/**
 * Phase 17 (Sprint 4) — usage / cost ledger (LedgerStore via IdentityStore).
 *
 * Coverage:
 *   - append: assigns id + default ts, round-trips every field, defaults
 *     (cache/meta/attribution) to 0 / null, accepts unattributed rows
 *   - append validation: missing agentId / model, negative tokens / cost,
 *     non-object meta, oversized meta
 *   - query: filter by user / agent / workflow / model, half-open
 *     [since, until) window, newest-first (id DESC), limit clamp + offset
 *   - aggregate: groupBy user / model / day, SUM tokens + cost, COUNT
 *     calls, '(none)' bucket for null group, cost-DESC order, bad groupBy
 *
 * Timestamps are passed explicitly so the day-bucketing + window tests
 * are wall-clock independent. The ledger has no FK to users, so plain
 * string ids stand in for attribution.
 */

import { describe, expect, it, beforeEach } from 'vitest'

import { IdentityError, IdentityStore, openIdentityStore } from '../src/index.js'

// Mid-day anchors on two distinct UTC calendar days.
const D15 = Date.UTC(2026, 3, 15, 10, 0, 0) // 2026-04-15
const D16 = Date.UTC(2026, 3, 16, 9, 0, 0) // 2026-04-16

describe('IdentityStore — usage/cost ledger (Phase 17)', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:' })
  })

  it('append assigns id + resolved ts and round-trips a full row', () => {
    const entry = store.appendLedger({
      ts: D15,
      orgId: 'org-1',
      userId: 'user-a',
      agentId: 'agent-x',
      workflowId: 'wf-1',
      taskId: 'task-1',
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 50,
      cacheReadTokens: 30,
      costMicros: 18_500,
      unpriced: false,
      meta: { stopReason: 'end_turn', toolRounds: 2 },
    })
    expect(entry.id).toBeGreaterThan(0)
    expect(entry.ts).toBe(D15)
    expect(entry.orgId).toBe('org-1')
    expect(entry.userId).toBe('user-a')
    expect(entry.agentId).toBe('agent-x')
    expect(entry.workflowId).toBe('wf-1')
    expect(entry.taskId).toBe('task-1')
    expect(entry.model).toBe('claude-opus-4-8')
    expect(entry.provider).toBe('anthropic')
    expect(entry.inputTokens).toBe(1000)
    expect(entry.outputTokens).toBe(200)
    expect(entry.cacheCreationTokens).toBe(50)
    expect(entry.cacheReadTokens).toBe(30)
    expect(entry.costMicros).toBe(18_500)
    expect(entry.unpriced).toBe(false)
    expect(entry.meta).toEqual({ stopReason: 'end_turn', toolRounds: 2 })

    const back = store.queryLedger({ userId: 'user-a' })
    expect(back).toHaveLength(1)
    expect(back[0]).toEqual(entry)
  })

  it('defaults cache / meta / attribution and accepts unattributed rows', () => {
    const entry = store.appendLedger({
      ts: D15,
      agentId: 'agent-x',
      model: 'mock-model',
      inputTokens: 10,
      outputTokens: 5,
      costMicros: 0,
      unpriced: true,
    })
    expect(entry.orgId).toBeNull()
    expect(entry.userId).toBeNull()
    expect(entry.workflowId).toBeNull()
    expect(entry.taskId).toBeNull()
    expect(entry.provider).toBeNull()
    expect(entry.cacheCreationTokens).toBe(0)
    expect(entry.cacheReadTokens).toBe(0)
    expect(entry.unpriced).toBe(true)
    expect(entry.meta).toBeNull()
  })

  it('append resolves ts to a number when omitted', () => {
    const before = Date.now()
    const entry = store.appendLedger({
      agentId: 'a',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      costMicros: 1,
    })
    expect(entry.ts).toBeGreaterThanOrEqual(before)
  })

  it('rejects bad append input', () => {
    const base = {
      agentId: 'a',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      costMicros: 1,
    }
    expect(() => store.appendLedger({ ...base, agentId: '' })).toThrow(
      IdentityError,
    )
    expect(() => store.appendLedger({ ...base, model: '' })).toThrow(
      IdentityError,
    )
    expect(() =>
      store.appendLedger({ ...base, inputTokens: -1 }),
    ).toThrow(IdentityError)
    expect(() =>
      store.appendLedger({ ...base, outputTokens: 1.5 }),
    ).toThrow(IdentityError)
    expect(() => store.appendLedger({ ...base, costMicros: -5 })).toThrow(
      IdentityError,
    )
    // meta must be a plain object
    expect(() =>
      store.appendLedger({ ...base, meta: [1, 2, 3] as unknown as Record<string, unknown> }),
    ).toThrow(IdentityError)
    // oversized meta (> 8KB serialised)
    const big = { blob: 'x'.repeat(9000) }
    expect(() => store.appendLedger({ ...base, meta: big })).toThrow(
      IdentityError,
    )
  })

  describe('query filters', () => {
    beforeEach(() => {
      store.appendLedger({ ts: D15, userId: 'u1', agentId: 'a1', workflowId: 'wf1', model: 'opus', inputTokens: 100, outputTokens: 10, costMicros: 1000 })
      store.appendLedger({ ts: D15 + 1000, userId: 'u2', agentId: 'a1', workflowId: 'wf2', model: 'sonnet', inputTokens: 200, outputTokens: 20, costMicros: 500 })
      store.appendLedger({ ts: D16, userId: 'u1', agentId: 'a2', workflowId: 'wf1', model: 'opus', inputTokens: 300, outputTokens: 30, costMicros: 2000 })
    })

    it('filters by userId', () => {
      const rows = store.queryLedger({ userId: 'u1' })
      expect(rows.map((r) => r.userId)).toEqual(['u1', 'u1'])
    })

    it('filters by agentId', () => {
      expect(store.queryLedger({ agentId: 'a1' })).toHaveLength(2)
      expect(store.queryLedger({ agentId: 'a2' })).toHaveLength(1)
    })

    it('filters by workflowId and model', () => {
      expect(store.queryLedger({ workflowId: 'wf1' })).toHaveLength(2)
      expect(store.queryLedger({ model: 'sonnet' })).toHaveLength(1)
    })

    it('applies a half-open [since, until) window', () => {
      // [D15, D16) excludes the D16 row but includes both D15 rows.
      const rows = store.queryLedger({ since: D15, until: D16 })
      expect(rows).toHaveLength(2)
      expect(rows.every((r) => r.ts >= D15 && r.ts < D16)).toBe(true)
    })

    it('returns newest-first (id DESC)', () => {
      const rows = store.queryLedger({})
      // Insert order was D15, D15+1000, D16; id DESC ⇒ last-inserted first.
      expect(rows[0].ts).toBe(D16)
      expect(rows[2].ts).toBe(D15)
    })

    it('honours limit + offset', () => {
      const page1 = store.queryLedger({ limit: 2, offset: 0 })
      const page2 = store.queryLedger({ limit: 2, offset: 2 })
      expect(page1).toHaveLength(2)
      expect(page2).toHaveLength(1)
      // No overlap between pages.
      expect(page1.map((r) => r.id)).not.toContain(page2[0].id)
    })
  })

  describe('aggregate', () => {
    beforeEach(() => {
      store.appendLedger({ ts: D15, userId: 'u1', agentId: 'a1', model: 'opus', inputTokens: 100, outputTokens: 10, costMicros: 1000 })
      store.appendLedger({ ts: D15, userId: 'u1', agentId: 'a1', model: 'opus', inputTokens: 200, outputTokens: 20, costMicros: 3000 })
      store.appendLedger({ ts: D16, userId: 'u2', agentId: 'a2', model: 'sonnet', inputTokens: 50, outputTokens: 5, costMicros: 500 })
      // Unattributed row — null userId collapses to '(none)' bucket.
      store.appendLedger({ ts: D16, agentId: 'a2', model: 'sonnet', inputTokens: 1, outputTokens: 1, costMicros: 0 })
    })

    it('groups by user with summed tokens + cost and call counts', () => {
      const rows = store.aggregateLedger({ groupBy: 'user' })
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
      expect(byKey['u1'].calls).toBe(2)
      expect(byKey['u1'].inputTokens).toBe(300)
      expect(byKey['u1'].outputTokens).toBe(30)
      expect(byKey['u1'].costMicros).toBe(4000)
      expect(byKey['u2'].calls).toBe(1)
      expect(byKey['(none)'].calls).toBe(1)
      expect(byKey['(none)'].costMicros).toBe(0)
    })

    it('orders aggregate buckets by cost DESC', () => {
      const rows = store.aggregateLedger({ groupBy: 'user' })
      const costs = rows.map((r) => r.costMicros)
      const sorted = [...costs].sort((a, b) => b - a)
      expect(costs).toEqual(sorted)
      expect(rows[0].key).toBe('u1') // highest spend
    })

    it('groups by model', () => {
      const rows = store.aggregateLedger({ groupBy: 'model' })
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
      expect(byKey['opus'].calls).toBe(2)
      expect(byKey['opus'].costMicros).toBe(4000)
      expect(byKey['sonnet'].calls).toBe(2)
    })

    it('groups by UTC day', () => {
      const rows = store.aggregateLedger({ groupBy: 'day' })
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
      expect(byKey['2026-04-15'].calls).toBe(2)
      expect(byKey['2026-04-16'].calls).toBe(2)
    })

    it('honours the [since, until) window in aggregates', () => {
      const rows = store.aggregateLedger({ groupBy: 'day', since: D16 })
      expect(rows).toHaveLength(1)
      expect(rows[0].key).toBe('2026-04-16')
    })

    it('rejects an unknown groupBy axis', () => {
      expect(() =>
        store.aggregateLedger({ groupBy: 'nope' as never }),
      ).toThrow(IdentityError)
    })
  })
})

describe('IdentityStore — ledger peer attribution (Phase 19 P4-M2)', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:' })
  })

  it('round-trips peerId and defaults it to null when omitted (local usage)', () => {
    const fed = store.appendLedger({
      orgId: 'remote-org',
      userId: 'remote-user',
      peerId: 'peer-row-1',
      agentId: 'agent-x',
      model: 'm',
      inputTokens: 10,
      outputTokens: 5,
      costMicros: 100,
    })
    expect(fed.peerId).toBe('peer-row-1')

    const local = store.appendLedger({
      userId: 'local-user',
      agentId: 'agent-y',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      costMicros: 0,
    })
    expect(local.peerId).toBeNull()
  })

  it('filters rows by peerId (cross-org usage isolation)', () => {
    store.appendLedger({ peerId: 'peer-a', agentId: 'a', model: 'm', inputTokens: 1, outputTokens: 1, costMicros: 10 })
    store.appendLedger({ peerId: 'peer-b', agentId: 'a', model: 'm', inputTokens: 1, outputTokens: 1, costMicros: 20 })
    store.appendLedger({ agentId: 'a', model: 'm', inputTokens: 1, outputTokens: 1, costMicros: 30 }) // local

    const onlyA = store.queryLedger({ peerId: 'peer-a' })
    expect(onlyA).toHaveLength(1)
    expect(onlyA[0].peerId).toBe('peer-a')
    expect(onlyA[0].costMicros).toBe(10)
  })

  it('aggregates by peer, collapsing local usage to the (none) bucket', () => {
    store.appendLedger({ peerId: 'peer-a', agentId: 'a', model: 'm', inputTokens: 0, outputTokens: 0, costMicros: 10 })
    store.appendLedger({ peerId: 'peer-a', agentId: 'a', model: 'm', inputTokens: 0, outputTokens: 0, costMicros: 5 })
    store.appendLedger({ agentId: 'a', model: 'm', inputTokens: 0, outputTokens: 0, costMicros: 7 }) // local → null

    const rows = store.aggregateLedger({ groupBy: 'peer' })
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
    expect(byKey['peer-a'].calls).toBe(2)
    expect(byKey['peer-a'].costMicros).toBe(15)
    expect(byKey['(none)'].calls).toBe(1)
    expect(byKey['(none)'].costMicros).toBe(7)
  })
})

describe('IdentityStore — ledger retention / prune (Route B P0-M3-M4)', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:' })
  })

  /** Seed three rows on three distinct days (D15 < D16 < D17). */
  const D17 = Date.UTC(2026, 3, 17, 9, 0, 0) // 2026-04-17
  function seedThreeDays(): void {
    for (const ts of [D15, D16, D17]) {
      store.appendLedger({ ts, agentId: 'a', model: 'm', inputTokens: 1, outputTokens: 1, costMicros: 10 })
    }
  }

  it('deletes rows older than `before` (half-open) and returns the count', () => {
    seedThreeDays()
    // Cutoff at D16: D15 is older (deleted), D16 itself is RETAINED (ts < before
    // is half-open), D17 is newer (retained).
    const removed = store.pruneLedger({ before: D16 })
    expect(removed).toBe(1)

    const kept = store.queryLedger({})
    expect(kept.map((e) => e.ts).sort()).toEqual([D16, D17])
  })

  it('retained window stays queryable/exportable after prune', () => {
    seedThreeDays()
    store.pruneLedger({ before: D17 }) // drop D15 + D16, keep only D17
    const kept = store.queryLedger({})
    expect(kept).toHaveLength(1)
    expect(kept[0].ts).toBe(D17)
    // And aggregate (which backs the CSV/JSONL export) sees only the kept row.
    const agg = store.aggregateLedger({ groupBy: 'day' })
    expect(agg).toHaveLength(1)
    expect(agg[0].calls).toBe(1)
  })

  it('leaves the audit_log compliance trail untouched (separate table)', () => {
    seedThreeDays()
    store.writeAuditLog({ action: 'login_success', actorSource: 'v4-session' })
    expect(store.pruneLedger({ before: D17 })).toBe(2) // prunes 2 ledger rows
    // The audit row predates nothing in the ledger window — prune must not
    // reach into audit_log at all.
    expect(store.listAuditLog()).toHaveLength(1)
  })

  it('is a no-op (0 removed) when nothing is older than the cutoff', () => {
    seedThreeDays()
    expect(store.pruneLedger({ before: D15 })).toBe(0) // D15 itself is half-open-retained
    expect(store.queryLedger({})).toHaveLength(3)
  })

  it('validates the cutoff — missing / negative / non-integer throws', () => {
    expect(() => store.pruneLedger({} as { before: number })).toThrow(IdentityError)
    expect(() => store.pruneLedger({ before: -1 })).toThrow(IdentityError)
    expect(() => store.pruneLedger({ before: 1.5 })).toThrow(IdentityError)
  })
})
