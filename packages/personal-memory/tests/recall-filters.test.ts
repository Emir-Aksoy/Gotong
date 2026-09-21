import { describe, expect, it } from 'vitest'
import { buildInvertedIndex, invertedIndexRetriever } from '../src/inverted-index.js'
import { fusedRetriever } from '../src/fusion-retriever.js'
import { MemoryToolset } from '../src/toolset.js'
import { entry, makeFakeMemory } from './fake-memory.js'

describe('recall filters before ranking', () => {
  for (const build of [invertedIndexRetriever, fusedRetriever]) {
    it(`${build.name}: a lower ranked matching tier survives k=1`, async () => {
      const entries = [
        entry('wrong', 'semantic', 'project', 2, { tier: 'projects', importance: 5 }),
        entry('right', 'semantic', 'project colleague', 1, { tier: 'people' }),
      ]
      const tool = new MemoryToolset({ memory: makeFakeMemory(entries), retriever: build(buildInvertedIndex(entries)) })
      const result = JSON.stringify(await tool.callTool('recall', { query: 'project', tier: 'people', k: 1 }))
      expect(result).toContain('[right]')
      expect(result).not.toContain('[wrong]')
    })
  }

  it('does not leak expired or wrong-tier neighbors', async () => {
    const entries = [entry('seed', 'semantic', 'project', 1, { tier: 'people', links: ['old', 'other'] })]
    const tool = new MemoryToolset({ memory: makeFakeMemory(entries), now: () => 100,
      linkLookup: async () => [
        entry('old', 'semantic', 'old project', 1, { tier: 'people', validTo: 2 }),
        entry('other', 'semantic', 'other project', 1, { tier: 'projects' }),
      ],
    })
    const result = JSON.stringify(await tool.callTool('recall', { query: 'project', tier: 'people' }))
    expect(result).toContain('[seed]')
    expect(result).not.toContain('[old]')
    expect(result).not.toContain('[other]')
  })
})
