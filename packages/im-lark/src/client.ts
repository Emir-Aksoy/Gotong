/**
 * Tiny Lark / Feishu Open Platform client. Fetch-based, no SDK dep.
 *
 * Key complication vs Telegram / Matrix: Lark uses short-lived
 * `tenant_access_token`s (~2h TTL). The client caches the current
 * token and refreshes it transparently before every call when it's
 * close to expiry. A coalesced in-flight refresh promise prevents
 * thundering-herd on the auth endpoint when many requests fire
 * concurrently around the TTL boundary.
 *
 * What's NOT here (deliberate for M4):
 *
 *   - `app_access_token`. Some endpoints require the app-level token
 *     (instead of tenant-level). Bridge only uses
 *     `/open-apis/im/v1/messages` which is tenant-level, so we only
 *     fetch tenant tokens.
 *   - Marketplace-app auth flow (`app_ticket`-based refresh). Bridge
 *     assumes a tenant-installed internal app.
 *   - Automatic retry on `99991663` (token expired mid-request).
 *     Bridge's send path is short; if a token-expired error sneaks
 *     in, the caller's next attempt naturally re-fetches. We do
 *     expose `invalidateToken()` so the bridge can drop the cached
 *     token on demand.
 */

import type {
  LarkAccessTokenResponse,
  LarkApiErrorBody,
  LarkUploadFileResponse,
} from './types.js'

export interface LarkClientOptions {
  /** App ID from Lark Open Platform — e.g. 'cli_xxx'. Required. */
  appId: string
  /** App secret paired with the app id. Required. */
  appSecret: string
  /**
   * Base URL of the Open Platform API. Defaults to
   * `https://open.feishu.cn` (Feishu 国内). Switch to
   * `https://open.larksuite.com` for Lark international.
   */
  baseUrl?: string
  /**
   * Inject a fetch implementation for testing. Defaults to
   * `globalThis.fetch`. Node 20+ ships a working `fetch`.
   */
  fetchImpl?: typeof fetch
  /**
   * Per-call timeout. Defaults to 60s — Lark API typically responds
   * in milliseconds; the 60s ceiling is so a single hung request
   * can't block the bridge's webhook handler indefinitely.
   */
  timeoutMs?: number
  /**
   * Safety margin (ms) subtracted from a fresh token's TTL so the
   * client refreshes BEFORE the token actually expires server-side.
   * Defaults to 120_000 (2 min) — Lark issues ~7200s tokens so the
   * effective re-fetch interval is ~118 min.
   */
  tokenSafetyMarginMs?: number
}

export class LarkApiError extends Error {
  readonly method: string
  readonly path: string
  readonly status: number
  /**
   * Business-logic error code from the `code` field in the response
   * body. `0` is success and never reaches an error; non-zero means
   * Lark accepted the request but business logic refused.
   * Documented codes: https://open.feishu.cn/document/server-docs/getting-started/server-error-codes
   */
  readonly code: number | null
  /** Human-readable message from the `msg` field. */
  readonly msg: string | null

  constructor(input: {
    method: string
    path: string
    status: number
    code?: number | null
    msg?: string | null
  }) {
    const codeStr = input.code !== null && input.code !== undefined ? input.code : `HTTP_${input.status}`
    const detail = input.msg ?? `HTTP ${input.status}`
    super(`lark ${input.method} ${input.path}: ${codeStr} — ${detail}`)
    this.name = 'LarkApiError'
    this.method = input.method
    this.path = input.path
    this.status = input.status
    this.code = input.code ?? null
    this.msg = input.msg ?? null
  }
}

export interface LarkCallOptions {
  query?: Record<string, string | number | undefined>
  body?: unknown
  timeoutMs?: number
  /**
   * Skip the tenant_access_token Authorization header for this call.
   * Only true for the token-fetch call itself; bridge callers never
   * set this.
   */
  noAuth?: boolean
}

/** Input for the multipart `im/v1/files` upload (VOICE-M2). */
export interface LarkUploadFileInput {
  /** Lark file type — voice clips MUST be `'opus'` (the platform refuses to play anything else). */
  fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'
  fileName: string
  /** Clip duration in milliseconds — becomes the voice bubble's label. */
  durationMs?: number
  bytes: Buffer | Uint8Array
}

export interface LarkClient {
  /**
   * Call an Open Platform endpoint. `path` should start with
   * `/open-apis/...`; the client prepends `baseUrl` and the Bearer
   * Authorization header.
   *
   * Resolves with the parsed JSON body when `code: 0`. Throws
   * `LarkApiError` on non-2xx HTTP, on `code != 0`, and on body
   * parse failure. Underlying fetch / abort errors propagate raw.
   */
  call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options?: LarkCallOptions,
  ): Promise<T>
  /**
   * Upload a file (`POST /open-apis/im/v1/files`, multipart) and resolve
   * with the `file_key` for a subsequent message send. Same error
   * unification as `call`. Needs the `im:resource` permission.
   */
  uploadFile(input: LarkUploadFileInput): Promise<string>
  /**
   * Drop the cached tenant_access_token so the next call re-fetches.
   * Bridge invokes this on token-expired errors mid-stream.
   */
  invalidateToken(): void
}

export function createLarkClient(opts: LarkClientOptions): LarkClient {
  if (typeof opts?.appId !== 'string' || opts.appId.length === 0) {
    throw new TypeError('createLarkClient: appId is required')
  }
  if (typeof opts?.appSecret !== 'string' || opts.appSecret.length === 0) {
    throw new TypeError('createLarkClient: appSecret is required')
  }
  const baseUrl = (opts.baseUrl ?? 'https://open.feishu.cn').replace(/\/+$/, '')
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const defaultTimeoutMs = opts.timeoutMs ?? 60_000
  const safetyMarginMs = opts.tokenSafetyMarginMs ?? 120_000

  let cachedToken: { value: string; expiresAt: number } | null = null
  /**
   * Coalesces concurrent token-refresh attempts so we never fire two
   * parallel POSTs to the auth endpoint. If a refresh is in flight,
   * subsequent calls await the same promise.
   */
  let refreshPromise: Promise<string> | null = null

  async function refreshToken(): Promise<string> {
    const path = '/open-apis/auth/v3/tenant_access_token/internal'
    const url = `${baseUrl}${path}`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), defaultTimeoutMs)
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: opts.appId, app_secret: opts.appSecret }),
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      // Try to extract a usable error body even on non-2xx; the auth
      // endpoint may return business-logic failure as 4xx.
      let parsed: LarkApiErrorBody | null = null
      try {
        parsed = (await res.json()) as LarkApiErrorBody
      } catch {
        // empty
      }
      throw new LarkApiError({
        method: 'POST',
        path,
        status: res.status,
        code: parsed?.code ?? null,
        msg: parsed?.msg ?? null,
      })
    }
    const json = (await res.json()) as LarkAccessTokenResponse
    if (json.code !== 0 || typeof json.tenant_access_token !== 'string') {
      throw new LarkApiError({
        method: 'POST',
        path,
        status: res.status,
        code: json.code,
        msg: json.msg,
      })
    }
    cachedToken = {
      value: json.tenant_access_token,
      expiresAt: Date.now() + Math.max(0, json.expire * 1000 - safetyMarginMs),
    }
    return json.tenant_access_token
  }

  async function getToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
      return cachedToken.value
    }
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
      try {
        return await refreshToken()
      } finally {
        refreshPromise = null
      }
    })()
    return refreshPromise
  }

  return {
    async call<T>(
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      path: string,
      options: LarkCallOptions = {},
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
      const headers: Record<string, string> = {}
      if (!options.noAuth) {
        const token = await getToken()
        headers.authorization = `Bearer ${token}`
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
      // Even on 2xx, Lark uses `code != 0` to signal business-logic
      // failure (rate limit, permission, etc.). Inspect both paths.
      let parsed: (T & LarkApiErrorBody) | null = null
      try {
        parsed = (await res.json()) as T & LarkApiErrorBody
      } catch {
        // Body wasn't JSON.
      }
      if (!res.ok) {
        throw new LarkApiError({
          method,
          path,
          status: res.status,
          code: parsed?.code ?? null,
          msg: parsed?.msg ?? null,
        })
      }
      if (parsed && typeof parsed.code === 'number' && parsed.code !== 0) {
        throw new LarkApiError({
          method,
          path,
          status: res.status,
          code: parsed.code,
          msg: parsed.msg ?? null,
        })
      }
      return parsed as T
    },

    async uploadFile(input: LarkUploadFileInput): Promise<string> {
      const path = '/open-apis/im/v1/files'
      const url = `${baseUrl}${path}`
      const token = await getToken()
      const form = new FormData()
      form.append('file_type', input.fileType)
      form.append('file_name', input.fileName)
      if (input.durationMs !== undefined) {
        form.append('duration', String(Math.max(0, Math.round(input.durationMs))))
      }
      // Copy into a plain Uint8Array so Blob never aliases a live Buffer pool slice.
      form.append('file', new Blob([Uint8Array.from(input.bytes)]), input.fileName)
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), defaultTimeoutMs)
      let res: Response
      try {
        // NO content-type header — fetch derives the multipart boundary itself.
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: form,
          signal: ctrl.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      let parsed: LarkUploadFileResponse | null = null
      try {
        parsed = (await res.json()) as LarkUploadFileResponse
      } catch {
        // Body wasn't JSON.
      }
      if (!res.ok || (parsed && parsed.code !== 0)) {
        throw new LarkApiError({
          method: 'POST',
          path,
          status: res.status,
          code: parsed?.code ?? null,
          msg: parsed?.msg ?? null,
        })
      }
      const fileKey = parsed?.data?.file_key
      if (typeof fileKey !== 'string' || fileKey.length === 0) {
        throw new LarkApiError({
          method: 'POST',
          path,
          status: res.status,
          code: parsed?.code ?? null,
          msg: 'upload succeeded but response carried no file_key',
        })
      }
      return fileKey
    },

    invalidateToken(): void {
      cachedToken = null
    },
  }
}
