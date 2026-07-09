/**
 * MR-M3 — per-provider health projection for the admin panel.
 *
 * The MR-M1 {@link RoutingProvider} emits a {@link RoutingEvent} on every
 * candidate outcome (served / error / breaker open / breaker close). This
 * tracker folds that stream into a small per-agent, per-candidate health map
 * the admin health snapshot can read, so an operator sees WHICH provider is
 * flaky — not just the binary "the brain is out" that CARE-M7 already shows.
 *
 * **Why in-memory, not file-first.** The rest of Gotong's state is on disk
 * (north star §3). This projection is the deliberate exception: it mirrors the
 * RoutingProvider's circuit-breaker state, which is ITSELF in-memory and
 * rebuilt fresh every time the pool respawns the provider. Persisting routing
 * health to disk would outlive the thing it describes — after a restart the
 * breakers are all closed again, so a persisted "open" row would be a lie.
 * CARE's `llm-outage.json` persists precisely because a provider outage DOES
 * survive a restart; a tripped breaker does not. Lifetime-matched, honest.
 *
 * Zero LLM, zero env knobs — pure event folding + a time-window read.
 */

import type { RoutingEvent } from '@gotong/llm'

/**
 * One degraded candidate, surfaced to the panel. `state`:
 *   - `'open'`     — breaker tripped and still cooling (actively skipped; the
 *                    agent is serving from the next candidate).
 *   - `'half_open'`— cooldown elapsed; the next request probes this candidate.
 *   - `'degraded'` — recent pre-first-chunk failure that failed over, breaker
 *                    not (yet) tripped.
 * `since` is the epoch-ms the current state began; the panel folds minutes
 * against the snapshot's `checkedAt` (presentation layer owns the language).
 */
export interface HealthRoutingRow {
  agentId: string
  /** The candidate's routing label (e.g. `anthropic`, `openai-compatible:deepseek.com`). */
  candidate: string
  /** 0 = the primary provider; ≥1 = a declared fallback, in order. */
  index: number
  state: 'open' | 'half_open' | 'degraded'
  /** Structured error code from the last failure (auth/quota/network/…), when known. */
  errorKind?: string
  since: number
  /** Epoch-ms the breaker's cooldown ends (only for open/half_open). */
  openUntil?: number
}

/** The narrow recorder the pool depends on — one method, so tests can stub it. */
export interface RoutingHealthRecorder {
  record(agentId: string, ev: RoutingEvent): void
}

/**
 * A candidate had a pre-first-chunk failure this recently (and no success
 * since) → still counts as `degraded` on the panel. Matches the breaker's own
 * 60s sliding window: once a full window passes with no fresh failure, a
 * quiet candidate reads as healthy again (breakers self-heal by time).
 */
const DEGRADED_WINDOW_MS = 60_000

interface CandidateState {
  candidate: string
  index: number
  /** Last outcome we saw for this candidate. */
  lastOutcome: 'served' | 'error'
  lastErrorKind?: string
  lastErrorAt?: number
  /** Breaker currently tripped (set by breaker_open, cleared by breaker_close / a success). */
  breakerOpen: boolean
  openedAt?: number
  openUntil?: number
}

export class RoutingHealthTracker implements RoutingHealthRecorder {
  // agentId → (candidate index → state). Keyed by index (stable within an
  // agent's ordered chain) so a relabelled candidate can't spawn a ghost row.
  private readonly byAgent = new Map<string, Map<number, CandidateState>>()
  private readonly now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
  }

  record(agentId: string, ev: RoutingEvent): void {
    // `exhausted` is a per-request terminal (all candidates down) with no
    // candidate index — CARE-M7's llmOutage already covers "brain out", so we
    // don't double-report it here; the candidate_error events that preceded it
    // already updated each candidate's state.
    if (ev.type === 'exhausted') return
    const chain = this.byAgent.get(agentId) ?? new Map<number, CandidateState>()
    if (!this.byAgent.has(agentId)) this.byAgent.set(agentId, chain)
    const cur = chain.get(ev.index) ?? {
      candidate: ev.candidate,
      index: ev.index,
      lastOutcome: 'served' as const,
      breakerOpen: false,
    }
    cur.candidate = ev.candidate // labels are stable, but keep the freshest
    switch (ev.type) {
      case 'served':
        cur.lastOutcome = 'served'
        // A success is the authoritative "healthy again" signal — it closes the
        // breaker in the provider too (half-open probe succeeded).
        cur.breakerOpen = false
        cur.openedAt = undefined
        cur.openUntil = undefined
        break
      case 'candidate_error':
        cur.lastOutcome = 'error'
        cur.lastErrorKind = ev.errorKind
        cur.lastErrorAt = this.now()
        break
      case 'breaker_open':
        cur.breakerOpen = true
        cur.openedAt = this.now()
        cur.openUntil = ev.openUntil
        break
      case 'breaker_close':
        // A close only ever fires from RoutingProvider.recordSuccess — i.e. a
        // half-open probe SUCCEEDED — so it implies recovery, not just "cooldown
        // done". Clear the error state too (mirror `served`), so a candidate that
        // recovered reads healthy even if only the close event reached us.
        cur.breakerOpen = false
        cur.openedAt = undefined
        cur.openUntil = undefined
        cur.lastOutcome = 'served'
        break
    }
    chain.set(ev.index, cur)
  }

  /** Flatten to the panel rows, surfacing only currently-unhealthy candidates. */
  snapshot(): HealthRoutingRow[] {
    const now = this.now()
    const rows: HealthRoutingRow[] = []
    for (const [agentId, chain] of this.byAgent) {
      for (const c of chain.values()) {
        if (c.breakerOpen) {
          // Cooldown still running → open; elapsed → half-open (next request probes).
          const half = c.openUntil !== undefined && now >= c.openUntil
          rows.push({
            agentId,
            candidate: c.candidate,
            index: c.index,
            state: half ? 'half_open' : 'open',
            ...(c.lastErrorKind ? { errorKind: c.lastErrorKind } : {}),
            since: c.openedAt ?? now,
            ...(c.openUntil !== undefined ? { openUntil: c.openUntil } : {}),
          })
        } else if (
          c.lastOutcome === 'error' &&
          c.lastErrorAt !== undefined &&
          now - c.lastErrorAt < DEGRADED_WINDOW_MS
        ) {
          rows.push({
            agentId,
            candidate: c.candidate,
            index: c.index,
            state: 'degraded',
            ...(c.lastErrorKind ? { errorKind: c.lastErrorKind } : {}),
            since: c.lastErrorAt,
          })
        }
        // else healthy → not surfaced (the panel is a signal, not a topology dump).
      }
    }
    // Stable order: primary-first within an agent, agents alphabetical.
    rows.sort((a, b) => (a.agentId === b.agentId ? a.index - b.index : a.agentId < b.agentId ? -1 : 1))
    return rows
  }

  /** Drop an agent's routing state (e.g. it was deleted / its fallbacks cleared). */
  forget(agentId: string): void {
    this.byAgent.delete(agentId)
  }
}
