/**
 * QQ official Bot API client — fetch-based, no SDK dep.
 *
 * Two responsibilities:
 *
 *   1. **App access token.** The v2 bot API authenticates every REST
 *      call with `Authorization: QQBot <app_access_token>`. The token is
 *      minted from the AppID + ClientSecret at
 *      `https://bots.qq.com/app/getAppAccessToken` and is short-lived
 *      (~7200s). The client caches it and refreshes transparently before
 *      expiry, coalescing concurrent refreshes so a burst of sends near
 *      the TTL boundary fires only one auth POST. (Mirrors the Lark
 *      client's token cache — same TTL shape, same thundering-herd
 *      guard.)
 *
 *   2. **Passive-reply sends.** Four endpoints, one per surface:
 *        group   → POST /v2/groups/{group_openid}/messages
 *        C2C     → POST /v2/users/{user_openid}/messages
 *        channel → POST /channels/{channel_id}/messages
 *        guild DM→ POST /dms/{guild_id}/messages
 *      Group / C2C sends MUST carry `msg_id` (+ incrementing `msg_seq`)
 *      to be accepted — they are PASSIVE replies within the reply
 *      window. Proactive push to group/C2C was discontinued by the
 *      platform (2025-04); the bridge enforces that limitation, not the
 *      client (the client just sends what it's handed).
 *
 * Reference:
 *   - getAppAccessToken:
 *     https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html
 *   - v2 group / C2C send:
 *     https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html
 */

import type {
  QqApiErrorBody,
  QqAppAccessTokenResponse,
  QqPassiveReplyBody,
  QqSendResult,
} from './types.js'
import { QQ_MSG_TYPE_TEXT } from './types.js'

export class QqApiError extends Error {
  readonly method: string
  readonly path: string
  readonly status: number
  /** Business-logic error code from the response body (`code`/`err_code`). */
  readonly code: number | null
  /** Human-readable message from the response body. */
  readonly detail: string | null

  constructor(input: {
    method: string
    path: string
    status: number
    code?: number | null
    detail?: string | null
  }) {
    const codeStr =
      input.code !== null && input.code !== undefined ? input.code : `HTTP_${input.status}`
    super(`qq ${input.method} ${input.path}: ${codeStr} — ${input.detail ?? `HTTP ${input.status}`}`)
    this.name = 'QqApiError'
    this.method = input.method
    this.path = input.path
    this.status = input.status
    this.code = input.code ?? null
    this.detail = input.detail ?? null
  }
}

export interface QqClientOptions {
  /** Bot AppID from the QQ open platform. Required. */
  appId: string
  /** Bot ClientSecret (a.k.a. AppSecret) paired with the AppID. Required. */
  clientSecret: string
  /**
   * Base URL of the REST API. Defaults to the production sandbox-free
   * host `https://api.sgroup.qq.com`. (The sandbox host
   * `https://sandbox.api.sgroup.qq.com` is for the test environment.)
   */
  apiBase?: string
  /**
   * Base URL of the app-access-token endpoint. Defaults to
   * `https://bots.qq.com`. Split from `apiBase` because the token is
   * minted on a different host than the message endpoints.
   */
  tokenBase?: string
  /** Inject a fetch implementation for testing. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /**
   * Per-call timeout. Defaults to 60s — a hung request can't block the
   * bridge's webhook handler indefinitely.
   */
  timeoutMs?: number
  /**
   * Safety margin (ms) subtracted from a fresh token's TTL so the client
   * refreshes BEFORE the token expires server-side. Defaults to 120_000.
   */
  tokenSafetyMarginMs?: number
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number
}

export interface QqClient {
  /** Mint or return the cached app access token. */
  getAccessToken(): Promise<string>
  /** Passive-reply to a group. `msgId` makes it a reply; `msgSeq` increments per reply. */
  sendGroupMessage(
    groupOpenid: string,
    body: QqPassiveReplyBody,
  ): Promise<QqSendResult>
  /** Passive-reply to a C2C (friend) chat. */
  sendC2CMessage(userOpenid: string, body: QqPassiveReplyBody): Promise<QqSendResult>
  /** Reply in a guild channel. */
  sendChannelMessage(
    channelId: string,
    body: { content: string; msg_id?: string },
  ): Promise<QqSendResult>
  /** Reply in a guild direct-message conversation. */
  sendGuildDirectMessage(
    guildId: string,
    body: { content: string; msg_id?: string },
  ): Promise<QqSendResult>
  /** Drop the cached token so the next call re-mints. */
  invalidateToken(): void
}

export function createQqClient(opts: QqClientOptions): QqClient {
  if (typeof opts?.appId !== 'string' || opts.appId.length === 0) {
    throw new TypeError('createQqClient: appId is required')
  }
  if (typeof opts?.clientSecret !== 'string' || opts.clientSecret.length === 0) {
    throw new TypeError('createQqClient: clientSecret is required')
  }
  const apiBase = (opts.apiBase ?? 'https://api.sgroup.qq.com').replace(/\/+$/, '')
  const tokenBase = (opts.tokenBase ?? 'https://bots.qq.com').replace(/\/+$/, '')
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const defaultTimeoutMs = opts.timeoutMs ?? 60_000
  const safetyMarginMs = opts.tokenSafetyMarginMs ?? 120_000
  const now = opts.now ?? Date.now

  let cachedToken: { value: string; expiresAt: number } | null = null
  /** Coalesces concurrent token refreshes — one auth POST under load. */
  let refreshPromise: Promise<string> | null = null

  async function fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      return await fetchImpl(url, { ...init, signal: ctrl.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  async function refreshToken(): Promise<string> {
    const path = '/app/getAppAccessToken'
    const url = `${tokenBase}${path}`
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId: opts.appId, clientSecret: opts.clientSecret }),
      },
      defaultTimeoutMs,
    )
    let parsed: (QqAppAccessTokenResponse & QqApiErrorBody) | null = null
    try {
      parsed = (await res.json()) as QqAppAccessTokenResponse & QqApiErrorBody
    } catch {
      // Body wasn't JSON.
    }
    if (!res.ok || !parsed || typeof parsed.access_token !== 'string') {
      throw new QqApiError({
        method: 'POST',
        path,
        status: res.status,
        code: parsed?.code ?? parsed?.err_code ?? null,
        detail: parsed?.message ?? null,
      })
    }
    // `expires_in` comes as a number or numeric string — coerce.
    const ttlSec =
      typeof parsed.expires_in === 'number'
        ? parsed.expires_in
        : Number.parseInt(String(parsed.expires_in), 10)
    const ttlMs = Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec * 1000 : 0
    cachedToken = {
      value: parsed.access_token,
      expiresAt: now() + Math.max(0, ttlMs - safetyMarginMs),
    }
    return parsed.access_token
  }

  async function getToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > now()) return cachedToken.value
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

  async function send(
    method: 'POST',
    path: string,
    body: unknown,
  ): Promise<QqSendResult> {
    const token = await getToken()
    const url = `${apiBase}${path}`
    const res = await fetchWithTimeout(
      url,
      {
        method,
        headers: {
          authorization: `QQBot ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      defaultTimeoutMs,
    )
    let parsed: (QqSendResult & QqApiErrorBody) | null = null
    try {
      parsed = (await res.json()) as QqSendResult & QqApiErrorBody
    } catch {
      // Some success responses have an empty body; treat as ok below.
    }
    if (!res.ok) {
      throw new QqApiError({
        method,
        path,
        status: res.status,
        code: parsed?.code ?? parsed?.err_code ?? null,
        detail: parsed?.message ?? null,
      })
    }
    // A 2xx with a non-zero `code` is still a business-logic failure.
    if (parsed && typeof parsed.code === 'number' && parsed.code !== 0) {
      throw new QqApiError({
        method,
        path,
        status: res.status,
        code: parsed.code,
        detail: parsed.message ?? null,
      })
    }
    return parsed ?? {}
  }

  return {
    getAccessToken: getToken,

    sendGroupMessage(groupOpenid, body) {
      const payload: QqPassiveReplyBody = {
        content: body.content,
        msg_type: body.msg_type ?? QQ_MSG_TYPE_TEXT,
        ...(body.msg_id !== undefined ? { msg_id: body.msg_id } : {}),
        ...(body.msg_seq !== undefined ? { msg_seq: body.msg_seq } : {}),
      }
      return send('POST', `/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, payload)
    },

    sendC2CMessage(userOpenid, body) {
      const payload: QqPassiveReplyBody = {
        content: body.content,
        msg_type: body.msg_type ?? QQ_MSG_TYPE_TEXT,
        ...(body.msg_id !== undefined ? { msg_id: body.msg_id } : {}),
        ...(body.msg_seq !== undefined ? { msg_seq: body.msg_seq } : {}),
      }
      return send('POST', `/v2/users/${encodeURIComponent(userOpenid)}/messages`, payload)
    },

    sendChannelMessage(channelId, body) {
      // Guild channel endpoint takes `content` + `msg_id` (no msg_type/seq).
      const payload: Record<string, unknown> = { content: body.content }
      if (body.msg_id !== undefined) payload.msg_id = body.msg_id
      return send('POST', `/channels/${encodeURIComponent(channelId)}/messages`, payload)
    },

    sendGuildDirectMessage(guildId, body) {
      const payload: Record<string, unknown> = { content: body.content }
      if (body.msg_id !== undefined) payload.msg_id = body.msg_id
      return send('POST', `/dms/${encodeURIComponent(guildId)}/messages`, payload)
    },

    invalidateToken(): void {
      cachedToken = null
    },
  }
}
