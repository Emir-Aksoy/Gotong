/**
 * v5 Stream F-M7 — control-plane TRENDS + ALERTS two-hub acceptance gate.
 *
 * Stream F layers persistent history (trends) + live threshold alerts on top of
 * the E5 counts-only control plane. This gate proves all three Stream F claims
 * end-to-end against a REAL provider hub over a REAL in-proc link, with the
 * consumer's history + rule storage backed by a REAL IdentityStore (its own —
 * the provider's store is the other hub's):
 *
 *   1. trends   — two refreshes of the same source produce TWO chronological
 *                 history points; when the provider's real footprint changes
 *                 between them (an agent joins), the trend reflects it (2 → 3).
 *                 Both the local footprint AND the peer are captured per refresh.
 *   2. alerts   — rules evaluate LIVE against the current summaries: a breaching
 *                 rule fires on the ACTUAL source (never the `'*'` wildcard), a
 *                 non-breaching rule stays silent, a disabled rule stops firing,
 *                 and rule CRUD through the federation surface persists.
 *   3. no leak  — the persisted snapshot blobs AND the breach payloads carry
 *                 ONLY counts: the provider's agent ids / capabilities / parked
 *                 task id / model name never appear (the F path inherits E5's
 *                 counts-only shape — this re-pins it on the persistence path).
 *
 * Topology mirrors `peer-summary-e2e.test.ts` (the E5-M5 gate): ONE real
 * provider Hub (+ real identity store seeded with a real footprint), ONE consumer
 * control plane driven through the REAL aggregation surface over a REAL in-proc
 * HubLink. Only the consumer's PeerRegistry is a stub returning the live link —
 * the same lean pattern the E5 / stream-c gates use. The new piece is the
 * consumer's OWN IdentityStore wired as both the snapshot sink and the alert-rule
 * sink (duck-typed — exact method-name match, no host↔identity dep).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AgentParticipant,
  Hub,
  createInprocHubLinkPair,
  installPeerLink,
  type HubLink,
} from '@gotong/core'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@gotong/identity'

import {
  PeerSummaryHost,
  createPeerSummaryFederation,
  type BuildSummaryDeps,
  type PeerSummary,
  type PeerSummaryFederation,
  type SummaryPeerRegistryView,
  type SummaryWorkflowSource,
} from '../src/peer-summary.js'

/** A local participant with no behaviour — it exists only to be counted. */
class NoopAgent extends AgentParticipant {
  protected async handleTask(): Promise<unknown> {
    return { ok: true }
  }
}

/** Deterministic provider footprint for the workflow family (counts only). */
const workflowSource: SummaryWorkflowSource = {
  listAll: () => [{ state: 'published' }, { state: 'draft' }],
  countRuns: async () => ({ total: 3, byStatus: { running: 1, done: 2 } }),
}

/** A fixed, realistic provider clock (≈ 2033) — see the E5-M5 gate for why. */
const PROVIDER_NOW = 2_000_000_000_000

/**
 * The consumer control plane's federation surface over one live link, with its
 * OWN IdentityStore wired as the snapshot + alert-rule backing. The consumer's
 * own footprint is a fixed trivial summary (not under test here).
 */
function consumerFederation(
  link: HubLink,
  consumerStore: IdentityStore,
  now: () => number,
): PeerSummaryFederation {
  const registry: SummaryPeerRegistryView = {
    status: () => [{ peerId: 'provider', label: 'Provider Hub', connected: true }],
    linkForHub: (peerId) => (peerId === 'provider' ? link : null),
  }
  const ownSummary: PeerSummary = {
    hubId: 'control-plane',
    protocolVersion: '1',
    generatedAt: 0,
    assets: { agents: 0, workflows: 0, publishedWorkflows: 0, peers: 1 },
    runs: { total: 0, byStatus: {} },
    llm: { windowDays: 30, calls: 0, tokens: 0, costMicros: 0 },
    health: { suspendedTasks: 0 },
    alerts: { openFirings: 0 },
  }
  return createPeerSummaryFederation(registry, {
    buildLocal: async () => ownSummary,
    // The host backs both sinks with one IdentityStore (duck-typed).
    snapshots: consumerStore,
    alertRules: consumerStore,
    now,
  })
}

describe('v5 Stream F-M7 — control-plane trends + alerts over two hubs', () => {
  let providerStore: IdentityStore
  let consumerStore: IdentityStore
  let tmp: string
  let provider: Hub
  let pair: ReturnType<typeof createInprocHubLinkPair>
  // The consumer's clock advances per refresh so two snapshots get distinct
  // capturedAt — a trend reads left-to-right by capture time.
  let consumerClock: number

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gotong-stream-f-e2e-'))
    providerStore = openIdentityStore({
      dbPath: join(tmp, 'provider.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
    consumerStore = openIdentityStore({
      dbPath: join(tmp, 'consumer.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
    consumerClock = 1_000_000

    // The provider shares its summary with this consumer (opt-in, fail-closed).
    providerStore.addPeer({
      peerId: 'control-plane',
      endpointUrl: 'wss://cp.example',
      peerToken: 'tok-cp-1234567890',
      kind: 'organization',
      shareSummary: true,
    })

    // Seed a REAL footprint so llm + health are non-zero (proving they're sampled,
    // not hard-zero). The agent id / model / task id are the no-leak canaries.
    providerStore.appendLedger({
      ts: PROVIDER_NOW,
      agentId: 'agent-secret-alpha',
      model: 'claude-secret-x',
      inputTokens: 100,
      outputTokens: 50,
      costMicros: 7000,
    })
    providerStore.persistSuspendedTask({
      taskId: 'parked-secret-1',
      agentId: 'agent-secret-alpha',
      resumeAt: 9_999_999_999_000,
      state: {},
      taskJson: '{}',
    })

    provider = Hub.inMemory()
    await provider.start()
    provider.register(
      new NoopAgent({ id: 'agent-secret-alpha', capabilities: ['confidential-svc'] }),
    )
    provider.register(
      new NoopAgent({ id: 'agent-secret-beta', capabilities: ['confidential-svc-2'] }),
    )

    const summaryDeps: BuildSummaryDeps = {
      hubId: 'provider',
      hub: provider,
      // The consumer wrapper id is the peer id, excluded so the agent count is
      // the two (then three) local agents only.
      peerWrapperIds: () => new Set(['control-plane']),
      workflows: workflowSource,
      identity: providerStore,
      now: () => PROVIDER_NOW,
    }
    const summaryHost = new PeerSummaryHost(summaryDeps)

    pair = createInprocHubLinkPair({ aPeerId: 'control-plane', bPeerId: 'provider' })
    // Provider edge: the row opted into sharing, so the un-gated summary host
    // responds directly (no deny gate). One shared link is all Stream F needs;
    // the deny/per-link-isolation axis is the E5-M5 gate's job.
    installPeerLink({
      hub: provider,
      link: pair.a,
      remoteCapabilities: [],
      selfHubId: 'provider',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
      rpcResponder: summaryHost.respond,
    })
  })

  afterEach(async () => {
    providerStore.close()
    consumerStore.close()
    await provider.stop()
    await rm(tmp, { recursive: true, force: true })
  })

  it('trend: two refreshes capture two chronological points — and reflect a real footprint change', async () => {
    const fed = consumerFederation(pair.b, consumerStore, () => consumerClock)

    // metricKeys() is the canonical trendable set the UI dropdown reads.
    expect(fed.metricKeys()).toContain('assets.agents')
    expect(fed.metricKeys()).toContain('health.suspendedTasks')

    // Refresh #1 — provider has 2 agents.
    consumerClock = 1_000_000
    await fed.refresh()

    // A real footprint change between refreshes: a third agent joins the provider.
    provider.register(
      new NoopAgent({ id: 'agent-secret-gamma', capabilities: ['confidential-svc-3'] }),
    )

    // Refresh #2 — provider now has 3 agents, captured at a later instant.
    consumerClock = 1_001_000
    await fed.refresh()

    // The provider trend has two points, chronological, reflecting 2 → 3.
    const trend = await fed.history({ source: 'provider', metric: 'assets.agents' })
    expect(trend).toHaveLength(2)
    expect(trend[0]).toEqual({ capturedAt: 1_000_000, value: 2 })
    expect(trend[1]).toEqual({ capturedAt: 1_001_000, value: 3 })

    // The local footprint is captured every refresh too (its own trend).
    const localTrend = await fed.history({ source: 'local', metric: 'assets.peers' })
    expect(localTrend).toHaveLength(2)
    expect(localTrend.map((p) => p.capturedAt)).toEqual([1_000_000, 1_001_000])

    // An unknown metric key yields no points rather than throwing.
    const empty = await fed.history({ source: 'provider', metric: 'nope.nonexistent' })
    expect(empty).toEqual([])
  })

  it('alerts: rules fire LIVE on the actual source; disable stops firing; CRUD persists', async () => {
    const fed = consumerFederation(pair.b, consumerStore, () => consumerClock)
    await fed.refresh() // cache the provider summary (2 agents, 1 suspended task)

    // Three rules: one breaches on the provider, one never breaches, one wildcard.
    const agentsRule = fed.addAlertRule({
      source: 'provider',
      metric: 'assets.agents',
      comparator: 'gte',
      threshold: 2,
      label: '太多 agent',
    })
    fed.addAlertRule({ source: 'provider', metric: 'runs.total', comparator: 'gt', threshold: 999 })
    fed.addAlertRule({ source: '*', metric: 'health.suspendedTasks', comparator: 'gte', threshold: 1 })

    // CRUD persisted through the surface into the consumer store.
    expect(fed.listAlertRules()).toHaveLength(3)
    expect(consumerStore.listPeerSummaryAlertRules()).toHaveLength(3)

    const breaches = await fed.evaluateAlerts()
    // Exactly two fire: provider assets.agents (gte 2) and provider
    // health.suspendedTasks (via '*', matched to the provider source).
    expect(breaches).toHaveLength(2)
    const byMetric = new Map(breaches.map((b) => [b.metric, b]))

    const agentsBreach = byMetric.get('assets.agents')!
    expect(agentsBreach.source).toBe('provider')
    expect(agentsBreach.value).toBe(2)
    expect(agentsBreach.threshold).toBe(2)
    expect(agentsBreach.comparator).toBe('gte')
    expect(agentsBreach.label).toBe('太多 agent')

    const suspBreach = byMetric.get('health.suspendedTasks')!
    // The breach carries the ACTUAL source it fired on — never the '*' wildcard.
    expect(suspBreach.source).toBe('provider')
    expect(suspBreach.value).toBe(1)

    // The non-breaching rule stayed silent.
    expect(breaches.some((b) => b.metric === 'runs.total')).toBe(false)

    // Disabling the agents rule stops it firing (and updates the store).
    fed.updateAlertRule(agentsRule.id, { enabled: false })
    expect(consumerStore.getPeerSummaryAlertRule(agentsRule.id)!.enabled).toBe(false)
    const afterDisable = await fed.evaluateAlerts()
    expect(afterDisable.some((b) => b.metric === 'assets.agents')).toBe(false)
    expect(afterDisable).toHaveLength(1) // only the suspended-tasks breach remains

    // Removal persists.
    expect(fed.removeAlertRule(agentsRule.id)).toBe(true)
    expect(fed.listAlertRules()).toHaveLength(2)
  })

  it('no leak: persisted snapshots and breach payloads carry only counts', async () => {
    const fed = consumerFederation(pair.b, consumerStore, () => consumerClock)
    await fed.refresh()

    // The persisted provider snapshot is the counts-only summary blob — none of
    // the provider's internal identifiers may appear in what got stored.
    const snaps = consumerStore.listPeerSummarySnapshots({ source: 'provider' })
    expect(snaps.length).toBeGreaterThanOrEqual(1)
    for (const snap of snaps) {
      expect(snap.summaryJson).not.toContain('agent-secret-alpha')
      expect(snap.summaryJson).not.toContain('agent-secret-beta')
      expect(snap.summaryJson).not.toContain('confidential-svc')
      expect(snap.summaryJson).not.toContain('parked-secret-1')
      expect(snap.summaryJson).not.toContain('claude-secret-x')
      // But the real counts ARE there (proving it's a genuine summary, not empty).
      const parsed = JSON.parse(snap.summaryJson) as PeerSummary
      expect(parsed.assets.agents).toBe(2)
      expect(parsed.health.suspendedTasks).toBe(1)
    }

    // The breach payload likewise carries only the rule + count, no identifiers.
    fed.addAlertRule({ source: 'provider', metric: 'health.suspendedTasks', comparator: 'gte', threshold: 1 })
    const breaches = await fed.evaluateAlerts()
    expect(breaches).toHaveLength(1)
    const wire = JSON.stringify(breaches)
    expect(wire).not.toContain('agent-secret-alpha')
    expect(wire).not.toContain('parked-secret-1')
    expect(wire).not.toContain('claude-secret-x')
  })
})
