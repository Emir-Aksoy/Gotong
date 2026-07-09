/**
 * Tiny WeChat iLink Bot API client. Fetch-based, no SDK dep — the same
 * posture as `@gotong/im-telegram`'s client, and iLink is deliberately
 * Telegram-shaped (HTTP/JSON + Bearer + long-poll getupdates + cursor).
 *
 * Wire truth source: Tencent's official channel plugin
 * (`Tencent/openclaw-weixin` `src/api/{api,types,session-guard}.ts` +
 * `src/auth/login-qr.ts`, fetched verbatim 2026-07-09). Where community
 * write-ups and the official source disagreed (qrcode fetch is POST not
 * GET; `-14` lives in `errcode` not `ret`), the source wins.
 *
 * Identity posture: `iLink-App-Id: "bot"` is a public constant from the
 * official plugin's package.json (not a private credential). We declare
 * wire-compat via `channel_version` (the level servers key behaviour on)
 * and identify ourselves HONESTLY via `base_info.bot_agent = "Gotong/…"`,
 * which the official types document as observability-only.
 */

import { randomBytes, randomUUID } from 'node:crypto'

import type {
  WechatBaseInfo,
  WechatGetConfigResp,
  WechatGetUpdatesResp,
  WechatMessage,
  WechatQrcodeResp,
  WechatQrStatusResp,
  WechatSendMessageResp,
} from './types.js'

/** Login + default API host. Post-login calls should prefer the `baseurl`
 *  returned by the QR flow (IDC affinity); this is the bootstrap host. */
export const WECHAT_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** Server errcode for a stale/expired bot session. The official plugin's
 *  session-guard pauses ALL API calls for 60 minutes when it sees this —
 *  the bridge (M2) mirrors that cooldown. */
export const STALE_TOKEN_ERRCODE = -14

/** Official plugin's cooldown after `-14` (session-guard constant). */
export const STALE_SESSION_PAUSE_MS = 60 * 60 * 1000

/** `iLink-App-Id` — public constant in the official plugin's package.json. */
const ILINK_APP_ID = 'bot'

/** Wire-compat level. The official plugin sends its own version here and the
 *  server keys behaviour on it; we pin the version we verified against
 *  (plugin v2.4.6, 2026-07-09) rather than inventing a Gotong number the
 *  server has never seen. Bump only after re-verifying against the source. */
const ILINK_CHANNEL_VERSION = '2.4.6'

/** `iLink-App-ClientVersion`: uint32 0x00MMNNPP (major<<16|minor<<8|patch). */
export function buildIlinkClientVersion(version: string): number {
  const parts = version.split('.').map((p) => parseInt(p, 10))
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

const ILINK_APP_CLIENT_VERSION = buildIlinkClientVersion(ILINK_CHANNEL_VERSION)

/** Anti-replay header: random uint32 → decimal string → base64, per call. */
export function randomWechatUin(rand: (n: number) => Buffer = randomBytes): string {
  const uint32 = rand(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

/** Timeouts mirror the official plugin's per-endpoint constants. */
const LONG_POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000
const CONFIG_TIMEOUT_MS = 10_000

export class WechatIlinkError extends Error {
  readonly endpoint: string
  /** Application-level failure code (`ret`), or the HTTP status when the
   *  failure happened at the HTTP layer. */
  readonly ret: number | null
  /** Server `errcode` (e.g. -14 stale session) — distinct from `ret`. */
  readonly errcode: number | null

  constructor(input: { endpoint: string; message: string; ret?: number | null; errcode?: number | null }) {
    super(`wechat ${input.endpoint}: ${input.message}`)
    this.name = 'WechatIlinkError'
    this.endpoint = input.endpoint
    this.ret = input.ret ?? null
    this.errcode = input.errcode ?? null
  }
}

export interface WechatIlinkClientOptions {
  /** `bot_token` from the QR login flow. Omit ONLY for the login endpoints
   *  themselves (they mint the token). */
  token?: string
  /** API base — pass the `baseurl` the QR flow returned; defaults to the
   *  bootstrap host. */
  baseUrl?: string
  /** Inject for tests. Defaults to `globalThis.fetch` (Node ≥20). */
  fetchImpl?: typeof fetch
  /** Overrides `base_info.bot_agent`. Default `Gotong/0.1`. */
  botAgent?: string
}

export interface WechatGetUpdatesParams {
  /** Cursor from the previous response; '' on the first call. */
  getUpdatesBuf?: string
  /** External abort (bridge stop) — cancels the in-flight long-poll. */
  abortSignal?: AbortSignal
}

export interface WechatSendTextParams {
  toUserId: string
  text: string
  /** Conversation-window token from the inbound message — REQUIRED by the
   *  protocol for the reply to reach the right chat window. */
  contextToken: string
  /** Outbound dedup id; defaults to a fresh UUID. */
  clientId?: string
}

export interface WechatIlinkClient {
  /** Long-poll for new messages. Client-side timeout / external abort return
   *  an EMPTY page (`ret: 0`, cursor unchanged) — normal long-poll control
   *  flow, mirroring the official client — so callers just loop. */
  getUpdates(params?: WechatGetUpdatesParams): Promise<WechatGetUpdatesResp>
  /** Send one text message. Throws `WechatIlinkError` on `ret !== 0` — the
   *  official plugin had a silent-fail bug here (issue #197); we hard-check. */
  sendTextMessage(params: WechatSendTextParams): Promise<void>
  /** Bot config (carries `typing_ticket` for sendTyping). */
  getConfig(params: { ilinkUserId: string; contextToken?: string }): Promise<WechatGetConfigResp>
  /** Lifecycle notifications — best-effort courtesies, response unchecked. */
  notifyStart(): Promise<void>
  notifyStop(): Promise<void>
  // ── QR login (token-less endpoints on the bootstrap host) ──
  /** POST get_bot_qrcode (NOT a GET — official source). Returns the QR image
   *  URL to show the user + the polling key. */
  fetchBotQrcode(params?: { botType?: string }): Promise<WechatQrcodeResp>
  /** One long-poll tick of get_qrcode_status. Timeout → `{ status: 'wait' }`
   *  (keep polling). Pass `verifyCode` after a `need_verifycode` status. */
  pollQrcodeStatus(params: {
    qrcode: string
    verifyCode?: string
    /** Poll THIS host when the flow got an IDC redirect. */
    baseUrlOverride?: string
  }): Promise<WechatQrStatusResp>
}

export function createWechatIlinkClient(opts: WechatIlinkClientOptions = {}): WechatIlinkClient {
  const baseUrl = (opts.baseUrl ?? WECHAT_ILINK_BASE_URL).replace(/\/$/, '')
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const botAgent = opts.botAgent ?? 'Gotong/0.1'

  const baseInfo = (): WechatBaseInfo => ({
    channel_version: ILINK_CHANNEL_VERSION,
    bot_agent: botAgent,
  })

  const headers = (withAuth: boolean): Record<string, string> => {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomWechatUin(),
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    }
    if (withAuth && opts.token?.trim()) h.Authorization = `Bearer ${opts.token.trim()}`
    return h
  }

  /** POST JSON, return raw text. HTTP-level failure → WechatIlinkError with
   *  ret = HTTP status. Timeout/abort surfaces as the AbortError from fetch
   *  so per-endpoint wrappers can decide (long-polls treat it as normal). */
  const post = async (
    endpoint: string,
    body: unknown,
    { timeoutMs, abortSignal, base }: { timeoutMs: number; abortSignal?: AbortSignal; base?: string },
  ): Promise<string> => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const onExternalAbort = () => ctrl.abort()
    if (abortSignal) {
      if (abortSignal.aborted) ctrl.abort()
      else abortSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
    try {
      const res = await fetchImpl(`${base ?? baseUrl}/${endpoint}`, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      const rawText = await res.text()
      if (!res.ok) {
        throw new WechatIlinkError({ endpoint, message: `HTTP ${res.status}: ${rawText.slice(0, 200)}`, ret: res.status })
      }
      return rawText
    } finally {
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', onExternalAbort)
    }
  }

  const getRaw = async (
    endpoint: string,
    { timeoutMs, base }: { timeoutMs: number; base?: string },
  ): Promise<string> => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      // GET requests carry only the app-id headers (official apiGetFetch).
      const res = await fetchImpl(`${base ?? baseUrl}/${endpoint}`, {
        method: 'GET',
        headers: {
          'iLink-App-Id': ILINK_APP_ID,
          'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
        },
        signal: ctrl.signal,
      })
      const rawText = await res.text()
      if (!res.ok) {
        throw new WechatIlinkError({ endpoint, message: `HTTP ${res.status}: ${rawText.slice(0, 200)}`, ret: res.status })
      }
      return rawText
    } finally {
      clearTimeout(timer)
    }
  }

  const isAbort = (err: unknown): boolean => err instanceof Error && err.name === 'AbortError'

  return {
    async getUpdates(params: WechatGetUpdatesParams = {}): Promise<WechatGetUpdatesResp> {
      const buf = params.getUpdatesBuf ?? ''
      try {
        const raw = await post(
          'ilink/bot/getupdates',
          { get_updates_buf: buf, base_info: baseInfo() },
          { timeoutMs: LONG_POLL_TIMEOUT_MS, abortSignal: params.abortSignal },
        )
        return JSON.parse(raw) as WechatGetUpdatesResp
      } catch (err) {
        // Long-poll client timeout AND external abort are normal exits: hand
        // back an empty page with the cursor unchanged; the loop re-checks
        // its own stop flag. (Official getUpdates does exactly this.)
        if (isAbort(err)) return { ret: 0, msgs: [], get_updates_buf: buf }
        throw err
      }
    },

    async sendTextMessage(params: WechatSendTextParams): Promise<void> {
      const msg: WechatMessage = {
        to_user_id: params.toUserId,
        client_id: params.clientId ?? randomUUID(),
        message_type: 2, // BOT
        message_state: 2, // FINISH
        context_token: params.contextToken,
        item_list: [{ type: 1, text_item: { text: params.text } }],
      }
      const raw = await post(
        'ilink/bot/sendmessage',
        { msg, base_info: baseInfo() },
        { timeoutMs: API_TIMEOUT_MS },
      )
      const resp = JSON.parse(raw) as WechatSendMessageResp
      if (resp.ret && resp.ret !== 0) {
        throw new WechatIlinkError({
          endpoint: 'ilink/bot/sendmessage',
          message: `ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`,
          ret: resp.ret,
        })
      }
    },

    async getConfig(params: { ilinkUserId: string; contextToken?: string }): Promise<WechatGetConfigResp> {
      const raw = await post(
        'ilink/bot/getconfig',
        { ilink_user_id: params.ilinkUserId, context_token: params.contextToken, base_info: baseInfo() },
        { timeoutMs: CONFIG_TIMEOUT_MS },
      )
      return JSON.parse(raw) as WechatGetConfigResp
    },

    async notifyStart(): Promise<void> {
      await post('ilink/bot/msg/notifystart', { base_info: baseInfo() }, { timeoutMs: CONFIG_TIMEOUT_MS })
    },

    async notifyStop(): Promise<void> {
      await post('ilink/bot/msg/notifystop', { base_info: baseInfo() }, { timeoutMs: CONFIG_TIMEOUT_MS })
    },

    async fetchBotQrcode(params: { botType?: string } = {}): Promise<WechatQrcodeResp> {
      const botType = params.botType ?? '3'
      // `local_token_list` lets a returning install re-associate; a fresh
      // Gotong login has none, and [] is what a fresh official install sends.
      const raw = await post(
        `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
        { local_token_list: [] },
        { timeoutMs: API_TIMEOUT_MS },
      )
      return JSON.parse(raw) as WechatQrcodeResp
    },

    async pollQrcodeStatus(params: {
      qrcode: string
      verifyCode?: string
      baseUrlOverride?: string
    }): Promise<WechatQrStatusResp> {
      let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`
      if (params.verifyCode) endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`
      try {
        const raw = await getRaw(endpoint, {
          timeoutMs: LONG_POLL_TIMEOUT_MS,
          ...(params.baseUrlOverride ? { base: params.baseUrlOverride.replace(/\/$/, '') } : {}),
        })
        return JSON.parse(raw) as WechatQrStatusResp
      } catch (err) {
        // Timeout → still waiting; caller keeps polling. (Official client
        // also folds gateway 5xx into 'wait', but we only fold the timeout —
        // a real HTTP error should be visible to the person mid-login.)
        if (isAbort(err)) return { status: 'wait' }
        throw err
      }
    },
  }
}
