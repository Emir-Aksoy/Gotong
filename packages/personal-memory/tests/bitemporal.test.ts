import { describe, expect, it } from 'vitest'

import {
  closedMeta,
  isActive,
  isClosed,
  isExpired,
  openedMeta,
  supersedesOf,
  validFromOf,
  validToOf,
} from '../src/index.js'
import { entry } from './fake-memory.js'

const at = (meta: Record<string, unknown>) => entry('e', 'semantic', 'fact', 100, meta)

describe('bitemporal accessors (D-M1)', () => {
  describe('validFromOf / validToOf / supersedesOf', () => {
    it('reads finite-number stamps, undefined otherwise', () => {
      expect(validFromOf(at({ validFrom: 500 }))).toBe(500)
      expect(validToOf(at({ validTo: 900 }))).toBe(900)
      expect(validFromOf(at({}))).toBeUndefined()
      expect(validToOf(entry('e', 'semantic', 'x', 1))).toBeUndefined()
      // non-finite / non-number → undefined (no crash)
      expect(validFromOf(at({ validFrom: 'soon' as unknown as number }))).toBeUndefined()
      expect(validToOf(at({ validTo: Number.NaN }))).toBeUndefined()
    })

    it('reads a non-empty supersedes id, undefined otherwise', () => {
      expect(supersedesOf(at({ supersedes: 's1' }))).toBe('s1')
      expect(supersedesOf(at({ supersedes: '' }))).toBeUndefined()
      expect(supersedesOf(at({}))).toBeUndefined()
    })
  })

  describe('isClosed', () => {
    it('is true exactly when a validTo is stamped', () => {
      expect(isClosed(at({ validTo: 900 }))).toBe(true)
      expect(isClosed(at({ validFrom: 100 }))).toBe(false)
      expect(isClosed(at({}))).toBe(false)
    })
  })

  describe('isActive', () => {
    it('an entry with no validity meta is ALWAYS active (legacy data unaffected)', () => {
      const legacy = entry('e', 'semantic', 'x', 1)
      expect(isActive(legacy, 0)).toBe(true)
      expect(isActive(legacy, 9_999_999)).toBe(true)
    })

    it('validFrom gates the lower bound (inclusive)', () => {
      const e = at({ validFrom: 500 })
      expect(isActive(e, 499)).toBe(false) // not yet in effect
      expect(isActive(e, 500)).toBe(true) // boundary is inclusive
      expect(isActive(e, 600)).toBe(true)
    })

    it('validTo gates the upper bound (exclusive)', () => {
      const e = at({ validTo: 900 })
      expect(isActive(e, 899)).toBe(true)
      expect(isActive(e, 900)).toBe(false) // closed at validTo
      expect(isActive(e, 901)).toBe(false)
    })

    it('a closed interval [from, to) is active only inside it', () => {
      const e = at({ validFrom: 500, validTo: 900 })
      expect(isActive(e, 400)).toBe(false)
      expect(isActive(e, 500)).toBe(true)
      expect(isActive(e, 700)).toBe(true)
      expect(isActive(e, 900)).toBe(false)
    })
  })

  describe('isExpired (D-M3)', () => {
    it('is true only for a closed interval whose validTo has passed', () => {
      expect(isExpired(at({ validTo: 900 }), 900)).toBe(true) // at the bound (half-open)
      expect(isExpired(at({ validTo: 900 }), 1000)).toBe(true)
      expect(isExpired(at({ validTo: 900 }), 800)).toBe(false) // still open
    })

    it('is false with no validTo, however far in the future `now` is', () => {
      expect(isExpired(at({}), 9_999_999)).toBe(false)
      expect(isExpired(entry('e', 'semantic', 'x', 1), 9_999_999)).toBe(false)
    })

    it('a not-yet-valid future fact is inactive but NOT expired', () => {
      const future = at({ validFrom: 5000 }) // no validTo
      expect(isActive(future, 300)).toBe(false) // not in effect yet
      expect(isExpired(future, 300)).toBe(false) // but not dead history either
    })
  })

  describe('openedMeta / closedMeta', () => {
    it('openedMeta stamps validFrom and an optional supersedes, preserving base', () => {
      expect(openedMeta({ user: 'alice', importance: 3 }, 500)).toEqual({
        user: 'alice',
        importance: 3,
        validFrom: 500,
      })
      expect(openedMeta({ user: 'alice' }, 500, 's1')).toEqual({
        user: 'alice',
        validFrom: 500,
        supersedes: 's1',
      })
      // empty supersedes is omitted (not stamped)
      expect(openedMeta(undefined, 500, '')).toEqual({ validFrom: 500 })
    })

    it('closedMeta stamps validTo, preserving base', () => {
      expect(closedMeta({ user: 'bob', validFrom: 100 }, 900)).toEqual({
        user: 'bob',
        validFrom: 100,
        validTo: 900,
      })
      expect(closedMeta(undefined, 900)).toEqual({ validTo: 900 })
    })

    it('are pure — they do not mutate the input meta', () => {
      const base = { user: 'alice' }
      openedMeta(base, 1)
      closedMeta(base, 2)
      expect(base).toEqual({ user: 'alice' })
    })
  })
})
