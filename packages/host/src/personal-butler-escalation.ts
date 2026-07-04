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

import type { Task, TaskResult } from '@gotong/core'
import { readButlerGateState } from '@gotong/personal-butler'
import type { InboxItem } from '@gotong/inbox'

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
    // Tag the origin so HostInboxService can push the outcome back to the
    // member's IM once they resolve it (S1-M3). A workflow human step leaves
    // this unset — only a butler governed park opts into the push-back.
    source: 'butler',
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

/**
 * S1-M3 — the message (if any) to push back to a member's IM once they resolve
 * an inbox item. This is the discriminator + phrasing for the push-back:
 *
 *   - only a BUTLER governed-action item opts in (`source === 'butler'`); a
 *     workflow human step / ACP escalation / steward park leaves `source` unset
 *     and returns null — they don't push;
 *   - the resumed butler turn phrases its OWN outcome and returns
 *     `{ kind:'ok', output:{ text } }` for BOTH approve (the action ran) and
 *     reject (fail-closed), so forward that text verbatim;
 *   - a failure AFTER approval still deserves a word (the butler promised to
 *     come back with the result);
 *   - a re-park (`suspended`) or an unparked child (`null`) is not a settled
 *     outcome → null (stay silent; the next resolve / sweep settles it).
 *
 * Pure — the caller (HostInboxService's `onResolved` hook in main.ts) forwards
 * the returned line to the reachable registry's push. Extracted (not inlined) so
 * it is a named, unit-testable unit AND the e2e can wire the SAME function to a
 * fake push exactly as production wires it to the real one.
 */
export function butlerResolvePushback(
  item: InboxItem,
  childResult: TaskResult | null,
): string | null {
  if (item.source !== 'butler' || !childResult) return null
  if (childResult.kind === 'ok') {
    const out = childResult.output
    const text =
      out && typeof out === 'object' && 'text' in out && typeof (out as { text: unknown }).text === 'string'
        ? (out as { text: string }).text.trim()
        : ''
    return text.length > 0 ? text : '好了,我已经照你的意思处理完了。'
  }
  if (childResult.kind === 'failed') return `抱歉,刚才那件事没能完成:${childResult.error}`
  return null
}

/** A short, human-readable (zh) approval prompt naming the butler + the action. */
function buildButlerApprovalPrompt(
  agentId: string,
  approval: { title: string; reason: string },
): string {
  return `管家「${agentId}」想执行一个敏感动作:${approval.title}。原因:${approval.reason}。批准后才会执行。`
}
