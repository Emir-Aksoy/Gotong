/**
 * personal-butler-workflow-create.ts — Track A BE-M3. The resident butler's
 * governed "用大白话给我建一个工作流" verb.
 *
 * BF-M7 already lets a member — by talking to their butler — CREATE/EDIT/DELETE
 * their own agents and EDIT an existing workflow. The one authoring gap was
 * building a workflow from scratch. This closes it: a member says "每天早上把我的
 * 待办整理一下发给我" and the butler proposes a new workflow; on approval the
 * existing `MeWorkflowCreateService` turns the sentence into YAML and saves it as
 * a DRAFT the member owns.
 *
 * ── Why this is a THIN governed wrapper, not a new engine ────────────────────
 * Every hard part already exists in `MeWorkflowCreateService` (the /me 工作流架构师):
 * NL→YAML via the assistant, the ★ LOCAL-ONLY gate ★ (a member-authored workflow
 * that dispatches off-hub is rejected — cross-hub is an admin trust contract),
 * draft-never-live, owner-as-grant, the structure hard-gate. This file only
 * exposes that service as ONE approval-gated LLM tool. The butler invents no
 * capability the member doesn't already have in /me — the cross-hub reject and
 * the draft ceiling come along for free because they live in the service.
 *
 * ── Why a SEPARATE GovernedActionToolset (not folded into the steward set) ───
 * `create_workflow` is not a `StewardAction` (only `edit_workflow` is), so it
 * routes through its OWN executor here rather than `performStewardAction`. The
 * butler composes multiple governed gates (`PersonalButlerAgent.governed` takes an
 * array; `governedFor` picks the gate that owns a tool name on resume), and
 * `create_workflow` is disjoint from every steward verb — so this drops in
 * alongside the steward gate with no vocabulary change and no touch to the /me
 * steward. Approval flows through the SAME park → `butlerApprovalItemFor` → /me
 * inbox → approve path as every other butler governed action.
 *
 * Host-only: it needs the member workflow-create service, injected as a narrow
 * duck-typed surface. Per-user — the router builds one per `origin.userId`, and
 * the tool passes THAT member's id so the draft is owned by (and scoped to) them.
 */

import { GovernedActionToolset } from '@aipehub/personal-butler'

import type { MeWorkflowCreateResult } from './me-workflow-create-service.js'

/**
 * The slice of `MeWorkflowCreateService` this tool needs: author a workflow from
 * a member's plain-language instruction. The real service satisfies it (its
 * request carries optional `detail`/`history`/`onChunk` the butler doesn't use).
 * `createFromYaml` (WIZ-M4a) lands a wizard-checked YAML verbatim through the
 * SAME gates, zero LLM — the plan_workflow → create_workflow hand-off path.
 */
export interface ButlerWorkflowCreateSource {
  create(req: { instruction: string; userId: string }): Promise<MeWorkflowCreateResult>
  createFromYaml?(req: { yaml: string; userId: string }): Promise<MeWorkflowCreateResult>
}

export interface ButlerWorkflowCreateDeps {
  /** The member this butler serves — the new draft is owned by (and scoped to) them. */
  userId: string
  create: ButlerWorkflowCreateSource
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void }
}

/**
 * Build the per-user governed `create_workflow` gate. Returns a
 * `GovernedActionToolset` to compose into `PersonalButlerAgent.governed`. Every
 * call defaults to `approve` — the resident IM butler has no plan/apply preview,
 * so the /me inbox IS the review-before-execute step (same discipline as the
 * BF-M7 agent verbs).
 */
export function buildButlerWorkflowCreateToolset(
  deps: ButlerWorkflowCreateDeps,
): GovernedActionToolset {
  const { userId, create, logger } = deps
  return new GovernedActionToolset({
    tools: [
      {
        name: 'create_workflow',
        description:
          '用大白话给这个成员新建一个工作流(例如「每天早上把我的待办整理一下发给我」)。会先送 /me 收件箱等你批准;批准后 AI 把描述写成 YAML 存成【草稿】——只用本 hub 的能力,不跨 hub;之后你可以在 /me 里看流程图、改或发布。如果刚用 plan_workflow 出过方案且成员满意,把方案里的 YAML 原样传进 yaml,批准后就按那份落盘,不再重新生成。',
        inputSchema: {
          type: 'object',
          properties: {
            instruction: {
              type: 'string',
              description: '你想让这个工作流做什么,用大白话说清楚:谁来做、按什么顺序、用什么数据。',
            },
            yaml: {
              type: 'string',
              description:
                '(可选)plan_workflow 方案里的那份 YAML,原样传入。传了就按这份已核对的定义建,不再让 AI 重写。',
            },
          },
          required: ['instruction'],
          additionalProperties: false,
        },
        defaultVerdict: { decision: 'approve', reason: '会新建一个工作流——先请你确认' },
      },
    ],
    // Runs only AFTER the member approved in /me. Delegates to the member service,
    // which enforces the local-only (cross-hub reject) gate + draft-never-live.
    execute: async (_name, args) => {
      const instruction = typeof args.instruction === 'string' ? args.instruction : ''
      if (!instruction.trim()) {
        return { text: '你没说这个工作流要做什么,我没建。再描述一下?', isError: true }
      }
      const yaml = typeof args.yaml === 'string' && args.yaml.trim() ? args.yaml : null
      let result: MeWorkflowCreateResult
      try {
        if (yaml) {
          // WIZ-M4c — the wizard hand-off: land the member-approved YAML verbatim
          // (zero LLM). Falling back to create(instruction) here would silently
          // regenerate something the member never saw — refuse instead.
          if (!create.createFromYaml) {
            return { text: '按现成 YAML 建流的通道没接线,先没建。', isError: true }
          }
          result = await create.createFromYaml({ yaml, userId })
        } else {
          result = await create.create({ instruction, userId })
        }
      } catch (err) {
        logger?.error('butler create_workflow failed', { err })
        return { text: '新建工作流时出错了,没有保存,稍后再试。', isError: true }
      }
      if (!result.ok) {
        // A denial (cross-hub egress / assistant failure / id clash / …) is an
        // honest "couldn't do it" — surface it as an error so the butler tells the
        // member the reason instead of claiming success.
        return { text: `没能新建:${result.message}`, isError: true }
      }
      // The YAML path returns explanation:'' — skip the blank line honestly.
      const explanationLine = result.explanation.trim() ? `\n${result.explanation}` : ''
      return {
        text: `工作流已建好(草稿:${result.workflowId})。${explanationLine}\n去 /me 可以看它的流程图、再改,或发布它。`,
      }
    },
    // Human-readable (zh) title for the /me inbox item — the member sees WHAT they'd
    // be creating before they approve, and whether it lands the wizard-checked YAML
    // verbatim or asks the AI to author from scratch.
    describe: (_name, args) => {
      const instruction = typeof args.instruction === 'string' ? args.instruction.trim() : ''
      const brief = instruction.length > 40 ? instruction.slice(0, 39) + '…' : instruction
      const viaWizard = typeof args.yaml === 'string' && args.yaml.trim().length > 0
      return viaWizard
        ? `新建工作流(按向导核对过的方案):${brief || '(未描述)'}`
        : `新建工作流:${brief || '(未描述)'}`
    },
  })
}
