/**
 * `case-context.ts` — host-side helpers for storing and recalling a
 * **case's** conversation timeline + step outputs in a shared memory
 * handle.
 *
 * # Why this exists
 *
 * A "case" is the unit of an end-to-end consultation: one customer's
 * intake → research → draft → review → finalize trip through a
 * workflow. Two needs naturally arise:
 *
 *   1. **The user wants to interject mid-flow** — e.g. between draft
 *      and review they want to ask the coach "what about a vegetarian
 *      menu angle?". That side-conversation is **not** a workflow step
 *      and must NOT be hard-wired into the YAML; it's cross-cutting.
 *   2. **Downstream agents need to see prior conversation** — when the
 *      finalize step runs, the coach should know what the user asked
 *      between draft and review, not just see `draft.output` blind.
 *
 * Both needs collapse into one storage primitive: an append-only log of
 * "things that happened during this case", tagged so each consumer can
 * filter to what it needs.
 *
 * # Storage model
 *
 * - **No new service type.** We reuse {@link MemoryHandle} (kind=`episodic`).
 * - **Owner = `{kind:'workflow-run', id: caseId}`.** Each case has one
 *   memory owner — all agents working on the case attach to (or are
 *   handed a handle for) the same owner so they share a view.
 * - **Topic is meta-encoded.** Entries set `meta.caseId`, `meta.topic`
 *   (`'conversation'` or `'step-output'`), `meta.source` (who spoke /
 *   produced it), and optionally `meta.stepId`. The {@link MemoryHandle}
 *   API doesn't filter on meta, so filtering happens in this helper.
 *
 * # Why meta instead of a per-case owner
 *
 * Owner `{kind:'workflow-run', id: caseId}` *is* per-case. The meta tags
 * exist for **filtering within** that owner: "give me only conversation
 * entries", or "only step outputs", or "only entries from step=draft".
 * If we put each topic in a different owner we'd lose the ability to
 * recall the full case timeline in one read.
 *
 * # Performance posture (MVP)
 *
 * - `recall*` calls `memory.recall({k: 200})` and then filters by
 *   `meta.caseId`. The file backend reads jsonl from disk; cases
 *   typically have <1000 entries so this is fine.
 * - Future {@link MemoryHandle} backends (vector / sqlite) MAY accept
 *   a `meta` filter natively — when they land, this helper switches
 *   over without callers noticing.
 *
 * # Not in scope
 *
 * - Streaming / change events. The case-manager agent reads on each turn.
 * - Vector recall. The conversation log is small and chronological;
 *   substring + slice is enough.
 * - Cross-case search. A case is an island; talk-between-cases is what
 *   the `industry-research` datastore is for, not this helper.
 */

import type {
  MemoryEntry,
  MemoryHandle,
  NewMemoryEntry,
} from '@aipehub/services-sdk'

/** Who wrote a conversation entry. Open-ended on purpose — extra
 * roles (e.g. 'observer', 'qa') can land later without touching the
 * helper. */
export type CaseConversationSource =
  | 'user'
  | 'manager'
  | 'coach'
  | 'analyst'
  | 'reviewer'
  | 'system'

/** One entry in the case's append-only conversation log. */
export interface CaseConversationEntry {
  /** Who said it. */
  readonly source: CaseConversationSource
  /** Verbatim utterance. */
  readonly text: string
  /** If the turn happened during a specific workflow step, which one. */
  readonly stepId?: string
  /** ISO timestamp the helper wrote with. Older entries first when read. */
  readonly at: string
  /** memory entry id — useful for `forget`. */
  readonly id: string
}

/** Step output cached against the case so later steps / the manager
 * can recall it without re-running the workflow. */
export interface CaseStepOutputEntry {
  readonly stepId: string
  /** The step's output, stringified to text. Free-form. */
  readonly text: string
  readonly at: string
  readonly id: string
}

/** Pairs a {@link MemoryHandle} with the `caseId` it's logically tied
 * to. Helpers take this everywhere so callers don't have to keep
 * passing both. */
export interface CaseContextBinding {
  readonly caseId: string
  readonly memory: MemoryHandle
}

/** Meta keys we own. Anything else in `meta` is passed through. */
const META_CASE_ID = 'caseId'
const META_TOPIC = 'topic'
const META_SOURCE = 'source'
const META_STEP_ID = 'stepId'
const META_AT = 'at'

const TOPIC_CONVERSATION = 'conversation'
const TOPIC_STEP_OUTPUT = 'step-output'

// ---------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------

/**
 * Record one conversation turn. Returns the entry as persisted (id +
 * resolved `at`). Idempotent on retries only if the caller supplied
 * `entry.id` via raw memory; this helper does not dedupe.
 */
export async function recordCaseConversation(
  binding: CaseContextBinding,
  entry: Omit<CaseConversationEntry, 'at' | 'id'> & { at?: string },
): Promise<CaseConversationEntry> {
  const at = entry.at ?? new Date().toISOString()
  const meta: Record<string, unknown> = {
    [META_CASE_ID]: binding.caseId,
    [META_TOPIC]: TOPIC_CONVERSATION,
    [META_SOURCE]: entry.source,
    [META_AT]: at,
  }
  if (entry.stepId) meta[META_STEP_ID] = entry.stepId

  const newEntry: NewMemoryEntry = {
    kind: 'episodic',
    text: entry.text,
    meta,
  }
  const persisted = await binding.memory.remember(newEntry)
  return {
    source: entry.source,
    text: entry.text,
    at,
    id: persisted.id,
    ...(entry.stepId ? { stepId: entry.stepId } : {}),
  }
}

/**
 * Cache one step's output against the case. Subsequent steps and the
 * case-manager can recall it without re-running the dispatch.
 */
export async function recordCaseStepOutput(
  binding: CaseContextBinding,
  entry: Omit<CaseStepOutputEntry, 'at' | 'id'> & { at?: string },
): Promise<CaseStepOutputEntry> {
  const at = entry.at ?? new Date().toISOString()
  const meta: Record<string, unknown> = {
    [META_CASE_ID]: binding.caseId,
    [META_TOPIC]: TOPIC_STEP_OUTPUT,
    [META_STEP_ID]: entry.stepId,
    [META_AT]: at,
  }
  const newEntry: NewMemoryEntry = {
    kind: 'episodic',
    text: entry.text,
    meta,
  }
  const persisted = await binding.memory.remember(newEntry)
  return {
    stepId: entry.stepId,
    text: entry.text,
    at,
    id: persisted.id,
  }
}

// ---------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------

/**
 * Pull every conversation entry for the case, oldest first (matches
 * how readers want to format chat history). `opts.limit` caps the
 * result; default is 100 which covers most cases without truncation.
 *
 * Filtering happens here — the file-backed `MemoryHandle` doesn't
 * support meta queries.
 */
export async function recallCaseConversation(
  binding: CaseContextBinding,
  opts: { limit?: number } = {},
): Promise<CaseConversationEntry[]> {
  const limit = clamp(opts.limit ?? 100, 1, 200)
  // `recall` returns newest-first; we ask for the cap and then re-sort
  // by the underlying entry's `ts` (which the plugin assigns monotonically
  // — sorting by the helper-written ISO `at` would tie when two records
  // land in the same millisecond and silently keep them newest-first).
  const recent = await binding.memory.recall({ kinds: ['episodic'], k: 200 })
  return recent
    .filter((e) => isConversationFor(e, binding.caseId))
    .sort((a, b) => a.ts - b.ts)
    .map(toConversationEntry)
    .slice(-limit)
}

/**
 * Pull every step-output cached against the case. Returned oldest
 * first so callers can replay the timeline.
 */
export async function recallCaseStepOutputs(
  binding: CaseContextBinding,
  opts: { limit?: number } = {},
): Promise<CaseStepOutputEntry[]> {
  const limit = clamp(opts.limit ?? 50, 1, 200)
  // Sort by underlying `ts` for monotonic ordering — see the analogous
  // comment in `recallCaseConversation`.
  const recent = await binding.memory.recall({ kinds: ['episodic'], k: 200 })
  return recent
    .filter((e) => isStepOutputFor(e, binding.caseId))
    .sort((a, b) => a.ts - b.ts)
    .map(toStepOutputEntry)
    .slice(-limit)
}

// ---------------------------------------------------------------------
// Formatting helper
// ---------------------------------------------------------------------

export interface FormatCaseContextOpts {
  conversation: readonly CaseConversationEntry[]
  stepOutputs?: readonly CaseStepOutputEntry[]
  /** Prefix line shown above the block. Default tuned for Chinese
   * agent prompts. */
  header?: string
  /** When set, only includes step-output entries whose `stepId` is in
   * this list. Useful when a step wants to see only its predecessors. */
  includeStepOutputs?: readonly string[]
}

/**
 * Render the case context as a single markdown-ish block ready to be
 * prepended to an LLM prompt. Empty input produces an empty string
 * (caller can no-op without an `if`).
 *
 * Layout:
 *
 *     <header>
 *     【对话历史】
 *     - [user, intake] ...
 *     - [coach, draft] ...
 *     【已完成步骤产物】
 *     - [intake] 摘要 ...
 */
export function formatCaseContextBlock(opts: FormatCaseContextOpts): string {
  const lines: string[] = []
  if (opts.conversation.length > 0) {
    lines.push('【对话历史 / case conversation】')
    for (const c of opts.conversation) {
      const tag = c.stepId ? `${c.source}@${c.stepId}` : c.source
      lines.push(`- [${tag}] ${c.text}`)
    }
  }
  const so = opts.stepOutputs ?? []
  const filteredSo = opts.includeStepOutputs
    ? so.filter((e) => opts.includeStepOutputs!.includes(e.stepId))
    : so
  if (filteredSo.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('【已完成步骤产物 / completed step outputs】')
    for (const s of filteredSo) {
      lines.push(`- [${s.stepId}] ${truncate(s.text, 280)}`)
    }
  }
  if (lines.length === 0) return ''
  const header = opts.header ?? '## 当前 case 的已有上下文（请在回答时考虑）'
  return [header, '', ...lines, ''].join('\n')
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

function isConversationFor(e: MemoryEntry, caseId: string): boolean {
  const m = e.meta as Record<string, unknown> | undefined
  return (
    !!m &&
    m[META_CASE_ID] === caseId &&
    m[META_TOPIC] === TOPIC_CONVERSATION
  )
}

function isStepOutputFor(e: MemoryEntry, caseId: string): boolean {
  const m = e.meta as Record<string, unknown> | undefined
  return (
    !!m &&
    m[META_CASE_ID] === caseId &&
    m[META_TOPIC] === TOPIC_STEP_OUTPUT
  )
}

function toConversationEntry(e: MemoryEntry): CaseConversationEntry {
  const m = (e.meta ?? {}) as Record<string, unknown>
  const source = (m[META_SOURCE] as CaseConversationSource) ?? 'system'
  const at = typeof m[META_AT] === 'string'
    ? (m[META_AT] as string)
    : new Date(e.ts).toISOString()
  const stepId = typeof m[META_STEP_ID] === 'string'
    ? (m[META_STEP_ID] as string)
    : undefined
  const base: CaseConversationEntry = { source, text: e.text, at, id: e.id }
  return stepId ? { ...base, stepId } : base
}

function toStepOutputEntry(e: MemoryEntry): CaseStepOutputEntry {
  const m = (e.meta ?? {}) as Record<string, unknown>
  const stepId = typeof m[META_STEP_ID] === 'string'
    ? (m[META_STEP_ID] as string)
    : 'unknown-step'
  const at = typeof m[META_AT] === 'string'
    ? (m[META_AT] as string)
    : new Date(e.ts).toISOString()
  return { stepId, text: e.text, at, id: e.id }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}
