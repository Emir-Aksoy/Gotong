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

/**
 * IMA-M2 — hub 内配置动作的**列举**名单:只有这些 governed 工具批下去的项会带
 * `imApprovable`,也就是只有它们能在手机 IM 里按短码批。
 *
 * 名单是**列举**不是排除,理由见 `butlerApprovalItemFor` 里那段注释:排除法只
 * 约束新的写入方,约束不了新的工具族。往这里加一个名字 = 明确宣称「这个动作在
 * 一行 IM 里读得全,而且批错的后果留在 hub 内」。
 */
export const IM_APPROVABLE_TOOLS: ReadonlySet<string> = new Set([
  'create_agent',
  'edit_agent',
  'delete_agent',
  'create_workflow',
  'edit_workflow',
])

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
  // IMA-M2 — 只有名单上的动作能在 IM 里批(plan b)。
  //
  // 这里原本写的是**排除法**(不是 `ask_peer`、名字里没有 `__` 就放行),注释还管它
  // 叫「whitelist」。那条纪律管住了新的**写入方**,没管住新的**工具族**:HANDS-M2
  // 一次挂上五件 `hands_*`,一个字没改就全部落进了「可以在手机上批」的一侧——没有
  // 人做过这个决定。名单必须是**列举**的,新工具的默认答案是「不在名单上」。
  //
  // 名单外的三类,各自的理由:
  //   - `ask_peer`:跨 hub 出网,IMA-M0 就划在网页侧;
  //   - `<server>__<tool>` MCP 连接器:数据离盒方向(替你发、替你花钱、改外面的
  //     世界),任何未来的连接器自动落保守侧——它们的名字本来就进不了列举名单;
  //   - `hands_*`:**没有一种能写的 tier 2 手部动作在一行 IM 里读得全**(argv 只
  //     渲染前 4 段各 60 字,stdin 预览 240 字,而一行的预算是 80 码点)。今天它
  //     们落在网页侧是因为**那把尺子**恰好量不下——把 agent id 改短一点、把框架
  //     那句话缩一缩,这道门就静默打开了。安全属性不能挂在显示长度上;
  //   - `pack_backup`:身份档里有 hub 签名钥,是凭证级动作(AFR-M7 自己就这么写
  //     的)。老的排除法把它放进了 IM 侧,同样没有人做过这个决定。
  //
  // 名单与真实 governed 工具面的双向核对在 `butler-tool-tiers.test.ts`:新增一个
  // governed 工具而不在这里或那里的 web-only 名单上表态,门就红。
  const approvedTool = gate.pending.toolUses.find((t) => t.id === gate.pending!.approvedId)
  const toolName = approvedTool?.name ?? ''
  if (IM_APPROVABLE_TOOLS.has(toolName)) {
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
  // 正文是**用标题拼出来的**(见 `buildButlerApprovalPrompt`),所以一行渲染时说
  // 一遍就够。这个事实由写入方声明,不由渲染层从文本里倒推(Codex 九轮 A-H1)。
  item.titleInPrompt = true
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
