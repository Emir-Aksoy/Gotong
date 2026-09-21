import { describe, expect, it } from 'vitest'
import { MemoryToolset } from '../src/toolset.js'
import { evidenceSources } from '../src/evidence.js'
import { entry, makeFakeMemory } from './fake-memory.js'

describe('trusted user evidence for durable writes', () => {
  it('rejects assistant inventions and self-declared confirmation', async () => {
    const memory = makeFakeMemory()
    const tool = new MemoryToolset({ memory, requireUserEvidence: true })
    const result = await tool.callTool('remember', { text: 'invented fact', confirmed: true })
    expect(result.isError).toBe(true)
    expect(memory.entries).toHaveLength(0)
  })

  it('keeps a whole trusted user quote, never a model paraphrase', async () => {
    const memory = makeFakeMemory()
    const tool = new MemoryToolset({ memory, requireUserEvidence: true })
    await tool.withUserEvidence([{ sourceId: 'turn-1', text: 'I do not live in Paris', scope: 'u' }], async () => {
      expect((await tool.callTool('remember', { text: 'I live in Paris' })).isError).toBe(true)
      expect((await tool.callTool('remember', { text: 'I do not live in Paris' })).isError).not.toBe(true)
    })
    expect(evidenceSources(memory.entries[0]!)).toEqual([{ sourceId: 'turn-1', text: 'I do not live in Paris', scope: 'u' }])
  })

  it('does not accept an old assistant-only entry as a semantic source', async () => {
    const source = entry('assistant', 'episodic', 'Butler: invented fact', 1)
    const memory = makeFakeMemory([source])
    const tool = new MemoryToolset({ memory, requireUserEvidence: true, evidenceLookup: async () => [source] })
    expect((await tool.callTool('remember', { text: 'invented fact', sources: ['assistant'] })).isError).toBe(true)
    expect(memory.entries).toHaveLength(1)
  })

  it('cannot resurrect expired evidence as a new current fact', async () => {
    const source = entry('old', 'episodic', 'User: I live in Paris', 1, {
      userSpan: { v: 1, start: 6, end: 21 }, validTo: 2,
    })
    const memory = makeFakeMemory([source])
    const tool = new MemoryToolset({ memory, requireUserEvidence: true, now: () => 100, evidenceLookup: async () => [source] })
    expect((await tool.callTool('remember', { text: 'I live in Paris', sources: ['old'] })).isError).toBe(true)
    expect(memory.entries).toHaveLength(1)
  })
})
