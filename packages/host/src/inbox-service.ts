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

/** What HostInboxService needs from the identity suspended-task store. */
export interface SuspendedTaskLookup {
  getSuspendedTask(
    taskId: string,
  ): { agentId: string; state: unknown; taskJson: string; corrupt?: boolean } | null
  removeSuspendedTask(taskId: string): number
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

    // Two-step resume — child strictly before parent.
    const resumedChild = await this.resumeChild(item, validated)
    if (resumedChild) await this.resumeParent(item)
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
    // The broker's handleResume returns `state.answer` as the task's ok output.
    await this.hub.resumeTask(row.agentId, childTask, { answer: decision })
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
