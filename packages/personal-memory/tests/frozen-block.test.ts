import { describe, expect, it } from 'vitest'

import { renderFrozenBlock } from '../src/index.js'
import { entry } from './fake-memory.js'

describe('renderFrozenBlock', () => {
  it('emits a stable empty block with markers when there are no entries', () => {
    const block = renderFrozenBlock([])
    expect(block).toContain('<!-- gotong:memory:begin -->')
    expect(block).toContain('<!-- gotong:memory:end -->')
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
    expect(block).toMatch(/lower-priority memories omitted/)
    expect(block).not.toContain('[e00]') // far-older dropped
  })

  it('orders by importance first, then recency (a critical old fact leads a trivial new one)', () => {
    const block = renderFrozenBlock([
      entry('trivialNew', 'semantic', 'trivial recent', 300, { importance: 1 }),
      entry('criticalOld', 'semantic', 'critical but old', 100, { importance: 5 }),
      entry('ordinaryMid', 'semantic', 'ordinary', 200), // default importance 3
    ])
    const idxCrit = block.indexOf('[criticalOld]')
    const idxMid = block.indexOf('[ordinaryMid]')
    const idxTriv = block.indexOf('[trivialNew]')
    expect(idxCrit).toBeLessThan(idxMid) // 5 > 3, despite being the oldest
    expect(idxMid).toBeLessThan(idxTriv) // 3 > 1, despite trivial being newest
  })

  it('drops the LOWEST-importance entries first under the char budget', () => {
    // One pinned OLD entry + many trivial NEW ones; budget fits ~2 lines.
    const trivial = Array.from({ length: 10 }, (_, i) =>
      entry(`t${i}`, 'semantic', 'z'.repeat(80), 2000 + i, { importance: 1 }),
    )
    const pinned = entry('pin', 'semantic', 'z'.repeat(80), 100, { importance: 5 })
    const block = renderFrozenBlock([...trivial, pinned], { maxChars: 200 })
    expect(block).toContain('[pin]') // oldest, but importance 5 → leads + survives
    expect(block).toMatch(/lower-priority/)
    expect(block).not.toContain('[t0]') // lowest priority (trivial + oldest) dropped
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

  describe('showLinks (E-M3) — opt-in, byte-stable', () => {
    const a = entry('a', 'semantic', 'likes tea', 200, { links: ['b'] })
    const b = entry('b', 'semantic', 'runs a tea shop', 100, { links: ['a'] })
    const c = entry('c', 'semantic', 'lives in KL', 150) // no links

    it('is off by default — byte-identical to no links', () => {
      const withMeta = renderFrozenBlock([a, b, c])
      const plain = renderFrozenBlock([
        entry('a', 'semantic', 'likes tea', 200),
        entry('b', 'semantic', 'runs a tea shop', 100),
        c,
      ])
      expect(withMeta).toBe(plain) // meta.links present but unrendered
    })

    it('appends a related tail for intra-block links when enabled', () => {
      const block = renderFrozenBlock([a, b, c], { showLinks: true })
      expect(block).toContain('[a] likes tea (related: b)')
      expect(block).toContain('[b] runs a tea shop (related: a)')
      expect(block).toContain('[c] lives in KL') // no links → no tail
      expect(block).not.toMatch(/\[c\][^\n]*related/)
    })

    it('shows only links whose target is in the block (no dangling refs)', () => {
      const lonelyRef = entry('a', 'semantic', 'likes tea', 200, { links: ['gone', 'b'] })
      const block = renderFrozenBlock([lonelyRef, b], { showLinks: true })
      expect(block).toContain('[a] likes tea (related: b)') // 'gone' not in block → omitted
      expect(block).not.toContain('gone')
    })

    it('is a pure function of the set under showLinks (order does not matter)', () => {
      expect(renderFrozenBlock([a, b, c], { showLinks: true })).toBe(
        renderFrozenBlock([c, b, a], { showLinks: true }),
      )
    })
  })

  describe('showProcedures (G-M2) — opt-in, byte-stable', () => {
    const proc = (id: string, name: string, ts: number, steps: string[], imp?: number) =>
      entry(id, 'semantic', name, ts, { form: 'procedure', steps, ...(imp ? { importance: imp } : {}) })

    it('is byte-identical on/off when there are no procedures present', () => {
      const facts = [
        entry('a', 'semantic', 'likes tea', 200),
        entry('b', 'semantic', 'lives in KL', 100),
      ]
      expect(renderFrozenBlock(facts, { showProcedures: true })).toBe(renderFrozenBlock(facts))
    })

    it('lifts procedures into a dedicated section with steps, out of the fact bullets', () => {
      const entries = [entry('f1', 'semantic', 'likes tea', 200), proc('p1', 'brew tea', 150, ['boil', 'steep'])]

      const off = renderFrozenBlock(entries)
      expect(off).toContain('- [p1] brew tea') // off: procedure is just a fact bullet
      expect(off).not.toContain('Things I know how to do')

      const on = renderFrozenBlock(entries, { showProcedures: true })
      expect(on).toContain('## Things I know how to do')
      expect(on).toContain('- [p1] brew tea — 1. boil; 2. steep')
      expect(on).toContain('- [f1] likes tea') // a plain fact stays a fact
      // the procedure no longer appears among the fact bullets
      const factPart = on.split('## Things I know how to do')[0]!
      expect(factPart).not.toContain('[p1]')
    })

    it('is a pure function of the set under showProcedures (order does not matter)', () => {
      const f1 = entry('f1', 'semantic', 'likes tea', 200)
      const p1 = proc('p1', 'brew tea', 150, ['boil', 'steep'])
      const p2 = proc('p2', 'pour coffee', 100, ['grind', 'pour'])
      expect(renderFrozenBlock([f1, p1, p2], { showProcedures: true })).toBe(
        renderFrozenBlock([p2, f1, p1], { showProcedures: true }),
      )
    })

    it('caps the section at maxProcedures and notes the remainder', () => {
      const procs = Array.from({ length: 5 }, (_, i) => proc(`p${i}`, `task ${i}`, 100 + i, ['x']))
      const block = renderFrozenBlock(procs, { showProcedures: true, maxProcedures: 2 })
      expect(block).toMatch(/3 more procedures omitted/)
      const shown = block.split('\n').filter((l) => l.startsWith('- [p')).length
      expect(shown).toBe(2)
    })

    it('treats a procedure with no steps as an ordinary fact (nothing to show)', () => {
      const entries = [
        entry('p0', 'semantic', 'incomplete proc', 100, { form: 'procedure' }), // no steps
        entry('f0', 'semantic', 'a fact', 200),
      ]
      const on = renderFrozenBlock(entries, { showProcedures: true })
      expect(on).not.toContain('Things I know how to do')
      expect(on).toContain('- [p0] incomplete proc') // stayed a fact bullet
      expect(on).toBe(renderFrozenBlock(entries)) // byte-identical: nothing was lifted
    })
  })

  describe('activeOnly (D-M2) — opt-in, byte-stable per session', () => {
    const cur = entry('cur', 'semantic', 'lives in Penang', 200, { validFrom: 150 })
    const old = entry('old', 'semantic', 'lived in KL', 100, { validFrom: 50, validTo: 150 })

    it('is byte-identical on/off when no entry carries validity meta (legacy data)', () => {
      const legacy = [entry('a', 'semantic', 'likes tea', 200), entry('b', 'semantic', 'in KL', 100)]
      expect(renderFrozenBlock(legacy, { activeOnly: true, now: 9_999 })).toBe(
        renderFrozenBlock(legacy),
      )
    })

    it('drops a closed time-edge, keeping current truth in the block', () => {
      const on = renderFrozenBlock([cur, old], { activeOnly: true, now: 300 })
      expect(on).toContain('[cur] lives in Penang')
      expect(on).not.toContain('[old]') // closed [50,150) at now=300 → hidden
      // off → the closed edge still shows (history stays visible without the flag)
      expect(renderFrozenBlock([cur, old])).toContain('[old] lived in KL')
    })

    it('is a no-op without `now`, even when activeOnly is set', () => {
      expect(renderFrozenBlock([cur, old], { activeOnly: true })).toBe(renderFrozenBlock([cur, old]))
    })

    it('renders the empty block when every fact is closed at `now`', () => {
      const block = renderFrozenBlock([old], { activeOnly: true, now: 300 })
      expect(block).toContain('no memories yet')
    })

    it('hides a closed entry’s links from still-visible entries (no dangling refs)', () => {
      const a = entry('a', 'semantic', 'likes tea', 200, { validFrom: 50, links: ['old'] })
      const block = renderFrozenBlock([a, old], { activeOnly: true, now: 300, showLinks: true })
      expect(block).toContain('[a] likes tea') // 'old' is closed → not in the visible set
      expect(block).not.toMatch(/\[a\][^\n]*related/)
    })

    it('is a pure function of (set, now) under activeOnly', () => {
      expect(renderFrozenBlock([cur, old], { activeOnly: true, now: 300 })).toBe(
        renderFrozenBlock([old, cur], { activeOnly: true, now: 300 }),
      )
    })
  })
})
