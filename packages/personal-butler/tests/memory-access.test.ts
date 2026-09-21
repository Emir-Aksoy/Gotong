import { describe, expect, it } from 'vitest'
import { MemoryReadBudget } from '@gotong/personal-memory'
import { MemoryAccessToolset } from '../src/memory-access.js'
import type { MemoryNet } from '../src/memory-net.js'

const textOf = (r: { content: readonly unknown[] }) => (r.content[0] as { text: string }).text
const scope = { id: 'task', from: 'u' }

describe('progressive memory access', () => {
  it('returns scoped references, rejects changed content, and cannot read foreign IDs', async () => {
    let net: MemoryNet = { nodes: [{ id: 'knowledge:coffee.md', store: 'knowledge', text: 'coffee recipe', salience: 3 }], edges: [] }
    const fresh: boolean[] = []
    const tool = new MemoryAccessToolset({ net: async f => { fresh.push(f ?? false); return net } })
    const hit = JSON.parse(textOf(await tool.callTool('search_memory', { query: 'coffee' }))).hits[0]
    expect(hit.id).toBe('knowledge:coffee.md')
    expect(textOf(await tool.callTool('read_memory', hit))).toContain('coffee recipe')
    net = { ...net, nodes: [{ ...net.nodes[0]!, text: 'new coffee recipe' }] }
    expect((await tool.callTool('read_memory', hit)).isError).toBe(true)
    expect((await tool.callTool('read_memory', { ...hit, id: 'knowledge:../../other-user/secret' })).isError).toBe(true)
    expect(fresh.slice(1)).toEqual([true, true, true])
  })

  it('bounds long source reads, supports offsets, and deduplicates repeated slices within a task', async () => {
    const budget = new MemoryReadBudget()
    const net: MemoryNet = { nodes: [{ id: 'knowledge:coffee.md', store: 'knowledge', text: 'coffee '.repeat(2000), salience: 3 }], edges: [] }
    const tool = new MemoryAccessToolset({ net: async () => net, budget })
    await tool.runForTask(scope, async () => {
      const hit = JSON.parse(textOf(await tool.callTool('search_memory', { query: 'coffee' }))).hits[0]
      const first = textOf(await tool.callTool('read_memory', hit))
      expect(Buffer.byteLength(first)).toBeLessThanOrEqual(2000)
      expect(JSON.parse(first).nextOffset).toBeGreaterThan(0)
      expect(textOf(await tool.callTool('read_memory', hit))).toContain('already returned')
      let offset = JSON.parse(first).nextOffset
      for (let i = 0; i < 10; i++) {
        const result = await tool.callTool('read_memory', { ...hit, offset })
        const text = textOf(result)
        if (result.isError) break
        offset = JSON.parse(text).nextOffset
      }
      expect(budget.remaining()).toBeLessThan(2000)
    })
  })

  it('default search excludes expired facts but explicit history can retrieve them', async () => {
    const net: MemoryNet = { nodes: [{ id: 'memory:old', store: 'memory', text: 'Paris home', salience: 3, validTo: 10 }], edges: [] }
    const tool = new MemoryAccessToolset({ net: async () => net, now: () => 100 })
    expect(JSON.parse(textOf(await tool.callTool('search_memory', { query: 'Paris' }))).hits).toEqual([])
    expect(JSON.parse(textOf(await tool.callTool('search_memory', { query: 'Paris', history: true }))).hits).toHaveLength(1)
  })
})
