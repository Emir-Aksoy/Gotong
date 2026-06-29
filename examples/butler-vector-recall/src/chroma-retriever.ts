/**
 * chroma-retriever.ts — the "走 chroma-MCP" path for the butler's semantic recall.
 *
 * `embeddingRetriever` (in `@aipehub/personal-memory`) embeds a recency window
 * in-process on every recall — simple, local, fine for a consolidated and
 * budget-bounded butler. But for an unbounded corpus you want a real vector
 * store that holds the index and does embedding + ANN server-side. That store is
 * reached through `chroma-mcp` (an MCP server), exactly like `examples/rag-mcp`.
 *
 * The seam is the SAME `MemoryRetriever` interface — recall is pluggable, the
 * byte-stable frozen block is not. The difference is WHERE the work happens:
 *
 *   - embeddingRetriever: framework pulls candidates, calls the injected embedder,
 *     ranks by cosine in-process.
 *   - chromaRetriever (this file): the vector store ranks; the framework only
 *     forwards the query and maps results back to `MemoryEntry`. No in-frame
 *     cosine, no recency window, no embedding library imported.
 *
 * The framework still never computes a vector or imports a vector library: you
 * inject a {@link ChromaQuery} that forwards to the MCP tool call. In a live host
 * that function wraps `McpToolset.callTool('chroma_query', …)` against a
 * chroma-mcp server spawned alongside the butler. Here it is injected so the
 * example stays hermetic — a real chroma needs a running server (same strategy
 * as `examples/rag-mcp`, which is a config-preview, not a live run).
 */

import type { MemoryRetriever } from '@aipehub/personal-memory'
import type { MemoryEntry, MemoryKind, MemoryQuery } from '@aipehub/services-sdk'

/**
 * Forward a semantic query to the vector store (chroma via chroma-mcp). The
 * store embeds `text` and returns its own similarity-ranked hits, already
 * carrying the entry's id / kind / ts / text in chroma metadata. Honoring
 * `kinds` is the store's job (a `where` filter on the collection).
 */
export type ChromaQuery = (q: {
  text: string
  k: number
  kinds?: readonly MemoryKind[]
}) => Promise<readonly MemoryEntry[]>

/**
 * A `MemoryRetriever` backed by a vector store. The store does the ranking; this
 * just clamps `k` and passes `kinds` through. An empty query returns nothing —
 * this is the semantic-SEARCH path, not a query-less timeline. (For "show me
 * recent entries" use the handle's own recall, or compose the two retrievers;
 * the butler's frozen block already surfaces the curated profile without a query.)
 */
export function chromaRetriever(opts: { query: ChromaQuery }): MemoryRetriever {
  return {
    async retrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
      const text = query.text?.trim()
      if (!text) return []
      const k = query.k ?? 12
      const hits = await opts.query({
        text,
        k,
        ...(query.kinds && query.kinds.length > 0 ? { kinds: query.kinds } : {}),
      })
      return hits.slice(0, k) as MemoryEntry[]
    },
  }
}

/**
 * Sketch of the production wiring (NOT run here — it needs `chroma-mcp` and an
 * embedding model). In a live host the butler is an `LlmAgent` whose `mcpServers`
 * config spawns `chroma-mcp`; you build a `ChromaQuery` over an `McpToolset`:
 *
 * ```ts
 * import { McpToolset } from '@aipehub/mcp-client'
 *
 * const chroma = new McpToolset({  spawn chroma-mcp, see examples/rag-mcp  })
 * const query: ChromaQuery = async ({ text, k, kinds }) => {
 *   const res = await chroma.callTool('chroma_query', {
 *     collection: 'butler-memory',
 *     query_text: text,
 *     n_results: k,
 *     ...(kinds ? { where: { kind: { $in: kinds } } } : {}),
 *   })
 *   //  parse res.content → MemoryEntry[] (chroma metadata carries id/kind/ts)
 *   return parseChromaHits(res)
 * }
 * const retriever = chromaRetriever({ query })
 * //  new MemoryToolset({ memory, retriever })  — recall now goes through chroma
 * ```
 *
 * Writes still go to the `MemoryHandle`; a small hook mirrors each `remember`
 * into chroma (upsert) so the index stays in sync. The handle remains the source
 * of truth on disk — chroma is a derived, rebuildable index. Same north-star
 * stance as RAG: the framework stores no vectors.
 */
export const PRODUCTION_WIRING_DOC = true
