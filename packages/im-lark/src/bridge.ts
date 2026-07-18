/**
 * `ImBridge` implementation for Lark / Feishu over the OFFICIAL long
 * connection (`@larksuiteoapi/node-sdk` `WSClient` + `EventDispatcher`).
 *
 * Why long connection instead of the old webhook (Event Subscription)
 * mode:
 *
 *   - It is what OpenClaw / Hermes use for Feishu, and it matches every
 *     other "official + 免穿透" bridge here (Telegram long-poll,
 *     Discord gateway, Matrix /sync): the bridge dials OUT to Lark and
 *     receives events over a persistent socket. No public callback URL,
 *     no TLS, no reverse proxy, no verification token — a home box
 *     behind NAT just works.
 *   - The bridge's responsibility shrinks to: dedup, map, dispatch.
 *     Lark's SDK owns the socket, reconnect, and event framing.
 *
 * Threading model:
 *
 *   start() ─► connectionFactory(...) → connection.start()
 *                 │  WSClient dials wss://… and registers an
 *                 │  EventDispatcher for 'im.message.receive_v1'
 *                 │
 *                 └─ each event → handleMessageReceive(event)
 *                        dedup by message_id (reconnect may redeliver)
 *                        → larkToImMessage → listener
 *
 *   stop() best-effort closes the connection.
 *
 * `sendMessage` is UNCHANGED from the webhook era — outbound still goes
 * through the REST client (`POST /open-apis/im/v1/messages`). Only the
 * inbound transport changed.
 *
 * What the long connection does NOT deliver (honest limit):
 *
 *   - Interactive card-button callbacks (`card.action.trigger`). Those
 *     are only delivered to an HTTPS callback. Plain-text chat — the
 *     bridge's whole job — is fully covered. A hub that needs card
 *     buttons would run a webhook side-channel; out of scope here.
 *   - Outbound attachments other than ONE opus voice clip. An `audio`
 *     attachment carrying ogg/opus bytes is uploaded (`im/v1/files`)
 *     and sent as `msg_type: 'audio'` (VOICE-M2); anything else
 *     surfaces via `onError` and sends text only — same decision as
 *     Telegram / Matrix.
 *   - Card / interactive messages on the reply side. Bot replies use
 *     the plain-text msg_type.
 *
 * The connection is created through an INJECTABLE factory
 * (`connectionFactory`) so hermetic tests drive synthetic
 * `im.message.receive_v1` events without the real SDK or a socket. The
 * default factory lazily imports `@larksuiteoapi/node-sdk` through a
 * variable specifier, so typecheck and hermetic tests never hard-depend
 * on the module actually being resolvable.
 *
 * Note on `auto-strip @bot mentions`:
 *   Group messages embed `<at user_id="…">@Bot</at>` in the text.
 *   `parseImCommand` chokes on the leading tag, so the bridge strips
 *   them by default. Set `stripBotMentions: false` to preserve.
 */

import type {
  ImAttachment,
  ImBridge,
  ImMessage,
  ImUser,
} from '@gotong/im-adapter'

import { opusDurationMs } from './audio.js'
import {
  createLarkClient,
  type LarkClient,
  type LarkClientOptions,
} from './client.js'
import { larkToImMessage, pickLarkReceiveIdType } from './message.js'
import type {
  LarkMessageReceiveEvent,
  LarkSendMessageResponse,
} from './types.js'

/**
 * A live long connection to Lark. The bridge only needs to start it and
 * (best-effort) stop it; the SDK owns everything in between.
 */
export interface LarkLongConnection {
  start(): void | Promise<void>
  stop?(): void | Promise<void>
}

/** Everything a factory needs to build + wire a long connection. */
export interface LarkConnectionFactoryParams {
  appId: string
  appSecret: string
  /** Invoked for each inbound `im.message.receive_v1` event. */
  onMessageReceive: (event: LarkMessageReceiveEvent) => void | Promise<void>
  /** Background failures (dispatch exceptions, socket errors, …). */
  onError: (err: unknown) => void
}

export type LarkConnectionFactory = (
  params: LarkConnectionFactoryParams,
) => LarkLongConnection

/**
 * Minimal shape of `@larksuiteoapi/node-sdk` the default factory uses.
 * Declaring it locally keeps the SDK out of the type graph entirely —
 * the package is a runtime-only dependency reached through a lazy
 * dynamic import.
 */
interface LarkSdkModule {
  WSClient: new (opts: { appId: string; appSecret: string }) => {
    start(args: { eventDispatcher: unknown }): void
    stop?(): void
  }
  EventDispatcher: new (opts: Record<string, unknown>) => {
    register(handlers: Record<string, (data: unknown) => unknown>): unknown
  }
}

/**
 * Default factory: lazily imports the official SDK and wires a
 * `WSClient` + `EventDispatcher` for `im.message.receive_v1`.
 *
 * The module specifier is held in a variable so the bundler / typecheck
 * never tries to resolve it statically — hermetic tests inject a fake
 * factory and never reach this code, while real deployments install
 * `@larksuiteoapi/node-sdk` (a declared dependency).
 */
export const defaultLarkConnectionFactory: LarkConnectionFactory = (params) => {
  let wsClient: { stop?(): void } | undefined
  return {
    async start(): Promise<void> {
      const spec = '@larksuiteoapi/node-sdk'
      const mod = (await import(spec)) as LarkSdkModule & { default?: LarkSdkModule }
      const Lark = mod.default ?? mod
      const client = new Lark.WSClient({ appId: params.appId, appSecret: params.appSecret })
      const eventDispatcher = new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: unknown) => {
          try {
            await params.onMessageReceive(data as LarkMessageReceiveEvent)
          } catch (err) {
            params.onError(err)
          }
        },
      })
      client.start({ eventDispatcher })
      wsClient = client
    },
    stop(): void {
      try {
        wsClient?.stop?.()
      } catch {
        // best-effort: the process is tearing down anyway.
      }
    },
  }
}

export interface LarkBridgeOptions {
  /** App ID from Lark Open Platform (cli_xxx). Required — the connection dials with it. */
  appId: string
  /** App secret. Required. */
  appSecret: string
  /** Override the underlying REST client. Mostly for tests. */
  client?: LarkClient
  /**
   * Strip `<at user_id="…">@Bot</at>` from inbound text bodies.
   * Default `true` — group chats interpolate this, downstream command
   * parsing wants clean text.
   */
  stripBotMentions?: boolean
  /** Forwarded to `createLarkClient` when `client` isn't supplied. */
  clientOptions?: Omit<LarkClientOptions, 'appId' | 'appSecret'>
  /**
   * Build the long connection. Defaults to
   * `defaultLarkConnectionFactory` (lazy-imports the official SDK).
   * Tests inject a fake to drive synthetic events with no socket.
   */
  connectionFactory?: LarkConnectionFactory
  /**
   * Called on dispatch exceptions, socket errors, and other background
   * failures. The bridge never throws into the caller from event
   * handling; this is the diagnostic surface. Defaults to a no-op.
   */
  onError?: (err: unknown) => void
}

type Listener = (msg: ImMessage) => void | Promise<void>

/** Bounded dedup cache size for message_id. ~512 ≈ a few minutes of busy traffic. */
const DELIVERED_CACHE_MAX = 512

export class LarkBridge implements ImBridge {
  readonly platform = 'lark'

  private readonly appId: string
  private readonly appSecret: string
  private readonly client: LarkClient
  private readonly stripBotMentions: boolean
  private readonly connectionFactory: LarkConnectionFactory
  private readonly onError: (err: unknown) => void

  private running = false
  private listeners: Listener[] = []
  private connection: LarkLongConnection | null = null
  private deliveredMessageIds: Set<string> = new Set()
  private deliveredOrder: string[] = []

  constructor(opts: LarkBridgeOptions) {
    if (typeof opts.appId !== 'string' || opts.appId.length === 0) {
      throw new TypeError('LarkBridge: appId is required')
    }
    if (typeof opts.appSecret !== 'string' || opts.appSecret.length === 0) {
      throw new TypeError('LarkBridge: appSecret is required')
    }
    this.appId = opts.appId
    this.appSecret = opts.appSecret
    this.client =
      opts.client ??
      createLarkClient({
        appId: opts.appId,
        appSecret: opts.appSecret,
        ...opts.clientOptions,
      })
    this.stripBotMentions = opts.stripBotMentions ?? true
    this.connectionFactory = opts.connectionFactory ?? defaultLarkConnectionFactory
    this.onError = opts.onError ?? (() => {})
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.connection = this.connectionFactory({
      appId: this.appId,
      appSecret: this.appSecret,
      onMessageReceive: (event) => this.handleMessageReceive(event),
      onError: this.onError,
    })
    await this.connection.start()
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    const conn = this.connection
    this.connection = null
    if (conn?.stop) await conn.stop()
  }

  async sendMessage(
    to: ImUser,
    text: string,
    options?: { attachments?: ImAttachment[]; chatId?: string },
  ): Promise<void> {
    const attachments = options?.attachments ?? []
    // VOICE-M2: ONE audio attachment with bytes = a voice rendering of
    // `text`. Upload + send it as a voice bubble INSTEAD of the text
    // (sending both would duplicate the same content). Any failure on
    // the voice leg falls back to the text path — voice is an
    // enhancement, never a dependency.
    const voice = attachments.find((a) => a.kind === 'audio' && a.bytes && a.bytes.length > 0)
    const unsupported = attachments.filter((a) => a !== voice)
    if (unsupported.length > 0) {
      // Mirror the Telegram / Matrix decision: don't silently drop;
      // surface via onError so operators know. Text still goes out.
      this.onError(
        new Error(
          'LarkBridge.sendMessage: only one opus voice attachment is supported; sending text only',
        ),
      )
    }
    // Prefer chatId (typically oc_xxx — works for both DM and group)
    // and fall back to the user's open_id for direct DMs.
    const receiveId = options?.chatId ?? to.platformUserId
    if (typeof receiveId !== 'string' || receiveId.length === 0) {
      throw new Error(
        'LarkBridge.sendMessage: no chatId or platformUserId — Lark needs a receive_id',
      )
    }
    const receiveIdType = pickLarkReceiveIdType(receiveId)
    if (voice) {
      try {
        const durationMs = opusDurationMs(voice.bytes!)
        if (durationMs === null) {
          throw new Error('audio attachment is not an ogg/opus clip — Lark voice plays only opus')
        }
        const fileKey = await this.client.uploadFile({
          fileType: 'opus',
          fileName: voice.filename ?? 'voice.opus',
          durationMs,
          bytes: voice.bytes!,
        })
        await this.client.call<LarkSendMessageResponse>(
          'POST',
          '/open-apis/im/v1/messages',
          {
            query: { receive_id_type: receiveIdType },
            body: {
              receive_id: receiveId,
              msg_type: 'audio',
              content: JSON.stringify({ file_key: fileKey }),
            },
          },
        )
        return
      } catch (err) {
        this.onError(
          new Error(
            `LarkBridge.sendMessage: voice leg failed, falling back to text — ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
      }
    }
    await this.client.call<LarkSendMessageResponse>(
      'POST',
      '/open-apis/im/v1/messages',
      {
        query: { receive_id_type: receiveIdType },
        body: {
          receive_id: receiveId,
          msg_type: 'text',
          // Lark requires content to be a JSON STRING (not an object).
          // See https://open.feishu.cn/document/server-docs/im-v1/message/create
          content: JSON.stringify({ text }),
        },
      },
    )
  }

  onMessage(listener: Listener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  // --- public-but-low-level: connection entry point ----------------

  /**
   * Handle one inbound `im.message.receive_v1` event. Public so the
   * default factory and hermetic tests both route events through the
   * same dedup + map + dispatch path.
   *
   * Dedup keys on `message_id`, not an envelope event_id: the long
   * connection can redeliver the same message after a reconnect, and
   * `message_id` is the stable identifier present on every event. A
   * message with no usable id is delivered rather than dropped.
   */
  async handleMessageReceive(event: LarkMessageReceiveEvent): Promise<void> {
    const messageId = event?.message?.message_id
    if (!this.recordDelivered(messageId)) return
    const imMsg = larkToImMessage(event, { stripBotMentions: this.stripBotMentions })
    if (imMsg) await this.deliver(imMsg)
  }

  // --- internal -------------------------------------------------

  private recordDelivered(messageId: unknown): boolean {
    if (typeof messageId !== 'string' || messageId.length === 0) return true
    if (this.deliveredMessageIds.has(messageId)) return false
    this.deliveredMessageIds.add(messageId)
    this.deliveredOrder.push(messageId)
    if (this.deliveredOrder.length > DELIVERED_CACHE_MAX) {
      const drop = this.deliveredOrder.shift()!
      this.deliveredMessageIds.delete(drop)
    }
    return true
  }

  private async deliver(msg: ImMessage): Promise<void> {
    for (const l of this.listeners) {
      try {
        await l(msg)
      } catch (err) {
        // A listener that throws doesn't stop other listeners or
        // future events. Diagnostic via onError.
        this.onError(err)
      }
    }
  }
}
