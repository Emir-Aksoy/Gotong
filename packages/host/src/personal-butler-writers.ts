/**
 * personal-butler-writers.ts — turn a patch-capable memory handle into the three
 * INJECTED meta writers the long-term memory engine needs (Z-M2).
 *
 * The memory enhancements that AMEND an established entry's meta — closing a
 * bitemporal validity interval (D), reinforcing a recalled fact (F), growing an
 * associative link set (E) — are leaf-package primitives that compute the new
 * meta but deliberately DON'T touch the filesystem. Each hands its result to an
 * injected writer (`MemoryValidityWriter` / `MemoryReinforcer` / `MemoryLinkWriter`),
 * so `@aipehub/personal-memory` stays framework-friendly (no I/O) and the host
 * decides how to persist. This module is that host decision: wire all three to
 * the file backend's in-place `patchMeta` (Z-M1).
 *
 * The actual meta TRANSFORM stays in the leaf package (`closedMeta`,
 * `reinforcedMeta`, `META_LINKS`) — one source of truth for which keys mean
 * what, no drift between "how the budget reads validTo" and "how the host
 * stamps it". This adapter only routes the computed patch to `patchMeta`, which
 * shallow-merges it (so a `{ validTo }` delta never clobbers `validFrom` /
 * `links` / `importance`).
 *
 * Default OFF: nothing calls these unless a reviewer / recall path is wired with
 * them (the example does so in Z-M4). With no writer the leaf behavior is
 * byte-identical to pre-enhancement.
 */

import {
  closedMeta,
  queryHitMeta,
  reinforcedMeta,
  META_LINKS,
  type MemoryLinkWriter,
  type MemoryQueryHitWriter,
  type MemoryReinforcer,
  type MemoryValidityWriter,
} from '@aipehub/personal-memory'
import type { MemoryHandle } from '@aipehub/services-sdk'

/** The four injected writers, all backed by one handle's `patchMeta`. */
export interface ButlerMemoryWriters {
  /** D: close a fact's validity interval in place (stamp `validTo`). */
  readonly closeEntry: MemoryValidityWriter
  /** F: bump a recalled fact's `recallCount` / `lastRecalledTs`. */
  readonly reinforcer: MemoryReinforcer
  /** E: persist grown associative link lists. */
  readonly linkWriter: MemoryLinkWriter
  /** MR2: record a recall query's fingerprint to grow a fact's query-diversity. */
  readonly queryHit: MemoryQueryHitWriter
}

/**
 * Build the butler's meta writers over a patch-capable {@link MemoryHandle}.
 *
 * Requires the backend to expose `patchMeta` (the file backend does, Z-M1) —
 * the in-place meta amend without which these can't be real. A handle without
 * it is a wiring bug, so throw rather than silently no-op (same fail-visible
 * stance as `openButlerMemory`'s empty-userId guard). All three return the
 * underlying write promise so callers that await ordering (reconcile retiring an
 * old fact after closing it; link-pass) actually wait.
 */
export function butlerMemoryWriters(handle: MemoryHandle): ButlerMemoryWriters {
  const raw = handle.patchMeta
  if (!raw) {
    throw new Error(
      'butlerMemoryWriters requires a memory backend with patchMeta (in-place meta update)',
    )
  }
  // Bind: the writers call it detached, but MemoryFileHandle.patchMeta uses `this`.
  const patchMeta = raw.bind(handle)

  return {
    // `closedMeta(undefined, validTo)` is just the `{ validTo }` delta; patchMeta
    // shallow-merges it, so the open interval's `validFrom` / links survive.
    closeEntry: (entry, validTo) => patchMeta(entry.id, closedMeta(undefined, validTo)).then(noop),
    // `reinforcedMeta(entry, now)` is just the `{ recallCount, lastRecalledTs }`
    // delta (same shape contract as closedMeta); patchMeta shallow-merges it, so
    // it lifts ONLY the two salience keys and never clobbers a concurrent writer.
    reinforcer: (entry, now) => patchMeta(entry.id, reinforcedMeta(entry, now)).then(noop),
    // Each update's `links` is already the merged superset (buildLinkGraph keeps
    // existing); replace the one key, leave the rest of meta untouched.
    linkWriter: (updates) =>
      Promise.all(updates.map((u) => patchMeta(u.id, { [META_LINKS]: u.links }))).then(noop),
    // `queryHitMeta` returns the `{ queryHits }` delta — or null when the
    // fingerprint is empty or already counted (idempotent: a re-asked query is
    // not a new write). Skip the patch on null so a repeated query is a no-op.
    queryHit: (entry, fingerprint) => {
      const delta = queryHitMeta(entry, fingerprint)
      return delta ? patchMeta(entry.id, delta).then(noop) : Promise.resolve()
    },
  }
}

function noop(): void {
  /* discard the patchMeta boolean — the writers resolve to void */
}
