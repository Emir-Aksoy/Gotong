/**
 * ApprovalGatedParticipant — Phase 18 B-M3 outbound cross-org approval gate.
 *
 * Decorates the outbound `RemoteHubViaLink` wrapper (installed via
 * `installPeerLink`'s `wrapOutbound` hook) so a cross-org dispatch to a peer
 * flagged `requireApprovalOutbound` does NOT leave the hub until a person
 * approves it. The decorator is only ever wrapped around peers that require
 * approval, so EVERY task it sees is gated — there is no "approval not needed"
 * fast path here.
 *
 * North-star alignment: the approver is a `Participant` acting on an inbox
 * item, not a bespoke "approve tool". This reuses the whole Phase 16
 * suspend/resume machinery — the decorator is essentially a
 * `HumanInboxParticipant` whose resume FORWARDS to the wrapped remote instead
 * of returning the decision as output:
 *
 *   onTask(task):
 *     write an `approval` InboxItem (itemId = task.id) + throw
 *     `SuspendTaskError(NEVER_RESUME_AT)` so only a `/me` resolve wakes it.
 *     The inner remote is NOT called — nothing crosses the org boundary yet.
 *
 *   onResume(task, {answer}):
 *     - approved → `inner.onTask(task)` — the real cross-org send finally fires
 *     - rejected → `{ kind:'failed', error:'outbound_approval_denied' }`
 *     - non-approval state (Item 2 D4) → delegate to `inner.onResume` if it has
 *       one. After approval a lifecycle-aware A2A inner can park to poll
 *       `tasks/get`; the sweep then wakes THIS wrapper with the inner's own
 *       carried state, which must reach the inner's resume, not a blind re-park.
 *
 * Three invariants (Phase 16 lineage):
 *   1. `NEVER_RESUME_AT` — else the 30s resume sweep would auto-wake the park.
 *   2. `onResume` is implemented — resuming must forward, not re-run `onTask`
 *      (which would re-enter the gate forever).
 *   3. `parentKind` is derived from ancestry, NOT hardcoded. A workflow step
 *      that dispatches a gated outbound task parks its OWN run too (the runner
 *      calls `suspendWorkflow` → throws, inheriting the gate's
 *      `NEVER_RESUME_AT`), so a resolve must run the two-step recovery (child
 *      wrapper THEN the workflow run, which re-reads `taskResult(childId)`).
 *      `HumanInboxParticipant` derives it the same way; a direct / agent
 *      dispatch has no workflow ancestor and yields `'none'` / `'agent'`, so
 *      only the wrapper resumes. (This corrects the plan's draft assumption
 *      that the parent never needs resuming.)
 */

import {
  SuspendTaskError,
  type Message,
  type Participant,
  type ParticipantId,
  type Task,
  type TaskResult,
} from '@aipehub/core'
import { NEVER_RESUME_AT, type InboxItem, type InboxStore } from '@aipehub/inbox'

/**
 * The slice of the inner outbound participant the gate drives. `RemoteHubViaLink`
 * satisfies this structurally; typing the minimal shape keeps unit tests from
 * having to stand up a real `HubLink`.
 */
export interface GatedOutboundInner {
  readonly id: ParticipantId
  readonly capabilities: readonly string[]
  onTask(task: Task): Promise<TaskResult>
  onMessage?(msg: Message): void | Promise<void>
  /**
   * Item 2 (D4) — the inner participant's OWN resume hook, if it has one.
   * `RemoteHubViaLink` (mesh) has none; an `A2aRemoteParticipant` with the
   * long-running lifecycle opted in DOES — after approval its `onTask` can park
   * with a FINITE `resumeAt` to poll `tasks/get`, and the sweep then resumes the
   * WRAPPER (registered under this id). Those non-approval wakes must reach the
   * inner's poll logic instead of being swallowed by the gate's re-park, or the
   * lifecycle is lost. Optional → blocking inners are unaffected.
   */
  onResume?(task: Task, state: unknown): Promise<TaskResult>
}

export interface ApprovalGatedParticipantOptions {
  /** The outbound wrapper being gated (kept whole — id + caps delegate to it). */
  inner: GatedOutboundInner
  /** Where the parked approval item is written. */
  store: InboxStore
  /**
   * The user who must approve outbound sends to this peer — conventionally the
   * org owner. The inbox item lands in THEIR `/me` queue.
   */
  approver: ParticipantId
  /** Human-readable peer name for the approval prompt. Defaults to `inner.id`. */
  peerLabel?: string
  /** Clock injection for deterministic tests. */
  now?: () => number
}

export class ApprovalGatedParticipant implements Participant {
  readonly kind = 'agent' as const
  private readonly inner: GatedOutboundInner
  private readonly store: InboxStore
  private readonly approver: ParticipantId
  private readonly peerLabel: string
  private readonly now: () => number

  constructor(opts: ApprovalGatedParticipantOptions) {
    this.inner = opts.inner
    this.store = opts.store
    this.approver = opts.approver
    this.peerLabel = opts.peerLabel ?? opts.inner.id
    this.now = opts.now ?? (() => Date.now())
  }

  /** Delegate so the hub registers the gate under the wrapper id (FED routing). */
  get id(): ParticipantId {
    return this.inner.id
  }

  /** Delegate so capability dispatch still selects this edge for the peer's caps. */
  get capabilities(): readonly string[] {
    return this.inner.capabilities
  }

  async onTask(task: Task): Promise<TaskResult> {
    // Park BEFORE the inner send — the whole point is that nothing crosses the
    // org boundary until a person approves. parentKind is derived from ancestry
    // (see the invariant note above) so a workflow-dispatched send recovers via
    // the two-step path.
    const parentNode = task.ancestry?.at(-1)
    const parentKind: InboxItem['parentKind'] = !parentNode
      ? 'none'
      : parentNode.by.startsWith('workflow:')
        ? 'workflow'
        : 'agent'

    const item: InboxItem = {
      itemId: task.id,
      userId: this.approver,
      kind: 'approval',
      prompt: buildApprovalPrompt(this.peerLabel, task),
      parentKind,
      status: 'pending',
      createdAt: this.now(),
    }
    if (task.title !== undefined) item.title = task.title
    if (parentNode) item.parent = { taskId: parentNode.taskId, by: parentNode.by }

    await this.store.write(item)

    // A person, not a timer, wakes this. The carried state mirrors the human
    // broker's so the host's resolve path is identical.
    throw new SuspendTaskError({
      resumeAt: NEVER_RESUME_AT,
      state: { inboxItemId: item.itemId },
    })
  }

  async onResume(task: Task, state: unknown): Promise<TaskResult> {
    const decision = extractApproval(state)
    if (decision === null) {
      // Not an approval verdict. Under NEVER_RESUME_AT the ONLY thing that wakes
      // this gate with a non-approval state is the inner participant itself
      // having parked with a FINITE resumeAt (an A2A lifecycle `tasks/get` poll)
      // AFTER we already approved — the sweep is now waking the WRAPPER. Delegate
      // to the inner's own resume so the poll runs; if it re-parks, that
      // SuspendTaskError propagates and the sweep re-persists it under this id
      // (Item 2 D4 — fixes the lifecycle×approval resume collision).
      if (this.inner.onResume) return this.inner.onResume(task, state)
      // No inner resume path → this is a genuine stray wake (shouldn't happen
      // given NEVER_RESUME_AT). Re-park rather than silently send.
      throw new SuspendTaskError({ resumeAt: NEVER_RESUME_AT, state })
    }
    if (decision.approved) {
      // Approved — the real cross-org send finally happens. (For a lifecycle
      // inner this `onTask` may itself park with a finite resumeAt to poll; that
      // SuspendTaskError propagates out and the next non-approval wake lands in
      // the delegation branch above.)
      return this.inner.onTask(task)
    }
    return {
      kind: 'failed',
      taskId: task.id,
      by: this.id,
      error: 'outbound_approval_denied',
      ts: this.now(),
    }
  }

  async onMessage(msg: Message): Promise<void> {
    // Messages (channel publishes) are not gated — approval is a task-level
    // control. Forward straight through if the inner supports it.
    await this.inner.onMessage?.(msg)
  }
}

function buildApprovalPrompt(peerLabel: string, task: Task): string {
  const caps =
    task.strategy.kind === 'capability'
      ? ` (capability: ${task.strategy.capabilities.join(', ')})`
      : ''
  return `Approve outbound cross-org task to peer '${peerLabel}'${caps}?`
}

/**
 * Pull the approval verdict out of the resume state. The host's resolve path
 * injects `{ answer: <InboxDecision> }`; we only act on a well-formed approval
 * decision (anything else → null → re-park).
 */
function extractApproval(state: unknown): { approved: boolean } | null {
  if (!state || typeof state !== 'object' || !('answer' in state)) return null
  const answer = (state as { answer: unknown }).answer
  if (
    answer &&
    typeof answer === 'object' &&
    (answer as { kind?: unknown }).kind === 'approval' &&
    typeof (answer as { approved?: unknown }).approved === 'boolean'
  ) {
    return { approved: (answer as { approved: boolean }).approved }
  }
  return null
}
