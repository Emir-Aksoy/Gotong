/**
 * PeerSummarySnapshotStore — v5 Stream F control-plane history.
 *
 * The E5 `peer.summary` control plane is point-in-time only: a hub asks a
 * peer for its privacy-safe COUNTS-ONLY summary and caches it in memory,
 * lost on restart by design. To draw TRENDS we persist one snapshot per
 * refresh into this append-only table — same privacy contract as the live
 * summary (the row holds the aggregate blob, never any underlying row).
 *
 * Deliberately DUMB: identity stores `summary_json` opaque and never parses
 * it. All `PeerSummary` semantics — projecting a scalar metric for a trend,
 * evaluating alert thresholds — live in the host where the type is defined.
 * This keeps identity domain-agnostic (it just stamps "at time T, source S
 * had this blob") and means a new summary field never needs an identity
 * migration. Append-only on write, scan on read, retention prune — the same
 * access pattern (and shape) as {@link LedgerStore}.
 */

import { type SqliteDb, type SqliteStmt } from './db.js'
import { IdentityError } from './errors.js'
import {
  PEER_SUMMARY_SNAPSHOT_DEFAULT_LIMIT,
  PEER_SUMMARY_SNAPSHOT_MAX_LIMIT,
  type AppendPeerSummarySnapshotInput,
  type PeerSummarySnapshot,
  type PeerSummarySnapshotQuery,
} from './types.js'

/** Sqlite row shape — snake_case columns mirror the schema verbatim. */
interface SnapshotRow {
  id: number
  captured_at: number
  source: string
  summary_json: string
}

/** Max serialised size of a single snapshot blob — counts-only stays tiny. */
const SUMMARY_JSON_MAX_BYTES = 64 * 1024

export class PeerSummarySnapshotStore {
  private readonly db: SqliteDb
  private readonly stmtInsert: SqliteStmt
  private readonly stmtGetById: SqliteStmt

  constructor(db: SqliteDb) {
    this.db = db
    this.stmtInsert = db.prepare(
      `INSERT INTO peer_summary_snapshots (captured_at, source, summary_json)
       VALUES(?, ?, ?)`,
    )
    this.stmtGetById = db.prepare(
      'SELECT * FROM peer_summary_snapshots WHERE id = ?',
    )
  }

  /**
   * Append one snapshot. `capturedAt` defaults to now. Validates the
   * required `source` / `summaryJson` (non-empty strings, blob under the
   * size cap) but NEVER inspects the JSON's contents. No transaction
   * needed: better-sqlite3 is synchronous and we read back by the exact
   * `lastInsertRowid`.
   */
  append(input: AppendPeerSummarySnapshotInput): PeerSummarySnapshot {
    if (!input || typeof input !== 'object') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'appendPeerSummarySnapshot: input object required',
      })
    }
    assertNonEmptyStr(input.source, 'source')
    assertNonEmptyStr(input.summaryJson, 'summaryJson')
    if (input.summaryJson.length > SUMMARY_JSON_MAX_BYTES) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `summaryJson too large (max ${SUMMARY_JSON_MAX_BYTES} bytes); got ${input.summaryJson.length}`,
      })
    }
    const capturedAt = input.capturedAt ?? Date.now()
    assertNonNegInt(capturedAt, 'capturedAt')

    const res = this.stmtInsert.run(capturedAt, input.source, input.summaryJson)
    const id = Number(res.lastInsertRowid)
    const row = this.stmtGetById.get(id) as SnapshotRow | undefined
    if (!row) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `appendPeerSummarySnapshot: insert succeeded but read-back returned nothing for id=${id}`,
      })
    }
    return rowToSnapshot(row)
  }

  /**
   * History query, CHRONOLOGICAL (`captured_at ASC, id ASC`) — a trend reads
   * left-to-right. `source` narrows to one footprint; `[since, until)` is the
   * standard half-open window. `limit` defaults to
   * {@link PEER_SUMMARY_SNAPSHOT_DEFAULT_LIMIT}, clamped to
   * {@link PEER_SUMMARY_SNAPSHOT_MAX_LIMIT}.
   */
  list(q: PeerSummarySnapshotQuery = {}): PeerSummarySnapshot[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (q.source !== undefined) {
      assertNonEmptyStr(q.source, 'source')
      clauses.push('source = ?')
      params.push(q.source)
    }
    if (q.since !== undefined) {
      assertNonNegInt(q.since, 'since')
      clauses.push('captured_at >= ?')
      params.push(q.since)
    }
    if (q.until !== undefined) {
      assertNonNegInt(q.until, 'until')
      clauses.push('captured_at < ?')
      params.push(q.until)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = clampLimit(q.limit)
    const sql = `SELECT * FROM peer_summary_snapshots ${where}
                 ORDER BY captured_at ASC, id ASC LIMIT ?`
    const rows = this.db.prepare(sql).all(...params, limit) as SnapshotRow[]
    return rows.map(rowToSnapshot)
  }

  /**
   * Delete snapshots older than `before` (half-open `captured_at < before`),
   * returning the count removed — the retention knob for a table that grows
   * one row per refresh forever. Off by default in the host (no env ⇒ never
   * called), so a default deployment keeps full history. Mirrors
   * {@link LedgerStore.prune}: prepared per-call, boot-time-only.
   */
  prune(opts: { before: number }): number {
    if (!opts || typeof opts !== 'object') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'prunePeerSummarySnapshots: opts object with a `before` cutoff required',
      })
    }
    const before = assertNonNegInt(opts.before, 'before')
    const res = this.db
      .prepare('DELETE FROM peer_summary_snapshots WHERE captured_at < ?')
      .run(before)
    return Number(res.changes)
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function rowToSnapshot(r: SnapshotRow): PeerSummarySnapshot {
  return {
    id: r.id,
    capturedAt: r.captured_at,
    source: r.source,
    summaryJson: r.summary_json,
  }
}

/** undefined → default; provided → floored + clamped into [1, MAX]. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return PEER_SUMMARY_SNAPSHOT_DEFAULT_LIMIT
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `snapshot query limit must be a non-negative number; got ${limit}`,
    })
  }
  const n = Math.floor(limit)
  if (n < 1) return PEER_SUMMARY_SNAPSHOT_DEFAULT_LIMIT // 0 → default, not "no rows"
  return Math.min(n, PEER_SUMMARY_SNAPSHOT_MAX_LIMIT)
}

function assertNonEmptyStr(v: unknown, label: string): asserts v is string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `${label} must be a non-empty string`,
    })
  }
}

/** Assert a non-negative integer and return it (for inline use). */
function assertNonNegInt(v: unknown, label: string): number {
  if (
    typeof v !== 'number' ||
    !Number.isFinite(v) ||
    !Number.isInteger(v) ||
    v < 0
  ) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `${label} must be a non-negative integer; got ${v}`,
    })
  }
  return v
}
