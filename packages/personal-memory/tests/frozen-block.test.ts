import { describe, expect, it } from 'vitest'

import { renderFrozenBlock } from '../src/index.js'
import { entry } from './fake-memory.js'

describe('renderFrozenBlock', () => {
  it('emits a stable empty block with markers when there are no entries', () => {
    const block = renderFrozenBlock([])
    expect(block).toContain('<!-- aipehub:memory:begin -->')
    expect(block).toContain('<!-- aipehub:memory:end -->')
    expect(block).toContain('no memories yet')
    // Deterministic across calls.
    expect(renderFrozenBlock([])).toBe(block)
  })

  it('is a pure function of the entry SET — input order does not matter', () => {
    const a = entry('a', 'semantic', 'likes tea', 100)
    const b = entry('b', 'semantic', 'lives in KL', 200)
    const c = entry('c', 'semantic', 'prefers morning', 150)
    const one = renderFrozenBlock([a, b, c])
    const two = renderFrozenBlock([c, a, b]) // shuffled
    expect(two).toBe(one)
  })

  it('orders newest-first and includes ids (so the model can forget them)', () => {
    const block = renderFrozenBlock([
      entry('old', 'semantic', 'old fact', 100),
      entry('new', 'semantic', 'new fact', 300),
      entry('mid', 'semantic', 'mid fact', 200),
    ])
    const idxNew = block.indexOf('[new]')
    const idxMid = block.indexOf('[mid]')
    const idxOld = block.indexOf('[old]')
    expect(idxNew).toBeGreaterThan(-1)
    expect(idxNew).toBeLessThan(idxMid)
    expect(idxMid).toBeLessThan(idxOld)
  })

  it('breaks ties on id so equal-ts entries render deterministically', () => {
    const x = renderFrozenBlock([
      entry('zzz', 'semantic', 'z', 100),
      entry('aaa', 'semantic', 'a', 100),
    ])
    const y = renderFrozenBlock([
      entry('aaa', 'semantic', 'a', 100),
      entry('zzz', 'semantic', 'z', 100),
    ])
    expect(x).toBe(y)
    expect(x.indexOf('[aaa]')).toBeLessThan(x.indexOf('[zzz]'))
  })

  it('collapses newlines so one entry is exactly one bullet', () => {
    const block = renderFrozenBlock([entry('a', 'semantic', 'line one\n  line two', 100)])
    expect(block).toContain('[a] line one line two')
    expect(block.split('\n').filter((l) => l.startsWith('- [a]')).length).toBe(1)
  })

  it('respects the soft char cap, always keeps the newest, notes the omitted', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      entry(`e${String(i).padStart(2, '0')}`, 'semantic', 'x'.repeat(100), 1000 + i),
    )
    const block = renderFrozenBlock(many, { maxChars: 400 })
    expect(block).toContain('[e49]') // newest present
    expect(block).toMatch(/older memories omitted/)
    expect(block).not.toContain('[e00]') // far-older dropped
  })

  it('always includes the newest entry even if it alone exceeds the cap', () => {
    const block = renderFrozenBlock([entry('big', 'semantic', 'y'.repeat(5000), 100)], {
      maxChars: 50,
    })
    expect(block).toContain('[big]')
  })

  it('puts the label in the heading', () => {
    expect(renderFrozenBlock([], { label: 'butler-zh' })).toContain('Long-term memory — butler-zh')
  })
})
