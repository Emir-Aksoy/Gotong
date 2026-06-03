/**
 * Peer summary — provider + per-link gate + consumer (v5 Stream E5-M2).
 *
 * buildLocalSummary aggregates this hub's privacy-safe COUNTS (best-effort per
 * family); PeerSummaryHost.respond answers the one wire method; denyPeerSummaryRpc
 * is the per-link fail-closed gate (peer.summary denied, everything else through);
 * fetchPeerSummary + normalizePeerSummary defend the consumer against a hostile
 * reply. The end-to-end case runs the whole thing over an inproc HubLink pair,
 * mirroring peer-manifest.test.ts.
 */

import { describe, expect, it } from 'vitest'

import { createInprocHubLinkPair, type HubLink, type Participant } from '@aipehub/core'

import {
  PeerSummaryHost,
  PEER_SUMMARY_METHODS,
  PEER_SUMMARY_VERSION,
  buildLocalSummary,
  denyPeerSummaryRpc,
  fetchPeerSummary,
  normalizePeerSummary,
  type BuildSummaryDeps,
  type SummaryLedgerRow,
} from '../src/peer-summary.js'

const DAY_MS = 86_400_000

function fakeParticipant(id: string): Participant {
  return { id, kind: 'agent', capabilities: [] } as unknown as Participant
}

function ledgerRow(over: Partial<SummaryLedgerRow>): SummaryLedgerRow {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costMicros: 0,
    ...over,
  }
}

/** A fully-wired deps object whose sources each report distinct counts. */
function richDeps(over: Partial<BuildSummaryDeps> = {}): BuildSummaryDeps {
  return {
    hubId: 'hub_self',
    hub: { participants: () => [fakeParticipant('a'), fakeParticipant('b'), fakeParticipant('hub_n')] },
    peerWrapperIds: () => new Set(['hub_n']), // one wrapper excluded → 2 agents
    workflows: {
      listAll: async () => [{ state: 'draft' }, { state: 'published' }, { state: 'published' }],
      countRuns: async () => ({ total: 5, byStatus: { running: 1, done: 3, failed: 1 } }),
    },
    identity: {
      listPeers: () => [{}, {}], // 2 peers
      countSuspendedTasks: () => 4,
      aggregateLedger: () => [
        ledgerRow({ calls: 2, inputTokens: 10, outputTokens: 5, costMicros: 1000 }),
        ledgerRow({ calls: 1, cacheReadTokens: 7, costMicros: 500 }),
      ],
    },
    now: () => 1_000_000_000_000,
    ...over,
  }
}

describe('buildLocalSummary (v5 E5-M2)', () => {
  it('aggregates every count family, excluding peer wrappers from agents', async () => {
    const s = await buildLocalSummary(richDeps())
    expect(s.hubId).toBe('hub_self')
    expect(s.protocolVersion).toBe(PEER_SUMMARY_VERSION)
    expect(s.generatedAt).toBe(1_000_000_000_000)
    expect(s.assets).toEqual({ agents: 2, workflows: 3, publishedWorkflows: 2, peers: 2 })
    expect(s.runs).toEqual({ total: 5, byStatus: { running: 1, done: 3, failed: 1 } })
    // tokens = (10+5) + 7 = 22; calls = 3; cost = 1500
    expect(s.llm).toEqual({ windowDays: 30, calls: 3, tokens: 22, costMicros: 1500 })
    expect(s.health).toEqual({ suspendedTasks: 4 })
  })

  it('passes a trailing window `since` to the ledger and honours windowDays', async () => {
    let seen: { groupBy: string; since?: number } | undefined
    const s = await buildLocalSummary(
      richDeps({
        windowDays: 7,
        identity: {
          aggregateLedger: (q) => {
            seen = q
            return [ledgerRow({ calls: 9 })]
          },
        },
      }),
    )
    expect(s.llm.windowDays).toBe(7)
    expect(s.llm.calls).toBe(9)
    // since == now - 7 days
    expect(seen).toEqual({ groupBy: 'model', since: 1_000_000_000_000 - 7 * DAY_MS })
  })

  it('is best-effort: a throwing source leaves only that family at zero', async () => {
    const s = await buildLocalSummary(
      richDeps({
        workflows: {
          listAll: async () => {
            throw new Error('boom')
          },
          countRuns: async () => ({ total: 2, byStatus: { done: 2 } }),
        },
      }),
    )
    // workflow asset counts fell back to 0…
    expect(s.assets.workflows).toBe(0)
    expect(s.assets.publishedWorkflows).toBe(0)
    // …but every OTHER family still aggregated.
    expect(s.assets.agents).toBe(2)
    expect(s.runs.total).toBe(2)
    expect(s.health.suspendedTasks).toBe(4)
  })

  it('returns a fully-zeroed stable shape when no sources are wired', async () => {
    const s = await buildLocalSummary({
      hubId: 'bare',
      hub: { participants: () => [] },
      peerWrapperIds: () => new Set(),
      now: () => 42,
    })
    expect(s).toEqual({
      hubId: 'bare',
      protocolVersion: PEER_SUMMARY_VERSION,
      generatedAt: 42,
      assets: { agents: 0, workflows: 0, publishedWorkflows: 0, peers: 0 },
      runs: { total: 0, byStatus: {} },
      llm: { windowDays: 30, calls: 0, tokens: 0, costMicros: 0 },
      health: { suspendedTasks: 0 },
    })
  })
})

describe('PeerSummaryHost.respond (v5 E5-M2)', () => {
  it('answers peer.summary with the local summary', async () => {
    const host = new PeerSummaryHost(richDeps())
    const out = (await host.respond({ method: PEER_SUMMARY_METHODS.get, params: {} })) as {
      assets: { agents: number }
    }
    expect(out.assets.agents).toBe(2)
  })

  it('rejects an unknown method', async () => {
    const host = new PeerSummaryHost(richDeps())
    await expect(host.respond({ method: 'peer.exfiltrate', params: {} })).rejects.toThrow(
      /unknown peer summary method/,
    )
  })
})

describe('denyPeerSummaryRpc (v5 E5-M2, per-link gate)', () => {
  it('denies peer.summary (fail-closed) but passes every other method through', async () => {
    const seen: string[] = []
    const inner = async (call: { method: string; params: unknown }) => {
      seen.push(call.method)
      return `ok:${call.method}`
    }
    const gated = denyPeerSummaryRpc(inner)

    await expect(gated({ method: PEER_SUMMARY_METHODS.get, params: {} })).rejects.toThrow(
      /not shared by this peer/,
    )
    // the inner responder was never even consulted for the denied method
    expect(seen).toEqual([])

    expect(await gated({ method: 'mcp.listShared', params: {} })).toBe('ok:mcp.listShared')
    expect(await gated({ method: 'peer.manifest', params: {} })).toBe('ok:peer.manifest')
    expect(seen).toEqual(['mcp.listShared', 'peer.manifest'])
  })
})

describe('normalizePeerSummary (v5 E5-M2, consumer defence)', () => {
  it('coerces a hostile / partial reply into a well-formed summary', () => {
    const out = normalizePeerSummary({
      hubId: 'hub_x',
      generatedAt: 'not-a-number', // → 0
      assets: { agents: 3, workflows: 'x' }, // workflows → 0, others default 0
      runs: { total: 2, byStatus: { done: 2, weird: 'NaN' } }, // weird → 0
      llm: { calls: 7 },
      // health missing entirely
    })
    expect(out).toEqual({
      hubId: 'hub_x',
      protocolVersion: PEER_SUMMARY_VERSION, // defaulted
      generatedAt: 0,
      assets: { agents: 3, workflows: 0, publishedWorkflows: 0, peers: 0 },
      runs: { total: 2, byStatus: { done: 2, weird: 0 } },
      llm: { windowDays: 0, calls: 7, tokens: 0, costMicros: 0 },
      health: { suspendedTasks: 0 },
    })
  })

  it('defaults hubId to empty string when missing', () => {
    expect(normalizePeerSummary({}).hubId).toBe('')
  })
})

describe('fetchPeerSummary (v5 E5-M2, consumer)', () => {
  it('forwards the peer.summary rpc and normalises the reply', async () => {
    const seen: Array<{ method: string; params: unknown }> = []
    const link = {
      status: 'open' as const,
      rpc: async (method: string, params: unknown) => {
        seen.push({ method, params })
        return { hubId: 'hub_p', assets: { agents: 1 }, protocolVersion: '1' }
      },
    } as unknown as HubLink
    const out = await fetchPeerSummary(link)
    expect(out?.hubId).toBe('hub_p')
    expect(out?.assets.agents).toBe(1)
    expect(seen).toEqual([{ method: PEER_SUMMARY_METHODS.get, params: {} }])
  })

  it('returns null when the peer answers a non-object', async () => {
    const link = { status: 'open', rpc: async () => null } as unknown as HubLink
    expect(await fetchPeerSummary(link)).toBeNull()
  })

  it('propagates a gate rejection (an unshared peer) to the caller', async () => {
    const link = {
      status: 'open',
      rpc: async () => {
        throw new Error('peer summary is not shared by this peer')
      },
    } as unknown as HubLink
    await expect(fetchPeerSummary(link)).rejects.toThrow(/not shared by this peer/)
  })
})

describe('peer summary — end to end over a live link (v5 E5-M2)', () => {
  it('a consumer fetches a provider hub summary through the inproc link', async () => {
    const { a, b } = createInprocHubLinkPair({ aPeerId: 'provider', bPeerId: 'consumer' })
    const host = new PeerSummaryHost(
      richDeps({ hubId: 'provider', now: () => 7_000 }),
    )
    a.on('rpc', host.respond)
    const summary = await fetchPeerSummary(b)
    expect(summary?.hubId).toBe('provider')
    expect(summary?.assets).toEqual({ agents: 2, workflows: 3, publishedWorkflows: 2, peers: 2 })
    expect(summary?.generatedAt).toBe(7_000)
    await a.close()
  })

  it('denies the same fetch when the link is wrapped by the per-link gate', async () => {
    const { a, b } = createInprocHubLinkPair({ aPeerId: 'provider', bPeerId: 'consumer' })
    const host = new PeerSummaryHost(richDeps({ hubId: 'provider' }))
    // The provider has NOT opted into sharing → registry wraps respond in the gate.
    a.on('rpc', denyPeerSummaryRpc(host.respond))
    await expect(fetchPeerSummary(b)).rejects.toThrow(/not shared by this peer/)
    await a.close()
  })
})
