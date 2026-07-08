/**
 * local-embedder — the dependency-free TF embedder (MU-M2).
 *
 * The claims that matter for fusion: it is DETERMINISTIC (byte-stable scores),
 * FREQUENCY-aware (a text that repeats a term leans toward it), and — the honest
 * ceiling — ORTHOGONAL on true synonyms (shares no term ⇒ cosine 0), which is
 * exactly why local fusion cannot bridge 「饮料」→「奶茶」 and MU-M4 must inject a
 * real provider.
 */

import { describe, expect, it } from 'vitest'

import { cosineSimilarity, localBigramEmbedder } from '../src/index.js'

describe('localBigramEmbedder', () => {
  it('is deterministic — same batch → identical vectors', async () => {
    const embed = localBigramEmbedder()
    const a = await embed(['我喜欢喝奶茶', '今天天气很好'])
    const b = await embed(['我喜欢喝奶茶', '今天天气很好'])
    expect(a).toEqual(b)
  })

  it('emits L2-normalized vectors (unit length for non-empty text)', async () => {
    const [v] = await localBigramEmbedder()(['我喜欢喝奶茶'])
    const norm = Math.sqrt(v!.reduce((s, x) => s + x * x, 0))
    expect(norm).toBeCloseTo(1, 10)
  })

  it('is frequency-aware — a focused text scores higher on its term', async () => {
    // Query 「奶茶」 vs a focused doc (奶茶 ×3) and a passing mention (奶茶 ×1).
    const embed = localBigramEmbedder()
    const [q, focused, passing] = await embed([
      '奶茶',
      '我爱奶茶,天天喝奶茶,奶茶最好',
      '今天路过一家奶茶店',
    ])
    const sFocused = cosineSimilarity(q!, focused!)
    const sPassing = cosineSimilarity(q!, passing!)
    expect(sFocused).toBeGreaterThan(sPassing)
  })

  it('is ORTHOGONAL on a true synonym (no shared term → cosine 0) — the honest ceiling', async () => {
    const embed = localBigramEmbedder()
    const [q, gold] = await embed(['饮料', '珍珠奶茶'])
    expect(cosineSimilarity(q!, gold!)).toBe(0)
  })

  it('shares signal when texts share a term', async () => {
    const embed = localBigramEmbedder()
    const [q, doc] = await embed(['奶茶', '我开了一家卖奶茶的店'])
    expect(cosineSimilarity(q!, doc!)).toBeGreaterThan(0)
  })

  it('empty / term-less text → zero vector (no false match)', async () => {
    const embed = localBigramEmbedder()
    const [q, empty] = await embed(['奶茶', '、。!'])
    expect(cosineSimilarity(q!, empty!)).toBe(0)
  })
})
