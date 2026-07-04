/**
 * v5 E5-M5 — cross-hub control plane two-hub acceptance gate.
 *
 * The free-graph control plane invariant: a sovereign hub exposes a
 * privacy-safe, COUNTS-ONLY summary to a peer ONLY when it opted into sharing
 * with THAT peer (per-link `share_summary`, identity v23), and the counts carry
 * no raw rows. Mirrors the stream-c isolation gate's shape — ONE provider hub,
 * TWO consumer control planes, one shared-with and one not — and proves three
 * things at once:
 *
 *   1. opt-in  — the shared consumer aggregates the provider's REAL counts; the
 *                non-shared consumer is fail-closed REFUSED with an honest
 *                "not shared" reason (NOT fabricated zeros that would read as a
 *                healthy-but-empty hub).
 *   2. no leak — the shared consumer's received summary contains ONLY counts:
 *                the provider's agent ids / capabilities / task ids / model
 *                names never cross the wire (the shape has nowhere to hold one).
 *   3. per-link isolation — denying cp-denied never affects cp-allowed; a clamp
 *                on one edge of the free graph does not bleed onto another.
 *
 * Topology: ONE real provider Hub (+ real identity store seeded with a real
 * footprint). The consumer side is driven through the REAL aggregation surface
 * (`createPeerSummaryFederation`) over REAL in-proc HubLinks, through the REAL
 * per-link gate (`denyPeerSummaryRpc`, threaded the verbatim PeerRegistry
 * `gatedRpcResponder` way). So every wire-crossing component is real; only the
 * consumer's PeerRegistry is a stub returning the live link — the same lean
 * pattern the stream-c / peer-isolation gates use.
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

/** Deterministic provider footprint for the workflow family (counts only). */
const workflowSource: SummaryWorkflowSource = {
  listAll: () => [{ state: 'published' }, { state: 'draft' }],
  countRuns: async () => ({ total: 3, byStatus: { running: 1, done: 2 } }),
}

/**
 * A fixed but REALISTIC provider clock (≈ 2033). `buildLocalSummary` derives the
 * ledger window as `now - windowDays*DAY_MS`, and `aggregateLedger` rejects a
 * negative `since` — so the injected clock must exceed the 30-day window (a
 * production clock always does). The seeded ledger row is stamped at the same
 * instant so it lands inside the window.
 */
const PROVIDER_NOW = 2_000_000_000_000

/**
 * Thread a peer row into the rpc responder the verbatim PeerRegistry
 * `gatedRpcResponder` way (summary dimension): the summary host is the inner
 * responder, wrapped in the deny-gate ONLY when the row did NOT opt into
 * sharing — fail-closed by omission of the share.
 */
function rpcOptsFromRow(
  host: PeerSummaryHost,
  row: PeerRegistration,
): { rpcResponder: RpcResponder } {
  let responder: RpcResponder = host.respond
  if (!row.shareSummary) responder = denyPeerSummaryRpc(responder)
  return { rpcResponder: responder }
}

/** A consumer control plane's federation surface over one live link. */
function consumerFederation(link: HubLink): PeerSummaryFederation {
  const registry: SummaryPeerRegistryView = {
    status: () => [{ peerId: 'provider', label: 'Provider Hub', connected: true }],
    linkForHub: (peerId) => (peerId === 'provider' ? link : null),
  }
  // The consumer's OWN footprint is not under test — a trivial zero summary.
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
    now: () => 2_000_000,
  })
}

describe('v5 E5-M5 — cross-hub control plane summary is per-link opt-in + counts-only', () => {
  let store: IdentityStore
  let tmp: string
  let provider: Hub
  let pairAllowed: ReturnType<typeof createInprocHubLinkPair>
  let pairDenied: ReturnType<typeof createInprocHubLinkPair>

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gotong-peer-summary-e2e-'))
    store = openIdentityStore({
      dbPath: join(tmp, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })

    // Two consumer control planes: one the provider shares with, one it doesn't.
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

    // Seed a REAL footprint into the provider's identity store so the llm +
    // health families are non-zero (proving they are actually sampled, not
    // hard-zero). The agent id / model name here are the leak canaries below.
    store.appendLedger({
      ts: PROVIDER_NOW,
      agentId: 'agent-secret-alpha',
      model: 'claude-secret-x',
      inputTokens: 100,
      outputTokens: 50,
      costMicros: 7000,
    })
    store.persistSuspendedTask({
      taskId: 'parked-secret-1',
      agentId: 'agent-secret-alpha',
      resumeAt: 9_999_999_999_000,
      state: {},
      taskJson: '{}',
    })

    provider = Hub.inMemory()
    await provider.start()
    provider.register(new NoopAgent({ id: 'agent-secret-alpha', capabilities: ['confidential-svc'] }))
    provider.register(new NoopAgent({ id: 'agent-secret-beta', capabilities: ['confidential-svc-2'] }))

    const rowAllowed = store.getPeerByPeerId('cp-allowed')!
    const rowDenied = store.getPeerByPeerId('cp-denied')!

    const summaryDeps: BuildSummaryDeps = {
      hubId: 'provider',
      hub: provider,
      // Mirror main.ts: wrapper participant ids ARE the peer ids, excluded so
      // the agent count is the two local agents only.
      peerWrapperIds: () => new Set(['cp-allowed', 'cp-denied']),
      workflows: workflowSource,
      identity: store,
      now: () => PROVIDER_NOW,
    }
    const summaryHost = new PeerSummaryHost(summaryDeps)

    pairAllowed = createInprocHubLinkPair({ aPeerId: 'cp-allowed', bPeerId: 'provider' })
    pairDenied = createInprocHubLinkPair({ aPeerId: 'cp-denied', bPeerId: 'provider' })

    // Provider edges: each carries the per-link summary gate from its row.
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

  it('shared consumer aggregates the provider REAL counts — and the wire carries no raw rows', async () => {
    const fed = consumerFederation(pairAllowed.b)
    await fed.refresh()
    const rows = await fed.list()

    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.peer).toBe('provider')
    expect(row.online).toBe(true)
    expect(row.lastError).toBeNull()
    expect(row.summary).not.toBeNull()

    const s = row.summary!
    expect(s.hubId).toBe('provider')
    expect(s.generatedAt).toBe(PROVIDER_NOW) // the provider's injected clock = freshness signal
    expect(s.assets).toEqual({ agents: 2, workflows: 2, publishedWorkflows: 1, peers: 2 })
    expect(s.runs).toEqual({ total: 3, byStatus: { running: 1, done: 2 } })
    expect(s.llm.calls).toBe(1)
    expect(s.llm.tokens).toBe(150) // 100 input + 50 output
    expect(s.llm.costMicros).toBe(7000)
    expect(s.health.suspendedTasks).toBe(1)

    // No-leak: the counts-only shape must carry zero identifiers. The provider's
    // agent ids, capabilities, parked task id, and model name all exist in its
    // store — none may appear anywhere in what crossed the wire.
    const wire = JSON.stringify(row.summary)
    expect(wire).not.toContain('agent-secret-alpha')
    expect(wire).not.toContain('agent-secret-beta')
    expect(wire).not.toContain('confidential-svc')
    expect(wire).not.toContain('parked-secret-1')
    expect(wire).not.toContain('claude-secret-x')
  })

  it('non-shared consumer is fail-closed REFUSED with an honest reason (not zeros)', async () => {
    const fed = consumerFederation(pairDenied.b)
    await fed.refresh()
    const rows = await fed.list()

    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.peer).toBe('provider')
    expect(row.online).toBe(true)
    // The gate rejected the fetch: no counts, and the reason says WHY — so the
    // control plane never mistakes "not shared" for "an empty, healthy hub".
    expect(row.summary).toBeNull()
    expect(row.lastError).toMatch(/not shared/i)
  })

  it('per-link isolation — clamping cp-denied never affects cp-allowed (free graph)', async () => {
    // Both consumers read the SAME provider concurrently; the deny on one edge
    // must not bleed onto the other.
    const allowed = consumerFederation(pairAllowed.b)
    const denied = consumerFederation(pairDenied.b)
    await Promise.all([allowed.refresh(), denied.refresh()])
    const [aRows, dRows] = await Promise.all([allowed.list(), denied.list()])

    expect(aRows[0].summary?.assets.agents).toBe(2)
    expect(aRows[0].lastError).toBeNull()
    expect(dRows[0].summary).toBeNull()
    expect(dRows[0].lastError).toMatch(/not shared/i)
  })
})
