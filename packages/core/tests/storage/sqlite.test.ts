import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SqliteStorage } from '../../src/storage/sqlite.js'
import type { TranscriptEntry } from '../../src/types.js'

function joinEntry(seq: number, id: string): TranscriptEntry {
  return {
    seq,
    ts: 1_000 + seq,
    kind: 'participant_joined',
    data: { id, participantKind: 'agent', capabilities: ['x'] },
  }
}

describe('SqliteStorage', () => {
  let path: string

  beforeEach(() => {
    path = join(
      tmpdir(),
      `aipehub-sqlite-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    )
  })

  afterEach(async () => {
    await rm(path, { force: true })
    // SQLite WAL writes companion files
    await rm(`${path}-wal`, { force: true })
    await rm(`${path}-shm`, { force: true })
  })

  it(':memory: database round-trips entries verbatim', async () => {
    const s = new SqliteStorage({ path: ':memory:' })
    const entries: TranscriptEntry[] = [
      joinEntry(1, 'a'),
      joinEntry(2, 'b'),
      joinEntry(3, 'c'),
    ]
    for (const e of entries) await s.appendTranscriptEntry(e)
    const loaded = await s.loadTranscript()
    expect(loaded).toEqual(entries)
    await s.close()
  })

  it('persists across instances (file-backed)', async () => {
    const s1 = new SqliteStorage({ path })
    await s1.appendTranscriptEntry(joinEntry(1, 'a'))
    await s1.appendTranscriptEntry(joinEntry(2, 'b'))
    await s1.close()

    const s2 = new SqliteStorage({ path })
    const loaded = await s2.loadTranscript()
    expect(loaded.map((e) => e.seq)).toEqual([1, 2])
    expect(loaded[0]?.data).toEqual({
      id: 'a',
      participantKind: 'agent',
      capabilities: ['x'],
    })
    await s2.close()
  })

  it('orders rows by seq even when inserted out of order', async () => {
    const s = new SqliteStorage({ path: ':memory:' })
    await s.appendTranscriptEntry(joinEntry(3, 'c'))
    await s.appendTranscriptEntry(joinEntry(1, 'a'))
    await s.appendTranscriptEntry(joinEntry(2, 'b'))
    const loaded = await s.loadTranscript()
    expect(loaded.map((e) => e.seq)).toEqual([1, 2, 3])
    await s.close()
  })

  it('duplicate seq fails loudly via PK constraint', async () => {
    const s = new SqliteStorage({ path: ':memory:' })
    await s.appendTranscriptEntry(joinEntry(1, 'a'))
    await expect(s.appendTranscriptEntry(joinEntry(1, 'b'))).rejects.toThrow()
    // first insert still observable
    const loaded = await s.loadTranscript()
    expect(loaded.map((e) => e.seq)).toEqual([1])
    await s.close()
  })

  it('handles a burst of 200 concurrent appends with no loss', async () => {
    const s = new SqliteStorage({ path: ':memory:' })
    const N = 200
    const entries: TranscriptEntry[] = []
    for (let i = 1; i <= N; i++) entries.push(joinEntry(i, `p-${i}`))
    await Promise.all(entries.map((e) => s.appendTranscriptEntry(e)))

    const loaded = await s.loadTranscript()
    expect(loaded).toHaveLength(N)
    expect(loaded.map((e) => e.seq)).toEqual(entries.map((e) => e.seq))
    await s.close()
  })

  it('preserves all transcript kinds, not just participant_joined', async () => {
    const s = new SqliteStorage({ path: ':memory:' })
    const entries: TranscriptEntry[] = [
      joinEntry(1, 'a'),
      {
        seq: 2,
        ts: 2,
        kind: 'message',
        data: { id: 'm1', channel: '#main', from: 'a', body: 'hi', ts: 2 },
      },
      {
        seq: 3,
        ts: 3,
        kind: 'task',
        data: {
          id: 't1',
          from: 'a',
          strategy: { kind: 'explicit', to: 'b' },
          payload: { x: 1 },
          createdAt: 3,
        },
      },
      {
        seq: 4,
        ts: 4,
        kind: 'task_result',
        data: { kind: 'ok', taskId: 't1', by: 'b', output: { y: 2 }, ts: 4 },
      },
      {
        seq: 5,
        ts: 5,
        kind: 'participant_left',
        data: { id: 'a' },
      },
    ]
    for (const e of entries) await s.appendTranscriptEntry(e)
    const loaded = await s.loadTranscript()
    expect(loaded).toEqual(entries)
    await s.close()
  })
})
