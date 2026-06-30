/**
 * cleanOutputs / cleanOutputsReviewer (MR4 ② 清输出).
 *
 * The "清输出" maintenance pass prunes STALE ephemeral `working` scratch by age,
 * never touching the truth (`episodic`) or the durable profile (`semantic`).
 */

import { describe, expect, it } from 'vitest'

import {
  cleanOutputs,
  cleanOutputsReviewer,
  DEFAULT_CLEAN_STALE_MS,
} from '../src/clean-outputs.js'
import { entry, makeFakeMemory } from './fake-memory.js'

const NOW = 10_000_000

describe('cleanOutputs', () => {
  it('prunes working entries older than staleMs, keeping fresh ones', async () => {
    const mem = makeFakeMemory([
      entry('old1', 'working', '工具输出: 旧 scratch', NOW - 2 * DEFAULT_CLEAN_STALE_MS),
      entry('old2', 'working', '工具输出: 也旧', NOW - DEFAULT_CLEAN_STALE_MS - 1),
      entry('fresh', 'working', '刚刚的 scratch', NOW - 1000), // well within the window
    ])
    const r = await cleanOutputs({ memory: mem, now: NOW })
    expect(r.pruned).toBe(2)
    expect(r.scanned).toBe(3)
    const left = mem.entries.map((e) => e.id)
    expect(left).toEqual(['fresh'])
  })

  it('never touches episodic (truth) or semantic (profile)', async () => {
    const mem = makeFakeMemory([
      entry('ep', 'episodic', '一条很旧的对话', 1),
      entry('sem', 'semantic', '主人的画像', 1),
      entry('work', 'working', '很旧的 scratch', 1),
    ])
    const r = await cleanOutputs({ memory: mem, now: NOW, staleMs: 0 })
    expect(r.pruned).toBe(1) // only the working entry (kind selectivity, regardless of age)
    expect(mem.entries.map((e) => e.id).sort()).toEqual(['ep', 'sem'])
  })

  it('staleMs:0 wipes all target scratch regardless of age', async () => {
    const mem = makeFakeMemory([
      entry('w1', 'working', 'a', NOW - 1),
      entry('w2', 'working', 'b', NOW), // even one stamped exactly NOW
    ])
    const r = await cleanOutputs({ memory: mem, now: NOW, staleMs: 0 })
    expect(r.pruned).toBe(2)
    expect(mem.entries.length).toBe(0)
  })

  it('max caps the prune, dropping the STALEST first', async () => {
    const mem = makeFakeMemory([
      entry('w1', 'working', 'oldest', 100),
      entry('w2', 'working', 'middle', 200),
      entry('w3', 'working', 'newest-stale', 300),
    ])
    const r = await cleanOutputs({ memory: mem, now: NOW, staleMs: 0, max: 2 })
    expect(r.pruned).toBe(2)
    // The two oldest go; the newest-stale survives this capped sweep.
    expect(mem.entries.map((e) => e.id)).toEqual(['w3'])
  })

  it('filter scopes to one namespace (per-user no-leak)', async () => {
    const mem = makeFakeMemory([
      entry('a1', 'working', 'alice scratch', 1, { user: 'alice' }),
      entry('b1', 'working', 'bob scratch', 1, { user: 'bob' }),
    ])
    const r = await cleanOutputs({
      memory: mem,
      now: NOW,
      staleMs: 0,
      filter: (e) => (e.meta as { user?: string } | undefined)?.user === 'alice',
    })
    expect(r.pruned).toBe(1)
    expect(mem.entries.map((e) => e.id)).toEqual(['b1']) // bob's untouched
  })

  it('can clean other configured kinds (e.g. episodic) when asked', async () => {
    const mem = makeFakeMemory([entry('ep', 'episodic', 'x', 1), entry('w', 'working', 'y', 1)])
    const r = await cleanOutputs({ memory: mem, now: NOW, staleMs: 0, kinds: ['episodic'] })
    expect(r.pruned).toBe(1)
    expect(mem.entries.map((e) => e.id)).toEqual(['w']) // working left, episodic gone
  })
})

describe('cleanOutputsReviewer', () => {
  it('summarizes a prune and is idle when nothing is stale', async () => {
    const mem = makeFakeMemory([entry('w', 'working', 'old scratch', 1)])
    const review = cleanOutputsReviewer({ staleMs: 0 })

    const first = await review({ memory: mem, episodic: [], now: NOW })
    expect(first).toEqual({ summary: 'cleaned 1 stale output' })

    // Converged — the second tick finds nothing → {} (HEARTBEAT_OK, suppressed).
    const second = await review({ memory: mem, episodic: [], now: NOW })
    expect(second).toEqual({})
  })

  it('pluralizes the summary', async () => {
    const mem = makeFakeMemory([
      entry('w1', 'working', 'a', 1),
      entry('w2', 'working', 'b', 1),
    ])
    const out = await cleanOutputsReviewer({ staleMs: 0 })({ memory: mem, episodic: [], now: NOW })
    expect(out).toEqual({ summary: 'cleaned 2 stale outputs' })
  })
})
