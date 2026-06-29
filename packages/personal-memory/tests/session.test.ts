import { describe, expect, it } from 'vitest'

import { MemorySession } from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

describe('MemorySession', () => {
  it('frozenBlockSync is empty until ensureFrozenBlock resolves', async () => {
    const mem = makeFakeMemory([entry('a', 'semantic', 'likes tea', 100)])
    const s = new MemorySession({ memory: mem })
    expect(s.frozenBlockSync()).toBe('')
    expect(s.isReady).toBe(false)

    const block = await s.ensureFrozenBlock()
    expect(s.isReady).toBe(true)
    expect(s.frozenBlockSync()).toBe(block)
    expect(block).toContain('likes tea')
  })

  it('seeds the frozen block from semantic memory only (episodic excluded)', async () => {
    const mem = makeFakeMemory([
      entry('s', 'semantic', 'durable fact', 200),
      entry('e', 'episodic', 'what happened', 100),
    ])
    const s = new MemorySession({ memory: mem })
    const block = await s.ensureFrozenBlock()
    expect(block).toContain('durable fact')
    expect(block).not.toContain('what happened')
  })

  it('computes the block exactly once per session (memoized)', async () => {
    const mem = makeFakeMemory([entry('a', 'semantic', 'x', 100)])
    const s = new MemorySession({ memory: mem })
    await s.ensureFrozenBlock()
    await s.ensureFrozenBlock()
    await s.ensureFrozenBlock()
    expect(mem.recallCount).toBe(1)
  })

  it('does not double-recall under concurrent first calls', async () => {
    const mem = makeFakeMemory([entry('a', 'semantic', 'x', 100)])
    const s = new MemorySession({ memory: mem })
    await Promise.all([s.ensureFrozenBlock(), s.ensureFrozenBlock(), s.ensureFrozenBlock()])
    expect(mem.recallCount).toBe(1)
  })

  it('stays frozen when memory changes mid-session; a NEW session picks it up', async () => {
    const mem = makeFakeMemory([entry('a', 'semantic', 'first fact', 100)])
    const s1 = new MemorySession({ memory: mem })
    const before = await s1.ensureFrozenBlock()

    // Write a new durable fact mid-session.
    await mem.remember({ kind: 'semantic', text: 'second fact' })

    // Same session — byte-identical, no leak of the new fact.
    const after = await s1.ensureFrozenBlock()
    expect(after).toBe(before)
    expect(after).not.toContain('second fact')

    // Next session — re-recalls and includes it alongside the first.
    const s2 = new MemorySession({ memory: mem })
    const next = await s2.ensureFrozenBlock()
    expect(next).toContain('second fact')
    expect(next).toContain('first fact')
  })
})
