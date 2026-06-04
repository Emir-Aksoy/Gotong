/**
 * PeerSummaryAlertRuleStore — v5 Stream F, the control-plane alert rule registry.
 *
 * A rule says "breach when this source's metric crosses this threshold" and is
 * evaluated LIVE by the host against the current summaries (no breach history
 * in the MVP — this store holds only the RULES, not firings). Modeled on
 * A2aAgentStore: a small config table with full CRUD, no vault (nothing here is
 * secret — a threshold and a metric name).
 *
 * Identity stays domain-agnostic: `metric` and `source` are opaque strings the
 * host interprets (which metrics exist is host knowledge). Only the generic
 * structural bits are validated here — comparator ∈ {gt,gte,lt,lte} and a
 * finite numeric threshold — so a malformed rule fails fast at the boundary.
 */

import { randomBytes } from 'node:crypto'

import { type SqliteDb, type SqliteStmt } from './db.js'
import { IdentityError } from './errors.js'
import {
  PEER_SUMMARY_ALERT_COMPARATORS,
  type AddPeerSummaryAlertRuleInput,
  type PeerSummaryAlertComparator,
  type PeerSummaryAlertRule,
  type UpdatePeerSummaryAlertRuleInput,
} from './types.js'

interface AlertRuleRow {
  id: string
  source: string
  metric: string
  comparator: string
  threshold: number
  label: string | null
  enabled: number
  created_at: number
  updated_at: number
}

function rowToRule(r: AlertRuleRow): PeerSummaryAlertRule {
  return {
    id: r.id,
    source: r.source,
    metric: r.metric,
    // Stored comparator is always valid (validated on write); cast is safe.
    comparator: r.comparator as PeerSummaryAlertComparator,
    threshold: r.threshold,
    label: r.label ?? null,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Trim + reject empty. source / metric are both mandatory routing keys. */
function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `alert rule ${field} must be a non-empty string`,
    })
  }
  return value.trim()
}

function requireComparator(value: unknown): PeerSummaryAlertComparator {
  if (
    typeof value !== 'string' ||
    !PEER_SUMMARY_ALERT_COMPARATORS.includes(value as PeerSummaryAlertComparator)
  ) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `alert rule comparator must be one of ${PEER_SUMMARY_ALERT_COMPARATORS.join('/')}`,
    })
  }
  return value as PeerSummaryAlertComparator
}

function requireThreshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new IdentityError({
      code: 'invalid_input',
      message: 'alert rule threshold must be a finite number',
    })
  }
  return value
}

/** Optional trimmed label → null when absent/empty. */
function normLabel(value: string | null | undefined): string | null {
  if (value == null) return null
  const t = value.trim()
  return t.length > 0 ? t : null
}

export class PeerSummaryAlertRuleStore {
  private readonly stmtInsert: SqliteStmt
  private readonly stmtById: SqliteStmt
  private readonly stmtList: SqliteStmt
  private readonly stmtUpdate: SqliteStmt
  private readonly stmtDelete: SqliteStmt

  constructor(private readonly db: SqliteDb) {
    this.stmtInsert = db.prepare(
      `INSERT INTO peer_summary_alert_rules
         (id, source, metric, comparator, threshold, label, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.stmtById = db.prepare('SELECT * FROM peer_summary_alert_rules WHERE id = ?')
    // Tiebreak by SQLite's monotonic rowid (insertion order), NOT the random
    // `asr_<hex>` id — two rules added in the same millisecond must still list
    // in creation order, not by an arbitrary hex sort.
    this.stmtList = db.prepare('SELECT * FROM peer_summary_alert_rules ORDER BY created_at ASC, rowid ASC')
    this.stmtUpdate = db.prepare(
      `UPDATE peer_summary_alert_rules
         SET source = ?, metric = ?, comparator = ?, threshold = ?, label = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
    )
    this.stmtDelete = db.prepare('DELETE FROM peer_summary_alert_rules WHERE id = ?')
  }

  private rowById(id: string): AlertRuleRow | undefined {
    return this.stmtById.get(id) as AlertRuleRow | undefined
  }

  /** Create a rule. `id` is generated (`asr_<hex>`) when not supplied. */
  add(input: AddPeerSummaryAlertRuleInput): PeerSummaryAlertRule {
    const id =
      input.id !== undefined ? requireNonEmpty(input.id, 'id') : `asr_${randomBytes(8).toString('hex')}`
    const source = requireNonEmpty(input.source, 'source')
    const metric = requireNonEmpty(input.metric, 'metric')
    const comparator = requireComparator(input.comparator)
    const threshold = requireThreshold(input.threshold)
    const label = normLabel(input.label)
    const enabled = input.enabled === false ? 0 : 1

    const now = Date.now()
    try {
      this.stmtInsert.run(id, source, metric, comparator, threshold, label, enabled, now, now)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/UNIQUE|PRIMARY KEY/i.test(msg)) {
        throw new IdentityError({
          code: 'alert_rule_exists',
          message: `an alert rule with id ${id} already exists`,
        })
      }
      throw err
    }
    return rowToRule(this.rowById(id)!)
  }

  get(id: string): PeerSummaryAlertRule | null {
    if (typeof id !== 'string' || id.length === 0) return null
    const r = this.rowById(id)
    return r ? rowToRule(r) : null
  }

  list(): PeerSummaryAlertRule[] {
    return (this.stmtList.all() as AlertRuleRow[]).map(rowToRule)
  }

  /** Targeted update (undefined = keep). `id` is immutable. */
  update(id: string, patch: UpdatePeerSummaryAlertRuleInput): PeerSummaryAlertRule {
    const r = this.rowById(id)
    if (!r) {
      throw new IdentityError({ code: 'alert_rule_not_found', message: `no alert rule ${id}` })
    }
    const source = patch.source !== undefined ? requireNonEmpty(patch.source, 'source') : r.source
    const metric = patch.metric !== undefined ? requireNonEmpty(patch.metric, 'metric') : r.metric
    const comparator =
      patch.comparator !== undefined ? requireComparator(patch.comparator) : (r.comparator as PeerSummaryAlertComparator)
    const threshold = patch.threshold !== undefined ? requireThreshold(patch.threshold) : r.threshold
    const label = patch.label !== undefined ? normLabel(patch.label) : r.label
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : r.enabled

    this.stmtUpdate.run(source, metric, comparator, threshold, label, enabled, Date.now(), id)
    return rowToRule(this.rowById(id)!)
  }

  remove(id: string): boolean {
    const r = this.rowById(id)
    if (!r) return false
    this.stmtDelete.run(id)
    return true
  }
}
