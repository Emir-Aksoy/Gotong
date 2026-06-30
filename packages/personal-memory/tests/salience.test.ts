/**
 * salience — decay / reinforcement keep-value (F-M1).
 *
 * The two anchors:
 *   1. OFF by default — with no clock/options, effectiveSalience IS importance,
 *      so the budget comparator (F-M2) is byte-identical until a host opts in.
 *   2. ON — a low-importance long-unrecalled entry fades; a reinforced one
 *      strengthens; a pin never fades.
 */

import { describe, expect, it } from 'vitest'

import type { MemoryEntry } from '@aipehub/services-sdk'

import {
  DEFAULT_REINFORCE_WEIGHT,
  effectiveSalience,
  lastRecalledOf,
  META_LAST_RECALLED,
  META_RECALL_COUNT,
  recallCountOf,
  reinforcedMeta,
} from '../src/index.js'

function e(id: string, ts: number, meta?: Record<string, unknown>): MemoryEntry {
  return { id, kind: 'semantic', text: id, ts, ...(meta ? { meta } : {}) }
}

const DAY = 24 * 60 * 60 * 1000

describe('effectiveSalience — OFF by default (pre-F ordering preserved)', () => {
  it('with no now/opts, returns importanceOf (integer 1..5)', () => {
    expect(effectiveSalience(e('a', 100))).toBe(3) // default importance
    expect(effectiveSalience(e('b', 100, { importance: 5 }))).toBe(5)
    expect(effectiveSalience(e('c', 100, { importance: 1 }))).toBe(1)
  })

  it('with a clock but no decay/reinforce options, still returns importance', () => {
    const now = 10 * DAY
    expect(effectiveSalience(e('a', 0, { importance: 4 }), now)).toBe(4)
  })

  it('ordering by salience (off) matches importance, ties go to caller (no recency here)', () => {
    const rows = [e('lo', 300, { importance: 1 }), e('hi', 100, { importance: 5 }), e('mid', 200)]
    const sorted = [...rows].sort((a, b) => effectiveSalience(b) - effectiveSalience(a))
    expect(sorted.map((r) => r.id)).toEqual(['hi', 'mid', 'lo']) // 5, 3, 1
  })
})

describe('effectiveSalience — decay ON', () => {
  const opts = { halfLifeMs: 30 * DAY }

  it('a fresh entry keeps ~full importance; an old one decays toward 0', () => {
    const now = 60 * DAY
    const fresh = effectiveSalience(e('f', 60 * DAY, { importance: 3 }), now, opts)
    const old = effectiveSalience(e('o', 0, { importance: 3 }), now, opts)
    expect(fresh).toBeCloseTo(3) // age 0 → factor 1
    expect(old).toBeCloseTo(3 * 0.25) // 60d = 2 half-lives → 0.25
    expect(old).toBeLessThan(fresh)
  })

  it('a low-importance long-unrecalled entry fades below a fresh trivial one', () => {
    const now = 120 * DAY
    const staleLow = effectiveSalience(e('stale', 0, { importance: 2 }), now, opts) // 4 half-lives
    const freshLow = effectiveSalience(e('fresh', 120 * DAY, { importance: 1 }), now, opts)
    expect(staleLow).toBeLessThan(freshLow) // decay can invert importance — the point of F
  })

  it('pins (importance 5) never fade', () => {
    const now = 365 * DAY
    const pinOld = effectiveSalience(e('pin', 0, { importance: 5 }), now, opts)
    expect(pinOld).toBeCloseTo(5) // a year old, still full keep-value
  })

  it('uses lastRecalledTs over ts when present (a recall refreshes recency)', () => {
    const now = 60 * DAY
    const recalled = e('r', 0, { importance: 3, [META_LAST_RECALLED]: 60 * DAY })
    expect(effectiveSalience(recalled, now, opts)).toBeCloseTo(3) // recalled today → fresh
  })

  it('treats a future timestamp as age 0 (no negative decay)', () => {
    const now = 0
    expect(effectiveSalience(e('future', 100 * DAY, { importance: 3 }), now, opts)).toBeCloseTo(3)
  })
})

describe('effectiveSalience — reinforcement ON', () => {
  const opts = { reinforceWeight: DEFAULT_REINFORCE_WEIGHT }

  it('more recalls → strictly higher keep-value', () => {
    const none = effectiveSalience(e('a', 100, { importance: 3 }), 100, opts)
    const some = effectiveSalience(e('b', 100, { importance: 3, [META_RECALL_COUNT]: 3 }), 100, opts)
    const many = effectiveSalience(e('c', 100, { importance: 3, [META_RECALL_COUNT]: 15 }), 100, opts)
    expect(none).toBe(3) // recallCount 0 → factor 1 → importance
    expect(some).toBeGreaterThan(none)
    expect(many).toBeGreaterThan(some)
  })

  it('reinforcement still lifts a pin (only ever raises keep-value)', () => {
    const plain = effectiveSalience(e('p', 100, { importance: 5 }), 100, opts)
    const hot = effectiveSalience(e('q', 100, { importance: 5, [META_RECALL_COUNT]: 8 }), 100, opts)
    expect(hot).toBeGreaterThan(plain)
  })
})

describe('meta readers + reinforcedMeta', () => {
  it('recallCountOf / lastRecalledOf read or default', () => {
    expect(recallCountOf(e('a', 0))).toBe(0)
    expect(recallCountOf(e('a', 0, { recallCount: 4 }))).toBe(4)
    expect(recallCountOf(e('a', 0, { recallCount: -2 }))).toBe(0) // garbage → 0
    expect(lastRecalledOf(e('a', 0))).toBeUndefined()
    expect(lastRecalledOf(e('a', 0, { lastRecalledTs: 1234 }))).toBe(1234)
  })

  it('reinforcedMeta returns a 2-key delta (count + time), no other keys, no mutation', () => {
    const src = e('a', 0, { importance: 4, recallCount: 2, foo: 'bar' })
    const next = reinforcedMeta(src, 9999)
    expect(next[META_RECALL_COUNT]).toBe(3) // bumped off the entry's prior count
    expect(next[META_LAST_RECALLED]).toBe(9999)
    // Delta-only (like closedMeta): it does NOT re-spread the entry's meta, so a
    // stale snapshot of importance/foo can never clobber a concurrent writer.
    expect(Object.keys(next).sort()).toEqual([META_LAST_RECALLED, META_RECALL_COUNT].sort())
    expect(src.meta).toEqual({ importance: 4, recallCount: 2, foo: 'bar' }) // input untouched
    // The caller merges the delta onto the current meta to preserve the rest.
    const merged = { ...src.meta, ...next }
    expect(merged.importance).toBe(4)
    expect(merged.foo).toBe('bar')
  })

  it('reinforcedMeta from an entry with no meta starts the count at 1', () => {
    const next = reinforcedMeta(e('a', 0), 5)
    expect(next[META_RECALL_COUNT]).toBe(1)
    expect(next[META_LAST_RECALLED]).toBe(5)
  })
})
