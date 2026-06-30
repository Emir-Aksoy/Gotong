/**
 * In-memory `MemoryHandle` for unit tests. Mirrors the file backend's
 * semantics closely enough (substring recall, newest-first, per-kind filter)
 * without touching disk. `recallCount` proves the session memoizes.
 */

import type {
  MemoryEntry,
  MemoryHandle,
  MemoryKind,
  MemoryQuery,
  NewMemoryEntry,
} from '@aipehub/services-sdk'

export interface FakeMemory extends MemoryHandle {
  /** Live view of stored entries. */
  readonly entries: readonly MemoryEntry[]
  /** How many times `recall` has run — proves frozen-block memoization. */
  readonly recallCount: number
}

export function makeFakeMemory(seed: readonly MemoryEntry[] = []): FakeMemory {
  const entries: MemoryEntry[] = [...seed]
  let seq = 0
  let recallCount = 0

  return {
    get entries() {
      return entries
    },
    get recallCount() {
      return recallCount
    },
    async recall(q: MemoryQuery): Promise<MemoryEntry[]> {
      recallCount++
      const text = q.text ? q.text.toLowerCase() : undefined
      const kinds = q.kinds
      const since = q.since ?? 0
      const k = q.k ?? 20
      return entries
        .filter((e) => !kinds || kinds.includes(e.kind))
        .filter((e) => e.ts >= since)
        .filter((e) => !text || e.text.toLowerCase().includes(text))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, k)
    },
    async remember(ne: NewMemoryEntry): Promise<MemoryEntry> {
      seq++
      const e: MemoryEntry = {
        id: ne.id ?? `m${seq}`,
        kind: ne.kind,
        text: ne.text,
        ts: 1000 + seq,
        ...(ne.meta !== undefined ? { meta: ne.meta } : {}),
      }
      entries.push(e)
      return e
    },
    async list(opts: { kind?: MemoryKind; limit?: number } = {}): Promise<MemoryEntry[]> {
      const kind = opts.kind
      return entries
        .filter((e) => !kind || e.kind === kind)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, opts.limit ?? 100)
    },
    async forget(id: string): Promise<void> {
      const i = entries.findIndex((e) => e.id === id)
      if (i >= 0) entries.splice(i, 1)
    },
    // Mirror the file backend's in-place meta amend (Z-M1): shallow-merge `patch`
    // over the stored meta, preserving id/kind/text/ts, replacing the array slot so
    // the live `entries` view reflects it. Returns whether the id was found.
    async patchMeta(id: string, patch: Record<string, unknown>): Promise<boolean> {
      const i = entries.findIndex((e) => e.id === id)
      if (i < 0) return false
      const cur = entries[i]!
      entries[i] = { ...cur, meta: { ...(cur.meta ?? {}), ...patch } }
      return true
    },
    async clear(kind?: MemoryKind): Promise<void> {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (!kind || entries[i]!.kind === kind) entries.splice(i, 1)
      }
    },
  }
}

/** Terse entry constructor for seeds. Optional `meta` carries importance/tier. */
export function entry(
  id: string,
  kind: MemoryKind,
  text: string,
  ts: number,
  meta?: Record<string, unknown>,
): MemoryEntry {
  return { id, kind, text, ts, ...(meta !== undefined ? { meta } : {}) }
}
