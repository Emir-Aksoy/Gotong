import { describe, expect, it } from 'vitest'
import { MemoryReadBudget, utf8Prefix } from '../src/read-budget.js'
import { MemoryToolset } from '../src/toolset.js'
import { entry, makeFakeMemory } from './fake-memory.js'

describe('shared execution-scoped memory budget', () => {
  it('bounds and deduplicates actual recall results when the native shared budget is supplied', async () => {
    const memory = makeFakeMemory(Array.from({ length: 10 }, (_, i) => entry(`e${i}`, 'semantic', 'fact '.repeat(140), i)))
    const budget = new MemoryReadBudget()
    const tool = new MemoryToolset({ memory, readBudget: budget })
    await tool.runForTask({ id: 't', from: 'u' }, async () => {
      const seen = new Set<string>()
      for (let i = 0; i < 10; i++) {
        const result = await tool.callTool('recall', {})
        const text = (result.content[0] as { text: string }).text
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2000)
        for (const match of text.matchAll(/\[(e\d+)\]/g)) {
          expect(seen.has(match[1]!)).toBe(false)
          seen.add(match[1]!)
        }
      }
      expect(seen.size).toBeGreaterThan(0)
      expect(budget.remaining()).toBeGreaterThanOrEqual(0)
      expect(budget.remaining()).toBeLessThan(2000)
    })
  })
  it('nested tool scopes share a budget; sibling tasks do not', async () => {
    const b = new MemoryReadBudget()
    await b.runForTask({ id: 'a' }, async () => {
      expect(b.consume('a'.repeat(2000), 'first')).toBe(true)
      await b.runForTask({ id: 'a' }, async () => {
        expect(b.remaining()).toBe(4000)
        expect(b.consume('x', 'first')).toBe(false)
        expect(b.consume('b'.repeat(2000))).toBe(true)
      })
      await b.runForTask({ id: 'b' }, async () => { expect(b.remaining()).toBe(6000) })
      expect(b.remaining()).toBe(2000)
      expect(b.consume('c'.repeat(2000))).toBe(true)
      expect(b.consume('d')).toBe(false)
    })
  })
  it('clips Chinese and supplementary characters at UTF-8 boundaries', () => {
    expect(utf8Prefix('记忆😀', 9)).toBe('记忆')
    expect(utf8Prefix('记忆😀', 10)).toBe('记忆😀')
  })
})
