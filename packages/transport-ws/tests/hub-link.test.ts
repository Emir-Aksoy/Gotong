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

import type { HubLink, Message, Task, TaskResult, TrustTier } from '@gotong/core'

import { acceptHubLinks, connectHubLink } from '../src/hub-link.js'
import { bearerAuth } from '../src/peer-auth.js'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// GT-M6 — the advisory peer-declared tier getter lives on the concrete
// `WebSocketHubLinkImpl`, NOT the `HubLink` contract (deliberate: it is
// observability, not a load-bearing gate). Read it via a narrow cast.
const declaredTierOf = (link: HubLink): TrustTier | null =>
  (link as unknown as { peerDeclaredTrustTier: TrustTier | null }).peerDeclaredTrustTier

interface Bench {
  wss: WebSocketServer
  url: string
  /** Resolves to the next incoming link (one per call). */
  nextLink: () => Promise<HubLink>
  stop: () => Promise<void>
}

async function startBench(
  selfId: string,
  opts: { peerToken?: string; declaredTrustTier?: TrustTier } = {},
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
    ...(opts.peerToken !== undefined ? { auth: bearerAuth({ token: opts.peerToken }) } : {}),
    ...(opts.declaredTrustTier ? { declaredTrustTier: opts.declaredTrustTier } : {}),
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

  it('handshake timeout tears the underlying socket down (no orphan leak)', async () => {
    // A bare server that ACCEPTS the connection but never completes the
    // handshake (no HELLO_ACK). The client's handshake timer must fire AND
    // close the socket — otherwise the socket leaks, and a late-completing one
    // could finish a handshake on a link nobody holds. We assert from the
    // server side that it observes the client's close promptly after timeout.
    const wss = new WebSocketServer({ port: 0 })
    try {
      await new Promise<void>((r) => wss.once('listening', () => r()))
      const addr = wss.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0

      const serverSawClose = new Promise<void>((resolve) => {
        wss.on('connection', (sock) => {
          // Deliberately never reply — force the client's handshake to time out.
          sock.on('close', () => resolve())
        })
      })

      await expect(
        connectHubLink({
          url: `ws://127.0.0.1:${port}`,
          selfId: 'hubA',
          handshakeTimeoutMs: 100,
        }),
      ).rejects.toThrow(/handshake/i)

      // The fix closes the client ws on timeout, so the server sees the close
      // quickly. Time-box it: a leak (socket left open) makes this reject.
      await expect(
        Promise.race([
          serverSawClose,
          delay(1500).then(() => {
            throw new Error('socket left open after handshake timeout — leak')
          }),
        ]),
      ).resolves.toBeUndefined()
    } finally {
      wss.close()
    }
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
        auth: bearerAuth({ token: 'shared-AB-secret' }),
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
          auth: bearerAuth({ token: 'client-different-secret' }),
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
          auth: bearerAuth({ token: 'client-secret' }),
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

  it('empty-string bearer token is rejected at scheme construction (typo defense)', () => {
    // Catches the "MY_TOKEN env var was defined but empty" misconfig
    // that would otherwise silently present / expect a zero-length
    // secret. bearerAuth validates eagerly, so the throw happens at
    // scheme construction — before any link or socket is created.
    expect(() => bearerAuth({ token: '' })).toThrow(
      /token must be a non-empty string/,
    )
  })
})

// ---------------------------------------------------------------------------
// GT-M6 — advisory trust-tier self-declaration on the mesh handshake.
//
// The wire carries an OPTIONAL `trustTier` on MESH_HELLO (OUT→IN) and
// MESH_HELLO_ACK (IN→OUT). It is PURELY ADVISORY context for the peer's
// owner — a self-report, never a credential, never verified, and the
// receiver NEVER auto-applies it to any gate. These tests pin exactly that:
//   1. a valid declaration round-trips into the peer's
//      `peerDeclaredTrustTier` (both directions, symmetric);
//   2. an unknown value is dropped to null (fail-safe, never trusted);
//   3. absence stays null (byte-identical-to-today default);
//   4. the IRON LAW — a declaration NEVER changes the handshake verdict:
//      a wrong-token HELLO that ALSO declares T3 still fails auth and
//      never captures the tier (声明 ≠ 信任).
// ---------------------------------------------------------------------------

describe('WebSocketHubLink — GT-M6 advisory trust-tier declaration', () => {
  it('OUT declares a tier on HELLO → IN captures it (advisory context)', async () => {
    const bench = await startBench('hubB')
    try {
      const aLink = await connectHubLink({
        url: bench.url,
        selfId: 'hubA',
        declaredTrustTier: 'T3',
      })
      const bLink = await bench.nextLink()
      // The handshake succeeded and B captured A's self-declared tier.
      expect(bLink.status).toBe('open')
      expect(declaredTierOf(bLink)).toBe('T3')
      // Symmetry sanity: A declared, B did not → A sees no declaration.
      expect(declaredTierOf(aLink)).toBe(null)
      await aLink.close()
    } finally {
      await bench.stop()
    }
  })

  it('IN declares a tier on HELLO_ACK → OUT captures it (symmetric)', async () => {
    const bench = await startBench('hubB', { declaredTrustTier: 'T2' })
    try {
      const aLink = await connectHubLink({ url: bench.url, selfId: 'hubA' })
      const bLink = await bench.nextLink()
      // A (OUT) captured B's declaration echoed on the ACK.
      expect(aLink.status).toBe('open')
      expect(declaredTierOf(aLink)).toBe('T2')
      // B never received a declaration from A.
      expect(declaredTierOf(bLink)).toBe(null)
      await aLink.close()
    } finally {
      await bench.stop()
    }
  })

  it('both sides declare → each captures the other (fully symmetric)', async () => {
    const bench = await startBench('hubB', { declaredTrustTier: 'T1' })
    try {
      const aLink = await connectHubLink({
        url: bench.url,
        selfId: 'hubA',
        declaredTrustTier: 'T3',
      })
      const bLink = await bench.nextLink()
      expect(declaredTierOf(bLink)).toBe('T3') // B saw A's HELLO
      expect(declaredTierOf(aLink)).toBe('T1') // A saw B's ACK
      await aLink.close()
    } finally {
      await bench.stop()
    }
  })

  it('unknown declared value is dropped to null (never trusted, handshake still succeeds)', async () => {
    const bench = await startBench('hubB')
    try {
      // A malformed/unknown tier string must not poison the capture — it
      // is ignored (stays null) and the handshake is unaffected. Cast past
      // the type guard to simulate a peer on a newer/older/hostile build.
      const aLink = await connectHubLink({
        url: bench.url,
        selfId: 'hubA',
        declaredTrustTier: 'T9' as unknown as TrustTier,
      })
      const bLink = await bench.nextLink()
      expect(bLink.status).toBe('open')
      expect(declaredTierOf(bLink)).toBe(null)
      await aLink.close()
    } finally {
      await bench.stop()
    }
  })

  it('no declaration → null on both sides (byte-identical-to-today default)', async () => {
    const bench = await startBench('hubB')
    try {
      const aLink = await connectHubLink({ url: bench.url, selfId: 'hubA' })
      const bLink = await bench.nextLink()
      expect(declaredTierOf(aLink)).toBe(null)
      expect(declaredTierOf(bLink)).toBe(null)
      await aLink.close()
    } finally {
      await bench.stop()
    }
  })

  it('IRON LAW: a wrong-token HELLO that declares T3 still fails auth and NEVER captures the tier', async () => {
    // 声明 ≠ 信任. The declaration must not buy the peer past the auth
    // gate, and a rejected handshake must record nothing. We capture the
    // IN-side link even on failure to assert it never saw the tier.
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
    const addr = wss.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const url = `ws://127.0.0.1:${port}`

    // Grab the raw inbound link the instant it is constructed — before its
    // handshake resolves or rejects — so we can inspect it post-mortem. We
    // reach into acceptHubLinks' onLink (only fires on SUCCESS), plus a
    // fallback timer, to prove onLink never fires for a rejected peer.
    let acceptedLink: HubLink | null = null
    acceptHubLinks({
      server: wss,
      selfId: 'hubB',
      auth: bearerAuth({ token: 'server-secret' }),
      // The IN side declares its own T2, but that is irrelevant — the point
      // is the OUT side's bad-token+T3 HELLO gets rejected.
      declaredTrustTier: 'T2',
      onLink: (link) => {
        acceptedLink = link
      },
    })

    try {
      await expect(
        connectHubLink({
          url,
          selfId: 'hubA',
          auth: bearerAuth({ token: 'client-WRONG-secret' }),
          declaredTrustTier: 'T3',
          handshakeTimeoutMs: 1000,
        }),
      ).rejects.toThrow(/closed during handshake|peer_disconnected|handshake/i)

      // The rejected peer NEVER became an accepted link. The declaration
      // bought it nothing: no capture, no membership, no trust.
      await delay(50)
      expect(acceptedLink).toBe(null)
    } finally {
      for (const client of wss.clients) {
        try {
          client.terminate()
        } catch {
          /* swallow */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })
})
