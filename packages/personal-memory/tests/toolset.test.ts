import { describe, expect, it } from 'vitest'

import { MemoryToolset } from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

function textOf(result: { content: ReadonlyArray<unknown> }): string {
  return (result.content[0] as { text: string }).text
}

describe('MemoryToolset', () => {
  it('advertises remember/recall/forget with LLM-safe names', () => {
    const ts = new MemoryToolset({ memory: makeFakeMemory() })
    const names = ts.listTools().map((t) => t.name)
    expect(names).toEqual(['remember', 'recall', 'forget'])
    for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it('remember → recall round-trips, defaulting to semantic kind', async () => {
    const mem = makeFakeMemory()
    const ts = new MemoryToolset({ memory: mem })

    const r = await ts.callTool('remember', { text: 'user prefers morning workouts' })
    expect(r.isError).toBeFalsy()
    expect(mem.entries.some((e) => e.kind === 'semantic' && e.text.includes('morning'))).toBe(true)

    const recall = await ts.callTool('recall', { query: 'morning' })
    expect(recall.isError).toBeFalsy()
    expect(textOf(recall)).toContain('morning workouts')
  })

  it('remember accepts an explicit writable kind', async () => {
    const mem = makeFakeMemory()
    const ts = new MemoryToolset({ memory: mem })
    await ts.callTool('remember', { text: 'logged a thing', kind: 'episodic' })
    expect(mem.entries[0]!.kind).toBe('episodic')
  })

  it('rejects a non-writable kind', async () => {
    const ts = new MemoryToolset({ memory: makeFakeMemory(), writableKinds: ['semantic'] })
    const r = await ts.callTool('remember', { text: 'x', kind: 'episodic' })
    expect(r.isError).toBe(true)
  })

  it('rejects empty / whitespace-only text', async () => {
    const ts = new MemoryToolset({ memory: makeFakeMemory() })
    const r = await ts.callTool('remember', { text: '   ' })
    expect(r.isError).toBe(true)
  })

  it('recall returns a friendly message when nothing matches', async () => {
    const ts = new MemoryToolset({ memory: makeFakeMemory() })
    const r = await ts.callTool('recall', { query: 'nope' })
    expect(textOf(r)).toContain('No matching memories')
  })

  it('forget removes an entry by id; missing id is a no-op (not an error)', async () => {
    const mem = makeFakeMemory([
      entry('keep', 'semantic', 'keep me', 100),
      entry('drop', 'semantic', 'drop me', 200),
    ])
    const ts = new MemoryToolset({ memory: mem })
    await ts.callTool('forget', { id: 'drop' })
    expect(mem.entries.map((e) => e.id)).toEqual(['keep'])

    const r = await ts.callTool('forget', { id: 'ghost' })
    expect(r.isError).toBeFalsy()
  })

  it('unknown tool → isError', async () => {
    const ts = new MemoryToolset({ memory: makeFakeMemory() })
    const r = await ts.callTool('nope', {})
    expect(r.isError).toBe(true)
  })

  it('recall clamps k to the hard cap', async () => {
    const seed = Array.from({ length: 80 }, (_, i) =>
      entry(`e${i}`, 'episodic', `note ${i}`, 1000 + i),
    )
    const ts = new MemoryToolset({ memory: makeFakeMemory(seed) })
    const r = await ts.callTool('recall', { k: 999 })
    const lines = textOf(r).split('\n')
    expect(lines.length).toBeLessThanOrEqual(50)
  })
})
