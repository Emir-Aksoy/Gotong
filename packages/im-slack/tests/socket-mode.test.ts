/**
 * createSlackSocketMode coverage — the hand-rolled Socket Mode state
 * machine, driven by a fake WebSocket. No real network: `socketUrl`
 * pins the WSS URL (skipping apps.connections.open) for the envelope
 * tests, and an injected `fetchImpl` exercises the open round trip.
 *
 * What's asserted:
 *   - ack-by-envelope_id (Slack wants `{envelope_id}` echoed within 3s)
 *   - `hello` flips state → 'open'
 *   - `events_api` payload routes to `onEvent`; control/other types ack-only
 *   - apps.connections.open success → connects to the returned url
 *   - apps.connections.open fatal error (`invalid_auth`) → start() rejects
 *     + onClose({fatal:true}); transient retries instead
 *   - stop() closes intentionally, no reconnect
 */

import { describe, expect, it } from 'vitest'

import {
  createSlackSocketMode,
  type WebSocketCtor,
  type WebSocketLike,
} from '../src/socket-mode.js'

const WS_OPEN = 1
const WS_CLOSED = 3

interface FakeWs extends WebSocketLike {
  url: string
  sent: string[]
  /** Drive an inbound frame (server → client). */
  emit(env: unknown): void
  /** Fire the open handshake. */
  fireOpen(): void
}

/**
 * A fresh fake-WebSocket constructor plus the list of instances it
 * builds. createSlackSocketMode does `new WebSocketImpl(url)` on each
 * (re)connect, so the instances array lets a test reach the live socket.
 */
function makeFakeWsCtor(): { ctor: WebSocketCtor; instances: FakeWs[] } {
  const instances: FakeWs[] = []
  class Impl implements WebSocketLike {
    readyState = WS_OPEN
    onopen: ((ev?: unknown) => void) | null = null
    onclose: ((ev: { code: number; reason: string; wasClean?: boolean }) => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    onmessage: ((ev: { data: unknown }) => void) | null = null
    sent: string[] = []
    url: string
    constructor(url: string) {
      this.url = url
      instances.push(this as unknown as FakeWs)
    }
    send(data: string): void {
      this.sent.push(data)
    }
    close(code?: number, reason?: string): void {
      this.readyState = WS_CLOSED
      this.onclose?.({ code: code ?? 1000, reason: reason ?? '' })
    }
    emit(env: unknown): void {
      this.onmessage?.({ data: JSON.stringify(env) })
    }
    fireOpen(): void {
      this.onopen?.()
    }
  }
  return { ctor: Impl as unknown as WebSocketCtor, instances }
}

/** Flush pending microtasks (handleEnvelope awaits onEvent). */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** A `typeof fetch` stub returning a JSON body + status. */
function fakeFetch(
  body: unknown,
  status = 200,
): { fn: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return {
      status,
      json: async () => body,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fn, calls }
}

describe('createSlackSocketMode envelope handling', () => {
  it('acks events_api by envelope_id and routes the payload to onEvent', async () => {
    const { ctor, instances } = makeFakeWsCtor()
    const events: unknown[] = []
    const sm = createSlackSocketMode({
      appToken: 'xapp-x',
      webSocketImpl: ctor,
      socketUrl: 'wss://pinned',
      onEvent: (p) => {
        events.push(p)
      },
    })
    await sm.start()
    expect(instances).toHaveLength(1)
    const ws = instances[0]!
    expect(ws.url).toBe('wss://pinned')
    ws.fireOpen()

    // hello → state open, no ack (no envelope_id)
    ws.emit({ type: 'hello' })
    expect(sm.state).toBe('open')
    expect(ws.sent).toHaveLength(0)

    // events_api → ack THEN route payload
    const payload = { type: 'event_callback', event_id: 'E1', event: { type: 'message' } }
    ws.emit({ envelope_id: 'ENV1', type: 'events_api', payload })
    expect(ws.sent).toEqual([JSON.stringify({ envelope_id: 'ENV1' })])
    await flush()
    expect(events).toEqual([payload])

    await sm.stop()
  })

  it('acks non-events_api envelopes without surfacing them', async () => {
    const { ctor, instances } = makeFakeWsCtor()
    const events: unknown[] = []
    const sm = createSlackSocketMode({
      appToken: 'xapp-x',
      webSocketImpl: ctor,
      socketUrl: 'wss://pinned',
      onEvent: (p) => {
        events.push(p)
      },
    })
    await sm.start()
    const ws = instances[0]!
    ws.emit({ envelope_id: 'ENV9', type: 'slash_commands', payload: { command: '/x' } })
    // acked but not routed
    expect(ws.sent).toEqual([JSON.stringify({ envelope_id: 'ENV9' })])
    await flush()
    expect(events).toHaveLength(0)
    await sm.stop()
  })

  it('on a server disconnect, closes the socket', async () => {
    const { ctor, instances } = makeFakeWsCtor()
    const sm = createSlackSocketMode({
      appToken: 'xapp-x',
      webSocketImpl: ctor,
      socketUrl: 'wss://pinned',
      reconnectBackoffMs: 5,
      onEvent: () => {},
    })
    await sm.start()
    const ws = instances[0]!
    expect(ws.readyState).toBe(WS_OPEN)
    ws.emit({ type: 'disconnect', reason: 'refresh_requested' })
    expect(ws.readyState).toBe(WS_CLOSED)
    // a reconnect is scheduled (fresh instance) — stop before it fires to
    // keep the test deterministic and free of dangling timers.
    await sm.stop()
  })
})

describe('createSlackSocketMode apps.connections.open', () => {
  it('opens via fetch with the app token, then connects to the returned url', async () => {
    const { ctor, instances } = makeFakeWsCtor()
    const { fn, calls } = fakeFetch({ ok: true, url: 'wss://from-open' })
    const sm = createSlackSocketMode({
      appToken: 'xapp-secret',
      webSocketImpl: ctor,
      fetchImpl: fn,
      baseUrl: 'https://slack.test/api',
      onEvent: () => {},
    })
    await sm.start()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://slack.test/api/apps.connections.open')
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer xapp-secret',
    )
    expect(instances).toHaveLength(1)
    expect(instances[0]!.url).toBe('wss://from-open')
    await sm.stop()
  })

  it('rejects start() and reports fatal onClose on invalid_auth', async () => {
    const { ctor, instances } = makeFakeWsCtor()
    const { fn } = fakeFetch({ ok: false, error: 'invalid_auth' })
    const closes: Array<{ intentional: boolean; fatal: boolean; reason: string }> = []
    const sm = createSlackSocketMode({
      appToken: 'xapp-bad',
      webSocketImpl: ctor,
      fetchImpl: fn,
      onEvent: () => {},
      onClose: (info) => closes.push(info),
    })
    await expect(sm.start()).rejects.toThrow(/invalid_auth/)
    expect(instances).toHaveLength(0)
    expect(closes).toEqual([{ intentional: false, fatal: true, reason: 'invalid_auth' }])
    expect(sm.state).toBe('closed')
  })

  it('treats a transient open failure as retryable (no throw from start)', async () => {
    const { ctor } = makeFakeWsCtor()
    const { fn } = fakeFetch({ ok: false, error: 'ratelimited' })
    const errors: unknown[] = []
    const sm = createSlackSocketMode({
      appToken: 'xapp-x',
      webSocketImpl: ctor,
      fetchImpl: fn,
      reconnectBackoffMs: 5,
      onEvent: () => {},
      onError: (e) => errors.push(e),
    })
    // transient → start() resolves (schedules a retry) rather than throwing
    await expect(sm.start()).resolves.toBeUndefined()
    expect(errors.length).toBeGreaterThanOrEqual(1)
    await sm.stop()
  })
})

describe('createSlackSocketMode lifecycle', () => {
  it('throws on a missing appToken', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createSlackSocketMode({ webSocketImpl: makeFakeWsCtor().ctor, onEvent: () => {} } as any),
    ).toThrow(/appToken is required/)
  })

  it('stop() closes intentionally and does not reconnect', async () => {
    const { ctor, instances } = makeFakeWsCtor()
    const closes: Array<{ intentional: boolean }> = []
    const sm = createSlackSocketMode({
      appToken: 'xapp-x',
      webSocketImpl: ctor,
      socketUrl: 'wss://pinned',
      onEvent: () => {},
      onClose: (info) => closes.push(info),
    })
    await sm.start()
    expect(instances).toHaveLength(1)
    await sm.stop()
    expect(instances[0]!.readyState).toBe(WS_CLOSED)
    expect(closes).toEqual([{ intentional: true, fatal: false, reason: 'bridge stop' }])
    expect(sm.state).toBe('closed')
  })
})
