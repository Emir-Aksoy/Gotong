/**
 * Tests for the dreaming sweep (MR2).
 *
 * Four claims:
 *   1. the query-diversity signal — `queryFingerprint` (order-independent),
 *      `queryHitMeta` (idempotent delta + FIFO cap), and that it NEVER reaches
 *      the frozen block (prompt-cache byte-stability);
 *   2. `dreamScore` — the three multiplicative gates;
 *   3. `dreamingReviewer` — promote high-scorers / prune stale chatter / leave
 *      the in-between, with an honest diary;
 *   4. a converged sweep is idle (`{}` → HEARTBEAT_OK) and idempotent.
 */

import { describe, expect, it, vi } from 'vitest'

import type { MemoryEntry } from '@aipehub/services-sdk'

import {
  DEFAULT_DREAM_STALE_MS,
  DEFAULT_IMPORTANCE,
  MemoryToolset,
  type DreamRecord,
  type MemoryQueryHitWriter,
  dreamScore,
  dreamingReviewer,
  queryDiversityOf,
  queryFingerprint,
  queryHitMeta,
  queryHitsOf,
  renderFrozenBlock,
} from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

function recallText(out: { content: ReadonlyArray<unknown>; isError?: boolean }): string {
  return (out.content[0] as { text: string }).text
}

// A "high-value" episodic entry: important, often recalled, asked many ways.
function hot(id: string, ts = 1000): MemoryEntry {
  return entry(id, 'episodic', '主人最爱春水堂的珍珠奶茶', ts, {
    importance: 5,
    recallCount: 3,
    queryHits: ['fa', 'fb'],
  })
}

describe('query-diversity signal', () => {
  it('queryFingerprint is order-independent and deterministic', () => {
    // Same terms, different order → same fingerprint (sorted top-N terms).
    expect(queryFingerprint('奶茶 店')).toBe(queryFingerprint('店 奶茶'))
    expect(queryFingerprint('coffee shop')).toBe(queryFingerprint('shop coffee'))
    expect(queryFingerprint('珍珠奶茶')).toBe(queryFingerprint('珍珠奶茶'))
  })

  it('different queries → different fingerprints', () => {
    expect(queryFingerprint('珍珠奶茶')).not.toBe(queryFingerprint('美式咖啡'))
  })

  it('a query with no recallable terms → empty fingerprint', () => {
    expect(queryFingerprint('  ,  ')).toBe('')
    expect(queryFingerprint('')).toBe('')
  })

  it('queryHitMeta records the first hit and is idempotent on a repeat', () => {
    const e = entry('a', 'semantic', 't', 100, { queryHits: ['x'] })
    // A new fingerprint → a delta carrying the grown set.
    const added = queryHitMeta(e, 'y')
    expect(added).toEqual({ queryHits: ['x', 'y'] })
    // The SAME fingerprint again → null (no write — a re-asked query is not a hit).
    expect(queryHitMeta({ meta: { queryHits: ['x', 'y'] } }, 'y')).toBeNull()
    // An empty fingerprint never writes.
    expect(queryHitMeta(e, '')).toBeNull()
  })

  it('queryHitMeta is FIFO-capped (a fact answering endlessly-many queries stays bounded)', () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => `f${i}`)
    const e = entry('a', 'semantic', 't', 100, { queryHits: sixteen })
    const out = queryHitMeta(e, 'f16', 16)
    const hits = out?.queryHits as string[]
    expect(hits).toHaveLength(16) // capped
    expect(hits[0]).toBe('f1') // oldest (f0) dropped
    expect(hits).toContain('f16') // newest kept
    expect(hits).not.toContain('f0')
  })

  it('queryHitsOf / queryDiversityOf tolerate missing or malformed meta', () => {
    expect(queryDiversityOf(entry('a', 'semantic', 't', 1))).toBe(0)
    expect(queryDiversityOf({ meta: { queryHits: 'oops' } })).toBe(0)
    expect(queryHitsOf({ meta: { queryHits: ['x', 'x', 7, ''] as unknown[] } })).toEqual(['x', 'x'])
  })

  it('NEVER enters the frozen block (prompt-cache byte-stability)', () => {
    const base = entry('a', 'semantic', '主人住在槟城', 100, { importance: 4 })
    const before = renderFrozenBlock([base])
    // The same entry after dreaming stamped a query hit on it.
    const withHits: MemoryEntry = {
      ...base,
      meta: { ...base.meta, ...queryHitMeta(base, queryFingerprint('住哪')) },
    }
    expect(queryDiversityOf(withHits)).toBe(1) // the signal IS present on the entry…
    expect(renderFrozenBlock([withHits])).toBe(before) // …yet the block is byte-identical
  })
})

describe('dreamScore — three multiplicative gates', () => {
  it('defaults to importance when an entry has no usage signals', () => {
    expect(dreamScore(entry('x', 'semantic', 't', 100))).toBe(DEFAULT_IMPORTANCE) // 3 × 1 × 1
  })

  it('rises with each of importance, recall-frequency and query-diversity', () => {
    const plain = entry('p', 'episodic', 't', 100, { importance: 2 })
    const important = entry('i', 'episodic', 't', 100, { importance: 5 })
    const recalled = entry('r', 'episodic', 't', 100, { importance: 2, recallCount: 4 })
    const diverse = entry('d', 'episodic', 't', 100, { importance: 2, queryHits: ['a', 'b', 'c'] })
    expect(dreamScore(important)).toBeGreaterThan(dreamScore(plain))
    expect(dreamScore(recalled)).toBeGreaterThan(dreamScore(plain))
    expect(dreamScore(diverse)).toBeGreaterThan(dreamScore(plain))
    // All three together multiply: 5 × (1+3) × (1+2) = 60.
    expect(dreamScore(hot('h'))).toBe(60)
  })
})

describe('dreamingReviewer', () => {
  const NOW = 100_000_000_000 // far past any ts → everything is "stale" by age

  it('promotes high-scorers into a curated profile and folds the episodic', async () => {
    const seed = hot('hot')
    const mem = makeFakeMemory([seed])
    const diary: DreamRecord[] = []
    const reviewer = dreamingReviewer({
      summarize: async () => '主人偏好: 春水堂珍珠奶茶',
      promoteGate: 8,
      diary: (r) => {
        diary.push(r)
      },
    })

    const out = await reviewer({ memory: mem, episodic: [seed], now: NOW })

    // A curated, dreamed profile was written…
    const profiles = mem.entries.filter(
      (e) => e.kind === 'semantic' && (e.meta as { profile?: unknown } | undefined)?.profile === true,
    )
    expect(profiles).toHaveLength(1)
    expect((profiles[0]!.meta as { dreamed?: unknown }).dreamed).toBe(true)
    // …and the folded episodic was forgotten (crash-safe order: write THEN forget).
    expect(mem.entries.find((e) => e.id === 'hot')).toBeUndefined()
    // Diary is honest about what happened.
    expect(diary).toHaveLength(1)
    expect(diary[0]!.promoted.map((p) => p.id)).toEqual(['hot'])
    expect(diary[0]!.pruned).toEqual([])
    expect(diary[0]!.profileBytes).toBeGreaterThan(0)
    expect(diary[0]!.firedAt).toBe(NOW)
    expect(out.summary).toContain('promoted 1')
    expect(out.consolidated).toBe(1)
  })

  it('prunes a stale, low-value, never-diverse entry', async () => {
    const stale = entry('stale', 'episodic', '随口闲聊一句', 1000, { importance: 1 })
    const mem = makeFakeMemory([stale])
    const diary: DreamRecord[] = []
    const reviewer = dreamingReviewer({ pruneGate: 1, diary: (r) => diary.push(r) })

    const out = await reviewer({ memory: mem, episodic: [stale], now: NOW })

    expect(mem.entries.find((e) => e.id === 'stale')).toBeUndefined() // pruned
    expect(diary[0]!.pruned.map((p) => p.id)).toEqual(['stale'])
    expect(diary[0]!.promoted).toEqual([])
    expect(out.summary).toContain('pruned 1')
    expect(out.consolidated).toBeUndefined() // nothing promoted
  })

  it('does NOT prune a FRESH low-value entry (only stale chatter)', async () => {
    const fresh = entry('fresh', 'episodic', '刚说的一句', NOW - 1000, { importance: 1 })
    const mem = makeFakeMemory([fresh])
    const reviewer = dreamingReviewer({ pruneGate: 1 })

    const out = await reviewer({ memory: mem, episodic: [fresh], now: NOW })

    expect(mem.entries.find((e) => e.id === 'fresh')).toBeDefined() // survives — not stale
    expect(out).toEqual({})
  })

  it('does NOT prune an ever-asked-about entry even when stale and low-value', async () => {
    // score = 1 × (1+0) × (1+1) = 2, ≤ pruneGate 3, stale by age — but diversity>0 protects it.
    const asked = entry('asked', 'episodic', '问过好几次的事', 1000, { importance: 1, queryHits: ['q1'] })
    const mem = makeFakeMemory([asked])
    const reviewer = dreamingReviewer({ pruneGate: 3 })

    const out = await reviewer({ memory: mem, episodic: [asked], now: NOW })

    expect(mem.entries.find((e) => e.id === 'asked')).toBeDefined()
    expect(out).toEqual({})
  })

  it('leaves a mid-value entry alone (between the gates) and is idle + idempotent', async () => {
    const mid = entry('mid', 'episodic', '中等事项', NOW - 1000, { importance: 3 }) // score 3, fresh
    const mem = makeFakeMemory([mid])
    const reviewer = dreamingReviewer({ summarize: async () => 'x', promoteGate: 8, pruneGate: 1 })

    const out1 = await reviewer({ memory: mem, episodic: [mid], now: NOW })
    expect(out1).toEqual({}) // converged → idle
    const before = mem.entries.length

    const out2 = await reviewer({ memory: mem, episodic: [mid], now: NOW })
    expect(out2).toEqual({})
    expect(mem.entries.length).toBe(before) // a converged sweep writes nothing
  })

  it('respects a per-user filter (no-leak: another namespace is never touched)', async () => {
    const mine = hot('mine')
    const theirs = entry('theirs', 'episodic', '别人的高价值记忆', 1000, {
      importance: 5,
      recallCount: 9,
      queryHits: ['z1', 'z2', 'z3'],
      user: 'bob',
    })
    const mem = makeFakeMemory([mine, theirs])
    const reviewer = dreamingReviewer({
      summarize: async () => 'alice profile',
      promoteGate: 8,
      filter: (e) => (e.meta as { user?: unknown } | undefined)?.user !== 'bob',
    })

    await reviewer({ memory: mem, episodic: [mine, theirs], now: NOW })

    // Bob's high-value entry is untouched — only alice's was folded.
    expect(mem.entries.find((e) => e.id === 'theirs')).toBeDefined()
    expect(mem.entries.find((e) => e.id === 'mine')).toBeUndefined()
  })

  it('an empty episodic pool is a no-op', async () => {
    const mem = makeFakeMemory([])
    const reviewer = dreamingReviewer({ summarize: async () => 'x' })
    expect(await reviewer({ memory: mem, episodic: [], now: NOW })).toEqual({})
  })

  it('staleness is measured from the last recall, not the write time', async () => {
    // Written long ago but recalled just now → NOT stale, so not pruned.
    const recentlyUsed = entry('used', 'episodic', '老记忆但刚用过', 1000, {
      importance: 1,
      lastRecalledTs: NOW - 1000,
    })
    const mem = makeFakeMemory([recentlyUsed])
    const reviewer = dreamingReviewer({ pruneGate: 1, staleMs: DEFAULT_DREAM_STALE_MS })
    await reviewer({ memory: mem, episodic: [recentlyUsed], now: NOW })
    expect(mem.entries.find((e) => e.id === 'used')).toBeDefined()
  })
})

// Claim 5: the toolset actually FIRES the query-hit writer on a recall — without
// this wiring the whole signal would be inert (the field assigned but never read).
describe('queryHit toolset wiring (MR2 §五.2)', () => {
  it('OFF by default — no queryHit option, recall never stamps queryHits', async () => {
    const mem = makeFakeMemory([entry('e1', 'semantic', '我爱奶茶', 100)])
    const ts = new MemoryToolset({ memory: mem })
    const out = await ts.callTool('recall', { query: '奶茶' })
    expect(out.isError).toBeUndefined()
    expect(queryDiversityOf(mem.entries[0]!)).toBe(0)
  })

  it('ON — fires once per MATCHED seed with this call’s fingerprint', async () => {
    const mem = makeFakeMemory([
      entry('a', 'semantic', '奶茶店', 100),
      entry('b', 'semantic', '奶茶好喝', 200),
      entry('c', 'semantic', '篮球', 300),
    ])
    const spy = vi.fn<MemoryQueryHitWriter>(async () => {})
    const ts = new MemoryToolset({ memory: mem, queryHit: spy })
    await ts.callTool('recall', { query: '奶茶' })
    // 'a' and 'b' match 奶茶; 'c' does not → exactly two stamps (seeds only).
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls.map((call) => call[0].id).sort()).toEqual(['a', 'b'])
    // Every call carries the SAME non-empty fingerprint for this query.
    const fp = queryFingerprint('奶茶')
    expect(fp).not.toBe('')
    for (const call of spy.mock.calls) expect(call[1]).toBe(fp)
  })

  it('best-effort — a throwing queryHit writer never breaks recall', async () => {
    const mem = makeFakeMemory([entry('a', 'semantic', '奶茶店', 100)])
    const boom: MemoryQueryHitWriter = async () => {
      throw new Error('disk full')
    }
    const ts = new MemoryToolset({ memory: mem, queryHit: boom })
    const out = await ts.callTool('recall', { query: '奶茶' })
    expect(out.isError).toBeUndefined()
    expect(recallText(out)).toContain('奶茶')
  })

  it('a recall with no query records nothing (no fingerprint to stamp)', async () => {
    const mem = makeFakeMemory([entry('a', 'semantic', '奶茶店', 100)])
    const spy = vi.fn<MemoryQueryHitWriter>(async () => {})
    const ts = new MemoryToolset({ memory: mem, queryHit: spy })
    await ts.callTool('recall', {}) // recency recall, no query term
    expect(spy).not.toHaveBeenCalled()
  })
})
