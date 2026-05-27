/**
 * Phase 12 M7 — OneBot v11 forward-WS client coverage.
 *
 * Uses a FakeWebSocket so the test can drive `onopen`, push frames
 * via `pushFrame`, simulate close, and inspect outbound `send` calls.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  createOneBotClient,
  OneBotApiError,
  type WebSocketCtor,
  type WebSocketLike,
} from '../src/client.js'

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = []
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  readonly sent: string[] = []

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket not open')
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3
    queueMicrotask(() => this.onclose?.({ code, reason }))
  }

  // --- test driver helpers (not part of WebSocketLike) ---
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  fail(err: { message?: string } = { message: 'connect refused' }): void {
    this.readyState = 3
    this.onerror?.(err)
  }

  pushFrame(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }

  pushRaw(text: string): void {
    this.onmessage?.({ data: text })
  }

  serverClose(code = 1006, reason = 'abnormal'): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

const FakeWsCtor = FakeWebSocket as unknown as WebSocketCtor

function newEchoFactory(): () => string {
  let i = 0
  return () => `echo-${++i}`
}

describe('createOneBotClient: construction', () => {
  it('throws on missing url', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createOneBotClient({} as any)).toThrow(/url is required/)
    expect(() => createOneBotClient({ url: '' })).toThrow(/url is required/)
  })

  it('throws when no WebSocket impl is available', () => {
    const originalGlobal = (globalThis as { WebSocket?: unknown }).WebSocket
    ;(globalThis as { WebSocket?: unknown }).WebSocket = undefined
    try {
      expect(() => createOneBotClient({ url: 'ws://x' })).toThrow(/no WebSocket implementation/)
    } finally {
      ;(globalThis as { WebSocket?: unknown }).WebSocket = originalGlobal
    }
  })
})

describe('createOneBotClient: connect lifecycle', () => {
  it('opens the socket and reaches state=open', async () => {
    FakeWebSocket.instances = []
    const c = createOneBotClient({
      url: 'ws://x/',
      webSocketImpl: FakeWsCtor,
      generateEcho: newEchoFactory(),
    })
    const p = c.start()
    // Allow the constructor to run + onopen wiring to happen.
    await new Promise((r) => setImmediate(r))
    expect(FakeWebSocket.instances).toHaveLength(1)
    FakeWebSocket.instances[0]!.open()
    await p
    expect(c.state).toBe('open')
    await c.stop()
  })

  it('rejects on connect failure', async () => {
    FakeWebSocket.instances = []
    const c = createOneBotClient({
      url: 'ws://x/',
      webSocketImpl: FakeWsCtor,
      generateEcho: newEchoFactory(),
    })
    const p = c.start()
    await new Promise((r) => setImmediate(r))
    FakeWebSocket.instances[0]!.fail({ message: 'ECONNREFUSED' })
    await expect(p).rejects.toThrow(/ECONNREFUSED/)
    expect(c.state).toBe('closed')
  })

  it('appends access_token to the connect URL', async () => {
    FakeWebSocket.instances = []
    const c = createOneBotClient({
      url: 'ws://x/',
      accessToken: 'tok-abc',
      webSocketImpl: FakeWsCtor,
      generateEcho: newEchoFactory(),
    })
    const p = c.start()
    await new Promise((r) => setImmediate(r))
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://x/?access_token=tok-abc')
    FakeWebSocket.instances[0]!.open()
    await p
    await c.stop()
  })

  it('appends access_token with & when url already has query', async () => {
    FakeWebSocket.instances = []
    const c = createOneBotClient({
      url: 'ws://x/?foo=1',
      accessToken: 'tok',
      webSocketImpl: FakeWsCtor,
      generateEcho: newEchoFactory(),
    })
    const p = c.start()
    await new Promise((r) => setImmediate(r))
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://x/?foo=1&access_token=tok')
    FakeWebSocket.instances[0]!.open()
    await p
    await c.stop()
  })

  it('emits state changes to subscribers', async () => {
    FakeWebSocket.instances = []
    const c = createOneBotClient({ url: 'ws://x', webSocketImpl: FakeWsCtor, generateEcho: newEchoFactory() })
    const states: string[] = []
    c.onState((s) => states.push(s))
    const p = c.start()
    await new Promise((r) => setImmediate(r))
    FakeWebSocket.instances[0]!.open()
    await p
    await c.stop()
    expect(states).toEqual(['connecting', 'open', 'closed'])
  })
})

describe('createOneBotClient: action calls', () => {
  it('sends a JSON action with echo and resolves on matching response', async () => {
    FakeWebSocket.instances = []
    const c = createOneBotClient({
      url: 'ws://x',
      webSocketImpl: FakeWsCtor,
      generateEcho: newEchoFactory(),
    })
    const startP = c.start()
    await new Promise((r) => setImmediate(r))
    const sock = FakeWebSocket.instances[0]!
    sock.open()
    await startP
    const actionP = c.callAction<{ message_id: number }>('send_msg', {
      message_type: 'private',
      user_id: 1,
      message: [{ type: 'text', data: { text: 'hi' } }],
    })
    // After microtask the send should have happened.
    await new Promise((r) => setImmediate(r))
    expect(sock.sent).toHaveLength(1)
    const sentReq = JSON.parse(sock.sent[0]!) as { action: string; echo: string; params: unknown }
    expect(sentReq.action).toBe('send_msg')
    expect(sentReq.echo).toBe('echo-1')
    sock.pushFrame({ status: 'ok', retcode: 0, data: { message_id: 999 }, echo: 'echo-1' })
    const out = await actionP
    expect(out).toEqual({ message_id: 999 })
    await c.stop()
  })

  it('rejects with OneBotApiError on non-zero retcode', async () => {
    FakeWebSocket.instances = []
    const c = createOneBotClient({ url: 'ws://x', webSocketImpl: FakeWsCtor, generateEcho: newEchoFactory() })
    const startP = c.start()
    await new Promise((r) => setImmediate(r))
    FakeWebSocket.instances[0]!.open()
    await startP
    const sock = FakeWebSocket.instances[0]!
    const ap = c.callAction('send_msg', {})
    await new Promise((r) => setImmediate(r))
    sock.pushFrame({
      status: 'failed',
      retcode: 100,
      data: null,
      msg: 'BAD_PARAMS',
      wording: 'group_id required',
      echo: 'echo-1',
    })
    await expect(ap).rejects.toBeInstanceOf(OneBotApiError)
    await ap.catch((err) => {
      expect((err as OneBotApiError).retcode).toBe(100)
      expect((err as OneBotApiError).detail).toBe('group_id required')
    })
    await c.stop()
  })

  it('treats retcode=1 (async) as success and resolves with data', async () => {
    FakeWebSocket.instances = []
    const c = createOneBotClient({ url: 'ws://x', webSocketImpl: FakeWsCtor, generateEcho: newEchoFactory() })
    const startP = c.start()
    await new Promise((r) => setImmediate(r))
    FakeWebSocket.instances[0]!.open()
    await startP
    const sock = FakeWebSocket.instances[0]!
    const ap = c.callAction('send_msg', {})
    await new Promise((r) => setImmediate(r))
    sock.pushFrame({ status: 'async', retcode: 1, data: { queued: true }, echo: 'echo-1' })
    await expect(ap).resolves.toEqual({ queued: true })
    await c.stop()
  })

  it('rejects with timeout when no response arrives', async () => {
    FakeWebSocket.instances = []
    const c = createOneBotClient({
      url: 'ws://x',
      webSocketImpl: FakeWsCtor,
      generateEcho: newEchoFactory(),
      timeoutMs: 50,
    })
    const startP = c.start()
    await new Promise((r) => setImmediate(r))
    FakeWebSocket.instances[0]!.open()
    await startP
    await expect(c.callAction('send_msg', {})).rejects.toThrow(/timeout/)
    await c.stop()
  })

  it('rejects with disposed when stop() is called mid-flight', async () => {
    FakeWebSocket.instances = []
    const c = createOneBotClient({ url: 'ws://x', webSocketImpl: FakeWsCtor, generateEcho: newEchoFactory() })
    const startP = c.start()
    await new Promise((r) => setImmediate(r))
    FakeWebSocket.instances[0]!.open()
    await startP
    const ap = c.callAction('send_msg', {}).catch((e: Error) => e.message)
    await new Promise((r) => setImmediate(r))
    await c.stop()
    const msg = await ap
    expect(msg).toBe('disposed')
  })

  it('rejects when sending while not connected', async () => {
    FakeWebSocket.instances = []
    const c = createOneBotClient({ url: 'ws://x', webSocketImpl: FakeWsCtor, generateEcho: newEchoFactory() })
    await expect(c.callAction('send_msg')).rejects.toThrow(/state=closed/)
  })

  it('multiplexes concurrent actions by echo', async () => {
    FakeWebSocket.instances = []
    const c = createOneBotClient({ url: 'ws://x', webSocketImpl: FakeWsCtor, generateEcho: newEchoFactory() })
    const startP = c.start()
    await new Promise((r) => setImmediate(r))
    FakeWebSocket.instances[0]!.open()
    await startP
    const sock = FakeWebSocket.instances[0]!
    const a = c.callAction('send_msg', { id: 1 })
    const b = c.callAction('send_msg', { id: 2 })
    await new Promise((r) => setImmediate(r))
    // Respond out of order.
    sock.pushFrame({ status: 'ok', retcode: 0, data: 'B', echo: 'echo-2' })
    sock.pushFrame({ status: 'ok', retcode: 0, data: 'A', echo: 'echo-1' })
    expect(await a).toBe('A')
    expect(await b).toBe('B')
    await c.stop()
  })
})

describe('createOneBotClient: event push', () => {
  it('routes server-push frames into onEvent listeners', async () => {
    FakeWebSocket.instances = []
    const c = createOneBotClient({ url: 'ws://x', webSocketImpl: FakeWsCtor, generateEcho: newEchoFactory() })
    const got: unknown[] = []
    c.onEvent((ev) => got.push(ev))
    const startP = c.start()
    await new Promise((r) => setImmediate(r))
    FakeWebSocket.instances[0]!.open()
    await startP
    const sock = FakeWebSocket.instances[0]!
    sock.pushFrame({
      post_type: 'message',
      message_type: 'private',
      self_id: 1,
      user_id: 2,
      message: [{ type: 'text', data: { text: 'hi' } }],
      message_id: 1,
      time: 1,
    })
    expect(got).toHaveLength(1)
    await c.stop()
  })

  it('drops malformed JSON without crashing', async () => {
    FakeWebSocket.instances = []
    const c = createOneBotClient({ url: 'ws://x', webSocketImpl: FakeWsCtor, generateEcho: newEchoFactory() })
    const startP = c.start()
    await new Promise((r) => setImmediate(r))
    FakeWebSocket.instances[0]!.open()
    await startP
    const sock = FakeWebSocket.instances[0]!
    sock.pushRaw('this is not JSON')
    // Should still be alive — drive a real action through to confirm.
    const ap = c.callAction('test', {})
    await new Promise((r) => setImmediate(r))
    sock.pushFrame({ status: 'ok', retcode: 0, data: { ok: 1 }, echo: 'echo-1' })
    expect(await ap).toEqual({ ok: 1 })
    await c.stop()
  })

  it('returns unsubscribe from onEvent', async () => {
    FakeWebSocket.instances = []
    const c = createOneBotClient({ url: 'ws://x', webSocketImpl: FakeWsCtor, generateEcho: newEchoFactory() })
    const got: unknown[] = []
    const off = c.onEvent((ev) => got.push(ev))
    const startP = c.start()
    await new Promise((r) => setImmediate(r))
    FakeWebSocket.instances[0]!.open()
    await startP
    off()
    FakeWebSocket.instances[0]!.pushFrame({
      post_type: 'message',
      message_type: 'private',
      self_id: 1,
      user_id: 2,
      message: 'hi',
      message_id: 1,
      time: 1,
    })
    expect(got).toHaveLength(0)
    await c.stop()
  })
})

describe('createOneBotClient: server-side close', () => {
  it('fails all pending actions when server closes', async () => {
    FakeWebSocket.instances = []
    const c = createOneBotClient({ url: 'ws://x', webSocketImpl: FakeWsCtor, generateEcho: newEchoFactory() })
    const startP = c.start()
    await new Promise((r) => setImmediate(r))
    FakeWebSocket.instances[0]!.open()
    await startP
    const ap = c.callAction('send_msg', {}).catch((e: Error) => e.message)
    await new Promise((r) => setImmediate(r))
    FakeWebSocket.instances[0]!.serverClose(1006, 'lost')
    expect(await ap).toMatch(/closed/)
    expect(c.state).toBe('closed')
  })
})

// Silence unused-import warning.
void vi
