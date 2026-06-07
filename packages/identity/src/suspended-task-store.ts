/**
 * SuspendedTaskStore — durable park/resume rows for long-running agents.
 *
 * Extracted from IdentityStore as the second domain of the R13 god-object
 * split (vault was first). Self-contained: it owns the `suspended_tasks`
 * table's 5 prepared statements and nothing else touches them. IdentityStore
 * composes one and forwards the public methods verbatim, so callers see no
 * API change. Like the original, statements are prepared EAGERLY (the resume
 * sweep + the scheduler's notifySuspend hook are both potentially hot paths).
 *
 * Phase 11 M2 — `persistSuspendedTask` is called by the scheduler's
 * `notifySuspend` callback when a participant throws `SuspendTaskError`;
 * `listDueSuspendedTasks` drives the resume sweep; the rest are read/remove.
 */

import { type SqliteDb, type SqliteStmt } from './db.js'
import { IdentityError } from './errors.js'
import {
  type ListDueSuspendedTasksQuery,
  type PersistSuspendedTaskInput,
  type SuspendedTask,
} from './types.js'

interface SuspendedTaskRow {
  task_id: string
  agent_id: string
  hub_id: string | null
  origin_user_id: string | null
  resume_at: number
  state: string | null
  task_json: string
  created_at: number
  claimed_at: number | null
}

export class SuspendedTaskStore {
  // Eagerly prepared since the resume sweep (M3) and the scheduler's
  // notifySuspend hook are both potentially hot paths. INSERT is `OR
  // REPLACE` so a participant that throws SuspendTaskError from `onResume`
  // (suspend again) just overwrites the existing row instead of erroring
  // on PK collision.
  private readonly stmtSuspendInsert: SqliteStmt
  private readonly stmtSuspendDelete: SqliteStmt
  private readonly stmtSuspendGetById: SqliteStmt
  private readonly stmtSuspendListDue: SqliteStmt
  private readonly stmtSuspendListByAgent: SqliteStmt
  private readonly stmtSuspendCount: SqliteStmt
  // R9 — atomic claim (compare-and-set) + stale-claim reclaimer.
  private readonly stmtSuspendClaim: SqliteStmt
  private readonly stmtSuspendReclaim: SqliteStmt

  constructor(db: SqliteDb) {
    // Phase 11 M2 — suspended_tasks. `INSERT OR REPLACE` covers the
    // suspend-again case (a participant throws SuspendTaskError from
    // its `onResume` hook) without us having to branch in the public
    // API. Listing-by-due is the sweep query (M3); listing-by-agent
    // is exposed for future admin-UI inspection of parked tasks.
    this.stmtSuspendInsert = db.prepare(
      `INSERT OR REPLACE INTO suspended_tasks(
         task_id, agent_id, hub_id, origin_user_id,
         resume_at, state, task_json, created_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.stmtSuspendDelete = db.prepare(
      `DELETE FROM suspended_tasks WHERE task_id = ?`,
    )
    this.stmtSuspendGetById = db.prepare(
      `SELECT * FROM suspended_tasks WHERE task_id = ?`,
    )
    // R9 — only UNCLAIMED due rows. A claimed row is being resumed by
    // another claimant (this process's prior tick, or another host sharing
    // this store); excluding it here keeps the limit budget for rows that
    // can actually be picked up, and the atomic claim below is the real
    // race gate. A crashed claim is reset by `reclaimStaleSuspendedClaims`
    // so it reappears here.
    this.stmtSuspendListDue = db.prepare(
      `SELECT * FROM suspended_tasks
         WHERE resume_at <= ? AND claimed_at IS NULL
       ORDER BY resume_at ASC
       LIMIT ?`,
    )
    this.stmtSuspendListByAgent = db.prepare(
      `SELECT * FROM suspended_tasks
         WHERE agent_id = ?
       ORDER BY resume_at ASC`,
    )
    // Phase 19 P3-M1 — a cheap COUNT(*) for the /metrics gauge. Counts ALL
    // parked rows regardless of resume_at (the never-resume human-inbox rows
    // at NEVER_RESUME_AT included) — "how much work is currently suspended".
    this.stmtSuspendCount = db.prepare(
      `SELECT COUNT(*) AS c FROM suspended_tasks`,
    )
    // R9 — compare-and-set claim. Succeeds (changes===1) for exactly one
    // caller per row; a second caller (or a node racing) sees changes===0.
    this.stmtSuspendClaim = db.prepare(
      `UPDATE suspended_tasks
          SET claimed_at = ?
        WHERE task_id = ? AND claimed_at IS NULL`,
    )
    // R9 — reset claims older than a cutoff (a claimant that crashed between
    // claim and terminal-remove). Returns them to the unclaimed pool so the
    // next sweep retries them rather than letting them sit stranded.
    this.stmtSuspendReclaim = db.prepare(
      `UPDATE suspended_tasks
          SET claimed_at = NULL
        WHERE claimed_at IS NOT NULL AND claimed_at < ?`,
    )
  }

  /**
   * Persist a suspended-task row. Called by the scheduler's
   * `notifySuspend` callback when a participant throws
   * `SuspendTaskError`. `INSERT OR REPLACE` semantics: if the same
   * `taskId` is already parked (e.g. a `handleResume` re-suspended),
   * the row is overwritten with the new state and resumeAt.
   *
   * `state` is `JSON.stringify`d. `taskJson` is stored verbatim — the
   * caller (host wiring) is responsible for producing it.
   */
  persistSuspendedTask(input: PersistSuspendedTaskInput): void {
    if (!input || typeof input.taskId !== 'string' || input.taskId.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'persistSuspendedTask: taskId is required',
      })
    }
    if (typeof input.agentId !== 'string' || input.agentId.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'persistSuspendedTask: agentId is required',
      })
    }
    if (typeof input.resumeAt !== 'number' || !Number.isFinite(input.resumeAt)) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `persistSuspendedTask: resumeAt must be a finite number; got ${input.resumeAt}`,
      })
    }
    if (typeof input.taskJson !== 'string') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'persistSuspendedTask: taskJson must be a JSON string',
      })
    }
    // state can be undefined / null / any JSON-serialisable value.
    // We persist `null` for "absent" so the read side has a single
    // sentinel, and JSON-stringify everything else. A circular ref
    // here is a programmer error; let JSON.stringify throw and the
    // scheduler's catch will turn it into a `failed` result.
    const stateJson =
      input.state === undefined ? null : JSON.stringify(input.state)
    this.stmtSuspendInsert.run(
      input.taskId,
      input.agentId,
      input.hubId ?? null,
      input.originUserId ?? null,
      input.resumeAt,
      stateJson,
      input.taskJson,
      Date.now(),
    )
  }

  /**
   * Remove a parked row. Called by the resume sweep (M3) once the
   * task has been successfully re-dispatched and either resolved or
   * re-suspended (which itself wrote a fresh row via INSERT OR
   * REPLACE — so the delete is harmless in that case too, just races
   * the upsert).
   *
   * Returns the number of rows removed (0 or 1) so callers can
   * detect "already gone" races.
   */
  removeSuspendedTask(taskId: string): number {
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'removeSuspendedTask: taskId is required',
      })
    }
    const info = this.stmtSuspendDelete.run(taskId)
    return Number(info.changes)
  }

  /** Read a single suspended-task row by taskId. Returns null when absent. */
  getSuspendedTask(taskId: string): SuspendedTask | null {
    if (typeof taskId !== 'string' || taskId.length === 0) return null
    const row = this.stmtSuspendGetById.get(taskId) as
      | SuspendedTaskRow
      | undefined
    return row ? rowToSuspendedTask(row) : null
  }

  /**
   * List rows whose `resume_at <= now`, ordered by `resume_at ASC`
   * (oldest-due first). The resume sweep iterates this list and
   * re-dispatches each task. `limit` (default 100) bounds the batch
   * so a long sleep period doesn't return thousands of rows at once.
   */
  listDueSuspendedTasks(query: ListDueSuspendedTasksQuery = {}): SuspendedTask[] {
    const now = query.now ?? Date.now()
    const limit = query.limit ?? 100
    if (!Number.isFinite(now) || !Number.isFinite(limit) || limit < 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `listDueSuspendedTasks: invalid now=${now} or limit=${limit}`,
      })
    }
    const rows = this.stmtSuspendListDue.all(now, limit) as SuspendedTaskRow[]
    return rows.map(rowToSuspendedTask)
  }

  /**
   * Diagnostic: list all parked tasks for a single agent, oldest-due
   * first. Not used by the runtime path; exposed for admin UI
   * surfaces ("what's this agent waiting on?") and tests.
   */
  listSuspendedTasksByAgent(agentId: string): SuspendedTask[] {
    if (typeof agentId !== 'string' || agentId.length === 0) return []
    const rows = this.stmtSuspendListByAgent.all(agentId) as SuspendedTaskRow[]
    return rows.map(rowToSuspendedTask)
  }

  /**
   * Phase 19 P3-M1 — total parked-task count for the `/metrics` gauge.
   * O(1)-ish COUNT(*); never loads task_json. Counts every row including
   * the never-resume human-inbox rows.
   */
  countSuspendedTasks(): number {
    const row = this.stmtSuspendCount.get() as { c: number }
    return row.c
  }

  /**
   * R9 (tech-debt) — atomically claim a due row before the sweep re-enters
   * it. Compare-and-set: `SET claimed_at WHERE task_id=? AND claimed_at IS
   * NULL`. Returns `true` iff THIS caller won the claim (`changes===1`);
   * `false` means the row was already claimed (another tick / another host)
   * or no longer exists. The sweep skips the row on `false`.
   *
   * The claim is the real race gate (the `listDueSuspendedTasks` filter is
   * only an optimisation): two hosts can both list the same row, but only
   * one UPDATE flips `claimed_at` from NULL.
   */
  claimSuspendedTask(taskId: string, claimedAt: number): boolean {
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'claimSuspendedTask: taskId is required',
      })
    }
    if (typeof claimedAt !== 'number' || !Number.isFinite(claimedAt)) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `claimSuspendedTask: claimedAt must be a finite number; got ${claimedAt}`,
      })
    }
    const info = this.stmtSuspendClaim.run(claimedAt, taskId)
    return Number(info.changes) === 1
  }

  /**
   * R9 (tech-debt) — reclaim stale claims. Resets `claimed_at` to NULL for
   * every row claimed strictly before `olderThan` (epoch ms), so a row whose
   * claimant crashed between claim and terminal-remove returns to the
   * unclaimed pool and the next sweep retries it. Returns the number of rows
   * reclaimed. Call with a cutoff comfortably larger than the longest
   * expected resume so a legitimately slow in-flight resume isn't reclaimed
   * out from under itself (the worst case if it is: an at-least-once re-run,
   * which the pre-R9 sweep already had).
   */
  reclaimStaleSuspendedClaims(olderThan: number): number {
    if (typeof olderThan !== 'number' || !Number.isFinite(olderThan)) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `reclaimStaleSuspendedClaims: olderThan must be a finite number; got ${olderThan}`,
      })
    }
    const info = this.stmtSuspendReclaim.run(olderThan)
    return Number(info.changes)
  }
}

function rowToSuspendedTask(r: SuspendedTaskRow): SuspendedTask {
  // Parse `state` from JSON. The persist side stores `null` for
  // "absent"; everything else round-trips through JSON.stringify /
  // JSON.parse. A corrupt blob (e.g. a truncated write) must NOT throw
  // here: `rowToSuspendedTask` feeds `listDueSuspendedTasks` via
  // `.map()`, and a throw mid-map would abort the entire due batch.
  // Worse, the bad row sorts to the head (ORDER BY resume_at ASC), so
  // every subsequent sweep tick would re-throw on it and starve all
  // other parked tasks forever. Instead we flag the row `corrupt` and
  // null its state; the resume sweep detects the flag and drops the row
  // (it can't be resumed — a half-parsed state would re-enter the agent
  // into a broken state anyway).
  let state: unknown = null
  let corrupt = false
  if (r.state !== null) {
    try {
      state = JSON.parse(r.state)
    } catch {
      corrupt = true
    }
  }
  return {
    taskId: r.task_id,
    agentId: r.agent_id,
    hubId: r.hub_id,
    originUserId: r.origin_user_id,
    resumeAt: r.resume_at,
    state,
    // Omit on healthy rows so the record shape is unchanged.
    ...(corrupt ? { corrupt: true } : {}),
    taskJson: r.task_json,
    createdAt: r.created_at,
    // R9 — `?? null` so a row read from a DB migrated before v31 (column
    // absent on the row object) still yields the `null` sentinel.
    claimedAt: r.claimed_at ?? null,
  }
}
