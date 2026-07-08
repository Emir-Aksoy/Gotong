/**
 * local-embedder.ts — a dependency-free, deterministic {@link Embedder} (MU-M2).
 *
 * # What it is (and honestly is NOT)
 *
 * It turns text into a fixed-per-batch, L2-normalized term-frequency vector over
 * {@link extractTerms} (the SAME tokenizer the keyword arm uses). It is the
 * LEXICAL GEOMETRY of relevance — frequency + length normalization — not a
 * learned semantic model. Two texts that share no term are ORTHOGONAL, so it
 * cannot bridge a true synonym (「饮料」↛「珍珠奶茶」). That ceiling is left, on
 * purpose, to an injected real embedding provider (MU-M4).
 *
 * # Why it still earns its place in fusion
 *
 * The keyword arm scores query-COVERAGE: a binary "how many of my query terms
 * appear here". That ties every candidate that contains the query phrase (a
 * one-mention aside and a paragraph that is ABOUT the topic score identically),
 * and the tie falls to recency — which buries an older, on-topic fact under a
 * newer passing mention. This embedder gives fusion a CONTINUOUS second opinion:
 * cosine over normalized term frequencies rewards focus (the fact that repeats
 * the query term, proportional to its length) so the reranker can lift the
 * on-topic gold above the aside. No new dependency, no network, no key.
 *
 * # Batch-local vocabulary (collision-free, deterministic)
 *
 * The vocabulary is built from the batch itself (the retriever always embeds
 * `[query, ...candidates]` in one call, mirroring {@link embeddingRetriever}), so
 * dimensions are exact term indices — no feature-hashing collisions, byte-stable
 * across runs. Vectors are only ever compared WITHIN their batch (which is the
 * only place cosine is meaningful here), so batch-local dims are correct.
 */

import type { Embedder } from './embedding-retriever.js'
import { extractTerms } from './relevance.js'

/**
 * A local, deterministic term-frequency embedder. Builds a shared vocabulary over
 * the batch, then emits one L2-normalized TF vector per text. Empty / term-less
 * text → a zero vector (cosine 0 against everything), which the retriever treats
 * as "no semantic signal" rather than a false match.
 */
export function localBigramEmbedder(): Embedder {
  return async (texts: readonly string[]): Promise<number[][]> => {
    const termLists = texts.map((t) => extractTerms(t))
    const vocab = new Map<string, number>()
    for (const terms of termLists) {
      for (const term of terms) if (!vocab.has(term)) vocab.set(term, vocab.size)
    }
    const dim = vocab.size
    return termLists.map((terms) => {
      const v = new Array<number>(dim).fill(0)
      for (const term of terms) v[vocab.get(term)!]! += 1
      let norm = 0
      for (const x of v) norm += x * x
      norm = Math.sqrt(norm)
      if (norm > 0) for (let i = 0; i < dim; i++) v[i]! /= norm
      return v
    })
  }
}
