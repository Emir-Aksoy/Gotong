/**
 * personal-butler-escalation.ts — bridge a butler governed-action PARK into a
 * `/me` inbox approval. The sibling of `acp-escalation.ts`, for the resident
 * butler instead of the outbound ACP coding agent.
 *
 * `PersonalButlerAgent` (a core+llm+personal-memory leaf) parks its bounded
 * tool-loop with `SuspendTaskError` carrying a `ButlerGateState` whenever the
 * injected classifier escalates a tool (`pending.approval`). The leaf has zero
 * inbox dependency, so it can't write the item a person resolves. This host
 * helper closes that gap.
 *
 * The production `suspendNotifier` funnels EVERY park and hands the carried
 * state here. For a butler governed park we shape an `approval` `InboxItem`
 * (itemId = the parked task id, so `HostInboxService.resolve` finds the
 * suspended row by it). On resume the SAME two-step recovery runs: the child
 * (the held butler turn) reads `{ ...state, answer }` and `readButlerDecision`
 * pulls the verdict — fail-closed on a missing/garbled decision.
 *
 * Pure + deterministic (clock injected). Returns `null` for any park that is
 * NOT a butler governed-action park (a non-governed butler suspend with no
 * `pending`, or another participant's park entirely), so the notifier can call
 * it for every suspend with no double-write — the human-step broker, approval
 * gate, and ACP helper already write their own.
 */

import type { Task } from '@aipehub/core'
import { readButlerGateState } from '@aipehub/personal-butler'
import type { InboxItem } from '@aipehub/inbox'

export interface ButlerApprovalItemOptions {
  /**
   * The user who must approve the action. For a PERSONAL butler this is the
   * member themselves (you clear your own butler's dangerous moves); the
   * notifier closure conventionally passes `task.origin?.userId`. A team
   * deployment could route to the org owner instead — policy lives in the
   * caller, not here.
   */
  approver: string
  /** Clock injection for deterministic tests. */
  now?: () => number
}

/**
 * Build the approval inbox item for a butler governed-action park, or `null` if
 * `state` is not one. `by` is the butler participant id that parked (shown in
 * the prompt so the approver knows WHICH agent is asking).
 */
export function butlerApprovalItemFor(
  task: Task,
  by: string,
  state: unknown,
  opts: ButlerApprovalItemOptions,
): InboxItem | null {
  const gate = readButlerGateState(state)
  // Only a GOVERNED park (one awaiting a yes/no) becomes an inbox item. A butler
  // park with no `pending` is a wrapped non-governed suspend (e.g. a pre-call
  // quota gate) that resumes by continuing the loop — nothing for a human to do.
  if (!gate?.pending) return null
  const approver = opts.approver
  if (typeof approver !== 'string' || approver.length === 0) return null

  // Derive parentKind from ancestry exactly like HumanInboxParticipant /
  // ApprovalGatedParticipant / the ACP helper: a workflow-dispatched butler task
  // parks its OWN run too, so resolve must run the two-step recovery (child
  // butler turn THEN the workflow run); a direct / agent dispatch only resumes
  // the held butler turn.
  const parentNode = task.ancestry?.at(-1)
  const parentKind: InboxItem['parentKind'] = !parentNode
    ? 'none'
    : parentNode.by.startsWith('workflow:')
      ? 'workflow'
      : 'agent'

  const now = opts.now ?? (() => Date.now())
  const item: InboxItem = {
    itemId: task.id,
    userId: approver,
    kind: 'approval',
    prompt: buildButlerApprovalPrompt(by, gate.pending.approval),
    parentKind,
    status: 'pending',
    createdAt: now(),
  }
  if (task.title !== undefined) item.title = task.title
  if (parentNode) item.parent = { taskId: parentNode.taskId, by: parentNode.by }
  return item
}

/** A short, human-readable (zh) approval prompt naming the butler + the action. */
function buildButlerApprovalPrompt(
  agentId: string,
  approval: { title: string; reason: string },
): string {
  return `管家「${agentId}」想执行一个敏感动作:${approval.title}。原因:${approval.reason}。批准后才会执行。`
}
