/**
 * compaction.ts — save-before-compact (decision H / 用户 Q1「不丢上下文」那一面).
 *
 * # Why this exists
 *
 * OpenClaw runs a silent "save-before-compact" round by default: just before the
 * live working context is summarized-and-dropped, it prompts the agent to write
 * the important bits to durable memory so nothing is lost. AipeHub had no
 * equivalent — `capture.ts` records only the FINAL user prompt + reply of a turn
 * (extractive, no model), so everything that surfaced *inside* a long tool-loop
 * turn — decisions made, facts the user stated mid-conversation, commitments —
 * evaporates when that working context (`LlmAgent`'s `__llmMessages`) is dropped.
 * This is the safety net for that gap.
 *
 * # What it produces — candidates, not a transcript summary
 *
 * The natural home in our pipeline isn't "another summary" (consolidate already
 * distills episodic→profile). It's the **candidate producer** that
 * {@link reconcile} (MEM-A) always assumed but never supplied: reconcile takes
 * `candidates` = "new candidate facts from the latest conversation" and merges
 * them ADD/UPDATE/DELETE/NOOP — but nothing showed how to derive those from an
 * actual conversation. {@link extractDurableFacts} is that missing step: dying
 * transcript → durable fact candidates. So H feeds A.
 *
 * {@link saveBeforeCompact} is the turnkey orchestrator: extract, then persist
 * the facts as ad-hoc `semantic` entries so they ride the **next session's
 * frozen block immediately** (the whole point — "don't lose this now"). Dedup is
 * left to the heartbeat reconcile pass: by symmetry with capture (which appends
 * raw episodic, deduped later) this appends distilled semantic, deduped later.
 * A caller wanting inline dedup feeds `result`'s facts to `reconcile({candidates})`.
 *
 * # No LLM import, fail-soft
 *
 * Like {@link consolidate} / {@link reconcile} this takes a
 * {@link MemorySummarizer} callback, never importing `@aipehub/llm`, and is
 * trivially testable with a deterministic fake. A bad / empty / throwing model
 * response yields ZERO facts (never corrupts memory on a hiccup). The drop point
 * is infrequent (session end / before truncating working memory), so a single
 * extra model call there is cheap.
 */

import type { MemoryHandle, MemoryKind, NewMemoryEntry } from '@aipehub/services-sdk'

import type { MemorySummarizer } from './consolidate.js'
import { clampImportance, META_IMPORTANCE, type Importance } from './importance.js'

/** Soft cap on the transcript fed to the extractor (bigger than a single
 *  capture entry — this is the whole dying working context). */
export const DEFAULT_COMPACTION_MAX_CHARS = 6_000
/** Below this many readable messages, a flush isn't worth a model call. */
export const DEFAULT_COMPACTION_MIN_MESSAGES = 2
/** Meta flag marking a fact that entered memory via a save-before-compact flush. */
export const META_COMPACTED = 'compacted'

/**
 * A durable fact the extractor pulled out of the dying context. `text` is
 * atomic and self-contained; `importance` (1–5) is the model's call, defaulted
 * when absent.
 */
export interface DurableFact {
  readonly text: string
  readonly importance?: Importance
}

/**
 * One conversation message, duck-typed so callers can pass an `LlmMessage[]`
 * (or any `{ role, content }`-ish list) without this leaf package importing
 * `@aipehub/llm`. `content` is read defensively (string or content-block array).
 */
export interface CompactionMessage {
  readonly role?: string
  readonly content?: unknown
}

export interface ExtractDurableFactsOptions {
  /** The extraction LLM call. */
  summarize: MemorySummarizer
  /** The working context about to be dropped. */
  messages: readonly CompactionMessage[]
  /** Soft cap on the rendered transcript. Default {@link DEFAULT_COMPACTION_MAX_CHARS}. */
  maxChars?: number
  /** Override the extraction system prompt. */
  system?: string
}

/**
 * Extract the durable facts worth keeping from a conversation that is about to
 * be dropped. Pure w.r.t. memory (no reads, no writes) — it only calls the
 * summarizer. Returns `[]` when there's nothing readable to send, or on any
 * unusable / empty / throwing model response (fail-soft). The result is exactly
 * the shape {@link reconcile}'s `candidates` consumes.
 */
export async function extractDurableFacts(
  opts: ExtractDurableFactsOptions,
): Promise<DurableFact[]> {
  const transcript = renderConversation(opts.messages, clampChars(opts.maxChars))
  if (!transcript) return []
  const system = opts.system ?? DEFAULT_COMPACTION_SYSTEM
  let raw = ''
  try {
    raw = (await opts.summarize({ system, user: buildExtractPrompt(transcript) })).trim()
  } catch {
    return []
  }
  return parseDurableFacts(raw)
}

export interface SaveBeforeCompactOptions {
  /** The memory to persist into. */
  memory: MemoryHandle
  /** The extraction LLM call. */
  summarize: MemorySummarizer
  /** The working context about to be dropped. */
  messages: readonly CompactionMessage[]
  /** Which kind the saved facts live in. Default `'semantic'` (rides the next
   *  frozen block; the heartbeat reconcile then dedups). */
  kind?: MemoryKind
  /** Meta merged into every saved entry — e.g. a per-user namespace (no-leak). */
  entryMeta?: Record<string, unknown>
  /** Skip the flush (and the model call) below this many readable messages.
   *  Default {@link DEFAULT_COMPACTION_MIN_MESSAGES}. */
  minMessages?: number
  /** Soft cap on the rendered transcript. */
  maxChars?: number
  /** Override the extraction system prompt. */
  system?: string
}

export interface SaveBeforeCompactResult {
  /** Durable facts the extractor returned. */
  readonly extracted: number
  /** Facts actually written (empty-text facts are skipped). */
  readonly saved: number
}

/**
 * Run a save-before-compact pass: extract the durable facts from the dying
 * context and persist them. Returns `null` when there's nothing to do (too few
 * messages, or no durable facts surfaced) so the caller can skip without an
 * `if`. Best-effort by construction — extraction is fail-soft, and each write
 * carries `importance` + a `compacted` provenance flag.
 */
export async function saveBeforeCompact(
  opts: SaveBeforeCompactOptions,
): Promise<SaveBeforeCompactResult | null> {
  const minMessages = clampMin(opts.minMessages)
  const readable = opts.messages.filter((m) => messageText(m).length > 0)
  if (readable.length < minMessages) return null

  const facts = await extractDurableFacts({
    summarize: opts.summarize,
    messages: opts.messages,
    ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
    ...(opts.system !== undefined ? { system: opts.system } : {}),
  })
  if (facts.length === 0) return null

  const kind: MemoryKind = opts.kind ?? 'semantic'
  const baseMeta = opts.entryMeta ?? {}
  let saved = 0
  for (const f of facts) {
    const text = f.text.trim()
    if (!text) continue
    await opts.memory.remember(makeEntry(kind, text, baseMeta, clampImportance(f.importance)))
    saved++
  }
  if (saved === 0) return null
  return { extracted: facts.length, saved }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

export const DEFAULT_COMPACTION_SYSTEM = `You are a personal butler's memory curator performing a SAVE-BEFORE-COMPACT pass.

The conversation below is about to be dropped from the butler's live working context. Before it is lost, extract the DURABLE facts worth keeping — the standing knowledge a good butler remembers about the people they serve.

Keep:
- stable preferences, ongoing projects, important people, commitments, decisions
- concrete names, numbers, dates, and anything that will still matter next session

Drop:
- one-off chatter and pleasantries
- transient mechanics (tool calls, intermediate steps) and anything already superseded later in the conversation

Each fact must be atomic, self-contained, and understandable without the conversation. importance is 1 (trivial) to 5 (critical).

Output ONLY a JSON object, no prose. An empty list is correct when nothing durable was said:
{"facts":[{"text":"<durable fact>","importance":3}, ...]}`

function makeEntry(
  kind: MemoryKind,
  text: string,
  baseMeta: Record<string, unknown>,
  importance: Importance,
): NewMemoryEntry {
  return { kind, text, meta: { ...baseMeta, [META_IMPORTANCE]: importance, [META_COMPACTED]: true } }
}

function buildExtractPrompt(transcript: string): string {
  return [
    '[Conversation about to be dropped from the live context]',
    transcript,
    '',
    'Output the JSON object of durable facts now.',
  ].join('\n')
}

/**
 * Render the dying messages into a transcript. Accumulates newest-first so a
 * cap drops the OLDEST lines (the recent context is what matters most and is
 * about to be lost), then restores chronological order. Each message is capped
 * on its own so one giant turn can't crowd out the rest.
 */
function renderConversation(messages: readonly CompactionMessage[], maxChars: number): string {
  const perMsg = Math.max(200, Math.floor(maxChars / 4))
  const lines: string[] = []
  let total = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    const text = collapse(messageText(m))
    if (!text) continue
    const line = `${roleLabel(m.role)}: ${truncate(text, perMsg)}`
    if (total + line.length > maxChars && lines.length > 0) break
    lines.push(line)
    total += line.length + 1
  }
  return lines.reverse().join('\n')
}

/** Flatten a message's content to readable text. Pulls text + tool-result text;
 *  skips tool_use args (transient mechanics, not durable facts). */
function messageText(m: CompactionMessage): string {
  return flattenContent(m.content)
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown; content?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text)
    } else if (b.type === 'tool_result') {
      const inner = flattenContent(b.content)
      if (inner) parts.push(inner)
    }
    // tool_use / image / other blocks: skipped — not durable user-facing text.
  }
  return parts.join(' ')
}

function roleLabel(role: string | undefined): string {
  switch (role) {
    case 'user':
      return 'User'
    case 'assistant':
      return 'Butler'
    case 'system':
      return 'System'
    case 'tool':
      return 'Tool'
    default:
      return role && role.length > 0 ? role : 'Message'
  }
}

/**
 * Tolerant parser. Accepts `{"facts":[...]}` or a bare `[...]`; each item may be
 * a string or `{text, importance?}`. Returns `[]` on anything unusable (so a
 * model hiccup writes nothing).
 */
function parseDurableFacts(raw: string): DurableFact[] {
  if (!raw) return []
  const objStart = raw.indexOf('{')
  const arrStart = raw.indexOf('[')
  // Use whichever bracket opens FIRST — for a bare array the only `{` is an
  // inner element, so keying off `{` alone would slice out one element.
  const useArray = arrStart >= 0 && (objStart < 0 || arrStart < objStart)
  let jsonText: string | null = null
  if (useArray) {
    const end = raw.lastIndexOf(']')
    if (end > arrStart) jsonText = raw.slice(arrStart, end + 1)
  } else if (objStart >= 0) {
    const end = raw.lastIndexOf('}')
    if (end > objStart) jsonText = raw.slice(objStart, end + 1)
  }
  if (!jsonText) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { facts?: unknown } | null)?.facts)
      ? (parsed as { facts: unknown[] }).facts
      : null
  if (!list) return []

  const facts: DurableFact[] = []
  for (const item of list) {
    if (typeof item === 'string') {
      const text = item.trim()
      if (text) facts.push({ text })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const v = item as { text?: unknown; importance?: unknown }
    if (typeof v.text === 'string' && v.text.trim()) {
      facts.push({
        text: v.text,
        ...(typeof v.importance === 'number' ? { importance: clampImportance(v.importance) } : {}),
      })
    }
  }
  return facts
}

function collapse(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, Math.max(1, max - 1)) + '…'
}

function clampChars(maxChars: number | undefined): number {
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars) || maxChars <= 0) {
    return DEFAULT_COMPACTION_MAX_CHARS
  }
  return Math.floor(maxChars)
}

function clampMin(min: number | undefined): number {
  if (typeof min !== 'number' || !Number.isFinite(min) || min < 1) {
    return DEFAULT_COMPACTION_MIN_MESSAGES
  }
  return Math.floor(min)
}
