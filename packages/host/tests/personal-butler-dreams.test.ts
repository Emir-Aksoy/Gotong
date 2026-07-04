/**
 * Tests for the host side of the dreaming sweep (MR2).
 *
 * Three things, all over a real per-user tmp tree:
 *   1. the DREAMS.md diary — append per sweep, `readLatest` returns the most
 *      recent counts, `remove` wipes it (the forget-all path);
 *   2. the `queryHit` writer end to end — a real `recall` through `MemoryToolset`
 *      grows the matched entry's query-DIVERSITY via `patchMeta`, idempotently;
 *   3. `HostButlerMemoryService.read` surfaces the last sweep as `lastDream`, and
 *      `forgetAll` removes the derived diary too.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@gotong/core'
import {
  MemoryReviewParticipant,
  MemoryToolset,
  dreamingReviewer,
  lexicalRetriever,
  queryDiversityOf,
} from '@gotong/personal-memory'
import type { MemoryEntry } from '@gotong/services-sdk'

import { HostButlerMemoryService } from '../src/butler-memory-service.js'
import { openButlerDreamDiary } from '../src/personal-butler-dreams.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { butlerMemoryWriters } from '../src/personal-butler-writers.js'

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

describe('butler dream diary (DREAMS.md)', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'butler-dreams-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('appends a block per sweep and readLatest returns the most recent counts', async () => {
    const diary = openButlerDreamDiary({ rootDir: tmp, userId: 'alice', logger: silentLogger })
    expect(await diary.readLatest()).toBeNull() // no diary yet

    await diary.writer({
      firedAt: 1000,
      promoted: [{ id: 'a', score: 60, text: '主人最爱春水堂的珍珠奶茶' }],
      pruned: [],
      profileBytes: 42,
    })
    await diary.writer({
      firedAt: 2000,
      promoted: [],
      pruned: [{ id: 'b', score: 1, text: '随口闲聊一句' }],
    })

    // readLatest = the LAST block's counts (not the first).
    expect(await diary.readLatest()).toEqual({ firedAt: 2000, promoted: 0, pruned: 1 })

    // The file itself is human-readable markdown carrying both blocks.
    const md = await readFile(join(tmp, 'user', 'alice', 'DREAMS.md'), 'utf8')
    expect(md).toContain('## 复盘')
    expect(md).toContain('提升 1 条记忆进画像（42 字）')
    expect(md).toContain('封存 1 条陈旧记忆')
    expect(md).toContain('[a] 主人最爱春水堂的珍珠奶茶')
  })

  it('remove() deletes the diary (forget-all path)', async () => {
    const diary = openButlerDreamDiary({ rootDir: tmp, userId: 'bob', logger: silentLogger })
    await diary.writer({ firedAt: 1, promoted: [], pruned: [] })
    expect(await diary.readLatest()).not.toBeNull()
    await diary.remove()
    expect(await diary.readLatest()).toBeNull()
    await diary.remove() // idempotent — removing an absent diary is fine
  })

  it('throws on an empty userId', () => {
    expect(() => openButlerDreamDiary({ rootDir: tmp, userId: '', logger: silentLogger })).toThrow(
      /non-empty userId/,
    )
  })
})

describe('queryHit writer — a recall grows query-diversity end to end', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'butler-qh-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('distinct recall queries bump queryHits; a repeat is idempotent', async () => {
    const mem = openButlerMemory({ rootDir: tmp, userId: 'alice', logger: silentLogger })
    const seed = await mem.remember({ kind: 'semantic', text: '主人最爱春水堂的珍珠奶茶' })
    const writers = butlerMemoryWriters(mem)
    const toolset = new MemoryToolset({
      memory: mem,
      retriever: lexicalRetriever(mem),
      queryHit: writers.queryHit,
    })

    const reread = async (): Promise<MemoryEntry> =>
      (await mem.list({ limit: 100 })).find((e) => e.id === seed.id)!

    await toolset.callTool('recall', { query: '奶茶' })
    expect(queryDiversityOf(await reread())).toBe(1)

    // A DIFFERENT question about the same fact → diversity grows.
    await toolset.callTool('recall', { query: '春水堂' })
    expect(queryDiversityOf(await reread())).toBe(2)

    // The SAME question again → no new write (a re-asked query is not a hit).
    await toolset.callTool('recall', { query: '奶茶' })
    expect(queryDiversityOf(await reread())).toBe(2)
  })
})

describe('HostButlerMemoryService — lastDream projection', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'butler-svc-dream-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('a real heartbeat sweep promotes + prunes, writes DREAMS.md, /me reads it', async () => {
    const NOW = 100_000_000_000
    const mem = openButlerMemory({ rootDir: tmp, userId: 'carol', logger: silentLogger })
    // A high-value episodic the sweep will promote (importance 5 × recall 3 × diversity 2 = 60).
    await mem.remember({
      kind: 'episodic',
      text: '主人最爱春水堂的珍珠奶茶',
      meta: { importance: 5, recallCount: 3, queryHits: ['fa', 'fb'] },
    })
    // A stale, low-value, never-asked chatter the sweep will prune.
    await mem.remember({
      kind: 'episodic',
      text: '随口闲聊一句今天天气',
      meta: { importance: 1, lastRecalledTs: 1000 },
    })

    const diary = openButlerDreamDiary({ rootDir: tmp, userId: 'carol', logger: silentLogger })
    // Drive it the production way — a heartbeat-fired MemoryReviewParticipant over
    // the real file-backed handle, not the reviewer function called by hand.
    const heartbeat = new MemoryReviewParticipant({
      memory: mem,
      reviewer: dreamingReviewer({
        summarize: async () => '主人偏好: 春水堂珍珠奶茶',
        promoteGate: 8,
        pruneGate: 1,
        staleMs: 1000,
        diary: diary.writer,
      }),
      policy: { minEpisodic: 1 },
      now: () => NOW,
    })
    await heartbeat.review()

    // The promoted profile lives in the jsonl; the chatter is gone.
    const remaining = await mem.list({ limit: 100 })
    expect(remaining.some((e) => e.kind === 'semantic' && e.text.includes('春水堂'))).toBe(true)
    expect(remaining.some((e) => e.text.includes('天气'))).toBe(false)

    const svc = new HostButlerMemoryService({ rootDir: tmp, logger: silentLogger })
    const snap = await svc.read('carol')
    expect(snap.lastDream).toBeDefined()
    expect(snap.lastDream!.promoted).toBe(1)
    expect(snap.lastDream!.pruned).toBe(1)
    expect(snap.lastDream!.firedAt).toBe(NOW)

    // 被遗忘权: forgetAll clears the jsonl AND the derived diary.
    await svc.forgetAll('carol')
    const after = await svc.read('carol')
    expect(after.lastDream).toBeUndefined()
    expect(after.profile).toHaveLength(0)
  })
})
