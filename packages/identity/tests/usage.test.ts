/**
 * B2.1 — usage_counters / quota API.
 *
 * Coverage:
 *   - setQuota: create row / update existing without resetting used /
 *     clear via quota=null / reject bad input
 *   - listUsage: filter combinations
 *   - checkAndIncrement: increment + quota enforcement + exceededBy
 *     reporting + amount=0 peek + transactional non-commit on exceed
 *   - period roll: hourly / daily / monthly boundary crossing
 *   - 'total' period: never rolls
 *   - resetUsage: zero used + advance period_start / null when missing
 *   - boundary validation: empty userId / metric / bad period / amount<0
 *
 * Time is passed explicitly via `now` so tests don't race the wall clock.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  IdentityError,
  IdentityStore,
  openIdentityStore,
} from '../src/index.js'

describe('IdentityStore — usage counters (B2.1)', () => {
  let store: IdentityStore
  let userId: string

  // Anchor used by every period test. 2026-04-15 10:30 UTC — strictly
  // mid-period for hourly / daily / monthly so the boundaries below
  // are unambiguous.
  const NOW = Date.UTC(2026, 3, 15, 10, 30, 0)
  const HOUR_START = Date.UTC(2026, 3, 15, 10, 0, 0)
  const DAY_START = Date.UTC(2026, 3, 15, 0, 0, 0)
  const MONTH_START = Date.UTC(2026, 3, 1, 0, 0, 0)

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:' })
    const u = store.createUser({
      email: 'quota-target@test.local',
      displayName: 'Quota Target',
      role: 'member',
    })
    userId = u.id
  })

  afterEach(() => {
    store.close()
  })

  // ---------- setQuota ----------

  describe('setQuota', () => {
    it('creates a row when none exists, with used=0 and the requested cap', () => {
      const got = store.setQuota(
        { userId, metric: 'llm_requests', period: 'daily', quota: 100 },
        NOW,
      )
      expect(got).toEqual({
        userId,
        metric: 'llm_requests',
        period: 'daily',
        periodStart: DAY_START,
        used: 0,
        quota: 100,
        updatedAt: NOW,
      })
    })

    it('updates an existing row WITHOUT resetting used (cap raise must not refund usage)', () => {
      // Seed some usage.
      store.checkAndIncrement({
        userId,
        metric: 'llm_requests',
        period: 'daily',
        amount: 40,
        now: NOW,
      })
      // Raise the cap.
      const after = store.setQuota(
        { userId, metric: 'llm_requests', period: 'daily', quota: 200 },
        NOW + 5,
      )
      expect(after.used).toBe(40) // preserved
      expect(after.quota).toBe(200)
      expect(after.updatedAt).toBe(NOW + 5)
    })

    it('quota=null removes the cap (counter still ticks)', () => {
      store.setQuota(
        { userId, metric: 'llm_tokens_in', period: 'monthly', quota: 1000 },
        NOW,
      )
      const cleared = store.setQuota(
        { userId, metric: 'llm_tokens_in', period: 'monthly', quota: null },
        NOW + 1,
      )
      expect(cleared.quota).toBeNull()
      // Increment by a huge amount — should be allowed (unlimited).
      const r = store.checkAndIncrement({
        userId,
        metric: 'llm_tokens_in',
        period: 'monthly',
        amount: 999_999,
        now: NOW + 2,
      })
      expect(r.allowed).toBe(true)
      expect(r.counter.used).toBe(999_999)
    })

    it('rejects negative / non-integer / NaN quota', () => {
      const bad = (q: unknown): void => {
        store.setQuota(
          {
            userId,
            metric: 'llm_requests',
            period: 'daily',
            quota: q as number | null,
          },
          NOW,
        )
      }
      expect(() => bad(-1)).toThrow(IdentityError)
      expect(() => bad(1.5)).toThrow(IdentityError)
      expect(() => bad(NaN)).toThrow(IdentityError)
      expect(() => bad('100')).toThrow(IdentityError)
    })
  })

  // ---------- listUsage ----------

  describe('listUsage', () => {
    beforeEach(() => {
      // 3 metrics × 2 periods grid for this user.
      for (const metric of ['llm_requests', 'llm_tokens_in', 'mcp_calls']) {
        for (const period of ['daily', 'monthly'] as const) {
          store.setQuota({ userId, metric, period, quota: 50 }, NOW)
        }
      }
    })

    it('userId only returns every counter for that user', () => {
      expect(store.listUsage({ userId }).length).toBe(6)
    })

    it('filter by metric narrows to that metric across periods', () => {
      const rows = store.listUsage({ userId, metric: 'llm_requests' })
      expect(rows.length).toBe(2)
      expect(rows.map((r) => r.period).sort()).toEqual(['daily', 'monthly'])
    })

    it('filter by period narrows across metrics', () => {
      const rows = store.listUsage({ userId, period: 'daily' })
      expect(rows.length).toBe(3)
      expect(rows.every((r) => r.period === 'daily')).toBe(true)
    })

    it('triple-filter returns at most one row', () => {
      const rows = store.listUsage({
        userId,
        metric: 'mcp_calls',
        period: 'monthly',
      })
      expect(rows.length).toBe(1)
      expect(rows[0]!.metric).toBe('mcp_calls')
      expect(rows[0]!.period).toBe('monthly')
    })

    it('returns [] when nothing matches', () => {
      expect(
        store.listUsage({ userId, metric: 'nonexistent', period: 'daily' }),
      ).toEqual([])
    })
  })

  // ---------- checkAndIncrement: basic ----------

  describe('checkAndIncrement', () => {
    it('creates a row on first call when none exists', () => {
      const r = store.checkAndIncrement({
        userId,
        metric: 'llm_requests',
        period: 'daily',
        now: NOW,
      })
      expect(r.allowed).toBe(true)
      expect(r.counter.used).toBe(1)
      expect(r.counter.quota).toBeNull() // no setQuota first → unlimited
      expect(r.counter.periodStart).toBe(DAY_START)
    })

    it('respects amount > 1 for batched increments', () => {
      store.setQuota(
        { userId, metric: 'llm_tokens_in', period: 'daily', quota: 1000 },
        NOW,
      )
      const r = store.checkAndIncrement({
        userId,
        metric: 'llm_tokens_in',
        period: 'daily',
        amount: 250,
        now: NOW,
      })
      expect(r.allowed).toBe(true)
      expect(r.counter.used).toBe(250)
    })

    it('returns allowed=false + exceededBy when the increment would breach quota; does NOT commit used', () => {
      store.setQuota(
        { userId, metric: 'llm_requests', period: 'daily', quota: 10 },
        NOW,
      )
      // Get to 8.
      store.checkAndIncrement({
        userId,
        metric: 'llm_requests',
        period: 'daily',
        amount: 8,
        now: NOW,
      })
      // Try to add 5 — would land at 13, over the cap by 3.
      const blocked = store.checkAndIncrement({
        userId,
        metric: 'llm_requests',
        period: 'daily',
        amount: 5,
        now: NOW + 1,
      })
      expect(blocked.allowed).toBe(false)
      expect(blocked.exceededBy).toBe(3)
      // Critical: used stays at 8 — failure is non-committing.
      expect(blocked.counter.used).toBe(8)

      // And a subsequent small increment within the remaining budget
      // still works.
      const ok = store.checkAndIncrement({
        userId,
        metric: 'llm_requests',
        period: 'daily',
        amount: 2,
        now: NOW + 2,
      })
      expect(ok.allowed).toBe(true)
      expect(ok.counter.used).toBe(10)
    })

    it('allowed=true at the exact cap (boundary is inclusive)', () => {
      store.setQuota(
        { userId, metric: 'llm_requests', period: 'daily', quota: 10 },
        NOW,
      )
      const r = store.checkAndIncrement({
        userId,
        metric: 'llm_requests',
        period: 'daily',
        amount: 10,
        now: NOW,
      })
      expect(r.allowed).toBe(true)
      expect(r.counter.used).toBe(10)
    })

    it('amount=0 is a peek (rolls expired period without committing)', () => {
      store.setQuota(
        { userId, metric: 'llm_requests', period: 'hourly', quota: 5 },
        NOW,
      )
      store.checkAndIncrement({
        userId,
        metric: 'llm_requests',
        period: 'hourly',
        amount: 3,
        now: NOW,
      })
      const peeked = store.checkAndIncrement({
        userId,
        metric: 'llm_requests',
        period: 'hourly',
        amount: 0,
        now: NOW + 1,
      })
      expect(peeked.allowed).toBe(true)
      expect(peeked.counter.used).toBe(3) // unchanged by the peek
    })

    it('rejects negative amount', () => {
      expect(() =>
        store.checkAndIncrement({
          userId,
          metric: 'llm_requests',
          period: 'daily',
          amount: -1,
          now: NOW,
        }),
      ).toThrow(/non-negative integer/)
    })
  })

  // ---------- checkAndIncrement: period rolls ----------

  describe('checkAndIncrement period roll', () => {
    it('rolls when crossing an hourly boundary (resets used to 0)', () => {
      store.setQuota(
        { userId, metric: 'llm_requests', period: 'hourly', quota: 5 },
        NOW,
      )
      store.checkAndIncrement({
        userId,
        metric: 'llm_requests',
        period: 'hourly',
        amount: 5,
        now: NOW,
      })
      // Jump to next hour — should roll. The cap was reached, so a
      // post-roll increment of 1 must succeed (fresh budget).
      const NEXT_HOUR = HOUR_START + 3_600_000 + 5 * 60_000 // 11:05 UTC
      const r = store.checkAndIncrement({
        userId,
        metric: 'llm_requests',
        period: 'hourly',
        amount: 1,
        now: NEXT_HOUR,
      })
      expect(r.allowed).toBe(true)
      expect(r.counter.used).toBe(1)
      expect(r.counter.periodStart).toBe(HOUR_START + 3_600_000)
    })

    it('rolls when crossing a daily boundary', () => {
      store.setQuota(
        { userId, metric: 'llm_requests', period: 'daily', quota: 5 },
        NOW,
      )
      store.checkAndIncrement({
        userId,
        metric: 'llm_requests',
        period: 'daily',
        amount: 5,
        now: NOW,
      })
      const NEXT_DAY = DAY_START + 86_400_000 + 8 * 3_600_000 // next-day 08:00 UTC
      const r = store.checkAndIncrement({
        userId,
        metric: 'llm_requests',
        period: 'daily',
        amount: 1,
        now: NEXT_DAY,
      })
      expect(r.allowed).toBe(true)
      expect(r.counter.used).toBe(1)
      expect(r.counter.periodStart).toBe(DAY_START + 86_400_000)
    })

    it('rolls when crossing a monthly boundary (Date.UTC handles month math)', () => {
      store.setQuota(
        { userId, metric: 'llm_tokens_in', period: 'monthly', quota: 5 },
        NOW,
      )
      store.checkAndIncrement({
        userId,
        metric: 'llm_tokens_in',
        period: 'monthly',
        amount: 5,
        now: NOW,
      })
      const NEXT_MONTH = Date.UTC(2026, 4, 3, 12, 0, 0) // May 3 2026 12:00 UTC
      const r = store.checkAndIncrement({
        userId,
        metric: 'llm_tokens_in',
        period: 'monthly',
        amount: 1,
        now: NEXT_MONTH,
      })
      expect(r.allowed).toBe(true)
      expect(r.counter.used).toBe(1)
      expect(r.counter.periodStart).toBe(Date.UTC(2026, 4, 1))
    })

    it("'total' period NEVER rolls (lifetime counter)", () => {
      store.checkAndIncrement({
        userId,
        metric: 'llm_lifetime',
        period: 'total',
        amount: 7,
        now: NOW,
      })
      // A year later — used should still accumulate, not reset.
      const YEAR_LATER = NOW + 365 * 86_400_000
      const r = store.checkAndIncrement({
        userId,
        metric: 'llm_lifetime',
        period: 'total',
        amount: 3,
        now: YEAR_LATER,
      })
      expect(r.counter.used).toBe(10)
      expect(r.counter.periodStart).toBe(0) // sentinel
    })
  })

  // ---------- resetUsage ----------

  describe('resetUsage', () => {
    it('returns null when no counter exists', () => {
      expect(
        store.resetUsage({
          userId,
          metric: 'nope',
          period: 'daily',
          now: NOW,
        }),
      ).toBeNull()
    })

    it('zeros used and advances period_start to the new boundary', () => {
      store.setQuota(
        { userId, metric: 'llm_requests', period: 'daily', quota: 100 },
        NOW,
      )
      store.checkAndIncrement({
        userId,
        metric: 'llm_requests',
        period: 'daily',
        amount: 40,
        now: NOW,
      })
      const RESET_AT = DAY_START + 86_400_000 + 9 * 3_600_000
      const after = store.resetUsage({
        userId,
        metric: 'llm_requests',
        period: 'daily',
        now: RESET_AT,
      })
      expect(after?.used).toBe(0)
      expect(after?.periodStart).toBe(DAY_START + 86_400_000)
      expect(after?.quota).toBe(100) // quota preserved across reset
    })
  })

  // ---------- input validation ----------

  describe('input validation', () => {
    it('rejects empty userId', () => {
      expect(() =>
        store.checkAndIncrement({
          userId: '',
          metric: 'x',
          period: 'daily',
          now: NOW,
        }),
      ).toThrow(/userId/)
    })

    it('rejects empty metric', () => {
      expect(() =>
        store.checkAndIncrement({
          userId,
          metric: '',
          period: 'daily',
          now: NOW,
        }),
      ).toThrow(/non-empty/)
    })

    it('rejects metric longer than 64 chars', () => {
      expect(() =>
        store.checkAndIncrement({
          userId,
          metric: 'x'.repeat(65),
          period: 'daily',
          now: NOW,
        }),
      ).toThrow(/too long/)
    })

    it('rejects unknown period', () => {
      expect(() =>
        store.checkAndIncrement({
          userId,
          metric: 'x',
          period: 'weekly' as unknown as 'daily',
          now: NOW,
        }),
      ).toThrow(/usage period must be one of/)
    })
  })

  // ---------- FK cascade ----------

  it('ON DELETE CASCADE: deleting the user removes their usage rows', () => {
    store.setQuota(
      { userId, metric: 'llm_requests', period: 'daily', quota: 5 },
      NOW,
    )
    store.checkAndIncrement({
      userId,
      metric: 'llm_requests',
      period: 'daily',
      now: NOW,
    })
    expect(store.listUsage({ userId }).length).toBe(1)

    // No public deleteUser API, but raw delete via the underlying db
    // exercises the FK we just relied on. We use the private db handle
    // — fine for tests.
    ;(store as unknown as { db: { prepare: (s: string) => { run: (id: string) => void } } }).db
      .prepare('DELETE FROM users WHERE id = ?')
      .run(userId)
    expect(store.listUsage({ userId })).toEqual([])
  })
})
