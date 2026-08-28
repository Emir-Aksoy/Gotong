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
 *
 * `emitChunk` — the router every emitter goes through — is pinned below it:
 * A③'s blanket also dropped `tool_use`, and its argument never covered that
 * case (a task_result carries `toolRounds`, a number — not the tool's name,
 * its input, or the fact it ran). So prose stays ephemeral and actions land
 * on disk, decided in ONE place.
 */

import { describe, expect, it } from 'vitest'

import type { Storage } from '../src/storage/index.js'
import { Transcript, chunkDeservesDisk } from '../src/transcript.js'
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

function chunk(type: string, extra: Record<string, unknown> = {}): Omit<TranscriptEntry, 'seq'> {
  return {
    ts: 1,
    kind: 'llm_stream_chunk',
    data: { taskId: 't-1', agentId: 'a-1', chunk: { type, ...extra } },
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

describe('chunkDeservesDisk (A③ revised — prose out, actions in)', () => {
  it('only tool_use earns a place on disk', () => {
    expect(chunkDeservesDisk({ type: 'tool_use', toolUse: { name: 'x' } })).toBe(true)
    for (const t of ['text', 'usage', 'end', 'error']) {
      expect(chunkDeservesDisk({ type: t })).toBe(false)
    }
  })

  it('is a whitelist: an unrecognised type is display-only', () => {
    // The direction the default errs matters. A provider inventing a new
    // high-volume chunk type must not silently start filling the disk; the
    // mirror risk (a new ACTION-bearing type silently dropped) is what the
    // host-side gate against the `LlmStreamChunk` union exists to catch.
    expect(chunkDeservesDisk({ type: 'thinking_delta' })).toBe(false)
    expect(chunkDeservesDisk({ type: 'audio' })).toBe(false)
  })

  it('tolerates any shape — `chunk` is typed unknown on the entry', () => {
    // core does not depend on @gotong/llm, so nothing guarantees the payload
    // is even an object. Every non-conforming value is display-only rather
    // than a throw: a malformed chunk must not take the agent's reply down.
    for (const bad of [undefined, null, 'tool_use', 42, [], {}, { type: 7 }]) {
      expect(chunkDeservesDisk(bad)).toBe(false)
    }
  })
})

describe('Transcript.emitChunk (the one router)', () => {
  it('persists tool_use and drops the prose around it, in one live stream', async () => {
    const { storage, persisted } = memStorage()
    const t = new Transcript(storage)
    const seen: string[] = []
    t.onAppend((e) => seen.push((e.data as { chunk: { type: string } }).chunk.type))

    t.emitChunk(chunk('text'))
    t.emitChunk(chunk('tool_use', { toolUse: { id: 'i1', name: 'tavily_search', input: { q: 'k' } } }))
    t.emitChunk(chunk('usage'))
    t.emitChunk(chunk('end'))

    // Live: the observer still sees all four — routing changes what is KEPT,
    // never what is shown. The typing preview loses nothing.
    expect(seen).toEqual(['text', 'tool_use', 'usage', 'end'])

    // Recorded: the action, and only the action.
    expect(t.all().length).toBe(1)
    await new Promise((r) => setImmediate(r))
    expect(persisted.length).toBe(1)
    const kept = persisted[0]!.data as { chunk: { toolUse: { name: string } } }
    expect(kept.chunk.toolUse.name).toBe('tavily_search')
  })

  it('a persisted chunk takes a seq like any other entry; the gaps stay gaps', async () => {
    const { storage, persisted } = memStorage()
    const t = new Transcript(storage)
    t.append(msg('one')) // 1
    t.emitChunk(chunk('text')) // 2 — burned, stored nowhere
    t.emitChunk(chunk('tool_use', { toolUse: { name: 'x' } })) // 3 — stored
    t.append(msg('two')) // 4
    await new Promise((r) => setImmediate(r))
    expect(persisted.map((e) => e.seq)).toEqual([1, 3, 4])
  })
})
