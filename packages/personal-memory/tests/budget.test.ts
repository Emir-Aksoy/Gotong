/**
 * Disk-budget auto-management (decision B / 用户 Q2「按设置的可用文件夹大小自动
 * 管理记忆文件大小」).
 *
 * Pure deterministic eviction — no LLM, no summarizer. Tests assert on WHICH
 * entries survive (by id) under a known byte budget, so they don't depend on
 * exact meta-JSON sizes: every body is ASCII so 1 char == 1 byte, and budgets
 * sit with comfortable margin around whole-entry boundaries.
 */

import { describe, expect, it } from 'vitest'

import {
  budgetReviewer,
  enforceBudget,
  importanceOf,
  tieredReviewer,
  type MemorySummarizer,
  type ReviewContext,
} from '../src/index.js'
import { entry, makeFakeMemory, type FakeMemory } from './fake-memory.js'

const BODY = 'x'.repeat(1000) // 1000 bytes of ASCII
const idsOf = (mem: FakeMemory): string[] => mem.entries.map((e) => e.id).sort()
const has = (mem: FakeMemory, id: string): boolean => mem.entries.some((e) => e.id === id)

const ep = (id: string, ts: number, importance?: number, extra?: Record<string, unknown>) =>
  entry(id, 'episodic', BODY, ts, importance !== undefined || extra ? { ...extra, ...(importance !== undefined ? { importance } : {}) } : undefined)

const semAdHoc = (id: string, ts: number) => entry(id, 'semantic', BODY, ts)
const semDigest = (id: string, ts: number, importance = 3) =>
  entry(id, 'semantic', BODY, ts, { tier: 'misc', level: 'digest', importance })
const semProfile = (id: string, ts: number, importance = 5) =>
  entry(id, 'semantic', BODY, ts, { tier: 'misc', level: 'profile', profile: true, importance })

describe('enforceBudget', () => {
  it('returns null when already at/under budget (nothing to do)', async () => {
    const mem = makeFakeMemory([ep('a', 100), ep('b', 101), ep('c', 102)])
    const res = await enforceBudget({ memory: mem, budgetBytes: 100_000 })
    expect(res).toBeNull()
    expect(mem.entries.length).toBe(3) // untouched
  })

  it('evicts by level rank: episodic → ad-hoc semantic → digest → profile', async () => {
    const mem = makeFakeMemory([
      ep('ep1', 100),
      ep('ep2', 101),
      semAdHoc('sem1', 102),
      semDigest('dig1', 103),
      semProfile('prof1', 104),
    ])
    // start ≈ 5000+meta; budget 2500 → drop the 3 lowest-rank, keep digest+profile.
    const res = await enforceBudget({ memory: mem, budgetBytes: 2500, protectRecentEpisodic: 0 })
    expect(res).not.toBeNull()
    expect(res!.evicted).toBe(3)
    expect(res!.stillOverBudget).toBe(false)
    expect(idsOf(mem)).toEqual(['dig1', 'prof1']) // the two most valuable layers survive
  })

  it('within a rank, evicts lowest importance first', async () => {
    const mem = makeFakeMemory([
      ep('hi', 100, 5),
      ep('lo', 101, 1),
      ep('mid', 102, 3),
    ])
    const res = await enforceBudget({ memory: mem, budgetBytes: 2500, protectRecentEpisodic: 0 })
    expect(res!.evicted).toBe(1)
    expect(has(mem, 'lo')).toBe(false) // importance 1 goes first despite being newer than 'hi'
    expect(has(mem, 'hi')).toBe(true)
    expect(has(mem, 'mid')).toBe(true)
  })

  it('within a rank+importance tie, evicts oldest first', async () => {
    const mem = makeFakeMemory([ep('old', 100), ep('mid', 101), ep('new', 102)]) // all importance 3
    const res = await enforceBudget({ memory: mem, budgetBytes: 2500, protectRecentEpisodic: 0 })
    expect(res!.evicted).toBe(1)
    expect(has(mem, 'old')).toBe(false)
    expect(idsOf(mem)).toEqual(['mid', 'new'])
  })

  it('never evicts the most recent N episodic, even if it stays over budget', async () => {
    const mem = makeFakeMemory([ep('e100', 100), ep('e101', 101), ep('e102', 102)])
    // protect the 2 newest; only e100 is evictable; budget far too small to fit the rest.
    const res = await enforceBudget({ memory: mem, budgetBytes: 500, protectRecentEpisodic: 2 })
    expect(res!.evicted).toBe(1)
    expect(has(mem, 'e100')).toBe(false)
    expect(has(mem, 'e101')).toBe(true)
    expect(has(mem, 'e102')).toBe(true)
    expect(res!.stillOverBudget).toBe(true) // honest: protected remainder exceeds the ceiling
  })

  it('stops as soon as it is under budget (does not over-evict)', async () => {
    const mem = makeFakeMemory([ep('a', 100), ep('b', 101), ep('c', 102), ep('d', 103)])
    // start ≈ 4000; budget 2500 → evict exactly 2 (down to ≈2000), leave 2.
    const res = await enforceBudget({ memory: mem, budgetBytes: 2500, protectRecentEpisodic: 0 })
    expect(res!.evicted).toBe(2)
    expect(mem.entries.length).toBe(2)
    expect(res!.finalBytes).toBeLessThanOrEqual(2500)
  })

  it('scopes to one namespace via filter (per-user no-leak)', async () => {
    const mem = makeFakeMemory([
      entry('alice1', 'episodic', BODY, 100, { user: 'alice' }),
      entry('bob1', 'episodic', BODY, 101, { user: 'bob' }),
    ])
    const res = await enforceBudget({
      memory: mem,
      budgetBytes: 100,
      protectRecentEpisodic: 0,
      filter: (e) => (e.meta as { user?: string } | undefined)?.user === 'alice',
    })
    expect(res!.evicted).toBe(1)
    expect(has(mem, 'alice1')).toBe(false)
    expect(has(mem, 'bob1')).toBe(true) // another user's memory is never touched
  })

  it('uses the injected measure as the authority over byte counting', async () => {
    const mem = makeFakeMemory([ep('a', 100), ep('b', 101), ep('c', 102)])
    let calls = 0
    // measure claims the namespace is tiny regardless of real entry size →
    // enforceBudget sees under-budget and does nothing.
    const res = await enforceBudget({
      memory: mem,
      budgetBytes: 100,
      measure: () => {
        calls++
        return 50
      },
    })
    expect(res).toBeNull()
    expect(calls).toBe(1)
    expect(mem.entries.length).toBe(3) // injected measure said "fine" → no eviction
  })
})

describe('budgetReviewer', () => {
  const ctx = (mem: FakeMemory): ReviewContext => ({ memory: mem, episodic: [], now: 5_000_000 })

  it('returns {} (idle) when under budget', async () => {
    const mem = makeFakeMemory([ep('a', 100)])
    const out = await budgetReviewer({ budgetBytes: 100_000 })(ctx(mem))
    expect(out).toEqual({})
  })

  it('returns a one-line summary when it evicts', async () => {
    const mem = makeFakeMemory([ep('a', 100), ep('b', 101), ep('c', 102)])
    const out = await budgetReviewer({ budgetBytes: 1500, protectRecentEpisodic: 0 })(ctx(mem))
    expect(out.summary).toMatch(/budget: evicted \d+/)
    expect(mem.entries.length).toBeLessThan(3)
  })
})

describe('tieredReviewer budget backstop', () => {
  const noopSummarizer: MemorySummarizer = async () => ''
  const ctx = (mem: FakeMemory): ReviewContext => ({ memory: mem, episodic: [], now: 5_000_000 })

  it('does NOT evict when no budgetBytes is set (opt-in, zero regression)', async () => {
    const mem = makeFakeMemory([semAdHoc('s1', 100), semAdHoc('s2', 101), semAdHoc('s3', 102)])
    const out = await tieredReviewer({ summarize: noopSummarizer })(ctx(mem))
    expect(out).toEqual({})
    expect(mem.entries.length).toBe(3) // nothing consolidated, nothing evicted
  })

  it('enforces the byte ceiling after consolidate+promote when budgetBytes is set', async () => {
    const mem = makeFakeMemory([semAdHoc('s1', 100), semAdHoc('s2', 101), semAdHoc('s3', 102), semAdHoc('s4', 103), semAdHoc('s5', 104)])
    // No episodic to consolidate, no digests to promote → only the budget step acts.
    const out = await tieredReviewer({
      summarize: noopSummarizer,
      budgetBytes: 2500,
      protectRecentEpisodic: 0,
    })(ctx(mem))
    expect(out.summary).toMatch(/budget evicted \d+/)
    expect(mem.entries.length).toBe(2) // 5000 → evict 3 → ≈2000 under 2500
    // oldest ad-hoc semantics go first (importance tie)
    expect(idsOf(mem)).toEqual(['s4', 's5'])
  })
})

describe('importanceOf sanity (eviction ordering depends on it)', () => {
  it('defaults to 3 and reads meta.importance', () => {
    expect(importanceOf(ep('a', 1))).toBe(3)
    expect(importanceOf(ep('b', 1, 1))).toBe(1)
    expect(importanceOf(ep('c', 1, 5))).toBe(5)
  })
})

const DAY = 24 * 60 * 60 * 1000

describe('enforceBudget — salience (decision F-M2), opt-in', () => {
  it('without salience: eviction is byte-identical to importance-then-recency', async () => {
    // Two equal-importance episodic, budget drops exactly 1 → oldest goes (ts tiebreak).
    const mem = makeFakeMemory([ep('old', 0, 3), ep('new', 200, 3)])
    const res = await enforceBudget({ memory: mem, budgetBytes: 1500, protectRecentEpisodic: 0 })
    expect(res!.evicted).toBe(1)
    expect(has(mem, 'new')).toBe(true) // newer survives — unchanged pre-F behavior
    expect(has(mem, 'old')).toBe(false)
  })

  it('reinforcement keeps a heavily-recalled entry even though it is older', async () => {
    // OFF → oldest (hot) evicted. ON → hot has high keep-value, the un-recalled one goes.
    const hot = ep('hot', 0, 3, { recallCount: 10 })
    const cold = ep('cold', 200, 3)
    const mkMem = () => makeFakeMemory([{ ...hot }, { ...cold }])

    const off = mkMem()
    await enforceBudget({ memory: off, budgetBytes: 1500, protectRecentEpisodic: 0 })
    expect(has(off, 'hot')).toBe(false) // OFF: older 'hot' evicted

    const on = mkMem()
    await enforceBudget({
      memory: on,
      budgetBytes: 1500,
      protectRecentEpisodic: 0,
      salience: { reinforceWeight: 0.5 },
      now: () => 1000,
    })
    expect(has(on, 'hot')).toBe(true) // ON: reinforcement saves 'hot'
    expect(has(on, 'cold')).toBe(false) // the un-recalled one is dropped instead
  })

  it('decay can invert importance: a faded high-importance entry is evicted first', async () => {
    // 'stale' is more important (3) but 4 half-lives old; 'fresh' is less important (2) but new.
    const stale = ep('stale', 0, 3)
    const fresh = ep('fresh', 119 * DAY, 2)
    const mkMem = () => makeFakeMemory([{ ...stale }, { ...fresh }])

    const off = mkMem()
    await enforceBudget({ memory: off, budgetBytes: 1500, protectRecentEpisodic: 0 })
    expect(has(off, 'stale')).toBe(true) // OFF: importance 3 > 2 → 'fresh' evicted
    expect(has(off, 'fresh')).toBe(false)

    const on = mkMem()
    await enforceBudget({
      memory: on,
      budgetBytes: 1500,
      protectRecentEpisodic: 0,
      salience: { halfLifeMs: 30 * DAY },
      now: () => 120 * DAY,
    })
    expect(has(on, 'stale')).toBe(false) // ON: decay drops the faded high-importance one
    expect(has(on, 'fresh')).toBe(true)
  })

  it('pins never fade under decay — a year-old pin outlives a fresh non-pin', async () => {
    const pin = ep('pin', 0, 5) // a year old, but pinned
    const recent = ep('recent', 300 * DAY, 4) // fresh, high-but-not-pin
    const mem = makeFakeMemory([pin, recent])
    await enforceBudget({
      memory: mem,
      budgetBytes: 1500,
      protectRecentEpisodic: 0,
      salience: { halfLifeMs: 30 * DAY },
      now: () => 365 * DAY,
    })
    expect(has(mem, 'pin')).toBe(true) // pin survives despite age (no fade)
    expect(has(mem, 'recent')).toBe(false)
  })

  it('decay still respects level rank — a faded profile outlives a fresh episodic', async () => {
    // Level dominates salience: episodic (rank 0) is dropped before any semantic,
    // even a much older, faded profile.
    const freshEp = ep('freshEp', 120 * DAY, 5) // fresh + pinned, but episodic
    const oldProfile = semProfile('oldProfile', 0, 3) // ancient, lower importance, but profile
    const mem = makeFakeMemory([freshEp, oldProfile])
    await enforceBudget({
      memory: mem,
      budgetBytes: 1500,
      protectRecentEpisodic: 0,
      salience: { halfLifeMs: 30 * DAY },
      now: () => 120 * DAY,
    })
    expect(has(mem, 'freshEp')).toBe(false) // episodic evicted first regardless of salience
    expect(has(mem, 'oldProfile')).toBe(true)
  })
})
