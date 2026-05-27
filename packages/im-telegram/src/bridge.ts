/**
 * `ImBridge` implementation for Telegram. Long-polling mode.
 *
 * Why long-polling rather than webhook for M2:
 *
 *   - **No public endpoint required**. Telegram webhooks demand a
 *     HTTPS URL the Bot API can reach — that means TLS, a public IP
 *     or a tunnel like ngrok, and host-side routing wired into the
 *     web server. Long-polling works from a laptop with no inbound
 *     connectivity, perfect for the personal-mode story (Phase 7).
 *   - **Simpler shutdown semantics**. We control the loop; on
 *     `stop()` we just let the current `getUpdates` return and break
 *     out. With webhooks we'd be tearing down an HTTP handler and
 *     hoping Telegram doesn't retry in flight.
 *   - **One less surface to harden**. No need to verify webhook
 *     signatures, dedup retries, etc. Telegram's long-poll already
 *     delivers each update at-least-once and `update_id` makes
 *     dedup trivial.
 *
 * Production deployments behind a reverse proxy can switch to webhook
 * mode in a later milestone. The `ImBridge` interface is the same
 * either way, so the host wiring doesn't change.
 *
 * Threading model:
 *
 *   start() ─► pollLoop() running on the event loop
 *                 │
 *                 ├─ getUpdates(offset=lastUpdateId+1, timeout=25s)
 *                 │      blocks ~25s when the bot is idle
 *                 │
 *                 ├─ for each update.message: dispatch listeners
 *                 │      listeners are awaited SEQUENTIALLY for the
 *                 │      same poll batch (delivery order matters
 *                 │      within a chat); parallel across chats is
 *                 │      achieved by Telegram batching updates from
 *                 │      different chats and us not blocking polls
 *                 │      on listener side-effects.
 *                 │
 *                 └─ on error: log via opts.onError, sleep 1s, retry
 *                       (we never crash the loop on a single failure;
 *                        operators rely on the bridge being self-healing)
 *
 * stop() flips `running=false`; the next poll returns (or times out
 * server-side) and the loop breaks. The promise returned by
 * `pollLoop()` is what we await on `stop()` so cleanup waits for the
 * current iteration to finish — never a half-handled update.
 */

import type {
  ImAttachment,
  ImBridge,
  ImMessage,
  ImUser,
} from '@aipehub/im-adapter'

import {
  createTelegramClient,
  TelegramApiError,
  type TelegramClient,
  type TelegramClientOptions,
} from './client.js'
import { telegramToImMessage } from './message.js'
import type { TelegramUpdate } from './types.js'

export interface TelegramBridgeOptions {
  /** Bot token from @BotFather. */
  token: string
  /**
   * Override the underlying client. Mostly for tests; one client per
   * bridge is fine for production.
   */
  client?: TelegramClient
  /**
   * Server-side long-poll timeout in seconds, passed to `getUpdates`.
   * Default 25 — Telegram's server holds the connection up to this
   * long when no updates are pending. Lowering it adds wallclock
   * load on the Bot API; raising past 50 hits the documented cap.
   */
  pollTimeoutSec?: number
  /**
   * Sleep after a transient failure before retrying the next poll.
   * Default 1000ms. The bridge never stops the loop on API failure;
   * a network glitch or 429 should self-heal without operator
   * intervention.
   */
  retryBackoffMs?: number
  /**
   * Forwarded to `createTelegramClient` when `client` isn't supplied.
   * Useful for tests that want to override `fetchImpl` without
   * constructing the client themselves.
   */
  clientOptions?: Omit<TelegramClientOptions, 'token'>
  /**
   * Called on poll-loop errors and on listener exceptions. The bridge
   * never throws into the caller from background work; this is the
   * only diagnostic surface. Defaults to a no-op (silent self-heal).
   */
  onError?: (err: unknown) => void
}

type Listener = (msg: ImMessage) => void | Promise<void>

export class TelegramBridge implements ImBridge {
  readonly platform = 'telegram'

  private readonly client: TelegramClient
  private readonly pollTimeoutSec: number
  private readonly retryBackoffMs: number
  private readonly onError: (err: unknown) => void

  private running = false
  private listeners: Listener[] = []
  /**
   * The `offset` we pass to `getUpdates`. Per spec, sending
   * `offset = lastSeen + 1` ACKs every previous update so the server
   * stops re-delivering them. We persist nothing across restarts;
   * Telegram replays the last 24h of unconsumed updates on
   * cold-start, which is fine for the bridge.
   */
  private lastUpdateId = 0
  private pollPromise: Promise<void> | null = null

  constructor(opts: TelegramBridgeOptions) {
    this.client =
      opts.client ?? createTelegramClient({ token: opts.token, ...opts.clientOptions })
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 25
    this.retryBackoffMs = opts.retryBackoffMs ?? 1000
    this.onError = opts.onError ?? (() => {})
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    // Fire-and-track the loop; we keep the promise so `stop()` can
    // await it. Errors inside the loop are swallowed by the
    // try/catch — they reach `onError` instead of rejecting `start`.
    this.pollPromise = this.pollLoop()
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    if (this.pollPromise) {
      // Wait for the in-flight poll to return. Worst case: 25s server
      // timeout + network round-trip. We don't force-abort because
      // unprocessed updates would be lost (Telegram won't re-deliver
      // until we re-poll with the old offset).
      try {
        await this.pollPromise
      } catch {
        // pollLoop never rejects (we catch inside) — defensive only.
      }
      this.pollPromise = null
    }
  }

  async sendMessage(
    to: ImUser,
    text: string,
    options?: { attachments?: ImAttachment[]; chatId?: string },
  ): Promise<void> {
    // Bridges that don't carry an explicit chatId default to DM
    // semantics: the user's platformUserId IS their private chat id
    // in Telegram. Group replies require the caller to pass the
    // original `ImMessage.chatId` through.
    const chatId = options?.chatId ?? to.platformUserId
    // M2 sends text-only. Outbound attachments (photo/document
    // upload via sendPhoto / sendDocument) are a future milestone;
    // text-only is the 90%-case for command-driven flows.
    if (options?.attachments && options.attachments.length > 0) {
      // Don't silently drop — the host should know we ignored them.
      this.onError(
        new Error(
          'TelegramBridge.sendMessage: outbound attachments not yet supported; sending text only',
        ),
      )
    }
    await this.client.call('sendMessage', { chat_id: chatId, text })
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
      try {
        const updates = await this.client.call<TelegramUpdate[]>('getUpdates', {
          offset: this.lastUpdateId + 1,
          timeout: this.pollTimeoutSec,
          // `allowed_updates: ['message']` is the recommended
          // filter for command-driven bots — we'd ignore everything
          // else anyway, and Telegram saves bandwidth on its side.
          // Future: add 'edited_message' if we want to handle edits.
          allowed_updates: ['message'],
        })
        for (const upd of updates) {
          if (upd.update_id > this.lastUpdateId) this.lastUpdateId = upd.update_id
          if (upd.message) await this.deliver(upd.message)
        }
      } catch (err) {
        // Telegram returns 429 with `retry_after` on rate-limit; we
        // respect that hint when present, otherwise the configured
        // backoff. Other errors (auth failure, network) get the same
        // backoff — they're typically transient or the operator's
        // problem to spot via onError.
        const wait =
          err instanceof TelegramApiError && err.retryAfter
            ? err.retryAfter * 1000
            : this.retryBackoffMs
        this.onError(err)
        if (this.running) await sleep(wait)
      }
    }
  }

  private async deliver(message: TelegramUpdate['message']): Promise<void> {
    const imMsg = telegramToImMessage(message!)
    if (!imMsg) return // channel post / bot — skip
    for (const l of this.listeners) {
      try {
        await l(imMsg)
      } catch (err) {
        // A listener that throws doesn't stop other listeners or the
        // poll loop. Diagnostic via onError; operator can decide.
        this.onError(err)
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
