/**
 * `ImBridge` implementation for QQ via the OFFICIAL Bot API (webhook).
 *
 * This replaces the previous OneBot v11 forward-WS bridge wholesale. The
 * official QQ open platform (https://bot.q.qq.com) discontinued its
 * WebSocket gateway (end-2024) and now delivers events over an HTTP
 * **webhook**: the bot registers a public callback URL and QQ POSTs
 * events to it.
 *
 * Structural template = the Slack / Lark webhook bridges (HTTP server +
 * `handleRawRequest` + `handleEvent`), NOT the Discord WS gateway.
 *
 * Two inbound flows over the one webhook:
 *
 *   start() ─► http.createServer().listen()
 *                 │
 *                 ├─ POST <webhookPath>, op:13 → sign(event_ts+plain_token)
 *                 │      → 200 { plain_token, signature }   (callback validation)
 *                 │
 *                 └─ POST <webhookPath>, op:0  → verify Ed25519(timestamp+rawBody)
 *                        → handleEvent → qqToImMessage → listeners → 200 {}
 *                        signature mismatch → 401
 *
 * The HTTP server is OPTIONAL — set `webhookPort: 0` and the host drives
 * `handleRawRequest(rawBody, headers)` from its own HTTP layer (e.g. a
 * reverse-proxied `@aipehub/web` route). The raw body MUST be the
 * unmodified bytes QQ sent — the op:0 signature is over `timestamp +
 * rawBody`, so a re-stringify of parsed JSON breaks it.
 *
 * ── Passive-reply only (an official platform limitation, not a gap) ──
 *
 *   Group / C2C messages can only be replied to PASSIVELY: within a
 *   short window after a user message, carrying that message's `msg_id`
 *   (+ an incrementing `msg_seq`). Proactive push to group/C2C was
 *   discontinued (2025-04). So `sendMessage` works as a reply to an
 *   inbound message, but throws an honest error when asked to push to a
 *   chat the bridge has never received a message from — the bridge
 *   cannot fabricate the `msg_id` a passive reply requires. Heartbeat /
 *   alert agents therefore cannot push unsolicited messages to QQ.
 *
 * What's NOT in this milestone (deliberate):
 *   - Rich media (image/audio/file). Text only; media via the official
 *     rich-media upload API is a follow-up.
 *   - Guild proactive sends. Guild channels historically allowed some
 *     proactive sends, but MVP treats every surface as passive-reply for
 *     a single honest model.
 */

import * as http from 'node:http'
import type { KeyObject } from 'node:crypto'

import type {
  ImAttachment,
  ImBridge,
  ImMessage,
  ImUser,
} from '@aipehub/im-adapter'

import {
  createQqClient,
  type QqClient,
  type QqClientOptions,
} from './client.js'
import { deriveQqKeyPair, signQqCallback, verifyQqEventSignature } from './qq-crypto.js'
import { parseQqChatId, qqToImMessage } from './message.js'
import {
  QQ_OP_DISPATCH,
  QQ_OP_VALIDATION,
  type QqValidationData,
  type QqWebhookPayload,
} from './types.js'

export interface QqBridgeOptions {
  /** Bot AppID from the QQ open platform. Required. */
  appId: string
  /**
   * Bot ClientSecret (a.k.a. AppSecret). Required — it drives BOTH the
   * Ed25519 keypair (callback signing + event verification) and the
   * app-access-token mint. The legacy `Token` value is unused on the
   * webhook + v2 REST path, so the bridge doesn't take it.
   */
  secret: string
  /** Override the underlying client. Mostly for tests. */
  client?: QqClient
  /** Forwarded to `createQqClient` when `client` isn't supplied. */
  clientOptions?: Omit<QqClientOptions, 'appId' | 'clientSecret'>
  /**
   * Port for the built-in HTTP webhook server. Default 9092 (one off
   * from Slack's 9091). Set to `0` to disable the listener — the host
   * then drives `handleRawRequest` from its own HTTP layer.
   */
  webhookPort?: number
  /** Bind host. Default '0.0.0.0'. */
  webhookHost?: string
  /** Webhook path. Default '/qq/webhook'. */
  webhookPath?: string
  /** Strip the bot's `<@!id>` mention from guild text. Default `true`. */
  stripBotMentions?: boolean
  /** Background diagnostic surface. Defaults to a no-op. */
  onError?: (err: unknown) => void
}

type Listener = (msg: ImMessage) => void | Promise<void>

/** Bounded dedup cache for event ids. ~512 ≈ a few minutes of busy traffic. */
const DELIVERED_CACHE_MAX = 512

/**
 * Result the bridge tells the HTTP layer to write back to QQ.
 *   - op:13 → 200 with the signed `{ plain_token, signature }`.
 *   - op:0  → 200 `{}` ack (QQ treats 2xx as delivered).
 *   - bad signature → 401; malformed → 400.
 */
export type QqHandleResult =
  | { status: 200; body: { plain_token: string; signature: string } | Record<string, never> }
  | { status: 401 | 400; body: { error: string } }

export class QqBridge implements ImBridge {
  readonly platform = 'qq'

  private readonly client: QqClient
  private readonly privateKey: KeyObject
  private readonly publicKey: KeyObject
  private readonly webhookPort: number
  private readonly webhookHost: string
  private readonly webhookPath: string
  private readonly stripBotMentions: boolean
  private readonly onError: (err: unknown) => void

  private running = false
  private listeners: Listener[] = []
  private server: http.Server | null = null
  private deliveredIds: Set<string> = new Set()
  private deliveredOrder: string[] = []
  /**
   * The most recent inbound message per chat — the handle a passive
   * reply needs. `seq` pre-increments per outbound so multiple replies
   * to the same `msg_id` don't collide (QQ rejects duplicate msg_seq).
   */
  private lastReply: Map<string, { msgId: string; seq: number }> = new Map()

  constructor(opts: QqBridgeOptions) {
    if (typeof opts?.appId !== 'string' || opts.appId.length === 0) {
      throw new TypeError('QqBridge: appId is required')
    }
    if (typeof opts?.secret !== 'string' || opts.secret.length === 0) {
      throw new TypeError('QqBridge: secret is required')
    }
    const keyPair = deriveQqKeyPair(opts.secret)
    this.privateKey = keyPair.privateKey
    this.publicKey = keyPair.publicKey
    this.client =
      opts.client ??
      createQqClient({
        appId: opts.appId,
        clientSecret: opts.secret,
        ...opts.clientOptions,
      })
    this.webhookPort = opts.webhookPort ?? 9092
    this.webhookHost = opts.webhookHost ?? '0.0.0.0'
    this.webhookPath = opts.webhookPath ?? '/qq/webhook'
    this.stripBotMentions = opts.stripBotMentions ?? true
    this.onError = opts.onError ?? (() => {})
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    if (this.webhookPort > 0) {
      this.server = http.createServer((req, res) => {
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
      this.onError(
        new Error(
          'QqBridge.sendMessage: outbound attachments not yet supported; sending text only',
        ),
      )
    }
    const chatId = options?.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) {
      throw new Error(
        'QqBridge.sendMessage: chatId is required — QQ needs the originating group/C2C/channel id',
      )
    }
    const parsed = parseQqChatId(chatId)
    if (!parsed) {
      throw new Error(
        `QqBridge.sendMessage: malformed chatId ${JSON.stringify(chatId)}; expected "group:"/"c2c:"/"channel:"/"dm:"`,
      )
    }
    // Passive-reply model: we can only answer a message we actually
    // received (it carries the msg_id a reply requires). Proactive push
    // to a group/C2C was discontinued by the platform — honest-fail
    // rather than silently no-op, so an alert agent learns QQ can't be
    // a push target.
    const handle = this.lastReply.get(chatId)
    if (!handle || handle.msgId.length === 0) {
      throw new Error(
        `QqBridge.sendMessage: no inbound message to reply to for ${chatId}. ` +
          'QQ only permits PASSIVE replies (within the window after a user message); ' +
          'proactive push to QQ groups/users was discontinued by the platform.',
      )
    }
    handle.seq += 1
    const seq = handle.seq
    switch (parsed.kind) {
      case 'group':
        await this.client.sendGroupMessage(parsed.id, {
          content: text,
          msg_id: handle.msgId,
          msg_seq: seq,
        })
        return
      case 'c2c':
        await this.client.sendC2CMessage(parsed.id, {
          content: text,
          msg_id: handle.msgId,
          msg_seq: seq,
        })
        return
      case 'channel':
        await this.client.sendChannelMessage(parsed.id, {
          content: text,
          msg_id: handle.msgId,
        })
        return
      case 'dm':
        await this.client.sendGuildDirectMessage(parsed.id, {
          content: text,
          msg_id: handle.msgId,
        })
        return
    }
  }

  onMessage(listener: Listener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  // --- public-but-low-level: host-driven webhook entry point ---------

  /**
   * Handle one raw webhook request. Public so hosts that own the HTTP
   * layer hand the raw bytes + signature headers straight in.
   *
   * Discriminates on `op` BEFORE verifying, because op:13 (callback
   * validation) is itself unsigned — it's the bootstrap that proves the
   * bot holds the secret. op:0 events ARE signed and verified over the
   * UNMODIFIED `rawBody`.
   */
  async handleRawRequest(
    rawBody: string,
    headers: { signature?: string | null; timestamp?: string | null },
  ): Promise<QqHandleResult> {
    let payload: QqWebhookPayload
    try {
      payload = JSON.parse(rawBody) as QqWebhookPayload
    } catch (err) {
      this.onError(err)
      return { status: 400, body: { error: 'invalid_json' } }
    }
    if (!payload || typeof payload !== 'object' || typeof payload.op !== 'number') {
      return { status: 400, body: { error: 'invalid_payload' } }
    }

    // op:13 — callback validation. Unsigned; we PROVE we hold the secret
    // by signing event_ts + plain_token and echoing it back.
    if (payload.op === QQ_OP_VALIDATION) {
      const d = payload.d as QqValidationData | undefined
      if (
        !d ||
        typeof d.plain_token !== 'string' ||
        typeof d.event_ts !== 'string'
      ) {
        return { status: 400, body: { error: 'invalid_validation_payload' } }
      }
      const signature = signQqCallback(this.privateKey, d.event_ts, d.plain_token)
      return { status: 200, body: { plain_token: d.plain_token, signature } }
    }

    // op:0 — a dispatched event. Verify the Ed25519 signature before
    // trusting anything in the body.
    if (payload.op === QQ_OP_DISPATCH) {
      const ok = verifyQqEventSignature(this.publicKey, {
        signature: headers.signature ?? '',
        timestamp: headers.timestamp ?? '',
        rawBody,
      })
      if (!ok) {
        this.onError(new Error('QqBridge: event signature verification failed'))
        return { status: 401, body: { error: 'bad_signature' } }
      }
      try {
        await this.handleEvent(payload)
      } catch (err) {
        this.onError(err)
        return { status: 400, body: { error: 'event_handler_failed' } }
      }
      return { status: 200, body: {} }
    }

    // Any other op (heartbeat-ish / resume on the deprecated gateway) —
    // ack so QQ doesn't keep retrying.
    return { status: 200, body: {} }
  }

  /**
   * Handle one already-parsed dispatch (op:0) payload. Public so tests
   * can drive the inner state machine without composing Ed25519
   * signatures. Dedups by event id, maps to `ImMessage`, remembers the
   * reply handle, and delivers to listeners.
   */
  async handleEvent(payload: QqWebhookPayload): Promise<void> {
    if (payload.op !== QQ_OP_DISPATCH) return
    // Dedup — QQ retries on a slow ack.
    if (typeof payload.id === 'string' && payload.id.length > 0) {
      if (!this.recordDelivered(payload.id)) return
    }
    const imMsg = qqToImMessage(payload, { stripBotMentions: this.stripBotMentions })
    if (!imMsg) return
    // Remember the reply handle so a later sendMessage to this chat can
    // be a passive reply. Reset seq to 0 for the new inbound message.
    if (
      typeof imMsg.chatId === 'string' &&
      imMsg.chatId.length > 0 &&
      typeof imMsg.messageId === 'string' &&
      imMsg.messageId.length > 0
    ) {
      this.lastReply.set(imMsg.chatId, { msgId: imMsg.messageId, seq: 0 })
    }
    await this.deliver(imMsg)
  }

  // --- internal ------------------------------------------------------

  private recordDelivered(id: string): boolean {
    if (this.deliveredIds.has(id)) return false
    this.deliveredIds.add(id)
    this.deliveredOrder.push(id)
    if (this.deliveredOrder.length > DELIVERED_CACHE_MAX) {
      const drop = this.deliveredOrder.shift()!
      this.deliveredIds.delete(drop)
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

  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method === 'GET') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/plain')
      res.end('qq-bridge ok')
      return
    }
    if (req.method !== 'POST' || req.url !== this.webhookPath) {
      res.statusCode = 404
      res.end()
      return
    }
    let rawBody: string
    try {
      rawBody = await readBody(req)
    } catch (err) {
      this.onError(err)
      res.statusCode = 400
      res.end()
      return
    }
    const signature = pickHeader(req.headers['x-signature-ed25519'])
    const timestamp = pickHeader(req.headers['x-signature-timestamp'])
    const result = await this.handleRawRequest(rawBody, { signature, timestamp })
    res.statusCode = result.status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(result.body))
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the full request body as a UTF-8 string (raw — signature depends on it). */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Header values may be string | string[]; flatten to the first. */
function pickHeader(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length > 0) return value[0] ?? null
  return null
}
