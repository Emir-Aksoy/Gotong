/**
 * benchmark.ts — a tiny, LLM-free recall benchmark for the `MemoryRetriever`
 * seam (MU-M1). The frontier (Mem0 / Zep) measures memory on LongMemEval /
 * LoCoMo; Gotong had no recall benchmark at all, so "recall got better" was
 * unfalsifiable. This is the ruler: a fixture of (corpus, query, gold ids)
 * cases + `recall@k` / MRR scoring, deterministic and zero-key.
 *
 * It is intentionally a RETRIEVAL benchmark, not a full capture→consolidate→
 * recall chain: consolidation needs the one 6h LLM call, and a gate must be
 * key-free + reproducible. Retrieval is exactly the layer MU-M2 (fusion) and
 * MU-M3 (atomic facts) improve, so scoring it directly is what lets those
 * milestones PROVE a lift against a locked baseline (the line-budget ratchet
 * idiom, applied to accuracy).
 *
 * Reusable by design: `scoreRetriever` takes a RETRIEVER FACTORY (corpus →
 * retriever), so M2 runs the fused retriever over the SAME cases and the
 * capstone shows the cumulative lift.
 */

import type { MemoryEntry, MemoryKind } from '@gotong/services-sdk'

import type { MemoryRetriever } from './retriever.js'

/** The categories mirror LongMemEval's axes — each stresses a different failure. */
export type RecallCategory =
  | 'direct' // single fact, query shares words — keyword already wins
  | 'cross-session' // the gold fact is buried among many distractors
  | 'temporal' // a superseded fact must NOT be returned (activeOnly)
  | 'semantic' // query shares NO characters with the gold (keyword's blind spot)
  | 'multi-hop' // several facts are jointly relevant

export interface RecallCase {
  name: string
  category: RecallCategory
  /** The stored memory for this case (gold + distractors). Ids must be unique. */
  corpus: MemoryEntry[]
  query: { text: string; kinds?: readonly MemoryKind[]; k?: number }
  /** Ids in `corpus` that a correct recall should surface. */
  relevantIds: readonly string[]
  note?: string
}

/** Build a retriever over one case's corpus. M1 passes the keyword baseline;
 *  M2 passes the fused retriever; the cases stay identical. */
export type RetrieverFactory = (corpus: MemoryEntry[]) => MemoryRetriever

export interface CaseScore {
  name: string
  category: RecallCategory
  /** |gold ∩ top-k| / |gold| for this case. */
  recallAtK: number
  /** 1 / (1-based rank of the first gold hit), or 0 if none in the page. */
  reciprocalRank: number
  hit: boolean
}

export interface BenchResult {
  k: number
  /** Mean recall@k across cases. */
  recallAtK: number
  /** Mean reciprocal rank (MRR) across cases. */
  mrr: number
  /** Fraction of cases with at least one gold hit in top-k. */
  hitRate: number
  perCase: CaseScore[]
  byCategory: Record<string, { recallAtK: number; mrr: number; n: number }>
}

/**
 * Score a retriever factory over the cases. For each case: build the retriever
 * from the corpus, run the query at `k`, then compute recall@k + reciprocal
 * rank against the gold ids. Pure aside from the retriever's own async I/O.
 */
export async function scoreRetriever(
  make: RetrieverFactory,
  cases: readonly RecallCase[],
  k = 5,
): Promise<BenchResult> {
  const perCase: CaseScore[] = []
  for (const c of cases) {
    const retriever = make(c.corpus)
    const gold = new Set(c.relevantIds)
    const page = await retriever.retrieve({
      text: c.query.text,
      ...(c.query.kinds ? { kinds: [...c.query.kinds] } : {}),
      k: c.query.k ?? k,
    })
    const topK = page.slice(0, c.query.k ?? k)
    const foundInTopK = topK.filter((e) => gold.has(e.id)).length
    const recallAtK = gold.size === 0 ? 0 : foundInTopK / gold.size
    let reciprocalRank = 0
    for (let i = 0; i < page.length; i++) {
      if (gold.has(page[i]!.id)) {
        reciprocalRank = 1 / (i + 1)
        break
      }
    }
    perCase.push({ name: c.name, category: c.category, recallAtK, reciprocalRank, hit: foundInTopK > 0 })
  }

  const n = perCase.length || 1
  const recallAtK = perCase.reduce((s, c) => s + c.recallAtK, 0) / n
  const mrr = perCase.reduce((s, c) => s + c.reciprocalRank, 0) / n
  const hitRate = perCase.filter((c) => c.hit).length / n

  const byCategory: Record<string, { recallAtK: number; mrr: number; n: number }> = {}
  for (const c of perCase) {
    const g = (byCategory[c.category] ??= { recallAtK: 0, mrr: 0, n: 0 })
    g.recallAtK += c.recallAtK
    g.mrr += c.reciprocalRank
    g.n += 1
  }
  for (const g of Object.values(byCategory)) {
    g.recallAtK /= g.n
    g.mrr /= g.n
  }

  return { k, recallAtK, mrr, hitRate, perCase, byCategory }
}

/** One-line-per-category human summary (for the gate's console output). */
export function formatBenchResult(label: string, r: BenchResult): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`
  const lines = [
    `【${label}】recall@${r.k}=${pct(r.recallAtK)}  MRR=${r.mrr.toFixed(3)}  命中率=${pct(r.hitRate)}`,
  ]
  for (const [cat, g] of Object.entries(r.byCategory).sort()) {
    lines.push(`  · ${cat.padEnd(13)} recall@${r.k}=${pct(g.recallAtK)}  MRR=${g.mrr.toFixed(3)}  (${g.n} 例)`)
  }
  return lines.join('\n')
}
