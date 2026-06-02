/**
 * ResourceGrantStore — v5 Stream A-M1, the unified resource-level RBAC store
 * (decision #3). Generalizes WorkflowGrantStore (Phase 19 P2-M5, since folded
 * away) from "user → workflow" to "{@link Principal} → any resource".
 *
 * One row per (resourceKind, resourceId, principal). The OWNER is the
 * perm='owner' row — ownership and sharing are the one model, one table, no
 * separate owner column. Perms form a ladder owner > editor > viewer (compared
 * by rank, not a SQL CHECK, so the ladder can grow without a migration). The
 * composite PK gives upsert-on-regrant and exactly one perm per principal per
 * resource.
 *
 * The principal is serialized to its {@link principalKey} ("<kind>:<id>") for
 * the single TEXT column; reads parse it back. A corrupt principal string in a
 * row fails VISIBLY on read (parsePrincipalKey throws) rather than silently
 * matching nobody.
 *
 * Mechanism only — "who may touch resource X, at what level" and "what may
 * principal P touch". Policy (an owner bypasses grants, an agent owner needs a
 * human for sensitive ops — see agent-authority.ts) belongs to the caller. No
 * FK to users/agents — a deleted principal's grant simply dangles and is
 * prunable, the same append-friendly posture as audit_log.
 */

import { type SqliteDb, type SqliteStmt } from './db.js'
import { IdentityError } from './errors.js'
import { principalKey, parsePrincipalKey, isPrincipalKind, type Principal } from './principal.js'
import {
  GRANT_PERMS,
  GRANT_PERM_RANK,
  RESOURCE_KINDS,
  type GrantPerm,
  type ResourceGrant,
  type ResourceKind,
  type SetResourceGrantInput,
} from './types.js'

/** Sqlite row shape — snake_case mirrors the schema verbatim. */
interface GrantRow {
  resource_kind: string
  resource_id: string
  principal: string
  perm: string
  granted_by: string | null
  granted_at: number
}

export class ResourceGrantStore {
  private readonly stmtUpsert: SqliteStmt
  private readonly stmtGet: SqliteStmt
  private readonly stmtByResource: SqliteStmt
  private readonly stmtByPrincipal: SqliteStmt
  private readonly stmtRemove: SqliteStmt
  private readonly stmtRemoveAll: SqliteStmt

  constructor(db: SqliteDb) {
    // INSERT OR REPLACE on the (resource_kind, resource_id, principal) PK =
    // upsert. A regrant overwrites perm + granted_by + granted_at for the triple.
    this.stmtUpsert = db.prepare(
      `INSERT OR REPLACE INTO resource_grants
         (resource_kind, resource_id, principal, perm, granted_by, granted_at)
       VALUES(?, ?, ?, ?, ?, ?)`,
    )
    this.stmtGet = db.prepare(
      'SELECT * FROM resource_grants WHERE resource_kind = ? AND resource_id = ? AND principal = ?',
    )
    this.stmtByResource = db.prepare(
      'SELECT * FROM resource_grants WHERE resource_kind = ? AND resource_id = ? ORDER BY granted_at ASC',
    )
    this.stmtByPrincipal = db.prepare(
      'SELECT * FROM resource_grants WHERE principal = ? ORDER BY granted_at ASC',
    )
    this.stmtRemove = db.prepare(
      'DELETE FROM resource_grants WHERE resource_kind = ? AND resource_id = ? AND principal = ?',
    )
    this.stmtRemoveAll = db.prepare(
      'DELETE FROM resource_grants WHERE resource_kind = ? AND resource_id = ?',
    )
  }

  /** Upsert a grant. Returns the persisted row. */
  set(input: SetResourceGrantInput): ResourceGrant {
    if (!input || typeof input !== 'object') {
      throw new IdentityError({ code: 'invalid_input', message: 'setResourceGrant: input object required' })
    }
    const resourceKind = assertResourceKind(input.resourceKind)
    const resourceId = assertNonEmptyStr(input.resourceId, 'resourceId')
    const principal = assertPrincipal(input.principal)
    const perm = assertPerm(input.perm)
    const grantedBy = input.grantedBy ?? null
    const grantedAt = input.grantedAt ?? Date.now()
    this.stmtUpsert.run(resourceKind, resourceId, principalKey(principal), perm, grantedBy, grantedAt)
    return { resourceKind, resourceId, principal, perm, grantedBy, grantedAt }
  }

  /** The grant for one (resource, principal), or null. */
  get(resourceKind: ResourceKind, resourceId: string, principal: Principal): ResourceGrant | null {
    const row = this.stmtGet.get(resourceKind, resourceId, principalKey(principal)) as GrantRow | undefined
    return row ? rowToGrant(row) : null
  }

  /**
   * Does `principal` hold at least `min` permission on the resource? A missing
   * grant → false. An unknown stored perm (manual db edit) → false (fail
   * closed). This is the hot-path enforcement check.
   */
  has(resourceKind: ResourceKind, resourceId: string, principal: Principal, min: GrantPerm): boolean {
    const row = this.stmtGet.get(resourceKind, resourceId, principalKey(principal)) as GrantRow | undefined
    if (!row) return false
    const rank = GRANT_PERM_RANK[row.perm as GrantPerm]
    if (rank === undefined) return false
    return rank >= GRANT_PERM_RANK[min]
  }

  /** All grants on a resource, oldest-first (the owner seed leads). */
  listForResource(resourceKind: ResourceKind, resourceId: string): ResourceGrant[] {
    const rows = this.stmtByResource.all(resourceKind, resourceId) as GrantRow[]
    return rows.map(rowToGrant)
  }

  /** All grants a principal holds, oldest-first. Backs the /me + owner views. */
  listForPrincipal(principal: Principal): ResourceGrant[] {
    const rows = this.stmtByPrincipal.all(principalKey(principal)) as GrantRow[]
    return rows.map(rowToGrant)
  }

  /** Remove one grant. Returns true iff a row was deleted. */
  remove(resourceKind: ResourceKind, resourceId: string, principal: Principal): boolean {
    return this.stmtRemove.run(resourceKind, resourceId, principalKey(principal)).changes > 0
  }

  /** Drop every grant on a resource (call when the resource is deleted). */
  removeAllForResource(resourceKind: ResourceKind, resourceId: string): number {
    return this.stmtRemoveAll.run(resourceKind, resourceId).changes
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function rowToGrant(r: GrantRow): ResourceGrant {
  return {
    resourceKind: r.resource_kind as ResourceKind,
    resourceId: r.resource_id,
    // parsePrincipalKey throws on a corrupt key — a malformed grant row should
    // surface, never silently resolve to the wrong / no subject.
    principal: parsePrincipalKey(r.principal),
    perm: r.perm as GrantPerm,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at,
  }
}

function assertNonEmptyStr(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new IdentityError({ code: 'invalid_input', message: `${label} must be a non-empty string` })
  }
  return v
}

function assertResourceKind(v: unknown): ResourceKind {
  if (typeof v !== 'string' || !RESOURCE_KINDS.includes(v as ResourceKind)) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `resourceKind must be one of ${RESOURCE_KINDS.join(', ')}; got ${JSON.stringify(v)}`,
    })
  }
  return v as ResourceKind
}

function assertPerm(v: unknown): GrantPerm {
  if (typeof v !== 'string' || !GRANT_PERMS.includes(v as GrantPerm)) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `perm must be one of ${GRANT_PERMS.join(', ')}; got ${JSON.stringify(v)}`,
    })
  }
  return v as GrantPerm
}

function assertPrincipal(v: unknown): Principal {
  if (!v || typeof v !== 'object') {
    throw new IdentityError({ code: 'invalid_input', message: 'principal must be a { kind, id } object' })
  }
  const p = v as { kind?: unknown; id?: unknown }
  const id = assertNonEmptyStr(p.id, 'principal.id')
  if (typeof p.kind !== 'string' || !isPrincipalKind(p.kind)) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `principal.kind must be one of hub, user, agent, peer; got ${JSON.stringify(p.kind)}`,
    })
  }
  return { kind: p.kind, id }
}
