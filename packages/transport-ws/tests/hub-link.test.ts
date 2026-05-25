/**
 * WebSocketHubLink — M3 of the hub-mesh implementation.
 *
 * Tests run a real `ws.WebSocketServer` on an OS-assigned port,
 * `connectHubLink` from the same process, and exercise the symmetric
 * contract end-to-end:
 *
 *   - both sides can `dispatch` to the other
 *   - both sides can `publish` to the other
 *   - close on either side propagates
 *   - handshake mismatch / timeout / missing handler degrade safely
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

import type { HubLink, Message, Task, TaskResult } from '@aipehub/core'

import { acceptHubLinks, connectHubLink } from '../src/hub-link.js'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface Bench {
  wss: WebSocketServer
  url: string
  /** Resolves to the next incoming link (one per call). */
  nextLink: () => Promise<HubLink>
  stop: () => Promise<void>
}

async function startBench(
  selfId: string,
  opts: { peerToken?: string } = {},
): Promise<Bench> {
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const addr = wss.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const url = `ws://127.0.0.1:${port}`

  const pendingLinks: HubLink[] = []
  const waiters: Array<(l: HubLink) => void> = []
  acceptHubLinks({
    server: wss,
    selfId,
    ...(opts.peerToken !== undefined ? { peerToken: opts.peerToken } : {}),
    onLink: (link) => {
      const w = waiters.shift()
      if (w) w(link)
      else pendingLinks.push(link)
    },
  })

  return {
    wss,
    url,
    nextLink: () =>
      new Promise<HubLink>((resolve) => {
        const ready = pendingLinks.shift()
        if (ready) resolve(ready)
        else waiters.push(resolve)
      }),
    stop: async () => {
      // Force-close any link that was accepted but never awaited via
      // nextLink() — otherwise the underlying ws connection keeps
      // wss.close() from invoking its callback.
      for (const link of pendingLinks.splice(0)) {
        await link.close().catch(() => {})
      }
      // Also forcibly terminate any active client connections that
      // never produced a HubLink (e.g. failed handshakes).
      for (const client of wss.clients) {
        try {
          client.terminate()
        } catch {
          /* swallow */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

function makeTask(id: string, payload: unknown = {}): Task {
  return {
    id,
    from: 'tester',
    strategy: { kind: 'capability', capabilities: ['x'] },
    payload,
    createdAt: Date.now(),
  }
}

function makeMessage(id: string, body: unknown = {}): Message {
  return {
    id,
    channel: 'announcements',
    from: 'tester',
    body,
    ts: Date.now(),
  }
}

describe('WebSocketHubLink (symmetric ws)', () => {
  let bench: Bench

  beforeEach(async () => {
    bench = await startBench('hubB')
  })

  afterEach(async () => {
    await bench.stop()
  })

  it('handshake: connect resolves and both sides have matching peerIds', async () => {
    const aLink = await connectHubLink({
      url: bench.url,
      selfId: 'hubA',
    })
    const bLink = await bench.nextLink()

    expect(aLink.status).toBe('open')
    expect(bLink.status).toBe('open')
    expect(aLink.peerId).toBe('hubB')
    expect(bLink.peerId).toBe('hubA')
    expect(aLink.direction).toBe('out')
    expect(bLink.direction).toBe('in')

    await aLink.close()
  })

  it('dispatch from A reaches B handler and result flows back', async () => {
    const aLink = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    const bLink = await bench.nextLink()

    bLink.on('task', async (task): Promise<TaskResult> => ({
      kind: 'ok',
      taskId: task.id,
      by: 'hubB-worker',
      output: { processed: task.id },
      ts: Date.now(),
    }))

    const result = await aLink.dispatch(makeTask('t1'))
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('hubB-worker')
      expect(result.output).toMatchObject({ processed: 't1' })
    }

    await aLink.close()
  })

  it('dispatch from B reaches A handler (symmetry)', async () => {
    const aLink = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    const bLink = await bench.nextLink()

    aLink.on('task', async (task): Promise<TaskResult> => ({
      kind: 'ok',
      taskId: task.id,
      by: 'hubA-worker',
      output: { reverse: true },
      ts: Date.now(),
    }))

    const result = await bLink.dispatch(makeTask('t2'))
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('hubA-worker')
      expect(result.output).toMatchObject({ reverse: true })
    }

    await aLink.close()
  })

  it('dispatch with no handler returns no_participant', async () => {
    const aLink = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    await bench.nextLink() // B side; no handler registered

    const result = await aLink.dispatch(makeTask('t3'))
    expect(result.kind).toBe('no_participant')
    if (result.kind === 'no_participant') {
      expect(result.taskId).toBe('t3')
    }

    await aLink.close()
  })

  it('handler that throws on B turns into a failed result on A', async () => {
    const aLink = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    const bLink = await bench.nextLink()

    bLink.on('task', async () => {
      throw new Error('intentional boom')
    })

    const result = await aLink.dispatch(makeTask('t4'))
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.by).toBe('hubB')
      expect(result.error).toMatch(/intentional boom/)
    }

    await aLink.close()
  })

  it('publish from A is delivered to all message handlers on B', async () => {
    const aLink = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    const bLink = await bench.nextLink()

    const received: Message[] = []
    bLink.on('message', (m) => {
      received.push(m)
    })

    aLink.publish(makeMessage('m1', { hello: 'B' }))
    // give the ws event loop a tick to deliver
    await delay(30)

    expect(received.length).toBe(1)
    expect(received[0].body).toMatchObject({ hello: 'B' })

    await aLink.close()
  })

  it('close on A propagates: B sees status closed and fires closed handler', async () => {
    const aLink = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    const bLink = await bench.nextLink()

    let bClosed = false
    bLink.on('closed', () => {
      bClosed = true
    })

    await aLink.close()
    // ws round-trip
    await delay(50)

    expect(aLink.status).toBe('closed')
    expect(bLink.status).toBe('closed')
    expect(bClosed).toBe(true)
  })

  it('dispatch after close resolves with failed/link_closed', async () => {
    const aLink = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    await bench.nextLink()

    await aLink.close()
    const result = await aLink.dispatch(makeTask('t-after-close'))
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toMatch(/link_closed/)
    }
  })

  it('pending dispatch is failed when link closes mid-flight', async () => {
    const aLink = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    const bLink = await bench.nextLink()

    // B handler never resolves
    bLink.on('task', () => new Promise<TaskResult>(() => {}))

    const dispatchPromise = aLink.dispatch(makeTask('t-hang'))
    await delay(20)
    await aLink.close()

    const result = await dispatchPromise
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toMatch(/link_closed/)
    }
  })

  it('expectedPeerId mismatch fails handshake', async () => {
    await expect(
      connectHubLink({
        url: bench.url,
        selfId: 'hubA',
        expectedPeerId: 'wrongHub',
        handshakeTimeoutMs: 1000,
      }),
    ).rejects.toThrow(/peer id mismatch|handshake/i)
  })

  it('dispatch timeout: peer never replies → failed/dispatch_timeout', async () => {
    const aLink = await connectHubLink({
      url: bench.url,
      selfId: 'hubA',
      dispatchTimeoutMs: 200, // short for test
    })
    const bLink = await bench.nextLink()

    // hang the handler forever
    bLink.on('task', () => new Promise<TaskResult>(() => {}))

    const result = await aLink.dispatch(makeTask('t-timeout'))
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toMatch(/dispatch_timeout/)
    }

    await aLink.close()
  })

  it('handshake timeout on connect fails fast if no server reply', async () => {
    // Point at the existing server but make the handshake impossible by
    // killing the server BEFORE the client sends HELLO. Easiest way:
    // close the server, then attempt connect to its dead port.
    const port = new URL(bench.url).port
    await bench.stop()
    // Brief delay so the port is fully released — not strictly required
    // but reduces flake on macOS.
    await delay(30)

    // Server is dead — `ws` raises ECONNREFUSED before any handshake
    // logic runs, which surfaces as the underlying socket error rather
    // than our own `handshake timeout` message. Either is a valid
    // failure mode for "I couldn't establish the link"; both must
    // reject cleanly so callers can retry / fail upstream.
    await expect(
      connectHubLink({
        url: `ws://127.0.0.1:${port}`,
        selfId: 'hubA',
        handshakeTimeoutMs: 300,
      }),
    ).rejects.toThrow(/handshake|ECONNREFUSED|connect/i)
  })
})

// ---------------------------------------------------------------------------
// FED-M1 — peer mutual authentication via shared peerToken
// ---------------------------------------------------------------------------

describe('WebSocketHubLink — FED-M1 mutual peer auth', () => {
  it('matching peerTokens on both sides → handshake succeeds + can dispatch', async () => {
    const bench = await startBench('hubB', { peerToken: 'shared-AB-secret' })
    try {
      const aLink = await connectHubLink({
        url: bench.url,
        selfId: 'hubA',
        peerToken: 'shared-AB-secret',
      })
      const bLink = await bench.nextLink()
      // Wire a task handler on B and dispatch from A — proves the link
      // is genuinely usable, not just past the handshake.
      bLink.on('task', async (task: Task): Promise<TaskResult> => ({
        kind: 'completed',
        taskId: task.id,
        by: 'hubB-agent',
        result: { ok: true },
        ts: Date.now(),
      }))
      const result = await aLink.dispatch(makeTask('t-auth-ok'))
      expect(result.kind).toBe('completed')
      await aLink.close()
    } finally {
      await bench.stop()
    }
  })

  it('mismatched peerTokens → handshake rejects (OUT sees opaque close, IN saw precise reason)', async () => {
    // Deliberate: the IN side rejects the bad-token HELLO and closes
    // the socket WITHOUT sending any failure frame back. The OUT side
    // only observes the close — not why. This is anti-enumeration
    // (attacker can't probe valid-token-format vs invalid-token-value
    // by inspecting error text). The IN side records the precise
    // reason internally for ops/logging but doesn't put it on the wire.
    const bench = await startBench('hubB', { peerToken: 'server-secret' })
    try {
      await expect(
        connectHubLink({
          url: bench.url,
          selfId: 'hubA',
          peerToken: 'client-different-secret',
          handshakeTimeoutMs: 1000,
        }),
      ).rejects.toThrow(/closed during handshake|peer_disconnected|handshake/i)
    } finally {
      await bench.stop()
    }
  })

  it('server requires token, client omits → server rejects (no leak of self info)', async () => {
    const bench = await startBench('hubB', { peerToken: 'server-secret' })
    try {
      // Client doesn't set peerToken — server requires one. Server side
      // rejects in handshake → client sees handshake failure (the
      // underlying ws closes; connectHubLink resolves to the timeout or
      // a generic handshake error depending on race).
      await expect(
        connectHubLink({
          url: bench.url,
          selfId: 'hubA',
          handshakeTimeoutMs: 1000,
        }),
      ).rejects.toThrow(/handshake|peerToken|closed/i)
    } finally {
      await bench.stop()
    }
  })

  it('client requires token, server has none → client rejects HELLO_ACK', async () => {
    // Server has NO peerToken configured → it sends HELLO_ACK without
    // peerToken. Client requires one → client rejects.
    const bench = await startBench('hubB')
    try {
      await expect(
        connectHubLink({
          url: bench.url,
          selfId: 'hubA',
          peerToken: 'client-secret',
          handshakeTimeoutMs: 1000,
        }),
      ).rejects.toThrow(/peerToken|mutual auth/i)
    } finally {
      await bench.stop()
    }
  })

  it('neither side configures peerToken → handshake still succeeds (legacy / inproc-compatible)', async () => {
    const bench = await startBench('hubB')
    try {
      const aLink = await connectHubLink({
        url: bench.url,
        selfId: 'hubA',
      })
      const bLink = await bench.nextLink()
      expect(aLink.status).toBe('open')
      expect(bLink.status).toBe('open')
      await aLink.close()
    } finally {
      await bench.stop()
    }
  })

  it('empty-string peerToken is rejected before opening the WebSocket (typo defense)', async () => {
    // Catches the "MY_TOKEN env var was defined but empty" misconfig
    // that would otherwise silently disable auth on the side that set
    // peerToken: process.env.MY_TOKEN. The rejection happens BEFORE
    // any socket is opened (the URL below is intentionally invalid;
    // if the check ran after `new WebSocket()`, we'd see ECONNREFUSED
    // as an unhandled error rather than our own throw).
    //
    // `connectHubLink` is an async function, so its synchronous throw
    // surfaces as a rejected Promise — assert via `.rejects.toThrow`.
    await expect(
      connectHubLink({
        url: 'ws://127.0.0.1:1',
        selfId: 'hubA',
        peerToken: '',
        handshakeTimeoutMs: 100,
      }),
    ).rejects.toThrow(/peerToken must be a non-empty string/)
  })
})
