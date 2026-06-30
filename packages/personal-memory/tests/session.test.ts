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

  // ── Fix B: D/E/G frozen-block options must reach the renderer ──────────────
  // The renderer already supported activeOnly / showLinks / showProcedures; the
  // gap was that MemorySession never threaded them. These pin that they now do.

  it('activeOnly + now drop closed bitemporal facts from the block (D)', async () => {
    const mem = makeFakeMemory([
      entry('live', 'semantic', '现住槟城', 200, { validFrom: 100 }),
      entry('past', 'semantic', '曾住吉隆坡', 100, { validFrom: 0, validTo: 150 }),
    ])
    // now = 300: the KL edge is closed (validTo 150 ≤ 300), Penang is live.
    const s = new MemorySession({ memory: mem, activeOnly: true, now: 300 })
    const block = await s.ensureFrozenBlock()
    expect(block).toContain('槟城')
    expect(block).not.toContain('吉隆坡') // closed edge filtered out of the block

    // Off (default) → both show, proving the option is what dropped it.
    const flat = await new MemorySession({ memory: mem }).ensureFrozenBlock()
    expect(flat).toContain('吉隆坡')
  })

  it('showLinks appends intra-block (related: …) tails (E)', async () => {
    const mem = makeFakeMemory([
      entry('p', 'semantic', '在做奶茶店项目', 200, { links: ['s'] }),
      entry('s', 'semantic', '供货商是城南批发', 100, { links: ['p'] }),
    ])
    const block = await new MemorySession({ memory: mem, showLinks: true }).ensureFrozenBlock()
    expect(block).toContain('(related: s)')
    expect(block).toContain('(related: p)')
    // Off → no tails.
    const off = await new MemorySession({ memory: mem }).ensureFrozenBlock()
    expect(off).not.toContain('related:')
  })

  it('showProcedures lifts how-tos into their own section (G)', async () => {
    const mem = makeFakeMemory([
      entry('fact', 'semantic', '主人爱喝奶茶', 200),
      entry('how', 'semantic', '给加班费定金额', 100, { form: 'procedure', steps: ['查日别倍率', '乘工时'] }),
    ])
    const block = await new MemorySession({ memory: mem, showProcedures: true }).ensureFrozenBlock()
    expect(block).toContain('Things I know how to do')
    expect(block).toContain('查日别倍率')
    // Off → the procedure stays an ordinary fact bullet, no section heading.
    const off = await new MemorySession({ memory: mem }).ensureFrozenBlock()
    expect(off).not.toContain('Things I know how to do')
  })

  it('activeOnly without a supplied now samples a frozen now once (still byte-stable)', async () => {
    // No `now` → constructor samples Date.now(). Legacy data has no validity meta
    // so it is always active → the block is identical to the off path, and stable
    // across calls (the sampled now is pinned).
    const mem = makeFakeMemory([entry('a', 'semantic', 'plain fact', 100)])
    const s = new MemorySession({ memory: mem, activeOnly: true })
    const first = await s.ensureFrozenBlock()
    const second = await s.ensureFrozenBlock()
    expect(second).toBe(first) // pinned now → no drift
    expect(first).toContain('plain fact')
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
