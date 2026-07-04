/**
 * embedding-retriever.ts — the SEMANTIC half of recall (decision C / C-M3).
 *
 * C-M2's `lexicalRetriever` ranks by CJK-bigram / Latin-token OVERLAP — it finds
 * 「奶茶店」 inside 「卖奶茶的店」 (shared characters) but it is still lexical: a
 * query 「饮料」 (beverage) will NOT match 「奶茶」 / 「咖啡」 because they share no
 * characters. Semantic recall closes that gap.
 *
 * # The framework provides the SEAM, never the vectors (用户: embedding 不进框架)
 *
 * Turning text into a vector needs a model; that model — local or a hosted
 * embedding API — is INJECTED as an {@link Embedder}. The framework only does the
 * trivial, dependency-free math (cosine) and the ranking. Two production paths,
 * both behind the existing `MemoryRetriever` seam (no new wiring):
 *
 *   1. local embed + in-memory cosine — THIS module ({@link embeddingRetriever}).
 *      It embeds the recency window per recall. Honest tradeoff: that is N embed
 *      calls per query, fine for a consolidated, budget-bounded butler; for an
 *      unbounded corpus use path 2.
 *   2. a real vector store (chroma) via chroma-mcp — the store holds the index
 *      and does ANN server-side; you implement `MemoryRetriever.retrieve` to call
 *      it directly (no in-framework cosine). See `examples/butler-vector-recall`.
 *
 * Like the other retrievers this only answers queries; writes still go to the
 * `MemoryHandle`, and the byte-stable frozen block is untouched (relevance is
 * query-dependent, so it never enters the prompt-cache prefix).
 */

import type { MemoryEntry, MemoryHandle, MemoryQuery } from '@gotong/services-sdk'

import { compareByImportanceThenRecency } from './importance.js'
import type { MemoryRetriever } from './retriever.js'

/**
 * Turn texts into vectors. BATCH on purpose — the retriever embeds the query
 * plus every candidate in one call, so a hosted embedding API is hit once per
 * recall, not once per entry. The framework never imports an embedding library;
 * a host wraps its model / API / chroma-mcp call here.
 */
export type Embedder = (texts: readonly string[]) => Promise<number[][]>

export interface EmbeddingRetrieverOptions {
  /** The (already per-owner-scoped) memory handle. */
  memory: MemoryHandle
  /** Injected text→vector function (local model or hosted API). */
  embed: Embedder
  /** Recency window to rank over. Default 200 (clamped to ≥1). */
  wideK?: number
  /**
   * Keep only candidates scoring strictly above this cosine floor. Default 0
   * (keep positive similarity), so the tool still NARROWS like a search should.
   */
  minScore?: number
}

/**
 * Cosine similarity of two vectors, in [-1,1]. Defensive: mismatched lengths use
 * the shorter; a zero-magnitude (or empty) vector yields 0 rather than NaN.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * A semantic retriever: pull a recency window (NOT handing `text` to the
 * backend), embed the query + candidates in one batch call, rank by cosine
 * (tie → importance-then-recency), drop sub-floor candidates. An empty query
 * reduces to importance-then-recency, identical to the other retrievers.
 *
 * Fail-soft: if the embedder returns an unusable shape (wrong length / throws)
 * the recall degrades to recency order rather than erroring mid-turn — a bad
 * embedding backend never breaks recall.
 */
export function embeddingRetriever(opts: EmbeddingRetrieverOptions): MemoryRetriever {
  const wideK = Math.max(1, Math.floor(opts.wideK ?? 200))
  const minScore = opts.minScore ?? 0
  return {
    async retrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
      const k = query.k
      const { text, ...rest } = query
      const page = await opts.memory.recall({ ...rest, k: wideK })

      const q = text?.trim()
      if (!q || page.length === 0) {
        page.sort(compareByImportanceThenRecency)
        return k ? page.slice(0, k) : page
      }

      let vectors: number[][]
      try {
        vectors = await opts.embed([q, ...page.map((e) => e.text)])
      } catch {
        vectors = []
      }
      // Degrade to recency if the embedder gave us nothing usable for the query.
      if (!Array.isArray(vectors) || vectors.length < 1 || !Array.isArray(vectors[0])) {
        page.sort(compareByImportanceThenRecency)
        return k ? page.slice(0, k) : page
      }
      const qv = vectors[0]!

      const ranked = page
        .map((e, i) => ({ e, s: cosineSimilarity(qv, vectors[i + 1] ?? []) }))
        .filter((x) => x.s > minScore)
        .sort((a, b) => (a.s !== b.s ? b.s - a.s : compareByImportanceThenRecency(a.e, b.e)))
        .map((x) => x.e)
      return k ? ranked.slice(0, k) : ranked
    },
  }
}
