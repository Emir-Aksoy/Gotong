/**
 * MR-M3 — RoutingHealthTracker folds RoutingProvider events into the per-agent,
 * per-candidate health rows the admin panel reads. Pinned here:
 *   - healthy candidates are NOT surfaced (the panel is a signal, not a dump)
 *   - a recent pre-first-chunk error → a `degraded` row that expires by time
 *   - an open breaker → `open`, then `half_open` once its cooldown elapses
 *   - a success (or breaker_close) clears the row
 *   - `exhausted` alone spawns no row; `forget` drops an agent
 * A mutable clock makes the time-window behaviour deterministic.
 */

import { describe, expect, it } from 'vitest'

import type { LlmErrorKind, RoutingEvent } from '@gotong/llm'

import { RoutingHealthTracker } from '../src/routing-health.js'

function trackerAt(clock: { t: number }): RoutingHealthTracker {
  return new RoutingHealthTracker({ now: () => clock.t })
}

const served = (i: number, label = `c${i}`): RoutingEvent => ({ type: 'served', candidate: label, index: i })
const errored = (i: number, kind: LlmErrorKind, label = `c${i}`): RoutingEvent =>
  ({ type: 'candidate_error', candidate: label, index: i, errorKind: kind })
const opened = (i: number, openUntil: number, label = `c${i}`): RoutingEvent =>
  ({ type: 'breaker_open', candidate: label, index: i, openUntil })
const closed = (i: number, label = `c${i}`): RoutingEvent => ({ type: 'breaker_close', candidate: label, index: i })

describe('RoutingHealthTracker (MR-M3)', () => {
  it('a served candidate is not surfaced (healthy = quiet)', () => {
    const clock = { t: 1_000 }
    const tr = trackerAt(clock)
    tr.record('a', served(0))
    expect(tr.snapshot()).toEqual([])
  })

  it('a recent candidate_error surfaces a degraded row with the error kind', () => {
    const clock = { t: 1_000 }
    const tr = trackerAt(clock)
    tr.record('a', errored(0, 'rate_limited'))
    const rows = tr.snapshot()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      agentId: 'a',
      candidate: 'c0',
      index: 0,
      state: 'degraded',
      errorKind: 'rate_limited',
      since: 1_000,
    })
  })

  it('a degraded row expires once the 60s window passes with no fresh failure', () => {
    const clock = { t: 1_000 }
    const tr = trackerAt(clock)
    tr.record('a', errored(0, 'network'))
    expect(tr.snapshot()).toHaveLength(1)
    clock.t = 1_000 + 60_000 // exactly the window edge → no longer "recent"
    expect(tr.snapshot()).toEqual([])
  })

  it('a success after an error clears the degraded row', () => {
    const clock = { t: 1_000 }
    const tr = trackerAt(clock)
    tr.record('a', errored(0, 'timeout'))
    expect(tr.snapshot()).toHaveLength(1)
    tr.record('a', served(0))
    expect(tr.snapshot()).toEqual([])
  })

  it('an open breaker is `open` while cooling, `half_open` once cooldown elapses', () => {
    const clock = { t: 1_000 }
    const tr = trackerAt(clock)
    tr.record('a', errored(0, 'network'))
    tr.record('a', opened(0, 31_000)) // openUntil = 31s
    let rows = tr.snapshot()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'open', openUntil: 31_000, errorKind: 'network' })
    clock.t = 31_000 // cooldown elapsed → the next request would probe
    rows = tr.snapshot()
    expect(rows[0]).toMatchObject({ state: 'half_open' })
  })

  it('breaker_close removes the row (recovered)', () => {
    const clock = { t: 1_000 }
    const tr = trackerAt(clock)
    tr.record('a', errored(0, 'network'))
    tr.record('a', opened(0, 31_000))
    expect(tr.snapshot()).toHaveLength(1)
    tr.record('a', closed(0))
    expect(tr.snapshot()).toEqual([])
  })

  it('`exhausted` alone surfaces no row (llmOutage owns "brain out")', () => {
    const clock = { t: 1_000 }
    const tr = trackerAt(clock)
    tr.record('a', { type: 'exhausted', errorKind: 'network' })
    expect(tr.snapshot()).toEqual([])
  })

  it('rows sort primary-first within an agent, agents alphabetical', () => {
    const clock = { t: 1_000 }
    const tr = trackerAt(clock)
    tr.record('b', errored(1, 'auth', 'b1'))
    tr.record('a', errored(2, 'quota', 'a2'))
    tr.record('a', opened(0, 99_000, 'a0'))
    const rows = tr.snapshot()
    expect(rows.map((r) => `${r.agentId}:${r.index}`)).toEqual(['a:0', 'a:2', 'b:1'])
  })

  it('forget drops an agent entirely', () => {
    const clock = { t: 1_000 }
    const tr = trackerAt(clock)
    tr.record('a', errored(0, 'network'))
    tr.record('b', errored(0, 'network'))
    tr.forget('a')
    const rows = tr.snapshot()
    expect(rows.map((r) => r.agentId)).toEqual(['b'])
  })
})
