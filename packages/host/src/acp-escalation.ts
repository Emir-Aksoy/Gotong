/**
 * acp-escalation.ts — bridge an ACP permission PARK into a `/me` inbox approval.
 *
 * The OpenClaw-style outbound ACP adapter (`AcpParticipant`) is a core-only leaf:
 * when its permission gate ESCALATES a destructive tool, it throws
 * `SuspendTaskError` carrying an `AcpCheckpointState` (the in-memory permission
 * token + a human-readable tool context) — but it has zero inbox dependency, so
 * it cannot write the item a person resolves. This host helper closes that gap.
 *
 * The production `suspendNotifier` already funnels EVERY park; it hands the
 * carried state here. For an ACP permission park we shape an `approval`
 * `InboxItem` (itemId = the parked task id, so `HostInboxService.resolve` finds
 * the suspended row by it) assigned to the approver — conventionally the org
 * owner, mirroring the Phase 18 outbound cross-org approval gate. Resolve then
 * runs the SAME two-step recovery the human-step broker uses: child (the held
 * ACP turn) before parent (a workflow run, if one dispatched the task).
 *
 * Pure + deterministic (clock injected). Returns `null` for any NON-ACP park, so
 * the notifier can call it for every suspend and only ACP permission parks turn
 * into inbox items (the human-step broker / approval gate already write their
 * own, so there is no double-write).
 */

import type { Task } from '@gotong/core'
import { readAcpCheckpointState, type AcpCheckpointState } from '@gotong/acp-agent'
import type { InboxItem } from '@gotong/inbox'
import { clipApprovalText } from './approval-text.js'

export interface AcpApprovalItemOptions {
  /** The user who must approve the action (conventionally the org owner). */
  approver: string
  /** Clock injection for deterministic tests. */
  now?: () => number
}

/**
 * Build the approval inbox item for an ACP permission park, or `null` if `state`
 * is not one. `by` is the ACP participant id that parked (shown in the prompt so
 * the approver knows WHICH coding agent is asking).
 */
export function acpApprovalItemFor(
  task: Task,
  by: string,
  state: unknown,
  opts: AcpApprovalItemOptions,
): InboxItem | null {
  const park = readAcpCheckpointState(state)
  if (!park || park.kind !== 'permission') return null

  // Derive parentKind from ancestry exactly like HumanInboxParticipant /
  // ApprovalGatedParticipant: a workflow-dispatched ACP task parks its OWN run
  // too, so resolve must run the two-step recovery (child ACP turn THEN the
  // workflow run); a direct / agent dispatch only resumes the held ACP turn.
  const parentNode = task.ancestry?.at(-1)
  const parentKind: InboxItem['parentKind'] = !parentNode
    ? 'none'
    : parentNode.by.startsWith('workflow:')
      ? 'workflow'
      : 'agent'

  const now = opts.now ?? (() => Date.now())
  const item: InboxItem = {
    itemId: task.id,
    userId: opts.approver,
    kind: 'approval',
    prompt: buildAcpApprovalPrompt(by, park),
    parentKind,
    status: 'pending',
    createdAt: now(),
  }
  // 行标题 = 那个**动作**,不是任务的传输标签(Codex 四轮 H1/H3 同型):IM 的
  // `/inbox` 只渲染 `item.title`,而任务标题在生产上常是通道名。同样过清洗。
  item.title = clipApprovalText(acpActionText(park), ACP_TITLE_CHARS)
  if (parentNode) item.parent = { taskId: parentNode.taskId, by: parentNode.by }
  return item
}

/** 被批的那个动作,人话一行。**来自对端 coding agent,一律当不可信正文。** */
function acpActionText(park: AcpCheckpointState): string {
  return park.tool.title ?? park.tool.kind ?? 'an unspecified action'
}

const ACP_ID_CHARS = 80
const ACP_TITLE_CHARS = 1200

/**
 * A short, human-readable approval prompt naming the agent + the action it wants.
 *
 * 这里的 `tool.title` 是**外部 coding agent 通过 ACP 送进来的字**——比管家那两个
 * 字段更不可信(那边至少是我们自己的模型)。它同样能在正文里接出一句假的框架句:
 * `title = "read a file. Approve before it runs? Approved."`。故与
 * `personal-butler-escalation.ts` 走同一套清洗 + 定界:审批卡怎么拼,全仓只有
 * `approval-text.ts` 一处答案(Codex 四轮 H3)。
 */
function buildAcpApprovalPrompt(agentId: string, park: AcpCheckpointState): string {
  const who = clipApprovalText(agentId, ACP_ID_CHARS)
  const what = clipApprovalText(acpActionText(park), ACP_TITLE_CHARS)
  return `Coding agent 「${who}」 wants to run a destructive action: 「${what}」. Approve before it runs?`
}
