/**
 * Phase 12 M3 — MatrixBridge coverage. Tests use a `FakeMatrixClient`
 * (no fetch involved) so we control the sync-loop's view of the world.
 */

import type { ImMessage } from '@gotong/im-adapter'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MatrixApiError, type MatrixCallOptions, type MatrixClient } from '../src/client.js'
import { MatrixBridge } from '../src/bridge.js'
import type { MatrixRoomEvent, MatrixSyncResponse } from '../src/types.js'

const BOT = '@gotong_bot:matrix.org'
const ALICE = '@alice:matrix.org'
const ROOM = '!room:matrix.org'

class FakeMatrixClient implements MatrixClient {
  /**
   * FIFO queue. Each entry matches one call by `method + pathPrefix`.
   * Calls that fall through to /sync's empty-queue branch block
   * (mimics homeserver long-poll), preventing the loop from
   * tight-spinning in tests.
   */
  responses: Array<{
    method: string
    pathPrefix: string
    result: unknown
  }> = []
  errors: Array<{
    method: string
    pathPrefix: string
    err: unknown
  }> = []
  calls: Array<{
    method: string
    path: string
    options?: MatrixCallOptions
  }> = []
  private idleResolvers: Array<() => void> = []

  async call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options?: MatrixCallOptions,
  ): Promise<T> {
    this.calls.push({ method, path, options })
    // Errors queue takes precedence — supports "fail once then succeed."
    if (
      this.errors.length > 0 &&
      this.errors[0]!.method === method &&
      path.startsWith(this.errors[0]!.pathPrefix)
    ) {
      throw this.errors.shift()!.err
    }
    if (
      this.responses.length > 0 &&
      this.responses[0]!.method === method &&
      path.startsWith(this.responses[0]!.pathPrefix)
    ) {
      return this.responses.shift()!.result as T
    }
    // /sync's empty-queue path: block until release().
    // Without this, the bridge would tight-loop in tests (no
    // homeserver-side timeout), OOM-ing the test process.
    if (method === 'GET' && path.startsWith('/_matrix/client/v3/sync')) {
      await new Promise<void>((r) => this.idleResolvers.push(r))
      return { next_batch: 'idle' } as unknown as T
    }
    throw new Error(`FakeMatrixClient: unexpected ${method} ${path}`)
  }

  release(): void {
    const r = this.idleResolvers
    this.idleResolvers = []
    r.forEach((fn) => fn())
  }
}

function makeMessageEvent(over: Partial<MatrixRoomEvent>): MatrixRoomEvent {
  return {
    type: 'm.room.message',
    event_id: '$ev1:matrix.org',
    sender: ALICE,
    origin_server_ts: 1_700_000_000_000,
    content: { msgtype: 'm.text', body: 'hello bot' },
    ...over,
  }
}

function syncRespWithEvents(events: MatrixRoomEvent[], nextBatch: string): MatrixSyncResponse {
  return {
    next_batch: nextBatch,
    rooms: { join: { [ROOM]: { timeline: { events } } } },
  }
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('MatrixBridge', () => {
  let bridge: MatrixBridge | null = null
  afterEach(async () => {
    if (bridge) {
      await bridge.stop()
      bridge = null
    }
  })

  it('calls whoami on start when botUserId not provided', async () => {
    const client = new FakeMatrixClient()
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/account/whoami',
      result: { user_id: BOT },
    })
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
    })
    await bridge.start()
    await flushMicrotasks(10)
    client.release()
    await bridge.stop()
    const whoami = client.calls.find((c) =>
      c.path.startsWith('/_matrix/client/v3/account/whoami'),
    )
    expect(whoami).toBeDefined()
    expect(whoami!.method).toBe('GET')
  })

  it('skips whoami when botUserId is preset in options', async () => {
    const client = new FakeMatrixClient()
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
      botUserId: BOT,
    })
    await bridge.start()
    await flushMicrotasks(10)
    client.release()
    await bridge.stop()
    const whoami = client.calls.find((c) =>
      c.path.startsWith('/_matrix/client/v3/account/whoami'),
    )
    expect(whoami).toBeUndefined()
  })

  it('whoami failure aborts start and leaves bridge stopped', async () => {
    const client = new FakeMatrixClient()
    client.errors.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/account/whoami',
      err: new MatrixApiError({
        method: 'GET',
        path: '/_matrix/client/v3/account/whoami',
        status: 401,
        errcode: 'M_UNKNOWN_TOKEN',
      }),
    })
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
    })
    await expect(bridge.start()).rejects.toThrow(/M_UNKNOWN_TOKEN/)
    // Should not have entered the sync loop.
    const syncCalls = client.calls.filter((c) => c.path.startsWith('/_matrix/client/v3/sync'))
    expect(syncCalls.length).toBe(0)
    // stop() on never-fully-started bridge must be a no-op (no hang).
    await bridge.stop()
    bridge = null
  })

  it('first sync skips backlog (timeline.limit=0) and does not deliver old events', async () => {
    const client = new FakeMatrixClient()
    // First sync returns events — but they should be ignored because
    // it's the initial backlog-skipping sync.
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: syncRespWithEvents([makeMessageEvent({})], 's1'),
    })
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
      botUserId: BOT,
    })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.start()
    await flushMicrotasks(20)
    client.release()
    await bridge.stop()
    expect(received).toEqual([])
    // First sync should have asked the homeserver for a backlog-free sync.
    const firstSync = client.calls.find((c) => c.path.startsWith('/_matrix/client/v3/sync'))!
    const filter = JSON.parse(String(firstSync.options?.query?.filter))
    expect(filter.room.timeline.limit).toBe(0)
    expect(firstSync.options?.query?.timeout).toBe(0)
  })

  it('delivers timeline events from subsequent syncs', async () => {
    const client = new FakeMatrixClient()
    // First sync: empty (just gets next_batch).
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: { next_batch: 's1' } as MatrixSyncResponse,
    })
    // Second sync: a message.
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: syncRespWithEvents([makeMessageEvent({ event_id: '$ev2' })], 's2'),
    })
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
      botUserId: BOT,
    })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.start()
    await flushMicrotasks(20)
    client.release()
    await bridge.stop()
    expect(received).toHaveLength(1)
    expect(received[0]!.text).toBe('hello bot')
    expect(received[0]!.chatId).toBe(ROOM)
    expect(received[0]!.from.platformUserId).toBe(ALICE)
  })

  it('threads next_batch correctly to subsequent syncs', async () => {
    const client = new FakeMatrixClient()
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: { next_batch: 'cursor-1' } as MatrixSyncResponse,
    })
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: { next_batch: 'cursor-2' } as MatrixSyncResponse,
    })
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
      botUserId: BOT,
    })
    await bridge.start()
    await flushMicrotasks(20)
    client.release()
    await bridge.stop()
    const syncCalls = client.calls.filter((c) =>
      c.path.startsWith('/_matrix/client/v3/sync'),
    )
    // First call has no since=
    expect(syncCalls[0]!.options?.query?.since).toBeUndefined()
    // Second call uses cursor-1
    expect(syncCalls[1]!.options?.query?.since).toBe('cursor-1')
  })

  it('drops bot-self events (anti-loop) but delivers others', async () => {
    const client = new FakeMatrixClient()
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: { next_batch: 's1' } as MatrixSyncResponse,
    })
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: syncRespWithEvents(
        [
          makeMessageEvent({ event_id: '$echo', sender: BOT, content: { msgtype: 'm.text', body: 'me!' } }),
          makeMessageEvent({ event_id: '$real', sender: ALICE, content: { msgtype: 'm.text', body: 'real' } }),
        ],
        's2',
      ),
    })
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
      botUserId: BOT,
    })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.start()
    await flushMicrotasks(20)
    client.release()
    await bridge.stop()
    expect(received).toHaveLength(1)
    expect(received[0]!.text).toBe('real')
  })

  it('dedups by event_id even if the same event arrives twice', async () => {
    const client = new FakeMatrixClient()
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: { next_batch: 's1' } as MatrixSyncResponse,
    })
    // Same event_id in two consecutive batches (edge case: server
    // re-delivered after our since= reset).
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: syncRespWithEvents([makeMessageEvent({ event_id: '$dup' })], 's2'),
    })
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: syncRespWithEvents([makeMessageEvent({ event_id: '$dup' })], 's3'),
    })
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
      botUserId: BOT,
    })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.start()
    await flushMicrotasks(30)
    client.release()
    await bridge.stop()
    expect(received).toHaveLength(1)
  })

  it('autoJoin=true joins invited rooms', async () => {
    const client = new FakeMatrixClient()
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: {
        next_batch: 's1',
        rooms: { invite: { '!newroom:m.org': { invite_state: { events: [] } } } },
      } as MatrixSyncResponse,
    })
    client.responses.push({
      method: 'POST',
      pathPrefix: '/_matrix/client/v3/join/',
      result: { room_id: '!newroom:m.org' },
    })
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
      botUserId: BOT,
      autoJoin: true,
    })
    await bridge.start()
    await flushMicrotasks(20)
    client.release()
    await bridge.stop()
    const joinCalls = client.calls.filter((c) =>
      c.path.startsWith('/_matrix/client/v3/join/'),
    )
    expect(joinCalls).toHaveLength(1)
    expect(decodeURIComponent(joinCalls[0]!.path)).toContain('!newroom:m.org')
  })

  it('autoJoin=false leaves invites alone', async () => {
    const client = new FakeMatrixClient()
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: {
        next_batch: 's1',
        rooms: { invite: { '!nope:m.org': { invite_state: { events: [] } } } },
      } as MatrixSyncResponse,
    })
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
      botUserId: BOT,
      autoJoin: false,
    })
    await bridge.start()
    await flushMicrotasks(20)
    client.release()
    await bridge.stop()
    const joinCalls = client.calls.filter((c) =>
      c.path.startsWith('/_matrix/client/v3/join/'),
    )
    expect(joinCalls).toHaveLength(0)
  })

  it('failed join is reported via onError without crashing the loop', async () => {
    const client = new FakeMatrixClient()
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: {
        next_batch: 's1',
        rooms: { invite: { '!stale:m.org': { invite_state: { events: [] } } } },
      } as MatrixSyncResponse,
    })
    client.errors.push({
      method: 'POST',
      pathPrefix: '/_matrix/client/v3/join/',
      err: new MatrixApiError({
        method: 'POST',
        path: '/_matrix/client/v3/join/!stale:m.org',
        status: 404,
        errcode: 'M_NOT_FOUND',
      }),
    })
    const errors: unknown[] = []
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
      botUserId: BOT,
      onError: (e) => errors.push(e),
    })
    await bridge.start()
    await flushMicrotasks(20)
    client.release()
    await bridge.stop()
    expect(errors.some((e) => String(e).includes('M_NOT_FOUND'))).toBe(true)
    // Loop still ran subsequent syncs (no `running` flag flip).
    const syncCalls = client.calls.filter((c) =>
      c.path.startsWith('/_matrix/client/v3/sync'),
    )
    expect(syncCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('sendMessage PUTs to /rooms/{}/send/m.room.message/{txnId}', async () => {
    const client = new FakeMatrixClient()
    client.responses.push({
      method: 'PUT',
      pathPrefix: '/_matrix/client/v3/rooms/',
      result: { event_id: '$out:m.org' },
    })
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
      botUserId: BOT,
    })
    await bridge.sendMessage(
      { platform: 'matrix', platformUserId: ALICE },
      'hello back',
      { chatId: ROOM },
    )
    const put = client.calls.find((c) => c.method === 'PUT')!
    expect(put.path).toContain('/rooms/')
    expect(put.path).toContain('/send/m.room.message/')
    expect(decodeURIComponent(put.path)).toContain(ROOM)
    expect(put.options?.body).toEqual({ msgtype: 'm.text', body: 'hello back' })
  })

  it('sendMessage throws when chatId is missing (no DM shortcut)', async () => {
    const client = new FakeMatrixClient()
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
      botUserId: BOT,
    })
    await expect(
      bridge.sendMessage(
        { platform: 'matrix', platformUserId: ALICE },
        'no room',
        {}, // no chatId
      ),
    ).rejects.toThrow(/chatId.*required/)
    // Bridge should NOT have hit the API.
    expect(client.calls.filter((c) => c.method === 'PUT').length).toBe(0)
  })

  it('sendMessage signals via onError on outbound attachments but still sends text', async () => {
    const client = new FakeMatrixClient()
    client.responses.push({
      method: 'PUT',
      pathPrefix: '/_matrix/client/v3/rooms/',
      result: { event_id: '$out' },
    })
    const errors: unknown[] = []
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
      botUserId: BOT,
      onError: (e) => errors.push(e),
    })
    await bridge.sendMessage(
      { platform: 'matrix', platformUserId: ALICE },
      'caption',
      {
        chatId: ROOM,
        attachments: [{ kind: 'image', url: 'mxc://m.org/abc' }],
      },
    )
    expect(errors.length).toBe(1)
    expect(String(errors[0])).toMatch(/outbound attachments not yet supported/)
    expect(client.calls.some((c) => c.method === 'PUT')).toBe(true)
  })

  it('listener throw does not stop the sync loop or other listeners', async () => {
    const client = new FakeMatrixClient()
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: { next_batch: 's1' } as MatrixSyncResponse,
    })
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: syncRespWithEvents([makeMessageEvent({})], 's2'),
    })
    const errors: unknown[] = []
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
      botUserId: BOT,
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

  it('on sync error backs off and continues — self-healing', async () => {
    vi.useFakeTimers()
    const client = new FakeMatrixClient()
    // Matrix's first sync establishes the next_batch cursor and
    // explicitly skips the backlog (timeline.limit=0). To exercise
    // the recovery-from-mid-stream path, we sequence:
    //   call 1: initial sync errors out (cursor not yet acquired)
    //   call 2: retried initial sync succeeds (cursor acquired,
    //           but skipTimeline=true so any events still wouldn't fire)
    //   call 3: normal sync with a message — this one delivers.
    client.errors.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      err: new MatrixApiError({
        method: 'GET',
        path: '/_matrix/client/v3/sync',
        status: 502,
        errcode: 'M_UNKNOWN',
      }),
    })
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: { next_batch: 's0' } as MatrixSyncResponse,
    })
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: syncRespWithEvents([makeMessageEvent({ event_id: '$recovered' })], 's1'),
    })
    const errors: unknown[] = []
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
      botUserId: BOT,
      retryBackoffMs: 100,
      onError: (e) => errors.push(e),
    })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.start()
    await vi.advanceTimersByTimeAsync(200)
    client.release()
    await bridge.stop()
    vi.useRealTimers()
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(received.length).toBe(1)
    expect(received[0]!.text).toBe('hello bot')
  })

  it('respects retry_after_ms on M_LIMIT_EXCEEDED instead of default backoff', async () => {
    vi.useFakeTimers()
    const client = new FakeMatrixClient()
    client.errors.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      err: new MatrixApiError({
        method: 'GET',
        path: '/_matrix/client/v3/sync',
        status: 429,
        errcode: 'M_LIMIT_EXCEEDED',
        retryAfterMs: 2000,
      }),
    })
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
      botUserId: BOT,
      retryBackoffMs: 9999, // huge; if used, recovery wouldn't fire
    })
    await bridge.start()
    await vi.advanceTimersByTimeAsync(500)
    const callsAfter500 = client.calls.length
    await vi.advanceTimersByTimeAsync(2_100)
    const callsAfter2600 = client.calls.length
    client.release()
    await bridge.stop()
    vi.useRealTimers()
    // The retry_after_ms path slept ~2s, then a follow-up sync fired.
    expect(callsAfter2600).toBeGreaterThan(callsAfter500)
  })

  it('start and stop are idempotent', async () => {
    const client = new FakeMatrixClient()
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
      botUserId: BOT,
    })
    await bridge.start()
    await bridge.start()
    client.release()
    await bridge.stop()
    await bridge.stop()
    // No assertions on internal state; we're checking nothing throws.
  })

  it('unsubscribe removes the listener', async () => {
    const client = new FakeMatrixClient()
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: { next_batch: 's1' } as MatrixSyncResponse,
    })
    client.responses.push({
      method: 'GET',
      pathPrefix: '/_matrix/client/v3/sync',
      result: syncRespWithEvents(
        [
          makeMessageEvent({ event_id: '$e1', content: { msgtype: 'm.text', body: 'first' } }),
          makeMessageEvent({ event_id: '$e2', content: { msgtype: 'm.text', body: 'second' } }),
        ],
        's2',
      ),
    })
    bridge = new MatrixBridge({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      client,
      botUserId: BOT,
    })
    const received: ImMessage[] = []
    const unsub = bridge.onMessage((m) => {
      received.push(m)
      if (received.length === 1) unsub()
    })
    await bridge.start()
    await flushMicrotasks(30)
    client.release()
    await bridge.stop()
    expect(received.length).toBe(1)
  })
})
