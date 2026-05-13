/**
 * `memory` service type — per-owner recall of past activity.
 *
 * Three kinds of memory:
 *   - `episodic`  append-only log of "what happened" (one entry per
 *                 dispatched task by convention; plugin doesn't enforce)
 *   - `semantic`  curated knowledge the agent decides to keep ("I
 *                 learned that …"). Plugin authors may persist as a
 *                 single md file or many.
 *   - `working`   short-lived scratch tied to a single task. Plugin
 *                 implementations are encouraged to clear `working`
 *                 entries when the task that created them resolves,
 *                 though MVP plugins keep them until the agent does
 *                 `clear({kind:'working'})`.
 *
 * Recall is intentionally simple in MVP: plain-text substring or
 * full-list retrieval. Vector search lands in a separate
 * `memory:vector` plugin later — same MemoryHandle surface so agents
 * can swap implementations.
 */

export type MemoryKind = 'episodic' | 'semantic' | 'working'

export interface MemoryEntry {
  /** Stable id within this owner+kind. Assigned by `remember`. */
  readonly id: string
  readonly kind: MemoryKind
  /** Recallable content. Plugins MUST persist this verbatim. */
  readonly text: string
  /** Free-form metadata. Plugins SHOULD pass through unchanged. */
  readonly meta?: Record<string, unknown>
  /** Epoch ms when written. */
  readonly ts: number
}

export interface MemoryHandle {
  /**
   * Pull entries matching the query. With no `text`/`kinds`/`since`
   * this returns the most recent `k` (default 20) entries across all
   * kinds, newest first.
   *
   * `text` matching is implementation-defined: file backend does
   * case-insensitive substring; future vector backend does cosine
   * similarity. Agents should not assume a specific algorithm.
   */
  recall(query: MemoryQuery): Promise<MemoryEntry[]>

  /** Persist a new entry. Returns the entry with `id` and `ts` filled. */
  remember(entry: NewMemoryEntry): Promise<MemoryEntry>

  /**
   * Raw list — no filtering. Used by admin UI to render the full
   * timeline. Capped at `limit` (default 100) to keep payloads small.
   */
  list(opts?: { kind?: MemoryKind; limit?: number }): Promise<MemoryEntry[]>

  /** Remove one entry by id. No-op if not found. */
  forget(id: string): Promise<void>

  /** Remove all entries (or all of one kind). Used by `clear working`. */
  clear(kind?: MemoryKind): Promise<void>
}

export interface MemoryQuery {
  /** Free-text query. Case-insensitive substring in MVP file backend. */
  text?: string
  /** Restrict to one or more kinds. */
  kinds?: MemoryKind[]
  /** Max entries to return. Default 20, hard cap 200. */
  k?: number
  /** Only entries with `ts >= since`. */
  since?: number
}

/** Input to `remember`. The plugin assigns `id` + `ts`. */
export type NewMemoryEntry = Omit<MemoryEntry, 'id' | 'ts'> & {
  /** Optional: caller-supplied id (e.g. for idempotent retries). */
  id?: string
}
