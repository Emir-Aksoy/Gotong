/**
 * personal-butler-profile.ts — the resident butler's BENIGN "你记得我什么" tool
 * (S2-M1).
 *
 * A member asks their butler "你记得我什么?" over IM. Without this tool the
 * model improvises from the frozen block — budget-capped, interleaved, and
 * impossible to audit against what the hub actually stores. This tool answers
 * from the SAME `HostButlerMemoryService.read()` that backs the `/me`「管家记
 * 得你什么」privacy panel, so what the butler SAYS it remembers and what the
 * member can SEE / erase are one source of truth (M6c's 同源 discipline,
 * extended to IM).
 *
 * One benign tool (reading your own memory has no consequence — it runs inline
 * in the butler's loop, never parks):
 *
 *   - `show_my_memory` — the structured snapshot: 画像 (curated semantic
 *     profile, grouped by its ③-tier cluster), 会做的事 (G-form procedures),
 *     最近聊到 (recent episodic captures), plus the /me pointer for the right
 *     to be forgotten. Rendered HERE (deterministic, testable) — the model is
 *     told to relay the list, not to invent one.
 *
 * ── The security invariant, mirrored from the sibling toolsets ───────────────
 * The read is scoped by the `userId` the host forces at construction — never a
 * model arg — so the butler can only ever show the member it serves their OWN
 * memory (the per-user namespace is the no-leak boundary).
 */

import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@aipehub/llm'
import { DEFAULT_TIERS } from '@aipehub/personal-memory'
import type { WebServerOptions } from '@aipehub/web'

// Derive the snapshot contract from the web surface — the SAME projection the
// /me privacy panel renders (same pattern as HostButlerMemoryService itself).
type ButlerMemorySurface = NonNullable<WebServerOptions['butlerMemory']>
type ButlerMemorySnapshot = Awaited<ReturnType<ButlerMemorySurface['read']>>
type ButlerMemoryView = ButlerMemorySnapshot['profile'][number]

export interface ButlerProfileDeps {
  /** The member this butler serves — every read is scoped to their namespace. */
  userId: string
  /** The service that backs `/api/me/butler/memory` — one source of truth. */
  view: Pick<ButlerMemorySurface, 'read'>
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void }
}

/** IM messages must stay skimmable — cap lines per section, honestly counted. */
const PROFILE_LINE_LIMIT = 12
const PROCEDURE_LINE_LIMIT = 5
const RECENT_LINE_LIMIT = 6
/** One fact per line — clip runaway captures, keep the line readable. */
const LINE_CLIP = 120

const PROFILE_TOOLS: LlmToolDefinition[] = [
  {
    name: 'show_my_memory',
    description:
      '用户问"你记得我什么 / 你都知道我什么 / 你的记忆里有我什么"这类问题时调用。' +
      '返回管家长期记忆的结构化清单(画像、会做的事、最近聊到),与网页 /me「管家记得你什么」同源。' +
      '把清单内容如实转述给用户——不要编造、不要遗漏条目;结尾保留去 /me 面板删除记忆的提示。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

class ButlerProfileToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerProfileDeps) {}

  listTools(): LlmToolDefinition[] {
    return PROFILE_TOOLS
  }

  async callTool(name: string): Promise<LlmToolCallResult> {
    if (name !== 'show_my_memory') return text(`未知工具:${name}`, true)
    let snap: ButlerMemorySnapshot
    try {
      snap = await this.deps.view.read(this.deps.userId)
    } catch (err) {
      this.deps.logger?.error('butler profile: memory read failed', { err })
      return text('没能读取记忆,待会儿再试一次吧。', true)
    }
    return text(renderButlerMemorySnapshot(snap))
  }
}

/**
 * Render the /me snapshot as a structured, skimmable IM answer. Exported for
 * deterministic tests. Sections:
 *   画像     — curated semantic facts, grouped by ③-tier cluster (catalog order,
 *              unknown tiers fold into the default cluster's label);
 *   会做的事 — G-form procedures (name line only — steps stay in /me);
 *   最近聊到 — recent episodic captures.
 * Suffix tags keep honesty cheap: (重要) for importance ≥ 4, (已失效) for a
 * closed bitemporal fact. Overflow is counted, never silently dropped.
 */
export function renderButlerMemorySnapshot(snap: ButlerMemorySnapshot): string {
  const procedures = snap.profile.filter((e) => e.form === 'procedure')
  const facts = snap.profile.filter((e) => e.form !== 'procedure')

  if (facts.length === 0 && procedures.length === 0 && snap.recent.length === 0) {
    return '我还没有存下关于你的长期记忆。多跟我聊聊,重要的事我会记住。'
  }

  const lines: string[] = [`【管家记忆】画像 ${snap.profile.length} 条 · 最近 ${snap.recent.length} 条`]

  if (facts.length > 0) {
    lines.push('■ 画像(长期)')
    // Group by tier in catalog order; entries keep their recall order within a
    // group. An entry with no / unknown tier folds into the default cluster.
    const labelOf = new Map(DEFAULT_TIERS.tiers.map((t) => [t.id, t.label]))
    const fallback = DEFAULT_TIERS.defaultTier
    const grouped = new Map<string, ButlerMemoryView[]>()
    for (const e of facts) {
      const tier = e.tier && labelOf.has(e.tier) ? e.tier : fallback
      const bucket = grouped.get(tier)
      if (bucket) bucket.push(e)
      else grouped.set(tier, [e])
    }
    let shown = 0
    for (const tier of DEFAULT_TIERS.tiers) {
      const bucket = grouped.get(tier.id)
      if (!bucket) continue
      for (const e of bucket) {
        if (shown >= PROFILE_LINE_LIMIT) break
        lines.push(`- [${tier.label}] ${entryLine(e)}`)
        shown++
      }
    }
    if (facts.length > shown) lines.push(`……另有 ${facts.length - shown} 条画像。`)
  }

  if (procedures.length > 0) {
    lines.push('■ 会做的事')
    for (const e of procedures.slice(0, PROCEDURE_LINE_LIMIT)) {
      lines.push(`- ${entryLine(e)}`)
    }
    if (procedures.length > PROCEDURE_LINE_LIMIT) {
      lines.push(`……另有 ${procedures.length - PROCEDURE_LINE_LIMIT} 条。`)
    }
  }

  if (snap.recent.length > 0) {
    lines.push('■ 最近聊到')
    for (const e of snap.recent.slice(0, RECENT_LINE_LIMIT)) {
      lines.push(`- ${entryLine(e)}`)
    }
    if (snap.recent.length > RECENT_LINE_LIMIT) {
      lines.push(`……另有 ${snap.recent.length - RECENT_LINE_LIMIT} 条。`)
    }
  }

  lines.push('想看全部、逐条删除或全部清空:网页 /me 的「管家记得你什么」面板。')
  return lines.join('\n')
}

function entryLine(e: ButlerMemoryView): string {
  const t = e.text.length > LINE_CLIP ? e.text.slice(0, LINE_CLIP - 1) + '…' : e.text
  const tags = `${(e.importance ?? 3) >= 4 ? '(重要)' : ''}${e.active === false ? '(已失效)' : ''}`
  return `${t}${tags}`
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] }
}

/**
 * Build the per-user benign "你记得我什么" toolset for a resident butler. Add it
 * to `PersonalButlerAgent({ benign })`.
 */
export function buildButlerProfileToolset(deps: ButlerProfileDeps): LlmAgentToolset {
  return new ButlerProfileToolset(deps)
}
