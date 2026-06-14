/**
 * StewardApprovalBroker — SW-M5. The SECOND confirmation for the hub steward's
 * dangerous / cross-hub actions — the user's two hard constraints:
 *
 *   「跨 hub 间的工作流需要再次确认，危险动作都再次确认。」
 *
 * When the server-side classifier tiers a steward action `dangerous`
 * (delete_agent) or `cross_hub` (a workflow that leaves this hub), `apply`
 * (hub-steward-service) does NOT execute it. Instead it dispatches a
 * `{ userId, action }` task to THIS broker (capability `aipehub.steward.exec/v1`),
 * which parks it in the member's own inbox and suspends. The member sees the
 * approval item in `/me`, approves or rejects, and only then does anything run.
 *
 *   onTask(task):
 *     write an `approval` InboxItem (itemId = task.id) for the member + throw
 *     `SuspendTaskError(NEVER_RESUME_AT)` so only a `/me` resolve — never the
 *     timer sweep — can wake it. NOTHING is executed yet.
 *
 *   onResume(task, { answer }):
 *     - approved → `performStewardAction(userId, action)` — the SAME execution
 *       chokepoint the SAFE inline path uses, so an approved delete takes the
 *       EXACT code path a safe create does (RBAC + member limits reused).
 *     - rejected → `{ kind:'failed', error:'steward_action_denied' }` —
 *       fail-closed; the action never runs.
 *
 * Mirrors `ApprovalGatedParticipant` (the outbound cross-org gate) but is a
 * STANDALONE registered participant the steward dispatches to, not a decorator
 * over an outbound wrapper. Three invariants from the Phase 16 lineage hold:
 *
 *   1. `NEVER_RESUME_AT` — else the 30s resume sweep would auto-wake the park.
 *   2. `onResume` is implemented — resuming EXECUTES (or fails closed); it must
 *      never fall back to re-running `onTask` (which would re-park forever).
 *   3. `parentKind` is always `'none'` — `apply` dispatches the exec task
 *      DIRECTLY (not from a workflow run), so the inbox two-step resume only
 *      ever runs `resumeChild` (this broker); there is no parent run to resume.
 *      (Unlike the human inbox broker, which a workflow step CAN dispatch.)
 */

import {
  SuspendTaskError,
  type Participant,
  type ParticipantId,
  type Task,
  type TaskResult,
} from '@aipehub/core'
import { NEVER_RESUME_AT, type InboxItem, type InboxStore } from '@aipehub/inbox'
import { validateStewardAction, type StewardAction } from '@aipehub/hub-steward'

import {
  performStewardAction,
  type StewardAgentDirectory,
  type StewardWorkflowEditor,
} from './hub-steward-service.js'

/**
 * The capability the steward dispatches a gated action to. One capability for
 * both dangerous + cross_hub — the action kind lives in the payload, exactly
 * like the human inbox broker's single `aipehub.human/v1`.
 */
export const STEWARD_EXEC_CAPABILITY = 'aipehub.steward.exec/v1'

/**
 * The fixed participant id the broker is registered under. Fixed (not generated)
 * so `HostInboxService.resolve` → `hub.resumeTask(row.agentId, …)` lands here
 * without a lookup — `row.agentId` is whatever suspended, i.e. this id.
 */
export const STEWARD_EXEC_PARTICIPANT_ID = 'aipehub:steward-exec'

/**
 * The payload `apply` dispatches to the broker: the member + the single action
 * they accepted. Round-trips through suspend/resume (JSON), so `onResume`
 * re-validates it before executing.
 */
export interface StewardExecPayload {
  userId: string
  action: StewardAction
}

export interface StewardApprovalBrokerOptions {
  /** Where the parked approval item is written (the member's inbox). */
  store: InboxStore
  /** The member-agent executor — reused so RBAC + member limits apply on approve. */
  agents: StewardAgentDirectory
  /** The workflow-edit executor — the OpenClaw-style editor (cross-hub lock). */
  workflowEditor: StewardWorkflowEditor
  /** Clock injection for deterministic tests. */
  now?: () => number
}

export class StewardApprovalBroker implements Participant {
  readonly kind = 'agent' as const
  readonly id: ParticipantId = STEWARD_EXEC_PARTICIPANT_ID
  readonly capabilities: readonly string[] = [STEWARD_EXEC_CAPABILITY]

  private readonly store: InboxStore
  private readonly deps: { agents: StewardAgentDirectory; workflowEditor: StewardWorkflowEditor }
  private readonly now: () => number

  constructor(opts: StewardApprovalBrokerOptions) {
    this.store = opts.store
    this.deps = { agents: opts.agents, workflowEditor: opts.workflowEditor }
    this.now = opts.now ?? (() => Date.now())
  }

  async onTask(task: Task): Promise<TaskResult> {
    // Park BEFORE executing — the whole point is that a dangerous / cross-hub
    // action waits for a person. A malformed payload throws here → the scheduler
    // maps it to `failed` (the action fails visibly rather than parking a ghost).
    const payload = parseStewardExecPayload(task.payload)

    const item: InboxItem = {
      itemId: task.id,
      // The member who asked is the one who must confirm — the second
      // confirmation lands back in THEIR `/me` inbox.
      userId: payload.userId,
      kind: 'approval',
      prompt: buildStewardApprovalPrompt(payload.action),
      // Always 'none' — apply dispatches the exec task directly, not from a
      // workflow run, so resolve only ever resumes this child (no parent run).
      parentKind: 'none',
      status: 'pending',
      createdAt: this.now(),
    }
    if (task.title !== undefined) item.title = task.title

    await this.store.write(item)

    // A person, not a timer, wakes this. The carried state mirrors the human
    // broker's `{ inboxItemId }` so the host's resolve path is identical (it
    // merges `{ ...state, answer }` on resume).
    throw new SuspendTaskError({
      resumeAt: NEVER_RESUME_AT,
      state: { inboxItemId: item.itemId },
    })
  }

  async onResume(task: Task, state: unknown): Promise<TaskResult> {
    const decision = extractApproval(state)
    if (decision === null) {
      // No approval decision in the resume state — a stray wake (shouldn't
      // happen given NEVER_RESUME_AT). Re-park rather than silently execute.
      throw new SuspendTaskError({ resumeAt: NEVER_RESUME_AT, state })
    }
    if (!decision.approved) {
      // Fail-closed — the member rejected the second confirmation; nothing runs.
      return {
        kind: 'failed',
        taskId: task.id,
        by: this.id,
        error: 'steward_action_denied',
        ts: this.now(),
      }
    }
    // Approved — re-validate the round-tripped payload and run it through the
    // SAME chokepoint the safe inline path uses. A member service throw (RBAC /
    // not-found / validation) propagates → the scheduler maps it to `failed`.
    const payload = parseStewardExecPayload(task.payload)
    const output = await performStewardAction(payload.userId, payload.action, this.deps)
    return { kind: 'ok', taskId: task.id, by: this.id, output, ts: this.now() }
  }
}

// --- helpers ----------------------------------------------------------------

/**
 * Validate + normalise the dispatched exec payload. `apply` always sends a
 * well-formed `{ userId, action }`, but it round-trips through suspend/resume
 * (JSON), so the broker re-validates defensively — reusing the SAME
 * `validateStewardAction` the LLM-reply parser uses (one validation contract).
 * Throws a plain Error → the scheduler surfaces it as `failed`.
 */
export function parseStewardExecPayload(raw: unknown): StewardExecPayload {
  if (!raw || typeof raw !== 'object') {
    throw new Error('steward exec payload must be an object')
  }
  const p = raw as Record<string, unknown>
  if (typeof p.userId !== 'string' || p.userId.length === 0) {
    throw new Error('steward exec payload.userId must be a non-empty string')
  }
  const action = validateStewardAction(p.action)
  if (!action) {
    throw new Error('steward exec payload.action is not a well-formed StewardAction')
  }
  return { userId: p.userId, action }
}

/** A member-readable (zh) approval prompt for a gated action. */
function buildStewardApprovalPrompt(action: StewardAction): string {
  switch (action.kind) {
    case 'delete_agent':
      return `确认删除助手「${action.agentId}」?删掉后无法恢复。`
    case 'edit_workflow':
      return `确认按你的说法修改工作流「${action.workflowId}」?它会跨出本 hub,涉及跨组织协作,所以需要你再确认一次。`
    default:
      // Only dangerous (delete_agent) / cross_hub (edit_workflow) actions reach
      // the broker; anything else is a routing bug. Give a generic prompt rather
      // than throwing inside onTask (the item is still actionable by the member).
      return `确认执行这个需要二次确认的动作 (${action.kind})?`
  }
}

/**
 * Pull the approval verdict out of the resume state. `HostInboxService.resolve`
 * injects `{ answer: <InboxDecision> }`; we act only on a well-formed approval
 * decision (anything else → null → re-park). Same shape the outbound approval
 * gate reads, so the host's resolve path is identical for both.
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
