/**
 * Phase 12 M2 — TelegramBridge coverage. Tests use a `FakeTelegramClient`
 * (no fetch involved) so we control the poll-loop's view of the world.
 */

import type { ImMessage } from '@aipehub/im-adapter'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TelegramApiError, type TelegramClient } from '../src/client.js'
import { TelegramBridge } from '../src/bridge.js'
import type { TelegramUpdate } from '../src/types.js'

class FakeTelegramClient implements TelegramClient {
  /** FIFO queue of (method → result) responses. Each call shifts. */
  responses: Array<{ method: string; result: unknown }> = []
  /** Methods that throw on the next call, FIFO. */
  errors: Array<{ method: string; err: unknown }> = []
  /** Every call we received, for assertions. */
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  /**
   * Resolvers for `getUpdates` calls that hit the empty-queue branch.
   * Mimics real long-poll: the server holds the connection until an
   * update arrives or `release()` is called.
   *
   * Without this, the bridge would tight-loop in tests (no
   * server-side timeout in a fake), OOM-ing the test process.
   */
  private idleResolvers: Array<() => void> = []

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params })
    // errors queue takes precedence — useful for "fail once, then succeed."
    if (this.errors.length > 0 && this.errors[0]!.method === method) {
      const e = this.errors.shift()!.err
      throw e
    }
    if (this.responses.length > 0 && this.responses[0]!.method === method) {
      return this.responses.shift()!.result as T
    }
    if (method === 'getUpdates') {
      // Block until release() — emulates server-side long-poll.
      await new Promise<void>((r) => this.idleResolvers.push(r))
      return [] as unknown as T
    }
    throw new Error(`FakeTelegramClient: unexpected call ${method}`)
  }

  /** Unblock any pending getUpdates — call before bridge.stop() in tests. */
  release(): void {
    const r = this.idleResolvers
    this.idleResolvers = []
    r.forEach((fn) => fn())
  }
}

const baseChat = { id: 100, type: 'private' as const }
const baseFrom = {
  id: 42,
  is_bot: false,
  first_name: 'Alice',
  username: 'alice_doe',
}

function makeTextUpdate(updateId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000 + updateId,
      chat: baseChat,
      from: baseFrom,
      text,
    },
  }
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('TelegramBridge', () => {
  let bridge: TelegramBridge | null = null
  afterEach(async () => {
    if (bridge) {
      await bridge.stop()
      bridge = null
    }
  })

  it('delivers inbound messages as ImMessage', async () => {
    const client = new FakeTelegramClient()
    client.responses.push({
      method: 'getUpdates',
      result: [makeTextUpdate(1, 'hello bot')],
    })
    bridge = new TelegramBridge({ token: 't', client, pollTimeoutSec: 0 })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.start()
    await flushMicrotasks(20)
    client.release()
    await bridge.stop()

    expect(received.length).toBe(1)
    expect(received[0]!.from.platform).toBe('telegram')
    expect(received[0]!.from.platformUserId).toBe('42')
    expect(received[0]!.text).toBe('hello bot')
    // getUpdates was called with offset=1 on the first poll.
    const firstCall = client.calls.find((c) => c.method === 'getUpdates')!
    expect(firstCall.params.offset).toBe(1)
  })

  it('advances offset past delivered updates so we never replay', async () => {
    const client = new FakeTelegramClient()
    client.responses.push({
      method: 'getUpdates',
      result: [makeTextUpdate(5, 'first'), makeTextUpdate(6, 'second')],
    })
    bridge = new TelegramBridge({ token: 't', client, pollTimeoutSec: 0 })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.start()
    await flushMicrotasks(20)
    client.release()
    await bridge.stop()

    expect(received.length).toBe(2)
    // After update_id=6 the next poll offset should be 7.
    const updatesCalls = client.calls.filter((c) => c.method === 'getUpdates')
    expect(updatesCalls.length).toBeGreaterThan(1)
    const second = updatesCalls[1]!
    expect(second.params.offset).toBe(7)
  })

  it('drops messages with no `from` (channel posts) and bot-sent messages', async () => {
    const client = new FakeTelegramClient()
    client.responses.push({
      method: 'getUpdates',
      result: [
        // No from — channel post style.
        {
          update_id: 1,
          message: {
            message_id: 1,
            date: 1_700_000_000,
            chat: { id: -100, type: 'channel' },
            text: 'channel post',
          },
        },
        // is_bot=true — another bot.
        {
          update_id: 2,
          message: {
            message_id: 2,
            date: 1_700_000_001,
            chat: baseChat,
            from: { ...baseFrom, is_bot: true },
            text: 'bot greeting',
          },
        },
      ],
    })
    bridge = new TelegramBridge({ token: 't', client, pollTimeoutSec: 0 })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.start()
    await flushMicrotasks(20)
    client.release()
    await bridge.stop()

    expect(received).toEqual([])
  })

  it('sendMessage hits the sendMessage API method', async () => {
    const client = new FakeTelegramClient()
    client.responses.push({ method: 'sendMessage', result: { message_id: 99 } })
    bridge = new TelegramBridge({ token: 't', client, pollTimeoutSec: 0 })
    await bridge.sendMessage(
      { platform: 'telegram', platformUserId: '42' },
      'hello back',
    )
    const sm = client.calls.find((c) => c.method === 'sendMessage')!
    expect(sm.params.chat_id).toBe('42')
    expect(sm.params.text).toBe('hello back')
  })

  it('sendMessage uses options.chatId when provided (group reply)', async () => {
    const client = new FakeTelegramClient()
    client.responses.push({ method: 'sendMessage', result: { message_id: 99 } })
    bridge = new TelegramBridge({ token: 't', client, pollTimeoutSec: 0 })
    await bridge.sendMessage(
      { platform: 'telegram', platformUserId: '42' },
      'in group',
      { chatId: '-100123' },
    )
    const sm = client.calls.find((c) => c.method === 'sendMessage')!
    expect(sm.params.chat_id).toBe('-100123')
  })

  it('sendMessage signals via onError when attachments are passed (text still sent)', async () => {
    const client = new FakeTelegramClient()
    client.responses.push({ method: 'sendMessage', result: { message_id: 99 } })
    const errors: unknown[] = []
    bridge = new TelegramBridge({
      token: 't',
      client,
      pollTimeoutSec: 0,
      onError: (e) => errors.push(e),
    })
    await bridge.sendMessage(
      { platform: 'telegram', platformUserId: '42' },
      'caption',
      { attachments: [{ kind: 'image', url: 'telegram-file:abc' }] },
    )
    expect(errors.length).toBe(1)
    expect(String(errors[0])).toMatch(/outbound attachments not yet supported/)
    // Text still went out.
    expect(client.calls.some((c) => c.method === 'sendMessage')).toBe(true)
  })

  it('listener throw does not stop the poll loop or other listeners', async () => {
    const client = new FakeTelegramClient()
    client.responses.push({
      method: 'getUpdates',
      result: [makeTextUpdate(1, 'hi')],
    })
    const errors: unknown[] = []
    bridge = new TelegramBridge({
      token: 't',
      client,
      pollTimeoutSec: 0,
      onError: (e) => errors.push(e),
    })
    const goodReceived: ImMessage[] = []
    bridge.onMessage(() => {
      throw new Error('listener boom')
    })
    bridge.onMessage((m) => {
      goodReceived.push(m)
    })
    await bridge.start()
    await flushMicrotasks(20)
    client.release()
    await bridge.stop()
    expect(goodReceived.length).toBe(1)
    expect(errors.some((e) => String(e).includes('listener boom'))).toBe(true)
  })

  it('on API error backs off and continues — self-healing', async () => {
    vi.useFakeTimers()
    const client = new FakeTelegramClient()
    // First getUpdates throws; second returns one message.
    client.errors.push({
      method: 'getUpdates',
      err: new TelegramApiError({ method: 'getUpdates', description: 'transient' }),
    })
    client.responses.push({
      method: 'getUpdates',
      result: [makeTextUpdate(1, 'after-recovery')],
    })
    const errors: unknown[] = []
    bridge = new TelegramBridge({
      token: 't',
      client,
      pollTimeoutSec: 0,
      retryBackoffMs: 100,
      onError: (e) => errors.push(e),
    })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.start()
    await vi.advanceTimersByTimeAsync(150)
    // Recovery message delivered; next poll hits idle. Release + stop.
    client.release()
    await bridge.stop()
    vi.useRealTimers()

    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(received.length).toBe(1)
    expect(received[0]!.text).toBe('after-recovery')
  })

  it('respects retry_after on 429 instead of the default backoff', async () => {
    vi.useFakeTimers()
    const client = new FakeTelegramClient()
    client.errors.push({
      method: 'getUpdates',
      err: new TelegramApiError({
        method: 'getUpdates',
        description: 'rate limited',
        errorCode: 429,
        retryAfter: 2, // seconds — bridge multiplies × 1000
      }),
    })
    bridge = new TelegramBridge({
      token: 't',
      client,
      pollTimeoutSec: 0,
      retryBackoffMs: 9999, // huge; if used, the recovery poll wouldn't fire
    })
    await bridge.start()
    // After 500ms not enough; after 2100ms we should be past the
    // retry_after window and the loop re-polled.
    await vi.advanceTimersByTimeAsync(500)
    const callsAfter500 = client.calls.length
    await vi.advanceTimersByTimeAsync(2_100)
    const callsAfter2600 = client.calls.length
    client.release()
    await bridge.stop()
    vi.useRealTimers()
    // The retry_after path slept ~2s, then a follow-up poll fired.
    expect(callsAfter2600).toBeGreaterThan(callsAfter500)
  })

  it('start is idempotent; stop is idempotent', async () => {
    const client = new FakeTelegramClient()
    bridge = new TelegramBridge({ token: 't', client, pollTimeoutSec: 0 })
    await bridge.start()
    await bridge.start()
    // First poll is now idle-blocked. Release before stop so the
    // pollPromise inside stop() doesn't hang on the unresolved promise.
    client.release()
    await bridge.stop()
    await bridge.stop()
    // No assertions on internal state; we're checking nothing throws and the
    // poll loop is recoverable from these no-op calls.
  })

  it('unsubscribe removes the listener', async () => {
    const client = new FakeTelegramClient()
    client.responses.push({
      method: 'getUpdates',
      result: [makeTextUpdate(1, 'first'), makeTextUpdate(2, 'second')],
    })
    bridge = new TelegramBridge({ token: 't', client, pollTimeoutSec: 0 })
    const received: ImMessage[] = []
    const unsub = bridge.onMessage((m) => {
      received.push(m)
      // Unsubscribe after the first delivery.
      if (received.length === 1) unsub()
    })
    await bridge.start()
    await flushMicrotasks(30)
    client.release()
    await bridge.stop()
    expect(received.length).toBe(1)
  })
})
