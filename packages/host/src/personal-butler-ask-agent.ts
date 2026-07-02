/**
 * personal-butler-ask-agent.ts — Track A BE-M4. The resident butler's BENIGN
 * "问我自己的助手" one-shot dispatch.
 *
 * A member talking to the butler can say "问一下我的研究助手 X 是什么" and the
 * butler relays the question to ONE of THEIR OWN agents, waits for the reply, and
 * hands it back — a single round trip, inline. This is the butler acting as the
 * member's switchboard to the agents it already manages.
 *
 * ── Why benign / inline (not governed) ───────────────────────────────────────
 * Asking your own agent a question is a member self-service action — exactly what
 * the member does by messaging that agent directly. It changes nothing on anyone
 * else's behalf, so it needs no approval park. If the target agent itself tries a
 * consequential action, THAT gates downstream via the agent's own machinery (a
 * governed tool parks to the agent's inbox; a member LLM agent has only benign
 * tools anyway). So this tool stays a benign switchboard: it dispatches and reads
 * back, nothing more.
 *
 * ── The one security gate: no-leak ───────────────────────────────────────────
 * The target MUST be an agent THIS member OWNS. The tool resolves `agentId`
 * against `listOwned(userId)` and refuses anything else — so a member (or a model
 * improvising an id) can never make the butler ask, or read the reply of, another
 * member's agent. The dispatch is attributed to the member (`origin.userId`), the
 * same identity a /me dispatch carries.
 *
 * ── Why AWAIT the reply (unlike run_my_workflow) ─────────────────────────────
 * A workflow run is minutes→hours, so S1-M1 fires-and-forgets. A single agent turn
 * is bounded, and the member wants the answer in the same IM reply — so this AWAITs
 * the `TaskResult`. The failure modes resolve on their own: a target that PARKS
 * returns `suspended` immediately (no hang), an offline one returns
 * `no_participant`, an erroring one `failed`. Each maps to an honest message.
 *
 * Host-only: it needs a per-user owned-agent lister (`HostMeAgentService.listOwned`)
 * + `hub.dispatch`, injected as narrow duck-typed surfaces. Per-user — the router
 * builds one per `origin.userId`, bound to that member's id.
 */

import type { TaskResult } from '@aipehub/core'
import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@aipehub/llm'

/** One owned agent the switchboard can reach — id + optional display label/liveness. */
export interface ButlerAskAgent {
  id: string
  label?: string
  online?: boolean
}

/** Lists the agents THIS member owns. `HostMeAgentService.listOwned` fits. */
export interface ButlerAskRosterSource {
  listOwned(userId: string): Promise<ButlerAskAgent[]>
}

/** The narrow slice of `Hub.dispatch` this tool calls — one explicit round trip. */
export interface ButlerAskDispatch {
  dispatch(input: {
    from: string
    origin: { orgId: string; userId: string }
    strategy: { kind: 'explicit'; to: string }
    payload: unknown
    title: string
  }): Promise<TaskResult>
}

export interface ButlerAskAgentDeps {
  /** The member this butler serves — dispatch is scoped to and attributed to them. */
  userId: string
  roster?: ButlerAskRosterSource
  hub: ButlerAskDispatch
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void }
}

const ASK_TOOL: LlmToolDefinition = {
  name: 'ask_my_agent',
  description:
    '把一个问题转给这个成员自己的某个助手,拿到回答再带回来(一次问答,只能问他自己的助手)。适合「问一下我的研究助手…」「让我的编码助手看看这段」这种一次性求助。先用 list_my_agents 看有哪些助手和它们的 id。',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: '要问的助手的完整 id(见 list_my_agents)。' },
      message: { type: 'string', description: '要问它的话,用大白话写清楚。' },
    },
    required: ['agentId', 'message'],
    additionalProperties: false,
  },
}

class ButlerAskAgentToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerAskAgentDeps) {}

  listTools(): LlmToolDefinition[] {
    // Needs the roster to enforce no-leak; without it there's no safe target set.
    return this.deps.roster ? [ASK_TOOL] : []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (name !== 'ask_my_agent') return text(`未知工具:${name}`, true)
    const { roster, hub, userId } = this.deps
    if (!roster) return text('这个功能没接线。', true)

    const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : ''
    const message = typeof args.message === 'string' ? args.message : ''
    if (!agentId) return text('没说要问哪个助手(缺 agentId)。先用 list_my_agents 看看。', true)
    if (!message.trim()) return text('没说要问什么。再写一下要问的话?', true)

    // ── no-leak: the target MUST be one this member owns ──────────────────────
    let owned: ButlerAskAgent[]
    try {
      owned = await roster.listOwned(userId)
    } catch (err) {
      this.deps.logger?.error('butler ask: listOwned failed', { err })
      return text('暂时读不到你的助手列表,稍后再试。', true)
    }
    const target = owned.find((a) => a.id === agentId)
    if (!target) {
      const ids = owned.map((a) => a.id).join('、') || '(你名下还没有助手)'
      return text(`「${agentId}」不是你的助手,我不能替你问它。你的助手有:${ids}`, true)
    }
    const label = target.label ?? target.id

    // ── one explicit round trip, attributed to the member ─────────────────────
    let result: TaskResult
    try {
      result = await hub.dispatch({
        from: userId,
        origin: { orgId: 'local', userId },
        strategy: { kind: 'explicit', to: agentId },
        payload: message,
        title: `问助手「${label}」— ${userId}`,
      })
    } catch (err) {
      this.deps.logger?.error('butler ask: dispatch failed', { err, agentId })
      return text(`问「${label}」的时候出错了,稍后再试。`, true)
    }

    switch (result.kind) {
      case 'ok': {
        const reply = replyText(result.output)
        return reply
          ? text(`「${label}」说:\n${reply}`)
          : text(`「${label}」回复了,但没有可读的文字内容。`)
      }
      case 'suspended':
        return text(`「${label}」需要进一步确认才能回答(可能在等一个审批),先去 /me 看看。`)
      case 'failed':
        return text(`「${label}」没能完成:${result.error}`, true)
      case 'no_participant':
        return text(`「${label}」现在不在线,过会儿再问。`, true)
      case 'cancelled':
        return text(`这次询问被取消了(${result.reason})。`, true)
    }
  }
}

/**
 * Pull an agent's reply text out of a `TaskResult`'s output. Handles the two real
 * shapes — a bare string, or an `{ text }` object (LlmTaskOutput). Returns null
 * for anything opaque so the caller says "no readable text" rather than dumping
 * JSON. (Same two-shape logic as `heartbeatResultText`, kept local so this tool
 * carries no heartbeat coupling.)
 */
function replyText(output: unknown): string | null {
  if (typeof output === 'string') return output.trim() || null
  if (output && typeof output === 'object' && typeof (output as { text?: unknown }).text === 'string') {
    return (output as { text: string }).text.trim() || null
  }
  return null
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] }
}

/**
 * Build the per-user benign "ask my agent" switchboard. Add it to the butler's
 * `benign` set. Offers no tool (invisible) when the roster surface is absent.
 */
export function buildButlerAskAgentToolset(deps: ButlerAskAgentDeps): LlmAgentToolset {
  return new ButlerAskAgentToolset(deps)
}
