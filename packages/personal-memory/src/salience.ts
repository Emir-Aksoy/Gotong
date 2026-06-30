/**
 * salience.ts — decay / reinforcement scoring (decision F).
 *
 * Generative-Agents memory ranks by recency + importance + relevance, where
 * recency is an exponential decay since last access and each access reinforces.
 * F brings that ONE deterministic scalar to the butler:
 *
 *   - low-importance, long-unrecalled entries FADE (their keep-value decays);
 *   - repeatedly-recalled entries STRENGTHEN (each recall lifts keep-value).
 *
 * # Where it is allowed to act — and where it is NOT
 *
 * `effectiveSalience` is a KEEP-VALUE used for **eviction** ranking (decision B's
 * `enforceBudget`, F-M2): higher = keep, lower = drop first. It is shared with B
 * exactly because both answer the same question — "what is least worth keeping".
 *
 * It MUST NOT enter the frozen block. The frozen block's order is the pure
 * set-function `compareByImportanceThenRecency` (the prompt-cache prefix
 * contract); a time-decaying score is by definition NOT a function of the entry
 * set alone (it moves with the clock), so letting it in would break byte
 * stability mid-session. So this module is imported by the eviction / recall
 * paths only — never by `frozen-block.ts`.
 *
 * # Opt-in, default byte-identical
 *
 * With no options (or no clock) `effectiveSalience` IS `importanceOf` — an
 * integer 1..5. So swapping the budget comparator's `importance` term for
 * `effectiveSalience` (F-M2) is a no-op until a host turns decay/reinforcement
 * on, and legacy data (no `recallCount` / `lastRecalledTs`) ranks exactly as
 * before. Pure, no LLM, trivially testable (北极星: 框架不跑 LLM).
 */

import type { MemoryEntry } from '@aipehub/services-sdk'

import { importanceOf, PIN_IMPORTANCE } from './importance.js'

/** Meta key: how many times this entry has been reinforced (recalled). */
export const META_RECALL_COUNT = 'recallCount'
/** Meta key: epoch ms of the most recent reinforcement (recall). */
export const META_LAST_RECALLED = 'lastRecalledTs'

/** A sensible default decay half-life: 30 days. */
export const DEFAULT_SALIENCE_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000

/** A sensible default reinforcement weight (per-recall log-scaled lift). */
export const DEFAULT_REINFORCE_WEIGHT = 0.5

export interface SalienceOptions {
  /**
   * Exponential decay half-life in ms. After this long with no recall an entry's
   * non-pin keep-value halves. Omit / ≤0 → NO time decay (the default).
   */
  halfLifeMs?: number
  /**
   * Per-recall reinforcement weight; keep-value is multiplied by
   * `1 + weight·log2(1 + recallCount)`. Omit / ≤0 → NO reinforcement (default).
   */
  reinforceWeight?: number
}

/** Read an entry's reinforcement count from meta (clamped ≥0, default 0). */
export function recallCountOf(entry: Pick<MemoryEntry, 'meta'>): number {
  const raw = (entry.meta as { recallCount?: unknown } | undefined)?.recallCount
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
}

/** Read an entry's last-recalled timestamp from meta, if present and valid. */
export function lastRecalledOf(entry: Pick<MemoryEntry, 'meta'>): number | undefined {
  const raw = (entry.meta as { lastRecalledTs?: unknown } | undefined)?.lastRecalledTs
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

/**
 * The deterministic keep-value of an entry.
 *
 * Default (no `now`, or no decay/reinforce option) → `importanceOf(entry)`, an
 * integer 1..5: byte-identical eviction ordering to pre-F.
 *
 * With decay/reinforcement configured:
 *   salience = importance × ageFactor × reinforceFactor
 *     ageFactor       = 0.5 ^ (age / halfLife)   — age since last recall (or write)
 *     reinforceFactor = 1 + weight·log2(1+recallCount)
 *
 * Pins (`importance === 5`) never fade (ageFactor forced to 1), so the "pin is
 * never auto-dropped" contract survives decay — a pinned fact always outranks any
 * decayed non-pin for keep-value. Reinforcement still applies to pins (can only
 * raise keep-value).
 */
export function effectiveSalience(
  entry: MemoryEntry,
  now?: number,
  opts?: SalienceOptions,
): number {
  const importance = importanceOf(entry)
  const halfLife = opts?.halfLifeMs
  const reinforceWeight = opts?.reinforceWeight
  const decayOn = typeof now === 'number' && typeof halfLife === 'number' && halfLife > 0
  const reinforceOn = typeof reinforceWeight === 'number' && reinforceWeight > 0

  // Neither signal configured → keep-value IS importance (pre-F ordering).
  if (!decayOn && !reinforceOn) return importance

  let s: number = importance
  if (decayOn && importance < PIN_IMPORTANCE) {
    const lastRef = lastRecalledOf(entry) ?? entry.ts
    const age = Math.max(0, now! - lastRef)
    s *= Math.pow(0.5, age / halfLife!)
  }
  if (reinforceOn) {
    s *= 1 + reinforceWeight! * Math.log2(1 + recallCountOf(entry))
  }
  return s
}

/**
 * Reinforce an entry IN META: bump `recallCount` and stamp `lastRecalledTs`.
 *
 * Returns a META DELTA — only the two keys it changes, NOT a re-spread of the
 * whole meta (mirrors its sibling `closedMeta`, which returns just `{validTo}`).
 * The caller applies it as a shallow merge onto the CURRENT stored meta: the
 * host's `patchMeta` and the example's `DemoMemory.patchMeta` both do exactly
 * that. Returning a delta is the correctness fix — re-spreading `entry.meta`
 * would write back the reinforcer's possibly-stale snapshot of every other key
 * (importance, links, validity…), clobbering whatever another writer changed in
 * between. A delta touches only what it owns. Pure, never mutates the input.
 *
 * `recallCountOf(entry)` reads the prior count off the passed entry, so the
 * caller must hand in the up-to-date entry (the merge target) for the bump to
 * accumulate.
 */
export function reinforcedMeta(
  entry: Pick<MemoryEntry, 'meta'>,
  now: number,
): Record<string, unknown> {
  return {
    [META_RECALL_COUNT]: recallCountOf(entry) + 1,
    [META_LAST_RECALLED]: now,
  }
}
