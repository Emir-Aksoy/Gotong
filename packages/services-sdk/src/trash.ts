/**
 * Trash — soft-delete bookkeeping.
 *
 * When the Hub calls `plugin.softDelete(owner)` the plugin returns a
 * {@link TrashRef} that identifies the trashed bundle. The Hub stores
 * the ref in its own registry; the plugin stores it inside the
 * payload directory as `meta.json`. Either side losing its half is
 * recoverable from the other.
 *
 * Per RFC §18 question 2 (sign-off Q3=A "告知 + 30 天"):
 *   - `id` is a hash, not a uuid. Same (type, impl, owner, bucket)
 *     deterministically produces the same id, so back-to-back soft
 *     deletes from a flaky admin click are idempotent.
 *   - `bucket` is `Math.floor(deletedAt / 86_400_000)` (UTC day). Two
 *     deletes on the same day collide → second is a no-op. Two on
 *     different days produce different ids — the older one stays
 *     trashed independently.
 */

import type { Owner } from './owner.js'

export interface TrashRef {
  /** Stable hash id. Deterministic for `(type, impl, owner, dayBucket)`. */
  readonly id: string
  readonly type: string
  readonly impl: string
  readonly ownerKind: Owner['kind']
  readonly ownerId: string
  /** Epoch ms when softDelete ran. */
  readonly deletedAt: number
  /**
   * Epoch ms after which a sweep promotes this to hard-delete.
   * Default = deletedAt + 30 days; configurable per space.
   */
  readonly expiresAt: number
  /** Free-form note: who did it, why. Surfaced to admin UI. */
  readonly reason?: string
}

/** Default retention window — 30 days, in ms. */
export const TRASH_DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** Day-bucket size for hash determinism. */
export const TRASH_BUCKET_MS = 24 * 60 * 60 * 1000

/**
 * Compute the deterministic id for a trash entry.
 *
 * SHA-256 of `type|impl|kind|id|dayBucket`, first 16 hex chars. We
 * pick 16 (= 64 bits) — collision-resistant enough for an interactive
 * trash bin (≪ 2^32 entries) while staying short enough to read.
 *
 * Truncation tradeoff: a full hash is 64 chars, hard to glance at; 16
 * fits an admin UI column without wrapping and matches git's default
 * short-hash length, which everyone already trusts.
 */
export async function trashId(input: {
  type: string
  impl: string
  owner: Owner
  /** Epoch ms. Bucketed to the day at hash time. */
  deletedAt: number
}): Promise<string> {
  const bucket = Math.floor(input.deletedAt / TRASH_BUCKET_MS)
  const material = [
    input.type,
    input.impl,
    input.owner.kind,
    input.owner.id,
    String(bucket),
  ].join('|')
  const hex = await sha256Hex(material)
  return hex.slice(0, 16)
}

/** Build a complete {@link TrashRef} with computed id + expiry. */
export async function makeTrashRef(input: {
  type: string
  impl: string
  owner: Owner
  deletedAt: number
  retentionMs?: number
  reason?: string
}): Promise<TrashRef> {
  const id = await trashId(input)
  const retention = input.retentionMs ?? TRASH_DEFAULT_RETENTION_MS
  const ref: TrashRef = {
    id,
    type: input.type,
    impl: input.impl,
    ownerKind: input.owner.kind,
    ownerId: input.owner.id,
    deletedAt: input.deletedAt,
    expiresAt: input.deletedAt + retention,
  }
  if (input.reason !== undefined) {
    return { ...ref, reason: input.reason }
  }
  return ref
}

/** True iff `now` is past the ref's `expiresAt`. */
export function isExpired(ref: TrashRef, now: number): boolean {
  return now >= ref.expiresAt
}

// --- internal ---------------------------------------------------------

async function sha256Hex(input: string): Promise<string> {
  // Node 20+ has `crypto.subtle`. We avoid a static import of 'node:crypto'
  // so this file stays runnable in any ESM environment (workers, deno).
  const data = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(buf)
  let out = ''
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0')
  }
  return out
}
