/**
 * Peer summary — PROVIDER + consumer + per-link gate (v5 Stream E5).
 *
 * The free-graph "control plane" (控制面): a hub asks a connected peer for a
 * privacy-safe OVERVIEW of its footprint over the same authenticated HubLink
 * rpc seam that already carries cross-hub MCP (`mcp-proxy.ts`) and the
 * capability manifest (`peer-manifest.ts`). The peer answers with COUNTS only —
 * never raw rows, names, payloads, or user/credential material — so an operator
 * watching many sovereign hubs sees aggregate health WITHOUT any hub being
 * absorbed into a platform tenant (North Star: the hub network is a free graph,
 * not a hierarchy — a control plane observes, it never owns).
 *
 * Why this is gated when `peer.manifest` is not: a manifest discloses only
 * capability NAMES an authenticated peer could already dispatch (it learns
 * nothing new), but a summary discloses ACTIVITY VOLUME. So sharing is OPT-IN
 * per link and FAIL-CLOSED: the per-link gate (`denyPeerSummaryRpc`, applied by
 * peer-registry) rejects `peer.summary` unless the peer row's `share_summary`
 * flag (identity v23) is set. A hub that never flips it leaks nothing.
 *
 * Wire contract — one method:
 *
 *   peer.summary { }  → PeerSummary
 *
 * The link is authenticated (peerToken); this is mesh-internal aggregation, not
 * the public `/.well-known/agent-card.json`.
 */

import type { HubLink, Participant, ParticipantId } from '@aipehub/core'
import type {
  AddPeerSummaryAlertRuleInput,
  PeerSummaryAlertRule,
  UpdatePeerSummaryAlertRuleInput,
} from '@aipehub/identity'
import type { RpcResponder } from './peer-kb-gate.js'
import {
  PEER_SUMMARY_METRIC_KEYS,
  buildPeerSummaryTrend,
  type PeerSummaryTrendPoint,
} from './peer-summary-metrics.js'
import {
  evaluatePeerSummaryAlerts,
  type PeerSummaryAlertBreach,
  type PeerSummarySource,
} from './peer-summary-alerts.js'

/** Wire method names for the peer summary (shared producer/consumer). */
export const PEER_SUMMARY_METHODS = {
  get: 'peer.summary',
} as const

/**
 * The summary schema version. Bumps when `PeerSummary` changes shape so a
 * consumer can reason about an older peer's reply. Independent of the peer
 * MANIFEST version and the A2A protocol version — this is the control plane's
 * own contract.
 */
export const PEER_SUMMARY_VERSION = '1'

/** Trailing window (days) the LLM-usage roll-up covers when none is configured. */
const DEFAULT_WINDOW_DAYS = 30
const DAY_MS = 86_400_000

/**
 * A peer's privacy-safe footprint — COUNTS ONLY. Every field is a number or a
 * map of numbers; there is deliberately no place to put a name, id, payload, or
 * any per-row datum. That invariant is the privacy contract: the producer
 * cannot accidentally leak a row because the shape has nowhere to hold one.
 */
export interface PeerSummary {
  /** The advertising hub's self id (== `orgId` on the federation wire). */
  hubId: string
  /** `PEER_SUMMARY_VERSION` at emit time. */
  protocolVersion: string
  /**
   * Epoch ms the summary was built — the ONLY freshness signal. The producer
   * emits no per-row timestamps, so a consumer reasons about staleness from
   * this alone (and its own fetch time).
   */
  generatedAt: number
  /** Point-in-time asset counts. */
  assets: {
    /** Locally-owned participants (excludes installed peer wrappers). */
    agents: number
    /** Workflow definitions across all lifecycle states. */
    workflows: number
    /** Of those, how many are currently `published`. */
    publishedWorkflows: number
    /** Configured federation peers. */
    peers: number
  }
  /** Point-in-time tally over the ACTIVE run set (not windowed). */
  runs: {
    total: number
    /** Counts keyed by run status (running/done/failed/cancelled). */
    byStatus: Record<string, number>
  }
  /** LLM usage aggregated over the trailing `windowDays`. */
  llm: {
    windowDays: number
    calls: number
    /** input + output + cache-creation + cache-read tokens. */
    tokens: number
    /** Integer micro-USD (1e6 == $1), mirroring the usage ledger. */
    costMicros: number
  }
  /** Operational health gauges. */
  health: {
    /** Parked tasks awaiting resume (includes NEVER_RESUME_AT human/approval items). */
    suspendedTasks: number
  }
}

// ─── producer side ──────────────────────────────────────────────────────────

/** The slice of `Hub` that `buildLocalSummary` reads (tests inject a stub). */
export interface SummaryHubView {
  participants(): Participant[]
}

/** Narrow projection of the workflow controller — list + run tally. */
export interface SummaryWorkflowSource {
  listAll?(): Promise<Array<{ state?: string }>> | Array<{ state?: string }>
  countRuns?(opts?: {
    workflowId?: string
  }): Promise<{ total: number; byStatus: Record<string, number> }>
}

/** Narrow projection of one `aggregateLedger` row (mirrors the ledger DTO). */
export interface SummaryLedgerRow {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costMicros: number
}

/** Narrow projection of `IdentityStore` — the read methods the summary samples. */
export interface SummaryIdentitySource {
  countSuspendedTasks?(): number
  aggregateLedger?(query: {
    groupBy: 'model'
    since?: number
    until?: number
  }): SummaryLedgerRow[]
  listPeers?(): unknown[]
}

export interface BuildSummaryDeps {
  /** This hub's self id (stamped as `PeerSummary.hubId`). */
  hubId: string
  hub: SummaryHubView
  /**
   * Installed peer-wrapper ids to exclude from the agent count — a thunk so it
   * reflects the registry's CURRENT peers on every call (mirrors the manifest).
   */
  peerWrapperIds: () => ReadonlySet<ParticipantId>
  workflows?: SummaryWorkflowSource
  identity?: SummaryIdentitySource
  /** LLM-usage window in days (default 30). */
  windowDays?: number
  now?: () => number
}

/**
 * Aggregate this hub's privacy-safe footprint. EVERY family is best-effort,
 * exactly like `collectBusinessMetrics`: a source the host didn't wire, a method
 * an older host lacks, or a call that throws leaves that family at its zero
 * default rather than rejecting the whole summary. The stable shape (no omitted
 * keys) keeps the consumer's aggregation trivial.
 */
export async function buildLocalSummary(deps: BuildSummaryDeps): Promise<PeerSummary> {
  const now = deps.now ?? (() => Date.now())
  const windowDays =
    deps.windowDays && deps.windowDays > 0 ? deps.windowDays : DEFAULT_WINDOW_DAYS
  const generatedAt = now()

  const summary: PeerSummary = {
    hubId: deps.hubId,
    protocolVersion: PEER_SUMMARY_VERSION,
    generatedAt,
    assets: { agents: 0, workflows: 0, publishedWorkflows: 0, peers: 0 },
    runs: { total: 0, byStatus: {} },
    llm: { windowDays, calls: 0, tokens: 0, costMicros: 0 },
    health: { suspendedTasks: 0 },
  }

  // --- assets.agents — local participants minus peer wrappers (mirror manifest)
  try {
    const wrappers = deps.peerWrapperIds()
    let n = 0
    for (const p of deps.hub.participants()) if (!wrappers.has(p.id)) n++
    summary.assets.agents = n
  } catch {
    // leave 0
  }

  // --- assets.workflows / publishedWorkflows ---------------------------------
  const wf = deps.workflows
  if (wf && typeof wf.listAll === 'function') {
    try {
      const all = await wf.listAll()
      summary.assets.workflows = all.length
      summary.assets.publishedWorkflows = all.filter((w) => w?.state === 'published').length
    } catch {
      // leave 0
    }
  }

  // --- assets.peers ----------------------------------------------------------
  const id = deps.identity
  if (id && typeof id.listPeers === 'function') {
    try {
      summary.assets.peers = id.listPeers().length
    } catch {
      // leave 0
    }
  }

  // --- runs (point-in-time active-set tally) ---------------------------------
  if (wf && typeof wf.countRuns === 'function') {
    try {
      const { total, byStatus } = await wf.countRuns()
      summary.runs = { total, byStatus }
    } catch {
      // leave 0 / {}
    }
  }

  // --- llm window ------------------------------------------------------------
  if (id && typeof id.aggregateLedger === 'function') {
    try {
      const since = generatedAt - windowDays * DAY_MS
      const rows = id.aggregateLedger({ groupBy: 'model', since })
      let calls = 0
      let tokens = 0
      let costMicros = 0
      for (const r of rows) {
        calls += r.calls
        tokens += r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens
        costMicros += r.costMicros
      }
      summary.llm = { windowDays, calls, tokens, costMicros }
    } catch {
      // leave 0s
    }
  }

  // --- health ----------------------------------------------------------------
  if (id && typeof id.countSuspendedTasks === 'function') {
    try {
      summary.health.suspendedTasks = id.countSuspendedTasks()
    } catch {
      // leave 0
    }
  }

  return summary
}

export class PeerSummaryHost {
  private readonly deps: BuildSummaryDeps

  constructor(deps: BuildSummaryDeps) {
    this.deps = deps
  }

  /**
   * Bound `rpcResponder` fragment, composed onto the host's single rpcResponder
   * alongside the MCP proxy + manifest host. A throw here surfaces as an rpc
   * rejection on the calling peer.
   */
  readonly respond = async (call: {
    method: string
    params: unknown
  }): Promise<unknown> => {
    switch (call.method) {
      case PEER_SUMMARY_METHODS.get:
        return buildLocalSummary(this.deps)
      default:
        throw new Error(`unknown peer summary method '${call.method}'`)
    }
  }
}

// ─── per-link gate ──────────────────────────────────────────────────────────

/**
 * v5 E5 — the per-link summary gate (pure function, like `gateKnowledgeBaseRpc`).
 * Wrap `inner` so `peer.summary` is DENIED (throws → rpc rejection on the
 * caller) while every other method passes through untouched. The peer-registry
 * applies this ONLY when the row has NOT opted into sharing (`share_summary`
 * false / unset), so the default — and any link that never flips the flag — is
 * fail-closed by omission of the share.
 */
export function denyPeerSummaryRpc(inner: RpcResponder): RpcResponder {
  return async (call) => {
    if (call.method === PEER_SUMMARY_METHODS.get) {
      throw new Error('peer summary is not shared by this peer')
    }
    return inner(call)
  }
}

// ─── consumer side ──────────────────────────────────────────────────────────

/**
 * Coerce a peer's reply into a well-formed `PeerSummary`, defending against a
 * hostile / older peer: every numeric field falls back to 0, unknown
 * `byStatus` keys are kept but their values coerced. The aggregating surface
 * (E5-M3) can sum these without per-peer guards.
 */
export function normalizePeerSummary(raw: unknown): PeerSummary {
  const o = (raw ?? {}) as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

  const assets = obj(o.assets)
  const runs = obj(o.runs)
  const llm = obj(o.llm)
  const health = obj(o.health)

  const byStatus: Record<string, number> = {}
  for (const [k, v] of Object.entries(obj(runs.byStatus))) byStatus[k] = num(v)

  return {
    hubId: typeof o.hubId === 'string' ? o.hubId : '',
    protocolVersion:
      typeof o.protocolVersion === 'string' ? o.protocolVersion : PEER_SUMMARY_VERSION,
    generatedAt: num(o.generatedAt),
    assets: {
      agents: num(assets.agents),
      workflows: num(assets.workflows),
      publishedWorkflows: num(assets.publishedWorkflows),
      peers: num(assets.peers),
    },
    runs: { total: num(runs.total), byStatus },
    llm: {
      windowDays: num(llm.windowDays),
      calls: num(llm.calls),
      tokens: num(llm.tokens),
      costMicros: num(llm.costMicros),
    },
    health: { suspendedTasks: num(health.suspendedTasks) },
  }
}

/**
 * Discovery (consumer side): ask a peer hub over its link for its summary. Thin
 * wrapper over the `peer.summary` rpc — the caller decides what to do when the
 * link is closed, the call rejects (e.g. the peer hasn't opted into sharing →
 * the gate throws), or an older peer lacks the method. Returns `null` when the
 * peer answers nothing.
 */
export async function fetchPeerSummary(link: HubLink): Promise<PeerSummary | null> {
  const out = await link.rpc(PEER_SUMMARY_METHODS.get, {})
  if (!out || typeof out !== 'object') return null
  return normalizePeerSummary(out)
}

// ─── federation surface (host → admin UI, v5 E5-M3) ─────────────────────────

/** The slice of the host `PeerRegistry` the federation surface reads. */
export interface SummaryPeerRegistryView {
  status(): Array<{ peerId: ParticipantId; label: string | null; connected: boolean }>
  linkForHub(peerId: ParticipantId): HubLink | null
}

/** One peer's summary row served to the admin control plane (web mirrors this shape). */
export interface PeerSummaryRow {
  /** Peer hub id. */
  peer: string
  /** Human label from the peers table, if any. */
  label: string | null
  /** Whether the peer link is connected right now. */
  online: boolean
  /** A cached summary exists but the peer is offline — its counts may be stale. */
  stale: boolean
  /** Last fetched summary (counts only), or null when never fetched / unavailable. */
  summary: PeerSummary | null
  /** Epoch ms of the last successful summary fetch, or null if never. */
  lastFetchedAt: number | null
  /**
   * Why the last refresh failed, or null on success / never-tried. The control
   * plane shows this to distinguish "peer offline" from "peer hasn't opted into
   * sharing" (the gate rejects with `not shared by this peer`) — the opt-in is
   * the whole point, so the UI must be able to surface it honestly.
   */
  lastError: string | null
}

/**
 * Persistent snapshot sink (v5 Stream F) — the control plane's HISTORY backing.
 * Duck-typed so the host backs it with `IdentityStore`
 * (`appendPeerSummarySnapshot` / `listPeerSummarySnapshots`) while peer-summary
 * keeps zero identity dep. COUNTS-ONLY: it stores the same `PeerSummary` blob
 * the live cache holds, just stamped + persisted. Optional — without it the
 * control plane is point-in-time only (the E5 behaviour).
 */
export interface PeerSummarySnapshotSink {
  appendPeerSummarySnapshot(input: {
    capturedAt?: number
    source: string
    summaryJson: string
  }): unknown
  listPeerSummarySnapshots(query: {
    source?: string
    since?: number
    until?: number
    limit?: number
  }): Array<{ capturedAt: number; summaryJson: string }>
}

/**
 * Alert-rule store (v5 Stream F-M5) — the rules the control plane evaluates LIVE
 * against the current summaries. Duck-typed so the host backs it with
 * `IdentityStore` (the four method names mirror it exactly) while peer-summary
 * keeps zero identity RUNTIME dep — only the input/output TYPES are imported, and
 * those are erased. Optional: without it the federation reports no rules and no
 * breaches (the F-M4 evaluator is a pure function; this just feeds it).
 */
export interface PeerSummaryAlertRuleSink {
  listPeerSummaryAlertRules(): PeerSummaryAlertRule[]
  addPeerSummaryAlertRule(input: AddPeerSummaryAlertRuleInput): PeerSummaryAlertRule
  updatePeerSummaryAlertRule(id: string, patch: UpdatePeerSummaryAlertRuleInput): PeerSummaryAlertRule
  removePeerSummaryAlertRule(id: string): boolean
}

/** A history query: one source's trend of one scalar metric over a window. */
export interface PeerSummaryHistoryQuery {
  /** `'local'` or a peer id. */
  source: string
  /** A `PEER_SUMMARY_METRIC_KEYS` dotted key (e.g. `health.suspendedTasks`). */
  metric: string
  since?: number
  until?: number
  limit?: number
}

export interface PeerSummaryFederation {
  /** The host's OWN footprint — the control plane always shows local first. */
  local(): Promise<PeerSummary>
  /** Join the registry's live connection state with the summary cache. */
  list(): Promise<PeerSummaryRow[]>
  /** Refetch `peer.summary` from connected peers (all, or one by id). */
  refresh(peerId?: string): Promise<void>
  /**
   * Trend one scalar metric for one source over a window (v5 Stream F). Reads
   * persisted snapshots; returns `[]` when no snapshot sink is wired.
   */
  history(query: PeerSummaryHistoryQuery): Promise<PeerSummaryTrendPoint[]>
  /** The canonical trendable metric keys — single source for the UI dropdown. */
  metricKeys(): string[]
  /** List the configured alert rules (v5 Stream F-M5); `[]` when unwired. */
  listAlertRules(): PeerSummaryAlertRule[]
  /** Create an alert rule. Throws (→ store error) when no rule sink is wired. */
  addAlertRule(input: AddPeerSummaryAlertRuleInput): PeerSummaryAlertRule
  /** Targeted update of an alert rule (undefined = keep). */
  updateAlertRule(id: string, patch: UpdatePeerSummaryAlertRuleInput): PeerSummaryAlertRule
  /** Remove an alert rule; false when no such rule. */
  removeAlertRule(id: string): boolean
  /**
   * Evaluate the rules against the CURRENT summaries — this hub's freshly-built
   * `local` plus each peer's last-cached summary — and return the firings. A
   * fact about NOW (no breach history): recomputed each call. `[]` when no rule
   * sink is wired or no rule breaches.
   */
  evaluateAlerts(): Promise<PeerSummaryAlertBreach[]>
}

/**
 * Build the on-demand peer summary federation surface — the free-graph control
 * plane. Mirrors `createPeerManifestFederation`: an in-process cache (lost on
 * restart BY DESIGN) over the peer registry, joined with live connection state.
 * `local()` builds this hub's own summary on demand; `refresh` refetches from
 * connected peers, keeping the prior entry on a fetch error AND recording the
 * error so the UI can say WHY a peer has no summary (offline vs not shared).
 */
export function createPeerSummaryFederation(
  registry: SummaryPeerRegistryView,
  opts: {
    /** Thunk that builds the host's own summary (closes over the same deps). */
    buildLocal: () => Promise<PeerSummary>
    /**
     * Persistent history backing (v5 Stream F). When wired, every `refresh`
     * records a counts-only snapshot of the local footprint plus each
     * successfully-fetched peer, and `history` reads back the trend. Omit it
     * and the control plane stays point-in-time only (the E5 behaviour).
     */
    snapshots?: PeerSummarySnapshotSink
    /**
     * Alert-rule backing (v5 Stream F-M5). When wired, the federation exposes
     * rule CRUD + live `evaluateAlerts`. IdentityStore duck-types it. Omit it
     * and the control plane reports no rules and no breaches.
     */
    alertRules?: PeerSummaryAlertRuleSink
    now?: () => number
    logger?: { warn?: (msg: string, meta?: Record<string, unknown>) => void }
  },
): PeerSummaryFederation {
  const now = opts.now ?? (() => Date.now())
  const cache = new Map<string, { summary: PeerSummary; lastFetchedAt: number }>()
  const errors = new Map<string, string>()

  // Best-effort: a snapshot-store hiccup must never break a user-facing
  // refresh, so capture is wrapped + logged, not thrown.
  function capture(source: string, summary: PeerSummary): void {
    if (!opts.snapshots) return
    try {
      opts.snapshots.appendPeerSummarySnapshot({
        capturedAt: now(),
        source,
        summaryJson: JSON.stringify(summary),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      opts.logger?.warn?.('peer summary: snapshot append failed', { source, err: msg })
    }
  }

  // Join the registry's live connection state with the summary cache. Shared by
  // the public `list()` and by `evaluateAlerts` (which needs the cached peer
  // summaries as alert sources).
  function listRows(): PeerSummaryRow[] {
    return registry.status().map((row) => {
      const cached = cache.get(row.peerId)
      return {
        peer: row.peerId,
        label: row.label,
        online: row.connected,
        stale: cached ? !row.connected : false,
        summary: cached?.summary ?? null,
        lastFetchedAt: cached?.lastFetchedAt ?? null,
        lastError: errors.get(row.peerId) ?? null,
      }
    })
  }

  return {
    async local() {
      return opts.buildLocal()
    },
    async list() {
      return listRows()
    },
    async refresh(peerId?: string) {
      const rows = registry
        .status()
        .filter((r) => r.connected && (peerId === undefined || r.peerId === peerId))
      await Promise.all(
        rows.map(async (row) => {
          const link = registry.linkForHub(row.peerId)
          if (!link) return
          try {
            const summary = await fetchPeerSummary(link)
            if (summary) {
              cache.set(row.peerId, { summary, lastFetchedAt: now() })
              errors.delete(row.peerId)
              capture(row.peerId, summary)
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            errors.set(row.peerId, msg)
            opts.logger?.warn?.('peer summary: fetch failed', { peer: row.peerId, err: msg })
          }
        }),
      )
      // Always record a LOCAL reading per refresh — it needs no network and is
      // the most useful trend (this hub's own footprint over time). A refresh
      // scoped to one peer still stamps local; finer local granularity is fine.
      if (opts.snapshots) {
        try {
          capture('local', await opts.buildLocal())
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          opts.logger?.warn?.('peer summary: local snapshot failed', { err: msg })
        }
      }
    },
    async history(query) {
      if (!opts.snapshots) return []
      const rows = opts.snapshots.listPeerSummarySnapshots({
        source: query.source,
        since: query.since,
        until: query.until,
        limit: query.limit,
      })
      return buildPeerSummaryTrend(rows, query.metric)
    },
    metricKeys() {
      return PEER_SUMMARY_METRIC_KEYS
    },
    listAlertRules() {
      return opts.alertRules ? opts.alertRules.listPeerSummaryAlertRules() : []
    },
    addAlertRule(input) {
      if (!opts.alertRules) throw new Error('alert rules not enabled on this host')
      return opts.alertRules.addPeerSummaryAlertRule(input)
    },
    updateAlertRule(id, patch) {
      if (!opts.alertRules) throw new Error('alert rules not enabled on this host')
      return opts.alertRules.updatePeerSummaryAlertRule(id, patch)
    },
    removeAlertRule(id) {
      return opts.alertRules ? opts.alertRules.removePeerSummaryAlertRule(id) : false
    },
    async evaluateAlerts() {
      if (!opts.alertRules) return []
      const rules = opts.alertRules.listPeerSummaryAlertRules()
      if (rules.length === 0) return []
      // Build the live source set: this hub's freshly-built local summary plus
      // each peer's LAST-CACHED summary (alerts fire on the last known reading —
      // the row's `stale` flag is the UI's honesty signal, not a reason to skip).
      const sources: PeerSummarySource[] = [{ source: 'local', summary: await opts.buildLocal() }]
      for (const row of listRows()) {
        if (row.summary) sources.push({ source: row.peer, summary: row.summary })
      }
      return evaluatePeerSummaryAlerts(sources, rules)
    },
  }
}
