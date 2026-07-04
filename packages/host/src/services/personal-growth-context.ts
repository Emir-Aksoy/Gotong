/**
 * `personal-growth-context.ts` — host-side helpers for the
 * `personal-growth-flow` workflow's cross-session memory.
 *
 * # Why this exists
 *
 * The personal-growth workflow is fundamentally a **long-term**
 * conversation: one human runs it now to plan the next 12 weeks,
 * then runs it again 6 weeks later to see "what changed about me?",
 * and again at 12 weeks for the wrap-up. Each run should build on
 * the prior one — the interviewer (step 1) should know "this is your
 * third time, last time you said X, has Y changed?".
 *
 * Gotong's workflow runner doesn't pass any cross-run identity to
 * the agent — every dispatch is a fresh `Task`. So the **caseId**
 * (the per-human identity that ties runs together) lives in the
 * agent's `memory` handle via `meta.caseId`, and the agent recalls
 * + filters it on every step.
 *
 * # caseId choice (v0.3 — multi-user)
 *
 * caseId is **per-coachee**, NOT per-admin. The mapping rule
 * depends on the dispatch surface:
 *
 *   - `/api/me/dispatch` (v4 user-facing) → caseId = userId, forced
 *     server-side. A member cannot read or write another user's
 *     timeline because the route handler stamps caseId itself.
 *   - `/api/admin/dispatch` (owner) → caseId comes from the request
 *     payload's `case_id` field, defaulting to `'self'` if missing.
 *     This lets an owner debug another coachee's timeline by passing
 *     their userId explicitly.
 *
 * Reports are stored under `reports/<caseId>/…` on the synthesist
 * agent's artifact handle, so caseId is also the ACL key for
 * `/api/me/growth-reports*`. The route handler rejects any path
 * whose caseId segment ≠ the caller's userId.
 *
 * Memory isolation: every entry carries `meta.caseId`. Recall
 * filters in memory (`isForCase`) — the file plugin doesn't index on
 * meta so the wide-recall + filter pattern is intentional.
 *
 * # Storage model
 *
 * - Reuses {@link MemoryHandle} (no new service type).
 * - Owner is whatever the LlmAgent's services context resolved to
 *   (typically `{kind:'agent', id: <agent-id>}` — the agent's own
 *   private memory namespace).
 * - `meta.caseId` carries the cross-run identity inside that owner.
 * - `meta.topic` carries the step kind (`portrait`, `body`, `mind`,
 *   `goal`, `resource`, `social`, `synthesis`, or `compacted-summary`).
 * - `kind`: `episodic` for per-step entries, `semantic` for the
 *   compacted-summary that M2 auto-compaction produces.
 *
 * # Auto-compaction (M2 — pending)
 *
 * When recall yields > {@link COMPACT_TRIGGER_ENTRIES} entries or
 * > {@link COMPACT_TRIGGER_BYTES} bytes, the agent SHOULD trigger
 * a compaction pass (LLM summarizes old episodic into one semantic
 * `compacted-summary`, old episodic gets soft-deleted). The helper
 * in this file just exposes the predicate — the actual compaction
 * dispatch lives in `PersonalGrowthAgent.maybeCompact()` because it
 * needs the agent's provider to call the LLM.
 */

import type {
  MemoryEntry,
  MemoryHandle,
  NewMemoryEntry,
} from '@gotong/services-sdk'

/**
 * The seven workflow step kinds + the compacted-summary topic. Used
 * as `meta.topic` so each agent can recall its own per-step history
 * while the synthesist can recall everything.
 */
export type GrowthTopic =
  | 'portrait'
  | 'body'
  | 'mind'
  | 'goal'
  | 'resource'
  | 'social'
  | 'synthesis'
  | 'compacted-summary'

/** Map an agent's capability to the topic it should write under. */
export function topicForCapability(capability: string): GrowthTopic | null {
  switch (capability) {
    case 'user-portrait':
      return 'portrait'
    case 'analyze-body':
      return 'body'
    case 'analyze-mind':
      return 'mind'
    case 'analyze-goal':
      return 'goal'
    case 'analyze-resource':
      return 'resource'
    case 'analyze-social':
      return 'social'
    case 'synthesize-growth-path':
      return 'synthesis'
    default:
      return null
  }
}

/** One stored growth-history entry — a step's output for a given case. */
export interface GrowthHistoryEntry {
  readonly topic: GrowthTopic
  readonly text: string
  /** ISO timestamp. */
  readonly at: string
  /** Memory entry id — needed if a caller wants to forget it. */
  readonly id: string
}

/** Pairs a MemoryHandle with the caseId it's tied to. */
export interface GrowthBinding {
  readonly caseId: string
  readonly memory: MemoryHandle
}

// Meta keys we own.
const META_CASE_ID = 'caseId'
const META_TOPIC = 'topic'
const META_AT = 'at'

// Compaction triggers. Conservative defaults — tune in M2.
export const COMPACT_TRIGGER_ENTRIES = 32
export const COMPACT_TRIGGER_BYTES = 32 * 1024

// ---------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------

/**
 * Persist one step's output. Returns the entry as persisted (id + at).
 *
 * Idempotency: this helper does NOT dedupe. The agent is responsible
 * for not re-writing the same step output if it gets re-dispatched
 * (workflow runners are at-least-once, but in practice the runner
 * runs each step exactly once per `runId`).
 */
export async function recordGrowthOutput(
  binding: GrowthBinding,
  entry: { topic: GrowthTopic; text: string; at?: string },
): Promise<GrowthHistoryEntry> {
  const at = entry.at ?? new Date().toISOString()
  const meta: Record<string, unknown> = {
    [META_CASE_ID]: binding.caseId,
    [META_TOPIC]: entry.topic,
    [META_AT]: at,
  }
  const newEntry: NewMemoryEntry = {
    kind: entry.topic === 'compacted-summary' ? 'semantic' : 'episodic',
    text: entry.text,
    meta,
  }
  const persisted = await binding.memory.remember(newEntry)
  return { topic: entry.topic, text: entry.text, at, id: persisted.id }
}

// ---------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------

/**
 * Pull every growth-history entry for the case, oldest first. Optionally
 * filter by topic(s) so the body coach only reads body history and not
 * the synthesist's full assembly.
 *
 * The MemoryHandle backend doesn't filter on meta, so we pull a wide
 * window and filter in memory. For the typical case (single human,
 * <30 runs over 12 weeks) the window is tiny.
 *
 * `compacted-summary` entries always survive the topic filter — they
 * fold context from all topics into one entry, so a body-coach that
 * recalls only `body` would otherwise lose the body-related history
 * that already got rolled into the summary.
 */
export async function recallGrowthHistory(
  binding: GrowthBinding,
  opts: { topics?: readonly GrowthTopic[]; limit?: number } = {},
): Promise<GrowthHistoryEntry[]> {
  const limit = clamp(opts.limit ?? 50, 1, 200)
  // Pull both episodic (per-step entries) and semantic (compacted-summary).
  // Recall returns newest-first; we re-sort by underlying ts to get a
  // monotonic timeline that survives same-millisecond writes.
  const recent = await binding.memory.recall({
    kinds: ['episodic', 'semantic'],
    k: 200,
  })
  const topics = opts.topics ? new Set(opts.topics) : null
  return recent
    .filter((e) => isForCase(e, binding.caseId))
    .filter((e) => {
      if (!topics) return true
      const t = extractTopic(e)
      // Compacted summaries cross topic boundaries — they need to be
      // visible to every dimension coach, not just to "all topics" callers.
      if (t === 'compacted-summary') return true
      return topics.has(t)
    })
    .sort((a, b) => a.ts - b.ts)
    .map(toGrowthEntry)
    .slice(-limit)
}

/**
 * Predicate: does the current memory state exceed the auto-compaction
 * trigger? Cheap — just runs a recall (which we usually do anyway).
 *
 * Compacted summaries count toward neither the entries nor bytes
 * total because they ARE the compaction; counting them would
 * cause re-compaction storms.
 */
export async function shouldCompact(
  binding: GrowthBinding,
): Promise<boolean> {
  const recent = await binding.memory.recall({ kinds: ['episodic'], k: 200 })
  const ours = recent.filter((e) => isForCase(e, binding.caseId))
  if (ours.length >= COMPACT_TRIGGER_ENTRIES) return true
  const bytes = ours.reduce((sum, e) => sum + e.text.length, 0)
  return bytes >= COMPACT_TRIGGER_BYTES
}

// ---------------------------------------------------------------------
// Compaction (M2)
// ---------------------------------------------------------------------

/**
 * How many of the most recent episodic entries to leave uncompacted.
 * Anything older than these gets folded into the new summary.
 *
 * 8 is "roughly one full pass through the 7-step workflow plus a
 * little headroom" — recent runs stay verbatim because the agent
 * benefits more from the original wording in their recent context
 * than from a summary of them.
 */
export const COMPACT_KEEP_RECENT = 8

/** System prompt for the in-agent summarizer call. */
export const COMPACTION_SYSTEM_PROMPT = `你是个人成长工作流的"记忆压缩师"。

你的任务: 把这位用户过去与各位成长教练 (访谈员 / 身体 / 心理 / 目标 / 资源 / 社会关系 / 综合) 的对话历史浓缩成一段中文摘要 (≤ 500 字), 让未来的教练能快速恢复"这是谁、之前聊到哪一步、有什么贯穿的主题"。

写作要求:
1. 按六个维度 + 综合 组织 (身体 / 心理 / 目标 / 资源 / 社会关系 / 综合)。每个维度 1-3 行, 没材料的维度直接省略。
2. 优先保留: 反复出现的主题、用户做出的决定、给出的承诺、关键判断、被点名的人、具体的数字 / 日期 / 地名。
3. 删掉: 一次性的细节、教练的客套话、已经被后来对话推翻或废弃的早期判断、模板性的列表。
4. 用"用户"指代主体, 不用"你"。
5. 如果存在更早的压缩摘要 (会标在输入里), 把它当作"更早的背景", 用一句话继承核心、再并入新对话里增量的信息 — 不要逐条复读旧摘要。

输出: 直接是中文摘要本体, 不要前言/解释/客套话。开头用"## 已经过去的对话浓缩 (截至 <日期>)"作为标题。`

/** Result of a successful compaction pass. */
export interface MaybeCompactResult {
  /** Number of episodic entries that were folded into the new summary. */
  readonly compactedCount: number
  /** Number of prior `compacted-summary` entries that were absorbed. */
  readonly absorbedSummaries: number
  /** The newly-written summary entry. */
  readonly summaryEntry: GrowthHistoryEntry
}

/**
 * Caller-supplied LLM summarizer. The compactor passes a `system` +
 * `user` prompt and expects the raw text back. This keeps
 * `personal-growth-context.ts` free of any `@gotong/llm` import —
 * the agent decides which provider + model + temperature to use.
 */
export type GrowthSummarizer = (input: {
  readonly system: string
  readonly user: string
}) => Promise<string>

export interface MaybeCompactOpts {
  /** Override how many recent episodic entries stay verbatim. */
  readonly keepRecent?: number
  /** Hook for tests — skips the LLM trigger check. */
  readonly force?: boolean
}

/**
 * Run the compaction pass when {@link shouldCompact} says we should
 * (or when `opts.force` is set). Strategy:
 *
 *   1. Pull every episodic entry for this case, sorted oldest-first.
 *   2. Slice off the most recent `keepRecent` — they stay as-is.
 *   3. Pull every prior `compacted-summary` (semantic) so we can fold
 *      them into the new one. We treat them as "earlier background"
 *      so a multi-round timeline doesn't snowball.
 *   4. Call the summarizer with the two slices.
 *   5. Persist the new summary as `kind:semantic, topic:compacted-summary`.
 *      Done BEFORE deletes so a crash leaves us with both copies (a
 *      duplicate) rather than nothing.
 *   6. Forget the absorbed entries (old episodic + old summaries).
 *      The file plugin moves them to the 30-day trash bucket, not
 *      hard-delete, so an operator can restore.
 *
 * Returns `null` when nothing was done (under threshold, or fewer than
 * `keepRecent + 1` entries). Throws if the summarizer throws — the
 * caller is expected to catch and log non-fatally so an LLM hiccup
 * doesn't block the actual workflow step.
 */
export async function maybeCompactMemory(
  binding: GrowthBinding,
  summarize: GrowthSummarizer,
  opts: MaybeCompactOpts = {},
): Promise<MaybeCompactResult | null> {
  if (!opts.force && !(await shouldCompact(binding))) return null
  const keepRecent = clamp(opts.keepRecent ?? COMPACT_KEEP_RECENT, 1, 200)

  const allEpisodic = await binding.memory.recall({ kinds: ['episodic'], k: 200 })
  const ours = allEpisodic
    .filter((e) => isForCase(e, binding.caseId))
    .sort((a, b) => a.ts - b.ts)

  // Not enough entries to be worth compacting yet — defensive: should
  // not happen because shouldCompact requires ≥ 32, but `force:true`
  // (or a future lowered threshold) might land us here.
  if (ours.length <= keepRecent) return null

  const toCompact = ours.slice(0, ours.length - keepRecent)
  const keptCount = keepRecent

  // Pull existing compacted summaries — fold them in so a third / fourth
  // pass doesn't lose what the first pass already squeezed out.
  const allSemantic = await binding.memory.recall({ kinds: ['semantic'], k: 50 })
  const priorSummaries = allSemantic
    .filter((e) => isForCase(e, binding.caseId))
    .filter((e) => extractTopic(e) === 'compacted-summary')
    .sort((a, b) => a.ts - b.ts)

  const userPrompt = buildCompactionUserPrompt({
    priorSummaries: priorSummaries.map(toGrowthEntry),
    toCompact: toCompact.map(toGrowthEntry),
    keptCount,
  })

  const summaryText = (
    await summarize({ system: COMPACTION_SYSTEM_PROMPT, user: userPrompt })
  ).trim()

  if (!summaryText) {
    // Empty model output — better to abort than to write a useless
    // summary that the next compaction would have to absorb again.
    throw new Error('compaction: summarizer returned empty text')
  }

  // Write new BEFORE deleting old, so an interrupted run leaves
  // *more* data rather than less.
  const summaryEntry = await recordGrowthOutput(binding, {
    topic: 'compacted-summary',
    text: summaryText,
  })

  let compactedCount = 0
  for (const e of toCompact) {
    try {
      await binding.memory.forget(e.id)
      compactedCount++
    } catch {
      // Tolerate a single failed forget — the new summary already
      // covers this entry, and the file plugin's idempotent retry on
      // next pass will pick the straggler up.
    }
  }
  let absorbedSummaries = 0
  for (const s of priorSummaries) {
    try {
      await binding.memory.forget(s.id)
      absorbedSummaries++
    } catch {
      // ditto
    }
  }

  return { compactedCount, absorbedSummaries, summaryEntry }
}

/**
 * Build the user-prompt half of the compaction call. Format chosen so
 * the model sees a clear "older background → new entries → take it
 * away" structure without needing extra instructions in the system
 * prompt.
 */
function buildCompactionUserPrompt(args: {
  priorSummaries: ReadonlyArray<GrowthHistoryEntry>
  toCompact: ReadonlyArray<GrowthHistoryEntry>
  keptCount: number
}): string {
  const parts: string[] = []
  if (args.priorSummaries.length > 0) {
    parts.push('【更早的背景 (旧的压缩摘要,请在新摘要里继承核心、并入新对话的增量信息)】')
    for (const s of args.priorSummaries) {
      parts.push(s.text)
      parts.push('')
    }
    parts.push('---')
    parts.push('')
  }

  parts.push(`【新增 ${args.toCompact.length} 条对话历史 (oldest first)】`)
  for (const e of args.toCompact) {
    parts.push(`### [${e.topic}] ${e.at}`)
    parts.push(e.text)
    parts.push('')
  }

  parts.push(
    `【最近 ${args.keptCount} 条对话以原文继续陪伴用户, 你不需要处理它们 — 把它们留给当下的教练。】`,
  )
  parts.push('')
  parts.push(`请输出 ≤ 500 字的中文摘要 (按系统提示里的写作要求)。当前日期: ${new Date().toISOString().slice(0, 10)}.`)
  return parts.join('\n')
}

// ---------------------------------------------------------------------
// Format for prompt injection
// ---------------------------------------------------------------------

export interface FormatGrowthContextOpts {
  history: readonly GrowthHistoryEntry[]
  /** Prefix line above the block. Default tuned for Chinese prompts. */
  header?: string
  /** Per-entry truncation (chars). Default 400. */
  truncate?: number
}

/**
 * Render the growth history as a markdown block ready to be prepended
 * to an LLM prompt. Empty input → empty string (caller can no-op
 * without an `if`). Designed to be **bounded in tokens**: each entry
 * is truncated to `opts.truncate` chars so a long-running case doesn't
 * blow up the prompt.
 *
 * Compacted-summary entries are surfaced verbatim (no truncate) and
 * called out as the "compacted past"; they typically replace many
 * truncated episodic entries.
 */
export function formatGrowthContextBlock(opts: FormatGrowthContextOpts): string {
  if (opts.history.length === 0) return ''
  const truncate = opts.truncate ?? 400
  const header = opts.header ?? '## 你之前跑这条工作流时,我们聊到的'
  const lines: string[] = []

  const compacted = opts.history.filter((e) => e.topic === 'compacted-summary')
  const perStep = opts.history.filter((e) => e.topic !== 'compacted-summary')

  if (compacted.length > 0) {
    lines.push('【更早之前的摘要 / compacted summary】')
    for (const c of compacted) {
      lines.push(c.text)
      lines.push('')
    }
  }

  if (perStep.length > 0) {
    lines.push('【最近的逐步产物 / recent step outputs (oldest first)】')
    for (const e of perStep) {
      const head = `### [${e.topic}] (${e.at})`
      const body = e.text.length > truncate
        ? e.text.slice(0, truncate - 1) + '…'
        : e.text
      lines.push(head)
      lines.push(body)
      lines.push('')
    }
  }

  return [header, '', ...lines].join('\n')
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

function isForCase(e: MemoryEntry, caseId: string): boolean {
  const m = e.meta as Record<string, unknown> | undefined
  return !!m && m[META_CASE_ID] === caseId
}

function extractTopic(e: MemoryEntry): GrowthTopic {
  const m = (e.meta ?? {}) as Record<string, unknown>
  const t = m[META_TOPIC]
  if (
    t === 'portrait' || t === 'body' || t === 'mind' || t === 'goal'
    || t === 'resource' || t === 'social' || t === 'synthesis'
    || t === 'compacted-summary'
  ) {
    return t
  }
  // Defensive: a foreign entry slipped into our owner. Tag it so the
  // formatter can still surface it without crashing.
  return 'portrait'
}

function toGrowthEntry(e: MemoryEntry): GrowthHistoryEntry {
  const m = (e.meta ?? {}) as Record<string, unknown>
  const at = typeof m[META_AT] === 'string'
    ? (m[META_AT] as string)
    : new Date(e.ts).toISOString()
  return { topic: extractTopic(e), text: e.text, at, id: e.id }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
