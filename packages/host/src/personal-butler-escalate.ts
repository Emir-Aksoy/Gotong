/**
 * personal-butler-escalate.ts — DUO-M2. The reception brain's BENIGN
 * fire-and-forget "转派专家" doorway.
 *
 * The dual-brain shape (docs/zh/ATONG-DUAL-BRAIN.md): the butler runs on a
 * light, cheap reception model; when the member's ask is heavy, the MODEL
 * decides to hand it to the owner-configured expert agent and keeps the turn
 * short — the member gets an immediate receipt, and the expert's result is
 * pushed back to the same chat window later as a second message. The framework
 * only provides the deterministic pipe (explicit dispatch + push-back); it
 * never judges "is this heavy" itself (north-star rule 1).
 *
 * ── Why benign / inline (not governed) ───────────────────────────────────────
 * Same argument as `ask_my_agent`: dispatching to an agent the member OWNS is
 * member self-service — it spends the owner's own key, stays inside the hub,
 * and any consequential action the EXPERT attempts gates downstream through
 * that agent's own machinery. The only new ingredient vs ask_my_agent is
 * asynchrony, which changes delivery, not authority.
 *
 * ── The two gates ────────────────────────────────────────────────────────────
 * 1. The target is OWNER-CONFIGURED (`spec.escalateTo`), not model-supplied —
 *    the model's entire decision surface is "escalate or not"; where it goes
 *    is pinned by a human. (The tool takes no target argument at all.)
 * 2. Call-time roster check, fail-closed: the configured target must be an
 *    agent THIS member owns (`listOwned(userId)`), the same no-leak gate as
 *    ask_my_agent. A stale/foreign id refuses loudly, pointing at the config.
 *
 * ── Fire-and-forget discipline (workflow-schedule-sweeper precedent) ─────────
 * `void dispatch(...).then(deliver, deliverFailure)` — never awaited (the
 * reception turn must end fast; IM has no mid-turn streaming), `.then`'s
 * rejection arm prevents unhandledRejection. The result ALWAYS lands in the
 * transcript regardless of push: push-back is best-effort delivery, not the
 * system of record. A member without an IM binding (web-only) reads it in /me
 * — the honest asymmetry DUO-M0 accepted.
 */

import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@gotong/llm'
import type { ButlerAskDispatch, ButlerAskRosterSource } from './personal-butler-ask-agent.js'

/**
 * Best-effort member push (IM bridges' `pushToMember`, injected lazily by
 * main.ts). Absent = web-only deployment: results stay in transcript / /me.
 */
export type ButlerEscalatePush = (userId: string, text: string) => Promise<unknown> | unknown

export interface ButlerEscalateDeps {
  /** The member this butler serves — dispatch is scoped to and attributed to them. */
  userId: string
  /** The owner-configured expert agent id (`spec.escalateTo`) — never model-supplied. */
  escalateTo: string
  /** Same owned-agent lister as ask_my_agent — the no-leak gate. */
  roster: ButlerAskRosterSource
  hub: ButlerAskDispatch
  push?: ButlerEscalatePush
  logger?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void
    error: (msg: string, meta?: Record<string, unknown>) => void
  }
}

const ESCALATE_TOOL: LlmToolDefinition = {
  name: 'escalate_to_expert',
  description:
    '把一件重活转派给专家助手在后台处理;结果出来会自动发回给成员,不占当前对话。调用本工具**之前**,先用一两句话回复成员:你收到了、已安排专家处理、大概什么时候有结果。task_summary 必须自包含 —— 专家看不到你们的对话,把背景、具体要求、期望产出都写进去。小事别转派,自己直接答更快。',
  inputSchema: {
    type: 'object',
    properties: {
      task_summary: {
        type: 'string',
        description: '交给专家的完整任务描述(自包含:背景 + 要求 + 期望产出)。',
      },
    },
    required: ['task_summary'],
    additionalProperties: false,
  },
}

class ButlerEscalateToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerEscalateDeps) {}

  listTools(): LlmToolDefinition[] {
    return [ESCALATE_TOOL]
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (name !== 'escalate_to_expert') return text(`未知工具:${name}`, true)
    const { roster, hub, userId, escalateTo } = this.deps

    const summary = typeof args.task_summary === 'string' ? args.task_summary.trim() : ''
    if (!summary) return text('没说要转派什么(缺 task_summary)。把任务写清楚再转。', true)

    // ── fail-closed: the configured target must be one this member owns ───────
    let label: string
    try {
      const owned = await roster.listOwned(userId)
      const target = owned.find((a) => a.id === escalateTo)
      if (!target) {
        return text(
          `配置的专家「${escalateTo}」不在这位成员名下,我不能转派。请管理员检查这个助手的 escalateTo 配置。这件事我先自己处理或告诉成员暂时办不了。`,
          true,
        )
      }
      label = target.label ?? target.id
    } catch (err) {
      this.deps.logger?.error('butler escalate: listOwned failed', { err })
      return text('暂时读不到助手列表,没法转派。稍后再试,或先自己回答。', true)
    }

    // ── fire-and-forget: dispatch now, deliver later, return the receipt ──────
    void hub
      .dispatch({
        from: userId,
        origin: { orgId: 'local', userId },
        strategy: { kind: 'explicit', to: escalateTo },
        payload: summary,
        title: `转派专家「${label}」— ${userId}`,
      })
      .then(
        (result) => this.deliver(label, result),
        (err) => {
          // dispatch itself threw (pre-flight failure) — never silent.
          this.deps.logger?.error('butler escalate: dispatch failed', { err, escalateTo })
          return this.pushSafe(
            `刚才转派给「${label}」的事没能启动(派发失败),需要的话换个说法再交给我一次。`,
          )
        },
      )

    return text(
      `已转派给「${label}」,在后台处理中;结果出来我会单独发给成员。现在简短告诉成员你安排了什么就行,别再重复任务内容。`,
    )
  }

  /** Map the expert's TaskResult to an honest push-back line (kind-by-kind). */
  private async deliver(
    label: string,
    result: { kind: string; output?: unknown; error?: string; reason?: string },
  ): Promise<void> {
    switch (result.kind) {
      case 'ok': {
        const reply = replyText(result.output)
        await this.pushSafe(
          reply
            ? `「${label}」办完了你转派的事:\n${reply}`
            : `「${label}」办完了你转派的事,但没有可读的文字结果。`,
        )
        return
      }
      case 'suspended':
        await this.pushSafe(`「${label}」做你转派的事做到一半,需要你进一步确认(可能在等审批),去 /me 看看。`)
        return
      case 'failed':
        await this.pushSafe(`「${label}」没能完成你转派的事:${result.error ?? '未知错误'}。要不换个说法再试?`)
        return
      case 'no_participant':
        await this.pushSafe(`「${label}」现在不在线,你转派的事没能开始。过会儿再交给我一次。`)
        return
      case 'cancelled':
        await this.pushSafe(`你转派给「${label}」的事被取消了(${result.reason ?? '未知原因'})。`)
        return
    }
  }

  /**
   * Best-effort push. No push handle (web-only) → the result already lives in
   * the transcript / /me, so silence here is honest, not lossy. A throwing
   * push logs once and never retries — the IM outbox owns redelivery.
   */
  private async pushSafe(msg: string): Promise<void> {
    const { push, userId } = this.deps
    if (!push) return
    try {
      await push(userId, msg)
    } catch (err) {
      this.deps.logger?.warn('butler escalate: push-back failed (result remains in transcript)', {
        err,
        userId,
      })
    }
  }
}

/** Same two-shape reply extraction as ask_my_agent (string | { text }). */
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
 * Build the per-user benign escalate doorway. Only constructed when the row
 * declares `escalateTo` AND the owned-agent roster is wired — unset config
 * means this file is never even reached (byte-identical tool face).
 */
export function buildButlerEscalateToolset(deps: ButlerEscalateDeps): LlmAgentToolset {
  return new ButlerEscalateToolset(deps)
}
