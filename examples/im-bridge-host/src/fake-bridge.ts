/**
 * `FakeBridge` — an in-memory `ImBridge` for demos and unit tests.
 *
 * Real bridges (`@gotong/im-telegram`, …) talk to actual IM
 * platforms; that's overkill for showing how the router glues
 * everything together. `FakeBridge` lets the example script inject
 * inbound messages by calling `inject(msg)` and observe outbound
 * replies via `outbound`.
 *
 * Why a separate class instead of just mocking `ImBridge` inline:
 *
 *   1. The transcript pretty-printer in `index.ts` needs to log
 *      both sides of the conversation. Centralising the in/out
 *      bookkeeping keeps that readable.
 *   2. A second example or unit test would re-implement the same
 *      thing. Making it explicit means "copy this if you want a
 *      fake bridge for tests" is obvious.
 *
 * Anyone writing a real-bridge unit test in the `@gotong/im-*`
 * packages should NOT import this — those packages have their
 * own (richer) fake-socket / fake-http helpers tuned to each
 * platform's quirks. This one is intentionally minimal.
 */

import type {
  ImAttachment,
  ImBridge,
  ImMessage,
  ImUser,
} from '@gotong/im-adapter'

export interface FakeBridgeOutbound {
  to: ImUser
  text: string
  attachments?: ImAttachment[]
  chatId?: string
}

export class FakeBridge implements ImBridge {
  readonly platform: string
  private listener: ((msg: ImMessage) => void | Promise<void>) | null = null
  private started = false
  public readonly outbound: FakeBridgeOutbound[] = []
  /** Optional hook so the example script can log replies inline. */
  public onOutbound?: (out: FakeBridgeOutbound) => void

  constructor(platform = 'fake') {
    this.platform = platform
  }

  async start(): Promise<void> {
    this.started = true
  }
  async stop(): Promise<void> {
    this.started = false
    this.listener = null
  }

  async sendMessage(
    to: ImUser,
    text: string,
    options?: { attachments?: ImAttachment[]; chatId?: string },
  ): Promise<void> {
    const entry: FakeBridgeOutbound = {
      to,
      text,
      ...(options?.attachments ? { attachments: options.attachments } : {}),
      ...(options?.chatId ? { chatId: options.chatId } : {}),
    }
    this.outbound.push(entry)
    this.onOutbound?.(entry)
  }

  onMessage(listener: (msg: ImMessage) => void | Promise<void>): () => void {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }

  /**
   * Test / demo helper: push an inbound message through the listener
   * synchronously (well, awaiting the listener if it's async).
   *
   * Throws if `start()` hasn't been called yet — that matches what
   * real bridges do (a Telegram bot doesn't deliver messages until
   * the long-poll is running).
   */
  async inject(msg: ImMessage): Promise<void> {
    if (!this.started) throw new Error('FakeBridge.inject called before start()')
    if (!this.listener) return
    await this.listener(msg)
  }
}
