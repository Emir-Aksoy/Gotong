/**
 * Associative links (E-M1) — deterministic link-building over term overlap.
 *
 * Load-bearing claims:
 *   1. `linkRelated` is PURE and deterministic — same inputs → same ids, ranked
 *      by symmetric term overlap, ties broken by importance/recency/id.
 *   2. It links only to things that actually overlap (zero-score dropped), never
 *      to itself, and respects topK / minScore.
 *   3. `defaultLinkScorer` is CJK-aware (reuses C-M1 `extractTerms`) and symmetric.
 *   4. `linksOf` / `mergeLinks` read and union link ids defensively (E-M2 makes
 *      links bidirectional by merging, so merge must be idempotent + self-safe).
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LINK_TOP_K,
  defaultLinkScorer,
  linkRelated,
  linksOf,
  mergeLinks,
  type LinkScorer,
} from '../src/index.js'
import { entry } from './fake-memory.js'

describe('defaultLinkScorer', () => {
  it('scores overlapping CJK texts above non-overlapping ones', () => {
    const a = entry('a', 'semantic', '喜欢喝奶茶', 100)
    const b = entry('b', 'semantic', '常去那家奶茶店', 100)
    const c = entry('c', 'semantic', '在打篮球', 100)
    expect(defaultLinkScorer(a, b)).toBeGreaterThan(0) // share 奶茶 bigram
    expect(defaultLinkScorer(a, c)).toBe(0) // nothing in common
  })

  it('is symmetric — relatedness is mutual', () => {
    const a = entry('a', 'semantic', '在做 AipeHub 项目', 100)
    const b = entry('b', 'semantic', 'AipeHub 项目进度', 100)
    expect(defaultLinkScorer(a, b)).toBe(defaultLinkScorer(b, a))
  })

  it('term-less / empty texts score 0', () => {
    const a = entry('a', 'semantic', '', 100)
    const b = entry('b', 'semantic', '奶茶', 100)
    expect(defaultLinkScorer(a, b)).toBe(0)
  })

  it('identical texts score 1 (full Jaccard)', () => {
    const a = entry('a', 'semantic', '住在马来西亚', 100)
    const b = entry('b', 'semantic', '住在马来西亚', 200)
    expect(defaultLinkScorer(a, b)).toBe(1)
  })
})

describe('linkRelated', () => {
  it('returns ids of overlapping candidates, dropping the unrelated and itself', () => {
    const self = entry('self', 'semantic', '我喜欢喝奶茶', 100)
    const cands = [
      self, // must be excluded even if passed in
      entry('a', 'semantic', '楼下新开了奶茶店', 90),
      entry('b', 'semantic', '奶茶加珍珠最好喝', 80),
      entry('c', 'semantic', '今天去爬山', 70), // unrelated → score 0 → dropped
    ]
    const ids = linkRelated(self, cands)
    expect(ids).toContain('a')
    expect(ids).toContain('b')
    expect(ids).not.toContain('c')
    expect(ids).not.toContain('self')
  })

  it('respects topK', () => {
    const self = entry('self', 'semantic', '奶茶', 100)
    const cands = [
      entry('a', 'semantic', '奶茶店', 90),
      entry('b', 'semantic', '奶茶好喝', 80),
      entry('c', 'semantic', '珍珠奶茶', 70),
    ]
    expect(linkRelated(self, cands, { topK: 2 })).toHaveLength(2)
  })

  it('topK 0 returns no links', () => {
    const self = entry('self', 'semantic', '奶茶', 100)
    const cands = [entry('a', 'semantic', '奶茶店', 90)]
    expect(linkRelated(self, cands, { topK: 0 })).toEqual([])
  })

  it('minScore filters weak overlaps', () => {
    const self = entry('self', 'semantic', '奶茶店开在马来西亚', 100)
    const strong = entry('strong', 'semantic', '奶茶店开在马来西亚', 90) // identical → 1
    const weak = entry('weak', 'semantic', '奶茶配甜点', 80) // shares only 奶茶
    const all = linkRelated(self, [strong, weak])
    expect(all).toContain('strong')
    expect(all).toContain('weak')
    const filtered = linkRelated(self, [strong, weak], { minScore: 0.5 })
    expect(filtered).toEqual(['strong']) // weak's Jaccard < 0.5
  })

  it('breaks score ties by importance, then recency, then id', () => {
    // Three candidates with identical text → identical score 1; the tiebreak is
    // importance DESC, ts DESC, id ASC (compareByImportanceThenRecency).
    const self = entry('self', 'semantic', '奶茶', 100)
    const cands = [
      entry('low', 'semantic', '奶茶', 300, { importance: 1 }),
      entry('hi-old', 'semantic', '奶茶', 100, { importance: 5 }),
      entry('hi-new', 'semantic', '奶茶', 200, { importance: 5 }),
    ]
    expect(linkRelated(self, cands)).toEqual(['hi-new', 'hi-old', 'low'])
  })

  it('is deterministic across input orderings', () => {
    const self = entry('self', 'semantic', '奶茶', 100)
    const a = entry('a', 'semantic', '奶茶', 200, { importance: 3 })
    const b = entry('b', 'semantic', '奶茶', 200, { importance: 3 })
    expect(linkRelated(self, [a, b])).toEqual(linkRelated(self, [b, a])) // id ASC final tiebreak
  })

  it('honors a custom scorer', () => {
    // Reverse scorer: rank by id length so we can prove the override is used.
    const byIdLen: LinkScorer = (_a, b) => b.id.length
    const self = entry('self', 'semantic', 'x', 100)
    const cands = [
      entry('aaa', 'semantic', 'x', 90),
      entry('a', 'semantic', 'x', 80),
      entry('aa', 'semantic', 'x', 70),
    ]
    expect(linkRelated(self, cands, { scorer: byIdLen })).toEqual(['aaa', 'aa', 'a'])
  })

  it('defaults to DEFAULT_LINK_TOP_K links', () => {
    const self = entry('self', 'semantic', '奶茶', 100)
    const cands = Array.from({ length: DEFAULT_LINK_TOP_K + 3 }, (_, i) =>
      entry(`c${i}`, 'semantic', '奶茶', 100 + i),
    )
    expect(linkRelated(self, cands)).toHaveLength(DEFAULT_LINK_TOP_K)
  })
})

describe('linksOf', () => {
  it('reads link ids from meta', () => {
    expect(linksOf({ meta: { links: ['a', 'b'] } })).toEqual(['a', 'b'])
  })

  it('returns [] when meta or links absent', () => {
    expect(linksOf({})).toEqual([])
    expect(linksOf({ meta: {} })).toEqual([])
    expect(linksOf({ meta: { links: 'oops' } })).toEqual([]) // not an array
  })

  it('dedups and drops non-string / empty entries', () => {
    expect(linksOf({ meta: { links: ['a', 'a', '', 7, null, 'b'] } })).toEqual(['a', 'b'])
  })
})

describe('mergeLinks', () => {
  it('unions existing and new, deduped, existing-first', () => {
    expect(mergeLinks(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('is idempotent — re-merging the same ids changes nothing', () => {
    const once = mergeLinks(['a'], ['b'])
    expect(mergeLinks(once, ['a', 'b'])).toEqual(once)
  })

  it('drops self-id and empties (an entry never links to itself)', () => {
    expect(mergeLinks(['a', ''], ['self', 'b'], 'self')).toEqual(['a', 'b'])
  })
})
