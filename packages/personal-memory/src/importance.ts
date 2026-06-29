/**
 * importance.ts — per-entry importance (salience) for the butler's memory.
 *
 * Decision ⑤: memory needs importance differentiation. We carry it as a small
 * integer 1..5 in `meta.importance` — NO schema change (MemoryEntry.meta is
 * free-form), and it keeps the frozen block byte-stable (ordering is a pure
 * function of the entry SET, see {@link compareByImportanceThenRecency}).
 *
 * Why an integer 1..5 (not a 0..1 float): an LLM assigns it reliably, a human
 * reads it at a glance, and it maps cleanly onto the consolidation levels
 * (digest→profile) added in the tier work. 5 is the pin level — never evicted
 * under space pressure.
 *
 * Importance drives three things across the engine:
 *   - frozen-block ordering: high importance leads, and survives the byte budget;
 *   - recall ranking (default retriever) + an optional `minImportance` filter;
 *   - consolidation: what gets promoted vs dropped (the tier work).
 */

import type { MemoryEntry } from '@aipehub/services-sdk'

export type Importance = 1 | 2 | 3 | 4 | 5

export const MIN_IMPORTANCE: Importance = 1
export const DEFAULT_IMPORTANCE: Importance = 3
export const MAX_IMPORTANCE: Importance = 5
/** The pin level: an entry at this importance is never auto-dropped. */
export const PIN_IMPORTANCE: Importance = 5

/** Meta key carrying an entry's importance. */
export const META_IMPORTANCE = 'importance'

/**
 * A few human/LLM words an importance might arrive as. Kept small on purpose —
 * the canonical input is the integer; words are a forgiving fallback so a model
 * that says "high" instead of 4 is not silently demoted to the default.
 */
const WORD_MAP: Record<string, Importance> = {
  trivial: 1,
  low: 2,
  normal: 3,
  medium: 3,
  high: 4,
  critical: 5,
  pin: 5,
}

/**
 * Coerce arbitrary input to a valid {@link Importance}. Accepts a number
 * (rounded + clamped to 1..5), a numeric string, or a known word
 * (low/medium/high/critical/…). Anything else → {@link DEFAULT_IMPORTANCE},
 * so a missing or garbage value reads as "ordinary" and this never throws.
 */
export function clampImportance(v: unknown): Importance {
  if (typeof v === 'number' && Number.isFinite(v)) return clampInt(v)
  if (typeof v === 'string') {
    const w = WORD_MAP[v.trim().toLowerCase()]
    if (w) return w
    const n = Number(v)
    if (v.trim().length > 0 && Number.isFinite(n)) return clampInt(n)
  }
  return DEFAULT_IMPORTANCE
}

/** Read an entry's importance from its meta, defaulting to mid. */
export function importanceOf(entry: Pick<MemoryEntry, 'meta'>): Importance {
  const raw = (entry.meta as { importance?: unknown } | undefined)?.importance
  return raw === undefined ? DEFAULT_IMPORTANCE : clampImportance(raw)
}

/**
 * Stable ordering comparator: importance DESC, then recency (`ts` DESC), then
 * id ASC. PURE — sorting with this is a function of the entry SET only, so the
 * frozen block stays byte-stable (the prompt-cache contract). When all entries
 * share the default importance this reduces to plain recency, so callers that
 * never set importance see no behaviour change.
 */
export function compareByImportanceThenRecency(a: MemoryEntry, b: MemoryEntry): number {
  const ia = importanceOf(a)
  const ib = importanceOf(b)
  if (ia !== ib) return ib - ia
  if (a.ts !== b.ts) return b.ts - a.ts
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function clampInt(n: number): Importance {
  const r = Math.round(n)
  return (r < MIN_IMPORTANCE ? MIN_IMPORTANCE : r > MAX_IMPORTANCE ? MAX_IMPORTANCE : r) as Importance
}
