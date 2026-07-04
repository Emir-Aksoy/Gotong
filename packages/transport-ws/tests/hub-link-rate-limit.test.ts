/**
 * Phase 6 #12 — acceptHubLinks onConnectionAttempt hook.
 *
 * Verifies the pre-handshake rate-limit gate. The hook fires BEFORE
 * a HubLink is constructed; returning false closes the ws silently.
 * Tests focus on the gate semantics — the actual fixed-window limiter
 * lives in PeerRegistry (host) and is exercised in the host suite.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

import { acceptHubLinks, connectHubLink, type HubLink } from '../src/index.js'

interface Bench {
  wss: WebSocketServer
  url: string
  attempts: string[]
  decisions: boolean[]
  stop: () => Promise<void>
}

async function startBench(opts: {
  onConnectionAttempt?: (ip: string) => boolean
  trustProxy?: boolean
}): Promise<Bench> {
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const addr = wss.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const url = `ws://127.0.0.1:${port}`
  const attempts: string[] = []
  const decisions: boolean[] = []

  const acceptedLinks: HubLink[] = []
  acceptHubLinks({
    server: wss,
    selfId: 'hubB',
    ...(opts.trustProxy ? { trustProxy: true } : {}),
    ...(opts.onConnectionAttempt
      ? {
        onConnectionAttempt: (ip) => {
          attempts.push(ip)
          const ok = opts.onConnectionAttempt!(ip)
          decisions.push(ok)
          return ok
        },
      }
      : {}),
    onLink: (link) => { acceptedLinks.push(link) },
  })

  return {
    wss,
    url,
    attempts,
    decisions,
    stop: async () => {
      for (const l of acceptedLinks) await l.close().catch(() => {})
      for (const c of wss.clients) {
        try { c.terminate() } catch { /* */ }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

describe('acceptHubLinks — onConnectionAttempt (Phase 6 #12)', () => {
  let bench: Bench
  afterEach(async () => { if (bench) await bench.stop() })

  it('hook receives source IP and allows when returns true', async () => {
    bench = await startBench({ onConnectionAttempt: () => true })
    const link = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    expect(bench.attempts).toHaveLength(1)
    // localhost can be ::1 or 127.0.0.1 depending on ws version; both
    // are non-empty strings.
    expect(bench.attempts[0]!.length).toBeGreaterThan(0)
    expect(bench.decisions).toEqual([true])
    await link.close()
  })

  it('returning false closes the ws before handshake state', async () => {
    bench = await startBench({ onConnectionAttempt: () => false })
    // The connect will fail because the server closes immediately.
    // We don't assert a specific error message — just that the connect
    // rejects rather than hangs.
    await expect(
      connectHubLink({ url: bench.url, selfId: 'hubA', handshakeTimeoutMs: 1000 }),
    ).rejects.toThrow()
    expect(bench.attempts).toHaveLength(1)
    expect(bench.decisions).toEqual([false])
  })

  it('hook throw is treated as reject (fail closed)', async () => {
    bench = await startBench({
      onConnectionAttempt: () => {
        throw new Error('limiter exploded')
      },
    })
    await expect(
      connectHubLink({ url: bench.url, selfId: 'hubA', handshakeTimeoutMs: 1000 }),
    ).rejects.toThrow()
  })

  it('without hook, every connection proceeds (default behavior)', async () => {
    bench = await startBench({})
    const link = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    expect(bench.attempts).toEqual([]) // hook never invoked
    await link.close()
  })

  it('different IPs (simulated) are recorded distinctly', async () => {
    // We can't actually use different IPs against localhost, but the
    // hook can inspect its input and choose differently per "call number".
    // Verifies the gate is per-attempt, not a one-shot decision.
    let count = 0
    bench = await startBench({
      onConnectionAttempt: () => {
        count++
        return count <= 2 // first two allowed, third blocked
      },
    })
    const a = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    const b = await connectHubLink({ url: bench.url, selfId: 'hubAA' })
    await expect(
      connectHubLink({ url: bench.url, selfId: 'hubAAA', handshakeTimeoutMs: 1000 }),
    ).rejects.toThrow()
    expect(bench.decisions).toEqual([true, true, false])
    await a.close()
    await b.close()
  })

  // Smoke for the constructor — confirms the ws library's connection
  // handler signature (ws, req) is what we're consuming. If the upstream
  // ever changed the order, the IP would come through as 'unknown'.
  it('IP comes from the request socket, not a synthetic placeholder', async () => {
    bench = await startBench({ onConnectionAttempt: () => true })
    void new WebSocket(bench.url) // raw connect; immediately closes after
    // Give the server one tick to record the attempt.
    await new Promise((r) => setTimeout(r, 50))
    expect(bench.attempts.length).toBeGreaterThanOrEqual(1)
    expect(bench.attempts[0]).not.toBe('unknown')
  })
})

// Audit #142 — when this server sits behind a reverse proxy, the
// raw `req.socket.remoteAddress` is the proxy's loopback, NOT the
// real client. Without trustProxy=true, every peer buckets under
// the same loopback IP — one rude peer starves all others (or
// every peer shares the 60/60s budget). The fix mirrors
// @gotong/web's clientIp helper: trustProxy → use first XFF entry.
describe('acceptHubLinks — trustProxy + X-Forwarded-For (Audit #142)', () => {
  let bench: Bench
  afterEach(async () => { if (bench) await bench.stop() })

  it('default (trustProxy off): XFF header is ignored, IP is socket remoteAddress', async () => {
    bench = await startBench({ onConnectionAttempt: () => true })
    void new WebSocket(bench.url, {
      headers: { 'x-forwarded-for': '203.0.113.42' },
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(bench.attempts.length).toBeGreaterThanOrEqual(1)
    // The header is present but trustProxy is off — must NOT honour it.
    expect(bench.attempts[0]).not.toBe('203.0.113.42')
    expect(bench.attempts[0]!.length).toBeGreaterThan(0) // is some real IP
  })

  it('trustProxy on: first XFF entry becomes the rate-limit key', async () => {
    bench = await startBench({
      onConnectionAttempt: () => true,
      trustProxy: true,
    })
    void new WebSocket(bench.url, {
      headers: { 'x-forwarded-for': '203.0.113.42' },
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(bench.attempts[0]).toBe('203.0.113.42')
  })

  it('trustProxy on + chained XFF: picks the first (leftmost) entry', async () => {
    bench = await startBench({
      onConnectionAttempt: () => true,
      trustProxy: true,
    })
    void new WebSocket(bench.url, {
      headers: { 'x-forwarded-for': '203.0.113.42, 10.0.0.1, 192.168.1.7' },
    })
    await new Promise((r) => setTimeout(r, 50))
    // Leftmost = the original client per RFC 7239 convention.
    expect(bench.attempts[0]).toBe('203.0.113.42')
  })

  it('trustProxy on but no XFF header: falls back to socket remoteAddress', async () => {
    bench = await startBench({
      onConnectionAttempt: () => true,
      trustProxy: true,
    })
    void new WebSocket(bench.url) // no XFF
    await new Promise((r) => setTimeout(r, 50))
    expect(bench.attempts[0]!.length).toBeGreaterThan(0)
    // The actual socket peer is some loopback variant; the assertion
    // is just "didn't crash and didn't return 'unknown'".
    expect(bench.attempts[0]).not.toBe('unknown')
  })

  it('trustProxy on + empty XFF: falls back to socket remoteAddress', async () => {
    bench = await startBench({
      onConnectionAttempt: () => true,
      trustProxy: true,
    })
    void new WebSocket(bench.url, { headers: { 'x-forwarded-for': '' } })
    await new Promise((r) => setTimeout(r, 50))
    expect(bench.attempts[0]!.length).toBeGreaterThan(0)
    expect(bench.attempts[0]).not.toBe('')
  })

  it('per-IP isolation via XFF: two different XFF values get different rate buckets', async () => {
    // Critical scenario: behind a proxy, two real client IPs come
    // through the same socket (the proxy's). Without trustProxy, the
    // limiter would treat them as one bucket; with trustProxy, each
    // gets its own.
    const calls: string[] = []
    bench = await startBench({
      trustProxy: true,
      onConnectionAttempt: (ip) => {
        calls.push(ip)
        return true
      },
    })
    void new WebSocket(bench.url, { headers: { 'x-forwarded-for': '198.51.100.1' } })
    await new Promise((r) => setTimeout(r, 30))
    void new WebSocket(bench.url, { headers: { 'x-forwarded-for': '198.51.100.2' } })
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toEqual(['198.51.100.1', '198.51.100.2'])
  })
})
