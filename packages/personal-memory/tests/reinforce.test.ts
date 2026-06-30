/**
 * Recall reinforcement (F-M3) — opt-in, best-effort, frozen-block byte-stable.
 *
 * The two load-bearing claims:
 *   1. OFF by default — a toolset with no `reinforce` never touches meta; recall
 *      is byte-identical to pre-F.
 *   2. ON — each recalled entry gets recallCount bumped + lastRecalledTs stamped,
 *      which lifts effectiveSalience, WITHOUT moving the frozen block (the block
 *      orders by importance/ts/id and prints neither recallCount nor ts).
 */

import { describe, expect, it, vi } from 'vitest'

import {
  effectiveSalience,
  MemoryToolset,
  recallCountOf,
  reinforcedMeta,
  renderFrozenBlock,
  type MemoryReinforcer,
} from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

function recallText(out: { content: ReadonlyArray<unknown>; isError?: boolean }): string {
  return (out.content[0] as { text: string }).text
}

describe('recall reinforcement — OFF by default', () => {
  it('with no reinforce option, recall works and meta is untouched', async () => {
    const mem = makeFakeMemory([entry('e1', 'semantic', '我爱奶茶', 100, { importance: 3 })])
    const ts = new MemoryToolset({ memory: mem })
    const out = await ts.callTool('recall', { query: '奶茶' })
    expect(out.isError).toBeUndefined()
    expect(recallText(out)).toContain('奶茶')
    expect(recallCountOf(mem.entries[0]!)).toBe(0) // never reinforced
  })
})

describe('recall reinforcement — ON (opt-in)', () => {
  it('calls the reinforcer once per returned entry, with the injected clock', async () => {
    const mem = makeFakeMemory([
      entry('a', 'semantic', '奶茶店', 100),
      entry('b', 'semantic', '奶茶好喝', 200),
      entry('c', 'semantic', '篮球', 300),
    ])
    const spy = vi.fn<MemoryReinforcer>(async () => {})
    const ts = new MemoryToolset({ memory: mem, reinforce: spy, now: () => 5000 })
    await ts.callTool('recall', { query: '奶茶' })
    // 'a' and 'b' match 奶茶; 'c' does not → exactly two reinforcements.
    expect(spy).toHaveBeenCalledTimes(2)
    for (const call of spy.mock.calls) expect(call[1]).toBe(5000) // now passed through
    expect(spy.mock.calls.map((c) => c[0].id).sort()).toEqual(['a', 'b'])
  })

  it('is best-effort: a throwing reinforcer never turns a good recall into an error', async () => {
    const mem = makeFakeMemory([entry('e1', 'semantic', '奶茶', 100)])
    const boom: MemoryReinforcer = async () => {
      throw new Error('disk full')
    }
    const ts = new MemoryToolset({ memory: mem, reinforce: boom })
    const out = await ts.callTool('recall', { query: '奶茶' })
    expect(out.isError).toBeUndefined() // recall still succeeds
    expect(recallText(out)).toContain('奶茶')
  })

  it('an in-place meta patch accumulates across recalls and lifts salience', async () => {
    const mem = makeFakeMemory([entry('e1', 'semantic', '我爱奶茶', 100, { importance: 3 })])
    // Simulate the host's file-backed patch: replace the entry's meta in place,
    // preserving id + ts + text (the contract a real reinforcer must honor).
    const reinforce: MemoryReinforcer = async (e, now) => {
      const i = mem.entries.findIndex((x) => x.id === e.id)
      // reinforcedMeta is a DELTA — merge it onto the current meta (the shallow
      // merge a real patchMeta does), so importance and friends are preserved.
      if (i >= 0)
        mem.entries[i] = {
          ...mem.entries[i]!,
          meta: { ...mem.entries[i]!.meta, ...reinforcedMeta(mem.entries[i]!, now) },
        }
    }
    let clock = 5000
    const ts = new MemoryToolset({ memory: mem, reinforce, now: () => clock })

    await ts.callTool('recall', { query: '奶茶' })
    expect(recallCountOf(mem.entries[0]!)).toBe(1)
    clock = 6000
    await ts.callTool('recall', { query: '奶茶' })
    expect(recallCountOf(mem.entries[0]!)).toBe(2)

    const opts = { reinforceWeight: 0.5 }
    const after = effectiveSalience(mem.entries[0]!, 6000, opts)
    expect(after).toBeGreaterThan(3) // reinforced → keep-value above bare importance
    expect(mem.entries[0]!.ts).toBe(100) // ts preserved — frozen block won't move
  })
})

describe('frozen block is byte-stable under reinforcement', () => {
  it('reinforcing entries (recallCount/lastRecalledTs only) leaves the block identical', () => {
    const entries = [
      entry('a', 'semantic', '在做 AipeHub 项目', 200, { importance: 5 }),
      entry('b', 'semantic', '喜欢喝奶茶', 100, { importance: 3 }),
      entry('c', 'semantic', '住在马来西亚', 150),
    ]
    const before = renderFrozenBlock(entries, { label: 'butler' })

    // Reinforce each differently — counts vary, timestamps stamped — but only
    // meta.recallCount / meta.lastRecalledTs change; id / ts / text / importance
    // are preserved (reinforcedMeta is a delta, the caller merges it on).
    let n = 0
    const reinforced = entries.map((e) => {
      let meta = e.meta
      for (let i = 0; i < (n++ % 3) + 1; i++) meta = { ...meta, ...reinforcedMeta({ meta }, 9000 + i) }
      return { ...e, meta }
    })
    const after = renderFrozenBlock(reinforced, { label: 'butler' })

    expect(after).toBe(before) // prompt-cache prefix unmoved
    // sanity: the reinforcement really happened (so the equality is meaningful).
    expect(recallCountOf(reinforced[0]!)).toBeGreaterThan(0)
  })
})
