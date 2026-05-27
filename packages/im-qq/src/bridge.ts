/**
 * `ImBridge` implementation for QQ via OneBot v11 (forward WebSocket).
 *
 * EXPERIMENTAL — see README for full risk write-up. Headline:
 *
 *   - OneBot v11 is a *third-party* protocol. There is no official
 *     public QQ bot API for personal accounts. Adapters (NapCat,
 *     go-cqhttp, Lagrange, Mirai-onebot, …) reverse-engineer the
 *     client wire format. Using them carries account-suspension risk;
 *     Tencent has on-and-off enforced bans on common adapters.
 *   - The bridge refuses to start unless `AIPE_QQ_BRIDGE_ACK_RISK=true`
 *     is set in the environment. This is a deliberate friction step
 *     so a host operator can't accidentally enable QQ without reading
 *     the docs.
 *
 * Threading model:
 *
 *   start() ─► OneBotClient.start() (WebSocket connect)
 *                 │
 *                 ├─ event push (message) → oneBotToImMessage → listeners
 *                 ├─ event push (meta_event lifecycle) → cache self_id
 *                 ├─ event push (notice/request) → ignore (200 ack equivalent)
 *                 │
 *                 └─ socket close → bridge reconnects with exponential backoff
 *
 *   stop() flips `intentionalStop`, closes the client, cancels any
 *   pending reconnect timer. Idempotent.
 *
 * What's NOT in M7 (deliberate):
 *
 *   - OAuth installation flow — N/A; adapter handles QQ login itself.
 *   - Outbound attachments / images / records. `sendMessage` with
 *     attachments triggers `onError` but text still goes out.
 *   - Reverse WebSocket transport. Forward WS is the simpler default.
 *   - HTTP POST + reverse webhook transport. Same reason.
 *   - CQ-code string-form mention strip beyond at-bot. Adapter
 *     should be configured to emit array form; bridge handles both
 *     but the array-form path is canonical.
 *   - Sharding / multi-account. One bridge instance = one QQ login.
 *   - Token refresh (none — adapter's access_token is long-lived).
 */

import type {
  ImAttachment,
  ImBridge,
  ImMessage,
  ImUser,
} from '@aipehub/im-adapter'

import {
  createOneBotClient,
  type OneBotClient,
  type OneBotClientOptions,
  type WebSocketCtor,
} from './client.js'
import {
  buildQqTextMessage,
  oneBotToImMessage,
  parseQqChatId,
} from './message.js'
import type {
  OneBotEvent,
  OneBotMessageEvent,
  OneBotMetaEvent,
  OneBotSendMsgData,
  OneBotSendMsgParams,
} from './types.js'

/**
 * Env-variable name the operator must set to `'true'` to enable the
 * bridge. Exported so docs / setup scripts can reference one source
 * of truth.
 */
export const QQ_RISK_ACK_ENV = 'AIPE_QQ_BRIDGE_ACK_RISK'

export interface QqBridgeOptions {
  /**
   * OneBot v11 forward-WS endpoint, e.g. `ws://127.0.0.1:3001/`.
   * Required.
   */
  url: string
  /**
   * Optional access token configured in the adapter (NapCat:
   * `network.websocketServers[].token`; go-cqhttp: `access_token`).
   * Omit when the adapter is open (loopback-only deployments).
   */
  accessToken?: string
  /**
   * Override the underlying client. Mostly for tests.
   */
  client?: OneBotClient
  /**
   * WebSocket constructor. Defaults to `globalThis.WebSocket` (Node
   * 22+); on Node 20 pass `import { WebSocket } from "ws"`.
   */
  webSocketImpl?: WebSocketCtor
  /**
   * Forwarded to `createOneBotClient` when `client` isn't supplied.
   * Useful for tuning the per-action timeout in tests.
   */
  clientOptions?: Omit<OneBotClientOptions, 'url' | 'accessToken' | 'webSocketImpl'>
  /**
   * Strip `[CQ:at,qq=<self>]` (and array-form `at` segments
   * targeting the bot) from inbound text. Default `true`.
   */
  stripBotMentions?: boolean
  /**
   * Override the bot's own QQ number. Usually unnecessary — bridge
   * captures `self_id` from the first inbound event (lifecycle or
   * message). Pre-setting skips the wait.
   */
  selfId?: number
  /**
   * Reconnect backoff (ms). Same shape as Discord's: starts at
   * `initial`, doubles per failure, caps at `max`, resets on
   * successful event delivery.
   */
  reconnectInitialMs?: number
  reconnectMaxMs?: number
  /**
   * Bypass the AIPE_QQ_BRIDGE_ACK_RISK env check. **TESTS ONLY.**
   * Not exposed in the README. Type as required-false so we trip
   * up future refactors that try to flip it.
   */
  __acknowledgeRiskInTest?: true
  /**
   * Background diagnostic surface.
   */
  onError?: (err: unknown) => void
}

type Listener = (msg: ImMessage) => void | Promise<void>

const DEFAULT_RECONNECT_INITIAL_MS = 1000
const DEFAULT_RECONNECT_MAX_MS = 30_000

export class QqBridge implements ImBridge {
  readonly platform = 'qq'

  private readonly clientFactory: () => OneBotClient
  private readonly stripBotMentions: boolean
  private readonly onError: (err: unknown) => void
  private readonly reconnectInitialMs: number
  private readonly reconnectMaxMs: number

  private client: OneBotClient | null = null
  private listeners: Listener[] = []
  private selfId: number | null
  private running = false
  private intentionalStop = false
  private reconnectBackoff: number
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: QqBridgeOptions) {
    if (typeof opts?.url !== 'string' || opts.url.length === 0) {
      throw new TypeError('QqBridge: url is required')
    }
    // Risk gate. We check process.env eagerly at construction so a
    // misconfigured host fails at boot, not on first message.
    const ack =
      opts.__acknowledgeRiskInTest === true ||
      (typeof process !== 'undefined' && process.env?.[QQ_RISK_ACK_ENV] === 'true')
    if (!ack) {
      throw new Error(
        `QqBridge: experimental — set ${QQ_RISK_ACK_ENV}=true in the environment to acknowledge ` +
          'the QQ bot account-suspension risk (see @aipehub/im-qq README). ' +
          'OneBot v11 is a third-party protocol; Tencent does not officially permit personal-account bots.',
      )
    }
    this.stripBotMentions = opts.stripBotMentions ?? true
    this.onError = opts.onError ?? (() => {})
    this.selfId = opts.selfId ?? null
    this.reconnectInitialMs = opts.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS
    this.reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS
    this.reconnectBackoff = this.reconnectInitialMs

    if (opts.client) {
      const c = opts.client
      this.clientFactory = () => c
    } else {
      this.clientFactory = () =>
        createOneBotClient({
          url: opts.url,
          accessToken: opts.accessToken,
          webSocketImpl: opts.webSocketImpl,
          ...opts.clientOptions,
        })
    }
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.intentionalStop = false
    await this.openClient()
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.intentionalStop = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const c = this.client
    this.client = null
    if (c) await c.stop()
  }

  async sendMessage(
    to: ImUser,
    text: string,
    options?: { attachments?: ImAttachment[]; chatId?: string },
  ): Promise<void> {
    if (!this.client || this.client.state !== 'open') {
      throw new Error(
        `QqBridge.sendMessage: client not connected (state=${this.client?.state ?? 'null'})`,
      )
    }
    if (options?.attachments && options.attachments.length > 0) {
      this.onError(
        new Error(
          'QqBridge.sendMessage: outbound attachments not yet supported; sending text only',
        ),
      )
    }
    // Prefer the inbound chatId — it tells us private vs group.
    // Fall back: assume DM to the platformUserId (a QQ number).
    const chatId = options?.chatId
    let params: OneBotSendMsgParams
    if (typeof chatId === 'string' && chatId.length > 0) {
      const parsed = parseQqChatId(chatId)
      if (!parsed) {
        throw new Error(
          `QqBridge.sendMessage: malformed chatId ${JSON.stringify(chatId)}; expected "private:<qq>" or "group:<qq>"`,
        )
      }
      params = {
        message_type: parsed.message_type,
        ...(parsed.message_type === 'private'
          ? { user_id: parsed.id }
          : { group_id: parsed.id }),
        message: buildQqTextMessage(text),
      }
    } else {
      const userId = Number(to.platformUserId)
      if (!Number.isFinite(userId) || userId <= 0) {
        throw new Error('QqBridge.sendMessage: no chatId and platformUserId is not a QQ number')
      }
      params = {
        message_type: 'private',
        user_id: userId,
        message: buildQqTextMessage(text),
      }
    }
    await this.client.callAction<OneBotSendMsgData>('send_msg', params as unknown as Record<string, unknown>)
  }

  onMessage(listener: Listener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  // --- internal ----------------------------------------------------

  private async openClient(): Promise<void> {
    const c = this.clientFactory()
    this.client = c
    c.onEvent((ev) => this.handleEvent(ev))
    c.onState((s) => {
      if (s === 'closed' && this.running && !this.intentionalStop) {
        this.scheduleReconnect()
      }
    })
    try {
      await c.start()
      // Connection successful — reset backoff for the next cycle.
      this.reconnectBackoff = this.reconnectInitialMs
    } catch (err) {
      this.onError(err)
      if (this.running && !this.intentionalStop) this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionalStop) return
    const delay = this.reconnectBackoff
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.running || this.intentionalStop) return
      // Bump the backoff for the *next* attempt; capped.
      this.reconnectBackoff = Math.min(this.reconnectMaxMs, this.reconnectBackoff * 2)
      void this.openClient()
    }, delay)
  }

  private handleEvent(ev: OneBotEvent): void {
    if (ev.post_type === 'meta_event') {
      this.handleMetaEvent(ev as OneBotMetaEvent)
      return
    }
    if (ev.post_type === 'message') {
      this.handleMessageEvent(ev as OneBotMessageEvent)
      return
    }
    // notice / request etc. — silently drop. OneBot adapters typically
    // emit a lot of `group_increase` / `friend_add` notices; bridging
    // every one would be noise.
  }

  private handleMetaEvent(ev: OneBotMetaEvent): void {
    // Lifecycle/heartbeat both carry self_id; capture if unset.
    if (this.selfId === null && typeof ev.self_id === 'number' && Number.isFinite(ev.self_id)) {
      this.selfId = ev.self_id
    }
  }

  private async handleMessageEvent(ev: OneBotMessageEvent): Promise<void> {
    // Opportunistic self_id capture from message events too — adapters
    // sometimes deliver messages before lifecycle.
    if (this.selfId === null && typeof ev.self_id === 'number') this.selfId = ev.self_id
    const im = oneBotToImMessage(ev, {
      selfId: this.selfId,
      stripBotMentions: this.stripBotMentions,
    })
    if (!im) return
    for (const l of this.listeners) {
      try {
        await l(im)
      } catch (err) {
        this.onError(err)
      }
    }
  }
}
