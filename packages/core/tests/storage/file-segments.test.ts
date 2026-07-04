import { appendFile, readdir, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileStorage } from '../../src/storage/file.js'
import type { TranscriptEntry } from '../../src/types.js'

/**
 * Route B P0-M2 (M1) — size-based transcript segmentation. The active file is
 * sealed into `transcript-NNNNNN.jsonl` when it grows past the cap; loading
 * concatenates sealed segments (oldest→newest) then the active file, so the
 * full transcript reads back in seq order. These pin: rotation actually splits
 * the file, the concatenation order is correct, a restart keeps numbering (no
 * clobber), a crash right after a seal loses nothing, and a non-positive cap
 * disables rotation (legacy single file). Each guard is falsifiable.
 */

function entry(seq: number): TranscriptEntry {
  return {
    seq,
    ts: 1_000 + seq,
    kind: 'participant_joined',
    data: { id: `p-${seq}`, participantKind: 'agent', capabilities: ['x'] },
  }
}

// ~95 bytes/entry, so a 150-byte cap rolls roughly every entry or two.
const TINY = 150

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gotong-seg-'))
  path = join(dir, 'transcript.jsonl')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function sealedSegments(): Promise<string[]> {
  return (await readdir(dir)).filter((n) => /^transcript-\d+\.jsonl$/.test(n)).sort()
}

describe('FileStorage segmentation (Route B P0-M2 M1)', () => {
  it('rolls sealed segments and loads the full transcript in seq order', async () => {
    const fs = new FileStorage(path, undefined, TINY)
    const all = Array.from({ length: 12 }, (_, i) => entry(i + 1))
    for (const e of all) await fs.appendTranscriptEntry(e)
    await fs.close()

    // The file actually split into multiple sealed segments.
    expect((await sealedSegments()).length).toBeGreaterThanOrEqual(2)

    // Concatenation = the full transcript in ascending seq order.
    const loaded = await new FileStorage(path, undefined, TINY).loadTranscript()
    expect(loaded.map((e) => e.seq)).toEqual(all.map((e) => e.seq))
  })

  it('orders sealed segments before the active file (not reversed)', async () => {
    const fs = new FileStorage(path, undefined, TINY)
    for (let i = 1; i <= 8; i++) await fs.appendTranscriptEntry(entry(i))
    await fs.close()

    const loaded = await new FileStorage(path, undefined, TINY).loadTranscript()
    // If the active file (newest, high seq) were read before the sealed
    // segments (oldest), this would not be sorted ascending.
    const seqs = loaded.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(seqs[seqs.length - 1]).toBe(8)
  })

  it('a restart keeps segment numbering — no clobber of existing segments', async () => {
    const fs1 = new FileStorage(path, undefined, TINY)
    for (let i = 1; i <= 6; i++) await fs1.appendTranscriptEntry(entry(i))
    await fs1.close()
    const afterFirst = (await sealedSegments()).length
    expect(afterFirst).toBeGreaterThanOrEqual(1)

    // Fresh instance over the same path (simulates a process restart).
    const fs2 = new FileStorage(path, undefined, TINY)
    for (let i = 7; i <= 12; i++) await fs2.appendTranscriptEntry(entry(i))
    await fs2.close()

    // New segments were added on top, none overwritten.
    expect((await sealedSegments()).length).toBeGreaterThan(afterFirst)
    const loaded = await new FileStorage(path, undefined, TINY).loadTranscript()
    expect(loaded.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('crash right after a seal (no active file) loses nothing and resumes', async () => {
    const fs = new FileStorage(path, undefined, TINY)
    for (let i = 1; i <= 5; i++) await fs.appendTranscriptEntry(entry(i))
    await fs.close()
    // Simulate a crash in the window after rename, before the next append:
    // the active file is gone, only sealed segments remain.
    await rm(path, { force: true })

    const loadedAfterCrash = await new FileStorage(path, undefined, TINY).loadTranscript()
    expect(loadedAfterCrash.length).toBeGreaterThanOrEqual(1)
    const seqsBefore = loadedAfterCrash.map((e) => e.seq)

    // A subsequent boot can keep appending; the recreated active file extends
    // the same monotonic sequence.
    const fs2 = new FileStorage(path, undefined, TINY)
    for (let i = 6; i <= 9; i++) await fs2.appendTranscriptEntry(entry(i))
    await fs2.close()
    const finalSeqs = (await new FileStorage(path, undefined, TINY).loadTranscript()).map(
      (e) => e.seq,
    )
    expect(finalSeqs).toEqual([...seqsBefore, 6, 7, 8, 9])
  })

  it('tolerates a corrupt trailing line in the active file with segments present', async () => {
    const fs = new FileStorage(path, undefined, TINY)
    for (let i = 1; i <= 6; i++) await fs.appendTranscriptEntry(entry(i))
    await fs.close()
    expect((await sealedSegments()).length).toBeGreaterThanOrEqual(1)

    // A crash leaves a partial line at the end of the active file.
    await appendFile(path, '{"seq":7,"ts":', 'utf8')

    const loaded = await new FileStorage(path, undefined, TINY).loadTranscript()
    expect(loaded.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('a non-positive cap disables rotation (legacy single file)', async () => {
    const fs = new FileStorage(path, undefined, 0)
    for (let i = 1; i <= 30; i++) await fs.appendTranscriptEntry(entry(i))
    await fs.close()

    expect(await sealedSegments()).toHaveLength(0)
    const loaded = await new FileStorage(path, undefined, 0).loadTranscript()
    expect(loaded).toHaveLength(30)
  })
})
