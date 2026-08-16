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
import { clipApprovalText } from './approval-text.js'

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
  // IMA-M2 — whitelist hub-INTERNAL actions for IM approval (plan b). The
  // gate is by SHAPE, not an enumerated list: `ask_peer` (cross-hub egress)
  // and any `<server>__<tool>` MCP connector action (the data-leaves-box
  // direction — sending, spending, editing the outside world) stay web-only,
  // so every future connector lands on the conservative side automatically.
  const approvedTool = gate.pending.toolUses.find((t) => t.id === gate.pending!.approvedId)
  const toolName = approvedTool?.name ?? ''
  if (toolName !== '' && toolName !== 'ask_peer' && !toolName.includes('__')) {
    item.imApprovable = true
  }
  // 行标题 = **动作**,不是任务的传输标签(Codex 四轮 H1)。
  //
  // IM 的 `/inbox` 只渲染一行,而那一行取的是 `item.title`(有就用,没有才退回
  // prompt);而生产上每条 IM 聊天派发出来的任务标题固定是 `im:lark` 之类的**通道
  // 名**。于是手机上看到的是 `[a1b2c3d4] im:lark`,人按 `/approve a1b2c3d4` 批的
  // 是什么完全看不见——**盲签**。tier 2「每次 park」的整个安全价值就押在这一行字上,
  // 它必须说清楚要干什么。
  //
  // 故这里用被批动作自己的标题(它已经过同一套清洗+定界),而不是 `task.title`:
  // 对一次 governed park 来说,「动作」才是这条待批项的名字。80 字的 IM 截断由
  // `im-approval-service` 做,且带省略号——被截过的一行读起来就是被截过的。
  item.title = clipApprovalText(gate.pending.approval.title, APPROVAL_TITLE_CHARS)
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

/**
 * A short, human-readable (zh) approval prompt naming the butler + the action.
 *
 * 三个插值位**全都不可信**:`agentId` 来自 hub 配置(半可信),而 title / reason 由
 * 各 toolset 的 `describe`/`classify` 现拼——里面有模型写的 argv、模型起的 agent id、
 * 模型填的 MCP 参数。一个被注入的模型不必骗过闸,只要骗过**读闸的人**:在 title 里
 * 接一句 `。原因:无害。批准后才会执行。` 就能伪造出一句完整的、看起来是 hub 说的话。
 *
 * 所以三处都走 `clipApprovalText`(洗不可见字符 + 把正文里的「」降级成『』),再由
 * 框架用「」把它们包起来:渲染出来的「」只可能在框架的位置上,假框架句接不出来。
 * 见 `approval-text.ts` 顶注。
 */
function buildButlerApprovalPrompt(
  agentId: string,
  approval: { title: string; reason: string },
): string {
  const who = clipApprovalText(agentId, APPROVAL_ID_CHARS)
  const what = clipApprovalText(approval.title, APPROVAL_TITLE_CHARS)
  const why = clipApprovalText(approval.reason, APPROVAL_REASON_CHARS)
  return `管家「${who}」想执行一个敏感动作:「${what}」。原因:「${why}」。批准后才会执行。`
}

/**
 * 三个字段各自的上限。给得宽是刻意的——审批人读不到完整动作就等于盲签(见
 * `personal-butler-hands.ts` 的 `ARGV_TITLE_CHARS` 同一理由);上限只挡「用几十 KB
 * 正文把真正的动作顶出屏幕」这一类覆盖攻击。
 */
const APPROVAL_ID_CHARS = 80
const APPROVAL_TITLE_CHARS = 1200
const APPROVAL_REASON_CHARS = 1200
