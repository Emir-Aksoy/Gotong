/**
 * peer-summary-alerts — v5 Stream F: the pure control-plane alert evaluator.
 *
 * A rule says "breach when this source's metric crosses this threshold". This
 * module applies the rules to the CURRENT summaries and returns the firings.
 * It is the live counterpart to the history trends (peer-summary-metrics): both
 * read the same metric registry, so a metric you can chart is a metric you can
 * alert on, and vice versa.
 *
 * Pure + deterministic — no I/O, no clock, no persistence. Alerts are evaluated
 * on demand against whatever summaries the caller passes; the MVP keeps no
 * breach history (a fired alert is a fact about NOW, recomputed each request).
 */

import type { PeerSummaryAlertComparator, PeerSummaryAlertRule } from '@aipehub/identity'

import { projectPeerSummaryMetric } from './peer-summary-metrics.js'
import type { PeerSummary } from './peer-summary.js'

/** A current summary keyed by its source (`'local'` | a peer id). */
export interface PeerSummarySource {
  source: string
  summary: PeerSummary
}

/** A fired alert: a rule whose metric crossed its threshold for one source. */
export interface PeerSummaryAlertBreach {
  ruleId: string
  /** The ACTUAL source that breached — never the `'*'` wildcard. */
  source: string
  metric: string
  comparator: PeerSummaryAlertComparator
  threshold: number
  /** The projected metric value that tripped the rule. */
  value: number
  label: string | null
}

/** Wildcard source: a rule with `source === '*'` evaluates against every source. */
const SOURCE_ANY = '*'

/** Apply one comparator. Unknown comparator → false (defensive; store validates). */
function compare(
  value: number,
  comparator: PeerSummaryAlertComparator,
  threshold: number,
): boolean {
  switch (comparator) {
    case 'gt':
      return value > threshold
    case 'gte':
      return value >= threshold
    case 'lt':
      return value < threshold
    case 'lte':
      return value <= threshold
    default:
      return false
  }
}

/**
 * Evaluate `rules` against the current `sources`, returning one breach per
 * (rule, matching source) whose metric crosses the threshold. Disabled rules
 * are skipped; a rule whose metric can't be projected from a given source
 * (unknown key / malformed blob) yields no breach for that source rather than
 * throwing — a control-plane check must never blow up on one odd reading.
 */
export function evaluatePeerSummaryAlerts(
  sources: PeerSummarySource[],
  rules: PeerSummaryAlertRule[],
): PeerSummaryAlertBreach[] {
  const breaches: PeerSummaryAlertBreach[] = []
  for (const rule of rules) {
    if (!rule.enabled) continue
    const matching =
      rule.source === SOURCE_ANY ? sources : sources.filter((s) => s.source === rule.source)
    for (const s of matching) {
      const value = projectPeerSummaryMetric(s.summary, rule.metric)
      if (value === undefined) continue
      if (compare(value, rule.comparator, rule.threshold)) {
        breaches.push({
          ruleId: rule.id,
          source: s.source,
          metric: rule.metric,
          comparator: rule.comparator,
          threshold: rule.threshold,
          value,
          label: rule.label,
        })
      }
    }
  }
  return breaches
}
