/**
 * `review.ts` — the heartbeat-driven memory review loop (M2 / decision D5).
 *
 * # Where this sits
 *
 * Capture (`capture.ts`) writes raw episodic entries on every turn. Those pile
 * up. The **review** is the second honest hook point: on a Stream-D heartbeat
 * tick the butler (or a dedicated reviewer agent) wakes, looks at the recent
 * episodic backlog, and — when it's grown past a threshold — runs a reviewer
 * that distills it into the curated `semantic` profile.
 *
 * # M2 vs M3 split
 *
 * This file ships the **mechanism**: a `Participant` that, on each heartbeat
 * tick, recalls recent episodic memory, applies the trigger policy, and (when
 * due) calls an injectable {@link MemoryReviewer}. The **intelligence** — the
 * actual episodic→semantic distillation with forced-overflow semantics — is
 * `consolidate()` (M3), wired in as the reviewer. Keeping the seam here means
 * M2 is testable on its own (inject a fake reviewer, prove the wiring) and M3
 * drops in without touching the loop.
 *
 * # Heartbeat integration
 *
 * `MemoryReviewParticipant` is a normal target agent: the existing Stream-D
 * `HeartbeatParticipant` fires heartbeat tasks at it (no new scheduler, no new
 * table — decision v5 #1a). It honors the "don't bother me when idle"
 * convention by replying with exactly {@link HEARTBEAT_OK} when nothing needs
 * doing, so a quiet review makes no noise (the host suppresses `HEARTBEAT_OK`).
 */

import { AgentParticipant, type ParticipantId, type Task } from '@gotong/core'
import type { MemoryEntry, MemoryHandle } from '@gotong/services-sdk'

/**
 * Idle sentinel — byte-identical to Stream D's `HEARTBEAT_OK` so the host's
 * existing heartbeat suppression treats a quiet review as silence. Duplicated
 * (not imported from `@gotong/host`) because this leaf package must not
 * depend on the host; the value is a wire constant, not logic.
 */
export const HEARTBEAT_OK = 'HEARTBEAT_OK'

/** Default participant id for the review broker. */
export const MEMORY_REVIEW_ID: ParticipantId = 'gotong:memory-review'

/** Default episodic-backlog size that triggers a review. */
export const DEFAULT_REVIEW_MIN_EPISODIC = 8

/** Default number of recent episodic entries pulled per review. */
export const DEFAULT_REVIEW_RECALL_K = 100

export interface ReviewPolicy {
  /**
   * Minimum number of (filtered) episodic entries before a review fires.
   * Below this the tick is idle — capture is still cheap, no need to distill
   * a handful of entries yet. Default {@link DEFAULT_REVIEW_MIN_EPISODIC}.
   */
  minEpisodic?: number
}

/** What the reviewer is handed when a review fires. */
export interface ReviewContext {
  /** The memory handle to read/curate. */
  readonly memory: MemoryHandle
  /** Recent episodic entries that crossed the trigger, newest-first. */
  readonly episodic: MemoryEntry[]
  /** Wake time (injected clock for determinism). */
  readonly now: number
}

/** What a reviewer reports back after a review pass. */
export interface ReviewOutcome {
  /**
   * A one-line human-readable summary the heartbeat surfaces as `active`.
   * Omit / empty → the tick is reported as idle (`HEARTBEAT_OK`), so a
   * reviewer that decided there was nothing to do stays quiet.
   */
  summary?: string
  /** How many episodic entries were folded into the profile (M3 reports this). */
  consolidated?: number
}

/**
 * The pluggable review pass. M3 supplies `consolidate()`; tests supply a fake.
 * Absent → the participant only applies the trigger policy and never mutates
 * memory (honest M2 default: no consolidator wired = nothing to distill).
 */
export type MemoryReviewer = (ctx: ReviewContext) => Promise<ReviewOutcome> | ReviewOutcome

/**
 * Run several reviewers on one heartbeat tick, in order, merging their reports.
 * The memory-enhancement passes are independent — tiered consolidation
 * (episodic→digest→profile + budget), reconciliation (ad-hoc dedup), a
 * save-before-compact extraction — and a butler wants all of them on the same
 * heartbeat. This composes them into one {@link MemoryReviewer}.
 *
 * Each sub-reviewer self-gates (reconcile on its semantic count, budget on
 * bytes, tiered on its episodic trigger), so the coarse episodic gate on
 * {@link MemoryReviewParticipant} would otherwise STARVE the non-episodic ones:
 * when composing, set the participant's `policy.minEpisodic` low (e.g. 1) and
 * let each pass decide for itself whether to act.
 *
 * Best-effort: a throwing sub-reviewer is caught and surfaced as an error note
 * in the summary (so e.g. `semantic_overflow` is still visible) rather than
 * aborting the remaining passes — one bad pass never starves the others.
 */
export function composeReviewers(...reviewers: ReadonlyArray<MemoryReviewer>): MemoryReviewer {
  const list = reviewers.filter(Boolean)
  return async (ctx: ReviewContext): Promise<ReviewOutcome> => {
    const summaries: string[] = []
    let consolidated = 0
    for (const r of list) {
      try {
        const out = await r(ctx)
        const s = out.summary?.trim()
        if (s) summaries.push(s)
        if (typeof out.consolidated === 'number') consolidated += out.consolidated
      } catch (err) {
        summaries.push(`review error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (summaries.length === 0) return {}
    return { summary: summaries.join('; '), ...(consolidated > 0 ? { consolidated } : {}) }
  }
}

export interface MemoryReviewParticipantOptions {
  /** Participant id. Default {@link MEMORY_REVIEW_ID}. */
  id?: ParticipantId
  /** The memory to review. */
  memory: MemoryHandle
  /** The distillation pass. Omit for the policy-only M2 default. */
  reviewer?: MemoryReviewer
  /** Trigger policy. */
  policy?: ReviewPolicy
  /** How many recent episodic entries to pull per review. Default {@link DEFAULT_REVIEW_RECALL_K}. */
  recallK?: number
  /**
   * Optional predicate to scope which episodic entries count toward the
   * trigger (e.g. one user's namespace). Default: all episodic entries.
   */
  filter?: (entry: MemoryEntry) => boolean
  /** Clock injection for deterministic tests. */
  now?: () => number
}

/**
 * Heartbeat-driven memory reviewer. Each tick:
 *   1. recall recent `episodic` entries (optionally scoped by `filter`);
 *   2. if fewer than `minEpisodic` → reply `HEARTBEAT_OK` (idle, suppressed),
 *      and never call the reviewer;
 *   3. otherwise call the reviewer (when set) and surface its `summary` as the
 *      reply — or `HEARTBEAT_OK` when the reviewer reported nothing / none is
 *      wired.
 *
 * It is capability-less: only ever explicit-routed by id (the heartbeat
 * broker dispatches it), never capability-matched.
 */
export class MemoryReviewParticipant extends AgentParticipant {
  private readonly memory: MemoryHandle
  private readonly reviewer: MemoryReviewer | undefined
  private readonly minEpisodic: number
  private readonly recallK: number
  private readonly filter: ((entry: MemoryEntry) => boolean) | undefined
  private readonly clock: () => number

  constructor(opts: MemoryReviewParticipantOptions) {
    super({ id: opts.id ?? MEMORY_REVIEW_ID, capabilities: [] })
    this.memory = opts.memory
    this.reviewer = opts.reviewer
    this.minEpisodic = clampMin(opts.policy?.minEpisodic)
    this.recallK = clampRecall(opts.recallK)
    this.filter = opts.filter
    this.clock = opts.now ?? ((): number => Date.now())
  }

  /** A heartbeat tick (or a direct dispatch) runs one review pass. */
  protected override async handleTask(_task: Task): Promise<unknown> {
    return this.review()
  }

  /**
   * Run a single review pass. Returns the reply string the heartbeat layer
   * classifies: `HEARTBEAT_OK` for idle, a summary otherwise.
   *
   * Exposed (not just `handleTask`) so the host can drive a review from a
   * non-heartbeat path too (e.g. a manual "review now" admin action) without
   * synthesizing a fake Task.
   */
  async review(): Promise<string> {
    const all = await this.memory.recall({ kinds: ['episodic'], k: this.recallK })
    const episodic = this.filter ? all.filter((e) => this.filter!(e)) : all
    if (episodic.length < this.minEpisodic) return HEARTBEAT_OK
    if (!this.reviewer) return HEARTBEAT_OK

    const outcome = await this.reviewer({
      memory: this.memory,
      episodic,
      now: this.clock(),
    })
    const summary = outcome.summary?.trim()
    return summary && summary.length > 0 ? summary : HEARTBEAT_OK
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function clampMin(min: number | undefined): number {
  if (typeof min !== 'number' || !Number.isFinite(min) || min < 1) {
    return DEFAULT_REVIEW_MIN_EPISODIC
  }
  return Math.floor(min)
}

function clampRecall(k: number | undefined): number {
  if (typeof k !== 'number' || !Number.isFinite(k) || k < 1) return DEFAULT_REVIEW_RECALL_K
  return Math.min(Math.floor(k), 500)
}
