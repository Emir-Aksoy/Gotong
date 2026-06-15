/**
 * AcpAgentStore — ACP-OUT-M1, the OUTBOUND ACP agent registry.
 *
 * Persists the config that makes a local capability dispatch SPAWN and drive an
 * external coding agent over ACP (Agent Client Protocol) — Claude Code / Codex
 * via their ACP bridges, OpenClaw-style (spawn once, hold one session, dispatch
 * many tasks). The host-side mirror of the inbound `aipehub connect`. Replaces
 * hand-written example glue with admin-editable, restart-surviving rows.
 *
 * Modeled on A2aAgentStore / SamlProviderStore: there is NO vault here, and —
 * unlike a2a — not even an env-var pointer. ACP bridges authenticate with the
 * underlying agent's OWN login (the hub injects no key), so every column is
 * non-secret config: the bridge command, its args, and the working directory.
 *
 * The PK is the LOCAL participant id (admin-supplied, the dispatch target),
 * unique on the hub — so there is no synthetic id. A reused id throws
 * `acp_agent_exists`.
 */

import { type SqliteDb, type SqliteStmt } from './db.js'
import { IdentityError } from './errors.js'
import type {
  AcpOutboundAgent,
  AddAcpOutboundAgentInput,
  UpdateAcpOutboundAgentInput,
} from './types.js'

interface AcpAgentRow {
  id: string
  capabilities: string
  command: string
  args: string
  cwd: string | null
  allowed_data_classes_json: string | null
  outbound_quota_budget: number | null
  enabled: number
  label: string | null
  created_at: number
  updated_at: number
}

/**
 * Parse a stored JSON string[] back to a string[]. A corrupt value (only
 * reachable by hand-editing the DB) degrades to `[]` rather than crashing boot.
 */
function parseStringArray(json: string): string[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : []
  } catch {
    return []
  }
}

function rowToAgent(r: AcpAgentRow): AcpOutboundAgent {
  return {
    id: r.id,
    capabilities: parseStringArray(r.capabilities),
    command: r.command,
    args: parseStringArray(r.args),
    cwd: r.cwd ?? null,
    allowedDataClasses: parseDataClasses(r.allowed_data_classes_json ?? null),
    outboundQuotaBudget: typeof r.outbound_quota_budget === 'number' ? r.outbound_quota_budget : null,
    enabled: r.enabled === 1,
    label: r.label ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Trim + reject empty; id and command are mandatory. */
function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `acp agent ${field} must be a non-empty string`,
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
      message: 'acp agent capabilities must be a non-empty string[]',
    })
  }
  return caps
}

/**
 * Normalize the bridge args. Unlike capabilities, an EMPTY args array is valid
 * (a bare binary like `codex-acp` may take none). Non-string elements are
 * dropped; args are NOT trimmed — a flag/value is passed to the child verbatim.
 */
function normArgs(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new IdentityError({ code: 'invalid_input', message: 'acp agent args must be a string[]' })
  }
  return value.filter((a): a is string => typeof a === 'string')
}

/** Optional trimmed field → null when absent/empty (cwd, label). */
function normOptional(value: string | null | undefined): string | null {
  if (value == null) return null
  const t = value.trim()
  return t.length > 0 ? t : null
}

/**
 * Item 2 — read the stored data-class allowlist JSON back to the gate's shape.
 * Mirrors the a2a store / peer-store P4-M4 precedent: NULL → null = no contract
 * (legacy); a JSON array → string[]; corrupt JSON / a non-array → null = inert.
 * An empty stored array `'[]'` round-trips to `[]` = LOCKDOWN. For ACP this gate
 * is a GOVERNANCE control over what class of context may feed the coding agent.
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
 * null/undefined → NULL; an array serializes its trimmed non-empty strings
 * (`[]` → `'[]'` = lockdown). A non-array non-null throws `invalid_input`.
 */
function normDataClasses(value: readonly string[] | null | undefined): string | null {
  if (value == null) return null
  if (!Array.isArray(value)) {
    throw new IdentityError({
      code: 'invalid_input',
      message: 'acp agent allowedDataClasses must be a string[] or null',
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
 */
function normQuota(value: number | null | undefined): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: 'acp agent outboundQuotaBudget must be a non-negative number or null',
    })
  }
  return Math.floor(value)
}

export class AcpAgentStore {
  private readonly stmtInsert: SqliteStmt
  private readonly stmtById: SqliteStmt
  private readonly stmtList: SqliteStmt
  private readonly stmtUpdate: SqliteStmt
  private readonly stmtDelete: SqliteStmt

  constructor(private readonly db: SqliteDb) {
    this.stmtInsert = db.prepare(
      `INSERT INTO acp_outbound_agents
         (id, capabilities, command, args, cwd,
          allowed_data_classes_json, outbound_quota_budget,
          enabled, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.stmtById = db.prepare('SELECT * FROM acp_outbound_agents WHERE id = ?')
    this.stmtList = db.prepare('SELECT * FROM acp_outbound_agents ORDER BY created_at ASC')
    this.stmtUpdate = db.prepare(
      `UPDATE acp_outbound_agents
         SET capabilities = ?, command = ?, args = ?, cwd = ?,
             allowed_data_classes_json = ?, outbound_quota_budget = ?,
             enabled = ?, label = ?, updated_at = ?
         WHERE id = ?`,
    )
    this.stmtDelete = db.prepare('DELETE FROM acp_outbound_agents WHERE id = ?')
  }

  private rowById(id: string): AcpAgentRow | undefined {
    return this.stmtById.get(id) as AcpAgentRow | undefined
  }

  /**
   * Register an outbound ACP agent. A reused id (the participant identity)
   * throws `acp_agent_exists` — one registration per hub-local dispatch target.
   */
  add(input: AddAcpOutboundAgentInput): AcpOutboundAgent {
    const id = requireNonEmpty(input.id, 'id')
    const capabilities = requireCapabilities(input.capabilities)
    const command = requireNonEmpty(input.command, 'command')
    const args = normArgs(input.args)
    const cwd = normOptional(input.cwd)
    const allowedDataClasses = normDataClasses(input.allowedDataClasses)
    const outboundQuotaBudget = normQuota(input.outboundQuotaBudget)
    const enabled = input.enabled === false ? 0 : 1
    const label = normOptional(input.label)

    const now = Date.now()
    try {
      this.stmtInsert.run(
        id,
        JSON.stringify(capabilities),
        command,
        JSON.stringify(args),
        cwd,
        allowedDataClasses,
        outboundQuotaBudget,
        enabled,
        label,
        now,
        now,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/UNIQUE|PRIMARY KEY/i.test(msg)) {
        throw new IdentityError({
          code: 'acp_agent_exists',
          message: `an outbound ACP agent with id ${id} already exists`,
        })
      }
      throw err
    }
    return rowToAgent(this.rowById(id)!)
  }

  get(id: string): AcpOutboundAgent | null {
    if (typeof id !== 'string' || id.length === 0) return null
    const r = this.rowById(id)
    return r ? rowToAgent(r) : null
  }

  list(): AcpOutboundAgent[] {
    return (this.stmtList.all() as AcpAgentRow[]).map(rowToAgent)
  }

  /**
   * Targeted update (undefined = keep). `id` is immutable — it's the
   * participant identity; re-add under a new id to rename the dispatch target.
   */
  update(id: string, patch: UpdateAcpOutboundAgentInput): AcpOutboundAgent {
    const r = this.rowById(id)
    if (!r) {
      throw new IdentityError({ code: 'acp_agent_not_found', message: `no outbound ACP agent ${id}` })
    }

    const capabilities =
      patch.capabilities !== undefined ? requireCapabilities(patch.capabilities) : parseStringArray(r.capabilities)
    const command = patch.command !== undefined ? requireNonEmpty(patch.command, 'command') : r.command
    const args = patch.args !== undefined ? normArgs(patch.args) : parseStringArray(r.args)
    const cwd = patch.cwd !== undefined ? normOptional(patch.cwd) : r.cwd
    // undefined = keep; null = clear contract; [] = lockdown; list = allowlist.
    const allowedDataClasses =
      patch.allowedDataClasses !== undefined ? normDataClasses(patch.allowedDataClasses) : r.allowed_data_classes_json
    // undefined = keep; null = clear quota; >=0 = set budget.
    const outboundQuotaBudget =
      patch.outboundQuotaBudget !== undefined ? normQuota(patch.outboundQuotaBudget) : r.outbound_quota_budget
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : r.enabled
    const label = patch.label !== undefined ? normOptional(patch.label) : r.label

    this.stmtUpdate.run(
      JSON.stringify(capabilities),
      command,
      JSON.stringify(args),
      cwd,
      allowedDataClasses,
      outboundQuotaBudget,
      enabled,
      label,
      Date.now(),
      id,
    )
    return rowToAgent(this.rowById(id)!)
  }

  /** Delete the registration. No secret to revoke (ACP rides the agent's login). */
  remove(id: string): boolean {
    const r = this.rowById(id)
    if (!r) return false
    this.stmtDelete.run(id)
    return true
  }
}
