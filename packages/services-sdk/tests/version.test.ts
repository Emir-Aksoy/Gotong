import { describe, expect, it } from 'vitest'
import { majorMatches, parseMajor, SDK_MAJOR } from '../src/version.js'

describe('parseMajor', () => {
  it.each([
    ['0.1.0', 0],
    ['1.0.0', 1],
    ['1.2.3-beta.4', 1],
    ['10.99.99', 10],
  ])('%s → %i', (v, expected) => {
    expect(parseMajor(v)).toBe(expected)
  })

  it('throws on unparseable input', () => {
    expect(() => parseMajor('weird')).toThrow(/unparseable/)
  })

  it('throws on empty', () => {
    expect(() => parseMajor('')).toThrow(/unparseable/)
  })
})

describe('majorMatches', () => {
  it('matches identical major', () => {
    expect(majorMatches(`${SDK_MAJOR}.5.0`)).toBe(true)
  })

  it('rejects different major', () => {
    expect(majorMatches(`${SDK_MAJOR + 1}.0.0`)).toBe(false)
  })

  it('honors explicit host major', () => {
    expect(majorMatches('2.1.0', 2)).toBe(true)
    expect(majorMatches('2.1.0', 1)).toBe(false)
  })
})
