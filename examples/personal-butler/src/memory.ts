/**
 * A tiny in-memory `MemoryHandle` for the deterministic demo. Mirrors the file
 * backend's semantics (substring recall, newest-first, per-kind filter) without
 * touching disk. `all()` is an extra accessor for the demo's assertions.
 *
 * In production the butler's memory is a per-user, file-backed handle from the
 * host's memory service — nothing else about the butler changes.
 */

import type {
  MemoryEntry,
  MemoryHandle,
  MemoryKind,
  MemoryQuery,
  NewMemoryEntry,
} from '@aipehub/services-sdk'

export interface DemoMemory extends MemoryHandle {
  /** Snapshot of everything stored — for assertions only. */
  all(): MemoryEntry[]
}

export function inMemoryHandle(): DemoMemory {
  const entries: MemoryEntry[] = []
  let seq = 0

  return {
    all() {
      return entries.slice()
    },
    async recall(q: MemoryQuery): Promise<MemoryEntry[]> {
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
    async clear(kind?: MemoryKind): Promise<void> {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (!kind || entries[i]!.kind === kind) entries.splice(i, 1)
      }
    },
  }
}
