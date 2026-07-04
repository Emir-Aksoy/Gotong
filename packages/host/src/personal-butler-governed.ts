/**
 * personal-butler-governed.ts — build the resident butler's SENSITIVE-action
 * toolset (BF-M7), reusing the hub-steward action set + executor.
 *
 * BF-M4 folded a PURE-MEMORY butler into the IM channel (remembers you, runs
 * benign tools inline, never parks). BF-M7 gives it the governed half: a
 * `GovernedActionToolset` whose tools let a member — by talking to the butler —
 * create / edit / delete their own managed agents and edit their own workflows.
 * Each one is APPROVAL-GATED: the butler's bounded loop parks the task
 * (`SuspendTaskError`), `butlerApprovalItemFor` turns the park into a `/me` inbox
 * item, and NOTHING runs until the member approves it there (the North Star:
 * "sensitive actions → the member's inbox"; the deferred-until-now BF-M7).
 *
 * ── Why reuse the steward, and why STRICTER than it ──────────────────────────
 * Execution routes through the SAME `performStewardAction` + member services
 * (`HostMeAgentService` / `MeWorkflowEditService`) the `/me` hub-steward uses, so
 * the butler is structurally INCAPABLE of exceeding what the member could do by
 * hand: the same `resource_grants` RBAC ladder + member limits gate every create
 * / edit / delete, and an `edit_workflow` inherits the WFEDIT cross-hub 出入口
 * lock (a member can never repoint a cross-hub edge through the butler either).
 *
 * But the butler is tiered DELIBERATELY stricter than the steward: the `/me`
 * steward SPA has a plan→apply PREVIEW (the member reviews a `ClassifiedProposal`
 * and clicks apply), so its `safe` create/edit run "inline" only AFTER that
 * review. The resident IM butler has no such preview — a `safe` verdict would run
 * from a chat message with zero human confirmation. So here EVERY exposed action
 * defaults to `approve`: the `/me` inbox IS the review-before-execute step. That's
 * the conservative mode `GovernedActionToolset` documents ("a governed tool with
 * no policy still asks a human"), applied on purpose.
 *
 * The four OPERATOR-ONLY sensitive writes (credentials / peer / security) are NOT
 * exposed at all — a member steward tiers them `forbidden` and is never handed
 * their executors, so the butler simply has no such tools.
 *
 * Host-only: it wires `@gotong/hub-steward` (the action vocabulary + validator)
 * to `performStewardAction` (host) + the member services. Per-user — the router
 * builds one butler (and one of these) per `origin.userId`, each bound to that
 * member's id so the executor's RBAC scopes to them.
 */

import {
  GovernedActionToolset,
  type GovernedToolSpec,
} from '@gotong/personal-butler'
import { validateStewardAction } from '@gotong/hub-steward'

import {
  performStewardAction,
  summarizeStewardAction,
  type StewardActionResult,
  type StewardAgentDirectory,
  type StewardWorkflowEditor,
} from './hub-steward-service.js'

export interface ButlerGovernedDeps {
  /** The member this butler serves — the executor's RBAC scopes to them. */
  userId: string
  /** Member-agent read/write service (`HostMeAgentService`). */
  agents: StewardAgentDirectory
  /**
   * Member-workflow editor (`MeWorkflowEditService`) — inherits the WFEDIT lock.
   * OPTIONAL: a hub with identity but no `workflowAssist` has none (same gate as
   * the steward). Absent ⇒ the `edit_workflow` tool is not exposed at all — the
   * butler advertises only the actions it can actually execute (agents still work).
   */
  workflowEditor?: StewardWorkflowEditor
}

/**
 * The provider enum for `create_agent` — mirrors `StewardAgentProvider`, kept as
 * a literal here so the tool schema advertises exactly the pickable providers.
 * The member service re-rejects any provider with no usable key on this hub.
 */
const CREATE_PROVIDER_ENUM = ['anthropic', 'openai', 'mock'] as const

/**
 * The agent-field object shared by `create_agent` (all required) and
 * `edit_agent.changes` (all optional). Factored so both schemas stay in lockstep
 * with `StewardAgentFields`.
 */
const AGENT_FIELD_PROPS: Record<string, unknown> = {
  handle: { type: 'string', description: '助手的短名(host 会拼成完整 id）' },
  label: { type: 'string', description: '给人看的名字' },
  provider: { type: 'string', enum: [...CREATE_PROVIDER_ENUM], description: '底层模型 provider' },
  model: { type: 'string', description: '可选：具体模型 id' },
  system: { type: 'string', description: '系统提示(这个助手的人设/职责）' },
  capabilities: {
    type: 'array',
    items: { type: 'string' },
    description: '这个助手回应的能力标签，例如 ["chat"]',
  },
}

/**
 * The member-scoped governed tools. All default to `approve` (see file header):
 * the resident IM butler always asks the member in `/me` before it changes their
 * hub. Names must match the `StewardAction['kind']` values so the executor can
 * build the action by `{ kind: name, ...args }`. `edit_workflow` is included only
 * when a workflow editor is wired (`withWorkflow`).
 */
function butlerGovernedToolSpecs(withWorkflow: boolean): GovernedToolSpec[] {
  const specs: GovernedToolSpec[] = [
    {
      name: 'create_agent',
      description:
        '为这个成员新建一个受管助手。会先送到 /me 收件箱等你批准，批准后才真正创建。',
      inputSchema: {
        type: 'object',
        properties: { ...AGENT_FIELD_PROPS },
        required: ['handle', 'label', 'provider', 'system', 'capabilities'],
        additionalProperties: false,
      },
      defaultVerdict: { decision: 'approve', reason: '会新建一个助手——先请你确认' },
    },
    {
      name: 'edit_agent',
      description:
        '修改成员某个已有助手的设置(名字/provider/model/系统提示/能力）。先送 /me 收件箱等你批准。',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '要改的助手的完整 id' },
          changes: {
            type: 'object',
            properties: { ...AGENT_FIELD_PROPS },
            additionalProperties: false,
            description: '只放你要改的字段',
          },
        },
        required: ['agentId', 'changes'],
        additionalProperties: false,
      },
      defaultVerdict: { decision: 'approve', reason: '会改动一个助手的设置——先请你确认' },
    },
    {
      name: 'delete_agent',
      description: '删除成员的一个助手(不可逆）。先送 /me 收件箱等你批准。',
      inputSchema: {
        type: 'object',
        properties: { agentId: { type: 'string', description: '要删的助手的完整 id' } },
        required: ['agentId'],
        additionalProperties: false,
      },
      defaultVerdict: { decision: 'approve', reason: '会永久删除一个助手——先请你确认' },
    },
  ]
  if (withWorkflow) {
    specs.push({
      name: 'edit_workflow',
      description:
        '用大白话修改成员的一个工作流(走 OpenClaw 式编辑器，跨 hub 出入口受锁保护）。先送 /me 收件箱等你批准。',
      inputSchema: {
        type: 'object',
        properties: {
          workflowId: { type: 'string', description: '要改的工作流 id' },
          instruction: { type: 'string', description: '你想怎么改，用大白话说' },
        },
        required: ['workflowId', 'instruction'],
        additionalProperties: false,
      },
      defaultVerdict: { decision: 'approve', reason: '会改动一个工作流——先请你确认' },
    })
  }
  return specs
}

/**
 * Build the per-user governed toolset for a resident butler, or `undefined` — the
 * caller passes `undefined` straight to `PersonalButlerAgent({ governed })`, which
 * degrades to a pure-memory butler. (Kept total so main.ts can build it
 * unconditionally when the member services are present.)
 */
export function buildButlerGovernedToolset(deps: ButlerGovernedDeps): GovernedActionToolset {
  const { userId, agents, workflowEditor } = deps
  // `performStewardAction`'s deps require a workflow editor, but the agent kinds
  // never touch it. When none is wired, `edit_workflow` isn't exposed (see specs),
  // so this stub is unreachable — it exists only to satisfy the type, and throws
  // loudly if a future change ever routes here without an editor.
  const editor: StewardWorkflowEditor =
    workflowEditor ?? {
      edit: async () => {
        throw new Error('butler governed toolset: edit_workflow invoked with no workflow editor')
      },
    }
  return new GovernedActionToolset({
    tools: butlerGovernedToolSpecs(workflowEditor !== undefined),
    // Execute a CLEARED action (the butler's loop / a human approval already
    // passed the gate). Build the steward action from the tool call, VALIDATE it
    // (the one contract — rejects malformed shapes AND any key-shaped field), then
    // run the shared chokepoint. A member butler never wires `sensitive`, so a
    // sensitive kind (impossible here — not exposed) would fail closed there.
    execute: async (name, args) => {
      const action = validateStewardAction({ kind: name, ...args })
      if (!action) {
        return {
          text: `动作格式不对，没有执行(${name})。`,
          isError: true,
        }
      }
      const result = await performStewardAction(userId, action, { agents, workflowEditor: editor })
      return { text: renderButlerActionResult(result) }
    },
    // Human-readable (zh) title for the /me inbox item — reuse the steward's
    // summary so the member sees "建一个新助手「X」" not raw JSON. Falls back to
    // the toolset's default `name(args)` when the args don't form a valid action.
    describe: (name, args) => {
      const action = validateStewardAction({ kind: name, ...args })
      return action ? summarizeStewardAction(action) : `${name}(${safeArgs(args)})`
    },
  })
}

/** Concise zh rendering of a performed action, for the LLM's tool_result. */
function renderButlerActionResult(result: StewardActionResult): string {
  switch (result.kind) {
    case 'inspect':
      return result.answer
    case 'create_agent':
      return `已创建助手「${result.agent.label}」(${result.agent.id})。`
    case 'edit_agent':
      return `已更新助手 ${result.agent.id}。`
    case 'delete_agent':
      return result.removed ? '已删除该助手。' : '没找到这个助手(可能已删）。'
    case 'edit_workflow':
      return result.edit.ok
        ? '工作流已按你的说法更新。'
        : `工作流没有改动:${result.edit.message ?? result.edit.reason}`
    // The member butler never exposes the sensitive kinds, so these are
    // unreachable — render defensively rather than throw.
    case 'set_credential_ref':
      return `已注册 ${result.provider} 凭证(env ${result.envVarName}）。`
    case 'revoke_credential':
      return result.removed ? '已吊销该凭证。' : '没找到这个凭证。'
    case 'set_peer_policy':
      return `已更新对端 ${result.peerId} 的信任契约。`
    case 'set_security_quota':
      return `已给 ${result.scope} 设 ${result.metric} 配额。`
  }
}

/** Best-effort JSON slice for the describe fallback. */
function safeArgs(args: Record<string, unknown>): string {
  let s: string
  try {
    s = JSON.stringify(args)
  } catch {
    s = '…'
  }
  return s.length > 120 ? s.slice(0, 119) + '…' : s
}
