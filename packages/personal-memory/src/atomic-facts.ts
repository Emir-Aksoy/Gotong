/**
 * atomic-facts.ts — Mem0-style atomic fact extraction for the 6h consolidation
 * (MU-M3). The one thing the keyword/local-fusion recall CANNOT do is bridge a
 * true synonym: a query 「饮料」 never finds 「珍珠奶茶」 because they share no
 * character (MU-M1's `semantic` category sits at recall 0 by construction). The
 * fix is not a smarter retriever — it is a better MEMORY: if consolidation writes
 * a SELF-CONTAINED fact 「用户最爱的饮料是珍珠奶茶」, then the category query hits
 * it directly (the fact carries BOTH the category word and the specific). This is
 * exactly Mem0's insight — extract atomic, standalone facts, each recallable on
 * its own — and it is what closes the gap M1/M2 left open.
 *
 * # One 6h call, no hot path
 *
 * Extraction is a `MemoryReviewer` that runs in the 6h maintenance pass alongside
 * the tiered distillation — a background, per-member, best-effort call on the
 * butler's own model. The per-turn hot path stays ZERO-LLM (capture is still
 * extractive). It reuses the injected {@link MemorySummarizer} seam (the leaf
 * never imports an LLM) exactly like `consolidate` / `tieredReviewer`.
 *
 * # Standalone facts, not a profile blob (the property the benchmark checks)
 *
 * The prompt forces each fact to be independently recallable — 「用户最爱的饮料是
 * 珍珠奶茶」, not 「珍珠奶茶」. That category+specific shape is what a later
 * category query overlaps. New facts are DEDUPED against existing semantic (a
 * lexical-overlap check, no second model call) so a stable fact isn't rewritten
 * every 6h, and tagged with a provenance marker (OpenClaw's "recall knows where a
 * memory came from"). Agent-stated facts are treated the same as user-stated ones
 * (Mem0's single-pass: the transcript is the source, whoever said it).
 */

import type { MemoryEntry } from '@gotong/services-sdk'

import type { MemorySummarizer } from './consolidate.js'
import { relevanceScore } from './relevance.js'
import type { MemoryReviewer, ReviewContext, ReviewOutcome } from './review.js'

/** Meta marker: this semantic entry was written by atomic fact extraction (provenance). */
export const META_ATOMIC_FACT = 'atomicFact'

/** Default: need at least this many recent episodic entries before extraction bothers. */
export const DEFAULT_ATOMIC_FACTS_TRIGGER_ENTRIES = 4

/**
 * Default: how many existing semantic entries the dedup check scans. Extraction
 * runs in the 6h background (never the hot path), so this scans the WHOLE store,
 * not a recency window: a candidate that duplicates an OLD fact — one the butler
 * distilled months ago, now buried under hundreds of newer entries — must still
 * be caught, or the same fact is re-extracted every 6h and `semantic` bloats with
 * near-duplicates (audit P2). A newest-`k` recall could only see the freshest `k`
 * and would miss anything older. The store is byte-bounded by the maintenance
 * `budgetBytes`, so a generous scan covers all of it; this mirrors
 * `BUDGET_SCAN_LIMIT`.
 */
export const ATOMIC_FACTS_RECALL_WINDOW = 10_000

/**
 * Default: a candidate whose lexical overlap with an already-known fact is at or
 * above this is treated as a duplicate and skipped (so a stable fact isn't
 * re-written every 6h). Query-coverage in [0,1]; 0.8 = "almost all of this fact's
 * terms are already covered by a stored one".
 */
export const DEFAULT_FACT_DEDUP_THRESHOLD = 0.8

/** Default cap on facts written per pass — a backstop against a runaway model. */
export const DEFAULT_MAX_FACTS_PER_PASS = 12

/** The extraction instruction. Forces STANDALONE facts (category + specific). */
export const DEFAULT_ATOMIC_FACTS_SYSTEM = [
  '你是一个记忆整理助手。从下面的对话记录里抽取【长期、稳定】的事实,写进用户的记忆。',
  '规则:',
  '1. 每条事实必须【自包含】——单独拿出来也能看懂:要带上类别词和具体值。',
  '   好例子:「用户最爱的饮料是珍珠奶茶」「用户养的宠物是一只叫大黄的金毛」。',
  '   坏例子:「珍珠奶茶」「大黄」(缺类别,单独召回时不知道在讲什么)。',
  '2. 只抽稳定的偏好 / 属性 / 关系 / 长期承诺;忽略一次性闲聊、临时情绪、当下动作。',
  '3. 一行一条,不编号、不加解释、不加标题。',
  '4. 如果没有值得长期记住的事实,输出空。',
].join('\n')

export interface AtomicFactsReviewerOptions {
  /** The extraction LLM call (the butler's own model, injected — the leaf stays LLM-free). */
  summarize: MemorySummarizer
  /** Override the extraction instruction. */
  system?: string
  /** Minimum recent episodic entries before a pass fires. Default {@link DEFAULT_ATOMIC_FACTS_TRIGGER_ENTRIES}. */
  triggerEntries?: number
  /** Dedup threshold in [0,1]. Default {@link DEFAULT_FACT_DEDUP_THRESHOLD}. */
  dedupThreshold?: number
  /** Cap on facts written per pass. Default {@link DEFAULT_MAX_FACTS_PER_PASS}. */
  maxFacts?: number
  /** Existing semantic entries scanned for dedup. Default {@link ATOMIC_FACTS_RECALL_WINDOW}. */
  recallWindow?: number
}

/**
 * A {@link MemoryReviewer} that extracts atomic self-contained facts from recent
 * episodic and writes the NEW ones to semantic. Composes into the 6h maintenance
 * chain (after tiered distillation, so dedup sees the fresh cluster profiles too).
 *
 * Best-effort and quiet: below the trigger, or when the model returns nothing
 * new, it returns an idle outcome (no summary) so the heartbeat stays silent.
 */
export function atomicFactsReviewer(opts: AtomicFactsReviewerOptions): MemoryReviewer {
  const system = opts.system ?? DEFAULT_ATOMIC_FACTS_SYSTEM
  const trigger = opts.triggerEntries ?? DEFAULT_ATOMIC_FACTS_TRIGGER_ENTRIES
  const threshold = opts.dedupThreshold ?? DEFAULT_FACT_DEDUP_THRESHOLD
  const maxFacts = opts.maxFacts ?? DEFAULT_MAX_FACTS_PER_PASS
  const recallWindow = opts.recallWindow ?? ATOMIC_FACTS_RECALL_WINDOW

  return async (ctx: ReviewContext): Promise<ReviewOutcome> => {
    if (ctx.episodic.length < trigger) return {} // not enough new material to bother

    // Episodic arrives newest-first; feed the model chronological order.
    const transcript = [...ctx.episodic].reverse().map((e) => e.text).join('\n')
    const raw = await opts.summarize({ system, user: `对话记录:\n${transcript}\n\n抽取事实:` })
    const candidates = parseFacts(raw, maxFacts)
    if (candidates.length === 0) return {}

    // Dedup against ALL existing semantic (lexical overlap; NO second model call)
    // plus the facts accepted so far this pass. `list` enumerates the store
    // newest-first with no recency/text filter, so a candidate that duplicates a
    // buried OLD fact is caught too — a newest-`k` recall would only surface the
    // freshest `k` and miss anything older, re-writing it every 6h (audit P2).
    // Cheap: one 6h-background scan of a byte-bounded store.
    const existing = await ctx.memory.list({ kind: 'semantic', limit: recallWindow })
    const knownTexts = existing.map((e) => e.text)
    const accepted: string[] = []
    for (const fact of candidates) {
      if (isDuplicate(fact, knownTexts, threshold) || isDuplicate(fact, accepted, threshold)) continue
      accepted.push(fact)
    }
    if (accepted.length === 0) return {}

    for (const fact of accepted) {
      await ctx.memory.remember({ kind: 'semantic', text: fact, meta: { [META_ATOMIC_FACT]: true } })
    }
    return { summary: `抽取 ${accepted.length} 条原子事实`, consolidated: accepted.length }
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** Longest a single "atomic fact" may be — beyond this it's a paragraph, not a fact. */
const MAX_FACT_CHARS = 200

/**
 * Parse the model's line-per-fact output into clean fact strings: strip list
 * markers / numbering, drop blanks, drop over-long lines (a paragraph slipped
 * through), cap the count. Deterministic and pure.
 */
export function parseFacts(raw: string, maxFacts: number): string[] {
  const out: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = line
      .trim()
      .replace(/^[-*•·]\s+/, '') // bullet
      .replace(/^\d+[.)、]\s*/, '') // "1. " / "1) " / "1、"
      .trim()
    if (cleaned.length < 2) continue // blank / punctuation-only
    if (cleaned.length > MAX_FACT_CHARS) continue // a paragraph, not an atomic fact
    out.push(cleaned)
    if (out.length >= maxFacts) break
  }
  return out
}

/**
 * Is `fact` already covered by one of `known`? Uses {@link relevanceScore} with
 * the candidate as the query — "are (almost) all of this fact's terms already
 * present in a stored one" — so a re-phrasing of a known fact is caught.
 */
function isDuplicate(fact: string, known: readonly string[], threshold: number): boolean {
  for (const text of known) if (relevanceScore(fact, text) >= threshold) return true
  return false
}

/** Whether an entry was written by atomic fact extraction (provenance query). */
export function isAtomicFact(e: MemoryEntry): boolean {
  return (e.meta as { atomicFact?: unknown } | undefined)?.atomicFact === true
}
