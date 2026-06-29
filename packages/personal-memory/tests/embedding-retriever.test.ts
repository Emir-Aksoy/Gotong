/**
 * embeddingRetriever — the SEMANTIC half of recall (C-M3).
 *
 * The headline claim: a query that shares ZERO characters with the stored text
 * still matches when they are semantically close. 「饮料」 (beverage) finds
 * 「奶茶」 / 「咖啡」 — something lexical overlap (C-M2) scores exactly 0 on, since
 * those strings share no characters with 「饮料」.
 *
 * The framework never computes a vector; the embedder is injected. These tests
 * inject a tiny deterministic keyword→dimension embedder so the semantics are
 * exact and the test stays hermetic (no model, no network).
 */

import { describe, expect, it, vi } from 'vitest'

import { cosineSimilarity, embeddingRetriever, lexicalRetriever, type Embedder } from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

// A deterministic stand-in for a real embedding model: three concept axes, a
// 1 on an axis if the text mentions any of that concept's keywords. Good enough
// to make 「奶茶」/「咖啡」/「饮料」 collinear (all on the `drink` axis) while
// 「篮球」 is orthogonal.
const AXES: Record<string, readonly string[]> = {
  drink: ['奶茶', '咖啡', '饮料', '茶', '奶'],
  sport: ['篮球', '足球', '运动'],
  weather: ['天气', '下雨', '晴'],
}
const AXIS_KEYS = Object.keys(AXES)
const fakeEmbed: Embedder = async (texts) =>
  texts.map((t) => AXIS_KEYS.map((axis) => (AXES[axis]!.some((kw) => t.includes(kw)) ? 1 : 0)))

describe('cosineSimilarity', () => {
  it('is 1 for identical direction, 0 for orthogonal, -1 for opposite', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
  })

  it('is magnitude-invariant', () => {
    expect(cosineSimilarity([2, 0, 0], [5, 0, 0])).toBeCloseTo(1)
  })

  it('returns 0 (not NaN) for empty or zero vectors, and tolerates length mismatch', () => {
    expect(cosineSimilarity([], [1, 2])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBeCloseTo(1) // min length
  })
})

describe('embeddingRetriever', () => {
  it('THE point: a zero-lexical-overlap query matches semantically (饮料 → 奶茶/咖啡)', async () => {
    const mem = makeFakeMemory([
      entry('tea', 'semantic', '我每天都喝奶茶', 100),
      entry('coffee', 'semantic', '早上来一杯咖啡', 200),
      entry('ball', 'semantic', '周末打篮球', 300),
    ])
    const r = await embeddingRetriever({ memory: mem, embed: fakeEmbed }).retrieve({
      text: '饮料',
      k: 5,
    })
    // drink-axis entries surface; the orthogonal sport entry is dropped.
    expect(r.map((e) => e.id).sort()).toEqual(['coffee', 'tea'])

    // Contrast: lexical overlap scores 饮料-vs-奶茶 at 0, so lexical finds nothing.
    const lex = await lexicalRetriever(mem).retrieve({ text: '饮料', k: 5 })
    expect(lex).toHaveLength(0)
  })

  it('embeds the query + all candidates in ONE batch call', async () => {
    const mem = makeFakeMemory([
      entry('a', 'semantic', '奶茶', 100),
      entry('b', 'semantic', '咖啡', 200),
    ])
    const spy = vi.fn(fakeEmbed)
    await embeddingRetriever({ memory: mem, embed: spy }).retrieve({ text: '饮料', k: 5 })
    expect(spy).toHaveBeenCalledTimes(1)
    // query first, then candidates in the backend's recency order (newest-first).
    expect(spy.mock.calls[0]![0]).toEqual(['饮料', '咖啡', '奶茶'])
  })

  it('breaks cosine ties by importance, then recency', async () => {
    const mem = makeFakeMemory([
      entry('old', 'semantic', '奶茶', 100),
      entry('new', 'semantic', '咖啡', 300),
      entry('vip', 'semantic', '饮料', 200, { importance: 5 }),
    ])
    // All three are collinear with 饮料 (cosine 1) → ties resolve by importance, then ts.
    const r = await embeddingRetriever({ memory: mem, embed: fakeEmbed }).retrieve({ text: '饮料' })
    expect(r.map((e) => e.id)).toEqual(['vip', 'new', 'old'])
  })

  it('honors minScore to keep only sufficiently-similar candidates', async () => {
    // A graded embedder: partial overlap → smaller cosine.
    const graded: Embedder = async (texts) =>
      texts.map((t) => [t.includes('奶茶') ? 1 : 0, t.includes('热') ? 1 : 0])
    const mem = makeFakeMemory([
      entry('pure', 'semantic', '奶茶', 100), // [1,0] vs query [1,0] → cos 1
      entry('mixed', 'semantic', '热奶茶', 200), // [1,1] vs [1,0] → cos ~0.707
    ])
    const hi = await embeddingRetriever({ memory: mem, embed: graded, minScore: 0.9 }).retrieve({
      text: '奶茶',
    })
    expect(hi.map((e) => e.id)).toEqual(['pure']) // mixed (~0.707) filtered out
  })

  it('with no query text, reduces to importance-then-recency (no embed call)', async () => {
    const mem = makeFakeMemory([
      entry('o', 'semantic', '奶茶', 100),
      entry('n', 'semantic', '咖啡', 200),
      entry('v', 'semantic', '篮球', 50, { importance: 5 }),
    ])
    const spy = vi.fn(fakeEmbed)
    const r = await embeddingRetriever({ memory: mem, embed: spy }).retrieve({ k: 5 })
    expect(r.map((e) => e.id)).toEqual(['v', 'n', 'o'])
    expect(spy).not.toHaveBeenCalled() // no query → no reason to embed
  })

  it('passes kinds through to the recency window', async () => {
    const mem = makeFakeMemory([
      entry('sem', 'semantic', '奶茶', 100),
      entry('epi', 'episodic', '奶茶', 200),
    ])
    const r = await embeddingRetriever({ memory: mem, embed: fakeEmbed }).retrieve({
      text: '饮料',
      kinds: ['semantic'],
    })
    expect(r.map((e) => e.id)).toEqual(['sem'])
  })

  it('degrades to recency order if the embedder throws (never breaks recall)', async () => {
    const mem = makeFakeMemory([
      entry('a', 'semantic', '奶茶', 100),
      entry('b', 'semantic', '咖啡', 200),
    ])
    const boom: Embedder = async () => {
      throw new Error('embedding backend down')
    }
    const r = await embeddingRetriever({ memory: mem, embed: boom }).retrieve({ text: '饮料', k: 5 })
    expect(r.map((e) => e.id)).toEqual(['b', 'a']) // newest-first fallback, not an error
  })

  it('degrades to recency if the embedder returns the wrong shape', async () => {
    const mem = makeFakeMemory([entry('a', 'semantic', '奶茶', 100)])
    const empty: Embedder = async () => []
    const r = await embeddingRetriever({ memory: mem, embed: empty }).retrieve({ text: '饮料', k: 5 })
    expect(r.map((e) => e.id)).toEqual(['a'])
  })
})
