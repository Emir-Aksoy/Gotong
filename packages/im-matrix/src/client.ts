/**
 * Tiny Matrix Client-Server API client. Fetch-based, no SDK dep.
 *
 * Compared to `createTelegramClient`, this client is a bit more
 * generic — Matrix uses a mix of GET / POST / PUT methods with path
 * params, query params and JSON bodies — so `call()` takes
 * `method + path + options` rather than `method + params`.
 *
 * What we don't do (deliberate for M3):
 *
 *   - Token refresh / SSO flow. The bridge expects an `access_token`
 *     from config; refreshable tokens are a spec extension some
 *     homeservers ship and we punt to a later milestone.
 *   - E2E encryption. Requires libolm + an on-disk store and would
 *     dwarf the bridge's footprint. Encrypted rooms are filtered out
 *     in the bridge — see `bridge.ts`.
 *   - Media upload (`POST /_matrix/media/v3/upload`). Outbound
 *     attachments aren't supported in M3; the bridge surfaces them
 *     via `onError` and sends text-only, mirroring the Telegram
 *     M2 decision.
 *   - Auto-retry. The bridge's sync loop owns the retry policy
 *     because retry-after handling is part of the long-poll cadence,
 *     not a transport concern.
 */

import type { MatrixErrorBody } from './types.js'

export interface MatrixClientOptions {
  /**
   * Homeserver base URL — e.g. `https://matrix.org`. NO trailing
   * slash; the client appends paths starting with `/_matrix/...`.
   * Required.
   */
  homeserverUrl: string
  /**
   * Bot user's access token. Obtained out-of-band (login flow, admin
   * tool, or homeserver appservice config). Required.
   */
  accessToken: string
  /**
   * Inject a fetch implementation for testing. Defaults to
   * `globalThis.fetch`. We don't pull in `undici` / `node-fetch` —
   * Node 20 ships a working `fetch`.
   */
  fetchImpl?: typeof fetch
  /**
   * Default per-call timeout. Defaults to 60s — comfortably above
   * the long-poll `timeout` we use on `/sync` (30s server-side,
   * Matrix may add a few seconds round-trip).
   *
   * `/sync` overrides this via `options.timeoutMs` to (server-timeout
   * + 10s) so we don't kill the connection before the homeserver
   * does.
   */
  timeoutMs?: number
}

export class MatrixApiError extends Error {
  readonly method: string
  readonly path: string
  readonly status: number
  readonly errcode: string | null
  /**
   * Advisory retry-after milliseconds, sourced from either:
   *   - response body's `retry_after_ms` (on M_LIMIT_EXCEEDED), or
   *   - `Retry-After` HTTP header (homeservers vary).
   *
   * The bridge multiplies straight, no further conversion.
   */
  readonly retryAfterMs: number | null

  constructor(input: {
    method: string
    path: string
    status: number
    errcode?: string | null
    error?: string
    retryAfterMs?: number | null
  }) {
    const code = input.errcode ?? `HTTP_${input.status}`
    const detail = input.error ?? `HTTP ${input.status}`
    super(`matrix ${input.method} ${input.path}: ${code} — ${detail}`)
    this.name = 'MatrixApiError'
    this.method = input.method
    this.path = input.path
    this.status = input.status
    this.errcode = input.errcode ?? null
    this.retryAfterMs = input.retryAfterMs ?? null
  }
}

export interface MatrixCallOptions {
  /** Querystring params; values URL-encoded by the client. */
  query?: Record<string, string | number | undefined>
  /** JSON body (passed through `JSON.stringify`). */
  body?: unknown
  /**
   * Override the default timeout for this call. `/sync` long-poll
   * uses this to extend past the server-side timeout.
   */
  timeoutMs?: number
}

export interface MatrixClient {
  /**
   * Call an arbitrary Client-Server API endpoint. `path` should start
   * with `/_matrix/...`; the client prepends `homeserverUrl`.
   *
   * Resolves with the parsed JSON body on 2xx. Throws
   * `MatrixApiError` on non-2xx, and re-throws underlying fetch
   * errors (network / abort) without wrapping so callers can
   * distinguish "API said no" from "couldn't reach API."
   */
  call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options?: MatrixCallOptions,
  ): Promise<T>
}

export function createMatrixClient(opts: MatrixClientOptions): MatrixClient {
  if (typeof opts?.homeserverUrl !== 'string' || opts.homeserverUrl.length === 0) {
    throw new TypeError('createMatrixClient: homeserverUrl is required')
  }
  if (typeof opts?.accessToken !== 'string' || opts.accessToken.length === 0) {
    throw new TypeError('createMatrixClient: accessToken is required')
  }
  // Strip a trailing slash defensively — common config error.
  const baseUrl = opts.homeserverUrl.replace(/\/+$/, '')
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const defaultTimeoutMs = opts.timeoutMs ?? 60_000

  return {
    async call<T>(
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      path: string,
      options: MatrixCallOptions = {},
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
        authorization: `Bearer ${opts.accessToken}`,
      }
      let body: string | undefined
      if (options.body !== undefined) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(options.body)
      }
      // AbortController per-call so a stuck request can't block the
      // sync loop's shutdown indefinitely. /sync overrides via
      // options.timeoutMs to give the homeserver its full timeout
      // window + a network grace margin.
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? defaultTimeoutMs)
      let res: Response
      try {
        res = await fetchImpl(url, {
          method,
          headers,
          body,
          signal: ctrl.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      // Matrix returns standard HTTP status codes — unlike Telegram,
      // a business-logic failure is a non-2xx with a JSON error body.
      if (!res.ok) {
        let parsed: MatrixErrorBody | null = null
        try {
          parsed = (await res.json()) as MatrixErrorBody
        } catch {
          // Body wasn't JSON. We still surface the status; the bridge
          // logs via onError and backs off — same path either way.
        }
        // retry_after_ms (body) vs Retry-After (header): some
        // homeservers set both, some only one. Pick the larger so
        // we don't under-sleep and immediately re-rate-limit.
        const headerSec = Number(res.headers.get('retry-after') ?? '')
        const headerMs = Number.isFinite(headerSec) && headerSec > 0 ? headerSec * 1000 : null
        const bodyMs = parsed?.retry_after_ms ?? null
        const retryAfterMs =
          headerMs !== null && bodyMs !== null
            ? Math.max(headerMs, bodyMs)
            : (headerMs ?? bodyMs)
        throw new MatrixApiError({
          method,
          path,
          status: res.status,
          errcode: parsed?.errcode ?? null,
          error: parsed?.error,
          retryAfterMs,
        })
      }
      // 200 + no body is legal for a couple of endpoints (PUT
      // /presence, etc.). We don't call those; `await res.json()`
      // would throw on empty body. Cast through if a future endpoint
      // returns an empty 200.
      return (await res.json()) as T
    },
  }
}
