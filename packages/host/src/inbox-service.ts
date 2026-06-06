/**
 * HostInboxService — host-side orchestration for the member task inbox.
 *
 * Implements the web layer's duck-typed `InboxSurface` *structurally* (no
 * import — web stays zero-dep on `@aipehub/inbox`). This is the only place the
 * concrete `Hub` + `IdentityStore` meet, so the two-step resume lives here:
 *
 *   resolve(itemId, userId, decision):
 *     1. load + ownership + pending checks (typed errors → HTTP status)
 *     2. validate the decision against the item's kind
 *     3. markResolved — the RACE GUARD: a second / concurrent resolve is
 *        rejected here, BEFORE any hub.resumeTask runs
 *     4. resume the CHILD broker task with `{ answer: decision }` → its ok
 *        result lands in the transcript → remove its parked row
 *     5. resume the PARENT workflow run (if any) → its
 *        refreshSuspendedStepRecord reads the child's ok → the human step's
 *        output becomes the decision → the run continues (or re-suspends on
 *        another human step) → remove the parent row only if it didn't
 *        re-suspend
 *
 * Child strictly BEFORE parent: until the child resumes, the parent's
 * `hub.taskResult(childTaskId)` is still `suspended`, so resuming the parent
 * first just re-parks it (harmless, but no progress).
 */

import type { Hub, Task } from '@aipehub/core'
import { InboxError, type InboxDecision, type InboxItem, type InboxStore } from '@aipehub/inbox'
import { AUDIT_ACTIONS, type WriteAuditLogInput } from '@aipehub/identity'

/** What HostInboxService needs from the identity store. */
export interface SuspendedTaskLookup {
  getSuspendedTask(
    taskId: string,
  ): { agentId: string; state: unknown; taskJson: string; corrupt?: boolean } | null
  removeSuspendedTask(taskId: string): number
  /**
   * inbox-gov M1 — optional governance audit sink. The real IdentityStore
   * satisfies it; tests can omit it. Resolve writes one `inbox_resolve` row so
   * the generic audit query/export surfaces "who decided this human step". An
   * audit fault must NEVER fail an already-committed decision (best-effort).
   */
  writeAuditLog?(input: WriteAuditLogInput): unknown
  /**
   * inbox-gov M2 — resolve a delegate target by email. The member hands a task
   * off by typing an email (never a user id), so we never expose the directory.
   * Optional only so tests can supply a fake; the real store always has it.
   */
  getUserByEmail?(email: string): { id: string } | null
}

/** Minimal logger shape — the host's structured logger satisfies it. */
interface InboxLogger {
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

export interface HostInboxServiceOptions {
  hub: Pick<Hub, 'resumeTask'>
  store: InboxStore
  identity: SuspendedTaskLookup
  logger?: InboxLogger
}

/** Public projection of an inbox item — matches web's `InboxItemView`. */
interface InboxItemView {
  itemId: string
  kind: string
  prompt: string
  title?: string
  options?: unknown[]
  editField?: unknown
  createdAt: number
  /**
   * inbox-gov M2 — the note from the most recent handoff, so the new assignee
   * sees WHY this landed in their inbox ("handed off with context"). Only the
   * note text is surfaced — never the delegator's user id (no directory leak).
   */
  handoffNote?: string
}

export class HostInboxService {
  private readonly hub: Pick<Hub, 'resumeTask'>
  private readonly store: InboxStore
  private readonly identity: SuspendedTaskLookup
  private readonly log: InboxLogger | undefined

  constructor(opts: HostInboxServiceOptions) {
    this.hub = opts.hub
    this.store = opts.store
    this.identity = opts.identity
    this.log = opts.logger
  }

  async listPending(userId: string): Promise<InboxItemView[]> {
    const items = await this.store.listPending(userId)
    return items.map(toView)
  }

  async resolve(args: { itemId: string; userId: string; decision: unknown }): Promise<void> {
    const { itemId, userId, decision } = args
    const item = await this.store.get(itemId)
    if (!item) throw new InboxError('not_found', `inbox item '${itemId}' not found`)
    if (item.userId !== userId) {
      throw new InboxError('forbidden', `inbox item '${itemId}' belongs to another user`)
    }
    if (item.status !== 'pending') {
      throw new InboxError('already_resolved', `inbox item '${itemId}' is already ${item.status}`)
    }
    const validated = validateDecision(item, decision)

    // RACE GUARD — flip pending→resolved before any resume. A concurrent or
    // repeat resolve hits already_resolved inside markResolved and never
    // touches the hub.
    await this.store.markResolved(itemId, validated)

    // Governance audit (inbox-gov M1) — record the committed decision right
    // after the race guard, BEFORE resume mechanics, so the row faithfully
    // reflects "this member made this decision" regardless of downstream
    // resume outcome. Best-effort: never fail a committed decision.
    this.recordResolveAudit(item, validated, userId)

    // Two-step resume — child strictly before parent.
    const resumedChild = await this.resumeChild(item, validated)
    if (resumedChild) await this.resumeParent(item)
  }

  /** inbox-gov M1 — write one `inbox_resolve` audit row (best-effort). */
  private recordResolveAudit(item: InboxItem, decision: InboxDecision, userId: string): void {
    if (typeof this.identity.writeAuditLog !== 'function') return
    try {
      this.identity.writeAuditLog({
        action: AUDIT_ACTIONS.INBOX_RESOLVE,
        actorSource: 'v4-session',
        actorUserId: userId,
        metadata: {
          itemId: item.itemId,
          kind: item.kind,
          parentKind: item.parentKind,
          outcome: outcomeOf(decision),
        },
        success: true,
      })
    } catch (err) {
      this.log?.warn('inbox resolve: audit write failed; decision already committed', {
        itemId: item.itemId,
        err,
      })
    }
  }

  /**
   * inbox-gov M2 — hand a pending item off to another member, identified by
   * email (never a user id — the directory is never exposed to members). The
   * item stays pending under the new assignee; no resume happens. Throws a
   * typed error (`.code`) the route maps to an HTTP status.
   */
  async delegate(args: {
    itemId: string
    userId: string
    toEmail: string
    note?: string
  }): Promise<void> {
    const { itemId, userId, toEmail, note } = args
    const item = await this.store.get(itemId)
    if (!item) throw new InboxError('not_found', `inbox item '${itemId}' not found`)
    if (item.userId !== userId) {
      throw new InboxError('forbidden', `inbox item '${itemId}' belongs to another user`)
    }
    if (item.status !== 'pending') {
      throw new InboxError('already_resolved', `inbox item '${itemId}' is already ${item.status}`)
    }

    // Resolve the target by email, fail-closed. A member can only hand off to a
    // real user, and never to themselves (that would be a no-op handoff).
    const email = typeof toEmail === 'string' ? toEmail.trim() : ''
    if (email.length === 0) throw new InboxError('invalid_target', 'a target email is required')
    const target =
      typeof this.identity.getUserByEmail === 'function'
        ? this.identity.getUserByEmail(email)
        : null
    if (!target) throw new InboxError('invalid_target', `no user with email '${email}'`)
    if (target.id === userId) {
      throw new InboxError('invalid_target', 'cannot delegate an item to yourself')
    }

    await this.store.delegate(itemId, target.id, { actor: userId, note })
    this.recordDelegateAudit(item, userId, target.id, note)
  }

  /** inbox-gov M2 — write one `inbox_delegate` audit row (best-effort). */
  private recordDelegateAudit(
    item: InboxItem,
    fromUserId: string,
    toUserId: string,
    note: string | undefined,
  ): void {
    if (typeof this.identity.writeAuditLog !== 'function') return
    try {
      this.identity.writeAuditLog({
        action: AUDIT_ACTIONS.INBOX_DELEGATE,
        actorSource: 'v4-session',
        actorUserId: fromUserId,
        // The handoff reason itself stays in the item history (visible to the
        // two members); the audit row records only that a note was attached.
        metadata: {
          itemId: item.itemId,
          kind: item.kind,
          from: fromUserId,
          to: toUserId,
          hasNote: typeof note === 'string' && note.length > 0,
        },
        success: true,
      })
    } catch (err) {
      this.log?.warn('inbox delegate: audit write failed; handoff already committed', {
        itemId: item.itemId,
        err,
      })
    }
  }

  /**
   * Resume the parked broker task, injecting the decision as its answer.
   * Returns false when the child wasn't parked (nothing to resume → leave the
   * parent alone too; the decision is still recorded).
   */
  private async resumeChild(item: InboxItem, decision: InboxDecision): Promise<boolean> {
    const row = this.identity.getSuspendedTask(item.itemId)
    if (!row || row.corrupt) {
      this.log?.warn('inbox resolve: child task not parked; decision recorded only', {
        itemId: item.itemId,
      })
      return false
    }
    let childTask: Task
    try {
      childTask = JSON.parse(row.taskJson) as Task
    } catch (err) {
      this.log?.error('inbox resolve: child task_json corrupt', { itemId: item.itemId, err })
      return false
    }
    // Merge the persisted park state UNDER `{ answer }`. The human-step broker /
    // approval gate only read `.answer` (returning the decision / forwarding the
    // send), so the extra fields are inert for them. But a participant whose
    // handleResume needs its carried state — the ACP adapter re-finds its
    // in-memory `permissionToken` from `row.state` to answer a still-open
    // permission request — gets both the state AND the decision in one payload.
    await this.hub.resumeTask(row.agentId, childTask, { ...asObject(row.state), answer: decision })
    this.identity.removeSuspendedTask(item.itemId)
    return true
  }

  /** Resume the parent workflow run, if the dispatcher was a workflow. */
  private async resumeParent(item: InboxItem): Promise<void> {
    if (item.parentKind !== 'workflow' || !item.parent) return
    const parent = item.parent
    const row = this.identity.getSuspendedTask(parent.taskId)
    if (!row || row.corrupt) {
      this.log?.warn('inbox resolve: parent workflow not parked', {
        itemId: item.itemId,
        parentTaskId: parent.taskId,
      })
      return
    }
    // Cross-check by DATA, not ancestry position: the parked row's agent must
    // equal the parent we recorded. Guards a taskId collision / corrupt item
    // from resuming the wrong participant.
    if (row.agentId !== parent.by) {
      this.log?.error('inbox resolve: parent agent mismatch; skipping parent resume', {
        itemId: item.itemId,
        expected: parent.by,
        got: row.agentId,
      })
      return
    }
    let parentTask: Task
    try {
      parentTask = JSON.parse(row.taskJson) as Task
    } catch (err) {
      this.log?.error('inbox resolve: parent task_json corrupt', { itemId: item.itemId, err })
      return
    }
    const result = await this.hub.resumeTask(parent.by, parentTask, row.state)
    // Remove the parent row only when the run finished. If it re-suspended on
    // ANOTHER human step, the notifier already wrote a fresh row (INSERT OR
    // REPLACE) — removing it here would lose that parking.
    if (result.kind !== 'suspended') this.identity.removeSuspendedTask(parent.taskId)
  }
}

/** Spread-safe view of a persisted park state (object → itself, else `{}`). */
function asObject(state: unknown): Record<string, unknown> {
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : {}
}

/**
 * inbox-gov M1 — a SHORT outcome label for the audit row. Approval → the
 * verdict; choice → the picked option (already short, validated against the
 * offered set). Edit free-text is deliberately NOT put in the audit metadata
 * (the column is for small facts, not blobs) — just `'edited'`.
 */
function outcomeOf(decision: InboxDecision): string {
  if (decision.kind === 'approval') {
    if (decision.changesRequested) return 'changes_requested'
    return decision.approved ? 'approved' : 'rejected'
  }
  if (decision.kind === 'choice') return decision.value
  return 'edited'
}

function toView(item: InboxItem): InboxItemView {
  const v: InboxItemView = {
    itemId: item.itemId,
    kind: item.kind,
    prompt: item.prompt,
    createdAt: item.createdAt,
  }
  if (item.title !== undefined) v.title = item.title
  if (item.options !== undefined) v.options = item.options
  if (item.editField !== undefined) v.editField = item.editField
  // Surface the latest handoff note (if any) so the recipient sees the context.
  for (let i = (item.history?.length ?? 0) - 1; i >= 0; i--) {
    const e = item.history![i]!
    if (e.type === 'delegated') {
      if (typeof e.note === 'string' && e.note.length > 0) v.handoffNote = e.note
      break
    }
  }
  return v
}

/**
 * Validate the submitted decision against the item's kind, returning the
 * normalised `InboxDecision` that becomes the human step's output. Throws
 * `InboxError('invalid_decision')` on a mismatch so the route returns 400.
 */
function validateDecision(item: InboxItem, raw: unknown): InboxDecision {
  if (!raw || typeof raw !== 'object') {
    throw new InboxError('invalid_decision', 'decision must be an object')
  }
  const d = raw as Record<string, unknown>
  if (d.kind !== item.kind) {
    throw new InboxError(
      'invalid_decision',
      `decision.kind '${String(d.kind)}' must match item kind '${item.kind}'`,
    )
  }
  if (item.kind === 'approval') {
    if (typeof d.approved !== 'boolean') {
      throw new InboxError('invalid_decision', "approval decision requires a boolean 'approved'")
    }
    const out: InboxDecision = { kind: 'approval', approved: d.approved }
    // inbox-gov M3 — "request changes" is approved=false PLUS an explicit flag,
    // and (unlike a bare reject) MUST carry a comment so the revise step has
    // something to act on. Reject "approve + request changes" as incoherent.
    if (d.changesRequested === true) {
      if (d.approved) {
        throw new InboxError(
          'invalid_decision',
          'cannot approve and request changes in the same decision',
        )
      }
      if (typeof d.comment !== 'string' || d.comment.trim().length === 0) {
        throw new InboxError(
          'invalid_decision',
          'requesting changes requires a comment describing what to change',
        )
      }
      out.changesRequested = true
    }
    if (typeof d.comment === 'string') out.comment = d.comment
    return out
  }
  if (item.kind === 'choice') {
    if (typeof d.value !== 'string') {
      throw new InboxError('invalid_decision', "choice decision requires a string 'value'")
    }
    const allowed = (item.options ?? []).map((o) => o.value)
    if (allowed.length > 0 && !allowed.includes(d.value)) {
      throw new InboxError('invalid_decision', `choice value '${d.value}' is not an offered option`)
    }
    return { kind: 'choice', value: d.value }
  }
  // edit
  if (typeof d.value !== 'string') {
    throw new InboxError('invalid_decision', "edit decision requires a string 'value'")
  }
  return { kind: 'edit', value: d.value }
}
