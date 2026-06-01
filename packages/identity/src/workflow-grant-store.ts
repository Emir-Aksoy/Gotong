/**
 * WorkflowGrantStore — Phase 19 P2-M5 resource-level RBAC for workflows.
 *
 * One row per (workflowId, userId). The OWNER is just the grant with
 * perm='owner', so ownership and sharing share one model and one table — no
 * separate owner column anywhere. Perms form a ladder owner > editor > viewer
 * (compared by rank, not a SQL CHECK, so the ladder can grow without a
 * migration). The composite PK gives upsert-on-regrant and exactly one perm
 * per user per workflow.
 *
 * Mechanism only: this store answers "who may touch workflow X, at what level"
 * and "what may user U touch". Policy questions like "an org owner bypasses
 * grants" or "transfer ownership demotes the old owner" belong to the caller
 * (the host/web enforcement layer in M5b), which composes these primitives.
 *
 * No FK to users — a deleted user's grant simply dangles and is prunable, the
 * same append-friendly posture as audit_log. All statements are fixed shapes,
 * eagerly prepared.
 */

import { type SqliteDb, type SqliteStmt } from './db.js'
import { IdentityError } from './errors.js'
import {
  WORKFLOW_PERMS,
  WORKFLOW_PERM_RANK,
  type SetWorkflowGrantInput,
  type WorkflowGrant,
  type WorkflowPerm,
} from './types.js'

/** Sqlite row shape — snake_case mirrors the schema verbatim. */
interface GrantRow {
  workflow_id: string
  user_id: string
  perm: string
  granted_by: string | null
  granted_at: number
}

export class WorkflowGrantStore {
  private readonly db: SqliteDb
  private readonly stmtUpsert: SqliteStmt
  private readonly stmtGet: SqliteStmt
  private readonly stmtByWorkflow: SqliteStmt
  private readonly stmtByUser: SqliteStmt
  private readonly stmtRemove: SqliteStmt
  private readonly stmtRemoveAll: SqliteStmt

  constructor(db: SqliteDb) {
    this.db = db
    // INSERT OR REPLACE on the (workflow_id, user_id) PK = upsert. A regrant
    // overwrites perm + granted_by + granted_at for that pair.
    this.stmtUpsert = db.prepare(
      `INSERT OR REPLACE INTO workflow_grants
         (workflow_id, user_id, perm, granted_by, granted_at)
       VALUES(?, ?, ?, ?, ?)`,
    )
    this.stmtGet = db.prepare(
      'SELECT * FROM workflow_grants WHERE workflow_id = ? AND user_id = ?',
    )
    this.stmtByWorkflow = db.prepare(
      'SELECT * FROM workflow_grants WHERE workflow_id = ? ORDER BY granted_at ASC',
    )
    this.stmtByUser = db.prepare(
      'SELECT * FROM workflow_grants WHERE user_id = ? ORDER BY granted_at ASC',
    )
    this.stmtRemove = db.prepare(
      'DELETE FROM workflow_grants WHERE workflow_id = ? AND user_id = ?',
    )
    this.stmtRemoveAll = db.prepare(
      'DELETE FROM workflow_grants WHERE workflow_id = ?',
    )
  }

  /** Upsert a grant. Returns the persisted row. */
  set(input: SetWorkflowGrantInput): WorkflowGrant {
    if (!input || typeof input !== 'object') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'setWorkflowGrant: input object required',
      })
    }
    const workflowId = assertNonEmptyStr(input.workflowId, 'workflowId')
    const userId = assertNonEmptyStr(input.userId, 'userId')
    const perm = assertPerm(input.perm)
    const grantedBy = input.grantedBy ?? null
    const grantedAt = input.grantedAt ?? Date.now()
    this.stmtUpsert.run(workflowId, userId, perm, grantedBy, grantedAt)
    return { workflowId, userId, perm, grantedBy, grantedAt }
  }

  /** The grant for one (workflow, user), or null. */
  get(workflowId: string, userId: string): WorkflowGrant | null {
    const row = this.stmtGet.get(workflowId, userId) as GrantRow | undefined
    return row ? rowToGrant(row) : null
  }

  /**
   * Does `userId` hold at least `min` permission on `workflowId`? A missing
   * grant → false. An unknown stored perm (manual db edit) → false (fail
   * closed). This is the hot-path check the enforcement layer calls.
   */
  has(workflowId: string, userId: string, min: WorkflowPerm): boolean {
    const row = this.stmtGet.get(workflowId, userId) as GrantRow | undefined
    if (!row) return false
    const rank = WORKFLOW_PERM_RANK[row.perm as WorkflowPerm]
    if (rank === undefined) return false
    return rank >= WORKFLOW_PERM_RANK[min]
  }

  /** All grants on a workflow, oldest-first (the owner seed leads). */
  listForWorkflow(workflowId: string): WorkflowGrant[] {
    const rows = this.stmtByWorkflow.all(workflowId) as GrantRow[]
    return rows.map(rowToGrant)
  }

  /** All grants a user holds, oldest-first. Backs the /me + self views. */
  listForUser(userId: string): WorkflowGrant[] {
    const rows = this.stmtByUser.all(userId) as GrantRow[]
    return rows.map(rowToGrant)
  }

  /** Remove one grant. Returns true iff a row was deleted. */
  remove(workflowId: string, userId: string): boolean {
    return this.stmtRemove.run(workflowId, userId).changes > 0
  }

  /** Drop every grant on a workflow (call when the workflow is deleted). */
  removeAllForWorkflow(workflowId: string): number {
    return this.stmtRemoveAll.run(workflowId).changes
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function rowToGrant(r: GrantRow): WorkflowGrant {
  return {
    workflowId: r.workflow_id,
    userId: r.user_id,
    perm: r.perm as WorkflowPerm,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at,
  }
}

function assertNonEmptyStr(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `${label} must be a non-empty string`,
    })
  }
  return v
}

function assertPerm(v: unknown): WorkflowPerm {
  if (typeof v !== 'string' || !WORKFLOW_PERMS.includes(v as WorkflowPerm)) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `perm must be one of ${WORKFLOW_PERMS.join(', ')}; got ${JSON.stringify(v)}`,
    })
  }
  return v as WorkflowPerm
}
