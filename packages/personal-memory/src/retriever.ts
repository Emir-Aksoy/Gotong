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

import { isActive } from './bitemporal.js'
import { compareByImportanceThenRecency } from './importance.js'
import { relevanceScore } from './relevance.js'

export interface MemoryRetriever {
  /**
   * Answer a recall query. Same contract as `MemoryHandle.recall`: newest-first,
   * honoring `kinds` / `since` / `text` / `k` as the backend can. A retriever
   * that ignores a field (e.g. a pure vector store with no `since`) just returns
   * its best ranking — the tool layer already clamps `k`.
   */
  retrieve(query: MemoryQuery): Promise<MemoryEntry[]>
}

/** Options shared by the built-in retrievers. */
export interface RetrieverOptions {
  /**
   * Opt-in (decision D, D-M2): return only facts that are in effect right now —
   * drop closed time-edges (e.g. the old "lived in KL" once "moved to Penang"
   * superseded it) and not-yet-valid facts. A consolidated butler usually wants
   * CURRENT truth from `recall`; the closed history stays on disk for a future
   * "what did I used to…" path. Default off → no filtering. An entry with no
   * validity meta is always active, so legacy data is unaffected even when on.
   */
  activeOnly?: boolean
  /** Clock for {@link activeOnly}. Default `Date.now`. */
  now?: () => number
}

/**
 * Filter a freshly-pulled page to the active slice when `activeOnly` is set.
 * Returns the page unchanged otherwise — so the default path is allocation-free
 * and byte-for-byte the pre-D behaviour.
 */
function filterActive(page: MemoryEntry[], opts?: RetrieverOptions): MemoryEntry[] {
  if (!opts?.activeOnly) return page
  const now = (opts.now ?? ((): number => Date.now()))()
  return page.filter((e) => isActive(e, now))
}

/**
 * The default retriever: the memory handle's own `recall`, re-ranked by
 * importance. It pulls a wider recency window from the handle, then orders by
 * importance-then-recency (a pure comparator) and clamps back to `k` — so a
 * high-importance fact outranks a merely-newer trivial one within the page.
 * A smarter backend (vector / hybrid) injected in its place ranks by relevance
 * and is left untouched; importance ranking is the SUBSTRING backend's job.
 *
 * When no entry sets importance this reduces to plain recency (top-k by `ts`),
 * so the `recall` tool behaves exactly as before for callers that never score.
 */
export function handleRetriever(memory: MemoryHandle, opts?: RetrieverOptions): MemoryRetriever {
  return {
    async retrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
      const k = query.k
      // Pull a wider recency window so importance can outrank pure recency
      // within the page; a vector backend would not need this.
      const wideK = k ? Math.min(k * 4, 200) : 200
      const page = filterActive(await memory.recall({ ...query, k: wideK }), opts)
      page.sort(compareByImportanceThenRecency)
      return k ? page.slice(0, k) : page
    },
  }
}

/**
 * The Chinese-aware lexical retriever — the new DEFAULT for the `recall` tool.
 *
 * It pulls a recency window WITHOUT handing `text` to the backend (so the
 * backend's substring filter can't pre-drop a non-contiguous CJK match), then
 * ranks every candidate by {@link relevanceScore} (CJK bigram / Latin token
 * overlap), breaking ties by importance-then-recency. It is a strict improvement
 * over substring matching:
 *
 *   - a full-phrase hit still scores 1, Latin tokens still match, an empty query
 *     still returns importance-then-recency (identical to {@link handleRetriever});
 *   - but 「奶茶店」 now finds 「卖奶茶的店」 where the substring backend returned
 *     nothing.
 *
 * With a query present, zero-relevance candidates are dropped (the tool still
 * NARROWS, as a keyword search should). Scope: it ranks over the most recent
 * `wideK` (cap 200) — for a consolidated, budget-bounded butler that is
 * effectively the whole store; an injected vector retriever (C-M3) handles
 * unbounded corpora.
 */
export function lexicalRetriever(memory: MemoryHandle, opts?: RetrieverOptions): MemoryRetriever {
  return {
    async retrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
      const k = query.k
      const wideK = k ? Math.min(k * 8, 200) : 200
      // Drop `text` from the backend query — its substring filter would discard
      // the very non-contiguous CJK matches this retriever exists to rank. We
      // pull by recency (honoring kinds / since) and rank `text` ourselves.
      const { text, ...rest } = query
      const page = filterActive(await memory.recall({ ...rest, k: wideK }), opts)

      const q = text?.trim()
      if (!q) {
        page.sort(compareByImportanceThenRecency)
        return k ? page.slice(0, k) : page
      }

      const ranked = page
        .map((e) => ({ e, r: relevanceScore(q, e.text) }))
        .filter((x) => x.r > 0)
        .sort((a, b) => (a.r !== b.r ? b.r - a.r : compareByImportanceThenRecency(a.e, b.e)))
        .map((x) => x.e)
      return k ? ranked.slice(0, k) : ranked
    },
  }
}
