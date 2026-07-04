/**
 * `ImBridge` implementation for Discord. WebSocket Gateway v10 mode.
 *
 * Why Discord differs from M2 (Telegram long-poll), M3 (Matrix sync
 * long-poll), M4 (Lark webhook):
 *
 *   - Discord uses a persistent **WebSocket** with a control-plane
 *     dialect (HELLO → IDENTIFY → READY → DISPATCH … plus heartbeat
 *     and RESUME). Less polling, more state. Most of the complexity
 *     lives in `./gateway.ts`; this file is the thin ImBridge facade.
 *   - Attachments are served as plain **CDN URLs** that don't require
 *     auth — bridge passes them through verbatim (no `discord-file:`
 *     scheme like Lark / Telegram).
 *   - `chatId` is Discord's `channel_id` (a snowflake). DMs are
 *     just channels with a single user; bridges that want to DM a
 *     user need to call `POST /users/@me/channels` first — out of
 *     scope for M5. Inbound DMs work fine because Discord delivers
 *     them as MESSAGE_CREATE with `channel_id` populated; replying to
 *     `ImMessage.chatId` round-trips correctly.
 *
 * Threading model:
 *
 *   start() ─► gateway.start()
 *                  │
 *                  ├─ HELLO → IDENTIFY → READY (captures bot user id)
 *                  │
 *                  ├─ MESSAGE_CREATE → discordToImMessage → listeners
 *                  │
 *                  └─ on disconnect → gateway auto-reconnects with RESUME
 *
 *   stop() flips intentionalStop in the gateway; the WebSocket closes
 *   with 1000, heartbeat timer cleared, reconnect cancelled. Idempotent.
 *
 * What's NOT in M5 (intentional):
 *
 *   - Slash command registration / INTERACTION_CREATE handling.
 *     Free-text + @bot mention is the M5 surface; slash commands need
 *     application command registration + interaction deferred replies
 *     which roughly doubles the code surface. Left for a later
 *     milestone if there's demand.
 *   - DM channel auto-creation. `sendMessage` to a user requires the
 *     caller to provide an existing channel id (typically by echoing
 *     `ImMessage.chatId` from the inbound message).
 *   - Outbound attachments / embeds / components.
 *   - Voice / video.
 *   - Sharding.
 */

import type {
  ImAttachment,
  ImBridge,
  ImMessage,
  ImUser,
} from '@gotong/im-adapter'

import {
  createDiscordClient,
  type DiscordClient,
  type DiscordClientOptions,
} from './client.js'
import {
  createDiscordGateway,
  type DiscordGateway,
  type DiscordGatewayOptions,
  type WebSocketCtor,
} from './gateway.js'
import { discordToImMessage } from './message.js'
import type {
  DiscordMessage,
  DiscordReadyData,
  DiscordSendMessageRequest,
  DiscordSendMessageResponse,
} from './types.js'

export interface DiscordBridgeOptions {
  /** Bot token from Discord developer portal. */
  token: string
  /**
   * Override the intent bitfield. Default covers GUILD_MESSAGES +
   * DIRECT_MESSAGES + MESSAGE_CONTENT (the privileged intent for
   * reading text content).
   */
  intents?: number
  /**
   * Override the REST client. Mostly for tests; production passes
   * just `token`.
   */
  client?: DiscordClient
  /**
   * Override the gateway implementation. Tests provide a fake; in
   * production the bridge constructs one from `token` + `webSocketImpl`.
   */
  gateway?: DiscordGateway
  /**
   * WebSocket constructor. Defaults to `globalThis.WebSocket` (Node
   * 22+ has it; on Node 20 pass `import { WebSocket } from "ws"` or
   * `import { WebSocket } from "undici"`).
   */
  webSocketImpl?: WebSocketCtor
  /**
   * Strip `<@BOT_ID>` mentions from inbound text. Default `true` —
   * `parseImCommand` chokes on a leading mention token and the bot
   * doesn't need to see its own name.
   */
  stripBotMentions?: boolean
  /**
   * Forwarded to `createDiscordClient` when `client` isn't supplied.
   */
  clientOptions?: Omit<DiscordClientOptions, 'token'>
  /**
   * Forwarded to `createDiscordGateway` when `gateway` isn't supplied.
   * Useful for tuning reconnect backoff in tests.
   */
  gatewayOptions?: Omit<
    DiscordGatewayOptions,
    'token' | 'intents' | 'client' | 'webSocketImpl' | 'onEvent' | 'onReady' | 'onError' | 'onClose'
  >
  /**
   * Bot's own user id. If omitted, the bridge captures it from the
   * gateway's READY frame. Setting it explicitly skips the wait —
   * inbound messages won't be filtered for the bot's id until READY
   * arrives, but in practice that's milliseconds.
   */
  botUserId?: string
  /**
   * Diagnostic surface for errors that happen in the background
   * (gateway reconnect, listener throw, send failure that's not
   * propagated). Defaults to no-op.
   */
  onError?: (err: unknown) => void
}

type Listener = (msg: ImMessage) => void | Promise<void>

export class DiscordBridge implements ImBridge {
  readonly platform = 'discord'

  private readonly client: DiscordClient
  private readonly gateway: DiscordGateway
  private readonly stripBotMentions: boolean
  private readonly onError: (err: unknown) => void

  private running = false
  private listeners: Listener[] = []
  /**
   * Bot's own user id. Captured from the gateway READY frame the first
   * time it arrives. Persists across reconnects (Discord assigns one
   * id per bot application).
   */
  private botUserId: string | null

  constructor(opts: DiscordBridgeOptions) {
    if (typeof opts.token !== 'string' || opts.token.length === 0) {
      throw new TypeError('DiscordBridge: token is required')
    }
    this.stripBotMentions = opts.stripBotMentions ?? true
    this.onError = opts.onError ?? (() => {})
    this.botUserId = opts.botUserId ?? null
    this.client =
      opts.client ??
      createDiscordClient({
        token: opts.token,
        ...opts.clientOptions,
      })
    this.gateway =
      opts.gateway ??
      createDiscordGateway({
        token: opts.token,
        intents: opts.intents,
        client: this.client,
        webSocketImpl: opts.webSocketImpl,
        ...opts.gatewayOptions,
        onEvent: (name, data) => this.handleGatewayEvent(name, data),
        onReady: (data) => this.handleReady(data),
        onError: this.onError,
        onClose: ({ fatal, code, reason }) => {
          if (fatal) {
            // Surface fatal closes so operators don't silently lose
            // the bridge to a 4014 disallowed-intents error.
            this.onError(
              new Error(
                `DiscordBridge: gateway closed fatally (code=${code} reason="${reason}"). ` +
                  'Check token validity and that the privileged MESSAGE_CONTENT intent is enabled in the bot application page.',
              ),
            )
          }
        },
      })
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.gateway.start()
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    await this.gateway.stop()
  }

  async sendMessage(
    to: ImUser,
    text: string,
    options?: { attachments?: ImAttachment[]; chatId?: string },
  ): Promise<void> {
    const channelId = options?.chatId
    if (!channelId || channelId.length === 0) {
      // Same shape as MatrixBridge.sendMessage: Discord has no
      // "DM by user id" shortcut without a prior POST /users/@me/channels.
      // The bridge stays simple by requiring callers to pass the
      // channel id (typically by echoing ImMessage.chatId).
      throw new Error(
        'DiscordBridge.sendMessage: options.chatId (Discord channel id) is required; ' +
          'Discord has no DM-by-user shortcut. Use ImMessage.chatId from the ' +
          'inbound message you are replying to.',
      )
    }
    if (options?.attachments && options.attachments.length > 0) {
      // Match the M2/M3/M4 decision: don't silently drop; surface via
      // onError so operators know. Text still goes out.
      this.onError(
        new Error(
          'DiscordBridge.sendMessage: outbound attachments not yet supported; sending text only',
        ),
      )
    }
    const body: DiscordSendMessageRequest = { content: text }
    await this.client.call<DiscordSendMessageResponse>(
      'POST',
      `/channels/${encodeURIComponent(channelId)}/messages`,
      { body },
    )
    // `to.platformUserId` is unused here — Discord routes by channel id,
    // not user id. Keep the param for ImBridge contract compatibility.
    void to
  }

  onMessage(listener: Listener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  // --- internal ----------------------------------------------------

  private handleReady(data: DiscordReadyData): void {
    // First READY (or any subsequent one — bot id never changes for
    // the same token) gives us the bot's own user id. Future
    // MESSAGE_CREATE events filter against this to suppress our own
    // posts and to strip @bot mentions.
    if (data.user?.id) {
      this.botUserId = data.user.id
    }
  }

  private async handleGatewayEvent(name: string, data: unknown): Promise<void> {
    if (name !== 'MESSAGE_CREATE') return
    const message = data as DiscordMessage
    const imMsg = discordToImMessage(message, {
      botUserId: this.botUserId,
      stripBotMentions: this.stripBotMentions,
    })
    if (!imMsg) return
    for (const l of this.listeners) {
      try {
        await l(imMsg)
      } catch (err) {
        // A listener that throws doesn't stop other listeners or the
        // gateway. Diagnostic via onError.
        this.onError(err)
      }
    }
  }
}
