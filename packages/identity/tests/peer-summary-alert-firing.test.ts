/**
 * v5 Stream F day-3 — control-plane alert FIRINGS (breach history, via
 * IdentityStore → PeerSummaryAlertFiringStore).
 *
 * Coverage:
 *   - open: autoincrement id, round-trips fields, resolvedAt null, defaults openedAt
 *   - edge-trigger invariant: a 2nd open while one is unresolved → alert_firing_open
 *   - re-open: allowed once the first firing is resolved
 *   - listOpen: only unresolved rows, oldest first
 *   - list: newest first; filter by source / ruleId / state / [since,until); limit clamp
 *   - resolve: stamps resolvedAt, idempotent; missing id → alert_firing_not_found
 *   - prune: removes resolved older than cutoff, never touches open rows
 *   - validation: empty ruleId/source/metric, non-finite threshold/value
 *   - shape: the firing carries only counts / ids / its own label (no free text)
 */

import { describe, expect, it, beforeEach } from 'vitest'

import { IdentityError, IdentityStore, openIdentityStore } from '../src/index.js'

describe('IdentityStore — peer summary alert firings (v5 Stream F day-3)', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:' })
  })

  const base = {
    ruleId: 'asr_abc',
    source: 'local',
    metric: 'health.suspendedTasks',
    comparator: 'gt' as const,
    threshold: 5,
    value: 9,
  }

  it('open generates an autoincrement id, round-trips fields, resolvedAt null', () => {
    const f = store.openPeerSummaryAlertFiring({ ...base, label: 'too many parked', openedAt: 1000 })
    expect(typeof f.id).toBe('number')
    expect(f.id).toBeGreaterThan(0)
    expect(f.ruleId).toBe('asr_abc')
    expect(f.source).toBe('local')
    expect(f.metric).toBe('health.suspendedTasks')
    expect(f.comparator).toBe('gt')
    expect(f.threshold).toBe(5)
    expect(f.value).toBe(9)
    expect(f.label).toBe('too many parked')
    expect(f.openedAt).toBe(1000)
    expect(f.resolvedAt).toBeNull()
  })

  it('open defaults openedAt to now and label to null', () => {
    const before = Date.now()
    const f = store.openPeerSummaryAlertFiring({ ...base })
    expect(f.openedAt).toBeGreaterThanOrEqual(before)
    expect(f.label).toBeNull()
  })

  it('enforces at-most-one OPEN firing per (rule, source)', () => {
    store.openPeerSummaryAlertFiring({ ...base, openedAt: 1000 })
    expect(() => store.openPeerSummaryAlertFiring({ ...base, openedAt: 1001 })).toThrow(IdentityError)
    try {
      store.openPeerSummaryAlertFiring({ ...base, openedAt: 1002 })
    } catch (err) {
      expect((err as IdentityError).code).toBe('alert_firing_open')
    }
    // A DIFFERENT source for the same rule is fine — they breach independently.
    const other = store.openPeerSummaryAlertFiring({ ...base, source: 'peer-x', openedAt: 1003 })
    expect(other.source).toBe('peer-x')
    expect(store.listOpenPeerSummaryAlertFirings()).toHaveLength(2)
  })

  it('re-opens the same (rule, source) once the prior firing is resolved', () => {
    const first = store.openPeerSummaryAlertFiring({ ...base, openedAt: 1000 })
    store.resolvePeerSummaryAlertFiring(first.id, { resolvedAt: 2000 })
    // resolved → the partial unique index no longer covers it → re-open allowed.
    const second = store.openPeerSummaryAlertFiring({ ...base, openedAt: 3000 })
    expect(second.id).not.toBe(first.id)
    expect(second.resolvedAt).toBeNull()
    expect(store.listOpenPeerSummaryAlertFirings()).toHaveLength(1)
  })

  it('listOpen returns only unresolved rows, oldest first', () => {
    const a = store.openPeerSummaryAlertFiring({ ...base, source: 'a', openedAt: 3000 })
    const b = store.openPeerSummaryAlertFiring({ ...base, source: 'b', openedAt: 1000 })
    store.openPeerSummaryAlertFiring({ ...base, source: 'c', openedAt: 2000 })
    store.resolvePeerSummaryAlertFiring(a.id, { resolvedAt: 4000 })
    const open = store.listOpenPeerSummaryAlertFirings()
    expect(open.map((f) => f.source)).toEqual(['b', 'c']) // oldest first, a resolved
  })

  it('list is newest-first and filters by source / ruleId / state / window', () => {
    const a = store.openPeerSummaryAlertFiring({ ...base, source: 'a', ruleId: 'r1', openedAt: 1000 })
    store.openPeerSummaryAlertFiring({ ...base, source: 'b', ruleId: 'r2', openedAt: 2000 })
    store.openPeerSummaryAlertFiring({ ...base, source: 'c', ruleId: 'r1', openedAt: 3000 })
    store.resolvePeerSummaryAlertFiring(a.id, { resolvedAt: 5000 })

    // newest first
    expect(store.listPeerSummaryAlertFirings().map((f) => f.openedAt)).toEqual([3000, 2000, 1000])
    // by source
    expect(store.listPeerSummaryAlertFirings({ source: 'b' }).map((f) => f.openedAt)).toEqual([2000])
    // by ruleId
    expect(store.listPeerSummaryAlertFirings({ ruleId: 'r1' }).map((f) => f.openedAt)).toEqual([3000, 1000])
    // by state
    expect(store.listPeerSummaryAlertFirings({ state: 'resolved' }).map((f) => f.openedAt)).toEqual([1000])
    expect(store.listPeerSummaryAlertFirings({ state: 'open' }).map((f) => f.openedAt)).toEqual([3000, 2000])
    // half-open window on opened_at
    expect(store.listPeerSummaryAlertFirings({ since: 2000, until: 3000 }).map((f) => f.openedAt)).toEqual([2000])
  })

  it('list clamps limit and rejects a bad state', () => {
    for (let i = 0; i < 5; i++) {
      store.openPeerSummaryAlertFiring({ ...base, source: `s${i}`, openedAt: 1000 + i })
    }
    expect(store.listPeerSummaryAlertFirings({ limit: 2 })).toHaveLength(2)
    expect(store.listPeerSummaryAlertFirings({ limit: 0 })).toHaveLength(5) // 0 → default, not "no rows"
    expect(() =>
      // @ts-expect-error — bad state at the boundary
      store.listPeerSummaryAlertFirings({ state: 'pending' }),
    ).toThrow(IdentityError)
  })

  it('resolve stamps resolvedAt, is idempotent, and 404s a missing id', () => {
    const f = store.openPeerSummaryAlertFiring({ ...base, openedAt: 1000 })
    const r1 = store.resolvePeerSummaryAlertFiring(f.id, { resolvedAt: 2000 })
    expect(r1.resolvedAt).toBe(2000)
    // re-resolving keeps the ORIGINAL resolvedAt (guarded UPDATE matches nothing).
    const r2 = store.resolvePeerSummaryAlertFiring(f.id, { resolvedAt: 9999 })
    expect(r2.resolvedAt).toBe(2000)
    try {
      store.resolvePeerSummaryAlertFiring(999_999)
    } catch (err) {
      expect((err as IdentityError).code).toBe('alert_firing_not_found')
    }
  })

  it('prune removes resolved firings older than the cutoff, never open ones', () => {
    const old = store.openPeerSummaryAlertFiring({ ...base, source: 'old', openedAt: 1000 })
    store.resolvePeerSummaryAlertFiring(old.id, { resolvedAt: 1500 })
    const recent = store.openPeerSummaryAlertFiring({ ...base, source: 'recent', openedAt: 9000 })
    store.resolvePeerSummaryAlertFiring(recent.id, { resolvedAt: 9500 })
    store.openPeerSummaryAlertFiring({ ...base, source: 'live', openedAt: 500 }) // OLD but still open

    const removed = store.prunePeerSummaryAlertFirings({ before: 5000 })
    expect(removed).toBe(1) // only the resolved 'old' row
    const left = store.listPeerSummaryAlertFirings().map((f) => f.source).sort()
    expect(left).toEqual(['live', 'recent']) // the still-open old row survives
  })

  it('rejects empty ids and non-finite numbers at the boundary', () => {
    expect(() => store.openPeerSummaryAlertFiring({ ...base, ruleId: '' })).toThrow(IdentityError)
    expect(() => store.openPeerSummaryAlertFiring({ ...base, source: '  ' })).toThrow(IdentityError)
    expect(() => store.openPeerSummaryAlertFiring({ ...base, metric: '' })).toThrow(IdentityError)
    expect(() => store.openPeerSummaryAlertFiring({ ...base, threshold: Infinity })).toThrow(IdentityError)
    expect(() => store.openPeerSummaryAlertFiring({ ...base, value: NaN })).toThrow(IdentityError)
  })

  it('a firing carries only counts / ids / its own label — no free-form leak surface', () => {
    const f = store.openPeerSummaryAlertFiring({ ...base, label: 'x', openedAt: 1000 })
    expect(Object.keys(f).sort()).toEqual(
      [
        'comparator',
        'id',
        'label',
        'metric',
        'openedAt',
        'resolvedAt',
        'ruleId',
        'source',
        'threshold',
        'value',
      ].sort(),
    )
  })
})
