/**
 * Tiny Slack Web API client. Fetch-based, no `@slack/web-api` dep.
 *
 * Unlike Lark (short-lived tenant_access_token), Slack issues a
 * long-lived bot user OAuth token (`xoxb-…`) that the host stores
 * once and the bridge uses verbatim. There's no refresh dance for
 * the bot token (only the user installer token rotates, which is a
 * concern for OAuth flow — out of scope for M6 transport).
 *
 * Slack's quirk vs Discord / Telegram: even on HTTP 200, business
 * failures surface as `{ ok: false, error: '<code>' }`. The client
 * unifies both paths into `SlackApiError`.
 *
 * What's NOT here (deliberate for M6):
 *
 *   - OAuth installation flow (`oauth.v2.access`). Host concern.
 *   - Token rotation. Bot tokens are stable; user tokens are out of
 *     scope.
 *   - Per-method retry. Slack's tier-based rate limit returns 429
 *     with a `Retry-After` header; we surface it on the error and
 *     let callers decide.
 *   - Form-encoded bodies. Web API accepts JSON when the
 *     `content-type` header says so — we always send JSON.
 *   - File uploads (`files.upload`). M6 sends text only; outbound
 *     attachments would need multipart.
 */

import type { SlackApiResponse } from './types.js'

export interface SlackClientOptions {
  /**
   * Bot user OAuth token from the Slack app's "OAuth & Permissions"
   * page — starts with `xoxb-`. Required.
   */
  token: string
  /**
   * Override the API base. Defaults to `https://slack.com/api`. Useful
   * for tests + sniffing via a local proxy.
   */
  baseUrl?: string
  /** Inject a fetch implementation for testing. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /**
   * Per-call timeout. Defaults to 60s — chat.postMessage is normally
   * milliseconds; the ceiling stops a hung request from blocking the
   * bridge's webhook handler.
   */
  timeoutMs?: number
}

export class SlackApiError extends Error {
  readonly method: string
  readonly path: string
  readonly status: number
  /**
   * Slack's machine-readable error code from the response body's
   * `error` field (e.g. 'channel_not_found', 'not_authed',
   * 'ratelimited'). Null on transport errors / non-JSON bodies.
   */
  readonly code: string | null
  /** Wait this many ms before retrying — set only on 429. */
  readonly retryAfterMs: number | null

  constructor(input: {
    method: string
    path: string
    status: number
    code?: string | null
    detail?: string | null
    retryAfterMs?: number | null
  }) {
    const codeStr = input.code ?? `HTTP_${input.status}`
    const detail = input.detail ?? `HTTP ${input.status}`
    super(`slack ${input.method} ${input.path}: ${codeStr} — ${detail}`)
    this.name = 'SlackApiError'
    this.method = input.method
    this.path = input.path
    this.status = input.status
    this.code = input.code ?? null
    this.retryAfterMs = input.retryAfterMs ?? null
  }
}

export interface SlackCallOptions {
  body?: unknown
  timeoutMs?: number
  /**
   * Skip the Authorization header for this call. Only true for
   * unauthenticated endpoints (none right now); bridge callers never
   * set this. Kept for future OAuth-bootstrap work.
   */
  noAuth?: boolean
}

export interface SlackClient {
  /**
   * Call a Slack Web API method. `path` should look like `/chat.postMessage`
   * (leading slash optional — client normalises). The Bearer token is
   * added automatically.
   *
   * Always POST as Slack's spec — even read-style methods take a body.
   * Resolves with the parsed `ok: true` response. Throws `SlackApiError`
   * on:
   *
   *   - non-2xx HTTP (incl. 429 with `retryAfterMs`)
   *   - `ok: false` in a 200 body (business-logic failure)
   *   - non-JSON body
   */
  call<T extends SlackApiResponse>(path: string, options?: SlackCallOptions): Promise<T>
  /** The exact base URL the client uses — handy for tests. */
  readonly baseUrl: string
}

export function createSlackClient(opts: SlackClientOptions): SlackClient {
  if (typeof opts?.token !== 'string' || opts.token.length === 0) {
    throw new TypeError('createSlackClient: token is required')
  }
  const baseUrl = (opts.baseUrl ?? 'https://slack.com/api').replace(/\/+$/, '')
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const defaultTimeoutMs = opts.timeoutMs ?? 60_000

  return {
    baseUrl,
    async call<T extends SlackApiResponse>(
      path: string,
      options: SlackCallOptions = {},
    ): Promise<T> {
      const normPath = path.startsWith('/') ? path : `/${path}`
      const url = `${baseUrl}${normPath}`
      const headers: Record<string, string> = {
        // Slack requires charset; without it Web API treats some
        // bodies as form-encoded and parsing diverges from JSON.
        'content-type': 'application/json; charset=utf-8',
      }
      if (!options.noAuth) {
        headers.authorization = `Bearer ${opts.token}`
      }
      const body = options.body !== undefined ? JSON.stringify(options.body) : '{}'
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? defaultTimeoutMs)
      let res: Response
      try {
        res = await fetchImpl(url, { method: 'POST', headers, body, signal: ctrl.signal })
      } finally {
        clearTimeout(timer)
      }
      // 429 / 5xx don't always carry a JSON body. Try to parse but
      // tolerate failure.
      let parsed: (T & SlackApiResponse) | null = null
      try {
        parsed = (await res.json()) as T & SlackApiResponse
      } catch {
        // Body wasn't JSON.
      }
      if (!res.ok) {
        let retryAfterMs: number | null = null
        if (res.status === 429) {
          // Slack uses the standard `Retry-After` header in seconds.
          const h = res.headers.get('retry-after')
          const n = h ? Number(h) : NaN
          if (Number.isFinite(n)) retryAfterMs = Math.ceil(n * 1000)
        }
        throw new SlackApiError({
          method: 'POST',
          path: normPath,
          status: res.status,
          code: parsed?.error ?? null,
          detail: parsed?.error ?? null,
          retryAfterMs,
        })
      }
      if (!parsed) {
        throw new SlackApiError({
          method: 'POST',
          path: normPath,
          status: res.status,
          detail: 'unparseable JSON response',
        })
      }
      if (parsed.ok !== true) {
        throw new SlackApiError({
          method: 'POST',
          path: normPath,
          status: res.status,
          code: parsed.error ?? null,
          detail: parsed.error ?? null,
        })
      }
      return parsed
    },
  }
}
