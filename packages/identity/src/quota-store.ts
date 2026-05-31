/**
 * QuotaStore — per-user usage counters (B2.1) + per-org soft quotas (E1).
 *
 * Extracted from IdentityStore as the fourth (and final named) domain of
 * the R13 god-object split (vault → suspended-tasks → peers → quota). The
 * two sub-domains live together because they're one billing story: the
 * per-user counters are the raw ticks, and the per-org quotas aggregate
 * `SUM(used)` across all users for a (metric, period) and run a small
 * ok/warn/over state machine on top. `checkOrgQuotaThreshold` reads both
 * tables, so splitting them apart would just re-introduce a cross-store
 * dependency.
 *
 * Statements are prepared EAGERLY (not lazy like vault/peer): once B2.2
 * lands, `checkAndIncrement` is on the agent-spawn hot path, and the
 * host's orgQuotaSweep ticks `checkOrgQuotaThreshold` on a timer. Both
 * want the prepared statement ready, not allocated on first call.
 *
 * NOT in here: `org_meta` (org_mode kv). That table is cross-cutting —
 * bootstrap, mode-switch, and the personal→team upgrade all read/write it
 * — so it stays in the IdentityStore facade body alongside the core
 * users/membership domain.
 */

import { type SqliteDb, type SqliteStmt, transaction } from './db.js'
import { IdentityError } from './errors.js'
import {
  USAGE_METRIC_MAX_LEN,
  USAGE_PERIODS,
  type CheckAndIncrementInput,
  type CheckAndIncrementResult,
  type CheckOrgQuotaResult,
  type GetUsageQuery,
  type OrgQuota,
  type OrgQuotaState,
  type ResetUsageInput,
  type SetOrgQuotaInput,
  type SetQuotaInput,
  type SweepUsageResult,
  type UsageCounter,
  type UsagePeriod,
} from './types.js'

/** Sqlite row shape — snake_case columns mirror the schema verbatim. */
interface UsageCounterRow {
  user_id: string
  metric: string
  period: string
  period_start: number
  used: number
  quota: number | null
  updated_at: number
}

interface OrgQuotaRow {
  metric: string
  period: string
  quota: number
  warn_pct: number
  last_state: string
  last_checked: number | null
  created_at: number
  updated_at: number
}

export class QuotaStore {
  private readonly db: SqliteDb

  // B2.1 — usage counters. Eagerly prepared (not lazy like vault) since
  // checkAndIncrement is the agent-spawn hot path once B2.2 lands.
  private readonly stmtUsageGet: SqliteStmt
  private readonly stmtUsageUpsert: SqliteStmt
  private readonly stmtUsageUpdate: SqliteStmt
  private readonly stmtUsageListByUser: SqliteStmt
  private readonly stmtUsageListByUserMetric: SqliteStmt
  private readonly stmtUsageListByUserPeriod: SqliteStmt
  private readonly stmtUsageListByTriple: SqliteStmt
  // B2.3 — background sweep prepared statement. One UPDATE covers
  // every stale row of a given period (hourly / daily / monthly);
  // 'total' rows are excluded entirely because their period_start is
  // the sentinel 0 and they're lifetime counters.
  private readonly stmtUsageSweep: SqliteStmt
  // E1 — aggregate sum across all users for (metric, period). Only
  // counts rows whose period_start matches the current boundary —
  // stale rows that haven't been swept yet (and the sentinel 0 for
  // 'total') are filtered to keep the aggregate honest.
  private readonly stmtSumUsageCurrent: SqliteStmt
  private readonly stmtSumUsageTotal: SqliteStmt
  // E1 — org_quotas CRUD + transition tracking.
  private readonly stmtOrgQuotaUpsert: SqliteStmt
  private readonly stmtOrgQuotaGet: SqliteStmt
  private readonly stmtOrgQuotaList: SqliteStmt
  private readonly stmtOrgQuotaDelete: SqliteStmt
  private readonly stmtOrgQuotaTouchState: SqliteStmt

  constructor(db: SqliteDb) {
    this.db = db

    // B2.1 — usage counters.
    this.stmtUsageGet = db.prepare(
      `SELECT * FROM usage_counters
        WHERE user_id = ? AND metric = ? AND period = ?`,
    )
    // ON CONFLICT DO UPDATE lets setQuota be a single statement whether
    // the row exists or not. We update `quota` + `updated_at`; `used`
    // and `period_start` stay at their current values (don't reset
    // usage when only the cap changes).
    this.stmtUsageUpsert = db.prepare(
      `INSERT INTO usage_counters
         (user_id, metric, period, period_start, used, quota, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, metric, period) DO UPDATE SET
         quota = excluded.quota,
         updated_at = excluded.updated_at`,
    )
    // checkAndIncrement uses this for "row exists, advance it": writes
    // used + period_start + updated_at (quota stays put — set via
    // setQuota only).
    this.stmtUsageUpdate = db.prepare(
      `UPDATE usage_counters
         SET used = ?, period_start = ?, updated_at = ?
       WHERE user_id = ? AND metric = ? AND period = ?`,
    )
    this.stmtUsageListByUser = db.prepare(
      `SELECT * FROM usage_counters WHERE user_id = ?
        ORDER BY metric, period`,
    )
    this.stmtUsageListByUserMetric = db.prepare(
      `SELECT * FROM usage_counters WHERE user_id = ? AND metric = ?
        ORDER BY period`,
    )
    this.stmtUsageListByUserPeriod = db.prepare(
      `SELECT * FROM usage_counters WHERE user_id = ? AND period = ?
        ORDER BY metric`,
    )
    this.stmtUsageListByTriple = db.prepare(
      `SELECT * FROM usage_counters
        WHERE user_id = ? AND metric = ? AND period = ?`,
    )
    // B2.3 — sweep stale rows of a single `period` forward to a fresh
    // boundary. `period_start < ?` (strict <) is deliberate: an admin
    // who manually edits a row to a *future* periodStart, or a host
    // whose wall-clock briefly jumps backwards (NTP correction), must
    // not see its counter erased. The sweep only ever moves time
    // forward.
    this.stmtUsageSweep = db.prepare(
      `UPDATE usage_counters
         SET used = 0, period_start = ?, updated_at = ?
       WHERE period = ? AND period_start < ?`,
    )

    // E1 — aggregate per-org sum. For non-'total' periods we filter on
    // `period_start = ?` so stale-but-unswept rows contribute 0 to the
    // aggregate (sweep will roll them on the next 1h tick; until then
    // we don't want yesterday's usage padding today's bill).
    // COALESCE because SUM of zero rows returns NULL.
    this.stmtSumUsageCurrent = db.prepare(
      `SELECT COALESCE(SUM(used), 0) AS s
         FROM usage_counters
        WHERE metric = ? AND period = ? AND period_start = ?`,
    )
    this.stmtSumUsageTotal = db.prepare(
      `SELECT COALESCE(SUM(used), 0) AS s
         FROM usage_counters
        WHERE metric = ? AND period = 'total'`,
    )

    // E1 — org_quotas.
    //
    // Upsert pattern mirrors setQuota: ON CONFLICT updates quota +
    // warn_pct + updated_at, but PRESERVES last_state / last_checked /
    // created_at. Re-issuing a quota for an at-warn (metric, period)
    // shouldn't reset the transition tracking — the next check decides.
    this.stmtOrgQuotaUpsert = db.prepare(
      `INSERT INTO org_quotas
         (metric, period, quota, warn_pct, last_state, last_checked, created_at, updated_at)
         VALUES(?, ?, ?, ?, 'ok', NULL, ?, ?)
       ON CONFLICT(metric, period) DO UPDATE SET
         quota = excluded.quota,
         warn_pct = excluded.warn_pct,
         updated_at = excluded.updated_at`,
    )
    this.stmtOrgQuotaGet = db.prepare(
      `SELECT * FROM org_quotas WHERE metric = ? AND period = ?`,
    )
    this.stmtOrgQuotaList = db.prepare(
      `SELECT * FROM org_quotas ORDER BY metric, period`,
    )
    this.stmtOrgQuotaDelete = db.prepare(
      `DELETE FROM org_quotas WHERE metric = ? AND period = ?`,
    )
    this.stmtOrgQuotaTouchState = db.prepare(
      `UPDATE org_quotas
         SET last_state = ?, last_checked = ?, updated_at = ?
       WHERE metric = ? AND period = ?`,
    )
  }

  // =====================================================================
  // B2.1 — Usage counters (per-user quota tracking)
  // =====================================================================

  /**
   * Set, update, or clear the quota cap for a (user, metric, period)
   * tuple. The row is created if absent (with `used=0`,
   * `periodStart=periodStartFor(period, now)`). Existing rows keep
   * their current `used` / `periodStart` — changing the cap MUST NOT
   * silently reset accumulated usage (an admin who raises someone's
   * daily limit doesn't want to give them a fresh day).
   *
   * Pass `quota=null` to remove the cap (counter still ticks for
   * visibility / future re-enablement).
   */
  setQuota(input: SetQuotaInput, now: number = Date.now()): UsageCounter {
    assertUsageMetric(input?.metric)
    assertUsagePeriod(input?.period)
    assertNonEmptyId(input?.userId, 'userId')
    if (input.quota !== null) {
      if (
        typeof input.quota !== 'number' ||
        !Number.isFinite(input.quota) ||
        !Number.isInteger(input.quota) ||
        input.quota < 0
      ) {
        throw new IdentityError({
          code: 'invalid_input',
          message: `setQuota: quota must be null or a non-negative integer; got ${input.quota}`,
        })
      }
    }
    const periodStart = periodStartFor(input.period, now)
    this.stmtUsageUpsert.run(
      input.userId,
      input.metric,
      input.period,
      periodStart,
      0,           // used — only honoured when INSERT (UPSERT updates only quota+updated_at)
      input.quota,
      now,
    )
    const row = this.stmtUsageGet.get(
      input.userId,
      input.metric,
      input.period,
    ) as UsageCounterRow | undefined
    if (!row) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `setQuota: upsert succeeded but read-back returned nothing for ${input.userId}/${input.metric}/${input.period}`,
      })
    }
    return rowToUsageCounter(row)
  }

  /**
   * Read counters. Filter by `metric` and / or `period`; omit either
   * to broaden the result. Does NOT auto-roll stale period rows —
   * read-only. Callers wanting the post-roll value for a single
   * counter should use {@link checkAndIncrement} with `amount=0` (an
   * idempotent peek that does trigger the roll).
   */
  listUsage(query: GetUsageQuery): UsageCounter[] {
    assertNonEmptyId(query?.userId, 'userId')
    let rows: UsageCounterRow[]
    if (query.metric !== undefined && query.period !== undefined) {
      assertUsageMetric(query.metric)
      assertUsagePeriod(query.period)
      rows = this.stmtUsageListByTriple.all(
        query.userId,
        query.metric,
        query.period,
      ) as UsageCounterRow[]
    } else if (query.metric !== undefined) {
      assertUsageMetric(query.metric)
      rows = this.stmtUsageListByUserMetric.all(
        query.userId,
        query.metric,
      ) as UsageCounterRow[]
    } else if (query.period !== undefined) {
      assertUsagePeriod(query.period)
      rows = this.stmtUsageListByUserPeriod.all(
        query.userId,
        query.period,
      ) as UsageCounterRow[]
    } else {
      rows = this.stmtUsageListByUser.all(query.userId) as UsageCounterRow[]
    }
    return rows.map(rowToUsageCounter)
  }

  /**
   * Atomic peek-roll-check-increment, inside a single transaction.
   *
   *   1. Read the (user, metric, period) row. Missing → treat as
   *      `used=0, quota=null, periodStart=periodStartFor(period, now)`.
   *   2. If the row's `periodStart` doesn't match the current
   *      period's boundary, ROLL: `used=0`, `periodStart=current`.
   *   3. If `quota !== null` and `used + amount > quota`, return
   *      `{allowed: false, counter, exceededBy}`. The row is still
   *      written (the roll, if any) but `used` is NOT incremented.
   *   4. Otherwise increment `used += amount`, write, return
   *      `{allowed: true, counter}`.
   *
   * `amount=0` is a "peek-and-roll" — won't trip a quota check, but
   * will still roll an expired period so the returned counter is
   * current.
   */
  checkAndIncrement(input: CheckAndIncrementInput): CheckAndIncrementResult {
    assertNonEmptyId(input?.userId, 'userId')
    assertUsageMetric(input?.metric)
    assertUsagePeriod(input?.period)
    const amount = input.amount ?? 1
    if (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      !Number.isInteger(amount) ||
      amount < 0
    ) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `checkAndIncrement: amount must be a non-negative integer; got ${amount}`,
      })
    }
    const now = input.now ?? Date.now()
    const expectedStart = periodStartFor(input.period, now)

    return transaction(this.db, () => {
      const existing = this.stmtUsageGet.get(
        input.userId,
        input.metric,
        input.period,
      ) as UsageCounterRow | undefined

      // Row state going into the check. We compute what the row WILL
      // look like before deciding allow/deny.
      const currentUsed =
        existing && existing.period_start === expectedStart
          ? existing.used
          : 0 // missing row OR period rolled → effective used=0
      const quota = existing ? existing.quota : null

      // Quota check first — we still write the roll if the period
      // expired, but we DON'T commit the increment.
      const wouldBe = currentUsed + amount
      const allowed = quota === null || wouldBe <= quota
      const finalUsed = allowed ? wouldBe : currentUsed

      if (!existing) {
        // Fresh row. Quota stays null (set via setQuota). period_start
        // is the current boundary.
        this.stmtUsageUpsert.run(
          input.userId,
          input.metric,
          input.period,
          expectedStart,
          finalUsed,
          null,
          now,
        )
      } else {
        // Existing row — UPDATE used + period_start + updated_at.
        // Quota is preserved (we never touch it from this method).
        this.stmtUsageUpdate.run(
          finalUsed,
          expectedStart,
          now,
          input.userId,
          input.metric,
          input.period,
        )
      }

      const row = this.stmtUsageGet.get(
        input.userId,
        input.metric,
        input.period,
      ) as UsageCounterRow
      const counter = rowToUsageCounter(row)
      if (!allowed) {
        return {
          allowed: false,
          counter,
          exceededBy: wouldBe - (quota as number),
        }
      }
      return { allowed: true, counter }
    })
  }

  /**
   * Phase 17 — UNGATED monotonic increment for recording actual usage
   * (the LLM tokens / cost the provider reported AFTER the call). Unlike
   * {@link checkAndIncrement}, this NEVER refuses: `used += amount`
   * always commits, so a counter CAN exceed its quota — and that
   * overshoot is the whole point.
   *
   * The pre-call budget peek (org-api-pool gate) refuses the NEXT call
   * once `used >= quota`. That can only become true if recording is
   * allowed to cross the cap. Recording via the gated `checkAndIncrement`
   * (the original M3/M4 wiring) freezes `used` just BELOW the quota — the
   * over-cap increment is silently dropped — so the peek never fires and
   * the budget is fail-OPEN. Recording ungated here is what makes the
   * token / cost budgets actually fail-closed.
   *
   * Still rolls an expired period (used resets to 0 at the boundary
   * before applying `amount`). Quota is preserved (only setQuota writes it).
   */
  recordUsage(input: CheckAndIncrementInput): UsageCounter {
    assertNonEmptyId(input?.userId, 'userId')
    assertUsageMetric(input?.metric)
    assertUsagePeriod(input?.period)
    const amount = input.amount ?? 1
    if (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      !Number.isInteger(amount) ||
      amount < 0
    ) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `recordUsage: amount must be a non-negative integer; got ${amount}`,
      })
    }
    const now = input.now ?? Date.now()
    const expectedStart = periodStartFor(input.period, now)

    return transaction(this.db, () => {
      const existing = this.stmtUsageGet.get(
        input.userId,
        input.metric,
        input.period,
      ) as UsageCounterRow | undefined

      // Roll an expired period to 0 before applying the amount.
      const currentUsed =
        existing && existing.period_start === expectedStart ? existing.used : 0
      const finalUsed = currentUsed + amount

      if (!existing) {
        this.stmtUsageUpsert.run(
          input.userId,
          input.metric,
          input.period,
          expectedStart,
          finalUsed,
          null,
          now,
        )
      } else {
        this.stmtUsageUpdate.run(
          finalUsed,
          expectedStart,
          now,
          input.userId,
          input.metric,
          input.period,
        )
      }

      const row = this.stmtUsageGet.get(
        input.userId,
        input.metric,
        input.period,
      ) as UsageCounterRow
      return rowToUsageCounter(row)
    })
  }

  /**
   * Manually zero the counter and start a fresh period. Useful for
   * admin "give this user their day back" / "they got hit by a runaway
   * loop, refund the usage" actions. Returns `null` when no row
   * existed (admins shouldn't get a false "reset" confirmation for a
   * counter that was never touched).
   */
  resetUsage(input: ResetUsageInput): UsageCounter | null {
    assertNonEmptyId(input?.userId, 'userId')
    assertUsageMetric(input?.metric)
    assertUsagePeriod(input?.period)
    const now = input.now ?? Date.now()
    const existing = this.stmtUsageGet.get(
      input.userId,
      input.metric,
      input.period,
    ) as UsageCounterRow | undefined
    if (!existing) return null
    this.stmtUsageUpdate.run(
      0,
      periodStartFor(input.period, now),
      now,
      input.userId,
      input.metric,
      input.period,
    )
    const row = this.stmtUsageGet.get(
      input.userId,
      input.metric,
      input.period,
    ) as UsageCounterRow
    return rowToUsageCounter(row)
  }

  /**
   * B2.3 — background hygiene sweep. For every `hourly` / `daily` /
   * `monthly` row whose stored `period_start` lies in a *prior* period
   * relative to `now`, advance `period_start` to the current boundary
   * and reset `used = 0`. `'total'` rows are never swept (lifetime
   * counters; sentinel `period_start = 0`).
   *
   * Why we still need this when `checkAndIncrement` already auto-rolls
   * on every call:
   *
   *   - `listUsage` does NOT roll (it's read-only by contract). Without
   *     the sweep, an admin opening the usage dashboard at 09:00 for a
   *     user who burned 100/100 yesterday and hasn't dispatched since
   *     would see `used=100, periodStart=<yesterday>` — confusing.
   *     Post-sweep they see `used=0, periodStart=<today>`.
   *   - Metrics that go inactive (a user stopped using a feature) would
   *     otherwise drift indefinitely with stale `period_start`. This
   *     also matters for E1 (per-org aggregation) — sum across
   *     `used` makes sense only if every row's period_start is current.
   *
   * Runs the three period UPDATEs in a single transaction. Each
   * statement is constrained by `period_start < ?` (strict) so a
   * clock skew that briefly pulls `now` backwards never rewrites a
   * row to an earlier boundary. Returns counts for diagnostics.
   */
  sweepUsageCounters(now: number = Date.now()): SweepUsageResult {
    return transaction(this.db, () => {
      const byPeriod = { hourly: 0, daily: 0, monthly: 0 }
      for (const period of ['hourly', 'daily', 'monthly'] as const) {
        const boundary = periodStartFor(period, now)
        const r = this.stmtUsageSweep.run(boundary, now, period, boundary)
        byPeriod[period] = Number(r.changes)
      }
      return {
        rolled: byPeriod.hourly + byPeriod.daily + byPeriod.monthly,
        byPeriod,
      }
    })
  }

  // =====================================================================
  // E1 — Per-org aggregation + soft quotas
  // =====================================================================

  /**
   * Aggregate `used` across ALL users for one (metric, period). For
   * non-`'total'` periods, only rows whose `period_start` matches the
   * current period boundary contribute — stale-but-unswept rows count
   * as zero (the `sweepUsageCounters` 1h tick keeps them current; we
   * don't want yesterday's usage padding today's number in case the
   * sweep is a few seconds late or skipped).
   *
   * Test code should pass `now` explicitly to align with whatever the
   * checkAndIncrement test calls used.
   */
  sumUsage(metric: string, period: UsagePeriod, now: number = Date.now()): number {
    assertUsageMetric(metric)
    assertUsagePeriod(period)
    if (period === 'total') {
      const r = this.stmtSumUsageTotal.get(metric) as { s: number }
      return Number(r.s)
    }
    const boundary = periodStartFor(period, now)
    const r = this.stmtSumUsageCurrent.get(metric, period, boundary) as { s: number }
    return Number(r.s)
  }

  /**
   * Create or update an org-level soft cap for a (metric, period) tuple.
   * `quota` is a required non-negative integer ("unlimited" is the
   * absence of a row — use {@link deleteOrgQuota}). `warnPct` defaults
   * to 80 on first create; omitting on update preserves the existing
   * value.
   *
   * The transition tracker (`lastState`, `lastChecked`) is NOT reset on
   * update — re-issuing a cap for an already-warning quota shouldn't
   * cause the next `checkOrgQuotaThreshold` to spuriously emit a
   * "warning resolved" then "warning re-opened" pair.
   */
  setOrgQuota(input: SetOrgQuotaInput, now: number = Date.now()): OrgQuota {
    assertUsageMetric(input?.metric)
    assertUsagePeriod(input?.period)
    if (
      typeof input.quota !== 'number' ||
      !Number.isFinite(input.quota) ||
      !Number.isInteger(input.quota) ||
      input.quota < 0
    ) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `setOrgQuota: quota must be a non-negative integer; got ${input.quota}`,
      })
    }
    // warn_pct constraint: integer in [1, 99]. 0 / 100 would degenerate
    // the state machine — at 0 every check is 'warn'; at 100 'warn' is
    // unreachable (you'd jump straight to 'over').
    let warnPct = 80
    if (input.warnPct !== undefined) {
      if (
        typeof input.warnPct !== 'number' ||
        !Number.isInteger(input.warnPct) ||
        input.warnPct < 1 ||
        input.warnPct > 99
      ) {
        throw new IdentityError({
          code: 'invalid_input',
          message: `setOrgQuota: warnPct must be an integer in [1, 99]; got ${input.warnPct}`,
        })
      }
      warnPct = input.warnPct
    } else {
      // Preserve existing warnPct on update if caller omitted it.
      const existing = this.stmtOrgQuotaGet.get(input.metric, input.period) as
        | OrgQuotaRow
        | undefined
      if (existing) warnPct = existing.warn_pct
    }
    this.stmtOrgQuotaUpsert.run(
      input.metric,
      input.period,
      input.quota,
      warnPct,
      now, // created_at — UPSERT keeps the existing value on conflict
      now, // updated_at
    )
    const row = this.stmtOrgQuotaGet.get(input.metric, input.period) as OrgQuotaRow
    return rowToOrgQuota(row)
  }

  /** Returns `null` when no row exists for the tuple. */
  getOrgQuota(metric: string, period: UsagePeriod): OrgQuota | null {
    assertUsageMetric(metric)
    assertUsagePeriod(period)
    const row = this.stmtOrgQuotaGet.get(metric, period) as OrgQuotaRow | undefined
    return row ? rowToOrgQuota(row) : null
  }

  /** All configured org quotas (admin UI list view). Ordered by (metric, period). */
  listOrgQuotas(): OrgQuota[] {
    const rows = this.stmtOrgQuotaList.all() as OrgQuotaRow[]
    return rows.map(rowToOrgQuota)
  }

  /**
   * Remove the soft cap for (metric, period). Returns `true` when a row
   * was deleted, `false` when nothing was there to delete (idempotent
   * for admin tooling — no need to check first).
   */
  deleteOrgQuota(metric: string, period: UsagePeriod): boolean {
    assertUsageMetric(metric)
    assertUsagePeriod(period)
    const r = this.stmtOrgQuotaDelete.run(metric, period)
    return Number(r.changes) > 0
  }

  /**
   * The host-side decision point. Reads the org quota + the current
   * aggregate usage, computes the state, compares against `lastState`,
   * and ATOMICALLY updates `lastState` / `lastChecked` to the new value
   * inside one transaction.
   *
   * Returns `transitioned=true` exactly when the state changed — the
   * host's orgQuotaSweep keys on this to decide whether to emit an
   * audit_log entry. Repeated checks at the same state are silent.
   *
   * Throws `org_quota_not_found` when no quota is configured for the
   * tuple — callers are expected to iterate `listOrgQuotas()` and only
   * check tuples that are configured.
   */
  checkOrgQuotaThreshold(
    metric: string,
    period: UsagePeriod,
    now: number = Date.now(),
  ): CheckOrgQuotaResult {
    assertUsageMetric(metric)
    assertUsagePeriod(period)
    return transaction(this.db, () => {
      const row = this.stmtOrgQuotaGet.get(metric, period) as OrgQuotaRow | undefined
      if (!row) {
        throw new IdentityError({
          code: 'org_quota_not_found',
          message: `checkOrgQuotaThreshold: no quota configured for ${metric}/${period}`,
        })
      }
      const usage = period === 'total'
        ? Number((this.stmtSumUsageTotal.get(metric) as { s: number }).s)
        : Number(
            (this.stmtSumUsageCurrent.get(
              metric,
              period,
              periodStartFor(period, now),
            ) as { s: number }).s,
          )

      // quota=0 is a degenerate but legal config ("nobody should call this
      // metric") — guard against /0. Any usage ≥ 0 with quota=0 is 'over'
      // unless usage is also 0 in which case it's 'ok' (vacuous truth).
      let pct: number
      let state: OrgQuotaState
      if (row.quota === 0) {
        pct = usage === 0 ? 0 : 999
        state = usage === 0 ? 'ok' : 'over'
      } else {
        pct = Math.min(999, Math.floor((usage / row.quota) * 100))
        if (pct >= 100) state = 'over'
        else if (pct >= row.warn_pct) state = 'warn'
        else state = 'ok'
      }

      const previousState = row.last_state as OrgQuotaState
      const transitioned = state !== previousState
      // Always touch last_checked (operator diagnostic). Only the state
      // column flips on transition, but `last_checked` updates every call.
      this.stmtOrgQuotaTouchState.run(state, now, now, metric, period)

      return {
        metric,
        period,
        quota: row.quota,
        warnPct: row.warn_pct,
        usage,
        pct,
        state,
        previousState,
        transitioned,
      }
    })
  }
}

// ---- B2.1 — usage-counter helpers ----

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/**
 * UTC-aligned period boundary for `now`. Returns the *start* of the
 * current period — checkAndIncrement compares this to the row's stored
 * `period_start` to decide whether to roll.
 *
 * `'total'` returns 0 as a sentinel (any `now` produces the same value,
 * so a row created with periodStart=0 never appears stale).
 */
function periodStartFor(period: UsagePeriod, now: number): number {
  if (period === 'total') return 0
  if (period === 'hourly') return Math.floor(now / HOUR_MS) * HOUR_MS
  if (period === 'daily') return Math.floor(now / DAY_MS) * DAY_MS
  // monthly — Date.UTC handles month rollover (Feb / leap years etc.)
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

function isUsagePeriod(s: unknown): s is UsagePeriod {
  return typeof s === 'string' && (USAGE_PERIODS as readonly string[]).includes(s)
}

function assertUsagePeriod(p: unknown): asserts p is UsagePeriod {
  if (!isUsagePeriod(p)) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `usage period must be one of ${USAGE_PERIODS.join(', ')}; got ${JSON.stringify(p)}`,
    })
  }
}

function assertUsageMetric(m: unknown): asserts m is string {
  if (typeof m !== 'string' || m.length === 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: 'usage metric must be a non-empty string',
    })
  }
  if (m.length > USAGE_METRIC_MAX_LEN) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `usage metric too long (max ${USAGE_METRIC_MAX_LEN} chars); got ${m.length}`,
    })
  }
}

function assertNonEmptyId(id: unknown, label: string): asserts id is string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `${label} must be a non-empty string`,
    })
  }
}

function rowToUsageCounter(r: UsageCounterRow): UsageCounter {
  // Defensive: tolerate an unrecognised period string (manual db edit /
  // pre-migration row). Fall back to 'total' — the row stays visible
  // in admin UI rather than crashing the list endpoint.
  const period: UsagePeriod = isUsagePeriod(r.period) ? r.period : 'total'
  return {
    userId: r.user_id,
    metric: r.metric,
    period,
    periodStart: r.period_start,
    used: r.used,
    quota: r.quota,
    updatedAt: r.updated_at,
  }
}

// ---- E1 — org-quotas helpers ----

function rowToOrgQuota(r: OrgQuotaRow): OrgQuota {
  // Same defensive tolerance as rowToUsageCounter for period.
  const period: UsagePeriod = isUsagePeriod(r.period) ? r.period : 'total'
  // Clamp unknown lastState to 'ok' so the state-machine bootstraps
  // sanely (next check will set it correctly).
  const lastState: OrgQuotaState =
    r.last_state === 'warn' || r.last_state === 'over' ? r.last_state : 'ok'
  return {
    metric: r.metric,
    period,
    quota: r.quota,
    warnPct: r.warn_pct,
    lastState,
    lastChecked: r.last_checked,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}
