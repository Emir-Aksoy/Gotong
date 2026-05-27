/**
 * Tiny Discord REST client. Fetch-based, no discord.js dep.
 *
 * Unlike Lark, Discord uses a long-lived bot token directly — no
 * token-refresh dance — so this file is mostly a fetch wrapper that:
 *
 *   - Prepends the API base URL (default `https://discord.com/api/v10`).
 *   - Sets `Authorization: Bot <TOKEN>` and a User-Agent (Discord
 *     REJECTS requests without a User-Agent header).
 *   - Surfaces 429 `Retry-After` as `retryAfterMs` on the thrown error
 *     so the bridge / caller can honour rate limits.
 *   - Unifies non-2xx responses into `DiscordApiError` with the
 *     numeric `code` from Discord's JSON error body.
 *
 * What's NOT here (deliberate for M5):
 *
 *   - Per-bucket rate limit tracking. Discord publishes header-driven
 *     buckets (`X-RateLimit-Bucket`) but a single bot's send rate is
 *     well under any limit. Bridge just respects 429 Retry-After.
 *   - Multipart uploads. M5 sends text only; outbound attachments
 *     would need `multipart/form-data`.
 *   - OAuth flows. Bridge assumes a bot token.
 */

import type { DiscordApiErrorBody } from './types.js'

export interface DiscordClientOptions {
  /** Bot token from https://discord.com/developers/applications. */
  token: string
  /**
   * Override the API base. Defaults to `https://discord.com/api/v10`.
   * Mostly useful for tests + sniffing via a local proxy.
   */
  baseUrl?: string
  /**
   * User-Agent header value. Discord requires this. Defaults to
   * `aipehub-im-discord/0.1.0 (+https://github.com/aipehub/aipehub)`.
   */
  userAgent?: string
  /** Inject a fetch implementation for testing. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /**
   * Per-call timeout. Defaults to 60s — REST responses are normally
   * milliseconds; the ceiling stops a hung request from blocking the
   * bridge's WebSocket handler.
   */
  timeoutMs?: number
}

export class DiscordApiError extends Error {
  readonly method: string
  readonly path: string
  readonly status: number
  /**
   * Numeric Discord error code from the response body (e.g. 10003
   * unknown channel, 50001 missing access). Null on transport errors
   * or non-JSON bodies.
   */
  readonly code: number | null
  /** Wait this many ms before retrying — set only on 429. */
  readonly retryAfterMs: number | null

  constructor(input: {
    method: string
    path: string
    status: number
    code?: number | null
    detail?: string | null
    retryAfterMs?: number | null
  }) {
    const codeStr =
      input.code !== null && input.code !== undefined ? input.code : `HTTP_${input.status}`
    const detail = input.detail ?? `HTTP ${input.status}`
    super(`discord ${input.method} ${input.path}: ${codeStr} — ${detail}`)
    this.name = 'DiscordApiError'
    this.method = input.method
    this.path = input.path
    this.status = input.status
    this.code = input.code ?? null
    this.retryAfterMs = input.retryAfterMs ?? null
  }
}

export interface DiscordCallOptions {
  query?: Record<string, string | number | undefined>
  body?: unknown
  timeoutMs?: number
}

export interface DiscordClient {
  /**
   * Call a Discord REST endpoint. `path` starts with `/` and is
   * appended to `baseUrl`. The Bot token + User-Agent are added
   * automatically.
   *
   * Returns the parsed JSON body on 2xx. Throws `DiscordApiError` on
   * non-2xx (including 429 with `retryAfterMs` populated). Body parse
   * failures also throw — Discord always returns JSON on errors.
   */
  call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options?: DiscordCallOptions,
  ): Promise<T>
  /** The exact base URL the client uses — handy for tests. */
  readonly baseUrl: string
}

export function createDiscordClient(opts: DiscordClientOptions): DiscordClient {
  if (typeof opts?.token !== 'string' || opts.token.length === 0) {
    throw new TypeError('createDiscordClient: token is required')
  }
  const baseUrl = (opts.baseUrl ?? 'https://discord.com/api/v10').replace(/\/+$/, '')
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const defaultTimeoutMs = opts.timeoutMs ?? 60_000
  const userAgent =
    opts.userAgent ?? 'aipehub-im-discord/0.1.0 (+https://github.com/aipehub/aipehub)'

  return {
    baseUrl,
    async call<T>(
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      options: DiscordCallOptions = {},
    ): Promise<T> {
      let url = `${baseUrl}${path}`
      if (options.query) {
        const qs = new URLSearchParams()
        for (const [k, v] of Object.entries(options.query)) {
          if (v === undefined) continue
          qs.append(k, String(v))
        }
        const s = qs.toString()
        if (s.length > 0) url += `?${s}`
      }
      const headers: Record<string, string> = {
        authorization: `Bot ${opts.token}`,
        'user-agent': userAgent,
      }
      let body: string | undefined
      if (options.body !== undefined) {
        headers['content-type'] = 'application/json; charset=utf-8'
        body = JSON.stringify(options.body)
      }
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? defaultTimeoutMs)
      let res: Response
      try {
        res = await fetchImpl(url, { method, headers, body, signal: ctrl.signal })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) {
        // Try to extract `code` + `message` from the standard error
        // envelope. 429 also carries `retry_after` (seconds, float).
        let parsed: DiscordApiErrorBody | null = null
        try {
          parsed = (await res.json()) as DiscordApiErrorBody
        } catch {
          // Body wasn't JSON — happens on 5xx from edge servers.
        }
        let retryAfterMs: number | null = null
        if (res.status === 429) {
          // Prefer the body's `retry_after` (seconds, float) when present,
          // fall back to the `Retry-After` header (seconds, integer).
          const bodyRetry = (parsed as Record<string, unknown> | null)?.retry_after
          if (typeof bodyRetry === 'number' && Number.isFinite(bodyRetry)) {
            retryAfterMs = Math.ceil(bodyRetry * 1000)
          } else {
            const h = res.headers.get('retry-after')
            const n = h ? Number(h) : NaN
            if (Number.isFinite(n)) retryAfterMs = Math.ceil(n * 1000)
          }
        }
        throw new DiscordApiError({
          method,
          path,
          status: res.status,
          code: parsed?.code ?? null,
          detail: parsed?.message ?? null,
          retryAfterMs,
        })
      }
      // 204 No Content from some DELETE endpoints — no body to parse.
      if (res.status === 204) return undefined as T
      try {
        return (await res.json()) as T
      } catch (err) {
        throw new DiscordApiError({
          method,
          path,
          status: res.status,
          detail: `unparseable JSON response: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    },
  }
}
