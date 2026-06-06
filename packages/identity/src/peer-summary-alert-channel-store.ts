/**
 * PeerSummaryAlertChannelStore — v5 Stream F day-3, the notification channel
 * registry for the control-plane alert dispatcher.
 *
 * Stream F could only SHOW live breaches in the admin UI; day-3 delivers them.
 * A channel is a destination + a toggle: the MVP kind is `'webhook'` (a
 * fire-and-forget HTTP POST of the counts-only firing payload), with `kind`
 * left extensible so `'im'` / `'email'` can land later without a migration.
 *
 * Modeled on A2aAgentStore: a small config table with full CRUD and NO vault.
 * The only sensitive bit is an optional `headerEnv`, which is an ENVIRONMENT
 * VARIABLE NAME (not the bearer) — the host reads the value at delivery time so
 * the secret never touches the database. Identity validates only the generic
 * structural bits (kind ∈ closed set, url is http/https, header_env looks like
 * an env-var name) so a malformed channel fails fast at the boundary.
 */

import { randomBytes } from 'node:crypto'

import { type SqliteDb, type SqliteStmt } from './db.js'
import { IdentityError } from './errors.js'
import {
  PEER_SUMMARY_ALERT_CHANNEL_KINDS,
  type AddPeerSummaryAlertChannelInput,
  type PeerSummaryAlertChannel,
  type PeerSummaryAlertChannelKind,
  type UpdatePeerSummaryAlertChannelInput,
} from './types.js'

interface ChannelRow {
  id: string
  kind: string
  url: string
  header_env: string | null
  enabled: number
  label: string | null
  created_at: number
  updated_at: number
}

function rowToChannel(r: ChannelRow): PeerSummaryAlertChannel {
  return {
    id: r.id,
    // Stored kind is always valid (validated on write); cast is safe.
    kind: r.kind as PeerSummaryAlertChannelKind,
    url: r.url,
    headerEnv: r.header_env ?? null,
    enabled: r.enabled === 1,
    label: r.label ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Trim + reject empty. */
function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `alert channel ${field} must be a non-empty string`,
    })
  }
  return value.trim()
}

function requireKind(value: unknown): PeerSummaryAlertChannelKind {
  if (
    typeof value !== 'string' ||
    !PEER_SUMMARY_ALERT_CHANNEL_KINDS.includes(value as PeerSummaryAlertChannelKind)
  ) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `alert channel kind must be one of ${PEER_SUMMARY_ALERT_CHANNEL_KINDS.join('/')}`,
    })
  }
  return value as PeerSummaryAlertChannelKind
}

/** A webhook url must be a well-formed http/https URL (no file:/data:/etc). */
function requireUrl(value: unknown): string {
  const raw = requireNonEmpty(value, 'url')
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new IdentityError({ code: 'invalid_input', message: `alert channel url is not a valid URL: ${raw}` })
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new IdentityError({
      code: 'invalid_input',
      message: `alert channel url must be http(s); got ${u.protocol}`,
    })
  }
  return raw
}

/** Optional env-var NAME → null when absent/empty; must look like an env var. */
function normHeaderEnv(value: string | null | undefined): string | null {
  if (value == null) return null
  const t = value.trim()
  if (t.length === 0) return null
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `alert channel headerEnv must be a valid env-var NAME (not the secret value): ${t}`,
    })
  }
  return t
}

/** Optional trimmed label → null when absent/empty. */
function normLabel(value: string | null | undefined): string | null {
  if (value == null) return null
  const t = value.trim()
  return t.length > 0 ? t : null
}

export class PeerSummaryAlertChannelStore {
  private readonly stmtInsert: SqliteStmt
  private readonly stmtById: SqliteStmt
  private readonly stmtList: SqliteStmt
  private readonly stmtUpdate: SqliteStmt
  private readonly stmtDelete: SqliteStmt

  constructor(private readonly db: SqliteDb) {
    this.stmtInsert = db.prepare(
      `INSERT INTO peer_summary_alert_channels
         (id, kind, url, header_env, enabled, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.stmtById = db.prepare('SELECT * FROM peer_summary_alert_channels WHERE id = ?')
    // Tiebreak by monotonic rowid (insertion order), not the random psac_ id.
    this.stmtList = db.prepare(
      'SELECT * FROM peer_summary_alert_channels ORDER BY created_at ASC, rowid ASC',
    )
    this.stmtUpdate = db.prepare(
      `UPDATE peer_summary_alert_channels
         SET kind = ?, url = ?, header_env = ?, enabled = ?, label = ?, updated_at = ?
         WHERE id = ?`,
    )
    this.stmtDelete = db.prepare('DELETE FROM peer_summary_alert_channels WHERE id = ?')
  }

  private rowById(id: string): ChannelRow | undefined {
    return this.stmtById.get(id) as ChannelRow | undefined
  }

  /** Create a channel. `id` is generated (`psac_<hex>`) when not supplied. */
  add(input: AddPeerSummaryAlertChannelInput): PeerSummaryAlertChannel {
    const id =
      input.id !== undefined ? requireNonEmpty(input.id, 'id') : `psac_${randomBytes(8).toString('hex')}`
    const kind = requireKind(input.kind)
    const url = requireUrl(input.url)
    const headerEnv = normHeaderEnv(input.headerEnv)
    const label = normLabel(input.label)
    const enabled = input.enabled === false ? 0 : 1

    const now = Date.now()
    try {
      this.stmtInsert.run(id, kind, url, headerEnv, enabled, label, now, now)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/UNIQUE|PRIMARY KEY/i.test(msg)) {
        throw new IdentityError({
          code: 'alert_channel_exists',
          message: `an alert channel with id ${id} already exists`,
        })
      }
      throw err
    }
    return rowToChannel(this.rowById(id)!)
  }

  get(id: string): PeerSummaryAlertChannel | null {
    if (typeof id !== 'string' || id.length === 0) return null
    const r = this.rowById(id)
    return r ? rowToChannel(r) : null
  }

  list(): PeerSummaryAlertChannel[] {
    return (this.stmtList.all() as ChannelRow[]).map(rowToChannel)
  }

  /** Targeted update (undefined = keep). `id` is immutable. */
  update(id: string, patch: UpdatePeerSummaryAlertChannelInput): PeerSummaryAlertChannel {
    const r = this.rowById(id)
    if (!r) {
      throw new IdentityError({ code: 'alert_channel_not_found', message: `no alert channel ${id}` })
    }
    const kind = patch.kind !== undefined ? requireKind(patch.kind) : (r.kind as PeerSummaryAlertChannelKind)
    const url = patch.url !== undefined ? requireUrl(patch.url) : r.url
    const headerEnv = patch.headerEnv !== undefined ? normHeaderEnv(patch.headerEnv) : r.header_env
    const label = patch.label !== undefined ? normLabel(patch.label) : r.label
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : r.enabled

    this.stmtUpdate.run(kind, url, headerEnv, enabled, label, Date.now(), id)
    return rowToChannel(this.rowById(id)!)
  }

  remove(id: string): boolean {
    const r = this.rowById(id)
    if (!r) return false
    this.stmtDelete.run(id)
    return true
  }
}
