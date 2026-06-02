import { readdir, rm } from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileStorage } from '../../src/storage/file.js'
import type { TranscriptEntry } from '../../src/types.js'

/**
 * Route B P0-M2 (M2b) — archive / prune. Old sealed segments move into
 * `archive/`, out of the active load path, so boot load shrinks to the
 * retained segments (O(tail)) while audit is preserved (loadAll merges archive
 * + active by global seq). These pin: keepLast bounds the active load, archived
 * seqs leave loadTranscript but survive in loadAll, segment numbers never reuse
 * across the archive boundary, `before` archives only fully-older segments, and
 * empty options are a no-op. Each guard is falsifiable.
 */

// ~95 bytes/entry; a 50-byte cap seals after every entry → 1 entry per segment,
// giving deterministic segment boundaries for the assertions below.
const PER_ENTRY = 50

function entry(seq: number, ts = 1_000 + seq): TranscriptEntry {
  return {
    seq,
    ts,
    kind: 'participant_joined',
    data: { id: `p-${seq}`, participantKind: 'agent', capabilities: ['x'] },
  }
}

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aipe-arch-'))
  path = join(dir, 'transcript.jsonl')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function write(entries: TranscriptEntry[], cap = PER_ENTRY): Promise<void> {
  const fs = new FileStorage(path, undefined, cap)
  for (const e of entries) await fs.appendTranscriptEntry(e)
  await fs.close()
}
async function archiveCount(): Promise<number> {
  const adir = join(dir, 'archive')
  if (!existsSync(adir)) return 0
  return (await readdir(adir)).filter((n) => /^transcript-\d+\.jsonl$/.test(n)).length
}

describe('FileStorage archive / prune (Route B P0-M2 M2b)', () => {
  it('keepLast bounds the active load while loadAll preserves the full audit', async () => {
    await write(Array.from({ length: 8 }, (_, i) => entry(i + 1)))

    // 8 entries at a 1-entry cap ⇒ 7 sealed segments + active(e8). keepLast:2
    // protects the two newest sealed (e6, e7) ⇒ 5 archived (e1..e5).
    const moved = await new FileStorage(path, undefined, PER_ENTRY).archiveSegments({
      keepLast: 2,
    })
    expect(moved.length).toBe(5)
    expect(await archiveCount()).toBe(moved.length)

    const store = new FileStorage(path, undefined, PER_ENTRY)
    const active = await store.loadTranscript()
    const full = await store.loadAll()
    // Boot load is bounded to the retained tail (the kept segments + active),
    // and the kept ones are the NEWEST — not an arbitrary subset.
    expect(active.map((e) => e.seq)).toEqual([6, 7, 8])
    expect(full.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('archived seqs leave the active load but remain in loadAll', async () => {
    await write(Array.from({ length: 6 }, (_, i) => entry(i + 1)))
    await new FileStorage(path, undefined, PER_ENTRY).archiveSegments({ keepLast: 1 })

    const store = new FileStorage(path, undefined, PER_ENTRY)
    const activeSeqs = new Set((await store.loadTranscript()).map((e) => e.seq))
    const archivedSeqs = (await store.loadArchivedSegments()).map((e) => e.seq)

    expect(archivedSeqs.length).toBeGreaterThan(0)
    for (const s of archivedSeqs) expect(activeSeqs.has(s)).toBe(false) // excluded from boot
    const allSeqs = (await store.loadAll()).map((e) => e.seq)
    for (const s of archivedSeqs) expect(allSeqs).toContain(s) // preserved in audit
  })

  it('segment numbers never reuse across the archive boundary', async () => {
    await write(Array.from({ length: 5 }, (_, i) => entry(i + 1)))
    // Archive every sealed segment (keep none).
    const moved = await new FileStorage(path, undefined, PER_ENTRY).archiveSegments({
      keepLast: 0,
    })
    const archivedMax = Math.max(...moved.map((n) => Number(/(\d+)/.exec(n)![1])))

    // Now append more — the new seals must take numbers ABOVE the archived max,
    // never colliding with an archived filename.
    const fs2 = new FileStorage(path, undefined, PER_ENTRY)
    for (let i = 6; i <= 9; i++) await fs2.appendTranscriptEntry(entry(i))
    await fs2.close()

    const newSealed = (await readdir(dir))
      .filter((n) => /^transcript-\d+\.jsonl$/.test(n))
      .map((n) => Number(/(\d+)/.exec(n)![1]))
    expect(Math.min(...newSealed)).toBeGreaterThan(archivedMax)

    const allSeqs = (await new FileStorage(path, undefined, PER_ENTRY).loadAll()).map(
      (e) => e.seq,
    )
    expect(allSeqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]) // no dupes, full order
  })

  it('`before` archives only segments fully older than the cutoff', async () => {
    // seqs 1-3 are old (ts ~1000s), 4-6 are recent (ts ~9000s).
    await write([
      entry(1, 1_000),
      entry(2, 1_001),
      entry(3, 1_002),
      entry(4, 9_000),
      entry(5, 9_001),
      entry(6, 9_002),
    ])

    await new FileStorage(path, undefined, PER_ENTRY).archiveSegments({ before: 5_000 })

    const store = new FileStorage(path, undefined, PER_ENTRY)
    // Only the old segments were archived; the recent ones still load on boot.
    expect((await store.loadArchivedSegments()).map((e) => e.seq)).toEqual([1, 2, 3])
    expect((await store.loadTranscript()).map((e) => e.seq)).toEqual([4, 5, 6])
  })

  it('empty options are a no-op (an explicit policy is required)', async () => {
    await write(Array.from({ length: 5 }, (_, i) => entry(i + 1)))
    const moved = await new FileStorage(path, undefined, PER_ENTRY).archiveSegments()
    expect(moved).toEqual([])
    expect(await archiveCount()).toBe(0)
  })

  it('loadAll equals loadTranscript when nothing has been archived', async () => {
    await write(Array.from({ length: 5 }, (_, i) => entry(i + 1)))
    const store = new FileStorage(path, undefined, PER_ENTRY)
    expect((await store.loadAll()).map((e) => e.seq)).toEqual(
      (await store.loadTranscript()).map((e) => e.seq),
    )
  })
})
