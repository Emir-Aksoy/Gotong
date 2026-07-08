/**
 * memory-recall-bench — the recall benchmark承重门 (MU-M1, raised by MU-M2).
 *
 * The frontier (Mem0 / Zep) reports LongMemEval / LoCoMo; Gotong had NO recall
 * benchmark, so "memory got better" was unfalsifiable. This gate is the ruler:
 * it runs the PRODUCTION default retriever over a bilingual fixture and locks a
 * FLOOR on recall@k + MRR.
 *
 * # What "production default" means here
 *
 * MU-M2 made the butler's `recall` a FUSED retriever (keyword ⊕ local TF cosine,
 * relative-score fusion) — the butler factory wires `openButlerRecallIndex({
 * fusion: {} })`. So the gate's production factory is `fusedRetriever`, and its
 * floor is the FUSED score. The M1 keyword baseline stays in this file as the
 * comparison the lift is measured against.
 *
 * # Ratchet direction (mirrors line-budget-gate, opposite sign)
 *
 * line-budget-gate locks a CEILING that can only DESCEND. Accuracy locks a FLOOR
 * that can only RISE: each milestone that improves recall RAISES these constants
 * and proves it here. If a refactor regresses recall, this goes red. Never lower
 * a floor to make it pass.
 *
 * # The lift is a TEST, not prose
 *
 * We assert `fused.mrr > keyword.mrr` (strict) and `fused.recall >= keyword.recall`
 * — so MU-M2's claim ("fusion reranks the on-topic fact to the front without
 * losing recall") is verified, not asserted in a doc. The keyword baseline scores
 * 0 on the `semantic` category BY CONSTRUCTION (a true synonym), and so does the
 * LOCAL fusion — that gap is the exact headroom MU-M3/M4 fill, asserted 0 here.
 */

import { describe, expect, it } from 'vitest'

import {
  buildInvertedIndex,
  formatBenchResult,
  fusedRetriever,
  invertedIndexRetriever,
  scoreRetriever,
  type RetrieverFactory,
} from '../src/index.js'
import { BENCH_NOW, RECALL_CASES } from './fixtures/recall-cases.js'

/** The M1 keyword baseline — kept as the comparison the MU-M2 lift is measured against. */
const keywordBaseline: RetrieverFactory = (corpus) =>
  invertedIndexRetriever(buildInvertedIndex(corpus), { activeOnly: true, now: () => BENCH_NOW })

/**
 * The MU-M2 production default: fusion with the dependency-free local embedder,
 * filtered to facts in effect at BENCH_NOW — the exact wiring the butler factory
 * uses (`openButlerRecallIndex({ fusion: {} })`).
 */
const fusedProduction: RetrieverFactory = (corpus) =>
  fusedRetriever(buildInvertedIndex(corpus), { activeOnly: true, now: () => BENCH_NOW })

/**
 * Locked floors. KEYWORD = the M1 baseline (recall@5=78.6%, MRR=0.548). FUSED =
 * the MU-M2 production default (recall@5=78.6%, MRR=0.738 — the on-topic fact
 * reranked to the front). A later milestone RAISES the FUSED floor; a regression
 * trips the gate. (Kept a hair below measured so float formatting can't red.)
 */
const KEYWORD_FLOORS = { recallAtK: 0.785, mrr: 0.547 } as const
const FUSED_FLOORS = { recallAtK: 0.785, mrr: 0.737, hitRate: 0.785 } as const

describe('memory recall benchmark — fused production floor + MU-M2 lift', () => {
  it('the fused production default meets its locked floor and prints the scorecard', async () => {
    const fused = await scoreRetriever(fusedProduction, RECALL_CASES, 5)
    const keyword = await scoreRetriever(keywordBaseline, RECALL_CASES, 5)

    // Surface both scorecards in the gate output — the lift is visible per-category
    // (cross-session MRR jumps once fusion reranks the focused gold to the front).
    // eslint-disable-next-line no-console
    console.log('\n' + formatBenchResult('keyword 基线', keyword))
    // eslint-disable-next-line no-console
    console.log('\n' + formatBenchResult('fused 生产', fused) + '\n')

    expect(fused.recallAtK).toBeGreaterThanOrEqual(FUSED_FLOORS.recallAtK)
    expect(fused.mrr).toBeGreaterThanOrEqual(FUSED_FLOORS.mrr)
    expect(fused.hitRate).toBeGreaterThanOrEqual(FUSED_FLOORS.hitRate)
    // The M1 baseline floor still holds (the ruler itself didn't drift).
    expect(keyword.recallAtK).toBeGreaterThanOrEqual(KEYWORD_FLOORS.recallAtK)
    expect(keyword.mrr).toBeGreaterThanOrEqual(KEYWORD_FLOORS.mrr)
  })

  it('MU-M2 lift is real: fusion strictly beats keyword on MRR, never loses recall', async () => {
    const fused = await scoreRetriever(fusedProduction, RECALL_CASES, 5)
    const keyword = await scoreRetriever(keywordBaseline, RECALL_CASES, 5)
    // Strict MRR lift (the on-topic fact moves toward rank 1)…
    expect(fused.mrr).toBeGreaterThan(keyword.mrr)
    // …without sacrificing recall (fusion only reorders for the local embedder)…
    expect(fused.recallAtK).toBeGreaterThanOrEqual(keyword.recallAtK)
    // …and the win is concentrated exactly where the ruler said it would be.
    expect(fused.byCategory['cross-session']!.mrr).toBeGreaterThan(
      keyword.byCategory['cross-session']!.mrr,
    )
  })

  it('recall is exactly 0 on the semantic (synonym) category for BOTH — the M3/M4 headroom', async () => {
    const fused = await scoreRetriever(fusedProduction, RECALL_CASES, 5)
    const keyword = await scoreRetriever(keywordBaseline, RECALL_CASES, 5)
    // A char-overlap signal (keyword OR the local embedder) cannot bridge
    // 「饮料」→「珍珠奶茶」. Asserted, not assumed — this is what M3/M4 must move.
    expect(fused.byCategory.semantic!.recallAtK).toBe(0)
    expect(keyword.byCategory.semantic!.recallAtK).toBe(0)
    expect(fused.byCategory.semantic!.n).toBe(3)
  })

  it('fusion solves the keyword-friendly categories (recall@5 = 1.0, MRR = 1.0)', async () => {
    const fused = await scoreRetriever(fusedProduction, RECALL_CASES, 5)
    for (const cat of ['direct', 'cross-session', 'temporal'] as const) {
      expect(fused.byCategory[cat]?.recallAtK).toBe(1)
      expect(fused.byCategory[cat]?.mrr).toBe(1) // fusion ranks the gold first
    }
    expect(fused.byCategory['multi-hop']?.recallAtK).toBe(1)
  })

  it('temporal cases drop the superseded (closed) fact via activeOnly', async () => {
    // Directly assert the bitemporal wiring: a closed interval must never surface,
    // even though its text keyword-matches the query as well as the current fact.
    const temporal = RECALL_CASES.filter((c) => c.category === 'temporal')
    expect(temporal.length).toBeGreaterThan(0)
    for (const c of temporal) {
      const retriever = fusedProduction(c.corpus)
      const page = await retriever.retrieve({ text: c.query.text, k: 10 })
      const ids = new Set(page.map((e) => e.id))
      const closedIds = c.corpus.filter((e) => e.meta && 'validTo' in e.meta).map((e) => e.id)
      expect(closedIds.length).toBeGreaterThan(0)
      for (const closedId of closedIds) expect(ids.has(closedId)).toBe(false)
    }
  })
})
