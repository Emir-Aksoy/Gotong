/**
 * v5 Stream F — evaluatePeerSummaryAlerts (the pure live alert evaluator).
 *
 * Coverage:
 *   - each comparator (gt/gte/lt/lte) fires / holds at the boundary
 *   - a '*' rule evaluates against every source (one breach per breaching one)
 *   - a source-specific rule only checks its source
 *   - disabled rules are skipped
 *   - an unknown / unprojectable metric yields no breach (never throws)
 *   - the breach carries the ACTUAL source + projected value (not '*')
 */

import { describe, expect, it } from 'vitest'

import type { PeerSummaryAlertRule } from '@gotong/identity'

import {
  evaluatePeerSummaryAlerts,
  type PeerSummarySource,
} from '../src/peer-summary-alerts.js'
import type { PeerSummary } from '../src/peer-summary.js'

const summary = (over: Partial<PeerSummary> = {}): PeerSummary => ({
  hubId: 'h',
  protocolVersion: '1',
  generatedAt: 0,
  assets: { agents: 3, workflows: 2, publishedWorkflows: 1, peers: 4 },
  runs: { total: 9, byStatus: { completed: 7, failed: 2 } },
  llm: { windowDays: 30, calls: 42, tokens: 1234, costMicros: 5600 },
  health: { suspendedTasks: 5 },
  alerts: { openFirings: 0 },
  ...over,
})

const rule = (over: Partial<PeerSummaryAlertRule>): PeerSummaryAlertRule => ({
  id: 'r1',
  source: 'local',
  metric: 'health.suspendedTasks',
  comparator: 'gt',
  threshold: 4,
  label: null,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

const src = (source: string, over: Partial<PeerSummary> = {}): PeerSummarySource => ({
  source,
  summary: summary(over),
})

describe('evaluatePeerSummaryAlerts (v5 Stream F)', () => {
  it('fires when gt threshold is crossed, carrying the actual source + value', () => {
    const out = evaluatePeerSummaryAlerts([src('local')], [rule({ comparator: 'gt', threshold: 4 })])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ ruleId: 'r1', source: 'local', metric: 'health.suspendedTasks', value: 5 })
  })

  it('respects each comparator at the boundary', () => {
    const s = [src('local', { health: { suspendedTasks: 5 } })]
    // value = 5
    expect(evaluatePeerSummaryAlerts(s, [rule({ comparator: 'gt', threshold: 5 })])).toHaveLength(0) // 5>5 false
    expect(evaluatePeerSummaryAlerts(s, [rule({ comparator: 'gte', threshold: 5 })])).toHaveLength(1) // 5>=5
    expect(evaluatePeerSummaryAlerts(s, [rule({ comparator: 'lt', threshold: 5 })])).toHaveLength(0) // 5<5 false
    expect(evaluatePeerSummaryAlerts(s, [rule({ comparator: 'lte', threshold: 5 })])).toHaveLength(1) // 5<=5
  })

  it('a * rule evaluates every source — one breach per breaching one', () => {
    const sources = [
      src('local', { health: { suspendedTasks: 9 } }), // breaches
      src('p1', { health: { suspendedTasks: 1 } }), // holds
      src('p2', { health: { suspendedTasks: 7 } }), // breaches
    ]
    const out = evaluatePeerSummaryAlerts(sources, [rule({ source: '*', comparator: 'gt', threshold: 5 })])
    expect(out.map((b) => b.source).sort()).toEqual(['local', 'p2'])
    expect(out.every((b) => b.source !== '*')).toBe(true)
  })

  it('a source-specific rule only checks its source', () => {
    const sources = [src('local', { health: { suspendedTasks: 0 } }), src('p1', { health: { suspendedTasks: 9 } })]
    const out = evaluatePeerSummaryAlerts(sources, [rule({ source: 'p1', comparator: 'gt', threshold: 5 })])
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('p1')
  })

  it('skips disabled rules', () => {
    const out = evaluatePeerSummaryAlerts([src('local')], [rule({ enabled: false, threshold: 0 })])
    expect(out).toHaveLength(0)
  })

  it('meta-alerts on a peer open-firing count across the federation (cross-hub-agg M2)', () => {
    // A `*` rule on the newly-registered alerts metric is how the control plane
    // alerts on OTHER hubs' alerting state — "some peer has >2 alerts firing".
    const sources = [
      src('local', { alerts: { openFirings: 0 } }), // calm
      src('p1', { alerts: { openFirings: 5 } }), // breaches
    ]
    const out = evaluatePeerSummaryAlerts(sources, [
      rule({ source: '*', metric: 'alerts.openFirings', comparator: 'gt', threshold: 2 }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ source: 'p1', metric: 'alerts.openFirings', value: 5 })
  })

  it('yields no breach for an unknown / unprojectable metric (never throws)', () => {
    const out = evaluatePeerSummaryAlerts([src('local')], [rule({ metric: 'assets.bogus', threshold: -1 })])
    expect(out).toHaveLength(0)
    // a blob missing a nested field also just skips, not throws
    const broken: PeerSummarySource = { source: 'local', summary: { assets: { agents: 1 } } as unknown as PeerSummary }
    expect(
      evaluatePeerSummaryAlerts([broken], [rule({ metric: 'health.suspendedTasks', comparator: 'gt', threshold: 0 })]),
    ).toHaveLength(0)
  })
})
