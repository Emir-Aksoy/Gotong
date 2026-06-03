/**
 * A2aAgentStore — Route B P1-M11a, the OUTBOUND A2A agent registry.
 *
 * Persists the config that makes a local capability dispatch reach OUT to an
 * external A2A agent (the mirror of the inbound A2aServer). Replaces the
 * `AIPE_A2A_AGENTS` env blob with admin-editable, restart-surviving rows.
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

function rowToAgent(r: A2aAgentRow): A2aOutboundAgent {
  return {
    id: r.id,
    capabilities: parseCapabilities(r.capabilities),
    url: r.url,
    tokenEnv: r.token_env,
    peerId: r.peer_id ?? null,
    targetSkill: r.target_skill ?? null,
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
         (id, capabilities, url, token_env, peer_id, target_skill, enabled, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.stmtById = db.prepare('SELECT * FROM a2a_outbound_agents WHERE id = ?')
    this.stmtList = db.prepare('SELECT * FROM a2a_outbound_agents ORDER BY created_at ASC')
    this.stmtUpdate = db.prepare(
      `UPDATE a2a_outbound_agents
         SET capabilities = ?, url = ?, token_env = ?, peer_id = ?, target_skill = ?, enabled = ?, label = ?, updated_at = ?
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
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : r.enabled
    const label = patch.label !== undefined ? normOptional(patch.label) : r.label

    this.stmtUpdate.run(
      JSON.stringify(capabilities),
      url,
      tokenEnv,
      peerId,
      targetSkill,
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
