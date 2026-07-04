/**
 * Tests for the host recall index (MR1).
 *
 * Two layers:
 *   1. `FileBackedInvertedIndex` with a FAKE io — pins the freshness contract
 *      (rebuild only on watermark drift, warm-start from a persisted snapshot,
 *      best-effort persist, clear) without touching disk.
 *   2. `openButlerRecallIndex` over a real tmp dir + `openButlerMemory` — proves
 *      the headline claim end-to-end: the index finds a relevant fact OLDER than
 *      the recency window the prior default (`lexicalRetriever`) would have
 *      ranked, and a later write drifts the watermark so the new fact shows up.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@gotong/core'
import { lexicalRetriever } from '@gotong/personal-memory'
import type { MemoryEntry } from '@gotong/services-sdk'

import {
  FileBackedInvertedIndex,
  openButlerRecallIndex,
  type PersistedRecallIndex,
  type RecallIndexIo,
} from '../src/butler-recall-index.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

function entry(id: string, text: string, ts: number, meta?: Record<string, unknown>): MemoryEntry {
  return { id, kind: 'semantic', text, ts, ...(meta ? { meta } : {}) }
}

/** A fake io with a mutable backing store + call counters. */
function fakeIo(initial: MemoryEntry[]): {
  io: RecallIndexIo
  store: MemoryEntry[]
  bump(): void
  persisted: PersistedRecallIndex | null
  counts: { loadAll: number; persist: number }
} {
  const state = {
    store: [...initial],
    tick: 0, // bump() advances the watermark, simulating a file write
    persisted: null as PersistedRecallIndex | null,
    counts: { loadAll: 0, persist: 0 },
  }
  const io: RecallIndexIo = {
    async loadAll() { state.counts.loadAll++; return [...state.store] },
    async watermark() { return `wm:${state.store.length}:${state.tick}` },
    async loadPersisted() { return state.persisted },
    async persist(data) { state.counts.persist++; state.persisted = data },
  }
  return {
    io,
    get store() { return state.store },
    bump() { state.tick++ },
    get persisted() { return state.persisted },
    get counts() { return state.counts },
  }
}

describe('FileBackedInvertedIndex — freshness contract (fake io)', () => {
  it('builds on first ensureFresh and reuses while the watermark is stable', async () => {
    const f = fakeIo([entry('a', '奶茶店项目', 100)])
    const idx = new FileBackedInvertedIndex(f.io)

    await idx.ensureFresh()
    expect(idx.size).toBe(1)
    expect(f.counts.loadAll).toBe(1)

    // No drift → no rebuild, however many times we ask.
    await idx.ensureFresh()
    await idx.retriever().retrieve({ text: '奶茶', k: 5 })
    expect(f.counts.loadAll).toBe(1)
  })

  it('rebuilds when the watermark drifts (a write happened)', async () => {
    const f = fakeIo([entry('a', '奶茶店项目', 100)])
    const idx = new FileBackedInvertedIndex(f.io)
    await idx.ensureFresh()
    expect(f.counts.loadAll).toBe(1)

    f.store.push(entry('b', '咖啡馆计划', 200))
    f.bump() // a write changed the file fingerprint
    const hits = await idx.retriever().retrieve({ text: '咖啡', k: 5 })
    expect(f.counts.loadAll).toBe(2) // rebuilt
    expect(hits.map((e) => e.id)).toEqual(['b'])
  })

  it('warm-starts from a persisted snapshot (no cold rebuild at the matching watermark)', async () => {
    const f = fakeIo([entry('a', '奶茶店项目', 100)])
    // Pre-seed a persisted snapshot whose watermark MATCHES the current store.
    f.io.persist!({
      snapshot: { version: 1, entries: [entry('a', '奶茶店项目', 100)] },
      watermark: 'wm:1:0',
    })
    const idx = new FileBackedInvertedIndex(f.io)

    await idx.ensureFresh()
    expect(idx.size).toBe(1)
    // Warm-start matched the live watermark → loadAll never ran.
    expect(f.counts.loadAll).toBe(0)
  })

  it('persists the rebuilt snapshot for the next boot', async () => {
    const f = fakeIo([entry('a', '奶茶店项目', 100)])
    const idx = new FileBackedInvertedIndex(f.io)
    await idx.ensureFresh()
    expect(f.persisted?.watermark).toBe('wm:1:0')
    expect(f.persisted?.snapshot.entries.map((e) => e.id)).toEqual(['a'])
  })

  it('clear() drops the index and the next ensureFresh rebuilds from the (empty) store', async () => {
    const f = fakeIo([entry('a', '奶茶店项目', 100)])
    const idx = new FileBackedInvertedIndex(f.io)
    await idx.ensureFresh()
    expect(idx.size).toBe(1)

    f.store.length = 0 // forget-all wiped the jsonl
    f.bump()
    idx.clear()
    expect(idx.size).toBe(0)

    await idx.ensureFresh()
    expect(idx.size).toBe(0) // rebuilt empty, did not reload the stale snapshot
  })

  it('a corrupt warm-start snapshot is non-fatal (falls through to a rebuild)', async () => {
    const f = fakeIo([entry('a', '奶茶店项目', 100)])
    f.io.loadPersisted = async () => { throw new Error('corrupt cache') }
    const idx = new FileBackedInvertedIndex(f.io, silentLogger)
    await idx.ensureFresh()
    expect(idx.size).toBe(1) // rebuilt despite the throwing warm-start
  })
})

describe('openButlerRecallIndex — real filesystem, end to end', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'butler-recall-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('finds a relevant fact OLDER than lexicalRetriever\'s recency window', async () => {
    const mem = openButlerMemory({ rootDir: tmp, userId: 'alice', logger: silentLogger })

    // The relevant fact, written first (oldest). The handle stamps ts = now() at
    // write time, so writing it first makes it the oldest by construction.
    await mem.remember({ kind: 'semantic', text: '主人最爱的奶茶店叫春水堂' })
    // …then bury it under 60 newer, non-matching turns.
    for (let i = 0; i < 60; i++) {
      await mem.remember({ kind: 'episodic', text: `日常闲聊第${i}条` })
    }

    const query = { text: '奶茶店', k: 5 } as const

    // The recency-window retriever (k=5 → wideK 40) only pulls the newest 40 → misses it.
    const lex = await lexicalRetriever(mem).retrieve(query)
    expect(lex).toHaveLength(0)

    // The index spans the whole store → finds the buried old fact.
    const idx = openButlerRecallIndex({ rootDir: tmp, userId: 'alice', logger: silentLogger })
    const hits = await idx.retriever().retrieve(query)
    expect(hits.map((e) => e.text)).toContain('主人最爱的奶茶店叫春水堂')
  })

  it('picks up a later write via watermark drift and persists the cache', async () => {
    const mem = openButlerMemory({ rootDir: tmp, userId: 'bob', logger: silentLogger })
    await mem.remember({ kind: 'semantic', text: '主人住在槟城' })

    const idx = openButlerRecallIndex({ rootDir: tmp, userId: 'bob', logger: silentLogger })
    expect((await idx.retriever().retrieve({ text: '槟城', k: 5 })).map((e) => e.text))
      .toEqual(['主人住在槟城'])

    // A new fact lands after the index first built → watermark drifts → rebuild.
    await mem.remember({ kind: 'semantic', text: '主人换工作去了吉隆坡' })
    const after = await idx.retriever().retrieve({ text: '吉隆坡', k: 5 })
    expect(after.map((e) => e.text)).toEqual(['主人换工作去了吉隆坡'])

    // The derived cache was written next to the jsonl (warm-start for next boot).
    const cached = JSON.parse(
      await readFile(join(tmp, 'user', 'bob', 'recall-index.json'), 'utf8'),
    ) as PersistedRecallIndex
    expect(cached.snapshot.entries.length).toBe(2)
  })

  it('does not leak across users (per-user namespace)', async () => {
    const alice = openButlerMemory({ rootDir: tmp, userId: 'alice', logger: silentLogger })
    await alice.remember({ kind: 'semantic', text: '主人在做奶茶店项目' })

    // Bob's index is scoped to bob's empty tree.
    const bobIdx = openButlerRecallIndex({ rootDir: tmp, userId: 'bob', logger: silentLogger })
    expect(await bobIdx.retriever().retrieve({ text: '奶茶店', k: 5 })).toHaveLength(0)
  })

  it('throws on an empty userId', () => {
    expect(() => openButlerRecallIndex({ rootDir: tmp, userId: '', logger: silentLogger })).toThrow(
      /non-empty userId/,
    )
  })
})
