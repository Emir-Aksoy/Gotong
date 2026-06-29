/**
 * links.ts — associative memory / link evolution (decision E).
 *
 * A-MEM (Zettelkasten for agents) interlinks memory notes so a cluster becomes a
 * small graph: pull one fact and you can walk to the related ones. AipeHub's own
 * `[[name]]` memory works the same way. E brings that to the butler — entries
 * carry `meta.links: string[]` (ids of related entries), exactly like importance
 * / recallCount: free-form meta, NO schema change.
 *
 * # This module is the DETERMINISTIC half (no LLM)
 *
 * `linkRelated` ranks candidates by term overlap and returns the top-K ids — a
 * pure function reusing C-M1's `extractTerms` tokenizer (one tokenizer, no
 * drift). The scorer is SYMMETRIC (Jaccard over term sets) because relatedness
 * is mutual — unlike `recall`'s asymmetric query-coverage `relevanceScore`. E-M2
 * wires this into the write path (reconcile ADD / consolidate) and makes links
 * BIDIRECTIONAL via {@link mergeLinks}; E-M3 expands one hop on recall / in the
 * frozen block.
 *
 * # Where links may act — and where they may NOT
 *
 * Links live in meta and are read by the recall / expansion path. They do NOT
 * enter the frozen block's ORDER (that stays `compareByImportanceThenRecency`, a
 * pure set-function — the prompt-cache contract); E-M3 only OPTIONALLY appends a
 * deterministic "related: [id]" tail per line, byte-stable for a fixed set.
 */

import type { MemoryEntry } from '@aipehub/services-sdk'

import { compareByImportanceThenRecency } from './importance.js'
import { extractTerms } from './relevance.js'

/** Meta key carrying an entry's related-entry ids. */
export const META_LINKS = 'links'

/** Default cap on links computed per entry. */
export const DEFAULT_LINK_TOP_K = 5

/** Relatedness of two entries, higher = more related. Symmetric by contract. */
export type LinkScorer = (a: MemoryEntry, b: MemoryEntry) => number

export interface LinkRelatedOptions {
  /** Max links to return. Default {@link DEFAULT_LINK_TOP_K}. */
  topK?: number
  /** Only link candidates scoring strictly above this. Default 0. */
  minScore?: number
  /** Override the relatedness scorer. Default {@link defaultLinkScorer}. */
  scorer?: LinkScorer
}

/**
 * Symmetric term-overlap (Jaccard) over C-M1's `extractTerms` — CJK bigrams +
 * Latin tokens. Symmetric because relatedness is mutual: link(a,b) == link(b,a).
 * Two empty/term-less texts score 0.
 */
export const defaultLinkScorer: LinkScorer = (a, b) =>
  jaccard(extractTerms(a.text), extractTerms(b.text))

/**
 * The ids of the top-K candidates most related to `entry` (excluding itself),
 * in deterministic order: score DESC, ties broken by
 * {@link compareByImportanceThenRecency} (importance, recency, id). Zero-score
 * candidates are dropped — an entry links only to things it actually overlaps.
 *
 * Pure: same inputs → same ids, every time. No LLM, no I/O.
 */
export function linkRelated(
  entry: MemoryEntry,
  candidates: readonly MemoryEntry[],
  opts: LinkRelatedOptions = {},
): string[] {
  const topK = Math.max(0, Math.floor(opts.topK ?? DEFAULT_LINK_TOP_K))
  if (topK === 0) return []
  const minScore = opts.minScore ?? 0
  const scorer = opts.scorer ?? defaultLinkScorer

  return candidates
    .filter((c) => c.id !== entry.id)
    .map((c) => ({ c, s: scorer(entry, c) }))
    .filter((x) => x.s > minScore)
    .sort((a, b) => (a.s !== b.s ? b.s - a.s : compareByImportanceThenRecency(a.c, b.c)))
    .slice(0, topK)
    .map((x) => x.c.id)
}

/** Read an entry's link ids from meta (deduped, non-empty strings only). */
export function linksOf(entry: Pick<MemoryEntry, 'meta'>): string[] {
  const raw = (entry.meta as { links?: unknown } | undefined)?.links
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of raw) {
    if (typeof x === 'string' && x.length > 0 && !seen.has(x)) {
      seen.add(x)
      out.push(x)
    }
  }
  return out
}

/**
 * Merge new link ids into existing ones: deduped union, dropping empties and
 * `selfId` (an entry never links to itself). Order is existing-first then new —
 * idempotent (re-merging the same ids changes nothing), which is what makes
 * bidirectional linking safe to run repeatedly.
 */
export function mergeLinks(
  existing: readonly string[],
  add: readonly string[],
  selfId?: string,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of [...existing, ...add]) {
    if (id && id !== selfId && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const sa = new Set(a)
  const sb = new Set(b)
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}
