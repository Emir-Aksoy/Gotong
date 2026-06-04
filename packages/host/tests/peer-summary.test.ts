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
import type {
  AddPeerSummaryAlertRuleInput,
  PeerSummaryAlertRule,
  UpdatePeerSummaryAlertRuleInput,
} from '@aipehub/identity'

import {
  PeerSummaryHost,
  PEER_SUMMARY_METHODS,
  PEER_SUMMARY_VERSION,
  buildLocalSummary,
  createPeerSummaryFederation,
  denyPeerSummaryRpc,
  fetchPeerSummary,
  normalizePeerSummary,
  type BuildSummaryDeps,
  type PeerSummary,
  type PeerSummaryAlertRuleSink,
  type SummaryLedgerRow,
  type SummaryPeerRegistryView,
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

describe('createPeerSummaryFederation (v5 E5-M3)', () => {
  type Row = { peerId: string; label: string | null; connected: boolean }

  const summaryFor = (hubId: string): PeerSummary => ({
    hubId,
    protocolVersion: PEER_SUMMARY_VERSION,
    generatedAt: 1,
    assets: { agents: 1, workflows: 0, publishedWorkflows: 0, peers: 0 },
    runs: { total: 0, byStatus: {} },
    llm: { windowDays: 30, calls: 0, tokens: 0, costMicros: 0 },
    health: { suspendedTasks: 0 },
  })

  function summaryLink(s: PeerSummary | null): HubLink {
    return { status: 'open', rpc: async () => s } as unknown as HubLink
  }
  function notSharedLink(): HubLink {
    return {
      status: 'open',
      rpc: async () => {
        throw new Error('peer summary is not shared by this peer')
      },
    } as unknown as HubLink
  }

  function stub(rows: Row[], links: Record<string, HubLink | null>): SummaryPeerRegistryView {
    return {
      status: () => rows,
      linkForHub: (peerId) => links[peerId] ?? null,
    }
  }

  const local = summaryFor('local')

  it('local() returns the host-built summary', async () => {
    const fed = createPeerSummaryFederation(stub([], {}), { buildLocal: async () => local })
    expect((await fed.local()).hubId).toBe('local')
  })

  it('lists every peer as unknown (no summary, no error) before any refresh', async () => {
    const fed = createPeerSummaryFederation(
      stub([{ peerId: 'p1', label: 'Partner', connected: true }], {}),
      { buildLocal: async () => local },
    )
    expect(await fed.list()).toEqual([
      {
        peer: 'p1',
        label: 'Partner',
        online: true,
        stale: false,
        summary: null,
        lastFetchedAt: null,
        lastError: null,
      },
    ])
  })

  it('refresh caches a connected peer summary + timestamp', async () => {
    const fed = createPeerSummaryFederation(
      stub([{ peerId: 'p1', label: null, connected: true }], { p1: summaryLink(summaryFor('p1')) }),
      { buildLocal: async () => local, now: () => 1000 },
    )
    await fed.refresh()
    const row = (await fed.list())[0]!
    expect(row.summary?.hubId).toBe('p1')
    expect(row.lastFetchedAt).toBe(1000)
    expect(row.lastError).toBeNull()
  })

  it('records lastError when a peer refuses to share (the gate rejects)', async () => {
    const fed = createPeerSummaryFederation(
      stub([{ peerId: 'p1', label: null, connected: true }], { p1: notSharedLink() }),
      { buildLocal: async () => local },
    )
    await fed.refresh()
    const row = (await fed.list())[0]!
    expect(row.summary).toBeNull() // no counts — distinct from offline
    expect(row.lastError).toMatch(/not shared by this peer/)
  })

  it('marks a peer stale once offline but keeps its cached summary', async () => {
    const rows: Row[] = [{ peerId: 'p1', label: null, connected: true }]
    const fed = createPeerSummaryFederation(stub(rows, { p1: summaryLink(summaryFor('p1')) }), {
      buildLocal: async () => local,
      now: () => 1000,
    })
    await fed.refresh()
    rows[0]!.connected = false
    const row = (await fed.list())[0]!
    expect(row.online).toBe(false)
    expect(row.stale).toBe(true)
    expect(row.summary?.hubId).toBe('p1') // last-known retained
  })

  it('refresh(peerId) only refetches the named peer', async () => {
    const seen: string[] = []
    const linkFor = (id: string): HubLink =>
      ({
        status: 'open',
        rpc: async () => {
          seen.push(id)
          return summaryFor(id)
        },
      }) as unknown as HubLink
    const fed = createPeerSummaryFederation(
      stub(
        [
          { peerId: 'p1', label: null, connected: true },
          { peerId: 'p2', label: null, connected: true },
        ],
        { p1: linkFor('p1'), p2: linkFor('p2') },
      ),
      { buildLocal: async () => local },
    )
    await fed.refresh('p2')
    expect(seen).toEqual(['p2'])
    const rows = await fed.list()
    expect(rows.find((r) => r.peer === 'p1')!.summary).toBeNull()
    expect(rows.find((r) => r.peer === 'p2')!.summary?.hubId).toBe('p2')
  })

  it('clears a prior lastError once a later refresh succeeds', async () => {
    const links: Record<string, HubLink | null> = { p1: notSharedLink() }
    const fed = createPeerSummaryFederation(
      stub([{ peerId: 'p1', label: null, connected: true }], links),
      { buildLocal: async () => local, now: () => 1 },
    )
    await fed.refresh()
    expect((await fed.list())[0]!.lastError).toBeTruthy()
    links.p1 = summaryLink(summaryFor('p1')) // peer opted in since
    await fed.refresh()
    const row = (await fed.list())[0]!
    expect(row.lastError).toBeNull()
    expect(row.summary?.hubId).toBe('p1')
  })

  // ── v5 Stream F — control-plane history (snapshots + trend) ──────────────

  function makeFakeSink() {
    const rows: Array<{ capturedAt: number; source: string; summaryJson: string }> = []
    return {
      rows,
      appendPeerSummarySnapshot(input: {
        capturedAt?: number
        source: string
        summaryJson: string
      }) {
        rows.push({
          capturedAt: input.capturedAt ?? 0,
          source: input.source,
          summaryJson: input.summaryJson,
        })
      },
      listPeerSummarySnapshots(q: {
        source?: string
        since?: number
        until?: number
        limit?: number
      }) {
        return rows
          .filter((r) => q.source === undefined || r.source === q.source)
          .filter((r) => q.since === undefined || r.capturedAt >= q.since)
          .filter((r) => q.until === undefined || r.capturedAt < q.until)
          .sort((a, b) => a.capturedAt - b.capturedAt)
          .map((r) => ({ capturedAt: r.capturedAt, summaryJson: r.summaryJson }))
      },
    }
  }

  it('refresh with a snapshot sink records local + each fetched peer', async () => {
    const sink = makeFakeSink()
    const fed = createPeerSummaryFederation(
      stub([{ peerId: 'p1', label: null, connected: true }], { p1: summaryLink(summaryFor('p1')) }),
      { buildLocal: async () => local, snapshots: sink, now: () => 2000 },
    )
    await fed.refresh()
    // one local reading + one per fetched peer, all stamped with the same now().
    expect(sink.rows.map((r) => r.source).sort()).toEqual(['local', 'p1'])
    expect(sink.rows.every((r) => r.capturedAt === 2000)).toBe(true)
    // the blob is a parseable counts-only PeerSummary, not a raw row dump.
    const localRow = sink.rows.find((r) => r.source === 'local')!
    expect(JSON.parse(localRow.summaryJson).hubId).toBe('local')
  })

  it('history projects a scalar metric trend from captured snapshots', async () => {
    const sink = makeFakeSink()
    let agents = 1
    let clock = 1000
    const fed = createPeerSummaryFederation(stub([], {}), {
      buildLocal: async () => ({
        ...summaryFor('local'),
        assets: { agents, workflows: 0, publishedWorkflows: 0, peers: 0 },
      }),
      snapshots: sink,
      now: () => clock,
    })
    await fed.refresh() // local agents=1 @1000
    agents = 3
    clock = 2000
    await fed.refresh() // local agents=3 @2000
    const trend = await fed.history({ source: 'local', metric: 'assets.agents' })
    expect(trend).toEqual([
      { capturedAt: 1000, value: 1 },
      { capturedAt: 2000, value: 3 },
    ])
  })

  it('history returns [] (and refresh captures nothing) without a snapshot sink', async () => {
    const fed = createPeerSummaryFederation(
      stub([{ peerId: 'p1', label: null, connected: true }], { p1: summaryLink(summaryFor('p1')) }),
      { buildLocal: async () => local },
    )
    await fed.refresh()
    expect(await fed.history({ source: 'local', metric: 'assets.agents' })).toEqual([])
  })

  it('metricKeys exposes the canonical trendable metric list', async () => {
    const fed = createPeerSummaryFederation(stub([], {}), { buildLocal: async () => local })
    const keys = fed.metricKeys()
    expect(keys).toContain('assets.agents')
    expect(keys).toContain('health.suspendedTasks')
    expect(keys.length).toBeGreaterThanOrEqual(9)
  })

  // ── v5 Stream F-M5 — control-plane alert rules + live evaluation ─────────

  /** In-memory alert-rule sink mirroring IdentityStore's four method names. */
  function makeFakeAlertSink(): PeerSummaryAlertRuleSink & { count: () => number } {
    const rules = new Map<string, PeerSummaryAlertRule>()
    let n = 0
    return {
      count: () => rules.size,
      listPeerSummaryAlertRules: () => [...rules.values()],
      addPeerSummaryAlertRule(input: AddPeerSummaryAlertRuleInput) {
        const id = input.id ?? `r${++n}`
        const rule: PeerSummaryAlertRule = {
          id,
          source: input.source,
          metric: input.metric,
          comparator: input.comparator,
          threshold: input.threshold,
          label: input.label ?? null,
          enabled: input.enabled ?? true,
          createdAt: 0,
          updatedAt: 0,
        }
        rules.set(id, rule)
        return rule
      },
      updatePeerSummaryAlertRule(id: string, patch: UpdatePeerSummaryAlertRuleInput) {
        const r = rules.get(id)
        if (!r) throw Object.assign(new Error('no rule'), { code: 'alert_rule_not_found' })
        const next: PeerSummaryAlertRule = {
          ...r,
          ...(patch.source !== undefined ? { source: patch.source } : {}),
          ...(patch.metric !== undefined ? { metric: patch.metric } : {}),
          ...(patch.comparator !== undefined ? { comparator: patch.comparator } : {}),
          ...(patch.threshold !== undefined ? { threshold: patch.threshold } : {}),
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        }
        rules.set(id, next)
        return next
      },
      removePeerSummaryAlertRule(id: string) {
        return rules.delete(id)
      },
    }
  }

  it('alert CRUD delegates to the wired sink', () => {
    const sink = makeFakeAlertSink()
    const fed = createPeerSummaryFederation(stub([], {}), {
      buildLocal: async () => local,
      alertRules: sink,
    })
    const rule = fed.addAlertRule({
      source: 'local',
      metric: 'health.suspendedTasks',
      comparator: 'gt',
      threshold: 5,
    })
    expect(fed.listAlertRules()).toHaveLength(1)
    const updated = fed.updateAlertRule(rule.id, { threshold: 9, enabled: false })
    expect(updated.threshold).toBe(9)
    expect(updated.enabled).toBe(false)
    expect(fed.removeAlertRule(rule.id)).toBe(true)
    expect(fed.listAlertRules()).toEqual([])
  })

  it('without an alert sink: list/remove are empty, mutations throw', () => {
    const fed = createPeerSummaryFederation(stub([], {}), { buildLocal: async () => local })
    expect(fed.listAlertRules()).toEqual([])
    expect(fed.removeAlertRule('x')).toBe(false)
    expect(() =>
      fed.addAlertRule({ source: 'local', metric: 'm', comparator: 'gt', threshold: 1 }),
    ).toThrow(/not enabled/)
    expect(() => fed.updateAlertRule('x', { threshold: 1 })).toThrow(/not enabled/)
  })

  it('evaluateAlerts returns [] without a sink or with no rules', async () => {
    const bare = createPeerSummaryFederation(stub([], {}), { buildLocal: async () => local })
    expect(await bare.evaluateAlerts()).toEqual([])
    const empty = createPeerSummaryFederation(stub([], {}), {
      buildLocal: async () => local,
      alertRules: makeFakeAlertSink(),
    })
    expect(await empty.evaluateAlerts()).toEqual([])
  })

  it('evaluateAlerts fires on the freshly-built LOCAL summary', async () => {
    const sink = makeFakeAlertSink()
    const fed = createPeerSummaryFederation(stub([], {}), {
      buildLocal: async () => local, // assets.agents = 1
      alertRules: sink,
    })
    fed.addAlertRule({ source: 'local', metric: 'assets.agents', comparator: 'gte', threshold: 1 })
    const breaches = await fed.evaluateAlerts()
    expect(breaches).toHaveLength(1)
    expect(breaches[0]).toMatchObject({ source: 'local', metric: 'assets.agents', value: 1 })
  })

  it('evaluateAlerts fires on a PEER using its last-cached summary (and * spans both)', async () => {
    const sink = makeFakeAlertSink()
    const fed = createPeerSummaryFederation(
      stub([{ peerId: 'p1', label: null, connected: true }], { p1: summaryLink(summaryFor('p1')) }),
      { buildLocal: async () => local, alertRules: sink, now: () => 1 },
    )
    await fed.refresh() // caches p1's summary (assets.agents = 1)
    // A '*' rule evaluates every source — local AND the cached peer both breach.
    fed.addAlertRule({ source: '*', metric: 'assets.agents', comparator: 'gte', threshold: 1 })
    const breaches = await fed.evaluateAlerts()
    expect(breaches.map((b) => b.source).sort()).toEqual(['local', 'p1'])
    expect(breaches.every((b) => b.source !== '*')).toBe(true)
  })

  it('evaluateAlerts skips a peer with no cached summary (never fetched)', async () => {
    const sink = makeFakeAlertSink()
    const fed = createPeerSummaryFederation(
      stub([{ peerId: 'p1', label: null, connected: true }], {}),
      { buildLocal: async () => local, alertRules: sink },
    )
    // No refresh → p1 has no cached summary; a p1-scoped rule has nothing to test.
    fed.addAlertRule({ source: 'p1', metric: 'assets.agents', comparator: 'gte', threshold: 1 })
    expect(await fed.evaluateAlerts()).toEqual([])
  })
})
