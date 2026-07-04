/**
 * A2aAgentStore — Route B P1-M11a, the OUTBOUND A2A agent registry.
 *
 * Persists the config that makes a local capability dispatch reach OUT to an
 * external A2A agent (the mirror of the inbound A2aServer). Replaces the
 * `GOTONG_A2A_AGENTS` env blob with admin-editable, restart-surviving rows.
 *
 * Modeled on SamlProviderStore, NOT OidcProviderStore: there is no vault here.
 * The one credential — the bearer the remote demands — is deliberately NOT
 * stored. `tokenEnv` names the env var the host reads it from at registration
 * time, so the secret stays in the normal env channel and never lands in the
 * DB or an admin HTTP body. Every column this store touches is non-secret.
 *
 * The PK is the LOCAL participant id (admin-supplied, the dispatch target),
 * unique on the hub — so there is no synthetic id and no separate UNIQUE
 * column. A reused id throws `a2a_agent_exists`.
 */

import { type SqliteDb, type SqliteStmt } from './db.js'
import { IdentityError } from './errors.js'
import type {
  A2aOutboundAgent,
  A2aOutboundLifecycle,
  AddA2aOutboundAgentInput,
  UpdateA2aOutboundAgentInput,
} from './types.js'

interface A2aAgentRow {
  id: string
  capabilities: string
  url: string
  token_env: string
  peer_id: string | null
  target_skill: string | null
  lifecycle: string | null
  allowed_data_classes_json: string | null
  outbound_quota_budget: number | null
  require_approval_outbound: number
  enabled: number
  label: string | null
  created_at: number
  updated_at: number
}

/**
 * Parse the stored capabilities JSON back to a string[]. A corrupt value (only
 * reachable by hand-editing the DB) degrades to `[]` — an agent with no
 * capabilities routes nothing, so it's inert rather than crashing boot.
 */
function parseCapabilities(json: string): string[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : []
  } catch {
    return []
  }
}

/**
 * Read the stored lifecycle JSON back to the participant option shape. Tolerant:
 * NULL → null (blocking). Corrupt JSON / a non-object (only reachable by
 * hand-editing the DB) → null, so a bad value is inert-blocking rather than
 * crashing boot. Only positive-number tuning fields survive; everything else is
 * dropped. An empty stored object `{}` round-trips to `{}` = lifecycle ON with
 * the participant's defaults (distinct from NULL = OFF).
 */
function parseLifecycle(json: string | null): A2aOutboundLifecycle | null {
  if (json == null) return null
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const out: A2aOutboundLifecycle = {}
  if (typeof o.pollIntervalMs === 'number' && Number.isFinite(o.pollIntervalMs) && o.pollIntervalMs > 0) {
    out.pollIntervalMs = Math.floor(o.pollIntervalMs)
  }
  if (typeof o.maxAttempts === 'number' && Number.isFinite(o.maxAttempts) && o.maxAttempts > 0) {
    out.maxAttempts = Math.floor(o.maxAttempts)
  }
  return out
}

/**
 * Validate + serialize a lifecycle on the write path. null/undefined → NULL
 * (blocking). An object validates structurally (each present field a positive
 * number) and serializes — including `{}` → `'{}'` (lifecycle on, defaults). A
 * non-object non-null value throws `invalid_input` (fail-visible, not silently
 * dropped). The participant owns flooring; identity only rejects nonsense.
 */
function normLifecycle(value: A2aOutboundLifecycle | null | undefined): string | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityError({
      code: 'invalid_input',
      message: 'a2a agent lifecycle must be an object or null',
    })
  }
  const out: A2aOutboundLifecycle = {}
  if (value.pollIntervalMs !== undefined) {
    const n = value.pollIntervalMs
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'a2a agent lifecycle.pollIntervalMs must be a positive number',
      })
    }
    out.pollIntervalMs = Math.floor(n)
  }
  if (value.maxAttempts !== undefined) {
    const n = value.maxAttempts
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'a2a agent lifecycle.maxAttempts must be a positive number',
      })
    }
    out.maxAttempts = Math.floor(n)
  }
  return JSON.stringify(out)
}

/**
 * Item 2 — read the stored data-class allowlist JSON back to the gate's shape.
 * Mirrors peer-store `parsePolicyArray` (the P4-M4 precedent): NULL → null = no
 * contract (send anything, legacy); a JSON array → trimmed string[]; corrupt
 * JSON / a non-array (only reachable by hand-editing the DB) → null = inert
 * (no contract), consistent with how the mesh edge degrades a corrupt column.
 * An empty stored array `'[]'` round-trips to `[]` = LOCKDOWN (distinct from
 * NULL = off), so the host gate (`checkOutboundDataClasses`) refuses every
 * declared class.
 */
function parseDataClasses(json: string | null): string[] | null {
  if (json == null) return null
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(v)) return null
  return v.filter((c): c is string => typeof c === 'string')
}

/**
 * Item 2 — validate + serialize a data-class allowlist on the write path.
 * null/undefined → NULL (no contract / clear). An array serializes its
 * non-empty trimmed string elements — including `[]` → `'[]'` (lockdown). A
 * non-array non-null value throws `invalid_input` (fail-visible, mirroring
 * `normLifecycle`).
 */
function normDataClasses(value: readonly string[] | null | undefined): string | null {
  if (value == null) return null
  if (!Array.isArray(value)) {
    throw new IdentityError({
      code: 'invalid_input',
      message: 'a2a agent allowedDataClasses must be a string[] or null',
    })
  }
  const classes = value
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
  return JSON.stringify(classes)
}

/**
 * Item 2 — validate an outbound quota budget on the write path. null/undefined
 * → null (no quota). A finite non-negative number floors to an integer (0 = a
 * persisted "off"). Negative / non-finite / non-number throws `invalid_input`.
 * The host owns the window + limiter; identity only rejects nonsense.
 */
function normQuota(value: number | null | undefined): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: 'a2a agent outboundQuotaBudget must be a non-negative number or null',
    })
  }
  return Math.floor(value)
}

function rowToAgent(r: A2aAgentRow): A2aOutboundAgent {
  return {
    id: r.id,
    capabilities: parseCapabilities(r.capabilities),
    url: r.url,
    tokenEnv: r.token_env,
    peerId: r.peer_id ?? null,
    targetSkill: r.target_skill ?? null,
    lifecycle: parseLifecycle(r.lifecycle ?? null),
    allowedDataClasses: parseDataClasses(r.allowed_data_classes_json ?? null),
    outboundQuotaBudget: typeof r.outbound_quota_budget === 'number' ? r.outbound_quota_budget : null,
    requireApprovalOutbound: r.require_approval_outbound === 1,
    enabled: r.enabled === 1,
    label: r.label ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Trim + reject empty; id / url / tokenEnv are all mandatory. */
function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `a2a agent ${field} must be a non-empty string`,
    })
  }
  return value.trim()
}

/** At least one non-empty capability string; that's the dispatch routing key. */
function requireCapabilities(value: unknown): string[] {
  const caps = Array.isArray(value)
    ? value.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim())
    : []
  if (caps.length === 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: 'a2a agent capabilities must be a non-empty string[]',
    })
  }
  return caps
}

/** Optional trimmed field → null when absent/empty (peer_id, target_skill, label). */
function normOptional(value: string | null | undefined): string | null {
  if (value == null) return null
  const t = value.trim()
  return t.length > 0 ? t : null
}

export class A2aAgentStore {
  private readonly stmtInsert: SqliteStmt
  private readonly stmtById: SqliteStmt
  private readonly stmtList: SqliteStmt
  private readonly stmtUpdate: SqliteStmt
  private readonly stmtDelete: SqliteStmt

  constructor(private readonly db: SqliteDb) {
    this.stmtInsert = db.prepare(
      `INSERT INTO a2a_outbound_agents
         (id, capabilities, url, token_env, peer_id, target_skill, lifecycle,
          allowed_data_classes_json, outbound_quota_budget, require_approval_outbound,
          enabled, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.stmtById = db.prepare('SELECT * FROM a2a_outbound_agents WHERE id = ?')
    this.stmtList = db.prepare('SELECT * FROM a2a_outbound_agents ORDER BY created_at ASC')
    this.stmtUpdate = db.prepare(
      `UPDATE a2a_outbound_agents
         SET capabilities = ?, url = ?, token_env = ?, peer_id = ?, target_skill = ?, lifecycle = ?,
             allowed_data_classes_json = ?, outbound_quota_budget = ?, require_approval_outbound = ?,
             enabled = ?, label = ?, updated_at = ?
         WHERE id = ?`,
    )
    this.stmtDelete = db.prepare('DELETE FROM a2a_outbound_agents WHERE id = ?')
  }

  private rowById(id: string): A2aAgentRow | undefined {
    return this.stmtById.get(id) as A2aAgentRow | undefined
  }

  /**
   * Register an outbound A2A agent. A reused id (the participant identity)
   * throws `a2a_agent_exists` — one registration per hub-local dispatch target.
   */
  add(input: AddA2aOutboundAgentInput): A2aOutboundAgent {
    const id = requireNonEmpty(input.id, 'id')
    const capabilities = requireCapabilities(input.capabilities)
    const url = requireNonEmpty(input.url, 'url')
    const tokenEnv = requireNonEmpty(input.tokenEnv, 'tokenEnv')
    const peerId = normOptional(input.peerId)
    const targetSkill = normOptional(input.targetSkill)
    const lifecycle = normLifecycle(input.lifecycle)
    const allowedDataClasses = normDataClasses(input.allowedDataClasses)
    const outboundQuotaBudget = normQuota(input.outboundQuotaBudget)
    const requireApprovalOutbound = input.requireApprovalOutbound ? 1 : 0
    const enabled = input.enabled === false ? 0 : 1
    const label = normOptional(input.label)

    const now = Date.now()
    try {
      this.stmtInsert.run(
        id,
        JSON.stringify(capabilities),
        url,
        tokenEnv,
        peerId,
        targetSkill,
        lifecycle,
        allowedDataClasses,
        outboundQuotaBudget,
        requireApprovalOutbound,
        enabled,
        label,
        now,
        now,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/UNIQUE|PRIMARY KEY/i.test(msg)) {
        throw new IdentityError({
          code: 'a2a_agent_exists',
          message: `an outbound A2A agent with id ${id} already exists`,
        })
      }
      throw err
    }
    return rowToAgent(this.rowById(id)!)
  }

  get(id: string): A2aOutboundAgent | null {
    if (typeof id !== 'string' || id.length === 0) return null
    const r = this.rowById(id)
    return r ? rowToAgent(r) : null
  }

  list(): A2aOutboundAgent[] {
    return (this.stmtList.all() as A2aAgentRow[]).map(rowToAgent)
  }

  /**
   * Targeted update (undefined = keep). `id` is immutable — it's the
   * participant identity; re-add under a new id to rename the dispatch target.
   */
  update(id: string, patch: UpdateA2aOutboundAgentInput): A2aOutboundAgent {
    const r = this.rowById(id)
    if (!r) {
      throw new IdentityError({ code: 'a2a_agent_not_found', message: `no outbound A2A agent ${id}` })
    }

    const capabilities =
      patch.capabilities !== undefined ? requireCapabilities(patch.capabilities) : parseCapabilities(r.capabilities)
    const url = patch.url !== undefined ? requireNonEmpty(patch.url, 'url') : r.url
    const tokenEnv = patch.tokenEnv !== undefined ? requireNonEmpty(patch.tokenEnv, 'tokenEnv') : r.token_env
    const peerId = patch.peerId !== undefined ? normOptional(patch.peerId) : r.peer_id
    const targetSkill = patch.targetSkill !== undefined ? normOptional(patch.targetSkill) : r.target_skill
    // undefined = keep the raw stored value; null = turn lifecycle off; object = set it.
    const lifecycle = patch.lifecycle !== undefined ? normLifecycle(patch.lifecycle) : r.lifecycle
    // undefined = keep; null = clear contract; [] = lockdown; list = allowlist.
    const allowedDataClasses =
      patch.allowedDataClasses !== undefined ? normDataClasses(patch.allowedDataClasses) : r.allowed_data_classes_json
    // undefined = keep; null = clear quota; >=0 = set budget.
    const outboundQuotaBudget =
      patch.outboundQuotaBudget !== undefined ? normQuota(patch.outboundQuotaBudget) : r.outbound_quota_budget
    const requireApprovalOutbound =
      patch.requireApprovalOutbound !== undefined
        ? patch.requireApprovalOutbound
          ? 1
          : 0
        : r.require_approval_outbound
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : r.enabled
    const label = patch.label !== undefined ? normOptional(patch.label) : r.label

    this.stmtUpdate.run(
      JSON.stringify(capabilities),
      url,
      tokenEnv,
      peerId,
      targetSkill,
      lifecycle,
      allowedDataClasses,
      outboundQuotaBudget,
      requireApprovalOutbound,
      enabled,
      label,
      Date.now(),
      id,
    )
    return rowToAgent(this.rowById(id)!)
  }

  /** Delete the registration. No secret to revoke (the bearer lives in env). */
  remove(id: string): boolean {
    const r = this.rowById(id)
    if (!r) return false
    this.stmtDelete.run(id)
    return true
  }
}
