/**
 * `FakeBridge` — an in-memory `ImBridge` for demos and unit tests.
 *
 * Copied verbatim from `examples/im-steward-bridge/src/fake-bridge.ts` (itself a copy of
 * `examples/im-bridge-host/src/fake-bridge.ts`). Real bridges (`@aipehub/im-telegram`, …)
 * talk to actual IM platforms; that's overkill for showing how the family oversight router
 * glues everything together. `FakeBridge` lets the example script inject inbound messages by
 * calling `inject(msg)` and observe outbound replies via `outbound`.
 *
 * Swap this for `new TelegramBridge({ token })` (etc.) to put the SAME oversight router on a
 * real platform — the router, the binding flow, and the push-back are unchanged. That's the
 * point of an example-first bridge.
 */

import type { ImAttachment, ImBridge, ImMessage, ImUser } from '@aipehub/im-adapter'

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
