/**
 * Phase 12 M7 — QqBridge end-to-end coverage.
 *
 * Uses a FakeOneBotClient that exposes the same shape as the real
 * client so we drive event push from the test side and observe
 * outbound action calls.
 */

import { describe, expect, it } from 'vitest'

import { QqBridge, QQ_RISK_ACK_ENV } from '../src/bridge.js'
import { OneBotApiError, type OneBotClient } from '../src/client.js'
import type {
  OneBotEvent,
  OneBotMessageEvent,
  OneBotMetaEvent,
  OneBotSendMsgParams,
} from '../src/types.js'

const SELF_ID = 100000
const USER_QQ = 200000
const GROUP_QQ = 500000

class FakeOneBotClient implements OneBotClient {
  state: 'connecting' | 'open' | 'closed' = 'closed'
  readonly calls: Array<{ action: string; params: Record<string, unknown> }> = []
  private eventListeners: Array<(ev: OneBotEvent) => void> = []
  private stateListeners: Array<(s: 'connecting' | 'open' | 'closed') => void> = []
  private responseByAction = new Map<string, unknown>()
  private errorByAction = new Map<string, Error>()
  /** Whether start() should fail. Used to test reconnect path. */
  failOnStart = false
  startCount = 0
  stopCount = 0

  setResponse(action: string, response: unknown): void {
    this.responseByAction.set(action, response)
  }

  setError(action: string, err: Error): void {
    this.errorByAction.set(action, err)
  }

  async start(): Promise<void> {
    this.startCount++
    this.setState('connecting')
    if (this.failOnStart) {
      this.setState('closed')
      throw new Error('connect refused')
    }
    this.setState('open')
  }

  async stop(): Promise<void> {
    this.stopCount++
    this.setState('closed')
  }

  onEvent(listener: (ev: OneBotEvent) => void): () => void {
    this.eventListeners.push(listener)
    return () => {
      const i = this.eventListeners.indexOf(listener)
      if (i >= 0) this.eventListeners.splice(i, 1)
    }
  }

  onState(listener: (s: 'connecting' | 'open' | 'closed') => void): () => void {
    this.stateListeners.push(listener)
    return () => {
      const i = this.stateListeners.indexOf(listener)
      if (i >= 0) this.stateListeners.splice(i, 1)
    }
  }

  async callAction<T = unknown>(
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ action, params })
    const e = this.errorByAction.get(action)
    if (e) throw e
    return (this.responseByAction.get(action) ?? null) as T
  }

  // --- driver methods for tests ---
  emit(ev: OneBotEvent): void {
    for (const l of this.eventListeners) l(ev)
  }

  simulateClose(): void {
    this.setState('closed')
  }

  private setState(s: 'connecting' | 'open' | 'closed'): void {
    if (this.state === s) return
    this.state = s
    for (const l of this.stateListeners) l(s)
  }
}

function makeMessageEvent(over: Partial<OneBotMessageEvent> = {}): OneBotMessageEvent {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: SELF_ID,
    user_id: USER_QQ,
    message_id: 7,
    time: 1748345600,
    message: [{ type: 'text', data: { text: 'hello' } }],
    raw_message: 'hello',
    sender: { user_id: USER_QQ, nickname: 'Alice' },
    ...over,
  }
}

function makeLifecycleEvent(): OneBotMetaEvent {
  return {
    post_type: 'meta_event',
    meta_event_type: 'lifecycle',
    sub_type: 'connect',
    self_id: SELF_ID,
    time: 1,
  }
}

describe('QqBridge: risk gate', () => {
  it('throws by default unless AIPE_QQ_BRIDGE_ACK_RISK=true', () => {
    expect(
      () =>
        new QqBridge({
          url: 'ws://x',
          client: new FakeOneBotClient(),
        }),
    ).toThrow(/AIPE_QQ_BRIDGE_ACK_RISK/)
  })

  it('reads from process.env at construction', () => {
    const original = process.env[QQ_RISK_ACK_ENV]
    process.env[QQ_RISK_ACK_ENV] = 'true'
    try {
      const b = new QqBridge({ url: 'ws://x', client: new FakeOneBotClient() })
      expect(b.platform).toBe('qq')
    } finally {
      if (original === undefined) delete process.env[QQ_RISK_ACK_ENV]
      else process.env[QQ_RISK_ACK_ENV] = original
    }
  })

  it('test-only __acknowledgeRiskInTest bypasses the env gate', () => {
    const b = new QqBridge({
      url: 'ws://x',
      client: new FakeOneBotClient(),
      __acknowledgeRiskInTest: true,
    })
    expect(b.platform).toBe('qq')
  })

  it('throws on missing url even with risk ack', () => {
    expect(
      () =>
        new QqBridge({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...({} as any),
          client: new FakeOneBotClient(),
          __acknowledgeRiskInTest: true,
        }),
    ).toThrow(/url is required/)
  })
})

describe('QqBridge: lifecycle', () => {
  it('start() opens the client', async () => {
    const fake = new FakeOneBotClient()
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    expect(fake.startCount).toBe(1)
    expect(fake.state).toBe('open')
    await b.stop()
  })

  it('start() is idempotent', async () => {
    const fake = new FakeOneBotClient()
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    await b.start()
    expect(fake.startCount).toBe(1)
    await b.stop()
  })

  it('stop() is idempotent and safe before start', async () => {
    const fake = new FakeOneBotClient()
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      __acknowledgeRiskInTest: true,
    })
    await b.stop() // before start
    await b.start()
    await b.stop()
    await b.stop() // double stop
  })

  it('reconnects with backoff on socket close', async () => {
    const fake = new FakeOneBotClient()
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      reconnectInitialMs: 5,
      reconnectMaxMs: 20,
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    expect(fake.startCount).toBe(1)
    fake.simulateClose()
    // Wait past the backoff.
    await new Promise((r) => setTimeout(r, 25))
    expect(fake.startCount).toBe(2)
    await b.stop()
  })

  it('does NOT reconnect after intentional stop', async () => {
    const fake = new FakeOneBotClient()
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      reconnectInitialMs: 5,
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    await b.stop()
    fake.simulateClose() // shouldn't trigger reconnect
    await new Promise((r) => setTimeout(r, 25))
    expect(fake.startCount).toBe(1)
  })

  it('surfaces start failure via onError + schedules reconnect', async () => {
    const fake = new FakeOneBotClient()
    fake.failOnStart = true
    const errors: unknown[] = []
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      reconnectInitialMs: 5,
      reconnectMaxMs: 50,
      onError: (e) => errors.push(e),
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    expect(errors).toHaveLength(1)
    // Second attempt will also fail.
    await new Promise((r) => setTimeout(r, 15))
    expect(fake.startCount).toBeGreaterThan(1)
    await b.stop()
  })
})

describe('QqBridge: event dispatch', () => {
  it('dispatches private message events to listeners', async () => {
    const fake = new FakeOneBotClient()
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      selfId: SELF_ID,
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    const got: Array<{ text: string; chatId?: string }> = []
    b.onMessage((m) => {
      got.push({ text: m.text, chatId: m.chatId })
    })
    fake.emit(makeMessageEvent())
    // emit triggers an async handler; let microtasks drain.
    await new Promise((r) => setImmediate(r))
    expect(got).toHaveLength(1)
    expect(got[0]!.text).toBe('hello')
    expect(got[0]!.chatId).toBe(`private:${USER_QQ}`)
    await b.stop()
  })

  it('captures selfId from lifecycle meta_event', async () => {
    const fake = new FakeOneBotClient()
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    const got: Array<unknown> = []
    b.onMessage((m) => got.push(m))
    fake.emit(makeLifecycleEvent())
    fake.emit(
      makeMessageEvent({
        message: [
          { type: 'at', data: { qq: SELF_ID } },
          { type: 'text', data: { text: ' /help' } },
        ],
      }),
    )
    await new Promise((r) => setImmediate(r))
    expect(got).toHaveLength(1)
    expect((got[0] as { text: string }).text).toBe('/help')
    await b.stop()
  })

  it('filters own-account posts (anti-loop)', async () => {
    const fake = new FakeOneBotClient()
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      selfId: SELF_ID,
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    const got: unknown[] = []
    b.onMessage((m) => got.push(m))
    fake.emit(makeMessageEvent({ user_id: SELF_ID }))
    await new Promise((r) => setImmediate(r))
    expect(got).toHaveLength(0)
    await b.stop()
  })

  it('drops notice and request events silently', async () => {
    const fake = new FakeOneBotClient()
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      selfId: SELF_ID,
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    const got: unknown[] = []
    b.onMessage((m) => got.push(m))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fake.emit({ post_type: 'notice', notice_type: 'group_increase', self_id: SELF_ID, time: 1 } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fake.emit({ post_type: 'request', request_type: 'friend', self_id: SELF_ID, time: 1 } as any)
    await new Promise((r) => setImmediate(r))
    expect(got).toHaveLength(0)
    await b.stop()
  })

  it('a listener that throws does not break the bridge', async () => {
    const fake = new FakeOneBotClient()
    const errors: unknown[] = []
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      selfId: SELF_ID,
      onError: (e) => errors.push(e),
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    const got: unknown[] = []
    b.onMessage(() => {
      throw new Error('boom')
    })
    b.onMessage((m) => got.push(m))
    fake.emit(makeMessageEvent())
    await new Promise((r) => setImmediate(r))
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('boom')
    expect(got).toHaveLength(1)
    await b.stop()
  })

  it('attaches images on a message event', async () => {
    const fake = new FakeOneBotClient()
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      selfId: SELF_ID,
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    const got: Array<{ text: string; attachments?: unknown[] }> = []
    b.onMessage((m) => got.push({ text: m.text, attachments: m.attachments }))
    fake.emit(
      makeMessageEvent({
        message: [
          { type: 'text', data: { text: 'caption' } },
          { type: 'image', data: { url: 'https://cdn.qq/x.jpg', file: 'x.jpg' } },
        ],
      }),
    )
    await new Promise((r) => setImmediate(r))
    expect(got).toHaveLength(1)
    expect(got[0]!.text).toBe('caption')
    expect(got[0]!.attachments).toHaveLength(1)
    await b.stop()
  })
})

describe('QqBridge.sendMessage', () => {
  it('sends a private message via send_msg with parsed chatId', async () => {
    const fake = new FakeOneBotClient()
    fake.setResponse('send_msg', { message_id: 1 })
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      selfId: SELF_ID,
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    await b.sendMessage(
      { platform: 'qq', platformUserId: String(USER_QQ) },
      'hi back',
      { chatId: `private:${USER_QQ}` },
    )
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.action).toBe('send_msg')
    const params = fake.calls[0]!.params as unknown as OneBotSendMsgParams
    expect(params.message_type).toBe('private')
    expect(params.user_id).toBe(USER_QQ)
    expect(params.message).toEqual([{ type: 'text', data: { text: 'hi back' } }])
    await b.stop()
  })

  it('sends a group message via send_msg', async () => {
    const fake = new FakeOneBotClient()
    fake.setResponse('send_msg', { message_id: 2 })
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      selfId: SELF_ID,
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    await b.sendMessage(
      { platform: 'qq', platformUserId: String(USER_QQ) },
      'group hello',
      { chatId: `group:${GROUP_QQ}` },
    )
    const params = fake.calls[0]!.params as unknown as OneBotSendMsgParams
    expect(params.message_type).toBe('group')
    expect(params.group_id).toBe(GROUP_QQ)
    expect((params as unknown as { user_id?: number }).user_id).toBeUndefined()
    await b.stop()
  })

  it('falls back to platformUserId as DM target when chatId is absent', async () => {
    const fake = new FakeOneBotClient()
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      selfId: SELF_ID,
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    await b.sendMessage({ platform: 'qq', platformUserId: String(USER_QQ) }, 'hi')
    const params = fake.calls[0]!.params as unknown as OneBotSendMsgParams
    expect(params.message_type).toBe('private')
    expect(params.user_id).toBe(USER_QQ)
    await b.stop()
  })

  it('throws on malformed chatId', async () => {
    const fake = new FakeOneBotClient()
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      selfId: SELF_ID,
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    await expect(
      b.sendMessage({ platform: 'qq', platformUserId: '1' }, 'hi', { chatId: 'bogus' }),
    ).rejects.toThrow(/malformed chatId/)
    await b.stop()
  })

  it('throws when client not connected', async () => {
    const fake = new FakeOneBotClient()
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      selfId: SELF_ID,
      __acknowledgeRiskInTest: true,
    })
    // Don't start.
    await expect(
      b.sendMessage({ platform: 'qq', platformUserId: '1' }, 'hi', { chatId: 'private:1' }),
    ).rejects.toThrow(/not connected/)
  })

  it('surfaces outbound attachments via onError and still sends text', async () => {
    const fake = new FakeOneBotClient()
    const errors: unknown[] = []
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      selfId: SELF_ID,
      onError: (e) => errors.push(e),
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    await b.sendMessage(
      { platform: 'qq', platformUserId: String(USER_QQ) },
      'caption',
      {
        chatId: `private:${USER_QQ}`,
        attachments: [{ kind: 'image', url: 'https://x/y.jpg' }],
      },
    )
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toMatch(/outbound attachments not yet supported/)
    expect(fake.calls).toHaveLength(1)
    await b.stop()
  })

  it('propagates OneBotApiError', async () => {
    const fake = new FakeOneBotClient()
    fake.setError(
      'send_msg',
      new OneBotApiError({ action: 'send_msg', retcode: 100, wording: 'group_id required' }),
    )
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      selfId: SELF_ID,
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    await expect(
      b.sendMessage({ platform: 'qq', platformUserId: String(USER_QQ) }, 'hi', {
        chatId: `private:${USER_QQ}`,
      }),
    ).rejects.toThrow(/retcode=100/)
    await b.stop()
  })
})

describe('QqBridge.onMessage', () => {
  it('returns an unsubscribe that removes the listener', async () => {
    const fake = new FakeOneBotClient()
    const b = new QqBridge({
      url: 'ws://x',
      client: fake,
      selfId: SELF_ID,
      __acknowledgeRiskInTest: true,
    })
    await b.start()
    const got: unknown[] = []
    const off = b.onMessage((m) => got.push(m))
    fake.emit(makeMessageEvent())
    await new Promise((r) => setImmediate(r))
    off()
    fake.emit(makeMessageEvent({ message_id: 8 }))
    await new Promise((r) => setImmediate(r))
    expect(got).toHaveLength(1)
    await b.stop()
  })
})
