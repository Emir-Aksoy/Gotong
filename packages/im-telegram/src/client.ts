/**
 * Tiny Telegram Bot API client. Fetch-based, no SDK dep.
 *
 * Why a custom client instead of `node-telegram-bot-api`:
 *
 *   - We only need 3 methods (`getUpdates` for the long-poll, `sendMessage`
 *     for replies, `getFile` for downloading attachments).
 *   - The wrapper libs pull in 10-20 transitive deps just to ship a
 *     full surface 99% of consumers never touch.
 *   - `bun --compile` single-file binary: we want the bridge to slot
 *     into the host's bundled binary without lock-step bumping a
 *     vendor SDK.
 *   - Test ergonomics: with a `fetchImpl` injection point the bridge
 *     unit-tests don't go anywhere near api.telegram.org.
 */

import type { TelegramApiResponse } from './types.js'

export interface TelegramClientOptions {
  /**
   * Bot token from @BotFather (e.g. '123456:ABC-DEF…'). Required.
   * Anything else is best-effort-rejected with a TypeError; we don't
   * try to validate the format because Telegram changes it
   * occasionally and the api will reject misformed tokens anyway.
   */
  token: string
  /** Override for testing; defaults to 'https://api.telegram.org'. */
  baseUrl?: string
  /**
   * Inject a fetch implementation for testing. Defaults to
   * `globalThis.fetch`. We don't pull in `undici` / `node-fetch` —
   * Node 20 ships a working `fetch`.
   */
  fetchImpl?: typeof fetch
  /**
   * Per-call timeout. Defaults to 60s — comfortably above the
   * long-poll `timeout` parameter we use on `getUpdates` (default
   * 25s server-side; Telegram may add a few seconds round-trip).
   * Set this lower for non-poll calls if needed by passing a custom
   * client per scope.
   */
  timeoutMs?: number
}

export class TelegramApiError extends Error {
  readonly method: string
  readonly errorCode: number | null
  /** Advisory retry-after seconds on rate-limit (HTTP 429). null otherwise. */
  readonly retryAfter: number | null

  constructor(input: {
    method: string
    description: string
    errorCode?: number | null
    retryAfter?: number | null
  }) {
    super(`telegram ${input.method}: ${input.description}`)
    this.name = 'TelegramApiError'
    this.method = input.method
    this.errorCode = input.errorCode ?? null
    this.retryAfter = input.retryAfter ?? null
  }
}

export interface TelegramClient {
  /**
   * Call any Bot API method. Resolves with the `result` field; throws
   * `TelegramApiError` on `ok: false`, and re-throws the underlying
   * fetch error (network, timeout) without wrapping so callers can
   * distinguish "API said no" from "couldn't reach API."
   */
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>
}

export function createTelegramClient(opts: TelegramClientOptions): TelegramClient {
  if (typeof opts?.token !== 'string' || opts.token.length === 0) {
    throw new TypeError('createTelegramClient: token is required')
  }
  const baseUrl = opts.baseUrl ?? 'https://api.telegram.org'
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 60_000

  return {
    async call<T>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      const url = `${baseUrl}/bot${opts.token}/${method}`
      // AbortController per-call so a stuck request can't block
      // shutdown indefinitely. The bridge's long-poll uses a 25s
      // server timeout, so 60s wallclock here covers that comfortably.
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      let res: Response
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal: ctrl.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      // We don't gate on res.ok — Telegram returns 200 + ok:false for
      // most business-logic failures; only network / transport errors
      // surface as exceptions from fetchImpl.
      const json = (await res.json()) as TelegramApiResponse<T>
      if (!json.ok) {
        throw new TelegramApiError({
          method,
          description: json.description ?? `HTTP ${res.status}`,
          errorCode: json.error_code ?? null,
          retryAfter: json.parameters?.retry_after ?? null,
        })
      }
      // `result` may legitimately be `null` (e.g. `setMyCommands`
      // returns true on success; `result` is `true` then). Cast.
      return json.result as T
    },
  }
}
