import { appendFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileStorage } from '../../src/storage/file.js'
import type { TranscriptEntry } from '../../src/types.js'

function joinEntry(seq: number, id: string): TranscriptEntry {
  return {
    seq,
    ts: 1_000 + seq,
    kind: 'participant_joined',
    data: { id, participantKind: 'agent', capabilities: ['x'] },
  }
}

describe('FileStorage', () => {
  let path: string

  beforeEach(() => {
    path = join(
      tmpdir(),
      `aipehub-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    )
  })

  afterEach(async () => {
    await rm(path, { force: true })
  })

  it('append + loadTranscript round-trips entries verbatim', async () => {
    const fs1 = new FileStorage(path)
    const entries: TranscriptEntry[] = [
      joinEntry(1, 'a'),
      joinEntry(2, 'b'),
      joinEntry(3, 'c'),
    ]
    for (const e of entries) await fs1.appendTranscriptEntry(e)
    await fs1.close()

    const fs2 = new FileStorage(path)
    const loaded = await fs2.loadTranscript()
    expect(loaded).toEqual(entries)
  })

  it('many concurrent appendTranscriptEntry calls produce one valid JSON object per line', async () => {
    const fs = new FileStorage(path)
    const N = 200
    const entries: TranscriptEntry[] = []
    for (let i = 1; i <= N; i++) entries.push(joinEntry(i, `p-${i}`))

    // fire them all in parallel
    await Promise.all(entries.map((e) => fs.appendTranscriptEntry(e)))
    await fs.close()

    const raw = await readFile(path, 'utf8')
    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(N)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    const reloaded = await new FileStorage(path).loadTranscript()
    expect(reloaded).toHaveLength(N)
    expect(reloaded.map((e) => e.seq).sort((a, b) => a - b)).toEqual(
      entries.map((e) => e.seq),
    )
  })

  it('loadTranscript tolerates a trailing corrupt line', async () => {
    const fs = new FileStorage(path)
    await fs.appendTranscriptEntry(joinEntry(1, 'a'))
    await fs.appendTranscriptEntry(joinEntry(2, 'b'))
    await fs.close()

    // simulate a crash: append a partial / non-JSON line
    await appendFile(path, 'not-json', 'utf8')

    const fs2 = new FileStorage(path)
    const loaded = await fs2.loadTranscript()
    expect(loaded.map((e) => e.seq)).toEqual([1, 2])
  })
})
