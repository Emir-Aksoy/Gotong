/**
 * `ImBridge` implementation for Slack. **Socket Mode** — the official
 * 免穿透 transport.
 *
 * Why Socket Mode instead of the Events API webhook:
 *
 *   - Socket Mode is Slack's official outbound-WebSocket transport: the
 *     app dials OUT, so NO public request URL, NO TLS, NO reverse
 *     proxy, and NO HMAC signing secret are needed. It works behind
 *     NAT exactly like the Telegram / Discord / Matrix / Lark bridges.
 *     This is the path OpenClaw / Hermes use for Slack.
 *   - The legacy RTM API is deprecated; the Events API webhook needs a
 *     public HTTPS endpoint. Socket Mode is the modern免穿透 answer.
 *
 * Threading model:
 *
 *   start() ─► socketFactory(...).start()
 *                 │  (apps.connections.open → WSS URL → connect)
 *                 │
 *                 └─ events_api envelope → onEvent(payload)
 *                        → handleEvent(event_callback)
 *                        → slackToImMessage → listener
 *
 *   stop() flips `running=false` and closes the socket; the state
 *   machine in `socket-mode.ts` owns reconnect / disconnect / backoff.
 *
 * The Socket Mode connection is built through an injectable
 * `socketFactory` (default `defaultSlackSocketFactory`), so hermetic
 * tests drive synthetic envelopes with a fake socket — no real network,
 * no `apps.connections.open` round trip.
 *
 * Two tokens (don't mix them up):
 *   - `appToken` (`xapp-…`, `connections:write`): opens the Socket Mode
 *     connection. Inbound only.
 *   - `token` (`xoxb-…`): the bot user OAuth token. Outbound
 *     `chat.postMessage` only.
 *
 * What's NOT here (deliberate, unchanged from before):
 *
 *   - OAuth installation flow. Bridge assumes the host already has both
 *     tokens from the Slack app config screens.
 *   - Slash commands / interactivity. Those envelopes are acked but not
 *     surfaced (see socket-mode.ts) — easy follow-up.
 *   - Outbound attachments / blocks / threads. `sendMessage` with
 *     attachments surfaces via `onError` and sends text only — same
 *     decision as Telegram / Matrix / Lark / Discord.
 *   - auth.test on start. Caller passes `botUserId` explicitly OR the
 *     bridge captures it from the first inbound event's `authorizations`
 *     array. Skips an extra round trip on every cold boot.
 *
 * Note on `auto-strip @bot mentions`:
 *   Group / channel replies prefix `<@UBOT…> /help`. `parseImCommand`
 *   chokes on the leading token, so the bridge strips by default. Set
 *   `stripBotMentions: false` to preserve.
 */

import type {
  ImAttachment,
  ImBridge,
  ImMessage,
  ImUser,
} from '@gotong/im-adapter'

import {
  createSlackClient,
  type SlackClient,
  type SlackClientOptions,
} from './client.js'
import { slackToImMessage } from './message.js'
import {
  createSlackSocketMode,
  type SlackSocketMode,
  type WebSocketCtor,
} from './socket-mode.js'
import type {
  SlackEventCallback,
  SlackMessageEvent,
  SlackPostMessageRequest,
  SlackPostMessageResponse,
} from './types.js'

// ---------------------------------------------------------------------------
// Socket Mode factory seam — lets tests inject a fake connection
// ---------------------------------------------------------------------------

/**
 * Everything the bridge hands a Socket Mode factory. The default
 * factory forwards these to `createSlackSocketMode`; a test factory can
 * ignore the transport options and just capture `onEvent` to drive
 * synthetic envelopes.
 */
export interface SlackSocketFactoryParams {
  /** App-level token (`xapp-…`). */
  appToken: string
  /** WebSocket constructor. Undefined → `globalThis.WebSocket`. */
  webSocketImpl?: WebSocketCtor
  /** fetch for `apps.connections.open`. Undefined → `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /** API base for `apps.connections.open`. */
  baseUrl?: string
  /** Pin the WSS URL (skips `apps.connections.open`). Tests only. */
  socketUrl?: string
  /** Each inbound `events_api` payload (standard `event_callback` body). */
  onEvent: (payload: unknown) => void | Promise<void>
  /** Background-failure surface. */
  onError: (err: unknown) => void
}

export type SlackSocketFactory = (params: SlackSocketFactoryParams) => SlackSocketMode

/** Production factory — a thin pass-through to `createSlackSocketMode`. */
export const defaultSlackSocketFactory: SlackSocketFactory = (params) =>
  createSlackSocketMode(params)

// ---------------------------------------------------------------------------
// Bridge options
// ---------------------------------------------------------------------------

export interface SlackBridgeOptions {
  /**
   * Bot user OAuth token (`xoxb-…`) from the Slack app's
   * "OAuth & Permissions" page. Required — used by `sendMessage`.
   */
  token: string
  /**
   * App-level token (`xapp-…`, `connections:write` scope) from the
   * Slack app's "Basic Information → App-Level Tokens" page. Required —
   * opens the Socket Mode connection.
   */
  appToken: string
  /** Override the Web API client (sendMessage). Mostly for tests. */
  client?: SlackClient
  /**
   * Strip `<@BOT_USER_ID>` from inbound text. Default `true` — group
   * channel replies prefix the bot's mention, downstream command
   * parsing wants clean text.
   */
  stripBotMentions?: boolean
  /**
   * Bot's own user id (`U…`). If omitted, the bridge captures it from
   * the first inbound `event_callback.authorizations[0].user_id` where
   * `is_bot: true`. Setting it explicitly skips that wait.
   */
  botUserId?: string
  /** Forwarded to `createSlackClient` when `client` isn't supplied. */
  clientOptions?: Omit<SlackClientOptions, 'token'>
  /**
   * WebSocket constructor for the Socket Mode connection. Defaults to
   * `globalThis.WebSocket` (Node 22+). On Node 20 pass `WebSocket` from
   * `ws` / `undici`. Forwarded to the default socket factory.
   */
  webSocketImpl?: WebSocketCtor
  /** Inject a fetch impl for `apps.connections.open`. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /** API base for `apps.connections.open`. Defaults to `https://slack.com/api`. */
  socketBaseUrl?: string
  /**
   * Pin the WSS URL — skips `apps.connections.open`. Mostly for tests
   * that inject a `webSocketImpl` directly.
   */
  socketUrl?: string
  /**
   * Build the Socket Mode connection. Defaults to
   * `defaultSlackSocketFactory`. Hermetic tests inject a fake to drive
   * synthetic envelopes with no socket.
   */
  socketFactory?: SlackSocketFactory
  /**
   * Called on listener exceptions and background transport failures.
   * The bridge never throws into the caller from inbound-handling code;
   * this is the diagnostic surface. Defaults to a no-op.
   */
  onError?: (err: unknown) => void
}

type Listener = (msg: ImMessage) => void | Promise<void>

/** Bounded dedup cache size for event_id. ~512 ≈ a few minutes of busy traffic. */
const DELIVERED_CACHE_MAX = 512

export class SlackBridge implements ImBridge {
  readonly platform = 'slack'

  private readonly client: SlackClient
  private readonly appToken: string
  private readonly stripBotMentions: boolean
  private readonly onError: (err: unknown) => void
  private readonly socketFactory: SlackSocketFactory
  private readonly webSocketImpl?: WebSocketCtor
  private readonly fetchImpl?: typeof fetch
  private readonly socketBaseUrl?: string
  private readonly socketUrl?: string

  private running = false
  private listeners: Listener[] = []
  private socket: SlackSocketMode | null = null
  private deliveredEventIds: Set<string> = new Set()
  private deliveredOrder: string[] = []
  private botUserId: string | null

  constructor(opts: SlackBridgeOptions) {
    if (typeof opts?.token !== 'string' || opts.token.length === 0) {
      throw new TypeError('SlackBridge: token is required')
    }
    if (typeof opts?.appToken !== 'string' || opts.appToken.length === 0) {
      throw new TypeError('SlackBridge: appToken is required')
    }
    this.client =
      opts.client ??
      createSlackClient({
        token: opts.token,
        ...opts.clientOptions,
      })
    this.appToken = opts.appToken
    this.stripBotMentions = opts.stripBotMentions ?? true
    this.onError = opts.onError ?? (() => {})
    this.socketFactory = opts.socketFactory ?? defaultSlackSocketFactory
    this.webSocketImpl = opts.webSocketImpl
    this.fetchImpl = opts.fetchImpl
    this.socketBaseUrl = opts.socketBaseUrl
    this.socketUrl = opts.socketUrl
    this.botUserId = opts.botUserId ?? null
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.socket = this.socketFactory({
      appToken: this.appToken,
      webSocketImpl: this.webSocketImpl,
      fetchImpl: this.fetchImpl,
      baseUrl: this.socketBaseUrl,
      socketUrl: this.socketUrl,
      onEvent: (payload) => this.handleEvent(payload),
      onError: this.onError,
    })
    await this.socket.start()
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    const s = this.socket
    this.socket = null
    if (s) await s.stop()
  }

  async sendMessage(
    to: ImUser,
    text: string,
    options?: { attachments?: ImAttachment[]; chatId?: string },
  ): Promise<void> {
    if (options?.attachments && options.attachments.length > 0) {
      // Mirror the Telegram/Matrix/Lark/Discord decision: don't silently
      // drop; surface via onError so operators know. Text still goes out.
      this.onError(
        new Error(
          'SlackBridge.sendMessage: outbound attachments not yet supported; sending text only',
        ),
      )
    }
    // Slack accepts a user id (`U…`) as the `channel` field for DMs, OR
    // a real channel id (`C…/D…/G…`). Prefer the inbound chatId; fall
    // back to the user id for explicit DM-by-user.
    const channel = options?.chatId ?? to.platformUserId
    if (typeof channel !== 'string' || channel.length === 0) {
      throw new Error(
        'SlackBridge.sendMessage: no chatId or platformUserId — Slack needs a channel id',
      )
    }
    const body: SlackPostMessageRequest = { channel, text }
    await this.client.call<SlackPostMessageResponse>('/chat.postMessage', { body })
  }

  onMessage(listener: Listener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  // --- inbound -------------------------------------------------------

  /**
   * Handle one Socket Mode `events_api` payload — the standard
   * `event_callback` body. Public so tests + the socket factory route
   * through the same capture + dedup + map + dispatch path.
   *
   * Tolerant by design: this is the inbound hot path off an
   * authenticated socket, so a malformed payload reports via `onError`
   * and returns rather than throwing (the socket-mode loop would just
   * catch a throw anyway).
   */
  async handleEvent(body: unknown): Promise<void> {
    if (!body || typeof body !== 'object') {
      this.onError(new Error('SlackBridge.handleEvent: payload must be an object'))
      return
    }
    const b = body as Record<string, unknown>
    // Socket Mode only surfaces `events_api` payloads, which are always
    // `event_callback` envelopes. Anything else (app_rate_limited, …)
    // is ignored.
    if (b.type !== 'event_callback') return
    const env = body as SlackEventCallback
    // Capture the bot user id opportunistically — `authorizations` is
    // delivered with every event_callback. First match where
    // `is_bot: true` wins.
    if (!this.botUserId && Array.isArray(env.authorizations)) {
      for (const a of env.authorizations) {
        if (a.is_bot && typeof a.user_id === 'string') {
          this.botUserId = a.user_id
          break
        }
      }
    }
    // Dedup by event_id. Socket Mode can redeliver the same event after
    // a reconnect / missed ack.
    if (typeof env.event_id === 'string') {
      if (!this.recordDelivered(env.event_id)) return
    }
    // Only `message` events bridge into the Hub. Other event types are
    // skipped silently.
    const event = env.event as { type?: string } | undefined
    if (event?.type === 'message') {
      const imMsg = slackToImMessage(event as SlackMessageEvent, {
        botUserId: this.botUserId,
        stripBotMentions: this.stripBotMentions,
      })
      if (imMsg) await this.deliver(imMsg)
    }
  }

  // --- internal ------------------------------------------------------

  private recordDelivered(eventId: string): boolean {
    if (this.deliveredEventIds.has(eventId)) return false
    this.deliveredEventIds.add(eventId)
    this.deliveredOrder.push(eventId)
    if (this.deliveredOrder.length > DELIVERED_CACHE_MAX) {
      const drop = this.deliveredOrder.shift()!
      this.deliveredEventIds.delete(drop)
    }
    return true
  }

  private async deliver(msg: ImMessage): Promise<void> {
    for (const l of this.listeners) {
      try {
        await l(msg)
      } catch (err) {
        this.onError(err)
      }
    }
  }
}
