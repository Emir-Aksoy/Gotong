/**
 * v5 Stream F cross-hub-agg M4 — cross-hub ALERT AGGREGATION two-hub gate.
 *
 * Stream F day-3 shipped per-hub alert firings; AGG-M1/M2 folded the open-firing
 * COUNT into the privacy-safe PeerSummary (`alerts.openFirings`) and registered
 * it as a trendable + meta-alertable metric. The federation-wide question — "how
 * many alerts are open across all my peers right now?" — then falls out of the
 * existing summary aggregation for free. This gate proves that fall-out is real,
 * and that folding alerting state into the counts-only summary did NOT open a
 * leak. ONE provider hub with REAL open firings, TWO consumer control planes
 * (one shared-with, one not), proving four things at once:
 *
 *   1. real count  — the shared consumer receives the provider's ACTUAL
 *                    open-firing count (3 open, 1 resolved → 3), proving the
 *                    alerts family is genuinely sampled, not hard-zero, AND that
 *                    a RESOLVED firing is excluded (the count is `listOpen`, not
 *                    every firing ever).
 *   2. aggregation — the control plane's federation-wide total is its OWN open
 *                    firings PLUS each shared peer's — a real sum (2 + 3 = 5),
 *                    the exact arithmetic renderAggregate() does in the UI.
 *   3. no leak     — the firing INTERNALS (rule ids, the source peers the
 *                    provider's own rules breached against, metric names, human
 *                    rule labels, thresholds) never cross the wire. The summary
 *                    shape has nowhere to hold one: only a length crosses.
 *   4. opt-in + isolation — the non-shared consumer is fail-closed REFUSED with
 *                    an honest reason, NOT a fabricated `openFirings: 0` that
 *                    would read as "a peer with no alerts firing"; and clamping
 *                    that edge never bleeds onto the shared edge.
 *
 * Harness mirrors peer-summary-e2e.test.ts (E5-M5) verbatim — one real provider
 * Hub + real identity store, consumer driven through the REAL aggregation
 * surface over REAL in-proc HubLinks through the REAL per-link gate. Only the
 * consumer's PeerRegistry is a stub returning the live link.
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
  type PeerRegistration,
} from '@gotong/identity'

import {
  PeerSummaryHost,
  createPeerSummaryFederation,
  denyPeerSummaryRpc,
  type BuildSummaryDeps,
  type PeerSummary,
  type PeerSummaryFederation,
  type SummaryPeerRegistryView,
  type SummaryWorkflowSource,
} from '../src/peer-summary.js'
import type { RpcResponder } from '../src/peer-kb-gate.js'

/** A local participant with no behaviour — it exists only to be counted. */
class NoopAgent extends AgentParticipant {
  protected async handleTask(): Promise<unknown> {
    return { ok: true }
  }
}

const workflowSource: SummaryWorkflowSource = {
  listAll: () => [{ state: 'published' }],
  countRuns: async () => ({ total: 0, byStatus: {} }),
}

/** Realistic provider clock (≈ 2033) so the ledger window's `since` stays >= 0. */
const PROVIDER_NOW = 2_000_000_000_000

function rpcOptsFromRow(
  host: PeerSummaryHost,
  row: PeerRegistration,
): { rpcResponder: RpcResponder } {
  let responder: RpcResponder = host.respond
  if (!row.shareSummary) responder = denyPeerSummaryRpc(responder)
  return { rpcResponder: responder }
}

/**
 * A consumer control plane over one live link. `ownOpenFirings` is the control
 * plane's OWN currently-open alert count — non-zero so the federation aggregate
 * is a genuine sum (local + peers), not a degenerate `0 + peer`.
 */
function consumerFederation(link: HubLink, ownOpenFirings: number): PeerSummaryFederation {
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
    alerts: { openFirings: ownOpenFirings },
  }
  return createPeerSummaryFederation(registry, {
    buildLocal: async () => ownSummary,
    now: () => 2_000_000,
  })
}

/**
 * The control plane's "federation-wide open firings" line — exactly what the UI
 * renderAggregate() computes: local + every peer that actually SHARED a summary.
 * A peer with no summary (not shared / offline) is NOT counted as zero.
 */
function aggregateOpenFirings(
  own: PeerSummary,
  rows: { summary: PeerSummary | null }[],
): { total: number; known: number } {
  let total = own.alerts.openFirings
  let known = 1 // local always counts
  for (const r of rows) {
    if (r.summary) {
      total += r.summary.alerts.openFirings
      known += 1
    }
  }
  return { total, known }
}

describe('cross-hub-agg M4 — federation-wide alert aggregation is opt-in + counts-only', () => {
  let store: IdentityStore
  let tmp: string
  let provider: Hub
  let pairAllowed: ReturnType<typeof createInprocHubLinkPair>
  let pairDenied: ReturnType<typeof createInprocHubLinkPair>

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gotong-peer-alert-agg-e2e-'))
    store = openIdentityStore({
      dbPath: join(tmp, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })

    store.addPeer({
      peerId: 'cp-allowed',
      endpointUrl: 'wss://allowed.example',
      peerToken: 'tok-allowed-12345678',
      kind: 'organization',
      shareSummary: true,
    })
    store.addPeer({
      peerId: 'cp-denied',
      endpointUrl: 'wss://denied.example',
      peerToken: 'tok-denied-12345678',
      kind: 'organization',
      shareSummary: false,
    })

    // Seed the provider's OWN alerting activity: three rules currently breaching
    // against three peers it monitors, plus one that already resolved. Every
    // field here is a leak canary — none may cross to a consumer, which only
    // ever learns the COUNT (3).
    store.openPeerSummaryAlertFiring({
      ruleId: 'asr_secretrule_alpha',
      source: 'secret-peer-alpha',
      metric: 'llm.costMicros',
      comparator: 'gt',
      threshold: 1000,
      value: 9999,
      label: 'private cost alarm ALPHA',
      openedAt: PROVIDER_NOW - 3000,
    })
    store.openPeerSummaryAlertFiring({
      ruleId: 'asr_secretrule_beta',
      source: 'secret-peer-beta',
      metric: 'health.suspendedTasks',
      comparator: 'gte',
      threshold: 5,
      value: 12,
      label: 'private backlog alarm BETA',
      openedAt: PROVIDER_NOW - 2000,
    })
    store.openPeerSummaryAlertFiring({
      ruleId: 'asr_secretrule_gamma',
      source: 'secret-peer-gamma',
      metric: 'alerts.openFirings',
      comparator: 'gt',
      threshold: 0,
      value: 3,
      label: 'private meta alarm GAMMA',
      openedAt: PROVIDER_NOW - 1000,
    })
    // A RESOLVED firing — must NOT be counted (the count is listOpen, not all).
    const resolved = store.openPeerSummaryAlertFiring({
      ruleId: 'asr_secretrule_delta',
      source: 'secret-peer-delta',
      metric: 'llm.tokens',
      comparator: 'gt',
      threshold: 10,
      value: 50,
      label: 'private resolved alarm DELTA',
      openedAt: PROVIDER_NOW - 4000,
    })
    store.resolvePeerSummaryAlertFiring(resolved.id, { resolvedAt: PROVIDER_NOW - 500 })

    provider = Hub.inMemory()
    await provider.start()
    provider.register(new NoopAgent({ id: 'agent-x', capabilities: ['svc'] }))

    const rowAllowed = store.getPeerByPeerId('cp-allowed')!
    const rowDenied = store.getPeerByPeerId('cp-denied')!

    const summaryDeps: BuildSummaryDeps = {
      hubId: 'provider',
      hub: provider,
      peerWrapperIds: () => new Set(['cp-allowed', 'cp-denied']),
      workflows: workflowSource,
      identity: store,
      now: () => PROVIDER_NOW,
    }
    const summaryHost = new PeerSummaryHost(summaryDeps)

    pairAllowed = createInprocHubLinkPair({ aPeerId: 'cp-allowed', bPeerId: 'provider' })
    pairDenied = createInprocHubLinkPair({ aPeerId: 'cp-denied', bPeerId: 'provider' })

    installPeerLink({
      hub: provider,
      link: pairAllowed.a,
      remoteCapabilities: [],
      selfHubId: 'provider',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
      ...rpcOptsFromRow(summaryHost, rowAllowed),
    })
    installPeerLink({
      hub: provider,
      link: pairDenied.a,
      remoteCapabilities: [],
      selfHubId: 'provider',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
      ...rpcOptsFromRow(summaryHost, rowDenied),
    })
  })

  afterEach(async () => {
    store.close()
    await provider.stop()
    await rm(tmp, { recursive: true, force: true })
  })

  it('shared consumer gets the provider REAL open-firing count (resolved excluded) and aggregates it', async () => {
    const fed = consumerFederation(pairAllowed.b, 2)
    await fed.refresh()
    const rows = await fed.list()

    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.peer).toBe('provider')
    expect(row.summary).not.toBeNull()

    // 3 open + 1 resolved seeded → the count is the OPEN ones only.
    expect(row.summary!.alerts.openFirings).toBe(3)

    // Federation-wide aggregate = own (2) + the one shared peer (3) = 5. This is
    // the exact arithmetic the UI's renderAggregate() does, computed here from
    // the real building blocks the consumer received.
    const own = await fed.local()
    const agg = aggregateOpenFirings(own, rows)
    expect(agg.total).toBe(5)
    expect(agg.known).toBe(2) // local + 1 shared peer
  })

  it('no firing internals cross the wire — only the count', async () => {
    const fed = consumerFederation(pairAllowed.b, 2)
    await fed.refresh()
    const rows = await fed.list()

    // The provider's rule ids, the peers ITS rules breached against, metric
    // names, and human labels all exist in its store. None may appear in what
    // crossed — the counts-only shape has nowhere to put them.
    const wire = JSON.stringify(rows[0].summary)
    expect(wire).not.toContain('asr_secretrule')
    expect(wire).not.toContain('secret-peer-alpha')
    expect(wire).not.toContain('secret-peer-beta')
    expect(wire).not.toContain('secret-peer-gamma')
    expect(wire).not.toContain('secret-peer-delta')
    expect(wire).not.toContain('private cost alarm')
    expect(wire).not.toContain('private backlog alarm')
    expect(wire).not.toContain('private meta alarm')
    // The only alerts data present is the scalar count.
    expect(rows[0].summary!.alerts).toEqual({ openFirings: 3 })
  })

  it('non-shared consumer is fail-closed REFUSED — not a fabricated openFirings:0', async () => {
    const fed = consumerFederation(pairDenied.b, 2)
    await fed.refresh()
    const rows = await fed.list()

    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.online).toBe(true)
    // No summary at all — crucially NOT `{ alerts: { openFirings: 0 } }`, which
    // would read as "a connected peer with no alerts firing" and silently
    // undercount the federation. The reason says WHY.
    expect(row.summary).toBeNull()
    expect(row.lastError).toMatch(/not shared/i)

    // And the honest aggregate counts only what was actually shared: local only.
    const own = await fed.local()
    const agg = aggregateOpenFirings(own, rows)
    expect(agg.total).toBe(2) // own 2; the refused peer contributes nothing
    expect(agg.known).toBe(1) // local only — the un-shared peer is NOT counted
  })

  it('per-link isolation — clamping cp-denied never affects cp-allowed', async () => {
    const allowed = consumerFederation(pairAllowed.b, 0)
    const denied = consumerFederation(pairDenied.b, 0)
    await Promise.all([allowed.refresh(), denied.refresh()])
    const [aRows, dRows] = await Promise.all([allowed.list(), denied.list()])

    expect(aRows[0].summary?.alerts.openFirings).toBe(3)
    expect(aRows[0].lastError).toBeNull()
    expect(dRows[0].summary).toBeNull()
    expect(dRows[0].lastError).toMatch(/not shared/i)
  })
})
