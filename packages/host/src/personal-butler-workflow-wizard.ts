/**
 * personal-butler-workflow-wizard.ts — WIZ-M4c. The resident butler's BENIGN
 * "帮我规划一个工作流" planning verb.
 *
 * A member says "我想要一个每周五自动发周报的流程" and the butler runs the
 * six-phase wizard's compose (③组装 → ④衡量缺口 → ⑥校验闭环) and hands back a
 * PROPOSAL: the plain-language explanation, the gap checklist (谁能接 / 怎么补),
 * and the validated YAML — persisting NOTHING. This is the wizard's ⑤ "给用户
 * 建议后由用户调整或同意" step surfaced over IM.
 *
 * ── Why benign / inline (not governed) ───────────────────────────────────────
 * Planning writes nothing: compose burns LLM to produce text, exactly like the
 * butler's own reply turn. The consequential half — actually SAVING the draft —
 * stays in the existing governed `create_workflow` (park → /me approve), which
 * this tool hands off to: the member says yes, the butler calls
 * `create_workflow` with the wizard's YAML, and the approval card names it. So
 * "propose freely, land only through the gate" — same split as diagnose (benign)
 * vs edit_agent (governed).
 *
 * ── Why hand the YAML through the model (not a session cache) ────────────────
 * The butler is stateless per IM message (client-held history discipline,
 * WFEDIT precedent). Caching "the last plan" server-side would leak across
 * concurrent chats and rot; instead the proposal text carries the YAML fenced,
 * and the model passes it VERBATIM into `create_workflow(yaml)`. The member
 * service re-parses + re-gates it on approval (createFromYaml is zero-LLM and
 * same-gate as create), so a mangled hand-off fails closed, never saves junk.
 *
 * Host-only: needs the wizard service, injected as a narrow duck-typed surface.
 * Per-user — the router builds one per `origin.userId`; compose is attributed to
 * that member (`by`), same identity a /me wizard call carries.
 */

import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@gotong/llm'

import type { WizardComposeResult } from './workflow-wizard.js'

/** The slice of `WorkflowWizardService` this tool calls. */
export interface ButlerWizardSource {
  compose(req: {
    task: string
    by: string
    clarifications?: string
  }): Promise<WizardComposeResult>
}

export interface ButlerWorkflowWizardDeps {
  /** The member this butler serves — compose is attributed to them. */
  userId: string
  wizard?: ButlerWizardSource
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void }
}

const PLAN_TOOL: LlmToolDefinition = {
  name: 'plan_workflow',
  description:
    '用建流向导给这个成员规划一个工作流方案(只出方案,不保存):AI 按 hub 里现有的组件组装流程、核对每一步谁能接、缺什么怎么补,并给出已通过校验的 YAML。成员满意后,再调 create_workflow 并把方案里的 YAML 原样带上落草稿。适合「帮我设计/规划一个…的流程」这种还没定稿的诉求。',
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: '想让工作流做什么,一句大白话(例如「每周五把周报整理好发给我确认」)。',
      },
      clarifications: {
        type: 'string',
        description: '成员补充的细节(频率/谁审批/用什么数据),可选。',
      },
    },
    required: ['task'],
    additionalProperties: false,
  },
}

class ButlerWorkflowWizardToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerWorkflowWizardDeps) {}

  listTools(): LlmToolDefinition[] {
    return this.deps.wizard ? [PLAN_TOOL] : []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (name !== 'plan_workflow') return text(`未知工具:${name}`, true)
    const { wizard, userId } = this.deps
    if (!wizard) return text('建流向导没接线。', true)

    const task = typeof args.task === 'string' ? args.task.trim() : ''
    if (!task) return text('没说这个工作流要做什么。用一句话描述一下?', true)
    const clarifications =
      typeof args.clarifications === 'string' && args.clarifications.trim()
        ? args.clarifications
        : undefined

    let r: WizardComposeResult
    try {
      r = await wizard.compose({ task, by: userId, ...(clarifications ? { clarifications } : {}) })
    } catch (err) {
      this.deps.logger?.error('butler plan_workflow failed', { err })
      return text('规划的时候出错了,什么都没保存,稍后再试。', true)
    }

    if (!r.ok) {
      if (r.reason === 'needs_user') {
        // The assistant is asking back — relay its question; that IS the answer.
        return text(r.explanation?.trim() || '我还需要你多说一点:这个流程谁参与、按什么顺序?')
      }
      if (r.reason === 'exhausted') {
        return text(
          `试了 ${r.repairRounds} 轮修复还是没凑出一版能过校验的方案。最后卡在:\n${r.errorsText ?? '(没有更多细节)'}\n换个说法描述一下,或者把流程拆简单点再试?`,
          true,
        )
      }
      return text('AI 助手暂时不可用(可能没配 key),稍后再试。', true)
    }

    const lines = [`方案(还没保存):${r.explanation}`, '', r.gapText]
    if (r.installTemplateRefs.length > 0) {
      lines.push(
        '',
        `按这个方案要先装模板:${r.installTemplateRefs.join('、')}(装模板需要管理员在模板画廊批准安装)。`,
      )
    }
    lines.push(
      '',
      '工作流定义:',
      '```yaml',
      r.yaml.trimEnd(),
      '```',
      '',
      '满意的话,我就用 create_workflow 把上面这份 YAML 原样落成草稿(会先送你的 /me 收件箱等你批准,不会重新生成)。想调整就直接说改哪里,我再规划一版。',
    )
    return text(lines.join('\n'))
  }
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError
    ? { content: [{ type: 'text', text: t }], isError: true }
    : { content: [{ type: 'text', text: t }] }
}

/**
 * Build the per-user benign "plan a workflow" tool. Add it to the butler's
 * `benign` set. Offers no tool (invisible) when the wizard surface is absent —
 * same degradation as the /me wizard routes' 503.
 */
export function buildButlerWorkflowWizardToolset(
  deps: ButlerWorkflowWizardDeps,
): LlmAgentToolset {
  return new ButlerWorkflowWizardToolset(deps)
}
