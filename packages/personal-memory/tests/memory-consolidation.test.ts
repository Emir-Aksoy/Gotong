/** Exact-source extraction preserves grounded recall; it does not invent synonym bridges. */
import { describe, expect, it } from 'vitest'

import { atomicFactsReviewer, buildInvertedIndex, invertedIndexRetriever } from '../src/index.js'
import { evidenceSources } from '../src/evidence.js'
import { entry, makeFakeMemory } from './fake-memory.js'

const T = 1_700_000_000_000
const CASES = [
  { id: 'pet', q: '金毛', synonym: '宠物', answer: '大黄', user: '我养了只金毛叫大黄' },
  { id: 'car', q: 'Tesla', synonym: 'electric vehicle', answer: 'Model 3', user: 'I drive a Tesla Model 3' },
]

describe('MU-M3 evidence-grounded consolidation', () => {
  it('recalls durable user statements without inferring a favorite from one purchase', async () => {
    const users = [
      ...CASES,
      { id: 'purchase', user: '上周点了一杯珍珠奶茶很好喝' },
      { id: 'filler', user: '今天天气不错' },
    ]
    const episodic = users.map(({ id, user }, i) => entry(id, 'episodic', `User: ${user} / Butler: 用户最爱的饮料是珍珠奶茶`, T + i, {
      userSpan: { v: 1, start: 6, end: 6 + user.length },
    }))
    const memory = makeFakeMemory(episodic)
    // This deterministic selector tests storage/recall, not a real model's durability judgment.
    const summarize = async () => JSON.stringify({ sources: CASES.map(c => c.id) })
    const out = await atomicFactsReviewer({ summarize })({ memory, episodic, now: T + 100 })
    expect(out.consolidated).toBe(2)
    const facts = await memory.list({ kind: 'semantic', limit: 50 })
    expect(facts.map(f => f.text).sort()).toEqual(CASES.map(c => c.user).sort())
    expect(facts.flatMap(evidenceSources).map(s => s.sourceId).sort()).toEqual(['car', 'pet'])
    expect(facts.some(f => /最爱|favorite|珍珠奶茶/.test(f.text))).toBe(false)

    let before = 0
    let after = 0
    for (const c of CASES) {
      const baseline = await invertedIndexRetriever(buildInvertedIndex(episodic)).retrieve({ text: c.q, k: 5 })
      const grounded = await invertedIndexRetriever(buildInvertedIndex(facts)).retrieve({ text: c.q, k: 5 })
      if (baseline.some(f => f.text.includes(c.answer))) before++
      if (grounded.some(f => f.text.includes(c.answer))) after++
      const synonym = await invertedIndexRetriever(buildInvertedIndex(facts)).retrieve({ text: c.synonym, k: 5 })
      expect(synonym.some(f => f.text.includes(c.answer))).toBe(false)
    }
    expect(before).toBe(CASES.length)
    expect(after).toBe(CASES.length)
    console.log(`\n【MU-M3 证据保真】原词 recall@5: ${before / CASES.length * 100}% → ${after / CASES.length * 100}%; 无虚构最爱、无同义词抬升声明\n`)
  })

  it('cannot turn even a wrongly selected purchase into a stronger preference claim', async () => {
    const user = '上周点了一杯珍珠奶茶很好喝'
    const episodic = [entry('purchase', 'episodic', `User: ${user} / Butler: 用户最爱的饮料是珍珠奶茶`, T, {
      userSpan: { v: 1, start: 6, end: 6 + user.length },
    })]
    const memory = makeFakeMemory(episodic)
    await atomicFactsReviewer({ summarize: async () => '{"sources":["purchase"]}', triggerEntries: 1 })(
      { memory, episodic, now: T },
    )
    expect((await memory.list({ kind: 'semantic', limit: 50 })).map(f => f.text)).toEqual([user])
  })
})
