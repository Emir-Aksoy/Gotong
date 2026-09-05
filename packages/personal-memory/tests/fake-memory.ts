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
} from '@gotong/services-sdk'
import { VerifiedSkills } from '../src/verified-skills.js'

/** Rendering fixtures use the actual lifecycle, not hand-forged passed metadata. */
export async function publishedFixture(id: string, name: string, ts: number, steps: string[], meta: Record<string, unknown> = {}): Promise<MemoryEntry> {
  const memory = makeFakeMemory([entry('source', 'episodic', 'source episode', 0)])
  const skills = new VerifiedSkills({ memory, userId: 'fixture-owner', runner: async () => ({ output: 'fixture', model: 'fixture-v1' }) })
  const c = await skills.create({ name, steps, sources: ['source'], conditions: ['fixture tasks'], counterexamples: ['other tasks'] }, meta)
  await skills.approveTests(c.id, [{ input: 'fixture input', expected: 'fixture' }])
  await skills.verify(c.id)
  await skills.publish(c.id)
  return { ...await skills.get(c.id), id, ts }
}

export interface FakeMemory extends MemoryHandle {
  /** Live view of stored entries. */
  readonly entries: readonly MemoryEntry[]
  /** How many times `recall` has run. */
  readonly recallCount: number
  /** How many times `list` has run — the frozen block fetches via `list`, so
   *  this proves frozen-block memoization (fetch exactly once per session). */
  readonly listCount: number
}

export function makeFakeMemory(seed: readonly MemoryEntry[] = []): FakeMemory {
  const entries: MemoryEntry[] = [...seed]
  let seq = 0
  let recallCount = 0
  let listCount = 0

  return {
    get entries() {
      return entries
    },
    get recallCount() {
      return recallCount
    },
    get listCount() {
      return listCount
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
      listCount++
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
