/**
 * `ImBridge` implementation for WeChat via the official iLink Bot API.
 * Long-polling — iLink has NO webhook mode, so this is the protocol's own
 * shape, not a deployment choice: works from a NAT'd home box, no tunnel.
 *
 * Structural template = TelegramBridge (long-poll loop + sequential
 * delivery + self-healing backoff), with four iLink-specific deltas:
 *
 *   1. **String cursor.** `get_updates_buf` is an opaque server token, not
 *      a numeric offset. We cache the latest and send it back; nothing is
 *      persisted across restarts (there is no history API — issue #164 —
 *      so a cold start simply begins at "now").
 *
 *   2. **Context-token ledger (passive-reply model).** iLink cannot push
 *      unsolicited messages: a send must echo the `context_token` from an
 *      inbound message of that peer. The bridge keeps the latest token per
 *      peer in memory and `sendMessage` throws an HONEST error for a peer
 *      it has never heard from (mirroring the QQ bridge's passive-reply
 *      posture) — the host's outbox then holds the message and retries
 *      when the member next speaks. Community field reports (issues
 *      #185/#202) say tokens go stale after ~24h of silence; the server is
 *      the judge, so we don't expire locally — a stale-token send fails
 *      loudly and the outbox does its job.
 *
 *   3. **Stale-session cooldown.** `errcode: -14` on getupdates means the
 *      bot session expired server-side. The official plugin's session-guard
 *      pauses ALL calls for 60 minutes (hammering just prolongs it); we
 *      mirror exactly that, surface it via `onError` once, and keep the
 *      loop alive so it self-heals after the window.
 *
 *   4. **Abortable stop.** iLink's long-poll accepts an abort signal, so
 *      `stop()` cancels the in-flight poll immediately instead of waiting
 *      out the 35s hold. The cursor stays where it was; the next start
 *      re-polls from it (at-least-once, same as Telegram's replay).
 */

import type { ImAttachment, ImBridge, ImMessage, ImUser } from '@gotong/im-adapter'

import {
  createWechatIlinkClient,
  STALE_SESSION_PAUSE_MS,
  STALE_TOKEN_ERRCODE,
  type WechatIlinkClient,
  type WechatIlinkClientOptions,
} from './client.js'
import { wechatContextToken, wechatToImMessage } from './message.js'
import type { WechatMessage } from './types.js'

export interface WechatBridgeOptions {
  /** `bot_token` from the QR login flow (`gotong wechat-login`). */
  token: string
  /** API base returned by the login flow (`baseurl`). Defaults to the
   *  bootstrap host — logins that didn't capture it still work; IDC
   *  affinity is an optimization, not a requirement. */
  baseUrl?: string
  /** Override the underlying client. Mostly for tests. */
  client?: WechatIlinkClient
  /** Forwarded to `createWechatIlinkClient` when `client` isn't supplied. */
  clientOptions?: Omit<WechatIlinkClientOptions, 'token' | 'baseUrl'>
  /** Sleep after a transient poll failure. Default 1000ms. */
  retryBackoffMs?: number
  /** Ledger capacity — peers beyond this evict the oldest entry. One entry
   *  per human the bot talks to, so 4096 is "never in practice". */
  maxLedgerEntries?: number
  /** Injectable clock (cooldown tests). Defaults to Date.now. */
  now?: () => number
  /** Background diagnostic surface. Defaults to a no-op. */
  onError?: (err: unknown) => void
}

type Listener = (msg: ImMessage) => void | Promise<void>

/** Longest single sleep while cooling down — keeps stop() responsive and
 *  re-checks the clock often enough to resume promptly. */
const COOLDOWN_SLEEP_CAP_MS = 30_000

export class WechatBridge implements ImBridge {
  readonly platform = 'wechat'

  private readonly client: WechatIlinkClient
  private readonly retryBackoffMs: number
  private readonly maxLedgerEntries: number
  private readonly now: () => number
  private readonly onError: (err: unknown) => void

  private running = false
  private listeners: Listener[] = []
  private pollPromise: Promise<void> | null = null
  private pollAbort: AbortController | null = null

  /** Opaque server cursor; '' = start from "now". */
  private getUpdatesBuf = ''
  /** peer platformUserId → latest conversation-window token. Insertion order
   *  doubles as the eviction order (Map preserves it; re-insert refreshes). */
  private readonly contextTokens = new Map<string, string>()
  /** Non-zero while the -14 stale-session cooldown is active. */
  private pausedUntil = 0
  private pauseReported = false

  constructor(opts: WechatBridgeOptions) {
    this.client =
      opts.client ??
      createWechatIlinkClient({
        token: opts.token,
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
        ...opts.clientOptions,
      })
    this.retryBackoffMs = opts.retryBackoffMs ?? 1000
    this.maxLedgerEntries = opts.maxLedgerEntries ?? 4096
    this.now = opts.now ?? Date.now
    this.onError = opts.onError ?? (() => {})
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    // Courtesy lifecycle ping (the official plugin sends it; server uses it
    // for presence). Failure must not block the bridge.
    void this.client.notifyStart().catch((err) => this.onError(err))
    this.pollPromise = this.pollLoop()
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    // Cancel the in-flight 35s hold NOW — the client folds the abort into an
    // empty page, the loop re-checks `running` and exits.
    this.pollAbort?.abort()
    if (this.pollPromise) {
      try {
        await this.pollPromise
      } catch {
        // pollLoop never rejects — defensive only.
      }
      this.pollPromise = null
    }
    void this.client.notifyStop().catch((err) => this.onError(err))
  }

  /**
   * Passive-reply send. `to.platformUserId` must be a peer this bridge has
   * heard from (we need their window token); otherwise this throws honestly
   * so the caller's outbox can hold + retry, never a silent drop.
   */
  async sendMessage(
    to: ImUser,
    text: string,
    options?: { attachments?: ImAttachment[]; chatId?: string },
  ): Promise<void> {
    const peer = options?.chatId ?? to.platformUserId
    if (this.pausedUntil > this.now()) {
      const remainingMin = Math.ceil((this.pausedUntil - this.now()) / 60_000)
      throw new Error(
        `WechatBridge.sendMessage: session cooling down after stale-token errcode ${STALE_TOKEN_ERRCODE} (~${remainingMin} min left)`,
      )
    }
    if (options?.attachments && options.attachments.length > 0) {
      // Text-only for now (media = AES-128-ECB + CDN, deferred). Don't
      // silently drop — the host should know we ignored them.
      this.onError(
        new Error('WechatBridge.sendMessage: outbound attachments not yet supported; sending text only'),
      )
    }
    const contextToken = this.contextTokens.get(peer)
    if (!contextToken) {
      throw new Error(
        `WechatBridge.sendMessage: no context_token for peer ${peer} — iLink only allows replies to conversations the user opened; the message can be retried after they next write`,
      )
    }
    await this.client.sendTextMessage({ toUserId: peer, text, contextToken })
  }

  onMessage(listener: Listener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  // --- internal -------------------------------------------------

  private async pollLoop(): Promise<void> {
    while (this.running) {
      // Stale-session cooldown: no API calls until the window passes.
      const pauseLeft = this.pausedUntil - this.now()
      if (pauseLeft > 0) {
        await sleep(Math.min(pauseLeft, COOLDOWN_SLEEP_CAP_MS))
        continue
      }
      this.pauseReported = false
      try {
        this.pollAbort = new AbortController()
        const page = await this.client.getUpdates({
          getUpdatesBuf: this.getUpdatesBuf,
          abortSignal: this.pollAbort.signal,
        })
        if (page.errcode === STALE_TOKEN_ERRCODE) {
          this.enterCooldown(page.errmsg)
          continue
        }
        if (page.ret !== undefined && page.ret !== 0) {
          this.onError(
            new Error(`wechat getupdates ret=${page.ret} errmsg=${page.errmsg ?? '(none)'}`),
          )
          if (this.running) await sleep(this.retryBackoffMs)
          continue
        }
        if (typeof page.get_updates_buf === 'string' && page.get_updates_buf.length > 0) {
          this.getUpdatesBuf = page.get_updates_buf
        }
        for (const msg of page.msgs ?? []) {
          this.recordContextToken(msg)
          await this.deliver(msg)
        }
      } catch (err) {
        this.onError(err)
        if (this.running) await sleep(this.retryBackoffMs)
      } finally {
        this.pollAbort = null
      }
    }
  }

  private enterCooldown(errmsg: string | undefined): void {
    this.pausedUntil = this.now() + STALE_SESSION_PAUSE_MS
    if (!this.pauseReported) {
      this.pauseReported = true
      this.onError(
        new Error(
          `wechat session stale (errcode ${STALE_TOKEN_ERRCODE}${errmsg ? `, ${errmsg}` : ''}); pausing all iLink calls for ${STALE_SESSION_PAUSE_MS / 60_000} min (official session-guard behaviour) — if this repeats, re-run the QR login`,
        ),
      )
    }
  }

  /** Remember the latest window token per peer — including from frames the
   *  echo filter later drops (a GENERATING frame carries a fresh token). */
  private recordContextToken(msg: WechatMessage): void {
    const peer = msg.from_user_id?.trim()
    const token = wechatContextToken(msg)
    if (!peer || !token || msg.message_type === 2) return
    // Re-insert so Map order stays "oldest first" for eviction.
    this.contextTokens.delete(peer)
    this.contextTokens.set(peer, token)
    if (this.contextTokens.size > this.maxLedgerEntries) {
      const oldest = this.contextTokens.keys().next().value
      if (oldest !== undefined) this.contextTokens.delete(oldest)
    }
  }

  private async deliver(msg: WechatMessage): Promise<void> {
    const imMsg = wechatToImMessage(msg)
    if (!imMsg) return // bot echo / streaming frame / empty — skip
    for (const l of this.listeners) {
      try {
        await l(imMsg)
      } catch (err) {
        // A listener that throws doesn't stop other listeners or the loop.
        this.onError(err)
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
