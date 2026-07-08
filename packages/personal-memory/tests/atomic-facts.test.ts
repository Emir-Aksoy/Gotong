/**
 * atomic-facts — Mem0-style extraction in the 6h consolidation (MU-M3).
 *
 * The claims: it writes SELF-CONTAINED facts to semantic (category + specific, so
 * a category query can hit them), it DEDUPS against what's already known (a stable
 * fact isn't rewritten every 6h), it stays quiet below the trigger, and the one
 * model call is the injected summarizer (the leaf never imports an LLM).
 */

import { describe, expect, it } from 'vitest'

import { atomicFactsReviewer, isAtomicFact, parseFacts } from '../src/index.js'
import type { MemorySummarizer } from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

const T = 1_700_000_000_000

/** A summarizer that returns a fixed extraction — deterministic, no LLM. */
const fixedSummarizer = (facts: string): MemorySummarizer => async () => facts

/** Four raw episodic turns (past the default trigger of 4). */
function episodicTurns(): ReturnType<typeof entry>[] {
  return [
    entry('e4', 'episodic', 'User: 我车是特斯拉 Model 3 / Butler: 记下了', T + 40),
    entry('e3', 'episodic', 'User: 我养了只金毛叫大黄 / Butler: 好', T + 30),
    entry('e2', 'episodic', 'User: 顺便一提我最近很忙 / Butler: 注意休息', T + 20),
    entry('e1', 'episodic', 'User: 上周点了珍珠奶茶很好喝 / Butler: 嗯', T + 10),
  ]
}

describe('atomicFactsReviewer', () => {
  it('writes self-contained facts to semantic with a provenance marker', async () => {
    const memory = makeFakeMemory(episodicTurns())
    const reviewer = atomicFactsReviewer({
      summarize: fixedSummarizer('用户最爱的饮料是珍珠奶茶\n用户养的宠物是一只叫大黄的金毛'),
    })
    const out = await reviewer({ memory, episodic: episodicTurns(), now: T + 100 })

    expect(out.consolidated).toBe(2)
    const semantic = await memory.recall({ kinds: ['semantic'], k: 50 })
    expect(semantic.map((e) => e.text).sort()).toEqual(
      ['用户养的宠物是一只叫大黄的金毛', '用户最爱的饮料是珍珠奶茶'].sort(),
    )
    expect(semantic.every(isAtomicFact)).toBe(true)
  })

  it('dedups against an existing known fact (no rewrite every 6h)', async () => {
    const memory = makeFakeMemory([
      ...episodicTurns(),
      entry('s1', 'semantic', '用户最爱的饮料是珍珠奶茶', T + 5),
    ])
    const reviewer = atomicFactsReviewer({
      summarize: fixedSummarizer('用户最爱的饮料是珍珠奶茶\n用户养的宠物是一只叫大黄的金毛'),
    })
    const out = await reviewer({ memory, episodic: episodicTurns(), now: T + 100 })
    // Only the NEW pet fact is written; the drink fact is already known.
    expect(out.consolidated).toBe(1)
    const facts = (await memory.recall({ kinds: ['semantic'], k: 50 })).filter(isAtomicFact)
    expect(facts.map((e) => e.text)).toEqual(['用户养的宠物是一只叫大黄的金毛'])
  })

  it('dedups against an OLD fact buried beyond the former newest-200 window (audit P2)', async () => {
    // 210 newer, unrelated semantic fillers sit ON TOP of one old duplicate
    // target. A newest-200 recall window would never see the buried fact, so the
    // model's re-statement of it would be written AGAIN every 6h — semantic bloat.
    // The full-store scan catches it and stays quiet.
    const fillers = Array.from({ length: 210 }, (_, i) =>
      entry(`f${i}`, 'semantic', `无关事实编号 ${i}`, T + 1000 + i),
    )
    const memory = makeFakeMemory([
      ...episodicTurns(),
      entry('old', 'semantic', '用户最爱的饮料是珍珠奶茶', T + 1), // oldest → outside newest-200
      ...fillers,
    ])
    const reviewer = atomicFactsReviewer({
      summarize: fixedSummarizer('用户最爱的饮料是珍珠奶茶'), // a re-statement of the buried fact
    })
    const out = await reviewer({ memory, episodic: episodicTurns(), now: T + 100 })

    expect(out).toEqual({}) // deduped against the buried old fact → nothing written
    const drink = (await memory.list({ kind: 'semantic', limit: 10_000 })).filter(
      (e) => e.text === '用户最爱的饮料是珍珠奶茶',
    )
    expect(drink).toHaveLength(1) // still exactly one copy, not re-written
  })

  it('dedups repeats WITHIN one pass', async () => {
    const memory = makeFakeMemory(episodicTurns())
    const reviewer = atomicFactsReviewer({
      summarize: fixedSummarizer('用户最爱的饮料是珍珠奶茶\n- 用户最爱的饮料是珍珠奶茶'),
    })
    const out = await reviewer({ memory, episodic: episodicTurns(), now: T + 100 })
    expect(out.consolidated).toBe(1)
  })

  it('stays idle below the trigger', async () => {
    const memory = makeFakeMemory([])
    const few = [entry('e1', 'episodic', 'User: hi', T + 1)]
    const reviewer = atomicFactsReviewer({ summarize: fixedSummarizer('用户喜欢咖啡') })
    const out = await reviewer({ memory, episodic: few, now: T + 100 })
    expect(out).toEqual({}) // no summary, no writes
    expect(await memory.recall({ kinds: ['semantic'], k: 50 })).toHaveLength(0)
  })

  it('stays idle when the model extracts nothing', async () => {
    const memory = makeFakeMemory(episodicTurns())
    const reviewer = atomicFactsReviewer({ summarize: fixedSummarizer('   \n\n') })
    const out = await reviewer({ memory, episodic: episodicTurns(), now: T + 100 })
    expect(out).toEqual({})
  })

  it('parseFacts strips markers, drops blanks and over-long lines, caps count', () => {
    const raw = ['- 事实一', '1. 事实二', '', '   ', '事'.repeat(300), '• 事实三'].join('\n')
    expect(parseFacts(raw, 10)).toEqual(['事实一', '事实二', '事实三'])
    expect(parseFacts(raw, 2)).toEqual(['事实一', '事实二'])
  })
})
