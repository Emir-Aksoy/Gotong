/**
 * v5 Stream F — peer-summary-metrics: the single source of truth for the
 * scalar metrics a `PeerSummary` can be trended / alerted on.
 *
 * Coverage:
 *   - projectPeerSummaryMetric: known keys, unknown key → undefined, a blob
 *     missing a nested field → undefined (not a throw)
 *   - PEER_SUMMARY_METRIC_KEYS / isPeerSummaryMetric agreement
 *   - buildPeerSummaryTrend: chronological projection, skip corrupt blob,
 *     skip a snapshot whose metric is absent
 */

import { describe, expect, it } from 'vitest'

import type { PeerSummary } from '../src/peer-summary.js'
import {
  PEER_SUMMARY_METRIC_KEYS,
  buildPeerSummaryTrend,
  isPeerSummaryMetric,
  projectPeerSummaryMetric,
} from '../src/peer-summary-metrics.js'

const summary = (over: Partial<PeerSummary> = {}): PeerSummary => ({
  hubId: 'h',
  protocolVersion: '1',
  generatedAt: 0,
  assets: { agents: 3, workflows: 2, publishedWorkflows: 1, peers: 4 },
  runs: { total: 9, byStatus: { completed: 7, failed: 2 } },
  llm: { windowDays: 30, calls: 42, tokens: 1234, costMicros: 5600 },
  health: { suspendedTasks: 5 },
  ...over,
})

describe('projectPeerSummaryMetric (v5 Stream F)', () => {
  it('projects every known scalar metric', () => {
    const s = summary()
    expect(projectPeerSummaryMetric(s, 'assets.agents')).toBe(3)
    expect(projectPeerSummaryMetric(s, 'assets.publishedWorkflows')).toBe(1)
    expect(projectPeerSummaryMetric(s, 'assets.peers')).toBe(4)
    expect(projectPeerSummaryMetric(s, 'runs.total')).toBe(9)
    expect(projectPeerSummaryMetric(s, 'llm.calls')).toBe(42)
    expect(projectPeerSummaryMetric(s, 'llm.costMicros')).toBe(5600)
    expect(projectPeerSummaryMetric(s, 'health.suspendedTasks')).toBe(5)
  })

  it('returns undefined for an unknown metric key', () => {
    expect(projectPeerSummaryMetric(summary(), 'assets.bogus')).toBeUndefined()
    expect(projectPeerSummaryMetric(summary(), 'runs.byStatus')).toBeUndefined()
  })

  it('returns undefined (never throws) for a blob missing a nested field', () => {
    // A malformed/old peer blob without `health` — extractor throws, we skip.
    const broken = { assets: { agents: 1 } } as unknown as PeerSummary
    expect(projectPeerSummaryMetric(broken, 'health.suspendedTasks')).toBeUndefined()
    expect(projectPeerSummaryMetric(broken, 'assets.agents')).toBe(1)
  })

  it('every metric key is recognised by isPeerSummaryMetric', () => {
    expect(PEER_SUMMARY_METRIC_KEYS.length).toBeGreaterThan(0)
    for (const k of PEER_SUMMARY_METRIC_KEYS) expect(isPeerSummaryMetric(k)).toBe(true)
    expect(isPeerSummaryMetric('not.a.metric')).toBe(false)
  })
})

describe('buildPeerSummaryTrend (v5 Stream F)', () => {
  it('projects a chronological trend, preserving order', () => {
    const snaps = [
      { capturedAt: 100, summaryJson: JSON.stringify(summary({ health: { suspendedTasks: 0 } })) },
      { capturedAt: 200, summaryJson: JSON.stringify(summary({ health: { suspendedTasks: 4 } })) },
      { capturedAt: 300, summaryJson: JSON.stringify(summary({ health: { suspendedTasks: 9 } })) },
    ]
    expect(buildPeerSummaryTrend(snaps, 'health.suspendedTasks')).toEqual([
      { capturedAt: 100, value: 0 },
      { capturedAt: 200, value: 4 },
      { capturedAt: 300, value: 9 },
    ])
  })

  it('skips a corrupt blob rather than throwing', () => {
    const snaps = [
      { capturedAt: 100, summaryJson: JSON.stringify(summary({ assets: { agents: 1, workflows: 0, publishedWorkflows: 0, peers: 0 } })) },
      { capturedAt: 200, summaryJson: 'not json {{{' },
      { capturedAt: 300, summaryJson: JSON.stringify(summary({ assets: { agents: 5, workflows: 0, publishedWorkflows: 0, peers: 0 } })) },
    ]
    expect(buildPeerSummaryTrend(snaps, 'assets.agents')).toEqual([
      { capturedAt: 100, value: 1 },
      { capturedAt: 300, value: 5 },
    ])
  })

  it('skips a snapshot whose metric is absent', () => {
    const snaps = [
      { capturedAt: 100, summaryJson: JSON.stringify(summary()) },
      { capturedAt: 200, summaryJson: JSON.stringify({ assets: { agents: 2 } }) }, // no health
    ]
    expect(buildPeerSummaryTrend(snaps, 'health.suspendedTasks')).toEqual([
      { capturedAt: 100, value: 5 },
    ])
  })
})
