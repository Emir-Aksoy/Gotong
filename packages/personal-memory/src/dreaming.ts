/**
 * dreaming.ts — background "dream" consolidation (MR2, aligning OpenClaw).
 *
 * # The gap this closes
 *
 * The butler already has `consolidate` (episodic→semantic), `effectiveSalience`
 * (F decay/reinforce) and `recallCountOf` (F). What OpenClaw's dreaming sweep adds
 * — and we lacked — is three things:
 *
 *   ① a QUERY-DIVERSITY signal: how many DISTINCT questions a fact has answered.
 *      A fact asked about in ten different ways is worth far more than one recalled
 *      ten times the same way. We capture it as a bounded set of query fingerprints
 *      on `meta.queryHits`; diversity = the set's size.
 *   ② a single sweep that SCORES every candidate on three gates and acts —
 *      promote the worthy into the curated profile, prune the stale-and-unloved.
 *   ③ a DREAM DIARY — a human-readable record of what each sweep promoted / pruned.
 *
 * # Three gates (OpenClaw's promotion criteria, made one deterministic scalar)
 *
 *   dreamScore = effectiveSalience      // score gate  (importance × decay × reinforce, F+⑤)
 *              × (1 + recallCount)       // frequency gate (how OFTEN recalled, F)
 *              × (1 + queryDiversity)    // diversity gate (how many DISTINCT queries)
 *
 * Multiplicative so a fact must do well on all three to score high; the `1 +`
 * keeps a fresh-but-important fact (0 recalls, 0 diversity) from zeroing out. Pure,
 * no LLM, trivially testable — the same stance as `salience.ts`.
 *
 * # What MUST NOT happen: time-varying signals in the frozen block
 *
 * `queryHits` (and `dreamScore`) are USE signals that move with the clock and with
 * what the user asks. They are for the dreaming sweep and eviction ONLY — never the
 * frozen block, whose byte-stability is the prompt-cache prefix contract (same rule
 * `salience.ts` states for keep-value). This module is imported by the heartbeat /
 * recall paths, never by `frozen-block.ts`.
 *
 * # Reuse, not rewrite
 *
 * Scoring reuses `effectiveSalience` / `recallCountOf` (F); fingerprinting reuses
 * `extractTerms` (the SAME tokenizer recall ranks with — zero drift); promotion
 * reuses `distillWithinCap` + the `meta.profile` tag (consolidate's overflow policy
 * and profile shape); pruning is plain `forget`. All MR2 state lives in
 * `MemoryEntry.meta` — zero schema change.
 */

import type { MemoryEntry, MemoryHandle, NewMemoryEntry } from '@aipehub/services-sdk'

import {
  DEFAULT_CONSOLIDATE_SYSTEM,
  DEFAULT_PROFILE_HARD_CAP,
  META_PROFILE,
  distillWithinCap,
  type MemorySummarizer,
} from './consolidate.js'
import { extractTerms } from './relevance.js'
import type { MemoryReviewer, ReviewContext, ReviewOutcome } from './review.js'
import { effectiveSalience, recallCountOf, type SalienceOptions } from './salience.js'

/** Meta key: the bounded set of distinct query fingerprints this entry answered. */
export const META_QUERY_HITS = 'queryHits'

/** Max distinct fingerprints kept per entry (FIFO). Diversity caps here. */
export const DEFAULT_QUERY_HITS_CAP = 16

/** How many top (sorted) query terms form a fingerprint — a query's stable shape. */
export const DEFAULT_FINGERPRINT_TERMS = 6

/** dreamScore ≥ this → promote into the curated profile. */
export const DEFAULT_DREAM_PROMOTE_GATE = 8

/** dreamScore ≤ this (AND stale AND never-diverse) → prune. */
export const DEFAULT_DREAM_PRUNE_GATE = 1

/** How long with no recall/write counts as "stale" for pruning. 14 days. */
export const DEFAULT_DREAM_STALE_MS = 14 * 24 * 60 * 60 * 1000

/** Max candidates scored per sweep (cost guard). */
export const DEFAULT_DREAM_MAX_CANDIDATES = 200

/**
 * A stable fingerprint of a recall query — the SAME tokenizer recall ranks with,
 * so "two queries that mean the same thing" collapse to one fingerprint and don't
 * inflate diversity. Top-N sorted distinct terms → a short base36 djb2 hash.
 * Returns '' for a query with no recallable terms (caller treats as "no hit").
 */
export function queryFingerprint(query: string, terms = DEFAULT_FINGERPRINT_TERMS): string {
  const t = [...new Set(extractTerms(query))].sort().slice(0, Math.max(1, terms))
  if (t.length === 0) return ''
  return djb2(t.join('|'))
}

/** Read an entry's distinct query fingerprints (validated string[], default []). */
export function queryHitsOf(entry: Pick<MemoryEntry, 'meta'>): string[] {
  const raw = (entry.meta as { queryHits?: unknown } | undefined)?.queryHits
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string' && x.length > 0)
}

/** Query-diversity = how many DISTINCT queries this entry has answered. */
export function queryDiversityOf(entry: Pick<MemoryEntry, 'meta'>): number {
  return queryHitsOf(entry).length
}

/**
 * The META DELTA that records one query hit, or `null` when nothing changes
 * (empty fingerprint, or already counted) — so the writer is IDEMPOTENT and a
 * re-asked query is not a write. Returns only the `queryHits` key (delta
 * discipline, mirroring `reinforcedMeta` / `closedMeta`): the caller shallow-
 * merges it, so it never clobbers a concurrent writer's keys. FIFO-capped at
 * `cap` (a fact answering endlessly-many distinct queries stays bounded; the most
 * recent shapes win).
 */
export function queryHitMeta(
  entry: Pick<MemoryEntry, 'meta'>,
  fingerprint: string,
  cap = DEFAULT_QUERY_HITS_CAP,
): Record<string, unknown> | null {
  if (!fingerprint) return null
  const cur = queryHitsOf(entry)
  if (cur.includes(fingerprint)) return null // already counted → no write (idempotent)
  const next = [...cur, fingerprint]
  const limit = Math.max(1, Math.floor(cap))
  const capped = next.length > limit ? next.slice(next.length - limit) : next
  return { [META_QUERY_HITS]: capped }
}

/**
 * Opt-in writer (recall path, sibling of `MemoryReinforcer`): record that
 * `fingerprint` matched `entry`, bumping its query-diversity. The host wires it to
 * the file backend's `patchMeta` with {@link queryHitMeta}; best-effort, once per
 * matched entry, alongside reinforcement.
 */
export type MemoryQueryHitWriter = (
  entry: MemoryEntry,
  fingerprint: string,
) => void | Promise<void>

export interface DreamScoreOptions {
  /** Decay / reinforcement options shared with `effectiveSalience`. */
  salience?: SalienceOptions
}

/**
 * The three-gate dream score (see file header). Default (no clock / options)
 * reduces to `importanceOf × (1+recallCount) × (1+diversity)`. Higher = more worth
 * promoting; lower = more prunable. Pure.
 */
export function dreamScore(entry: MemoryEntry, now?: number, opts?: DreamScoreOptions): number {
  const base = effectiveSalience(entry, now, opts?.salience) // ⑤+F: importance × decay × reinforce
  const frequency = 1 + recallCountOf(entry) // F: how often recalled
  const diversity = 1 + queryDiversityOf(entry) // MR2: how many DISTINCT queries
  return base * frequency * diversity
}

/** One entry a sweep acted on, for the diary. */
export interface DreamedEntry {
  readonly id: string
  readonly score: number
  readonly text: string
}

/** The structured result of one dreaming sweep — what the host appends to DREAMS.md. */
export interface DreamRecord {
  readonly firedAt: number
  /** High-scorers distilled into the curated profile this sweep. */
  readonly promoted: ReadonlyArray<DreamedEntry>
  /** Stale, low-value, never-diverse entries forgotten this sweep. */
  readonly pruned: ReadonlyArray<DreamedEntry>
  /** Size of the curated profile written, if any were promoted. */
  readonly profileBytes?: number
}

/** Structured diary sink — the host appends to `<userDir>/DREAMS.md`. Best-effort. */
export type DreamDiaryWriter = (record: DreamRecord) => void | Promise<void>

export interface DreamingReviewerOptions {
  /**
   * Distill the promote-set into a curated semantic profile. Omit → no promotion
   * (the sweep still prunes + diaries). When set, dreaming IS the promotion path
   * for this tick — don't also compose a full `consolidateReviewer` on the same
   * tick, or both would fold the episodic backlog.
   */
  summarize?: MemorySummarizer
  /** dreamScore ≥ this → promote. Default {@link DEFAULT_DREAM_PROMOTE_GATE}. */
  promoteGate?: number
  /** dreamScore ≤ this (and stale + never-diverse) → prune. Default {@link DEFAULT_DREAM_PRUNE_GATE}. */
  pruneGate?: number
  /** Age since last recall/write that counts as stale. Default {@link DEFAULT_DREAM_STALE_MS}. */
  staleMs?: number
  /** Decay/reinforce options for the score gate. */
  salience?: SalienceOptions
  /** Scope to one namespace (per-user no-leak). */
  filter?: (entry: MemoryEntry) => boolean
  /** Meta merged into the dreamed profile (e.g. `{ user: 'alice' }`). */
  profileMeta?: Record<string, unknown>
  /** Hard cap on the dreamed profile text. Default {@link DEFAULT_PROFILE_HARD_CAP}. */
  profileHardCap?: number
  /** Curator system prompt override. Default {@link DEFAULT_CONSOLIDATE_SYSTEM}. */
  system?: string
  /** Structured diary sink (host → DREAMS.md). */
  diary?: DreamDiaryWriter
  /** Max candidates scored per sweep. Default {@link DEFAULT_DREAM_MAX_CANDIDATES}. */
  maxCandidates?: number
}

/**
 * The dreaming sweep as a {@link MemoryReviewer} (runs on a heartbeat tick via
 * `MemoryReviewParticipant`, composable with `composeReviewers`).
 *
 * Each sweep:
 *   1. scores the episodic candidates by {@link dreamScore} (three gates);
 *   2. PROMOTES score ≥ `promoteGate` — distills them into a curated `profile`
 *      entry (crash-safe: write the profile, THEN forget the folded entries),
 *      reusing `distillWithinCap`'s overflow policy;
 *   3. PRUNES score ≤ `pruneGate` that are also stale AND never query-diverse —
 *      OpenClaw's proactive stale removal (by "never asked about", not just age);
 *   4. emits a {@link DreamRecord} to the diary and a one-line heartbeat summary.
 *
 * Converged state (nothing crosses either gate) → `{}` → idle / `HEARTBEAT_OK`, so
 * a quiet sweep makes no noise and the pass is idempotent.
 */
export function dreamingReviewer(opts: DreamingReviewerOptions = {}): MemoryReviewer {
  return async (ctx: ReviewContext): Promise<ReviewOutcome> => {
    const promoteGate = numOr(opts.promoteGate, DEFAULT_DREAM_PROMOTE_GATE)
    const pruneGate = numOr(opts.pruneGate, DEFAULT_DREAM_PRUNE_GATE)
    const staleMs = numOr(opts.staleMs, DEFAULT_DREAM_STALE_MS)
    const maxCandidates = Math.max(1, Math.floor(numOr(opts.maxCandidates, DEFAULT_DREAM_MAX_CANDIDATES)))

    const pool = (opts.filter ? ctx.episodic.filter(opts.filter) : ctx.episodic).slice(0, maxCandidates)
    if (pool.length === 0) return {}

    const scored = pool.map((e) => ({ e, s: dreamScore(e, ctx.now, { ...(opts.salience ? { salience: opts.salience } : {}) }) }))

    // PROMOTE — distill the high-scorers into the curated profile (crash-safe).
    const toPromote = scored.filter((x) => x.s >= promoteGate)
    const promoted: DreamedEntry[] = []
    let profileBytes: number | undefined
    if (opts.summarize && toPromote.length > 0) {
      const text = await distillWithinCap(
        opts.summarize,
        { system: opts.system ?? DEFAULT_CONSOLIDATE_SYSTEM, user: buildDreamPrompt(toPromote.map((x) => x.e)) },
        clampCap(opts.profileHardCap),
      )
      const meta: Record<string, unknown> = { ...(opts.profileMeta ?? {}), [META_PROFILE]: true, dreamed: true, dreamedAt: ctx.now }
      const profile: NewMemoryEntry = { kind: 'semantic', text, meta }
      await ctx.memory.remember(profile) // write BEFORE delete → a crash leaves more, not less
      profileBytes = text.length
      for (const x of toPromote) {
        try {
          await ctx.memory.forget(x.e.id)
          promoted.push(rec(x))
        } catch {
          // tolerate a straggler — the profile already covers it; next sweep retries
        }
      }
    }

    // PRUNE — stale, low-value, never-diverse chatter. Never prune what we promoted.
    const promotedIds = new Set(promoted.map((r) => r.id))
    const pruned: DreamedEntry[] = []
    for (const x of scored) {
      if (promotedIds.has(x.e.id)) continue
      if (x.s > pruneGate) continue
      if (queryDiversityOf(x.e) > 0) continue // ever-asked-about facts are not chatter
      if (!isStaleForPrune(x.e, ctx.now, staleMs)) continue
      try {
        await ctx.memory.forget(x.e.id)
        pruned.push(rec(x))
      } catch {
        // best-effort — a failed prune is retried next sweep
      }
    }

    if (promoted.length === 0 && pruned.length === 0) return {} // converged → idle

    const record: DreamRecord = {
      firedAt: ctx.now,
      promoted,
      pruned,
      ...(profileBytes !== undefined ? { profileBytes } : {}),
    }
    if (opts.diary) {
      try {
        await opts.diary(record)
      } catch {
        // diary is a human-readable side log; a failure must not break the sweep
      }
    }
    return {
      summary: `dreamed: promoted ${promoted.length}, pruned ${pruned.length}`,
      ...(promoted.length > 0 ? { consolidated: promoted.length } : {}),
    }
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** An entry is prunable-stale when it was last touched longer ago than `staleMs`. */
function isStaleForPrune(entry: MemoryEntry, now: number, staleMs: number): boolean {
  const last = lastTouch(entry)
  return now - last >= staleMs
}

/** Most recent activity timestamp — last recall if present, else the write time. */
function lastTouch(entry: MemoryEntry): number {
  const lr = (entry.meta as { lastRecalledTs?: unknown } | undefined)?.lastRecalledTs
  return typeof lr === 'number' && Number.isFinite(lr) ? lr : entry.ts
}

function rec(x: { e: MemoryEntry; s: number }): DreamedEntry {
  return { id: x.e.id, score: round2(x.s), text: x.e.text }
}

function buildDreamPrompt(entries: ReadonlyArray<MemoryEntry>): string {
  const parts: string[] = [`[${entries.length} high-value memories the dreaming sweep selected (oldest first)]`]
  for (const e of [...entries].sort((a, b) => a.ts - b.ts)) {
    parts.push(e.text)
    parts.push('')
  }
  parts.push('Output the curated profile (see the rules in the system prompt).')
  return parts.join('\n')
}

function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function numOr(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function clampCap(v: number | undefined): number {
  const n = numOr(v, DEFAULT_PROFILE_HARD_CAP)
  return Math.max(200, Math.min(200_000, Math.floor(n)))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
