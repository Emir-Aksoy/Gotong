/**
 * `consolidate.ts` — forced distillation: fold raw `episodic` history into a
 * bounded, curated `semantic` **profile** (M3 / decision D3 + D5).
 *
 * # Why this exists
 *
 * Capture (M2) writes every turn to `episodic`. Left alone that grows without
 * bound. `@aipehub/memory-file`'s only defense is a crude byte-cap that *halves
 * and drops* old entries — losing information blind. M3 replaces that with
 * **intelligent** bounding: an LLM distills the old episodic backlog into one
 * readable curated profile (MEMORY.md / USER.md style), then the folded
 * episodic is forgotten. The profile is small, so it rides next session's
 * frozen block (M1); the raw history it summarized is gone but its substance
 * survives.
 *
 * This is a generalization of the worked `personal-growth-context.ts`
 * compaction pass — same write-before-delete crash safety, same "keep the most
 * recent N verbatim, fold the rest" shape — lifted into a reusable primitive
 * with a per-namespace `filter` and an honest overflow story.
 *
 * # Forced overflow (Hermes 模式)
 *
 * Hermes errors on an over-limit memory write to force the agent to trim *that
 * turn*. AipeHub's curation runs off the hot path (on the heartbeat, D5), so
 * the analogous force is here: if the distilled profile still exceeds
 * `profileHardCap`, `consolidate` asks the summarizer once more to compress
 * it; if it *still* can't fit, it **throws** `PersonalMemoryError(
 * 'semantic_overflow')` rather than silently writing an over-budget profile.
 * The overflow is surfaced (the heartbeat logs it) instead of swallowed — an
 * unbounded profile is a real problem an operator should see.
 *
 * # No LLM import
 *
 * `consolidate` takes a {@link MemorySummarizer} callback, not an
 * `LlmProvider`. The caller (the butler / host) owns which provider + model +
 * temperature to use; this stays a pure orchestrator that's trivially
 * testable with a deterministic fake summarizer (real distillation quality is
 * verified opt-in with a real key — design §十 risks).
 */

import type { MemoryEntry, MemoryHandle, NewMemoryEntry } from '@aipehub/services-sdk'

import { PersonalMemoryError } from './errors.js'
import type { MemoryReviewer, ReviewContext, ReviewOutcome } from './review.js'

// Trigger defaults — mirror personal-growth's COMPACT_TRIGGER_*.
export const DEFAULT_CONSOLIDATE_TRIGGER_ENTRIES = 32
export const DEFAULT_CONSOLIDATE_TRIGGER_BYTES = 32 * 1024
/** How many recent episodic entries stay verbatim (not folded). */
export const DEFAULT_CONSOLIDATE_KEEP_RECENT = 8
/** Hard cap on the curated profile text — over this forces a re-summarize, then throws. */
export const DEFAULT_PROFILE_HARD_CAP = 4_000
/** Window pulled when scanning episodic / semantic for a pass. */
const RECALL_WINDOW = 200

/** Meta key marking a semantic entry as THE curated profile (vs an ad-hoc fact). */
export const META_PROFILE = 'profile'
const META_CONSOLIDATED_AT = 'consolidatedAt'

/**
 * Caller-supplied LLM summarizer. Gets a `system` + `user` prompt, returns the
 * raw curated text. Keeps this module free of any `@aipehub/llm` import.
 */
export type MemorySummarizer = (input: {
  readonly system: string
  readonly user: string
}) => Promise<string>

export interface ConsolidateOptions {
  /** The memory to curate. */
  memory: MemoryHandle
  /** The distillation LLM call. */
  summarize: MemorySummarizer
  /**
   * Scope every read/fold to one namespace (e.g. a single user). When set,
   * only entries the predicate accepts are counted, folded, or absorbed —
   * another user's memory is never touched (M6 no-leak).
   */
  filter?: (entry: MemoryEntry) => boolean
  /** Meta merged into the written profile entry (e.g. `{ user: 'alice' }`). */
  profileMeta?: Record<string, unknown>
  /** Recent episodic entries to leave verbatim. Default {@link DEFAULT_CONSOLIDATE_KEEP_RECENT}. */
  keepRecent?: number
  /** Episodic-count trigger. Default {@link DEFAULT_CONSOLIDATE_TRIGGER_ENTRIES}. */
  triggerEntries?: number
  /** Episodic-byte trigger. Default {@link DEFAULT_CONSOLIDATE_TRIGGER_BYTES}. */
  triggerBytes?: number
  /** Hard cap on the curated profile. Default {@link DEFAULT_PROFILE_HARD_CAP}. */
  profileHardCap?: number
  /** Run regardless of the trigger (manual "consolidate now" / tests). */
  force?: boolean
  /** Override the curator system prompt. */
  system?: string
  /** Clock injection. */
  now?: () => number
}

export interface ConsolidateResult {
  /** Episodic entries folded into the new profile. */
  readonly consolidatedCount: number
  /** Prior profile entries absorbed (folded forward). */
  readonly absorbedProfiles: number
  /** The newly written curated profile entry. */
  readonly profile: MemoryEntry
  /** Profile text length (after any re-summarize). */
  readonly bytes: number
}

/** Default curator system prompt — generic, override per-deployment. */
export const DEFAULT_CONSOLIDATE_SYSTEM = `You are a personal butler's memory curator.

Distill the user's recent conversation history into a concise, durable profile —
the kind of standing knowledge a good butler keeps about the people they serve.

Rules:
1. Keep what stays true: stable preferences, ongoing projects, important people,
   commitments, decisions, recurring themes, concrete names / numbers / dates.
2. Drop one-off chatter, pleasantries, and anything already superseded by later turns.
3. If an earlier profile is provided, treat it as background: carry its core forward
   and merge in only what's new — do not repeat it line by line.
4. Write it as a readable profile (short headed sections or tight bullets), not a transcript.
5. Output the profile body only — no preamble, no explanation.`

/**
 * Does the (filtered) episodic backlog exceed the consolidation trigger?
 * Cheap — one recall. Profile entries do not count (they ARE the result of
 * consolidation; counting them would cause re-consolidation storms).
 */
export async function shouldConsolidate(opts: ConsolidateOptions): Promise<boolean> {
  const episodic = await pullEpisodic(opts)
  const triggerEntries = opts.triggerEntries ?? DEFAULT_CONSOLIDATE_TRIGGER_ENTRIES
  const triggerBytes = opts.triggerBytes ?? DEFAULT_CONSOLIDATE_TRIGGER_BYTES
  if (episodic.length >= triggerEntries) return true
  const bytes = episodic.reduce((sum, e) => sum + e.text.length, 0)
  return bytes >= triggerBytes
}

/**
 * Run one consolidation pass. Returns `null` when nothing was done (under
 * trigger and not forced, or fewer than `keepRecent + 1` entries). Throws
 * `PersonalMemoryError` on an empty summarizer result or an irreducible
 * profile overflow.
 *
 * Strategy (mirrors personal-growth's crash-safe order):
 *   1. Pull filtered episodic, oldest-first.
 *   2. Slice off the most recent `keepRecent` — they stay verbatim.
 *   3. Pull prior profile entries to fold forward.
 *   4. Summarize (prior profiles + folded episodic) → curated text.
 *   5. Enforce the hard cap (re-summarize once; throw if still over).
 *   6. Write the new profile BEFORE deleting anything (a crash leaves a
 *      duplicate, never a gap).
 *   7. Forget the folded episodic + absorbed prior profiles.
 */
export async function consolidate(opts: ConsolidateOptions): Promise<ConsolidateResult | null> {
  if (!opts.force && !(await shouldConsolidate(opts))) return null

  const keepRecent = clamp(opts.keepRecent ?? DEFAULT_CONSOLIDATE_KEEP_RECENT, 1, RECALL_WINDOW)
  const now = (opts.now ?? ((): number => Date.now()))()

  const episodic = (await pullEpisodic(opts)).sort((a, b) => a.ts - b.ts)
  if (episodic.length <= keepRecent) return null

  const toFold = episodic.slice(0, episodic.length - keepRecent)
  const priorProfiles = (await pullProfiles(opts)).sort((a, b) => a.ts - b.ts)

  const system = opts.system ?? DEFAULT_CONSOLIDATE_SYSTEM
  const user = buildConsolidateUserPrompt({ priorProfiles, toFold, keptCount: keepRecent })

  const hardCap = clamp(opts.profileHardCap ?? DEFAULT_PROFILE_HARD_CAP, 200, 200_000)
  const profileText = await distillWithinCap(opts.summarize, { system, user }, hardCap)

  // Write new BEFORE deleting old → an interrupted pass leaves more, not less.
  const meta: Record<string, unknown> = {
    ...(opts.profileMeta ?? {}),
    [META_PROFILE]: true,
    [META_CONSOLIDATED_AT]: now,
  }
  const entry: NewMemoryEntry = { kind: 'semantic', text: profileText, meta }
  const profile = await opts.memory.remember(entry)

  let consolidatedCount = 0
  for (const e of toFold) {
    try {
      await opts.memory.forget(e.id)
      consolidatedCount++
    } catch {
      // Tolerate a straggler — the new profile already covers it; a later
      // pass picks it up. (Same forgiveness as personal-growth.)
    }
  }
  let absorbedProfiles = 0
  for (const p of priorProfiles) {
    try {
      await opts.memory.forget(p.id)
      absorbedProfiles++
    } catch {
      // ditto
    }
  }

  return { consolidatedCount, absorbedProfiles, profile, bytes: profileText.length }
}

/**
 * Adapt `consolidate` to a {@link MemoryReviewer} so the M2
 * `MemoryReviewParticipant` can run it on every heartbeat tick. Returns a
 * one-line summary when a pass happened, or `{}` (→ idle / `HEARTBEAT_OK`)
 * when there was nothing to do. The participant's own `filter` is *not*
 * threaded automatically — pass the same `filter` here when scoping per-user.
 */
export function consolidateReviewer(
  opts: Omit<ConsolidateOptions, 'memory'>,
): MemoryReviewer {
  return async (ctx: ReviewContext): Promise<ReviewOutcome> => {
    const result = await consolidate({ ...opts, memory: ctx.memory, now: () => ctx.now })
    if (!result) return {}
    return {
      summary: `consolidated ${result.consolidatedCount} episodic ${
        result.consolidatedCount === 1 ? 'entry' : 'entries'
      } into the profile (${result.bytes} chars)`,
      consolidated: result.consolidatedCount,
    }
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

async function pullEpisodic(opts: ConsolidateOptions): Promise<MemoryEntry[]> {
  const all = await opts.memory.recall({ kinds: ['episodic'], k: RECALL_WINDOW })
  return opts.filter ? all.filter((e) => opts.filter!(e)) : all
}

async function pullProfiles(opts: ConsolidateOptions): Promise<MemoryEntry[]> {
  const all = await opts.memory.recall({ kinds: ['semantic'], k: RECALL_WINDOW })
  return all.filter(isProfile).filter((e) => (opts.filter ? opts.filter(e) : true))
}

/**
 * A curated profile entry (the flat-consolidation output) is tagged
 * `meta.profile === true`. Exported so the reconcile pass can protect it: a
 * flat profile carries NO `meta.level`, so the tiered `isClusterProfile` guard
 * (which keys off `level`) misses it — reconcile must skip it by THIS predicate
 * too, or a real LLM would see the curated blob as an editable ad-hoc fact.
 */
export function isProfile(e: MemoryEntry): boolean {
  return (e.meta as { profile?: unknown } | undefined)?.profile === true
}

/**
 * Summarize, then enforce the hard cap. One re-summarize attempt asking for a
 * tighter compression; if the result still overflows, throw — never write an
 * over-budget profile. Exported so the tiered path reuses the SAME overflow
 * policy for its durable per-cluster profiles.
 */
export async function distillWithinCap(
  summarize: MemorySummarizer,
  prompt: { system: string; user: string },
  hardCap: number,
): Promise<string> {
  let text = (await summarize(prompt)).trim()
  if (!text) {
    throw new PersonalMemoryError(
      'consolidate_empty',
      'consolidate: summarizer returned empty text',
    )
  }
  if (text.length <= hardCap) return text

  // Over the cap — force a compression pass (Hermes 报错逼蒸, off the hot path).
  text = (
    await summarize({
      system: buildCompressSystem(hardCap),
      user: text,
    })
  ).trim()
  if (text.length <= hardCap) return text

  throw new PersonalMemoryError(
    'semantic_overflow',
    `consolidate: curated profile is ${text.length} chars, over the ${hardCap}-char ` +
      'hard cap even after a compression pass — refusing to write an unbounded profile',
  )
}

function buildCompressSystem(hardCap: number): string {
  return (
    `You are compressing an already-curated profile that is too long. Rewrite it to ` +
    `at most ${hardCap} characters, dropping the least important details first while ` +
    `keeping stable preferences, projects, people, and commitments. Output the profile body only.`
  )
}

function buildConsolidateUserPrompt(args: {
  priorProfiles: ReadonlyArray<MemoryEntry>
  toFold: ReadonlyArray<MemoryEntry>
  keptCount: number
}): string {
  const parts: string[] = []
  if (args.priorProfiles.length > 0) {
    parts.push('[Earlier profile — carry its core forward, merge in only what is new]')
    for (const p of args.priorProfiles) {
      parts.push(p.text)
      parts.push('')
    }
    parts.push('---')
    parts.push('')
  }
  parts.push(`[${args.toFold.length} recent conversation entries (oldest first)]`)
  for (const e of args.toFold) {
    parts.push(e.text)
    parts.push('')
  }
  parts.push(
    `[The most recent ${args.keptCount} entries stay verbatim for the live context — ` +
      'you do not need to handle them.]',
  )
  parts.push('')
  parts.push('Output the curated profile (see the rules in the system prompt).')
  return parts.join('\n')
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
