/**
 * semantic-lift.test.ts — the M-EMB1 ruler graduation.
 *
 * The recall benchmark (`memory-recall-bench`) pins the `semantic` category at
 * recall 0 for BOTH the keyword baseline and the LOCAL fusion embedder — a true
 * synonym (「饮料」↛「珍珠奶茶」) shares no character with its answer, so a
 * lexical signal can never bridge it. That gate measures the PRODUCTION DEFAULT
 * (`fusion: {}`, local embedder) and is untouched here.
 *
 * This test measures the OTHER side of the seam: inject a REAL semantic embedder
 * (M-EMB1's opt-in `fusion.embed`) and the synonym IS bridged. It uses a
 * deterministic concept-axis embedder as a stand-in for a real sentence embedder
 * (nomic-embed-text / text-embedding-3-small, which production supplies via the
 * host `httpEmbedder`): the point proven is that the retriever + fusion MATH
 * correctly turn semantic vectors into recall a char-overlap signal can't reach.
 *
 * The honest boundary is asserted too: an embedder ALONE does NOT move the gate's
 * decoy-hardened `semantic` cases (six distractors that DO contain the query
 * word bury the gold on both arms). Bridging those needs MU-M3's consolidated
 * atomic fact, not just an embedder — so M-EMB1 fills the CLEAN-synonym
 * graduation, and this test names exactly where its lift starts and stops.
 */
import { describe, expect, it } from 'vitest'

import {
  buildInvertedIndex,
  fusedRetriever,
  localBigramEmbedder,
  scoreRetriever,
  type Embedder,
  type RetrieverFactory,
} from '../src/index.js'
import type { MemoryEntry } from '@gotong/services-sdk'
import type { RecallCase } from '../src/benchmark.js'
import { RECALL_CASES, BENCH_NOW } from './fixtures/recall-cases.js'

/**
 * A concept-axis stand-in for a real sentence embedder: synonyms map to the SAME
 * axis (drink / pet / vehicle) despite zero character overlap, and unrelated text
 * maps to the zero vector (cosine 0 → dropped). A real embedder has this
 * structure organically; this makes it deterministic + dependency-free for a test.
 */
const AXES: Record<string, string[]> = {
  drink: ['饮料', '奶茶', '珍珠', '咖啡', 'coffee', '碳酸', 'beverage', 'bubble', 'tea'],
  pet: ['宠物', '金毛', '大黄', '狗', '猫', 'pet', 'dog', 'puppy'],
  vehicle: ['electric', 'vehicle', 'tesla', 'model', 'scooter', 'car', 'drive'],
}
const conceptEmbed: Embedder = async (texts) => {
  const keys = Object.keys(AXES)
  return texts.map((t) => {
    const low = t.toLowerCase()
    return keys.map((ax) => (AXES[ax]!.some((term) => low.includes(term.toLowerCase())) ? 1 : 0))
  })
}

function e(id: string, text: string, min: number): MemoryEntry {
  return { id, kind: 'semantic', text, ts: 1_700_000_000_000 + min * 60_000 }
}

/**
 * CLEAN synonym cases: the gold is a true synonym of the query, and the
 * distractors are semantically UNRELATED (no lexical-decoy trap). This isolates
 * the embedder's synonym-bridging ability — the exact headroom M-EMB1 fills.
 */
const CLEAN_SYNONYM: RecallCase[] = [
  {
    name: 'clean-drink',
    category: 'semantic-clean',
    corpus: [
      e('cg1', '上周我在城里点了一杯珍珠奶茶很好喝', 1),
      e('cg1-x1', '今天天气很好适合出门', 30),
      e('cg1-x2', '我在写一段代码', 40),
      e('cg1-x3', '会议改到下午三点', 50),
    ],
    query: { text: '饮料' },
    relevantIds: ['cg1'],
  },
  {
    name: 'clean-pet',
    category: 'semantic-clean',
    corpus: [
      e('cg2', '我家的金毛叫大黄', 1),
      e('cg2-x1', '房租下个月要交', 30),
      e('cg2-x2', '昨天看了一场电影', 40),
      e('cg2-x3', '手机电池不太耐用', 50),
    ],
    query: { text: '宠物' },
    relevantIds: ['cg2'],
  },
  {
    name: 'clean-vehicle',
    category: 'semantic-clean',
    corpus: [
      e('cg3', 'I drive a Tesla Model 3', 1),
      e('cg3-x1', 'the weather is nice today', 30),
      e('cg3-x2', 'I need to buy groceries', 40),
      e('cg3-x3', 'the meeting is at 3pm', 50),
    ],
    query: { text: 'electric vehicle' },
    relevantIds: ['cg3'],
  },
]

const fusedWith = (embed: Embedder): RetrieverFactory => (corpus) =>
  fusedRetriever(buildInvertedIndex(corpus), { activeOnly: true, now: () => BENCH_NOW, embed })

describe('M-EMB1 — a real embedder fills the clean-synonym recall graduation', () => {
  it('the LOCAL lexical embedder cannot bridge a clean synonym (recall 0)', async () => {
    const local = await scoreRetriever(fusedWith(localBigramEmbedder()), CLEAN_SYNONYM, 5)
    // 饮料/宠物/electric-vehicle share no character with 珍珠奶茶/金毛/Tesla → 0.
    expect(local.recallAtK).toBe(0)
  })

  it('a REAL semantic embedder bridges the clean synonym (recall 1.0, beats local)', async () => {
    const local = await scoreRetriever(fusedWith(localBigramEmbedder()), CLEAN_SYNONYM, 5)
    const real = await scoreRetriever(fusedWith(conceptEmbed), CLEAN_SYNONYM, 5)
    // The synonym gold is now found AND ranked first (no competing signal).
    expect(real.recallAtK).toBe(1)
    expect(real.mrr).toBe(1)
    // The lift is real and measured against the same ruler, not asserted in prose.
    expect(real.recallAtK).toBeGreaterThan(local.recallAtK)
  })

  it('honest boundary: an embedder alone does NOT move the decoy-hardened gate cases (that is MU-M3)', async () => {
    const hard = RECALL_CASES.filter((c) => c.category === 'semantic')
    expect(hard).toHaveLength(3)
    // Even with the real embedder, six distractors containing the query word bury
    // the gold — the semantic arm can't out-rank them alone. Bridging THESE needs
    // a consolidated atomic fact (MU-M3), so M-EMB1's lift honestly stops here.
    const real = await scoreRetriever(fusedWith(conceptEmbed), hard, 5)
    expect(real.recallAtK).toBe(0)
  })
})
