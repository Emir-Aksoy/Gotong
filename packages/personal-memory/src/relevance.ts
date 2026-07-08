/**
 * relevance.ts — deterministic lexical relevance scoring for `recall`
 * (decision C / 用户「默认召回中文弱」).
 *
 * # Why this exists
 *
 * The MVP file backend's `recall` matches by case-insensitive SUBSTRING. That
 * is fine for Latin keywords but quietly fails on Chinese: the text has no word
 * spaces, so a query like 「奶茶店」 never appears as a contiguous substring
 * inside 「我开了家卖奶茶的小店」 even though they are obviously about the same
 * thing. Every M5-era test had to hand-pick ASCII keywords or pre-split bigrams
 * to dodge exactly this. A resident butler whose owner speaks Chinese needs
 * recall that ranks by OVERLAP, not exact contiguity.
 *
 * # The approach: mixed CJK-bigram / Latin-token overlap (no deps, pure)
 *
 * This is the lexical half of a Generative-Agents-style relevance score — pure,
 * synchronous, embedding-free, so it belongs in the framework. (The semantic
 * half — vectors — stays OUT of the framework behind the `MemoryRetriever`
 * seam; see C-M3.)
 *
 *   - CJK runs are split into character BIGRAMS (奶茶店 → 奶茶, 茶店). Bigram
 *     overlap is the standard lightweight stand-in for CJK word segmentation:
 *     two texts about 奶茶 share the 奶茶 bigram with no dictionary. A lone CJK
 *     character keeps itself as a unigram term.
 *   - Latin/digit runs are split into whole lowercased TOKENS (word-level —
 *     splitting Latin into bigrams would over-match unrelated words like
 *     "coffee"/"toffee").
 *   - A full-phrase substring hit is the strongest signal → score 1.
 *
 * Score = `matched query terms / total query terms` (query-coverage), in [0,1].
 * Used ONLY on the recall path (C-M2) and by E's link-building (E-M1); it NEVER
 * enters the frozen block, whose ordering must stay a pure function of the entry
 * SET (the prompt-cache byte-stability contract).
 */

/** A CJK ideograph (Ext-A + Unified + Compatibility) — covers Chinese. */
function isCjk(ch: string): boolean {
  return /[㐀-䶿一-鿿豈-﫿]/.test(ch)
}

/** A Latin letter or digit (the runs we keep as whole word tokens). */
function isLatinDigit(ch: string): boolean {
  return /[a-zA-Z0-9]/.test(ch)
}

/**
 * Split a string into recallable terms: CJK runs → character bigrams (lone CJK
 * char → unigram), Latin/digit runs → whole lowercased tokens. Punctuation and
 * whitespace (ASCII or CJK) are separators and produce no term.
 *
 * Order is preserved and duplicates are kept; callers that want a set build one.
 * Exported because E-M1's link-building scores entry-to-entry similarity off the
 * same term extraction (one tokenizer, no drift).
 */
export function extractTerms(s: string): string[] {
  const terms: string[] = []
  const n = s.length
  let i = 0
  while (i < n) {
    const ch = s[i]!
    if (isCjk(ch)) {
      let j = i
      while (j < n && isCjk(s[j]!)) j++
      const run = s.slice(i, j)
      if (run.length === 1) {
        terms.push(run)
      } else {
        for (let k = 0; k + 1 < run.length; k++) terms.push(run.slice(k, k + 2))
      }
      i = j
    } else if (isLatinDigit(ch)) {
      let j = i
      while (j < n && isLatinDigit(s[j]!)) j++
      terms.push(s.slice(i, j).toLowerCase())
      i = j
    } else {
      i++ // separator
    }
  }
  return terms
}

/**
 * Recall (candidate-generation) terms: everything {@link extractTerms} yields PLUS
 * each individual CJK character as a unigram.
 *
 * The inverted index tokenizes with THIS, not `extractTerms`, so a single-CJK-
 * character query still has a posting to hit: a bigram-only index has no term for
 * 「茶」 (a length-≥2 run only produces bigrams like 奶茶/茶店), so a query 「茶」
 * finds NOTHING and recall comes back empty — even though 「珍珠奶茶」 obviously
 * contains it (audit P2). Adding the unigrams gives the single-char query a
 * candidate to surface.
 *
 * This widens CANDIDATE GENERATION only — ranking still uses the precise bigram
 * scorer {@link relevanceScore}. An extra unigram candidate that isn't actually
 * relevant scores 0 there and is filtered out, so the wider net never widens the
 * RESULT set for multi-character queries; it only rescues the single-char case.
 */
export function extractRecallTerms(s: string): string[] {
  const terms = extractTerms(s)
  for (const ch of s) if (isCjk(ch)) terms.push(ch)
  return terms
}

/**
 * Lexical relevance of `text` to `query`, in [0,1].
 *
 *   - Empty query (or no extractable terms) → 0 (nothing to match on).
 *   - The full normalized query appearing as a contiguous substring of the text
 *     → 1 (the strongest signal; works for both CJK phrases and Latin tokens).
 *   - Otherwise: the fraction of the query's terms that also appear in the text
 *     (CJK bigram / Latin token overlap). This is what lets 「奶茶店」 match
 *     「卖奶茶的店」 (shared 奶茶 bigram) where substring matching scores 0.
 *
 * Asymmetric on purpose (query-coverage, not Dice): recall asks "how much of
 * what I searched for is present here", not "how similar are these two strings".
 */
export function relevanceScore(query: string, text: string): number {
  const q = query.trim()
  if (!q) return 0
  const qTerms = new Set(extractTerms(q))
  if (qTerms.size === 0) return 0

  // Full-phrase substring hit = exact match = top score. Lowercase both so a
  // Latin query is case-insensitive; CJK is unaffected by toLowerCase.
  const normQuery = q.toLowerCase()
  if (text.toLowerCase().includes(normQuery)) return 1

  const tTerms = new Set(extractTerms(text))
  let matched = 0
  for (const term of qTerms) if (tTerms.has(term)) matched++
  return matched / qTerms.size
}
