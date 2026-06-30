/**
 * inverted-index — the default-recall index (MR1).
 *
 * The headline claim that justifies the whole milestone: an inverted index ranks
 * over the WHOLE store, so it finds a relevant entry OLDER than the recency window
 * that `lexicalRetriever` (which only pulls the most-recent ~wideK) never even
 * makes a candidate. Ranking itself stays {@link relevanceScore} — the SAME
 * tokenizer / scorer — so it's a strict coverage upgrade, not a behavior change.
 */

import { describe, expect, it } from 'vitest'

import {
  InvertedIndex,
  buildInvertedIndex,
  invertedIndexRetriever,
  lexicalRetriever,
} from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

describe('InvertedIndex — pure structure', () => {
  it('query returns candidates sharing any term (CJK bigram overlap)', () => {
    const ix = buildInvertedIndex([
      entry('e1', 'semantic', '我开了家卖奶茶的小店', 100),
      entry('e2', 'semantic', '今天天气不错', 200),
    ])
    // 奶茶店 → bigrams {奶茶, 茶店}; e1 shares 奶茶, e2 shares nothing.
    expect(ix.query('奶茶店').map((e) => e.id)).toEqual(['e1'])
  })

  it('remove drops an entry and its postings', () => {
    const ix = buildInvertedIndex([entry('e1', 'semantic', '奶茶', 100)])
    expect(ix.query('奶茶').map((e) => e.id)).toEqual(['e1'])
    ix.remove('e1')
    expect(ix.size).toBe(0)
    expect(ix.query('奶茶')).toHaveLength(0)
  })

  it('re-indexing the same id replaces its text (stale terms cleared)', () => {
    const ix = new InvertedIndex()
    ix.index(entry('e1', 'semantic', '奶茶', 100))
    ix.index(entry('e1', 'semantic', '咖啡', 100)) // same id, new text
    expect(ix.size).toBe(1)
    expect(ix.query('奶茶')).toHaveLength(0) // old term no longer points at e1
    expect(ix.query('咖啡').map((e) => e.id)).toEqual(['e1'])
  })

  it('serialize → load round-trips query results', () => {
    const ix = buildInvertedIndex([
      entry('e1', 'semantic', '奶茶店', 100),
      entry('e2', 'semantic', '咖啡馆', 200),
    ])
    const back = InvertedIndex.load(ix.serialize())
    expect(back.size).toBe(2)
    expect(back.query('奶茶').map((e) => e.id)).toEqual(['e1'])
    expect(back.query('咖啡').map((e) => e.id)).toEqual(['e2'])
  })

  it('load skips structurally-invalid entries', () => {
    const bad = { version: 1, entries: [{ id: 'ok', kind: 'semantic', text: 'x', ts: 1 }, { id: 5 }, null] }
    const ix = InvertedIndex.load(bad as never)
    expect(ix.size).toBe(1)
    expect(ix.get('ok')?.text).toBe('x')
  })
})

describe('invertedIndexRetriever', () => {
  it('THE point: finds a relevant entry OLDER than lexicalRetriever\'s recency window', async () => {
    // 60 newer non-matching fillers + 1 old matching entry. With k=5,
    // lexicalRetriever's wideK = min(5*8,200) = 40 → it only pulls the newest 40
    // (all fillers) and ranks 0 → returns nothing. The index spans the whole store.
    const fillers = Array.from({ length: 60 }, (_, i) =>
      entry(`f${i}`, 'semantic', `闲聊记录第${i}条`, 1000 + i),
    )
    const oldHit = entry('hit', 'semantic', '我家附近有家奶茶店', 100) // oldest
    const all = [oldHit, ...fillers]

    const idx = await invertedIndexRetriever(buildInvertedIndex(all)).retrieve({ text: '奶茶店', k: 5 })
    expect(idx.map((e) => e.id)).toEqual(['hit']) // index finds the old relevant one

    // Contrast: the recency-window retriever misses it entirely.
    const lex = await lexicalRetriever(makeFakeMemory(all)).retrieve({ text: '奶茶店', k: 5 })
    expect(lex).toHaveLength(0)
  })

  it('ranks a full-phrase hit above a partial bigram overlap (same ordering as lexical)', async () => {
    const ix = buildInvertedIndex([
      entry('exact', 'semantic', '我家附近有奶茶店', 100), // substring hit → 1
      entry('partial', 'semantic', '卖奶茶的店', 200), // newer, only 奶茶 bigram → 0.5
    ])
    const r = await invertedIndexRetriever(ix).retrieve({ text: '奶茶店', k: 5 })
    expect(r[0]!.id).toBe('exact')
    expect(r.map((e) => e.id)).toContain('partial')
  })

  it('drops zero-relevance candidates when a query is present', async () => {
    const ix = buildInvertedIndex([
      entry('hit', 'semantic', '我爱奶茶', 100),
      entry('miss', 'semantic', '我爱篮球', 200),
    ])
    const r = await invertedIndexRetriever(ix).retrieve({ text: '奶茶', k: 5 })
    expect(r.map((e) => e.id)).toEqual(['hit'])
  })

  it('empty query → importance-then-recency over the whole index', async () => {
    const ix = buildInvertedIndex([
      entry('old', 'semantic', 'a', 100),
      entry('new', 'semantic', 'b', 200),
      entry('vip', 'semantic', 'c', 50, { importance: 5 }),
    ])
    const r = await invertedIndexRetriever(ix).retrieve({ k: 5 })
    expect(r.map((e) => e.id)).toEqual(['vip', 'new', 'old'])
  })

  it('honors kinds and since narrowing', async () => {
    const ix = buildInvertedIndex([
      entry('sem', 'semantic', '奶茶', 100),
      entry('epi', 'episodic', '奶茶', 200),
      entry('old', 'semantic', '奶茶', 10),
    ])
    expect((await invertedIndexRetriever(ix).retrieve({ text: '奶茶', kinds: ['semantic'], k: 9 }))
      .map((e) => e.id).sort()).toEqual(['old', 'sem'])
    expect((await invertedIndexRetriever(ix).retrieve({ text: '奶茶', since: 50, k: 9 }))
      .map((e) => e.id).sort()).toEqual(['epi', 'sem']) // old (ts 10) dropped
  })

  it('activeOnly (D) drops closed time-edges; off returns them', async () => {
    const ix = buildInvertedIndex([
      entry('cur', 'semantic', '住在槟城', 200, { validFrom: 150 }),
      entry('old', 'semantic', '住在吉隆坡', 100, { validFrom: 50, validTo: 150 }),
    ])
    const active = await invertedIndexRetriever(ix, { activeOnly: true, now: () => 300 }).retrieve({ k: 5 })
    expect(active.map((e) => e.id)).toEqual(['cur'])
    const all = await invertedIndexRetriever(ix).retrieve({ k: 5 })
    expect(all.map((e) => e.id)).toEqual(['cur', 'old'])
  })
})
