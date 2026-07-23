/**
 * Perf audit A③ — `Transcript.emitEphemeral`.
 *
 * The ephemeral channel exists for high-volume transient kinds
 * (`llm_stream_chunk`): observers must see the entry live, but it must
 * never enter the in-memory log or the storage — that pair is what made
 * streaming grow RAM + transcript.jsonl without bound. These tests pin
 * the contract:
 *
 *   1. observers receive ephemeral entries, interleaved and strictly
 *      seq-ordered with persisted ones (shared counter);
 *   2. `all()` / `size()` / storage writes are untouched by an emit;
 *   3. the persisted log tolerates the seq gaps ephemeral entries leave
 *      (`load()` takes the max — the counter never regresses);
 *   4. a throwing observer doesn't break the emit or its siblings.
 */

import { describe, expect, it } from 'vitest'

import type { Storage } from '../src/storage/index.js'
import { Transcript } from '../src/transcript.js'
import type { TranscriptEntry } from '../src/types.js'

/** Minimal in-memory Storage recording every persisted entry. */
function memStorage(preloaded: TranscriptEntry[] = []): { storage: Storage; persisted: TranscriptEntry[] } {
  const persisted: TranscriptEntry[] = [...preloaded]
  const storage: Storage = {
    loadTranscript: async () => [...persisted],
    appendTranscriptEntry: async (e) => {
      persisted.push(e)
    },
  }
  return { storage, persisted }
}

function msg(text: string): Omit<TranscriptEntry, 'seq'> {
  return {
    ts: 1,
    kind: 'message',
    data: { id: `m-${text}`, channel: 'general', from: 'p-1', body: { text }, ts: 1 },
  } as Omit<TranscriptEntry, 'seq'>
}

function chunk(type: string): Omit<TranscriptEntry, 'seq'> {
  return {
    ts: 1,
    kind: 'llm_stream_chunk',
    data: { taskId: 't-1', agentId: 'a-1', chunk: { type } },
  } as Omit<TranscriptEntry, 'seq'>
}

describe('Transcript.emitEphemeral (perf audit A③)', () => {
  it('fans out to observers with shared-counter seqs but never stores', async () => {
    const { storage, persisted } = memStorage()
    const t = new Transcript(storage)
    const seen: Array<{ kind: string; seq: number }> = []
    t.onAppend((e) => seen.push({ kind: e.kind, seq: e.seq }))

    t.append(msg('before'))
    t.emitEphemeral(chunk('text'))
    t.emitEphemeral(chunk('end'))
    t.append(msg('after'))

    // Observers saw all four, strictly seq-ordered across both channels.
    expect(seen.map((e) => e.kind)).toEqual([
      'message',
      'llm_stream_chunk',
      'llm_stream_chunk',
      'message',
    ])
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4])

    // The recorded log — memory and storage — holds ONLY the persisted two.
    expect(t.size()).toBe(2)
    expect(t.all().map((e) => e.kind)).toEqual(['message', 'message'])
    // Storage writes are async fire-and-forget; let them settle.
    await new Promise((r) => setImmediate(r))
    expect(persisted.map((e) => e.kind)).toEqual(['message', 'message'])
    // The gap the ephemeral pair left is visible in the persisted seqs.
    expect(persisted.map((e) => e.seq)).toEqual([1, 4])
  })

  it('load() after a gapped log keeps the counter monotonic', async () => {
    const first = memStorage()
    const t1 = new Transcript(first.storage)
    t1.append(msg('one'))
    t1.emitEphemeral(chunk('text')) // consumes seq 2, persisted nowhere
    t1.append(msg('two')) // seq 3
    await new Promise((r) => setImmediate(r))

    // Restart: reload from what was persisted (seqs 1 and 3).
    const second = memStorage(first.persisted)
    const t2 = new Transcript(second.storage)
    await t2.load()
    const next = t2.append(msg('three'))
    expect(next.seq).toBe(4) // max persisted was 3 — never regresses
  })

  it('a throwing observer breaks neither the emit nor other observers', () => {
    const { storage } = memStorage()
    const t = new Transcript(storage)
    const seen: string[] = []
    t.onAppend(() => {
      throw new Error('observer boom')
    })
    t.onAppend((e) => seen.push(e.kind))

    const out = t.emitEphemeral(chunk('text'))
    expect(out.seq).toBe(1)
    expect(seen).toEqual(['llm_stream_chunk'])
  })
})
