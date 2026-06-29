/**
 * bitemporal.ts — validity intervals for memory (decision D).
 *
 * "Lived in KL" → "moved to Penang" should not OVERWRITE the old fact: both are
 * true, just at different times. Bitemporal memory keeps the history — each fact
 * carries a validity interval, and a supersession is a TIME-EDGE (close the old
 * interval, open a new one) rather than a destructive delete. A future "where
 * did I used to live?" can still be answered.
 *
 *   meta.validFrom    when the fact started being true (ms; absent = "always")
 *   meta.validTo      when it stopped (ms; absent = still true / open interval)
 *   meta.supersedes   id of the fact this one replaced (the time-edge back-link)
 *
 * Like every other enhancement these are free-form `meta`, NO schema change.
 *
 * # Opt-in, default OFF (locked decision)
 *
 * The whole feature is opt-in: with no validity meta an entry is simply ALWAYS
 * active ({@link isActive} returns true), so legacy data and the default
 * overwrite/true-delete reconcile behave exactly as before — byte-identical.
 * D-M1 wires the reconcile opt-in; D-M2 filters recall / the frozen block to the
 * active slice; D-M3 lets the budget evict closed intervals first.
 *
 * # Deterministic half (no LLM)
 *
 * Pure accessors + two meta transforms ({@link openedMeta} / {@link closedMeta}).
 * The handle has no meta-only update, so closing an interval in place is done by
 * an injected writer the host wires to a file-backed patch — same seam as
 * F-M3's reinforcer and E-M2's link writer.
 */

import type { MemoryEntry } from '@aipehub/services-sdk'

/** Meta key: when a fact started being true (ms epoch). Absent = "always". */
export const META_VALID_FROM = 'validFrom'

/** Meta key: when a fact stopped being true (ms epoch). Absent = open interval. */
export const META_VALID_TO = 'validTo'

/** Meta key: the id of the fact this one superseded (the time-edge back-link). */
export const META_SUPERSEDES = 'supersedes'

/**
 * Close an entry's validity interval IN PLACE by stamping `meta.validTo` — the
 * pure transform a host applies via a file-backed patch (the handle has no
 * meta-only update). See {@link MemoryValidityWriter}.
 */
export type MemoryValidityWriter = (entry: MemoryEntry, validTo: number) => void | Promise<void>

function readTs(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** The `validFrom` stamp (ms), or `undefined` when absent / not a finite number. */
export function validFromOf(e: MemoryEntry): number | undefined {
  return readTs((e.meta as { validFrom?: unknown } | undefined)?.validFrom)
}

/** The `validTo` stamp (ms), or `undefined` when absent / not a finite number. */
export function validToOf(e: MemoryEntry): number | undefined {
  return readTs((e.meta as { validTo?: unknown } | undefined)?.validTo)
}

/** The id this entry superseded, or `undefined`. */
export function supersedesOf(e: MemoryEntry): string | undefined {
  const s = (e.meta as { supersedes?: unknown } | undefined)?.supersedes
  return typeof s === 'string' && s.length > 0 ? s : undefined
}

/** Whether the entry's interval has been CLOSED (a `validTo` is stamped). */
export function isClosed(e: MemoryEntry): boolean {
  return validToOf(e) !== undefined
}

/**
 * Whether the entry's interval is closed AND already in the past at `now`
 * (`validTo <= now`) — i.e. dead history, the safest thing to evict under disk
 * pressure (D-M3). Distinct from the false case of {@link isActive}: a
 * not-yet-valid FUTURE fact (`validFrom > now`, no `validTo`) is inactive but
 * NOT expired — evicting a deliberately-scheduled future fact would lose intent.
 */
export function isExpired(e: MemoryEntry, now: number): boolean {
  const to = validToOf(e)
  return to !== undefined && now >= to
}

/**
 * Whether `e` is in effect at `now`. An entry with no validity meta is ALWAYS
 * active (so legacy data and non-bitemporal memory are unaffected). Otherwise
 * active iff `validFrom <= now` (or absent) AND `now < validTo` (or absent) —
 * the interval is half-open `[validFrom, validTo)`.
 */
export function isActive(e: MemoryEntry, now: number): boolean {
  const from = validFromOf(e)
  if (from !== undefined && now < from) return false // not yet in effect
  const to = validToOf(e)
  if (to !== undefined && now >= to) return false // interval already closed
  return true
}

/**
 * Meta for a newly-opened fact: stamp `validFrom` and, when it replaces another,
 * a `supersedes` back-link. Pure — merges onto `meta` without mutating it.
 */
export function openedMeta(
  meta: Record<string, unknown> | undefined,
  validFrom: number,
  supersedes?: string,
): Record<string, unknown> {
  return {
    ...(meta ?? {}),
    [META_VALID_FROM]: validFrom,
    ...(supersedes ? { [META_SUPERSEDES]: supersedes } : {}),
  }
}

/**
 * Meta for a closed fact: stamp `validTo`, preserving everything else. Pure —
 * the host applies this to the stored entry's meta in a file-backed patch.
 */
export function closedMeta(
  meta: Record<string, unknown> | undefined,
  validTo: number,
): Record<string, unknown> {
  return { ...(meta ?? {}), [META_VALID_TO]: validTo }
}
