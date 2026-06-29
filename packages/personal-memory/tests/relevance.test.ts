/**
 * relevance.ts — deterministic CJK-bigram / Latin-token relevance scoring.
 *
 * The headline claim is the Chinese case: a query that is NOT a contiguous
 * substring of the text (the MVP backend's only matcher) must still score > 0
 * via bigram overlap. That is the whole reason this module exists.
 */

import { describe, expect, it } from 'vitest'

import { extractTerms, relevanceScore } from '../src/relevance.js'

describe('extractTerms', () => {
  it('splits a CJK run into character bigrams', () => {
    expect(extractTerms('奶茶店')).toEqual(['奶茶', '茶店'])
  })

  it('keeps a lone CJK character as a unigram', () => {
    expect(extractTerms('茶')).toEqual(['茶'])
  })

  it('keeps a Latin run as one lowercased token (not bigrams)', () => {
    expect(extractTerms('Coffee')).toEqual(['coffee'])
  })

  it('treats whitespace and punctuation as separators', () => {
    expect(extractTerms('coffee, tea')).toEqual(['coffee', 'tea'])
    expect(extractTerms('奶茶、咖啡')).toEqual(['奶茶', '咖啡'])
  })

  it('handles mixed CJK + Latin + digits in one string', () => {
    // 喝 (unigram) | coffee (token) | 还是奶茶 → 还是,是奶,奶茶 | 3 (token)
    expect(extractTerms('喝coffee还是奶茶3')).toEqual([
      '喝',
      'coffee',
      '还是',
      '是奶',
      '奶茶',
      '3',
    ])
  })

  it('returns nothing for a separators-only string', () => {
    expect(extractTerms('  ,、 ')).toEqual([])
  })
})

describe('relevanceScore', () => {
  it('THE point: a non-contiguous Chinese query still scores > 0 via bigrams', () => {
    // 「奶茶店」 is NOT a substring of 「我开了家卖奶茶的小店」 → substring match
    // would give 0. Bigram overlap finds the shared 奶茶.
    const s = relevanceScore('奶茶店', '我开了家卖奶茶的小店')
    expect(s).toBeGreaterThan(0)
    expect('我开了家卖奶茶的小店'.includes('奶茶店')).toBe(false) // proves substring fails
  })

  it('scores a full CJK-phrase substring hit as 1', () => {
    expect(relevanceScore('奶茶', '我爱喝奶茶')).toBe(1)
  })

  it('scores a full Latin-phrase substring hit as 1 (case-insensitive)', () => {
    expect(relevanceScore('COFFEE', 'I love coffee')).toBe(1)
  })

  it('matches Latin tokens out of order when there is no substring hit', () => {
    // "coffee shop" not contiguous in the text, but both tokens are present.
    const s = relevanceScore('coffee shop', 'this shop only sells coffee beans')
    expect(s).toBe(1) // 2/2 query tokens matched
  })

  it('gives a partial score when only some query terms match', () => {
    // query bigrams {奶茶, coffee}; text has 奶茶 but not coffee → 1/2.
    expect(relevanceScore('奶茶 coffee', '卖奶茶和点心')).toBeCloseTo(0.5, 5)
  })

  it('ranks an exact mention above a partial overlap (the ordering use case)', () => {
    const exact = relevanceScore('奶茶店', '我开了家奶茶店') // substring → 1
    const partial = relevanceScore('奶茶店', '卖奶茶的店') // bigrams 奶茶✓ 茶店✗ → 0.5
    expect(exact).toBeGreaterThan(partial)
    expect(partial).toBeGreaterThan(0)
  })

  it('scores 0 when nothing overlaps', () => {
    expect(relevanceScore('篮球', '我爱喝奶茶')).toBe(0)
  })

  it('scores 0 for an empty or whitespace-only query', () => {
    expect(relevanceScore('', '任何内容')).toBe(0)
    expect(relevanceScore('   ', '任何内容')).toBe(0)
  })

  it('handles a single CJK character query', () => {
    expect(relevanceScore('茶', '奶茶')).toBe(1) // substring hit
    expect(relevanceScore('茶', '咖啡')).toBe(0)
  })
})
