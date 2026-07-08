/**
 * memory-consolidation — the MU-M3 consolidation-lift承重门.
 *
 * MU-M1's `semantic` category sits at recall 0: a query 「饮料」 cannot reach
 * 「珍珠奶茶」 because they share no term, and neither keyword nor a char-overlap
 * embedder (MU-M2) can bridge a true synonym. MU-M3 closes it at the MEMORY layer,
 * not the retriever: the 6h atomic-fact extraction writes a SELF-CONTAINED fact
 * 「用户最爱的饮料是珍珠奶茶」 — which carries BOTH the category word and the
 * specific — so the category query hits it directly.
 *
 * This gate measures that end-to-end lift deterministically (a fixed extraction,
 * no LLM): the SAME synonym queries that scored 0 before consolidation score 1
 * after. It is the honest complement to the pure-retrieval bench — M3 doesn't
 * change the retriever, it improves what's in the store for the retriever to find.
 */

import { describe, expect, it } from 'vitest'

import {
  atomicFactsReviewer,
  buildInvertedIndex,
  invertedIndexRetriever,
  type MemorySummarizer,
} from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

const T = 1_700_000_000_000

/** Each synonym case: a raw episodic mention (specific, no category word), a few
 *  category-word decoys, the category query, and the atomic fact extraction should
 *  produce. Query shares no term with the episodic answer → recall 0 pre-M3. */
const CASES = [
  {
    q: '饮料',
    answer: '珍珠奶茶',
    episodic: 'User: 上周点了一杯珍珠奶茶很好喝 / Butler: 嗯',
    decoys: ['冰箱里有饮料', '便利店买了饮料'],
    fact: '用户最爱的饮料是珍珠奶茶',
  },
  {
    q: '宠物',
    answer: '大黄',
    episodic: 'User: 我养了只金毛叫大黄 / Butler: 好',
    decoys: ['楼下宠物店促销', '宠物医院要预约'],
    fact: '用户养的宠物是一只叫大黄的金毛',
  },
  {
    q: 'electric vehicle',
    answer: 'Tesla',
    episodic: 'User: I drive a Tesla Model 3 / Butler: noted',
    decoys: ['my vehicle registration expired', 'the electric bill was high'],
    fact: "the user's vehicle is an electric Tesla Model 3",
  },
]

/** Fraction of cases whose category query surfaces the specific answer in top-5. */
async function recallOfAnswers(corpusFor: (c: (typeof CASES)[number]) => ReturnType<typeof entry>[]): Promise<number> {
  let hits = 0
  for (const c of CASES) {
    const page = await invertedIndexRetriever(buildInvertedIndex(corpusFor(c))).retrieve({
      text: c.q,
      k: 5,
    })
    if (page.some((e) => e.text.includes(c.answer))) hits++
  }
  return hits / CASES.length
}

describe('MU-M3 consolidation lift — atomic facts close the synonym gap', () => {
  it('the same synonym queries go from recall 0 → 1 after fact extraction', async () => {
    // BEFORE: only raw episodic + category-word decoys. The category query cannot
    // reach the specific answer (no shared term) → recall 0.
    const before = await recallOfAnswers((c) => [
      entry(`${c.q}-ep`, 'episodic', c.episodic, T + 1),
      ...c.decoys.map((d, i) => entry(`${c.q}-d${i}`, 'semantic', d, T + 10 + i)),
    ])
    expect(before).toBe(0)

    // Run the 6h extraction ONCE over all episodic with a fixed (deterministic)
    // summarizer — this is what the butler's maintenance does on its own model.
    const allEpisodic = [
      ...CASES.map((c, i) => entry(`ep-${i}`, 'episodic', c.episodic, T + 10 + i)),
      entry('ep-filler', 'episodic', 'User: 今天天气不错 / Butler: 是的', T + 20), // ≥ trigger
    ]
    const memory = makeFakeMemory(allEpisodic)
    const summarize: MemorySummarizer = async () => CASES.map((c) => c.fact).join('\n')
    const out = await atomicFactsReviewer({ summarize })({ memory, episodic: allEpisodic, now: T + 100 })
    expect(out.consolidated).toBe(3)
    const facts = await memory.recall({ kinds: ['semantic'], k: 50 })

    // AFTER: episodic + decoys + the extracted self-contained facts. Now the
    // category query hits the bridging fact, which carries the specific answer.
    const after = await recallOfAnswers((c) => [
      entry(`${c.q}-ep`, 'episodic', c.episodic, T + 1),
      ...c.decoys.map((d, i) => entry(`${c.q}-d${i}`, 'semantic', d, T + 10 + i)),
      ...facts.map((f, i) => entry(`${c.q}-f${i}`, 'semantic', f.text, T + 50 + i)),
    ])
    expect(after).toBe(1)

    // eslint-disable-next-line no-console
    console.log(`\n【MU-M3 蒸馏抬升】semantic 类 recall@5:  ${before * 100}%  →  ${after * 100}%\n`)
    expect(after).toBeGreaterThan(before)
  })
})
