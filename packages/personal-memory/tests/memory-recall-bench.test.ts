/**
 * memory-recall-bench — the recall benchmark承重门 (MU-M1).
 *
 * The frontier (Mem0 / Zep) reports LongMemEval / LoCoMo; Gotong had NO recall
 * benchmark, so "memory got better" was unfalsifiable. This gate is the ruler:
 * it runs the PRODUCTION default retriever (`invertedIndexRetriever` with
 * `activeOnly`, exactly how the butler factory wires it) over a bilingual fixture
 * and locks a FLOOR on recall@k + MRR.
 *
 * # Ratchet direction (mirrors line-budget-gate, opposite sign)
 *
 * line-budget-gate locks a CEILING that can only DESCEND. Accuracy locks a FLOOR
 * that can only RISE: MU-M2 (fusion) and MU-M3 (atomic facts) must each PROVE a
 * lift by running the SAME fixture and RAISING these constants. If a refactor
 * regresses recall, this goes red. Never lower a floor to make it pass.
 *
 * # What the score documents
 *
 * The keyword baseline scores 0 on the `semantic` category BY CONSTRUCTION (the
 * query shares no term with the gold — a true synonym). That is not a bug to hide
 * but the exact headroom MU-M3 (a consolidated fact bridging category→specific)
 * and MU-M4 (a real embedding provider) will fill. We assert it stays 0 for the
 * keyword baseline so the gap is a measured fact, not a footnote.
 */

import { describe, expect, it } from 'vitest'

import {
  buildInvertedIndex,
  formatBenchResult,
  invertedIndexRetriever,
  scoreRetriever,
  type RetrieverFactory,
} from '../src/index.js'
import { BENCH_NOW, RECALL_CASES } from './fixtures/recall-cases.js'

/**
 * The production keyword baseline: an inverted index over the corpus, filtered to
 * facts in effect at BENCH_NOW (`activeOnly`, the butler factory's default). This
 * is the exact retriever MU-M2 replaces — same cases, so its lift is provable.
 */
const keywordBaseline: RetrieverFactory = (corpus) =>
  invertedIndexRetriever(buildInvertedIndex(corpus), { activeOnly: true, now: () => BENCH_NOW })

/**
 * Locked baseline floors — measured keyword scores at k=5 (recall@5=78.6%,
 * MRR=0.548, 命中率=78.6%). MU-M2/M3/M4 RAISE these; a regression trips the gate.
 * (Kept a hair below the measured values so float formatting can't cause a
 * spurious red.) The MRR floor is deliberately low: the cross-session cases seat
 * the gold behind newer passing mentions (keyword MRR 0.333), which is exactly
 * the rank headroom MU-M2's fusion closes.
 */
const FLOORS = { recallAtK: 0.785, mrr: 0.547, hitRate: 0.785 } as const

describe('memory recall benchmark — keyword baseline floor (MU-M1)', () => {
  it('meets the locked recall@5 / MRR floor and prints the scorecard', async () => {
    const result = await scoreRetriever(keywordBaseline, RECALL_CASES, 5)

    // Surface the full scorecard in the gate output (per-category is where the
    // milestone story is visible — semantic sits at 0, the M3/M4 headroom).
    // eslint-disable-next-line no-console
    console.log('\n' + formatBenchResult('keyword 基线', result) + '\n')

    expect(result.recallAtK).toBeGreaterThanOrEqual(FLOORS.recallAtK)
    expect(result.mrr).toBeGreaterThanOrEqual(FLOORS.mrr)
    expect(result.hitRate).toBeGreaterThanOrEqual(FLOORS.hitRate)
  })

  it('keyword recall is exactly 0 on the semantic (synonym) category — the M3/M4 headroom', async () => {
    const result = await scoreRetriever(keywordBaseline, RECALL_CASES, 5)
    const semantic = result.byCategory.semantic
    expect(semantic).toBeDefined()
    // A char-overlap signal cannot bridge 「饮料」→「珍珠奶茶」. This is the exact
    // gap a later milestone must close — asserted, not assumed.
    expect(semantic!.recallAtK).toBe(0)
    expect(semantic!.n).toBe(3)
  })

  it('keyword already solves the keyword-friendly categories (recall@5 = 1.0)', async () => {
    const result = await scoreRetriever(keywordBaseline, RECALL_CASES, 5)
    for (const cat of ['direct', 'cross-session', 'temporal', 'multi-hop'] as const) {
      expect(result.byCategory[cat]?.recallAtK).toBe(1)
    }
  })

  it('temporal cases drop the superseded (closed) fact via activeOnly', async () => {
    // Directly assert the bitemporal wiring: a closed interval must never surface,
    // even though its text keyword-matches the query as well as the current fact.
    const temporal = RECALL_CASES.filter((c) => c.category === 'temporal')
    expect(temporal.length).toBeGreaterThan(0)
    for (const c of temporal) {
      const retriever = keywordBaseline(c.corpus)
      const page = await retriever.retrieve({ text: c.query.text, k: 10 })
      const ids = new Set(page.map((e) => e.id))
      const closedIds = c.corpus.filter((e) => e.meta && 'validTo' in e.meta).map((e) => e.id)
      expect(closedIds.length).toBeGreaterThan(0)
      for (const closedId of closedIds) expect(ids.has(closedId)).toBe(false)
    }
  })
})
