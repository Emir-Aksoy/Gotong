/**
 * lexicalRetriever — the Chinese-aware default `recall` backend (C-M2).
 *
 * The headline claim: it finds a non-contiguous Chinese match that the
 * substring-backed `handleRetriever` cannot, because it pulls candidates by
 * recency (NOT handing `text` to the backend's substring filter) and ranks them
 * by CJK-bigram / Latin-token overlap. Importance/recency only break ties.
 */

import { describe, expect, it } from 'vitest'

import { handleRetriever, lexicalRetriever, MemoryToolset } from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

function recallText(out: { content: ReadonlyArray<unknown> }): string {
  return (out.content[0] as { text: string }).text
}

describe('lexicalRetriever', () => {
  it('THE point: finds a non-contiguous Chinese match the substring retriever misses', async () => {
    const mem = makeFakeMemory([
      entry('e1', 'semantic', '我开了家卖奶茶的小店', 100),
      entry('e2', 'semantic', '今天天气不错', 200),
    ])
    // lexical: bigram 奶茶 overlaps e1, nothing in e2 → only e1.
    const lex = await lexicalRetriever(mem).retrieve({ text: '奶茶店', k: 5 })
    expect(lex.map((e) => e.id)).toEqual(['e1'])
    // substring backend: 「奶茶店」 is not contiguous in either → returns nothing.
    const sub = await handleRetriever(mem).retrieve({ text: '奶茶店', k: 5 })
    expect(sub).toHaveLength(0)
  })

  it('ranks a full-phrase hit above a partial bigram overlap, beating recency', async () => {
    const mem = makeFakeMemory([
      entry('exact', 'semantic', '我家附近有奶茶店', 100), // substring hit → 1
      entry('partial', 'semantic', '卖奶茶的店', 200), // newer, but only 奶茶 bigram → 0.5
    ])
    const r = await lexicalRetriever(mem).retrieve({ text: '奶茶店', k: 5 })
    expect(r[0]!.id).toBe('exact') // relevance outranks the newer partial
    expect(r.map((e) => e.id)).toContain('partial')
  })

  it('with no query text, returns importance-then-recency (same as the substring default)', async () => {
    const mem = makeFakeMemory([
      entry('old', 'semantic', 'a', 100),
      entry('new', 'semantic', 'b', 200),
      entry('vip', 'semantic', 'c', 50, { importance: 5 }),
    ])
    const r = await lexicalRetriever(mem).retrieve({ k: 5 })
    expect(r.map((e) => e.id)).toEqual(['vip', 'new', 'old']) // importance 5 leads despite oldest
  })

  it('drops zero-relevance candidates when a query is present (still narrows)', async () => {
    const mem = makeFakeMemory([
      entry('hit', 'semantic', '我爱奶茶', 100),
      entry('miss', 'semantic', '我爱篮球', 200),
    ])
    const r = await lexicalRetriever(mem).retrieve({ text: '奶茶', k: 5 })
    expect(r.map((e) => e.id)).toEqual(['hit'])
  })

  it('passes kinds / since through to the backend recency window', async () => {
    const mem = makeFakeMemory([
      entry('sem', 'semantic', '奶茶', 100),
      entry('epi', 'episodic', '奶茶', 200),
    ])
    const r = await lexicalRetriever(mem).retrieve({ text: '奶茶', kinds: ['semantic'], k: 5 })
    expect(r.map((e) => e.id)).toEqual(['sem'])
  })

  it('MemoryToolset now defaults to lexical recall — Chinese works with no injection', async () => {
    const mem = makeFakeMemory([entry('e1', 'semantic', '我开了家卖奶茶的小店', 100)])
    const ts = new MemoryToolset({ memory: mem })
    const out = await ts.callTool('recall', { query: '奶茶店' })
    expect(out.isError).toBeUndefined()
    expect(recallText(out)).toContain('卖奶茶的小店')
  })
})
