/**
 * `ImBridge` implementation for Slack. Events API webhook mode.
 *
 * Why webhook instead of long-poll / WebSocket:
 *
 *   - Slack's Events API is the recommended bot transport. The
 *     legacy RTM (WebSocket) API is deprecated for new apps; new
 *     workspaces can't even enable it.
 *   - Slack handles retry + dedup hints (event_id), so the bridge's
 *     responsibility shrinks to: verify signature, dedup, dispatch.
 *
 * Threading model:
 *
 *   start() ─► http.createServer().listen()
 *                 │
 *                 ├─ POST <webhookPath> → handleHttp() → handleEvent()
 *                 │      url_verification challenge → echo
 *                 │      event_callback{event:message} → slackToImMessage → listener
 *                 │      other event types → 200 ack + skip
 *                 │
 *                 └─ signature mismatch → 401 + onError
 *
 *   stop() flips `running=false`, closes the HTTP server, drains
 *   in-flight handlers.
 *
 * The HTTP server is OPTIONAL — set `webhookPort: 0` and the bridge
 * just exposes `handleRawRequest(rawBody, headers)` for the host to
 * drive itself. Host-side integrations that already run an HTTP
 * server (e.g. @aipehub/web) can route `POST /slack/webhook` straight
 * in without the bridge spawning its own listener.
 *
 * What's NOT in M6 (deliberate):
 *
 *   - OAuth installation flow. Bridge assumes the host has already
 *     obtained the bot token + signing secret via Slack's app config
 *     screen ("OAuth & Permissions" + "Basic Information").
 *   - Slash commands / interactivity. Those use a separate "Slash
 *     Commands" / "Interactivity & Shortcuts" request URL with the
 *     same HMAC scheme — easy to add in a follow-up milestone.
 *   - Outbound attachments / blocks / threads. `sendMessage` with
 *     attachments surfaces via `onError` and sends text only — same
 *     decision as Telegram M2 / Matrix M3 / Lark M4 / Discord M5.
 *   - TLS termination. Bridge binds plain HTTP. Production
 *     deployments MUST front it with a reverse proxy that supplies
 *     TLS — Slack requires HTTPS for the request URL.
 *   - auth.test on start. Caller passes `botUserId` explicitly OR the
 *     bridge captures it from the first inbound event's `authorizations`
 *     array. Skips an extra round trip on every cold boot.
 *
 * Note on `auto-strip @bot mentions`:
 *   Group / channel replies prefix `<@UBOT…> /help`. `parseImCommand`
 *   chokes on the leading token, so the bridge strips by default. Set
 *   `stripBotMentions: false` to preserve.
 */

import * as http from 'node:http'

import type {
  ImAttachment,
  ImBridge,
  ImMessage,
  ImUser,
} from '@aipehub/im-adapter'

import {
  createSlackClient,
  type SlackClient,
  type SlackClientOptions,
} from './client.js'
import { slackToImMessage, verifySlackSignature } from './message.js'
import type {
  SlackEventCallback,
  SlackMessageEvent,
  SlackPostMessageRequest,
  SlackPostMessageResponse,
  SlackUrlVerification,
} from './types.js'

export interface SlackBridgeOptions {
  /**
   * Bot user OAuth token (`xoxb-…`) from the Slack app's
   * "OAuth & Permissions" page. Required.
   */
  token: string
  /**
   * Signing Secret from the Slack app's "Basic Information" page.
   * Used to verify the HMAC signature on every inbound webhook.
   * Required — bridge refuses to start without it.
   */
  signingSecret: string
  /** Override the underlying client. Mostly for tests. */
  client?: SlackClient
  /**
   * Port for the built-in HTTP webhook server. Default 9091 (one off
   * from Lark's 9090 — handy when running both on the same box for a
   * smoke test). Set to `0` to disable the listener — the host can
   * then drive `handleRawRequest` directly from its own HTTP layer.
   */
  webhookPort?: number
  /** Bind host. Default '0.0.0.0'. */
  webhookHost?: string
  /** Webhook path. Default '/slack/webhook'. */
  webhookPath?: string
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
  /** Signature tolerance window in seconds. Defaults to 300 (5 min). */
  signatureToleranceSec?: number
  /**
   * Forwarded to `createSlackClient` when `client` isn't supplied.
   */
  clientOptions?: Omit<SlackClientOptions, 'token'>
  /**
   * Called on webhook errors, listener exceptions, signature
   * mismatches, and other background failures. The bridge never
   * throws into the caller from request-handling code; this is the
   * diagnostic surface. Defaults to a no-op.
   */
  onError?: (err: unknown) => void
}

type Listener = (msg: ImMessage) => void | Promise<void>

/** Bounded dedup cache size for event_id. ~512 ≈ a few minutes of busy traffic. */
const DELIVERED_CACHE_MAX = 512

/**
 * Result the bridge tells the HTTP layer to write back to Slack.
 *
 * Slack treats 2xx as "delivered, do not retry". 4xx triggers retry
 * (~3 attempts within 1 minute). For signature failures we want 401
 * to signal "this isn't a Slack request" — Slack itself never sees
 * the 401, the response goes to whoever is making the (bad) request.
 */
export type SlackHandleResult =
  | { status: 200; body: { challenge: string } | Record<string, never> }
  | { status: 401 | 400; body: { error: string } }

export class SlackBridge implements ImBridge {
  readonly platform = 'slack'

  private readonly client: SlackClient
  private readonly signingSecret: string
  private readonly webhookPort: number
  private readonly webhookHost: string
  private readonly webhookPath: string
  private readonly stripBotMentions: boolean
  private readonly signatureToleranceSec: number
  private readonly onError: (err: unknown) => void

  private running = false
  private listeners: Listener[] = []
  private server: http.Server | null = null
  private deliveredEventIds: Set<string> = new Set()
  private deliveredOrder: string[] = []
  private botUserId: string | null

  constructor(opts: SlackBridgeOptions) {
    if (typeof opts?.token !== 'string' || opts.token.length === 0) {
      throw new TypeError('SlackBridge: token is required')
    }
    if (typeof opts?.signingSecret !== 'string' || opts.signingSecret.length === 0) {
      throw new TypeError('SlackBridge: signingSecret is required')
    }
    this.client =
      opts.client ??
      createSlackClient({
        token: opts.token,
        ...opts.clientOptions,
      })
    this.signingSecret = opts.signingSecret
    this.webhookPort = opts.webhookPort ?? 9091
    this.webhookHost = opts.webhookHost ?? '0.0.0.0'
    this.webhookPath = opts.webhookPath ?? '/slack/webhook'
    this.stripBotMentions = opts.stripBotMentions ?? true
    this.signatureToleranceSec = opts.signatureToleranceSec ?? 300
    this.onError = opts.onError ?? (() => {})
    this.botUserId = opts.botUserId ?? null
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
      // Mirror the M2/M3/M4/M5 decision: don't silently drop; surface
      // via onError so operators know. Text still goes out.
      this.onError(
        new Error(
          'SlackBridge.sendMessage: outbound attachments not yet supported; sending text only',
        ),
      )
    }
    // Slack accepts user id (`U…`) as the `channel` field for DMs, OR
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

  // --- public-but-low-level: host-driven webhook entry point -------

  /**
   * Handle one raw webhook request. Public so hosts that drive HTTP
   * themselves can hand the raw bytes + headers straight in.
   *
   * Returns the desired HTTP response — the caller writes it.
   *
   * `rawBody` MUST be the unmodified UTF-8 bytes Slack sent. Even a
   * stray re-stringify of parsed JSON changes whitespace and breaks
   * the HMAC. Bridge's own HTTP handler buffers chunks before
   * touching the body.
   */
  async handleRawRequest(
    rawBody: string,
    headers: { signature?: string | null; timestamp?: string | null },
  ): Promise<SlackHandleResult> {
    const verify = verifySlackSignature({
      signingSecret: this.signingSecret,
      signature: headers.signature ?? null,
      timestamp: headers.timestamp ?? null,
      rawBody,
      toleranceSec: this.signatureToleranceSec,
    })
    if (!verify.ok) {
      const err = new Error(`SlackBridge: signature verification failed (${verify.reason})`)
      this.onError(err)
      return { status: 401, body: { error: verify.reason } }
    }
    let body: unknown
    try {
      body = JSON.parse(rawBody)
    } catch (err) {
      this.onError(err)
      return { status: 400, body: { error: 'invalid_json' } }
    }
    try {
      const result = await this.handleEvent(body)
      return { status: 200, body: result ?? {} }
    } catch (err) {
      this.onError(err)
      return { status: 400, body: { error: 'event_handler_failed' } }
    }
  }

  /**
   * Handle one already-parsed event body. Public so tests can drive
   * the inner state machine without composing raw HMAC signatures.
   *
   * Return value:
   *   - url_verification: `{ challenge }` to echo back.
   *   - event_callback: undefined; the caller should write `200 {}`
   *     to ack receipt.
   *
   * Throws when the envelope shape is malformed — caller responds 400.
   */
  async handleEvent(body: unknown): Promise<{ challenge: string } | undefined> {
    if (!body || typeof body !== 'object') {
      throw new Error('SlackBridge.handleEvent: body must be an object')
    }
    const b = body as Record<string, unknown>
    // 1. url_verification handshake (sent once when the request URL
    //    is configured in the Slack app dashboard).
    if (b.type === 'url_verification') {
      const v = body as SlackUrlVerification
      if (typeof v.challenge !== 'string' || v.challenge.length === 0) {
        throw new Error('SlackBridge: url_verification missing challenge')
      }
      return { challenge: v.challenge }
    }
    // 2. event_callback — the only other envelope we accept.
    if (b.type !== 'event_callback') {
      // Other top-level types (app_rate_limited at the moment) just
      // ack 200; logging them here would be noise.
      return undefined
    }
    const env = body as SlackEventCallback
    // Capture the bot user id opportunistically — `authorizations`
    // is delivered with every event_callback in the modern Events
    // API. First match where `is_bot: true` wins.
    if (!this.botUserId && Array.isArray(env.authorizations)) {
      for (const a of env.authorizations) {
        if (a.is_bot && typeof a.user_id === 'string') {
          this.botUserId = a.user_id
          break
        }
      }
    }
    // Dedup by event_id. Slack retries on slow ack; ack quickly
    // without re-dispatch.
    if (typeof env.event_id === 'string') {
      if (!this.recordDelivered(env.event_id)) return undefined
    }
    // Only `message` events bridge into the Hub in M6. Other event
    // types ack 200 + skip silently — keeps Slack from disabling the
    // subscription due to repeated 4xx responses.
    const event = env.event as { type?: string } | undefined
    if (event?.type === 'message') {
      const imMsg = slackToImMessage(event as SlackMessageEvent, {
        botUserId: this.botUserId,
        stripBotMentions: this.stripBotMentions,
      })
      if (imMsg) await this.deliver(imMsg)
    }
    return undefined
  }

  // --- internal ----------------------------------------------------

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

  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method === 'GET') {
      // Liveness probe.
      res.statusCode = 200
      res.setHeader('content-type', 'text/plain')
      res.end('slack-bridge ok')
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
    const signature = pickHeader(req.headers['x-slack-signature'])
    const timestamp = pickHeader(req.headers['x-slack-request-timestamp'])
    const result = await this.handleRawRequest(rawBody, { signature, timestamp })
    res.statusCode = result.status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(result.body))
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

/** Header values from http.IncomingMessage may be string | string[]; flatten. */
function pickHeader(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length > 0) return value[0] ?? null
  return null
}
