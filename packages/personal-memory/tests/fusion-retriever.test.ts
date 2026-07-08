/**
 * fusion-retriever — multi-signal recall fusion (MU-M2).
 *
 * The headline claim: when the keyword arm TIES many candidates (coverage is
 * coarse) and the tie falls to recency, the term-frequency cosine arm lifts the
 * on-topic (focused) fact to rank 1 — better MRR, same recall. And the honest
 * boundary: with the LOCAL embedder a true synonym stays unreachable (recall
 * unchanged); only an INJECTED real embedder bridges it — proving the M4 seam.
 */

import type { Embedder } from '../src/index.js'
import { describe, expect, it } from 'vitest'

import { buildInvertedIndex, fusedRetriever, invertedIndexRetriever } from '../src/index.js'
import { entry } from './fake-memory.js'

const T = 1_700_000_000_000

describe('fusedRetriever — reranks keyword ties by focus', () => {
  it('lifts the focused gold above newer passing mentions (keyword buries it)', async () => {
    const corpus = [
      entry('gold', 'semantic', '我爱奶茶,天天喝奶茶,奶茶是我的最爱', T + 1), // focused, OLD
      entry('x1', 'semantic', '今天路过一家奶茶店', T + 40),
      entry('x2', 'semantic', '奶茶喝多了不好', T + 50),
      entry('x3', 'semantic', '楼下新开了奶茶店', T + 60),
    ]
    const index = buildInvertedIndex(corpus)

    // Keyword: all tie on substring 奶茶 → recency → gold is LAST.
    const kw = await invertedIndexRetriever(index).retrieve({ text: '奶茶', k: 5 })
    expect(kw[kw.length - 1]!.id).toBe('gold')

    // Fusion: the focused gold is lifted to rank 1.
    const fused = await fusedRetriever(index).retrieve({ text: '奶茶', k: 5 })
    expect(fused[0]!.id).toBe('gold')
    // Recall is unchanged — same candidate set, only reordered.
    expect(new Set(fused.map((e) => e.id))).toEqual(new Set(kw.map((e) => e.id)))
  })

  it('with the LOCAL embedder a true synonym stays unreachable (recall unchanged)', async () => {
    const corpus = [
      entry('gold', 'semantic', '我最爱珍珠奶茶', T + 1),
      entry('d1', 'semantic', '冰箱里有饮料', T + 30),
      entry('d2', 'semantic', '买了两瓶饮料', T + 40),
    ]
    const fused = await fusedRetriever(buildInvertedIndex(corpus)).retrieve({ text: '饮料', k: 5 })
    // 饮料 shares no term with 珍珠奶茶 → gold not surfaced by the local embedder.
    expect(fused.map((e) => e.id)).not.toContain('gold')
  })

  it('an INJECTED embedder bridges the synonym — proves the MU-M4 seam', async () => {
    const corpus = [
      entry('gold', 'semantic', '我最爱珍珠奶茶', T + 1),
      entry('d1', 'semantic', '冰箱里有饮料', T + 30),
    ]
    // A toy "semantic" embedder: 饮料 and 奶茶 map to the SAME axis (synonyms),
    // everything else to a different axis. This is what a real provider does.
    const synonymEmbedder: Embedder = async (texts) =>
      texts.map((t) => (t.includes('饮料') || t.includes('奶茶') ? [1, 0] : [0, 1]))

    const fused = await fusedRetriever(buildInvertedIndex(corpus), { embed: synonymEmbedder }).retrieve(
      { text: '饮料', k: 5 },
    )
    expect(fused.map((e) => e.id)).toContain('gold')
  })

  it('fails soft — a throwing embedder degrades to keyword ranking, never errors', async () => {
    const corpus = [
      entry('a', 'semantic', '我爱奶茶,天天喝奶茶', T + 1),
      entry('b', 'semantic', '今天喝了奶茶', T + 40),
    ]
    const boom: Embedder = async () => {
      throw new Error('embedder down')
    }
    const index = buildInvertedIndex(corpus)
    const fused = await fusedRetriever(index, { embed: boom }).retrieve({ text: '奶茶', k: 5 })
    const kw = await invertedIndexRetriever(index).retrieve({ text: '奶茶', k: 5 })
    // Same candidate set as pure keyword — the semantic arm collapsed to 0.
    expect(new Set(fused.map((e) => e.id))).toEqual(new Set(kw.map((e) => e.id)))
    expect(fused.length).toBe(2)
  })

  it('empty query → importance-then-recency over the whole index', async () => {
    const corpus = [
      entry('old', 'semantic', '旧事', T + 1),
      entry('new', 'semantic', '新事', T + 100),
    ]
    const fused = await fusedRetriever(buildInvertedIndex(corpus)).retrieve({ k: 5 })
    expect(fused[0]!.id).toBe('new') // newest first, no text
  })

  it('activeOnly drops a closed (superseded) fact', async () => {
    const corpus = [
      entry('open', 'semantic', '我现在住槟城', T + 1),
      entry('closed', 'semantic', '我以前住槟城', T + 2, { validTo: T + 5 }),
    ]
    const fused = await fusedRetriever(buildInvertedIndex(corpus), {
      activeOnly: true,
      now: () => T + 100,
    }).retrieve({ text: '槟城', k: 5 })
    expect(fused.map((e) => e.id)).toEqual(['open'])
  })
})
