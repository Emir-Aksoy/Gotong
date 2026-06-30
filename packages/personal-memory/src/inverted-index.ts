/**
 * inverted-index.ts — the default-recall index (MR1, learning from Hermes Tier2).
 *
 * # The gap this closes
 *
 * `lexicalRetriever` (the prior default) pulls the most-recent `wideK` (cap 200)
 * entries from the handle and ranks THOSE by {@link relevanceScore}. That misses
 * the real problem for a resident butler: a relevant fact OLDER than the recency
 * window never even becomes a candidate — it can't be ranked because it was never
 * pulled. "半年前那家奶茶店叫什么" may sit just outside the last 200 turns.
 *
 * An inverted index fixes COVERAGE, not just cost: it maps each recallable term to
 * the entries that contain it, so a query's candidates are "everything that shares
 * a term", spanning the WHOLE store regardless of recency, in O(query-terms)
 * instead of O(n). Precise ranking is still {@link relevanceScore} — the index
 * only narrows the candidate set; the SAME tokenizer ({@link extractTerms}) and the
 * SAME scorer rank it, so there is zero drift between "what the index finds" and
 * "how recall ranked before".
 *
 * # Pure, file-first, no native dep (decision: 纯 JS 倒排, not SQLite FTS5)
 *
 * This module is the pure ALGORITHM — no I/O, no LLM, no native dependency. It
 * holds the entries it indexes (like a search index stores its documents), so the
 * retriever ranks and returns WITHOUT re-reading the backend. Persistence,
 * freshness, and rebuild-from-jsonl live in the host (`butler-recall-index.ts`)
 * so the leaf stays framework-friendly; the jsonl is always the source of truth
 * and this index is a rebuildable derived structure (北极星: file-first).
 *
 * The retriever drops into the existing {@link MemoryRetriever} seam (it sits ONLY
 * on the on-demand `recall` tool, never the frozen block) — a host swaps it in for
 * `lexicalRetriever` without touching anything else; SQLite FTS5 / vector
 * (`embeddingRetriever`, C-M3) remain alternative implementations behind the same
 * seam.
 */

import type { MemoryEntry, MemoryQuery } from '@aipehub/services-sdk'

import { isActive } from './bitemporal.js'
import { compareByImportanceThenRecency } from './importance.js'
import { extractTerms, relevanceScore } from './relevance.js'
import type { MemoryRetriever, RetrieverOptions } from './retriever.js'

/**
 * A serialized index. We persist the ENTRIES (postings are rebuilt from them on
 * load via the same {@link extractTerms} that built them) — one source of truth,
 * no chance of postings drifting from the entries they index. The host writes
 * this next to the jsonl so the index survives a restart; it is still a derived
 * cache the watermark check can discard and rebuild at any time.
 */
export interface InvertedIndexSnapshot {
  readonly version: 1
  readonly entries: readonly MemoryEntry[]
}

/** Structural validity for a loaded entry — drop anything that isn't a real entry. */
function validEntry(e: unknown): e is MemoryEntry {
  if (!e || typeof e !== 'object') return false
  const x = e as Partial<MemoryEntry>
  return (
    typeof x.id === 'string' &&
    typeof x.text === 'string' &&
    typeof x.kind === 'string' &&
    typeof x.ts === 'number'
  )
}

/**
 * A pure in-memory inverted index over `MemoryEntry`s. Holds both the postings
 * (`term → entry ids`) and the entries themselves, keyed by id, so `query`
 * returns ranked-ready entries without a backend round-trip. Re-indexing the same
 * id replaces it (so an entry whose text/meta changed is re-tokenized cleanly).
 */
export class InvertedIndex {
  private readonly byId = new Map<string, MemoryEntry>()
  /** term → set of entry ids containing it. */
  private readonly postings = new Map<string, Set<string>>()

  /** How many entries are indexed. */
  get size(): number {
    return this.byId.size
  }

  /** The indexed entry for `id`, if present. */
  get(id: string): MemoryEntry | undefined {
    return this.byId.get(id)
  }

  /** Every indexed entry (insertion order is not meaningful; callers sort). */
  entries(): MemoryEntry[] {
    return [...this.byId.values()]
  }

  /**
   * Index (or re-index) one entry. Re-indexing the same id first removes its old
   * postings, so a changed `text` never leaves stale terms pointing at it.
   */
  index(entry: MemoryEntry): void {
    if (this.byId.has(entry.id)) this.remove(entry.id)
    this.byId.set(entry.id, entry)
    for (const term of new Set(extractTerms(entry.text))) {
      let set = this.postings.get(term)
      if (!set) {
        set = new Set<string>()
        this.postings.set(term, set)
      }
      set.add(entry.id)
    }
  }

  /** Drop an entry and all its postings. Unknown id is a no-op. */
  remove(id: string): void {
    const e = this.byId.get(id)
    if (!e) return
    this.byId.delete(id)
    for (const term of new Set(extractTerms(e.text))) {
      const set = this.postings.get(term)
      if (!set) continue
      set.delete(id)
      if (set.size === 0) this.postings.delete(term)
    }
  }

  /**
   * Candidate entries for `text` = the UNION of postings for the query's terms
   * (OR semantics). Order is unspecified — the retriever ranks by relevance. The
   * union is what spans the whole store: a candidate that shares even one term
   * with the query is surfaced regardless of how old it is, then
   * {@link relevanceScore} decides whether it actually ranks.
   */
  query(text: string): MemoryEntry[] {
    const ids = new Set<string>()
    for (const term of new Set(extractTerms(text))) {
      const set = this.postings.get(term)
      if (set) for (const id of set) ids.add(id)
    }
    const out: MemoryEntry[] = []
    for (const id of ids) {
      const e = this.byId.get(id)
      if (e) out.push(e)
    }
    return out
  }

  /** Snapshot for the host to persist. Postings are NOT serialized (rebuilt on load). */
  serialize(): InvertedIndexSnapshot {
    return { version: 1, entries: this.entries() }
  }

  /** Rebuild an index from a snapshot, skipping any structurally-invalid entry. */
  static load(snap: InvertedIndexSnapshot | null | undefined): InvertedIndex {
    const ix = new InvertedIndex()
    if (snap && Array.isArray(snap.entries)) {
      for (const e of snap.entries) if (validEntry(e)) ix.index(e)
    }
    return ix
  }
}

/** Build an index from a batch of entries (cold-build / rebuild-from-jsonl). */
export function buildInvertedIndex(entries: Iterable<MemoryEntry>): InvertedIndex {
  const ix = new InvertedIndex()
  for (const e of entries) if (validEntry(e)) ix.index(e)
  return ix
}

/**
 * A {@link MemoryRetriever} that ranks an inverted index — the new index-backed
 * default for the `recall` tool.
 *
 * Unlike `handleRetriever` / `lexicalRetriever` (which read the handle live), this
 * reads a PRE-BUILT {@link InvertedIndex}: the host keeps it fresh (build on open,
 * incremental on writes, rebuild from jsonl on watermark drift). The retriever
 * itself is pure over the index — given a query it:
 *
 *   1. pulls candidates (whole store via postings, or all entries for an empty query);
 *   2. honors `kinds` / `since` (the index spans kinds; the seam still narrows);
 *   3. drops closed/not-yet-valid facts when `activeOnly` (D);
 *   4. ranks by {@link relevanceScore}, ties broken by importance-then-recency
 *      (identical ordering to `lexicalRetriever`);
 *   5. clamps to `k`.
 *
 * An empty query reduces to importance-then-recency over the whole index — same
 * contract as the other retrievers for callers that don't pass `text`.
 */
export function invertedIndexRetriever(
  index: InvertedIndex,
  opts?: RetrieverOptions,
): MemoryRetriever {
  return {
    async retrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
      const k = query.k
      const q = query.text?.trim()

      let candidates = q ? index.query(q) : index.entries()
      candidates = applyScope(candidates, query)
      candidates = filterActive(candidates, opts)

      if (!q) {
        candidates.sort(compareByImportanceThenRecency)
        return k ? candidates.slice(0, k) : candidates
      }

      const ranked = candidates
        .map((e) => ({ e, r: relevanceScore(q, e.text) }))
        .filter((x) => x.r > 0)
        .sort((a, b) => (a.r !== b.r ? b.r - a.r : compareByImportanceThenRecency(a.e, b.e)))
        .map((x) => x.e)
      return k ? ranked.slice(0, k) : ranked
    },
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** Apply the query's `kinds` / `since` narrowing (the index itself is kind-agnostic). */
function applyScope(page: MemoryEntry[], query: MemoryQuery): MemoryEntry[] {
  const kinds = query.kinds && query.kinds.length > 0 ? new Set(query.kinds) : undefined
  const since = query.since ?? 0
  if (!kinds && since <= 0) return page
  return page.filter((e) => (!kinds || kinds.has(e.kind)) && e.ts >= since)
}

/**
 * Drop closed / not-yet-valid facts when `activeOnly` is set (mirrors
 * `retriever.ts`'s identically-named private helper — same D semantics; an entry
 * with no validity meta is always active, so legacy data is unaffected).
 */
function filterActive(page: MemoryEntry[], opts?: RetrieverOptions): MemoryEntry[] {
  if (!opts?.activeOnly) return page
  const now = (opts.now ?? ((): number => Date.now()))()
  return page.filter((e) => isActive(e, now))
}
