/**
 * v5 Stream F — control-plane history (PeerSummarySnapshotStore via
 * IdentityStore).
 *
 * Coverage:
 *   - append: assigns id + default capturedAt, round-trips source + blob
 *   - append validation: missing source / summaryJson, negative capturedAt,
 *     oversized blob
 *   - list: filter by source, half-open [since, until) window, CHRONOLOGICAL
 *     (captured_at ASC) ordering, limit clamp
 *   - prune: deletes < before, returns count, retained window stays
 *   - OPAQUE: identity never parses summary_json — a non-JSON string
 *     round-trips byte-for-byte (the host owns PeerSummary semantics)
 *
 * Timestamps are passed explicitly so the window tests are wall-clock
 * independent. The table has no FK — plain string sources stand in.
 */

import { describe, expect, it, beforeEach } from 'vitest'

import { IdentityError, IdentityStore, openIdentityStore } from '../src/index.js'

// Three ascending instants on one UTC day.
const T1 = Date.UTC(2026, 4, 20, 9, 0, 0)
const T2 = Date.UTC(2026, 4, 20, 9, 5, 0)
const T3 = Date.UTC(2026, 4, 20, 9, 10, 0)

const SUMMARY = JSON.stringify({
  hubId: 'hub-a',
  protocolVersion: '1',
  generatedAt: T1,
  assets: { agents: 3, workflows: 2, publishedWorkflows: 1, peers: 1 },
  runs: { total: 9, byStatus: { completed: 7, failed: 2 } },
  llm: { windowDays: 30, calls: 42, tokens: 1234, costMicros: 5600 },
  health: { suspendedTasks: 0 },
})

describe('IdentityStore — peer summary snapshots (v5 Stream F)', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:' })
  })

  it('append assigns id + resolved capturedAt and round-trips the blob', () => {
    const snap = store.appendPeerSummarySnapshot({
      capturedAt: T1,
      source: 'local',
      summaryJson: SUMMARY,
    })
    expect(snap.id).toBeGreaterThan(0)
    expect(snap.capturedAt).toBe(T1)
    expect(snap.source).toBe('local')
    expect(snap.summaryJson).toBe(SUMMARY)

    const back = store.listPeerSummarySnapshots({ source: 'local' })
    expect(back).toHaveLength(1)
    expect(back[0].summaryJson).toBe(SUMMARY)
  })

  it('capturedAt defaults to now when omitted', () => {
    const before = Date.now()
    const snap = store.appendPeerSummarySnapshot({
      source: 'peer-x',
      summaryJson: SUMMARY,
    })
    expect(snap.capturedAt).toBeGreaterThanOrEqual(before)
    expect(snap.capturedAt).toBeLessThanOrEqual(Date.now())
  })

  it('stores summary_json OPAQUE — a non-JSON string round-trips verbatim', () => {
    // identity must never parse the blob; the host owns all semantics. A
    // garbage payload is stored + returned byte-for-byte, never rejected.
    const garbage = 'not json at all {{{'
    const snap = store.appendPeerSummarySnapshot({
      source: 'local',
      summaryJson: garbage,
    })
    expect(snap.summaryJson).toBe(garbage)
    expect(store.listPeerSummarySnapshots()[0].summaryJson).toBe(garbage)
  })

  it('append rejects missing source / summaryJson', () => {
    expect(() =>
      store.appendPeerSummarySnapshot({ source: '', summaryJson: SUMMARY }),
    ).toThrow(IdentityError)
    expect(() =>
      store.appendPeerSummarySnapshot({ source: 'local', summaryJson: '' }),
    ).toThrow(IdentityError)
  })

  it('append rejects a negative capturedAt and an oversized blob', () => {
    expect(() =>
      store.appendPeerSummarySnapshot({
        capturedAt: -1,
        source: 'local',
        summaryJson: SUMMARY,
      }),
    ).toThrow(IdentityError)
    // 64 KiB cap — counts-only summaries are tiny; anything huge is a bug.
    const huge = 'x'.repeat(64 * 1024 + 1)
    expect(() =>
      store.appendPeerSummarySnapshot({ source: 'local', summaryJson: huge }),
    ).toThrow(IdentityError)
  })

  it('list filters by source and returns chronological (ASC) order', () => {
    // Insert out of order; list must come back oldest-first for a left-to-right trend.
    store.appendPeerSummarySnapshot({ capturedAt: T3, source: 'local', summaryJson: SUMMARY })
    store.appendPeerSummarySnapshot({ capturedAt: T1, source: 'local', summaryJson: SUMMARY })
    store.appendPeerSummarySnapshot({ capturedAt: T2, source: 'local', summaryJson: SUMMARY })
    store.appendPeerSummarySnapshot({ capturedAt: T2, source: 'peer-x', summaryJson: SUMMARY })

    const local = store.listPeerSummarySnapshots({ source: 'local' })
    expect(local.map((s) => s.capturedAt)).toEqual([T1, T2, T3])

    const peer = store.listPeerSummarySnapshots({ source: 'peer-x' })
    expect(peer).toHaveLength(1)

    // No source filter → every source, still chronological.
    expect(store.listPeerSummarySnapshots()).toHaveLength(4)
  })

  it('list honours the half-open [since, until) window', () => {
    for (const t of [T1, T2, T3]) {
      store.appendPeerSummarySnapshot({ capturedAt: t, source: 'local', summaryJson: SUMMARY })
    }
    // [T1, T3): includes T1 + T2, excludes T3.
    const win = store.listPeerSummarySnapshots({ since: T1, until: T3 })
    expect(win.map((s) => s.capturedAt)).toEqual([T1, T2])
  })

  it('list clamps a 0 / over-max limit and respects a small one', () => {
    for (const t of [T1, T2, T3]) {
      store.appendPeerSummarySnapshot({ capturedAt: t, source: 'local', summaryJson: SUMMARY })
    }
    // limit 0 → default (not "no rows").
    expect(store.listPeerSummarySnapshots({ limit: 0 })).toHaveLength(3)
    // explicit small limit takes the oldest N (ASC).
    const two = store.listPeerSummarySnapshots({ limit: 2 })
    expect(two.map((s) => s.capturedAt)).toEqual([T1, T2])
  })

  it('prune deletes snapshots older than `before` and returns the count', () => {
    for (const t of [T1, T2, T3]) {
      store.appendPeerSummarySnapshot({ capturedAt: t, source: 'local', summaryJson: SUMMARY })
    }
    // Drop everything strictly before T3 → removes T1 + T2.
    const removed = store.prunePeerSummarySnapshots({ before: T3 })
    expect(removed).toBe(2)
    const left = store.listPeerSummarySnapshots()
    expect(left.map((s) => s.capturedAt)).toEqual([T3])
  })
})
