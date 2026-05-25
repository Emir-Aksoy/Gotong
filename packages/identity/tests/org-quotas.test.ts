/**
 * E1 — per-org soft quotas + aggregation.
 *
 * Coverage:
 *   - sumUsage: across multiple users, period boundary discipline
 *     ('current period' only), 'total' lifetime, missing metric → 0
 *   - setOrgQuota: create / update preserves last_state / warnPct default
 *     / warnPct preservation on update / rejects invalid input
 *   - getOrgQuota / listOrgQuotas / deleteOrgQuota basic CRUD
 *   - checkOrgQuotaThreshold:
 *     - state thresholds (ok / warn / over) at boundaries
 *     - custom warnPct
 *     - transitioned bit fires exactly on state change
 *     - repeated check at same state → transitioned=false
 *     - period roll resets transitions to ok
 *     - quota=0 degenerate case
 *     - throws when no quota configured
 *
 * Time is passed explicitly via `now` for deterministic period boundaries.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  IdentityError,
  IdentityStore,
  openIdentityStore,
} from '../src/index.js'

describe('IdentityStore — org quotas (E1)', () => {
  let store: IdentityStore
  let userA: string
  let userB: string
  let userC: string

  // Same anchor as usage.test.ts — strictly mid-period for every UTC bucket.
  const NOW = Date.UTC(2026, 3, 15, 10, 30, 0)
  const HOUR_START = Date.UTC(2026, 3, 15, 10, 0, 0)
  const DAY_START = Date.UTC(2026, 3, 15, 0, 0, 0)
  const NEXT_DAY = Date.UTC(2026, 3, 16, 0, 0, 0)
  const NEXT_DAY_MID = Date.UTC(2026, 3, 16, 10, 30, 0)
  void HOUR_START // referenced below

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:' })
    userA = store.createUser({
      email: 'a@e1.test',
      displayName: 'A',
      role: 'member',
    }).id
    userB = store.createUser({
      email: 'b@e1.test',
      displayName: 'B',
      role: 'member',
    }).id
    userC = store.createUser({
      email: 'c@e1.test',
      displayName: 'C',
      role: 'member',
    }).id
  })

  afterEach(() => {
    store.close()
  })

  // ---------- sumUsage ----------

  describe('sumUsage', () => {
    it('aggregates across all users in the current period', () => {
      store.checkAndIncrement({
        userId: userA,
        metric: 'llm_requests',
        period: 'daily',
        amount: 30,
        now: NOW,
      })
      store.checkAndIncrement({
        userId: userB,
        metric: 'llm_requests',
        period: 'daily',
        amount: 17,
        now: NOW,
      })
      store.checkAndIncrement({
        userId: userC,
        metric: 'llm_requests',
        period: 'daily',
        amount: 5,
        now: NOW,
      })
      expect(store.sumUsage('llm_requests', 'daily', NOW)).toBe(52)
    })

    it('returns 0 for an unconfigured metric', () => {
      expect(store.sumUsage('nonexistent_metric', 'daily', NOW)).toBe(0)
    })

    it('ignores rows whose period_start is stale (different boundary)', () => {
      // userA's row is from "yesterday".
      store.checkAndIncrement({
        userId: userA,
        metric: 'llm_requests',
        period: 'daily',
        amount: 1000,
        now: NOW,
      })
      // Sum at NEXT_DAY_MID — userA's row is now a "stale" period_start
      // that hasn't been swept. It should NOT contribute.
      expect(
        store.sumUsage('llm_requests', 'daily', NEXT_DAY_MID),
      ).toBe(0)
      // After sweep at NEXT_DAY_MID, userA's row is back to 0 for the
      // current period — sum remains 0.
      store.sweepUsageCounters(NEXT_DAY_MID)
      expect(
        store.sumUsage('llm_requests', 'daily', NEXT_DAY_MID),
      ).toBe(0)
      // New activity at NEXT_DAY_MID contributes normally.
      store.checkAndIncrement({
        userId: userB,
        metric: 'llm_requests',
        period: 'daily',
        amount: 7,
        now: NEXT_DAY_MID,
      })
      expect(
        store.sumUsage('llm_requests', 'daily', NEXT_DAY_MID),
      ).toBe(7)
    })

    it("'total' period sums every row regardless of period_start", () => {
      store.checkAndIncrement({
        userId: userA,
        metric: 'llm_tokens_in',
        period: 'total',
        amount: 100,
        now: NOW,
      })
      store.checkAndIncrement({
        userId: userB,
        metric: 'llm_tokens_in',
        period: 'total',
        amount: 250,
        now: NEXT_DAY_MID, // different "wall clock" — irrelevant for total
      })
      expect(store.sumUsage('llm_tokens_in', 'total', NEXT_DAY_MID)).toBe(350)
    })
  })

  // ---------- setOrgQuota CRUD ----------

  describe('setOrgQuota / getOrgQuota / listOrgQuotas / deleteOrgQuota', () => {
    it('creates a row with default warnPct=80 and lastState=ok', () => {
      const got = store.setOrgQuota(
        { metric: 'llm_requests', period: 'daily', quota: 1000 },
        NOW,
      )
      expect(got).toEqual({
        metric: 'llm_requests',
        period: 'daily',
        quota: 1000,
        warnPct: 80,
        lastState: 'ok',
        lastChecked: null,
        createdAt: NOW,
        updatedAt: NOW,
      })
    })

    it('respects custom warnPct', () => {
      const got = store.setOrgQuota(
        { metric: 'llm_requests', period: 'daily', quota: 1000, warnPct: 50 },
        NOW,
      )
      expect(got.warnPct).toBe(50)
    })

    it('update preserves warnPct when omitted', () => {
      store.setOrgQuota(
        { metric: 'llm_requests', period: 'daily', quota: 1000, warnPct: 50 },
        NOW,
      )
      const updated = store.setOrgQuota(
        { metric: 'llm_requests', period: 'daily', quota: 2000 },
        NOW + 1000,
      )
      expect(updated.quota).toBe(2000)
      expect(updated.warnPct).toBe(50) // preserved
    })

    it('rejects negative quota / non-integer / NaN', () => {
      expect(() =>
        store.setOrgQuota({ metric: 'm', period: 'daily', quota: -1 }, NOW),
      ).toThrow(IdentityError)
      expect(() =>
        store.setOrgQuota({ metric: 'm', period: 'daily', quota: 1.5 }, NOW),
      ).toThrow(IdentityError)
      expect(() =>
        store.setOrgQuota(
          { metric: 'm', period: 'daily', quota: Number.NaN },
          NOW,
        ),
      ).toThrow(IdentityError)
    })

    it('rejects warnPct outside [1, 99]', () => {
      expect(() =>
        store.setOrgQuota(
          { metric: 'm', period: 'daily', quota: 100, warnPct: 0 },
          NOW,
        ),
      ).toThrow(IdentityError)
      expect(() =>
        store.setOrgQuota(
          { metric: 'm', period: 'daily', quota: 100, warnPct: 100 },
          NOW,
        ),
      ).toThrow(IdentityError)
      expect(() =>
        store.setOrgQuota(
          { metric: 'm', period: 'daily', quota: 100, warnPct: 50.5 },
          NOW,
        ),
      ).toThrow(IdentityError)
    })

    it('getOrgQuota returns null for missing tuple', () => {
      expect(store.getOrgQuota('nope', 'daily')).toBeNull()
    })

    it('listOrgQuotas returns ordered rows', () => {
      store.setOrgQuota({ metric: 'b', period: 'daily', quota: 1 }, NOW)
      store.setOrgQuota({ metric: 'a', period: 'monthly', quota: 1 }, NOW)
      store.setOrgQuota({ metric: 'a', period: 'daily', quota: 1 }, NOW)
      const list = store.listOrgQuotas()
      expect(list.map((q) => `${q.metric}/${q.period}`)).toEqual([
        'a/daily',
        'a/monthly',
        'b/daily',
      ])
    })

    it('deleteOrgQuota returns true on hit, false on miss', () => {
      store.setOrgQuota({ metric: 'a', period: 'daily', quota: 1 }, NOW)
      expect(store.deleteOrgQuota('a', 'daily')).toBe(true)
      expect(store.deleteOrgQuota('a', 'daily')).toBe(false)
      expect(store.getOrgQuota('a', 'daily')).toBeNull()
    })
  })

  // ---------- checkOrgQuotaThreshold ----------

  describe('checkOrgQuotaThreshold', () => {
    it('returns ok state when usage below warnPct', () => {
      store.setOrgQuota(
        { metric: 'm', period: 'daily', quota: 100, warnPct: 80 },
        NOW,
      )
      store.checkAndIncrement({
        userId: userA,
        metric: 'm',
        period: 'daily',
        amount: 79,
        now: NOW,
      })
      const r = store.checkOrgQuotaThreshold('m', 'daily', NOW)
      expect(r.state).toBe('ok')
      expect(r.usage).toBe(79)
      expect(r.pct).toBe(79)
      expect(r.previousState).toBe('ok') // initial state
      expect(r.transitioned).toBe(false) // ok → ok
    })

    it('transitions ok → warn exactly at warnPct boundary', () => {
      store.setOrgQuota(
        { metric: 'm', period: 'daily', quota: 100, warnPct: 80 },
        NOW,
      )
      store.checkAndIncrement({
        userId: userA,
        metric: 'm',
        period: 'daily',
        amount: 80,
        now: NOW,
      })
      const r = store.checkOrgQuotaThreshold('m', 'daily', NOW)
      expect(r.state).toBe('warn')
      expect(r.pct).toBe(80)
      expect(r.previousState).toBe('ok')
      expect(r.transitioned).toBe(true)
    })

    it('transitions warn → over exactly at 100%', () => {
      store.setOrgQuota(
        { metric: 'm', period: 'daily', quota: 100, warnPct: 80 },
        NOW,
      )
      // Get to warn first.
      store.checkAndIncrement({
        userId: userA,
        metric: 'm',
        period: 'daily',
        amount: 80,
        now: NOW,
      })
      const r1 = store.checkOrgQuotaThreshold('m', 'daily', NOW)
      expect(r1.state).toBe('warn')
      // Push to over.
      store.checkAndIncrement({
        userId: userB,
        metric: 'm',
        period: 'daily',
        amount: 20,
        now: NOW,
      })
      const r2 = store.checkOrgQuotaThreshold('m', 'daily', NOW)
      expect(r2.state).toBe('over')
      expect(r2.pct).toBe(100)
      expect(r2.previousState).toBe('warn')
      expect(r2.transitioned).toBe(true)
    })

    it('repeated check at same state → transitioned=false', () => {
      store.setOrgQuota(
        { metric: 'm', period: 'daily', quota: 100 },
        NOW,
      )
      store.checkAndIncrement({
        userId: userA,
        metric: 'm',
        period: 'daily',
        amount: 85,
        now: NOW,
      })
      // First check: transition ok → warn.
      const r1 = store.checkOrgQuotaThreshold('m', 'daily', NOW)
      expect(r1.transitioned).toBe(true)
      expect(r1.state).toBe('warn')
      // Second check: no usage change; still warn.
      const r2 = store.checkOrgQuotaThreshold('m', 'daily', NOW + 1000)
      expect(r2.transitioned).toBe(false)
      expect(r2.state).toBe('warn')
      expect(r2.previousState).toBe('warn')
    })

    it('period roll: warn → ok transition after day boundary + sweep', () => {
      store.setOrgQuota(
        { metric: 'm', period: 'daily', quota: 100 },
        NOW,
      )
      store.checkAndIncrement({
        userId: userA,
        metric: 'm',
        period: 'daily',
        amount: 95,
        now: NOW,
      })
      const r1 = store.checkOrgQuotaThreshold('m', 'daily', NOW)
      expect(r1.state).toBe('warn')
      // Next day: sweep, then check.
      store.sweepUsageCounters(NEXT_DAY_MID)
      const r2 = store.checkOrgQuotaThreshold('m', 'daily', NEXT_DAY_MID)
      expect(r2.usage).toBe(0)
      expect(r2.state).toBe('ok')
      expect(r2.previousState).toBe('warn')
      expect(r2.transitioned).toBe(true)
    })

    it('respects custom warnPct (50%)', () => {
      store.setOrgQuota(
        { metric: 'm', period: 'daily', quota: 100, warnPct: 50 },
        NOW,
      )
      store.checkAndIncrement({
        userId: userA,
        metric: 'm',
        period: 'daily',
        amount: 49,
        now: NOW,
      })
      expect(store.checkOrgQuotaThreshold('m', 'daily', NOW).state).toBe('ok')
      store.checkAndIncrement({
        userId: userA,
        metric: 'm',
        period: 'daily',
        amount: 1,
        now: NOW,
      })
      // Now at 50 — should flip to warn.
      const r = store.checkOrgQuotaThreshold('m', 'daily', NOW)
      expect(r.state).toBe('warn')
      expect(r.pct).toBe(50)
    })

    it('quota=0 → over on any positive usage, ok on zero', () => {
      store.setOrgQuota(
        { metric: 'm', period: 'daily', quota: 0 },
        NOW,
      )
      const r0 = store.checkOrgQuotaThreshold('m', 'daily', NOW)
      expect(r0.state).toBe('ok')
      expect(r0.pct).toBe(0)
      store.checkAndIncrement({
        userId: userA,
        metric: 'm',
        period: 'daily',
        amount: 1,
        now: NOW,
      })
      const r1 = store.checkOrgQuotaThreshold('m', 'daily', NOW)
      expect(r1.state).toBe('over')
      expect(r1.pct).toBe(999) // clamped sentinel
    })

    it('throws org_quota_not_found when no quota configured', () => {
      try {
        store.checkOrgQuotaThreshold('not_configured', 'daily', NOW)
        throw new Error('expected throw')
      } catch (err) {
        expect((err as IdentityError).code).toBe('org_quota_not_found')
      }
    })

    it('lastChecked is updated on every call even without transition', () => {
      store.setOrgQuota(
        { metric: 'm', period: 'daily', quota: 100 },
        NOW,
      )
      // First check at NOW.
      store.checkOrgQuotaThreshold('m', 'daily', NOW)
      const q1 = store.getOrgQuota('m', 'daily')!
      expect(q1.lastChecked).toBe(NOW)
      // Second check at NOW+5000 — same state ok→ok, but lastChecked moves.
      store.checkOrgQuotaThreshold('m', 'daily', NOW + 5000)
      const q2 = store.getOrgQuota('m', 'daily')!
      expect(q2.lastChecked).toBe(NOW + 5000)
    })
  })

  // ---------- input validation ----------

  describe('input validation', () => {
    it('rejects unknown period in sumUsage', () => {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store.sumUsage('m', 'bogus' as any, NOW),
      ).toThrow(IdentityError)
    })

    it('rejects empty metric in setOrgQuota', () => {
      expect(() =>
        store.setOrgQuota({ metric: '', period: 'daily', quota: 1 }, NOW),
      ).toThrow(IdentityError)
    })
  })
})
