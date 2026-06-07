/**
 * PeerSummaryAlertChannelStore — v5 Stream F, the notification channel registry
 * for the control-plane alert dispatcher.
 *
 * Stream F could only SHOW live breaches in the admin UI; day-3 delivered them
 * to `'webhook'` channels, and the multi-channel pass added `'im'` (a stateless
 * send to a platform renderer) and `'email'`. A channel is a destination + a
 * toggle: `kind` picks the dispatcher branch, `platform` + `target` carry the
 * im/email destination (v30, additive nullable columns).
 *
 * Modeled on A2aAgentStore: a small config table with full CRUD and NO vault.
 * The only sensitive bit is an optional `headerEnv`, which is an ENVIRONMENT
 * VARIABLE NAME (not the bearer) — the host reads the value at delivery time so
 * the secret never touches the database. Identity validates only the generic
 * structural bits (kind ∈ closed set, url is http/https, header_env looks like
 * an env-var name, im → platform ∈ closed set, email → target present) so a
 * malformed channel fails fast at the boundary.
 */

import { randomBytes } from 'node:crypto'

import { type SqliteDb, type SqliteStmt } from './db.js'
import { IdentityError } from './errors.js'
import {
  PEER_SUMMARY_ALERT_CHANNEL_KINDS,
  PEER_SUMMARY_ALERT_IM_PLATFORMS,
  type AddPeerSummaryAlertChannelInput,
  type PeerSummaryAlertChannel,
  type PeerSummaryAlertChannelKind,
  type PeerSummaryAlertImPlatform,
  type UpdatePeerSummaryAlertChannelInput,
} from './types.js'

interface ChannelRow {
  id: string
  kind: string
  url: string
  header_env: string | null
  platform: string | null
  target: string | null
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
    platform: (r.platform ?? null) as PeerSummaryAlertImPlatform | null,
    target: r.target ?? null,
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

/** A delivery url must be a well-formed http/https URL (no file:/data:/etc). */
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

/**
 * `platform` is meaningful only for `kind:'im'`: required there and drawn from
 * the closed renderer set; forced to null for webhook/email so a stale value
 * can't survive a kind change.
 */
function requirePlatform(
  value: unknown,
  kind: PeerSummaryAlertChannelKind,
): PeerSummaryAlertImPlatform | null {
  if (kind !== 'im') return null
  if (
    typeof value !== 'string' ||
    !PEER_SUMMARY_ALERT_IM_PLATFORMS.includes(value as PeerSummaryAlertImPlatform)
  ) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `im alert channel platform must be one of ${PEER_SUMMARY_ALERT_IM_PLATFORMS.join('/')}`,
    })
  }
  return value as PeerSummaryAlertImPlatform
}

/**
 * `target` is the destination within the endpoint. email REQUIRES it (the
 * recipient); im MAY carry it (a chat/room id — incoming-webhook platforms
 * target via the url instead); webhook never has one.
 */
function requireTarget(value: unknown, kind: PeerSummaryAlertChannelKind): string | null {
  if (kind === 'webhook') return null
  if (kind === 'email') return requireNonEmpty(value, 'target (email recipient)')
  // im: optional.
  if (value == null) return null
  const t = String(value).trim()
  return t.length > 0 ? t : null
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
         (id, kind, url, header_env, platform, target, enabled, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.stmtById = db.prepare('SELECT * FROM peer_summary_alert_channels WHERE id = ?')
    // Tiebreak by monotonic rowid (insertion order), not the random psac_ id.
    this.stmtList = db.prepare(
      'SELECT * FROM peer_summary_alert_channels ORDER BY created_at ASC, rowid ASC',
    )
    this.stmtUpdate = db.prepare(
      `UPDATE peer_summary_alert_channels
         SET kind = ?, url = ?, header_env = ?, platform = ?, target = ?, enabled = ?, label = ?, updated_at = ?
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
    const platform = requirePlatform(input.platform, kind)
    const target = requireTarget(input.target, kind)
    const label = normLabel(input.label)
    const enabled = input.enabled === false ? 0 : 1

    const now = Date.now()
    try {
      this.stmtInsert.run(id, kind, url, headerEnv, platform, target, enabled, label, now, now)
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
    // platform/target validity depends on the EFFECTIVE kind: re-derive when
    // either the field or the kind itself changed, so a kind switch scrubs a
    // now-irrelevant value (im→webhook nulls the platform) and an email kind
    // re-checks that a recipient is present. Otherwise keep the stored value.
    const platform =
      patch.platform !== undefined || patch.kind !== undefined
        ? requirePlatform(patch.platform !== undefined ? patch.platform : r.platform, kind)
        : r.platform
    const target =
      patch.target !== undefined || patch.kind !== undefined
        ? requireTarget(patch.target !== undefined ? patch.target : r.target, kind)
        : r.target
    const label = patch.label !== undefined ? normLabel(patch.label) : r.label
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : r.enabled

    this.stmtUpdate.run(kind, url, headerEnv, platform, target, enabled, label, Date.now(), id)
    return rowToChannel(this.rowById(id)!)
  }

  remove(id: string): boolean {
    const r = this.rowById(id)
    if (!r) return false
    this.stmtDelete.run(id)
    return true
  }
}
