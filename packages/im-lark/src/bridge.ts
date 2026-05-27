/**
 * `ImBridge` implementation for Lark / Feishu. Webhook
 * (Event Subscription) mode.
 *
 * Why webhook instead of long-poll like Telegram / Matrix:
 *
 *   - Lark's Open Platform has no general-purpose long-poll API. Bot
 *     authors are expected to register an HTTPS callback URL in the
 *     admin panel and receive events as POSTs.
 *   - Feishu / Lark itself takes care of retry + dedup hints
 *     (event_id), so the bridge's responsibility shrinks to:
 *     verify, dedup, dispatch.
 *
 * Threading model:
 *
 *   start() ─► http.createServer().listen()
 *                 │
 *                 ├─ POST <webhookPath> → handleHttp() → handleEvent()
 *                 │      url_verification challenge → echo
 *                 │      im.message.receive_v1 → larkToImMessage → listener
 *                 │      unknown event type → 200 ack + skip
 *                 │
 *                 └─ verification token mismatch → 401 + onError
 *
 *   stop() flips `running=false`, closes the HTTP server, drains
 *   in-flight handlers.
 *
 * The HTTP server is OPTIONAL — set `webhookPort: 0` and the bridge
 * just exposes `handleEvent(body)` for the host to drive itself.
 * Host-side integrations that already run an HTTP server (e.g.
 * @aipehub/web) can route `POST /lark/webhook` straight into
 * `handleEvent` without the bridge spawning its own listener.
 *
 * What's NOT in M4 (deliberate):
 *
 *   - Encrypted webhooks. Lark supports an `encrypt_key` mode where
 *     the body is `{ "encrypt": "<AES-encrypted>" }`. We only handle
 *     the plaintext mode. The verification-token check is still
 *     mandatory.
 *   - Outbound attachments / images. `sendMessage` with attachments
 *     surfaces via `onError` and sends text only — same decision as
 *     Telegram M2 / Matrix M3.
 *   - Card / interactive messages. Bot replies use plain text msg_type.
 *   - TLS termination. The bridge binds plain HTTP. Production
 *     deployments MUST front it with a reverse proxy that supplies
 *     TLS — Lark requires HTTPS for webhooks.
 *
 * Note on `auto-strip @bot mentions`:
 *   Group messages embed `<at user_id="...">@Bot</at>` in the text.
 *   `parseImCommand` chokes on the leading tag, so the bridge strips
 *   them by default. Set `stripBotMentions: false` to preserve.
 */

import * as http from 'node:http'

import type {
  ImAttachment,
  ImBridge,
  ImMessage,
  ImUser,
} from '@aipehub/im-adapter'

import {
  createLarkClient,
  type LarkClient,
  type LarkClientOptions,
} from './client.js'
import { larkToImMessage, pickLarkReceiveIdType } from './message.js'
import type {
  LarkEventEnvelope,
  LarkMessageReceiveEvent,
  LarkSendMessageResponse,
  LarkUrlVerification,
} from './types.js'

export interface LarkBridgeOptions {
  /** App ID from Lark Open Platform (cli_xxx). */
  appId: string
  /** App secret. */
  appSecret: string
  /**
   * Verification Token configured in the Lark Open Platform admin
   * panel. Every inbound event carries this in `header.token` (or
   * top-level `token` for url_verification); bridge rejects events
   * whose token doesn't match.
   */
  verificationToken: string
  /** Override the underlying client. Mostly for tests. */
  client?: LarkClient
  /**
   * Port for the built-in HTTP webhook server. Default 9090. Set to
   * `0` to disable the listener — the host can then drive
   * `handleEvent` directly from its own HTTP layer.
   */
  webhookPort?: number
  /** Bind host. Default '0.0.0.0'. */
  webhookHost?: string
  /** Webhook path. Default '/lark/webhook'. */
  webhookPath?: string
  /**
   * Strip `<at user_id="...">@Bot</at>` from inbound text bodies.
   * Default `true` — group chats interpolate this, downstream
   * command parsing wants clean text.
   */
  stripBotMentions?: boolean
  /**
   * Forwarded to `createLarkClient` when `client` isn't supplied.
   */
  clientOptions?: Omit<LarkClientOptions, 'appId' | 'appSecret'>
  /**
   * Called on webhook errors, listener exceptions, and other
   * background failures. The bridge never throws into the caller
   * from request-handling code; this is the diagnostic surface.
   * Defaults to a no-op.
   */
  onError?: (err: unknown) => void
}

type Listener = (msg: ImMessage) => void | Promise<void>

/** Bounded dedup cache size for event_id. ~512 ≈ a few minutes of busy traffic. */
const DELIVERED_CACHE_MAX = 512

export class LarkBridge implements ImBridge {
  readonly platform = 'lark'

  private readonly client: LarkClient
  private readonly verificationToken: string
  private readonly webhookPort: number
  private readonly webhookHost: string
  private readonly webhookPath: string
  private readonly stripBotMentions: boolean
  private readonly onError: (err: unknown) => void

  private running = false
  private listeners: Listener[] = []
  private server: http.Server | null = null
  private deliveredEventIds: Set<string> = new Set()
  private deliveredOrder: string[] = []

  constructor(opts: LarkBridgeOptions) {
    if (typeof opts.verificationToken !== 'string' || opts.verificationToken.length === 0) {
      throw new TypeError('LarkBridge: verificationToken is required')
    }
    this.client =
      opts.client ??
      createLarkClient({
        appId: opts.appId,
        appSecret: opts.appSecret,
        ...opts.clientOptions,
      })
    this.verificationToken = opts.verificationToken
    this.webhookPort = opts.webhookPort ?? 9090
    this.webhookHost = opts.webhookHost ?? '0.0.0.0'
    this.webhookPath = opts.webhookPath ?? '/lark/webhook'
    this.stripBotMentions = opts.stripBotMentions ?? true
    this.onError = opts.onError ?? (() => {})
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    if (this.webhookPort > 0) {
      this.server = http.createServer((req, res) => {
        // Don't await — the http.Server invokes us synchronously.
        // handleHttp catches everything internally.
        void this.handleHttp(req, res)
      })
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          this.server?.off('listening', onListening)
          reject(err)
        }
        const onListening = (): void => {
          this.server?.off('error', onError)
          resolve()
        }
        this.server!.once('error', onError)
        this.server!.once('listening', onListening)
        this.server!.listen(this.webhookPort, this.webhookHost)
      })
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    if (this.server) {
      // `close()` rejects new connections but lets in-flight ones
      // drain. We don't force-kill — outstanding webhook deliveries
      // should be allowed to acknowledge so Lark doesn't retry.
      const srv = this.server
      this.server = null
      await new Promise<void>((resolve) => {
        srv.close(() => resolve())
      })
    }
  }

  async sendMessage(
    to: ImUser,
    text: string,
    options?: { attachments?: ImAttachment[]; chatId?: string },
  ): Promise<void> {
    if (options?.attachments && options.attachments.length > 0) {
      // Mirror the Telegram M2 / Matrix M3 decision: don't silently
      // drop; surface via onError so operators know. Text still goes out.
      this.onError(
        new Error(
          'LarkBridge.sendMessage: outbound attachments not yet supported; sending text only',
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

  // --- public-but-low-level: host-driven webhook entry point -------

  /**
   * Handle one decoded event body. Public so hosts that drive HTTP
   * themselves can route the parsed JSON straight in without the
   * bridge owning the listener. Tests use it the same way.
   *
   * Return value:
   *   - For url_verification: returns `{ challenge }` for the caller
   *     to echo back to Lark.
   *   - For event envelopes: returns `undefined`; the caller should
   *     respond `200 {}` to ack receipt.
   *
   * Throws when the verification token doesn't match — caller should
   * respond 401 + log via onError.
   */
  async handleEvent(body: unknown): Promise<{ challenge: string } | undefined> {
    if (!body || typeof body !== 'object') {
      throw new Error('LarkBridge.handleEvent: body must be an object')
    }
    const b = body as Record<string, unknown>
    // 1. url_verification handshake (called when the webhook URL is
    //    first configured in the admin panel).
    if (b.type === 'url_verification') {
      const v = body as LarkUrlVerification
      if (v.token !== this.verificationToken) {
        throw new Error('LarkBridge: url_verification token mismatch')
      }
      if (typeof v.challenge !== 'string' || v.challenge.length === 0) {
        throw new Error('LarkBridge: url_verification missing challenge')
      }
      return { challenge: v.challenge }
    }
    // 2. Schema 2.0 event envelope. Schema 1.0 is rejected — Lark
    //    moved everyone to 2.0 by 2023 and we don't want two
    //    code paths.
    if (b.schema !== '2.0') {
      throw new Error('LarkBridge: only Schema 2.0 events are supported')
    }
    const env = body as LarkEventEnvelope
    if (!env.header || env.header.token !== this.verificationToken) {
      throw new Error('LarkBridge: event token mismatch')
    }
    // Dedup by event_id. Lark may retry on slow ack; if we already
    // processed this id, ack quickly without re-dispatch.
    if (!this.recordDelivered(env.header.event_id)) return undefined
    // M4 only handles message receive. Other event types ack 200 +
    // skip silently — keeps Lark from disabling the subscription due
    // to repeated 4xx responses.
    if (env.header.event_type === 'im.message.receive_v1') {
      const ev = env.event as LarkMessageReceiveEvent
      const imMsg = larkToImMessage(ev, { stripBotMentions: this.stripBotMentions })
      if (imMsg) await this.deliver(imMsg)
    }
    return undefined
  }

  // --- internal -------------------------------------------------

  private recordDelivered(eventId: string): boolean {
    if (typeof eventId !== 'string' || eventId.length === 0) return true
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
        // A listener that throws doesn't stop other listeners or
        // future webhook calls. Diagnostic via onError.
        this.onError(err)
      }
    }
  }

  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Liveness probe — return 200 on any GET so a load balancer can
    // health-check without thinking the bridge is down.
    if (req.method === 'GET') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/plain')
      res.end('lark-bridge ok')
      return
    }
    if (req.method !== 'POST' || req.url !== this.webhookPath) {
      res.statusCode = 404
      res.end()
      return
    }
    let body: unknown
    try {
      const raw = await readBody(req)
      body = JSON.parse(raw)
    } catch (err) {
      this.onError(err)
      res.statusCode = 400
      res.end()
      return
    }
    try {
      const result = await this.handleEvent(body)
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(result ?? {}))
    } catch (err) {
      // Verification-token mismatch and similar request errors land
      // here. Status code: 401 for token failures (tells Lark to
      // disable the subscription rather than retry forever); 400 for
      // anything else.
      this.onError(err)
      const msg = err instanceof Error ? err.message : String(err)
      res.statusCode = msg.includes('token mismatch') ? 401 : 400
      res.end()
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the full request body as a UTF-8 string. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
