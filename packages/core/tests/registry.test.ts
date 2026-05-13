import { describe, expect, it, vi } from 'vitest'

import { Registry } from '../src/registry.js'
import type { Participant } from '../src/types.js'

function makeAgent(id: string, capabilities: readonly string[] = []): Participant {
  return {
    id,
    kind: 'agent',
    capabilities,
  }
}

describe('Registry', () => {
  it('throws when registering the same id twice', () => {
    const r = new Registry()
    r.register(makeAgent('a'))
    expect(() => r.register(makeAgent('a'))).toThrow(/already registered/)
  })

  it('unregister returns the original participant and get returns undefined afterwards', () => {
    const r = new Registry()
    const p = makeAgent('a')
    r.register(p)
    expect(r.unregister('a')).toBe(p)
    expect(r.get('a')).toBeUndefined()
    expect(r.unregister('a')).toBeUndefined()
  })

  it("byCapabilities(['a','b']) only returns participants covering both", () => {
    const r = new Registry()
    const both = makeAgent('both', ['a', 'b'])
    const onlyA = makeAgent('a-only', ['a'])
    const onlyB = makeAgent('b-only', ['b'])
    const extra = makeAgent('extra', ['a', 'b', 'c'])
    r.register(both)
    r.register(onlyA)
    r.register(onlyB)
    r.register(extra)

    const found = r.byCapabilities(['a', 'b'])
    expect(found.map((p) => p.id).sort()).toEqual(['both', 'extra'])
  })

  it('byCapabilities([]) returns all participants', () => {
    const r = new Registry()
    r.register(makeAgent('a', ['x']))
    r.register(makeAgent('b'))
    r.register(makeAgent('c', ['y', 'z']))
    expect(r.byCapabilities([]).map((p) => p.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('incLoad and decLoad behave correctly; decLoad floors at 0', () => {
    const r = new Registry()
    r.register(makeAgent('a'))
    expect(r.loadOf('a')).toBe(0)
    r.incLoad('a')
    r.incLoad('a')
    expect(r.loadOf('a')).toBe(2)
    r.decLoad('a')
    expect(r.loadOf('a')).toBe(1)
    r.decLoad('a')
    r.decLoad('a')
    r.decLoad('a')
    expect(r.loadOf('a')).toBe(0)
  })

  it('onJoin and onLeave fire on the right events; unsubscribe stops them', () => {
    const r = new Registry()
    const joinHandler = vi.fn()
    const leaveHandler = vi.fn()
    const offJoin = r.onJoin(joinHandler)
    const offLeave = r.onLeave(leaveHandler)

    const p = makeAgent('a')
    r.register(p)
    expect(joinHandler).toHaveBeenCalledTimes(1)
    expect(joinHandler).toHaveBeenCalledWith(p)
    expect(leaveHandler).not.toHaveBeenCalled()

    r.unregister('a')
    expect(leaveHandler).toHaveBeenCalledTimes(1)
    expect(leaveHandler).toHaveBeenCalledWith('a')

    offJoin()
    offLeave()

    r.register(makeAgent('b'))
    r.unregister('b')
    expect(joinHandler).toHaveBeenCalledTimes(1)
    expect(leaveHandler).toHaveBeenCalledTimes(1)
  })
})
