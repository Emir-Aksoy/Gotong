/**
 * Phase 6 #4 — Per-peer inbound token resolver.
 *
 * Verifies the new `peerTokenResolver` option on acceptHubLinks /
 * WebSocketHubLinkOptions. The shared-token path (FED-M1) remains in
 * hub-link.test.ts; this file isolates the resolver semantics:
 *
 *   - Resolver wins over shared token when both are set
 *   - Unknown peer (resolver returns null) → handshake rejected
 *   - Wrong token (resolver returns X, peer presents Y) → rejected
 *   - Right token → handshake succeeds
 *   - Resolver throws → fail closed (treat as unknown)
 *   - Resolver returns '' → fail closed (defensive)
 *   - Peer presents no peerId (degenerate; protocol requires it) →
 *     would be caught by the existing peerId check, but per-peer
 *     also requires non-empty peerId so we belt-and-braces here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

import {
  acceptHubLinks,
  connectHubLink,
  type HubLink,
} from '../src/index.js'

interface Bench {
  wss: WebSocketServer
  url: string
  nextLink: () => Promise<HubLink>
  stop: () => Promise<void>
}

async function startBench(
  selfId: string,
  opts: {
    peerToken?: string
    peerTokenResolver?: (claimedPeerId: string) => string | null
  } = {},
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
    ...(opts.peerTokenResolver
      ? { peerTokenResolver: opts.peerTokenResolver }
      : {}),
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
      for (const link of pendingLinks.splice(0)) {
        await link.close().catch(() => {})
      }
      for (const client of wss.clients) {
        try { client.terminate() } catch { /* swallow */ }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

describe('WebSocketHubLink — per-peer token resolver (Phase 6 #4)', () => {
  let bench: Bench
  afterEach(async () => { if (bench) await bench.stop() })

  it('right peerId + right token → handshake succeeds', async () => {
    bench = await startBench('hubB', {
      peerTokenResolver: (peerId) => {
        if (peerId === 'hubA') return 'token-for-A'
        return null
      },
    })
    const outP = connectHubLink({
      url: bench.url,
      selfId: 'hubA',
      peerToken: 'token-for-A',
    })
    const inLink = await bench.nextLink()
    const outLink = await outP
    expect(inLink.peerId).toBe('hubA')
    expect(outLink.peerId).toBe('hubB')
    await outLink.close()
  })

  it('unknown peerId (resolver returns null) → handshake rejected', async () => {
    bench = await startBench('hubB', {
      peerTokenResolver: (peerId) => (peerId === 'hubA' ? 'token-for-A' : null),
    })
    await expect(
      connectHubLink({
        url: bench.url,
        selfId: 'hubStranger',
        peerToken: 'any-token',
      }),
    ).rejects.toThrow(/handshake|unknown peer|closed/i)
  })

  it('right peerId but wrong token → handshake rejected', async () => {
    bench = await startBench('hubB', {
      peerTokenResolver: (peerId) => (peerId === 'hubA' ? 'token-for-A' : null),
    })
    await expect(
      connectHubLink({
        url: bench.url,
        selfId: 'hubA',
        peerToken: 'WRONG-token',
      }),
    ).rejects.toThrow(/handshake|invalid|closed/i)
  })

  it('peer presents no token → rejected (resolver requires mutual auth)', async () => {
    bench = await startBench('hubB', {
      peerTokenResolver: (peerId) => (peerId === 'hubA' ? 'token-for-A' : null),
    })
    await expect(
      connectHubLink({
        url: bench.url,
        selfId: 'hubA',
        // no peerToken
      }),
    ).rejects.toThrow(/handshake|mutual auth|closed/i)
  })

  it('resolver throws → fail closed (treated as unknown peer)', async () => {
    bench = await startBench('hubB', {
      peerTokenResolver: () => {
        throw new Error('db is down')
      },
    })
    await expect(
      connectHubLink({
        url: bench.url,
        selfId: 'hubA',
        peerToken: 'any',
      }),
    ).rejects.toThrow(/handshake|refusing|closed/i)
  })

  it('resolver returns empty string → fail closed (defensive)', async () => {
    bench = await startBench('hubB', {
      // Buggy resolver: returns '' instead of null. We treat it as
      // misconfiguration and refuse — never compare empty strings.
      peerTokenResolver: () => '',
    })
    await expect(
      connectHubLink({
        url: bench.url,
        selfId: 'hubA',
        peerToken: 'any',
      }),
    ).rejects.toThrow(/handshake|empty|refusing|closed/i)
  })

  it('resolver wins over shared peerToken when both are set', async () => {
    // Both resolver AND shared token configured. Resolver should win.
    // The shared "fallback-secret" must NOT be honored — only the
    // resolver's per-peer answer counts.
    bench = await startBench('hubB', {
      peerToken: 'fallback-secret', // would accept legacy clients
      peerTokenResolver: (peerId) =>
        peerId === 'hubA' ? 'token-for-A' : null,
    })
    // Client presenting the shared "fallback-secret" must be rejected
    // because the resolver returned 'token-for-A' for hubA.
    await expect(
      connectHubLink({
        url: bench.url,
        selfId: 'hubA',
        peerToken: 'fallback-secret',
      }),
    ).rejects.toThrow(/handshake|invalid|closed/i)
    // But the right per-peer token works.
    const outP = connectHubLink({
      url: bench.url,
      selfId: 'hubA',
      peerToken: 'token-for-A',
    })
    await bench.nextLink()
    const outLink = await outP
    expect(outLink.peerId).toBe('hubB')
    await outLink.close()
  })

  it('different peers get different tokens through the same resolver', async () => {
    const tokens: Record<string, string> = {
      hubA: 'A-secret',
      hubB: 'B-secret',
    }
    bench = await startBench('hubX', {
      peerTokenResolver: (peerId) => tokens[peerId] ?? null,
    })

    const a = await connectHubLink({
      url: bench.url,
      selfId: 'hubA',
      peerToken: 'A-secret',
    })
    await bench.nextLink()
    const b = await connectHubLink({
      url: bench.url,
      selfId: 'hubB',
      peerToken: 'B-secret',
    })
    await bench.nextLink()

    expect(a.peerId).toBe('hubX')
    expect(b.peerId).toBe('hubX')
    await a.close()
    await b.close()

    // And a peer using the wrong token (B trying A's secret) is rejected.
    await expect(
      connectHubLink({
        url: bench.url,
        selfId: 'hubB',
        peerToken: 'A-secret',
      }),
    ).rejects.toThrow(/handshake|invalid|closed/i)
  })
})
