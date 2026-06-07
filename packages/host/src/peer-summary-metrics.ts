/**
 * peer-summary-metrics — v5 Stream F: the single source of truth for "what
 * scalar metrics a `PeerSummary` has".
 *
 * The E5 control plane is counts-only; this module names the counts you can
 * TREND over time and ALERT on. One registry maps a dotted metric key →
 * an extractor; both the history projection (F-M2) and the alert evaluator
 * (F-M4) read it, so the set of measurable dimensions can never drift apart
 * between the two features.
 *
 * Pure + deterministic — no I/O, no clock. `runs.byStatus` (a dynamic map)
 * and `llm.windowDays` (a config constant, not a measurement) are deliberately
 * NOT metrics; only the fixed scalar counts are.
 */

import type { PeerSummary } from './peer-summary.js'

/** A point on a metric's trend: when it was captured + the scalar value. */
export interface PeerSummaryTrendPoint {
  capturedAt: number
  value: number
}

/** A persisted snapshot as the trend builder consumes it (blob + time). */
export interface TrendSnapshot {
  capturedAt: number
  summaryJson: string
}

/**
 * Dotted metric key → extractor. The keys mirror the `PeerSummary` shape so
 * the admin UI can label them from the path. Every value is a non-negative
 * integer count.
 */
export const PEER_SUMMARY_METRICS: Record<string, (s: PeerSummary) => number> = {
  'assets.agents': (s) => s.assets.agents,
  'assets.workflows': (s) => s.assets.workflows,
  'assets.publishedWorkflows': (s) => s.assets.publishedWorkflows,
  'assets.peers': (s) => s.assets.peers,
  'runs.total': (s) => s.runs.total,
  'llm.calls': (s) => s.llm.calls,
  'llm.tokens': (s) => s.llm.tokens,
  'llm.costMicros': (s) => s.llm.costMicros,
  'health.suspendedTasks': (s) => s.health.suspendedTasks,
  // Cross-hub alert aggregation (Stream F cross-hub-agg M2): registering the
  // alerts family here makes the federation-wide open-firing count TRENDABLE
  // (history) and META-ALERTABLE (a rule on this key evaluated against local +
  // each peer) for free — the registry is the single source both features read.
  // An old snapshot captured before the field existed simply throws inside the
  // extractor → projectPeerSummaryMetric skips that point (best-effort).
  'alerts.openFirings': (s) => s.alerts.openFirings,
}

/** The full list of valid metric keys (stable order for UI dropdowns). */
export const PEER_SUMMARY_METRIC_KEYS: string[] = Object.keys(PEER_SUMMARY_METRICS)

/** True if `key` names a known scalar metric. */
export function isPeerSummaryMetric(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(PEER_SUMMARY_METRICS, key)
}

/**
 * Project one scalar metric out of a summary. Returns `undefined` for an
 * unknown key or a non-finite value (a malformed blob) — callers SKIP those
 * points rather than charting a hole.
 */
export function projectPeerSummaryMetric(
  summary: PeerSummary,
  key: string,
): number | undefined {
  const extract = PEER_SUMMARY_METRICS[key]
  if (!extract) return undefined
  let v: unknown
  try {
    v = extract(summary)
  } catch {
    // A blob missing a nested field (assets/runs/llm/health) — skip it.
    return undefined
  }
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Build a chronological trend for `metricKey` from raw snapshots. Each
 * snapshot's `summaryJson` is parsed and projected; a corrupt blob or an
 * absent metric drops that point (best-effort — a control-plane trend should
 * never throw on one bad row). Input is assumed already chronological (the
 * snapshot store returns `captured_at ASC`); order is preserved.
 */
export function buildPeerSummaryTrend(
  snapshots: TrendSnapshot[],
  metricKey: string,
): PeerSummaryTrendPoint[] {
  const out: PeerSummaryTrendPoint[] = []
  for (const snap of snapshots) {
    let parsed: unknown
    try {
      parsed = JSON.parse(snap.summaryJson)
    } catch {
      continue // corrupt blob — skip
    }
    const value = projectPeerSummaryMetric(parsed as PeerSummary, metricKey)
    if (value === undefined) continue
    out.push({ capturedAt: snap.capturedAt, value })
  }
  return out
}
