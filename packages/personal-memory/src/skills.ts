/**
 * skills.ts — procedure self-authoring + Umbrella consolidation (MR3, learning Hermes).
 *
 * # The gap this closes
 *
 * G gave the butler a procedural FORM (`form:'procedure'` riding on a semantic
 * entry, with ordered `meta.steps`) but only as a PASSIVE record: the model had
 * to call `remember_procedure` explicitly. Hermes adds three behaviours we lacked:
 *
 *   ① 自创 (self-author): notice that the SAME multi-step pattern recurs across
 *      episodic memory and turn it into a named skill — without being told to.
 *   ② 自改 (self-improve): amend an existing skill's steps in place as it learns a
 *      better way (`refine_procedure`, in `toolset.ts` — patchMeta, no new id).
 *   ③ Umbrella 合并 (consolidate): periodically sweep the active skills, find
 *      REDUNDANT clusters (several micro-procedures that are really one), and merge
 *      each cluster into a single master "umbrella" skill — the rest are CLOSED
 *      (bitemporal, reversible) and back-linked to the umbrella.
 *
 * This module is the deterministic + aux-LLM machinery for ① and ③ (the heartbeat
 * passes). ② is a plain tool. The host projects the surviving active skills into a
 * human-readable `SKILL.md` (mirroring `DREAMS.md`).
 *
 * # Reuse, not rewrite (zero new schema)
 *
 *   - Clustering reuses `defaultLinkScorer` (E's symmetric term-overlap over the
 *     SAME `extractTerms` tokenizer recall ranks with) — one tokenizer, no drift.
 *   - A self-authored / umbrella skill is just an ordinary `form:'procedure'`
 *     entry (G); merging CLOSES the originals via `closedMeta` + `supersedes` (D,
 *     reversible — beats Hermes' destructive archive) and links them to the
 *     umbrella (E). NO parallel "skill" subsystem, NO new `MemoryKind`.
 *   - Recall / the frozen "things I know how to do" section already filter to
 *     `isActive`, so once the originals are closed they DROP OUT automatically and
 *     only the umbrella shows — the "SQLite repoint" comes free from D.
 *
 * # Governance (anti-unbounded-autonomy — the North Star)
 *
 * Self-authoring is a BOUNDED heartbeat pass (not a per-turn unbounded tool loop);
 * merging CLOSES rather than deletes (a bad merge is reversible by reopening the
 * interval). The auto-Umbrella merge is, by the locked decision, NOT inbox-gated
 * by default (closing is reversible and loses no data); an operator who wants
 * "auto-edits my skills" in the loop registers the merge through the existing
 * `GovernedActionToolset` — no new machinery.
 */

import type { MemoryEntry } from '@gotong/services-sdk'

import { closedMeta, isActive, META_SUPERSEDES } from './bitemporal.js'
import { defaultLinkScorer, linksOf, mergeLinks, META_LINKS } from './links.js'
import {
  FORM_PROCEDURE,
  META_FORM,
  META_STEPS,
  cleanSteps,
  isProcedure,
  stepsOf,
} from './procedure.js'
import { extractTerms } from './relevance.js'
import type { MemoryReviewer, ReviewContext, ReviewOutcome } from './review.js'

/** Meta key stamped on an episodic entry once a skill was authored FROM it (idempotency). */
export const META_PROCEDURIZED = 'procedurized'

/** Meta key marking a procedure as a MERGED umbrella skill (vs a directly-authored one). */
export const META_UMBRELLA = 'umbrella'

/** Default minimum recurrences of a pattern before it's proposed as a skill. */
export const DEFAULT_AUTHOR_MIN_OCCURRENCES = 3

/** Default similarity (symmetric term-overlap, [0,1]) two entries need to cluster. */
export const DEFAULT_CLUSTER_SIMILARITY = 0.5

/** Default minimum cluster size for an Umbrella merge (a redundant PAIR is enough). */
export const DEFAULT_UMBRELLA_MIN_CLUSTER = 2

/** Default cap on candidates / clusters processed per sweep (cost guard). */
export const DEFAULT_SKILLS_MAX_CANDIDATES = 50

/**
 * A drafted skill from the aux model: a one-line name and ordered steps. The
 * SAME shape whether the model is naming a fresh pattern (self-author) or merging
 * a redundant cluster (umbrella). The leaf stays LLM-free — it invokes an injected
 * async {@link ProcedureDrafter}; the host/example wires the real model (or a
 * deterministic stand-in), exactly like `MemorySummarizer` for dreaming.
 */
export interface DraftedProcedure {
  /** Short name / goal of the skill (one line). */
  readonly name: string
  /** Ordered action steps. */
  readonly steps: readonly string[]
}

/** Aux-model callback: given a prompt, return a named procedure with ordered steps. */
export type ProcedureDrafter = (input: {
  readonly system: string
  readonly user: string
}) => Promise<DraftedProcedure>

// ---------------------------------------------------------------------------
// pure clustering — shared by self-authoring (over episodic) and umbrella (over
// procedures). Deterministic single-link "star" clustering around a seed.
// ---------------------------------------------------------------------------

export interface ClusterOptions {
  /** Min symmetric similarity to join a seed's cluster. Default {@link DEFAULT_CLUSTER_SIMILARITY}. */
  minSimilarity?: number
  /** Min members for a cluster to count. Default 2. */
  minSize?: number
  /** Max clusters returned (cost guard). Default {@link DEFAULT_SKILLS_MAX_CANDIDATES}. */
  maxClusters?: number
}

/**
 * Group `entries` into clusters of mutually-similar items. Each unused entry, in
 * input order, SEEDS a cluster of itself plus every still-unused entry scoring
 * `>= minSimilarity` against it (symmetric term-overlap, {@link defaultLinkScorer}).
 * A cluster is emitted only when it reaches `minSize`; its members are then
 * consumed so they can't seed or join another. A seed whose cluster is too small
 * is NOT consumed — it stays available to join a later seed's cluster.
 *
 * Pure and deterministic: same input set + order → same clusters, every time. No
 * LLM, no I/O. Single-link / star (a member must be similar to the SEED, not
 * merely transitively reachable) keeps clusters tight and bounded.
 */
export function clusterBySimilarity(
  entries: readonly MemoryEntry[],
  opts: ClusterOptions = {},
): MemoryEntry[][] {
  const minSimilarity = numOr(opts.minSimilarity, DEFAULT_CLUSTER_SIMILARITY)
  const minSize = Math.max(1, Math.floor(numOr(opts.minSize, 2)))
  const maxClusters = Math.max(1, Math.floor(numOr(opts.maxClusters, DEFAULT_SKILLS_MAX_CANDIDATES)))

  const used = new Set<string>()
  const clusters: MemoryEntry[][] = []
  for (const seed of entries) {
    if (used.has(seed.id)) continue
    const cluster: MemoryEntry[] = [seed]
    for (const c of entries) {
      if (c.id === seed.id || used.has(c.id)) continue
      if (defaultLinkScorer(seed, c) >= minSimilarity) cluster.push(c)
    }
    if (cluster.length >= minSize) {
      for (const m of cluster) used.add(m.id)
      clusters.push(cluster)
      if (clusters.length >= maxClusters) break
    }
  }
  return clusters
}

// ---------------------------------------------------------------------------
// ① self-authoring — detect repeated patterns (pure) + a heartbeat pass that
// names them via the aux model and writes them as procedures.
// ---------------------------------------------------------------------------

/** A repeated episodic pattern worth turning into a skill. */
export interface ProcedureCandidate {
  /** The recurring episodic entries (the repeated occurrences). */
  readonly members: readonly MemoryEntry[]
  /** A stable hash of the cluster's shared shape (for the diary / dedup). */
  readonly signature: string
}

export interface DetectProcedureOptions {
  /** Min recurrences to propose a skill. Default {@link DEFAULT_AUTHOR_MIN_OCCURRENCES}. */
  minOccurrences?: number
  /** Min similarity to cluster. Default {@link DEFAULT_CLUSTER_SIMILARITY}. */
  minSimilarity?: number
  /** Max candidates returned. Default {@link DEFAULT_SKILLS_MAX_CANDIDATES}. */
  maxCandidates?: number
}

/** Whether a skill was already authored from this episodic entry (skip re-proposing). */
export function isProcedurized(e: Pick<MemoryEntry, 'meta'>): boolean {
  const v = (e.meta as { procedurized?: unknown } | undefined)?.procedurized
  return typeof v === 'string' && v.length > 0
}

/** Whether a procedure is a MERGED umbrella skill (vs a directly-recorded one). */
export function isUmbrella(e: Pick<MemoryEntry, 'meta'>): boolean {
  return (e.meta as { umbrella?: unknown } | undefined)?.umbrella === true
}

/**
 * Find repeated multi-step patterns in `episodic` — clusters of `>= minOccurrences`
 * mutually-similar entries — as skill candidates. Entries already turned into a
 * skill ({@link isProcedurized}) are excluded, so a converged history proposes
 * nothing (idempotent). Pure: the aux model does the naming, this only finds the
 * recurrence.
 */
export function detectProcedureCandidates(
  episodic: readonly MemoryEntry[],
  opts: DetectProcedureOptions = {},
): ProcedureCandidate[] {
  const minOccurrences = Math.max(2, Math.floor(numOr(opts.minOccurrences, DEFAULT_AUTHOR_MIN_OCCURRENCES)))
  const pool = episodic.filter((e) => !isProcedurized(e))
  const clusters = clusterBySimilarity(pool, {
    minSimilarity: numOr(opts.minSimilarity, DEFAULT_CLUSTER_SIMILARITY),
    minSize: minOccurrences,
    maxClusters: Math.max(1, Math.floor(numOr(opts.maxCandidates, DEFAULT_SKILLS_MAX_CANDIDATES))),
  })
  return clusters.map((members) => ({ members, signature: clusterSignature(members) }))
}

export interface ProcedureAuthoringReviewerOptions {
  /** Aux model that names a recurring pattern and regularizes it into steps. */
  draft: ProcedureDrafter
  /** Min recurrences before authoring. Default {@link DEFAULT_AUTHOR_MIN_OCCURRENCES}. */
  minOccurrences?: number
  /** Min similarity to cluster. Default {@link DEFAULT_CLUSTER_SIMILARITY}. */
  minSimilarity?: number
  /** Max candidates authored per sweep. Default {@link DEFAULT_SKILLS_MAX_CANDIDATES}. */
  maxCandidates?: number
  /** Scope to one namespace (per-user no-leak). */
  filter?: (entry: MemoryEntry) => boolean
  /** Meta merged into every authored procedure (e.g. `{ user: 'alice' }`). */
  procedureMeta?: Record<string, unknown>
  /** Aux-model system prompt override. */
  system?: string
}

/** Default system prompt steering the aux model to name + structure a recurring pattern. */
export const DEFAULT_AUTHOR_SYSTEM =
  'You are a skill librarian. You are shown several past episodes that follow the ' +
  'SAME repeated procedure. Extract the reusable how-to: a short one-line NAME for ' +
  'the skill, and the ordered STEPS (each a short imperative action). Generalize ' +
  'away one-off specifics; keep only what repeats. Output the name and steps.'

/**
 * Self-authoring as a {@link MemoryReviewer} (heartbeat pass). Each sweep:
 *   1. detects recurring episodic patterns ({@link detectProcedureCandidates});
 *   2. asks the aux model to NAME + structure each into ordered steps;
 *   3. writes it as a `form:'procedure'` semantic entry;
 *   4. stamps the source episodes `procedurized` so the same pattern is never
 *      re-authored (idempotent — a converged history authors nothing → `{}`).
 *
 * A candidate the aux model can't turn into a usable name+steps is skipped (no
 * empty skills written). Bounded by `maxCandidates` (cost guard, anti-runaway).
 */
export function procedureAuthoringReviewer(opts: ProcedureAuthoringReviewerOptions): MemoryReviewer {
  return async (ctx: ReviewContext): Promise<ReviewOutcome> => {
    const pool = opts.filter ? ctx.episodic.filter(opts.filter) : ctx.episodic
    const candidates = detectProcedureCandidates(pool, {
      ...(opts.minOccurrences !== undefined ? { minOccurrences: opts.minOccurrences } : {}),
      ...(opts.minSimilarity !== undefined ? { minSimilarity: opts.minSimilarity } : {}),
      ...(opts.maxCandidates !== undefined ? { maxCandidates: opts.maxCandidates } : {}),
    })
    if (candidates.length === 0) return {}

    const canPatch = typeof ctx.memory.patchMeta === 'function'
    let authored = 0
    for (const cand of candidates) {
      let drafted: DraftedProcedure
      try {
        drafted = await opts.draft({
          system: opts.system ?? DEFAULT_AUTHOR_SYSTEM,
          user: buildAuthorPrompt(cand.members),
        })
      } catch {
        continue // aux model failed on this one — try the next, don't abort the sweep
      }
      const name = (drafted.name ?? '').trim()
      const steps = cleanSteps(drafted.steps)
      if (!name || steps.length === 0) continue // unusable draft → skip, author nothing empty

      const meta: Record<string, unknown> = {
        ...(opts.procedureMeta ?? {}),
        [META_FORM]: FORM_PROCEDURE,
        [META_STEPS]: steps,
        authored: true,
        authoredAt: ctx.now,
      }
      const proc = await ctx.memory.remember({ kind: 'semantic', text: name, meta })
      // Stamp the sources so the same pattern is never re-authored. Best-effort —
      // a missed stamp only risks a duplicate next sweep, not data loss.
      if (canPatch) {
        for (const m of cand.members) {
          try {
            await ctx.memory.patchMeta!(m.id, { [META_PROCEDURIZED]: proc.id })
          } catch {
            /* best-effort idempotency stamp */
          }
        }
      }
      authored++
    }

    if (authored === 0) return {}
    return { summary: `authored ${authored} skill(s)` }
  }
}

// ---------------------------------------------------------------------------
// ③ Umbrella consolidation — sweep ACTIVE skills, merge redundant clusters into
// one master, CLOSE (not delete) the originals and back-link them to it.
// ---------------------------------------------------------------------------

/** Default cap on semantic entries scanned per Umbrella sweep (cost guard). */
export const DEFAULT_SKILLS_SCAN = 200

/** Default system prompt steering the aux model to MERGE a redundant cluster into one master skill. */
export const DEFAULT_MERGE_SYSTEM =
  'You are a skill librarian. You are shown several procedures that are REDUNDANT ' +
  '— they accomplish the SAME goal in slightly different ways. Merge them into ONE ' +
  'master skill: a single clear one-line NAME and the unified ordered STEPS ' +
  '(deduplicate, keep the best ordering, cover what all of them did). Output the ' +
  'merged name and steps.'

/**
 * The active skills the butler "knows how to do" right now — `form:'procedure'`
 * entries that are bitemporally active at `now`. The host projects exactly this set
 * into `SKILL.md`; recall's "things I know how to do" section filters identically,
 * so a closed (merged-away) original drops out of both for free.
 */
export function activeProcedures(entries: readonly MemoryEntry[], now: number): MemoryEntry[] {
  return entries.filter((e) => isProcedure(e) && isActive(e, now))
}

export interface UmbrellaReviewerOptions {
  /** Aux model that merges a redundant cluster into one master name+steps. */
  merge: ProcedureDrafter
  /** Min similarity (symmetric term-overlap) two skills need to be "redundant". */
  minSimilarity?: number
  /** Min cluster size to merge (a redundant PAIR is enough). Default {@link DEFAULT_UMBRELLA_MIN_CLUSTER}. */
  minCluster?: number
  /** Max clusters merged per sweep. Default {@link DEFAULT_SKILLS_MAX_CANDIDATES}. */
  maxClusters?: number
  /** Max semantic entries scanned for active procedures. Default {@link DEFAULT_SKILLS_SCAN}. */
  maxScan?: number
  /** Scope to one namespace (per-user no-leak). */
  filter?: (entry: MemoryEntry) => boolean
  /** Meta merged into every umbrella procedure (e.g. `{ user: 'alice' }`). */
  procedureMeta?: Record<string, unknown>
  /** Aux-model system prompt override. */
  system?: string
}

/**
 * Umbrella consolidation as a {@link MemoryReviewer} (heartbeat pass). Each sweep:
 *   1. fetches the ACTIVE procedures (recall semantic, filter `isProcedure && isActive`);
 *   2. clusters the REDUNDANT ones ({@link clusterBySimilarity}, `minCluster >= 2`);
 *   3. for each cluster, asks the aux model to MERGE it into one master skill;
 *   4. writes the umbrella procedure FIRST (crash-safe — see below), then CLOSES
 *      each original via {@link closedMeta} (`validTo = now`), stamps `supersedes`
 *      → the umbrella, and back-LINKS it to the umbrella (E). The closed originals
 *      drop out of `activeProcedures` / recall automatically — the "SQLite repoint"
 *      is free from D.
 *
 * Converged (no redundant cluster) → `{}`. Idempotent: after a merge the originals
 * are closed, so next sweep the cluster shrinks to just the umbrella (size 1 < 2)
 * and nothing re-merges.
 *
 * Crash-safety: the umbrella is written BEFORE the originals are closed. A crash in
 * between leaves the originals active alongside the umbrella; the next sweep simply
 * re-clusters and re-merges them (converging), never losing a skill.
 *
 * Requires `patchMeta` (the meta-amend seam) — without it we'd create a duplicate
 * ACTIVE umbrella we couldn't retire the originals against, so we refuse and no-op.
 */
export function umbrellaReviewer(opts: UmbrellaReviewerOptions): MemoryReviewer {
  return async (ctx: ReviewContext): Promise<ReviewOutcome> => {
    const canPatch = typeof ctx.memory.patchMeta === 'function'
    if (!canPatch) return {} // can't retire originals → don't strand a duplicate active umbrella

    const maxScan = Math.max(1, Math.floor(numOr(opts.maxScan, DEFAULT_SKILLS_SCAN)))
    const semantic = await ctx.memory.recall({ kinds: ['semantic'], k: maxScan })
    const active = activeProcedures(semantic, ctx.now)
    const procs = opts.filter ? active.filter(opts.filter) : active

    const clusters = clusterBySimilarity(procs, {
      ...(opts.minSimilarity !== undefined ? { minSimilarity: opts.minSimilarity } : {}),
      minSize: Math.max(2, Math.floor(numOr(opts.minCluster, DEFAULT_UMBRELLA_MIN_CLUSTER))),
      maxClusters: Math.max(1, Math.floor(numOr(opts.maxClusters, DEFAULT_SKILLS_MAX_CANDIDATES))),
    })
    if (clusters.length === 0) return {}

    let merged = 0
    for (const cluster of clusters) {
      let drafted: DraftedProcedure
      try {
        drafted = await opts.merge({
          system: opts.system ?? DEFAULT_MERGE_SYSTEM,
          user: buildMergePrompt(cluster),
        })
      } catch {
        continue // aux model failed on this cluster — leave it active, try the next
      }
      const name = (drafted.name ?? '').trim()
      const steps = cleanSteps(drafted.steps)
      if (!name || steps.length === 0) continue // unusable merge → leave the cluster intact

      const meta: Record<string, unknown> = {
        ...(opts.procedureMeta ?? {}),
        [META_FORM]: FORM_PROCEDURE,
        [META_STEPS]: steps,
        [META_UMBRELLA]: true,
        mergedAt: ctx.now,
      }
      // Write the umbrella BEFORE closing the originals (crash-safe ordering).
      const umbrella = await ctx.memory.remember({ kind: 'semantic', text: name, meta })
      for (const orig of cluster) {
        try {
          await ctx.memory.patchMeta!(orig.id, {
            ...closedMeta(orig.meta, ctx.now),
            [META_SUPERSEDES]: umbrella.id,
            [META_LINKS]: mergeLinks(linksOf(orig), [umbrella.id], orig.id),
          })
        } catch {
          // Best-effort: a straggler stays active and the next sweep re-merges it
          // with the umbrella (converging) — never a lost skill.
        }
      }
      merged++
    }

    if (merged === 0) return {}
    return { summary: `merged ${merged} skill cluster(s)` }
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** A stable label hash of a cluster's shared term shape (intersection, sorted). */
function clusterSignature(members: readonly MemoryEntry[]): string {
  if (members.length === 0) return djb2('')
  let shared: Set<string> | null = null
  for (const m of members) {
    const terms = new Set(extractTerms(m.text))
    if (shared === null) {
      shared = terms
    } else {
      for (const t of [...shared]) if (!terms.has(t)) shared.delete(t)
    }
  }
  const sig = [...(shared ?? new Set<string>())].sort()
  // Fall back to the first member's terms when nothing is common to ALL members
  // (pairwise-similar but no global overlap) — still a deterministic label.
  const basis = sig.length > 0 ? sig : [...new Set(extractTerms(members[0]!.text))].sort()
  return djb2(basis.join('|'))
}

function buildAuthorPrompt(members: readonly MemoryEntry[]): string {
  const parts: string[] = [`[${members.length} past episodes that follow the same procedure (oldest first)]`]
  for (const e of [...members].sort((a, b) => a.ts - b.ts)) {
    parts.push(`- ${e.text}`)
  }
  parts.push('', 'Output the skill: a one-line name and the ordered steps.')
  return parts.join('\n')
}

/** Render a redundant skill cluster for the aux merge model: each skill's name + steps. */
function buildMergePrompt(cluster: readonly MemoryEntry[]): string {
  const parts: string[] = [`[${cluster.length} redundant skills to merge into one master skill]`]
  for (const p of cluster) {
    parts.push(`## ${p.text}`)
    for (const s of stepsOf(p)) parts.push(`- ${s}`)
  }
  parts.push('', 'Output the merged master skill: a one-line name and the unified ordered steps.')
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

/** Re-export so callers building "skills I know" views don't reach two modules. */
export { isProcedure }
