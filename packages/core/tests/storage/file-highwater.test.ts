import { existsSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileStorage } from '../../src/storage/file.js'
import { Transcript } from '../../src/transcript.js'
import type { TranscriptEntry } from '../../src/types.js'

/**
 * Route B P0-M2 (M3) — persisted high-water seq. Archiving moves old segments
 * out of the boot load path (M2b); if it moves *every* loadable entry away
 * (e.g. a crash left no active file, then retention archived all sealed
 * segments), boot's loadTranscript() returns [] and seq would reset to 0 —
 * reissuing numbers archived entries already own. A tiny `transcript.hwm`
 * checkpoint records the highest seq ever assigned so seq stays monotonic
 * across the archive boundary. These pin: archiving persists the checkpoint
 * (readable on a fresh open), Transcript.load consults it so the next seq
 * clears every archived seq, and an un-archived workspace writes nothing
 * (default 0). Each guard is falsifiable.
 */

// ~95 bytes/entry; a 50-byte cap seals after every entry → 1 entry per segment.
const PER_ENTRY = 50

function entry(seq: number): TranscriptEntry {
  return {
    seq,
    ts: 1_000 + seq,
    kind: 'participant_joined',
    data: { id: `p-${seq}`, participantKind: 'agent', capabilities: ['x'] },
  }
}

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aipe-hwm-'))
  path = join(dir, 'transcript.jsonl')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function write(entries: TranscriptEntry[]): Promise<void> {
  const fs = new FileStorage(path, undefined, PER_ENTRY)
  for (const e of entries) await fs.appendTranscriptEntry(e)
  await fs.close()
}

describe('FileStorage high-water seq (Route B P0-M2 M3)', () => {
  it('archiving persists the high-water seq, readable on a fresh open', async () => {
    await write(Array.from({ length: 6 }, (_, i) => entry(i + 1)))
    // seg1..5 (e1..e5) + active(e6). Archive every sealed segment.
    await new FileStorage(path, undefined, PER_ENTRY).archiveSegments({ keepLast: 0 })

    // A fresh instance reads the checkpoint from disk (not in-process memory).
    expect(new FileStorage(path, undefined, PER_ENTRY).highWaterSeq()).toBe(6)
    expect(existsSync(join(dir, 'transcript.hwm'))).toBe(true)
  })

  it('seq never regresses after archiving removes every loadable entry', async () => {
    await write(Array.from({ length: 5 }, (_, i) => entry(i + 1)))
    // Simulate a crash in the seal window: the active file is gone, only sealed
    // segments (e1..e4) remain — the in-flight e5 was never durably written.
    await rm(path, { force: true })

    // Retention archives every sealed segment ⇒ nothing left in the load path.
    const archived = new FileStorage(path, undefined, PER_ENTRY)
    const moved = await archived.archiveSegments({ keepLast: 0 })
    expect(moved.length).toBeGreaterThan(0)

    const fresh = new FileStorage(path, undefined, PER_ENTRY)
    // Precondition: the boot load really is empty — without the checkpoint, seq
    // would reset to 0 here and the next append would reuse an archived number.
    expect(await fresh.loadTranscript()).toEqual([])
    const archivedMax = Math.max(...(await fresh.loadArchivedSegments()).map((e) => e.seq))

    const t = new Transcript(fresh)
    await t.load()
    const next = t.append({ ts: 9_000, kind: 'participant_left', data: { id: 'z' } })
    // The next seq clears every archived seq — no reuse / collision.
    expect(next.seq).toBeGreaterThan(archivedMax)
    expect(next.seq).toBe(archivedMax + 1)
  })

  it('an un-archived workspace reports high-water 0 and writes no checkpoint', async () => {
    await write(Array.from({ length: 3 }, (_, i) => entry(i + 1)))
    // Appending + a clean close never writes the checkpoint — only archiving,
    // which is the only operation that can remove entries from the load path.
    expect(new FileStorage(path, undefined, PER_ENTRY).highWaterSeq()).toBe(0)

    // Empty options are a no-op: no policy ⇒ no checkpoint written.
    await new FileStorage(path, undefined, PER_ENTRY).archiveSegments()
    expect(existsSync(join(dir, 'transcript.hwm'))).toBe(false)
    expect(new FileStorage(path, undefined, PER_ENTRY).highWaterSeq()).toBe(0)
  })
})
