/**
 * PeerSummaryAlertFiringStore — v5 Stream F day-3, the alert breach history the
 * MVP deliberately skipped.
 *
 * Stream F evaluated rules point-in-time ("a fired alert is a fact about NOW")
 * and kept no firings. Day-3 persists one row per open→resolve lifecycle so the
 * control plane can show a timeline AND a delivery dispatcher can edge-trigger:
 * notify ONCE when a breach opens, not every evaluation. The host opens a firing
 * when a rule's metric first crosses its threshold and resolves it when the
 * metric falls back.
 *
 * Same privacy contract as the rest of this plane — every column is a number, a
 * comparator, or an id of the alerting hub's OWN alert config. `ruleId` is kept
 * verbatim even after the rule is deleted (forensics, like {@link LedgerStore}
 * keeps a user id past account deletion) — no FK. The partial UNIQUE index
 * (rule_id, source) WHERE resolved_at IS NULL makes the edge-trigger invariant
 * — at most one OPEN firing per (rule, source) — a property of the schema, not
 * just the caller.
 */

import { type SqliteDb, type SqliteStmt } from './db.js'
import { IdentityError } from './errors.js'
import {
  PEER_SUMMARY_ALERT_FIRING_DEFAULT_LIMIT,
  PEER_SUMMARY_ALERT_FIRING_MAX_LIMIT,
  type OpenPeerSummaryAlertFiringInput,
  type PeerSummaryAlertComparator,
  type PeerSummaryAlertFiring,
  type PeerSummaryAlertFiringQuery,
} from './types.js'

/** Sqlite row shape — snake_case columns mirror the schema verbatim. */
interface FiringRow {
  id: number
  rule_id: string
  source: string
  metric: string
  comparator: string
  threshold: number
  value: number
  label: string | null
  opened_at: number
  resolved_at: number | null
}

function rowToFiring(r: FiringRow): PeerSummaryAlertFiring {
  return {
    id: r.id,
    ruleId: r.rule_id,
    source: r.source,
    metric: r.metric,
    // Stored comparator came from a validated rule; cast is safe on read.
    comparator: r.comparator as PeerSummaryAlertComparator,
    threshold: r.threshold,
    value: r.value,
    label: r.label ?? null,
    openedAt: r.opened_at,
    resolvedAt: r.resolved_at ?? null,
  }
}

export class PeerSummaryAlertFiringStore {
  private readonly db: SqliteDb
  private readonly stmtInsert: SqliteStmt
  private readonly stmtGetById: SqliteStmt
  private readonly stmtListOpen: SqliteStmt
  private readonly stmtResolve: SqliteStmt

  constructor(db: SqliteDb) {
    this.db = db
    this.stmtInsert = db.prepare(
      `INSERT INTO peer_summary_alert_firings
         (rule_id, source, metric, comparator, threshold, value, label, opened_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    this.stmtGetById = db.prepare('SELECT * FROM peer_summary_alert_firings WHERE id = ?')
    // Currently-firing rows, oldest first — the differ reads these to decide
    // which current breaches are NEW (open) and which open firings have cleared.
    this.stmtListOpen = db.prepare(
      'SELECT * FROM peer_summary_alert_firings WHERE resolved_at IS NULL ORDER BY opened_at ASC, id ASC',
    )
    // Resolve only an OPEN row (the `resolved_at IS NULL` guard makes a double
    // resolve a no-op, not a clobber of the original resolve time).
    this.stmtResolve = db.prepare(
      'UPDATE peer_summary_alert_firings SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL',
    )
  }

  /**
   * Open a new firing. `openedAt` defaults to now. The partial unique index
   * rejects a second open while one is unresolved for the same (rule, source)
   * → `alert_firing_open`, so a caller that forgets to check `listOpen` first
   * still can't double-open.
   */
  open(input: OpenPeerSummaryAlertFiringInput): PeerSummaryAlertFiring {
    if (!input || typeof input !== 'object') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'openPeerSummaryAlertFiring: input object required',
      })
    }
    const ruleId = requireNonEmpty(input.ruleId, 'ruleId')
    const source = requireNonEmpty(input.source, 'source')
    const metric = requireNonEmpty(input.metric, 'metric')
    const comparator = requireNonEmpty(input.comparator, 'comparator')
    const threshold = requireFinite(input.threshold, 'threshold')
    const value = requireFinite(input.value, 'value')
    const label = normLabel(input.label)
    const openedAt = input.openedAt ?? Date.now()
    assertNonNegInt(openedAt, 'openedAt')

    let res
    try {
      res = this.stmtInsert.run(
        ruleId,
        source,
        metric,
        comparator,
        threshold,
        value,
        label,
        openedAt,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/UNIQUE|constraint/i.test(msg)) {
        throw new IdentityError({
          code: 'alert_firing_open',
          message: `an OPEN firing already exists for rule ${ruleId} / source ${source}`,
        })
      }
      throw err
    }
    const id = Number(res.lastInsertRowid)
    return rowToFiring(this.stmtGetById.get(id) as FiringRow)
  }

  /**
   * All currently-firing rows (resolved_at IS NULL), oldest first. The
   * edge-trigger differ joins these against the current breach set.
   */
  listOpen(): PeerSummaryAlertFiring[] {
    return (this.stmtListOpen.all() as FiringRow[]).map(rowToFiring)
  }

  /**
   * Firing history, REVERSE-chronological (newest first) — a "recent firings"
   * list reads top-down. `source` / `ruleId` narrow; `state` filters open vs
   * resolved; `[since, until)` is a half-open window on `opened_at`. `limit`
   * defaults to {@link PEER_SUMMARY_ALERT_FIRING_DEFAULT_LIMIT}, clamped to
   * {@link PEER_SUMMARY_ALERT_FIRING_MAX_LIMIT}.
   */
  list(q: PeerSummaryAlertFiringQuery = {}): PeerSummaryAlertFiring[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (q.source !== undefined) {
      clauses.push('source = ?')
      params.push(requireNonEmpty(q.source, 'source'))
    }
    if (q.ruleId !== undefined) {
      clauses.push('rule_id = ?')
      params.push(requireNonEmpty(q.ruleId, 'ruleId'))
    }
    if (q.state === 'open') clauses.push('resolved_at IS NULL')
    else if (q.state === 'resolved') clauses.push('resolved_at IS NOT NULL')
    else if (q.state !== undefined) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `firing query state must be 'open' | 'resolved'; got ${q.state}`,
      })
    }
    if (q.since !== undefined) {
      assertNonNegInt(q.since, 'since')
      clauses.push('opened_at >= ?')
      params.push(q.since)
    }
    if (q.until !== undefined) {
      assertNonNegInt(q.until, 'until')
      clauses.push('opened_at < ?')
      params.push(q.until)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = clampLimit(q.limit)
    const sql = `SELECT * FROM peer_summary_alert_firings ${where}
                 ORDER BY opened_at DESC, id DESC LIMIT ?`
    const rows = this.db.prepare(sql).all(...params, limit) as FiringRow[]
    return rows.map(rowToFiring)
  }

  /**
   * Mark a firing resolved (the metric fell back). Idempotent: resolving an
   * already-resolved row keeps the original `resolvedAt`; a row that doesn't
   * exist at all → `alert_firing_not_found`. `resolvedAt` defaults to now.
   */
  resolve(id: number, opts: { resolvedAt?: number } = {}): PeerSummaryAlertFiring {
    assertNonNegInt(id, 'id')
    const resolvedAt = opts.resolvedAt ?? Date.now()
    assertNonNegInt(resolvedAt, 'resolvedAt')
    this.stmtResolve.run(resolvedAt, id)
    const row = this.stmtGetById.get(id) as FiringRow | undefined
    if (!row) {
      throw new IdentityError({
        code: 'alert_firing_not_found',
        message: `no alert firing ${id}`,
      })
    }
    return rowToFiring(row)
  }

  /**
   * Delete RESOLVED firings older than `before` (half-open `opened_at <
   * before`), returning the count removed — the retention knob. Open firings
   * are never pruned (a live breach must stay visible). Off by default in the
   * host (no env ⇒ never called). Mirrors {@link PeerSummarySnapshotStore.prune}.
   */
  prune(opts: { before: number }): number {
    if (!opts || typeof opts !== 'object') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'prunePeerSummaryAlertFirings: opts object with a `before` cutoff required',
      })
    }
    const before = assertNonNegInt(opts.before, 'before')
    const res = this.db
      .prepare(
        'DELETE FROM peer_summary_alert_firings WHERE resolved_at IS NOT NULL AND opened_at < ?',
      )
      .run(before)
    return Number(res.changes)
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `alert firing ${field} must be a non-empty string`,
    })
  }
  return value.trim()
}

function requireFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `alert firing ${field} must be a finite number`,
    })
  }
  return value
}

function normLabel(value: string | null | undefined): string | null {
  if (value == null) return null
  const t = value.trim()
  return t.length > 0 ? t : null
}

/** undefined → default; provided → floored + clamped into [1, MAX]. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return PEER_SUMMARY_ALERT_FIRING_DEFAULT_LIMIT
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `firing query limit must be a non-negative number; got ${limit}`,
    })
  }
  const n = Math.floor(limit)
  if (n < 1) return PEER_SUMMARY_ALERT_FIRING_DEFAULT_LIMIT // 0 → default, not "no rows"
  return Math.min(n, PEER_SUMMARY_ALERT_FIRING_MAX_LIMIT)
}

function assertNonNegInt(v: unknown, label: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `${label} must be a non-negative integer; got ${v}`,
    })
  }
  return v
}
