import { describe, expect, it } from 'vitest'

import {
  clampImportance,
  compareByImportanceThenRecency,
  DEFAULT_IMPORTANCE,
  importanceOf,
  PIN_IMPORTANCE,
} from '../src/index.js'
import { entry } from './fake-memory.js'

describe('importance', () => {
  it('clampImportance rounds + clamps numbers into 1..5', () => {
    expect(clampImportance(3)).toBe(3)
    expect(clampImportance(0)).toBe(1)
    expect(clampImportance(99)).toBe(5)
    expect(clampImportance(3.7)).toBe(4)
    expect(clampImportance(-2)).toBe(1)
  })

  it('clampImportance accepts numeric strings and known words, else defaults', () => {
    expect(clampImportance('4')).toBe(4)
    expect(clampImportance('high')).toBe(4)
    expect(clampImportance('critical')).toBe(PIN_IMPORTANCE)
    expect(clampImportance('low')).toBe(2)
    expect(clampImportance('garbage')).toBe(DEFAULT_IMPORTANCE)
    expect(clampImportance('')).toBe(DEFAULT_IMPORTANCE)
    expect(clampImportance(undefined)).toBe(DEFAULT_IMPORTANCE)
    expect(clampImportance(null)).toBe(DEFAULT_IMPORTANCE)
    expect(clampImportance(NaN)).toBe(DEFAULT_IMPORTANCE)
  })

  it('importanceOf defaults a meta-less entry to mid', () => {
    expect(importanceOf(entry('a', 'semantic', 'x', 100))).toBe(DEFAULT_IMPORTANCE)
    expect(importanceOf(entry('b', 'semantic', 'x', 100, { importance: 5 }))).toBe(5)
    expect(importanceOf(entry('c', 'semantic', 'x', 100, { importance: 'high' }))).toBe(4)
  })

  it('compareByImportanceThenRecency: importance desc, then ts desc, then id asc', () => {
    const hi = entry('hi', 'semantic', 'x', 100, { importance: 5 })
    const loNew = entry('loNew', 'semantic', 'x', 999, { importance: 1 })
    const midA = entry('a', 'semantic', 'x', 200) // default 3
    const midB = entry('b', 'semantic', 'x', 200) // default 3, same ts as midA
    const sorted = [loNew, midB, hi, midA].sort(compareByImportanceThenRecency)
    expect(sorted.map((e) => e.id)).toEqual(['hi', 'a', 'b', 'loNew'])
  })

  it('is a pure total order — sorting is independent of input order', () => {
    const xs = [
      entry('p', 'semantic', 'x', 100, { importance: 5 }),
      entry('q', 'semantic', 'x', 300, { importance: 3 }),
      entry('r', 'semantic', 'x', 200, { importance: 3 }),
    ]
    const a = [...xs].sort(compareByImportanceThenRecency).map((e) => e.id)
    const b = [...xs].reverse().sort(compareByImportanceThenRecency).map((e) => e.id)
    expect(a).toEqual(b)
    expect(a).toEqual(['p', 'q', 'r'])
  })
})
