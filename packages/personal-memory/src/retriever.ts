/**
 * `MemoryRetriever` — a swappable backend for the on-demand `recall` path.
 *
 * The butler's memory has two retrieval surfaces with very different needs:
 *
 *   - The **frozen block** (system-prompt prefix) is the curated `semantic`
 *     profile. It MUST stay byte-stable across a session (prompt-cache), so it
 *     is NOT pluggable — it always reads the handle's curated semantic memory.
 *   - The **`recall` tool** is the on-demand path the model uses mid-turn to dig
 *     up older detail. THIS is where a smarter retriever pays off: vector
 *     search, hybrid rerank, a chroma-mcp index — anything that ranks better
 *     than the file backend's substring match.
 *
 * So the retriever seam sits ONLY on `recall`. Writes (`remember` / `forget`)
 * always go to the `MemoryHandle`; the retriever just answers queries. Default
 * is the handle's own `recall` (substring) — a host swaps in a vector retriever
 * without replacing the whole handle.
 *
 * Note: composing a chroma-mcp `McpToolset` as a benign tool is the OTHER way to
 * give the butler RAG. The two compose — the retriever upgrades the built-in
 * `recall` tool in place; an MCP tool adds a separate, explicitly-named search.
 */

import type { MemoryEntry, MemoryHandle, MemoryQuery } from '@aipehub/services-sdk'

export interface MemoryRetriever {
  /**
   * Answer a recall query. Same contract as `MemoryHandle.recall`: newest-first,
   * honoring `kinds` / `since` / `text` / `k` as the backend can. A retriever
   * that ignores a field (e.g. a pure vector store with no `since`) just returns
   * its best ranking — the tool layer already clamps `k`.
   */
  retrieve(query: MemoryQuery): Promise<MemoryEntry[]>
}

/**
 * The default retriever: the memory handle's own `recall`. Used when no custom
 * retriever is injected, so the `recall` tool behaves exactly as before.
 */
export function handleRetriever(memory: MemoryHandle): MemoryRetriever {
  return { retrieve: (query) => memory.recall(query) }
}
