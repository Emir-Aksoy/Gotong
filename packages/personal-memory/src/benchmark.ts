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

/** One case's ranking outcome, independent of what the ids point at. */
export interface RankedScore {
  /** |gold ∩ top-k| / |gold| (0 when the case declares no gold). */
  recallAtK: number
  /** 1 / (1-based rank of the first gold hit) over the WHOLE page, or 0. */
  reciprocalRank: number
  hit: boolean
}

/**
 * The per-case ranking arithmetic, shared by every recall ruler in the repo.
 *
 * Extracted so a second ruler cannot quietly measure with a second formula:
 * two rulers whose numbers are compared must come from ONE implementation, or
 * a lift is indistinguishable from an arithmetic difference. `recall@k` counts
 * only the first `k`; the reciprocal rank deliberately scans the FULL page
 * (a gold hit at rank 7 is worth 1/7, not 0) — that asymmetry is the existing
 * behaviour and is preserved verbatim.
 */
export function scoreRankedIds(rankedIds: readonly string[], gold: ReadonlySet<string>, k: number): RankedScore {
  const foundInTopK = rankedIds.slice(0, k).filter((id) => gold.has(id)).length
  const recallAtK = gold.size === 0 ? 0 : foundInTopK / gold.size
  let reciprocalRank = 0
  for (let i = 0; i < rankedIds.length; i++) {
    if (gold.has(rankedIds[i]!)) {
      reciprocalRank = 1 / (i + 1)
      break
    }
  }
  return { recallAtK, reciprocalRank, hit: foundInTopK > 0 }
}

/** The minimum a case must carry to be aggregated (category is a free string
 *  so a second ruler can bring its own axes). */
export interface RankedCaseScore extends RankedScore {
  category: string
}

export interface RankedAggregate {
  recallAtK: number
  mrr: number
  hitRate: number
  byCategory: Record<string, { recallAtK: number; mrr: number; n: number }>
}

/** Mean recall / MRR / hit-rate overall and per category. Accumulate-then-divide. */
export function aggregateRankedScores(perCase: readonly RankedCaseScore[]): RankedAggregate {
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
  return { recallAtK, mrr, hitRate, byCategory }
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
    const caseK = c.query.k ?? k
    const page = await retriever.retrieve({
      text: c.query.text,
      ...(c.query.kinds ? { kinds: [...c.query.kinds] } : {}),
      k: caseK,
    })
    const score = scoreRankedIds(
      page.map((e) => e.id),
      new Set(c.relevantIds),
      caseK,
    )
    perCase.push({ name: c.name, category: c.category, ...score })
  }

  return { k, ...aggregateRankedScores(perCase), perCase }
}

/** One-line-per-category human summary (for the gate's console output). */
export function formatRankedResult(label: string, k: number, r: RankedAggregate): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`
  const lines = [`【${label}】recall@${k}=${pct(r.recallAtK)}  MRR=${r.mrr.toFixed(3)}  命中率=${pct(r.hitRate)}`]
  for (const [cat, g] of Object.entries(r.byCategory).sort()) {
    lines.push(`  · ${cat.padEnd(13)} recall@${k}=${pct(g.recallAtK)}  MRR=${g.mrr.toFixed(3)}  (${g.n} 例)`)
  }
  return lines.join('\n')
}

export function formatBenchResult(label: string, r: BenchResult): string {
  return formatRankedResult(label, r.k, r)
}
