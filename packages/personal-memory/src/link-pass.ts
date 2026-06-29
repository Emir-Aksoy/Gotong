/**
 * link-pass.ts — the I/O half of associative linking (decision E, E-M2).
 *
 * `links.ts` is pure: it computes WHICH entries relate. This module APPLIES that
 * over a live `MemoryHandle` on a heartbeat tick — recall the eligible ad-hoc
 * set, build the symmetric link closure, and persist the grown links via an
 * injected {@link MemoryLinkWriter}.
 *
 * # A standalone pass, not bolted onto reconcile (why)
 *
 * Facts enter durable memory three ways — the `remember` tool, reconcile ADD,
 * and consolidation. Rather than thread linking into each write path (and risk
 * reconcile's write-before-delete crash-safety, and the byte-identical guarantee
 * of its tests), linking is ONE periodic pass over the stored set, exactly like
 * {@link reconcileReviewer} dedups regardless of how a fact arrived. It links
 * whatever is there, from any source, uniformly — simpler and lower-risk than
 * entangling three write paths.
 *
 * # Why an injected writer (the seam)
 *
 * Bidirectional links must patch ESTABLISHED entries' `meta.links` while
 * preserving their id / ts / text — but `MemoryHandle` has no meta-only update
 * (reconcile's "update" is remember+forget, which mints a new id/ts and would
 * move the frozen block). So the leaf computes the updates and hands them to a
 * {@link MemoryLinkWriter} the host wires to a file-backed in-place patch (Z-M1),
 * mirroring F-M3's `MemoryReinforcer`. Default = no writer = this never runs
 * (opt-in; existing behavior byte-identical).
 *
 * Idempotent + cheap on steady state: {@link diffLinkUpdates} emits only entries
 * whose link set grew, so a converged memory produces zero writes per tick.
 */

import type { MemoryEntry, MemoryHandle, MemoryKind } from '@aipehub/services-sdk'

import {
  buildLinkGraph,
  diffLinkUpdates,
  type BuildLinkGraphOptions,
  type LinkScorer,
  type LinkUpdate,
} from './links.js'
import type { MemoryReviewer, ReviewContext, ReviewOutcome } from './review.js'
import { isClusterProfile, isDigest } from './tiers.js'

/** Window pulled when scanning the stored set for a link pass. */
export const LINK_RECALL_WINDOW = 200
/** Heartbeat linking fires once the eligible set reaches this size. */
export const DEFAULT_LINK_TRIGGER_ENTRIES = 4

/**
 * Persist grown link lists in place — patch each entry's `meta.links` WITHOUT
 * changing its id / ts / text (so the frozen block never moves). The host wires
 * a file-backed implementation in Z-M1; tests pass a fake. Best-effort: a throw
 * is swallowed by {@link linkPass} so a write failure never aborts the tick.
 */
export type MemoryLinkWriter = (updates: ReadonlyArray<LinkUpdate>) => void | Promise<void>

export interface LinkPassOptions extends BuildLinkGraphOptions {
  /** The memory to link over. */
  memory: MemoryHandle
  /** Applies the computed link updates (the file-backed patch lives here). */
  write: MemoryLinkWriter
  /** Scope the stored set to one namespace (per-user no-leak). */
  filter?: (entry: MemoryEntry) => boolean
  /** Which kind to link. Default `'semantic'`. */
  kind?: MemoryKind
  /**
   * Which stored entries are eligible to link. Default for `semantic`: ad-hoc
   * facts only (NOT cluster digests / profiles — tiered-owned). Other kinds: all.
   */
  existingFilter?: (entry: MemoryEntry) => boolean
  /** Max stored entries pulled. Default {@link LINK_RECALL_WINDOW}. */
  recallK?: number
}

export interface LinkPassResult {
  /** How many entries had their link set grown (and were handed to the writer). */
  readonly linked: number
}

/**
 * Run one linking pass: recall the eligible set, build the symmetric link
 * closure, and write the entries whose links grew. Returns `null` when there is
 * nothing to link (fewer than two eligible entries — a single fact has no peer).
 * Never throws on a writer hiccup (best-effort).
 */
export async function linkPass(opts: LinkPassOptions): Promise<LinkPassResult | null> {
  const eligible = await pullEligible(opts)
  if (eligible.length < 2) return null

  const graph = buildLinkGraph(eligible, graphOptions(opts))
  const updates = diffLinkUpdates(eligible, graph)
  if (updates.length === 0) return { linked: 0 }

  try {
    await opts.write(updates)
  } catch {
    return { linked: 0 } // best-effort: a failed write never breaks the tick
  }
  return { linked: updates.length }
}

/**
 * Adapt {@link linkPass} to a {@link MemoryReviewer}: each heartbeat tick links
 * the ad-hoc set once it reaches `triggerEntries` (default
 * {@link DEFAULT_LINK_TRIGGER_ENTRIES}). Returns a one-line summary when it grew
 * any links, else `{}` (idle / `HEARTBEAT_OK`). Compose it alongside the
 * reconcile / budget reviewers (Z-M1).
 */
export function linkReviewer(
  opts: Omit<LinkPassOptions, 'memory'> & { triggerEntries?: number },
): MemoryReviewer {
  const trigger = Math.max(2, Math.floor(opts.triggerEntries ?? DEFAULT_LINK_TRIGGER_ENTRIES))
  return async (ctx: ReviewContext): Promise<ReviewOutcome> => {
    const eligible = await pullEligible({ ...opts, memory: ctx.memory })
    if (eligible.length < trigger) return {}
    const r = await linkPass({ ...opts, memory: ctx.memory })
    if (!r || r.linked === 0) return {}
    return { summary: `linked: ${r.linked} ${r.linked === 1 ? 'entry' : 'entries'}` }
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

async function pullEligible(
  opts: Pick<LinkPassOptions, 'memory' | 'filter' | 'kind' | 'existingFilter' | 'recallK'>,
): Promise<MemoryEntry[]> {
  const kind: MemoryKind = opts.kind ?? 'semantic'
  const k = opts.recallK ?? LINK_RECALL_WINDOW
  const all = await opts.memory.recall({ kinds: [kind], k })
  const scoped = opts.filter ? all.filter((e) => opts.filter!(e)) : all
  const eligible = opts.existingFilter ?? defaultExistingFilter(kind)
  return scoped.filter(eligible)
}

/** Default eligibility: for `semantic`, ad-hoc facts only (skip tiered digest/
 *  profile); for any other kind, all of it. */
function defaultExistingFilter(kind: MemoryKind): (e: MemoryEntry) => boolean {
  if (kind !== 'semantic') return () => true
  return (e) => !isDigest(e) && !isClusterProfile(e)
}

function graphOptions(opts: LinkPassOptions): BuildLinkGraphOptions {
  const o: BuildLinkGraphOptions = {}
  if (opts.topK !== undefined) o.topK = opts.topK
  if (opts.minScore !== undefined) o.minScore = opts.minScore
  if (opts.scorer !== undefined) o.scorer = opts.scorer as LinkScorer
  return o
}
