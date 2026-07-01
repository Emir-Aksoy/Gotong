/**
 * personal-butler-consolidate.ts — the resident butler's BENIGN "整理一下记忆"
 * tool (Stream-2 S2-M2).
 *
 * BF-M8 runs the memory 蒸馏 (episodic → curated per-cluster profile) + STATUS.md
 * upkeep on a 6h BACKGROUND sweep. That makes consolidation invisible until a tick
 * fires — a member (or an operator smoke-testing the bot) can't SEE distillation
 * happen. This exposes the SAME per-member maintenance pass as a tool the butler
 * can run on demand: a member says "整理一下记忆" / "把我们聊过的复盘一下" and the
 * butler distils their captures right now.
 *
 * ── Why benign (inline, not governed) ────────────────────────────────────────
 * Consolidating a member's OWN memory is a self-service action: it's byte-for-byte
 * the same pass the 6h sweep already runs unattended, folding their episodic into
 * the durable semantic profile they can already read / erase from the `/me`
 * privacy view. It changes nothing outside this member's own namespace, so it
 * needs no approval park. It DOES cost one LLM call — on the butler's OWN model
 * (`buildProvider`, the same provider the BF-M8 sweep uses), billed to the same
 * place — so a null provider (no key yet) is an honest, non-throwing refusal.
 *
 * Host-only: it binds `buildProvider` (the butler's model) to
 * `runButlerMaintenanceOnce` (the shared one-member pass). Per-user — the router
 * builds one per `origin.userId`, scoped to that member's namespace.
 */

import type { Logger } from '@aipehub/core'
import type {
  LlmAgentToolset,
  LlmProvider,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@aipehub/llm'

import { butlerSummarizer, runButlerMaintenanceOnce } from './personal-butler-maintenance.js'

export interface ButlerConsolidateDeps {
  /** The member this butler serves — the namespace this pass maintains. */
  userId: string
  /** Butler memory root (`<space>/butler/memory`) — the tree the factory + /me use. */
  rootDir: string
  /**
   * Resolve the distillation provider (the butler's own model), usually
   * `() => pool.buildButlerProvider()`. Resolved on each call so a key added after
   * boot is picked up; a null result is a friendly refusal, not a crash.
   */
  buildProvider: () => Promise<LlmProvider | null>
  logger: Logger
  /** Per-request model / token overrides for the distillation call. */
  model?: string
  maxTokens?: number
}

const CONSOLIDATE_TOOL: LlmToolDefinition = {
  name: 'consolidate_my_memory',
  description:
    '整理这个成员的长期记忆:把最近记下的零散片段蒸馏进按主题分卷的策展画像,并更新维护状态(STATUS.md)。当成员说"整理一下记忆 / 把我们聊过的复盘一下 / 归纳一下你记住的东西"时用它。这是对成员自己记忆的自助操作,直接执行,不需要审批。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

class ButlerConsolidateToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerConsolidateDeps) {}

  listTools(): LlmToolDefinition[] {
    return [CONSOLIDATE_TOOL]
  }

  async callTool(name: string, _args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (name !== 'consolidate_my_memory') return text(`未知工具:${name}`, true)

    let provider: LlmProvider | null
    try {
      provider = await this.deps.buildProvider()
    } catch (err) {
      this.deps.logger.error('butler consolidate: provider build failed', {
        err: err instanceof Error ? err.message : String(err),
      })
      provider = null
    }
    if (!provider) {
      // No resolvable model — honest refusal, same no-op posture as the sweep's
      // null-provider tick, but surfaced to the member rather than silently skipped.
      return text('现在没法整理记忆(还没有可用的模型)。等配好模型再让我整理。', true)
    }

    const summarize = butlerSummarizer(provider, {
      ...(this.deps.model ? { model: this.deps.model } : {}),
      ...(this.deps.maxTokens !== undefined ? { maxTokens: this.deps.maxTokens } : {}),
    })
    try {
      const summary = await runButlerMaintenanceOnce({
        rootDir: this.deps.rootDir,
        userId: this.deps.userId,
        summarize,
        logger: this.deps.logger,
      })
      const detail = summary.trim()
      return text(detail ? `记忆整理好了。\n${detail}` : '记忆整理好了,暂时没有需要合并的新内容。')
    } catch (err) {
      this.deps.logger.error('butler consolidate: maintenance pass failed', {
        userId: this.deps.userId,
        err: err instanceof Error ? err.message : String(err),
      })
      return text(`整理记忆时出错了:${err instanceof Error ? err.message : String(err)}`, true)
    }
  }
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError
    ? { content: [{ type: 'text', text: t }], isError: true }
    : { content: [{ type: 'text', text: t }] }
}

/**
 * Build the per-user benign "整理记忆" toolset for a resident butler.
 * Add it to `PersonalButlerAgent({ benign })`.
 */
export function buildButlerConsolidateToolset(deps: ButlerConsolidateDeps): LlmAgentToolset {
  return new ButlerConsolidateToolset(deps)
}
