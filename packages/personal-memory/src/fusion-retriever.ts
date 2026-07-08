/**
 * fusion-retriever.ts — multi-signal recall fusion (MU-M2).
 *
 * # The gap
 *
 * The default `invertedIndexRetriever` ranks by ONE signal: query-coverage
 * ({@link relevanceScore}), which is binary per term. Every candidate containing
 * the query phrase ties at the top, and the tie falls to importance-then-recency
 * — so an older fact that is genuinely ABOUT the query loses its rank to a newer
 * passing mention. Recall@k is fine (both are in the page); the RANK the model
 * sees first is wrong. For a weak model, first-fact-is-right is what matters.
 *
 * # The fix: relative-score fusion of two complementary arms
 *
 *   - KEYWORD arm — {@link relevanceScore} over the inverted index's whole-store
 *     candidates (coverage, spans old facts).
 *   - SEMANTIC arm — cosine over an injected {@link Embedder}. Default is the
 *     dependency-free {@link localBigramEmbedder} (a continuous, focus-aware
 *     lexical signal that breaks the keyword arm's ties); inject a real embedding
 *     provider (MU-M4) and the SAME retriever gains true synonym bridging.
 *
 * We fuse by RELATIVE SCORE (min-max normalize each arm across the candidate set,
 * then weighted sum), NOT Reciprocal Rank Fusion. RRF combines rank positions and
 * is the right tool when arms have incomparable score SCALES — but our keyword arm
 * produces heavy TIES (coverage is coarse), and RRF of a tie against a reversed
 * arm cancels to a wash (rank (1,3),(2,2),(3,1) all sum equal). Relative-score
 * fusion lets a non-discriminating arm (all-equal scores → zero range) drop OUT
 * and the discriminating arm decide — exactly the tie-break we need. (Weaviate's
 * `relativeScoreFusion` makes the same choice for the same reason.)
 *
 * # Boundaries kept
 *
 *   - Sits ONLY on the `recall` seam (like every retriever) — the byte-stable
 *     frozen block is untouched (relevance is query-dependent).
 *   - No LLM, no network in the default path — the local embedder is pure math.
 *   - Fail-soft: if the injected embedder throws / returns a bad shape, recall
 *     degrades to the pure keyword ranking rather than erroring mid-turn. A bad
 *     embedding backend never breaks recall (mirrors `embeddingRetriever`).
 *   - For the local embedder, a candidate that shares no term has cosine 0 AND
 *     coverage 0, so it is dropped — recall is IDENTICAL to keyword (fusion only
 *     REORDERS). Only a real embedder expands recall to synonyms; that is the
 *     honest local ceiling MU-M3/M4 lift.
 */

import type { MemoryEntry, MemoryQuery } from '@gotong/services-sdk'

import { isActive } from './bitemporal.js'
import { cosineSimilarity, type Embedder } from './embedding-retriever.js'
import { compareByImportanceThenRecency } from './importance.js'
import type { InvertedIndex } from './inverted-index.js'
import { localBigramEmbedder } from './local-embedder.js'
import { relevanceScore } from './relevance.js'
import type { MemoryRetriever, RetrieverOptions } from './retriever.js'

export interface FusionRetrieverOptions extends RetrieverOptions {
  /** Text→vector. Default {@link localBigramEmbedder} (dependency-free). */
  embed?: Embedder
  /** Weight of the keyword (coverage) arm. Default 0.5. */
  keywordWeight?: number
  /** Weight of the semantic (cosine) arm. Default 0.5. */
  semanticWeight?: number
  /**
   * Cap on how many importance-recency entries (beyond keyword candidates) the
   * semantic arm may consider — the window where an injected real embedder can
   * surface a synonym the keyword arm missed. Default 200.
   */
  wideK?: number
}

/**
 * Fuse the keyword + semantic arms over a pre-built {@link InvertedIndex}. Reads a
 * fresh index (the host keeps it warm, exactly like `invertedIndexRetriever`);
 * pure over the index + injected embedder otherwise.
 */
export function fusedRetriever(index: InvertedIndex, opts?: FusionRetrieverOptions): MemoryRetriever {
  const embed = opts?.embed ?? localBigramEmbedder()
  const kw = opts?.keywordWeight ?? 0.5
  const sem = opts?.semanticWeight ?? 0.5
  const wideK = Math.max(1, Math.floor(opts?.wideK ?? 200))

  return {
    async retrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
      const k = query.k
      const q = query.text?.trim()

      // Empty query → importance-then-recency over the whole index (identical
      // contract to the other retrievers for callers that pass no text).
      if (!q) {
        let all = applyScope(index.entries(), query)
        all = filterActive(all, opts)
        all.sort(compareByImportanceThenRecency)
        return k ? all.slice(0, k) : all
      }

      // Candidate pool = keyword postings (whole-store coverage) ∪ an
      // importance-recency window (where a real embedder can reach a synonym the
      // keyword arm never surfaced). Deduped, then scope + activeOnly narrowed.
      const pool = dedupById([...index.query(q), ...topByImportance(index.entries(), wideK)])
      const scoped = filterActive(applyScope(pool, query), opts)
      if (scoped.length === 0) return []

      // KEYWORD arm.
      const rel = new Map<string, number>()
      for (const e of scoped) rel.set(e.id, relevanceScore(q, e.text))

      // SEMANTIC arm — one batch embed of [query, ...candidates]. Fail-soft: a
      // bad embedder collapses the semantic arm to 0 (pure keyword ranking).
      const cos = new Map<string, number>()
      try {
        const vectors = await embed([q, ...scoped.map((e) => e.text)])
        if (Array.isArray(vectors) && Array.isArray(vectors[0])) {
          const qv = vectors[0]!
          scoped.forEach((e, i) => cos.set(e.id, cosineSimilarity(qv, vectors[i + 1] ?? [])))
        }
      } catch {
        /* semantic arm stays empty → fused ranking is pure keyword */
      }

      // Drop candidates with NO signal on either arm (recency-window noise). For
      // the local embedder cos>0 ⇔ rel>0, so this leaves the keyword candidate
      // set unchanged (fusion only reorders); a real embedder keeps its synonyms.
      const live = scoped.filter((e) => (rel.get(e.id) ?? 0) > 0 || (cos.get(e.id) ?? 0) > 0)
      if (live.length === 0) return []

      const relN = minMax(live.map((e) => rel.get(e.id) ?? 0))
      const cosN = minMax(live.map((e) => cos.get(e.id) ?? 0))
      const fused = new Map<string, number>()
      live.forEach((e, i) => fused.set(e.id, kw * relN[i]! + sem * cosN[i]!))

      const ranked = [...live].sort((a, b) => {
        const fa = fused.get(a.id)!
        const fb = fused.get(b.id)!
        return fa !== fb ? fb - fa : compareByImportanceThenRecency(a, b)
      })
      return k ? ranked.slice(0, k) : ranked
    },
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** Min-max normalize to [0,1]. A zero-range (all-equal) arm → all 0, so a
 *  non-discriminating arm contributes nothing and the other arm decides. */
function minMax(xs: number[]): number[] {
  let lo = Infinity
  let hi = -Infinity
  for (const x of xs) {
    if (x < lo) lo = x
    if (x > hi) hi = x
  }
  const range = hi - lo
  if (!(range > 0)) return xs.map(() => 0)
  return xs.map((x) => (x - lo) / range)
}

/** Dedup entries by id, keeping first occurrence. */
function dedupById(entries: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>()
  const out: MemoryEntry[] = []
  for (const e of entries) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  return out
}

/** Top-N entries by importance-then-recency (the semantic arm's reach window). */
function topByImportance(entries: MemoryEntry[], n: number): MemoryEntry[] {
  return [...entries].sort(compareByImportanceThenRecency).slice(0, n)
}

/** Apply the query's `kinds` / `since` narrowing (mirrors inverted-index). */
function applyScope(page: MemoryEntry[], query: MemoryQuery): MemoryEntry[] {
  const kinds = query.kinds && query.kinds.length > 0 ? new Set(query.kinds) : undefined
  const since = query.since ?? 0
  if (!kinds && since <= 0) return page
  return page.filter((e) => (!kinds || kinds.has(e.kind)) && e.ts >= since)
}

/** Drop closed / not-yet-valid facts when `activeOnly` (mirrors inverted-index). */
function filterActive(page: MemoryEntry[], opts?: RetrieverOptions): MemoryEntry[] {
  if (!opts?.activeOnly) return page
  const now = (opts.now ?? ((): number => Date.now()))()
  return page.filter((e) => isActive(e, now))
}
