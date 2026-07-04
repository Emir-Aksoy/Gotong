/**
 * LIFE-L1-M1 — unit tests for the scheduled-workflow decision core.
 *
 * What these pin:
 *   1. normalizeWorkflowSchedule — a row that half-parses is null (never run
 *      with guessed values), enabled must be literally true, interval clamps
 *      to the floor instead of refusing.
 *   2. scheduleDue — the daily "at/after hour, once per member-local day"
 *      gate; weekly = same gate + weekday, deduped by the fired DATE (so next
 *      week's same weekday fires with no week-boundary special case); interval
 *      = elapsed-ms math with an unparseable mark degrading to "never fired".
 *   3. All local-time math is member-TZ, host-TZ-independent (fixed instants,
 *      explicit offsets — no Date.now, no host zone reads).
 */

import { describe, expect, it } from 'vitest'

import {
  SCHEDULE_MIN_INTERVAL_MS,
  normalizeWorkflowSchedule,
  scheduleDue,
  type WorkflowScheduleDef,
} from '../src/workflow-schedule-core.js'

// 2026-07-06 is a Monday. 00:00 UTC = 08:00 Malaysia (+480).
const MON_0000_UTC = Date.UTC(2026, 6, 6, 0, 0, 0)

const daily = (hour: number, tz = 480): WorkflowScheduleDef => ({
  id: 's1',
  workflowId: 'wf-brief',
  userId: 'u-emir',
  cadence: { kind: 'daily', hour, tzOffsetMinutes: tz },
  enabled: true,
})

describe('normalizeWorkflowSchedule', () => {
  it('accepts the three cadences and defaults tz to +08:00', () => {
    const d = normalizeWorkflowSchedule({
      id: 'a',
      workflowId: 'w',
      userId: 'u',
      cadence: { kind: 'daily', hour: 8 },
      enabled: true,
    })
    expect(d?.cadence).toEqual({ kind: 'daily', hour: 8, tzOffsetMinutes: 480 })

    const w = normalizeWorkflowSchedule({
      id: 'b',
      workflowId: 'w',
      userId: 'u',
      cadence: { kind: 'weekly', weekday: 0, hour: 20, tzOffsetMinutes: 0 },
      enabled: true,
    })
    expect(w?.cadence).toEqual({ kind: 'weekly', weekday: 0, hour: 20, tzOffsetMinutes: 0 })

    const i = normalizeWorkflowSchedule({
      id: 'c',
      workflowId: 'w',
      userId: 'u',
      cadence: { kind: 'interval', everyMs: 3_600_000 },
      enabled: true,
    })
    expect(i?.cadence).toEqual({ kind: 'interval', everyMs: 3_600_000 })
  })

  it('clamps a too-tight interval to the floor instead of refusing', () => {
    const s = normalizeWorkflowSchedule({
      id: 'a',
      workflowId: 'w',
      userId: 'u',
      cadence: { kind: 'interval', everyMs: 5 },
      enabled: true,
    })
    expect(s?.cadence).toEqual({ kind: 'interval', everyMs: SCHEDULE_MIN_INTERVAL_MS })
  })

  it('nulls a row it cannot trust — never runs with guessed values', () => {
    const base = { id: 'a', workflowId: 'w', userId: 'u', enabled: true }
    // unknown cadence kind / out-of-range hour / bad weekday / non-positive interval
    expect(normalizeWorkflowSchedule({ ...base, cadence: { kind: 'cron', expr: '* * * * *' } })).toBeNull()
    expect(normalizeWorkflowSchedule({ ...base, cadence: { kind: 'daily', hour: 24 } })).toBeNull()
    expect(normalizeWorkflowSchedule({ ...base, cadence: { kind: 'weekly', weekday: 7, hour: 8 } })).toBeNull()
    expect(normalizeWorkflowSchedule({ ...base, cadence: { kind: 'interval', everyMs: 0 } })).toBeNull()
    // missing identity fields
    expect(
      normalizeWorkflowSchedule({ ...base, id: '', cadence: { kind: 'daily', hour: 8 } }),
    ).toBeNull()
    expect(
      normalizeWorkflowSchedule({ id: 'a', workflowId: 'w', cadence: { kind: 'daily', hour: 8 }, enabled: true }),
    ).toBeNull()
    expect(normalizeWorkflowSchedule(null)).toBeNull()
    expect(normalizeWorkflowSchedule([])).toBeNull()
  })

  it('anything but literal true parks the row (enabled: false)', () => {
    for (const enabled of [false, undefined, 1, 'true']) {
      const s = normalizeWorkflowSchedule({
        id: 'a',
        workflowId: 'w',
        userId: 'u',
        cadence: { kind: 'daily', hour: 8 },
        enabled,
      })
      expect(s?.enabled).toBe(false)
    }
  })

  it('keeps inputs only when they are a plain object', () => {
    const base = { id: 'a', workflowId: 'w', userId: 'u', cadence: { kind: 'daily', hour: 8 }, enabled: true }
    expect(normalizeWorkflowSchedule({ ...base, inputs: { topic: 'news' } })?.inputs).toEqual({
      topic: 'news',
    })
    expect(normalizeWorkflowSchedule({ ...base, inputs: ['x'] })?.inputs).toBeUndefined()
  })
})

describe('scheduleDue — daily', () => {
  it('holds before the member-local hour, fires at/after it', () => {
    // 23:30 UTC previous day = 07:30 Malaysia — before an 08:00 schedule.
    const before = scheduleDue(daily(8), undefined, MON_0000_UTC - 30 * 60_000)
    expect(before).toEqual({ due: false, reason: 'before-hour' })
    // 00:00 UTC = 08:00 Malaysia — exactly at the hour.
    const at = scheduleDue(daily(8), undefined, MON_0000_UTC)
    expect(at).toEqual({ due: true, mark: '2026-07-06' })
    // Late in the local day still fires (at/after semantics).
    const late = scheduleDue(daily(8), undefined, MON_0000_UTC + 10 * 3_600_000)
    expect(late).toEqual({ due: true, mark: '2026-07-06' })
  })

  it('dedupes within the member-local day, reopens the next day', () => {
    const fired = scheduleDue(daily(8), '2026-07-06', MON_0000_UTC + 3_600_000)
    expect(fired).toEqual({ due: false, reason: 'already-fired' })
    const nextDay = scheduleDue(daily(8), '2026-07-06', MON_0000_UTC + 24 * 3_600_000)
    expect(nextDay).toEqual({ due: true, mark: '2026-07-07' })
  })

  it('gates on the MEMBER-local day, not UTC', () => {
    // 20:00 UTC Monday = 04:00 Tuesday in Malaysia — before Tuesday's 08:00,
    // even though it is well past 08:00 in UTC terms.
    const s = scheduleDue(daily(8), '2026-07-06', MON_0000_UTC + 20 * 3_600_000)
    expect(s).toEqual({ due: false, reason: 'before-hour' })
  })
})

describe('scheduleDue — weekly', () => {
  const weekly = (weekday: number): WorkflowScheduleDef => ({
    ...daily(20),
    cadence: { kind: 'weekly', weekday, hour: 20, tzOffsetMinutes: 480 },
  })

  it('fires only on the configured member-local weekday', () => {
    // Monday 20:00 Malaysia = Monday 12:00 UTC. weekday 1 = Monday.
    const mon = scheduleDue(weekly(1), undefined, MON_0000_UTC + 12 * 3_600_000)
    expect(mon).toEqual({ due: true, mark: '2026-07-06' })
    const wrongDay = scheduleDue(weekly(0), undefined, MON_0000_UTC + 12 * 3_600_000)
    expect(wrongDay).toEqual({ due: false, reason: 'wrong-weekday' })
  })

  it('dedupes by fired date — next week same weekday fires again', () => {
    const sameDay = scheduleDue(weekly(1), '2026-07-06', MON_0000_UTC + 13 * 3_600_000)
    expect(sameDay).toEqual({ due: false, reason: 'already-fired' })
    const nextWeek = scheduleDue(weekly(1), '2026-07-06', MON_0000_UTC + (7 * 24 + 12) * 3_600_000)
    expect(nextWeek).toEqual({ due: true, mark: '2026-07-13' })
  })
})

describe('scheduleDue — interval', () => {
  const interval = (everyMs: number): WorkflowScheduleDef => ({
    ...daily(8),
    cadence: { kind: 'interval', everyMs },
  })

  it('fires immediately when never fired, then waits out the interval', () => {
    const first = scheduleDue(interval(3_600_000), undefined, MON_0000_UTC)
    expect(first).toEqual({ due: true, mark: String(MON_0000_UTC) })
    const tooSoon = scheduleDue(interval(3_600_000), String(MON_0000_UTC), MON_0000_UTC + 1)
    expect(tooSoon).toEqual({ due: false, reason: 'interval-not-elapsed' })
    const elapsed = scheduleDue(
      interval(3_600_000),
      String(MON_0000_UTC),
      MON_0000_UTC + 3_600_000,
    )
    expect(elapsed).toEqual({ due: true, mark: String(MON_0000_UTC + 3_600_000) })
  })

  it('treats an unparseable mark as never-fired instead of wedging shut', () => {
    const s = scheduleDue(interval(3_600_000), 'not-a-number', MON_0000_UTC)
    expect(s).toEqual({ due: true, mark: String(MON_0000_UTC) })
  })
})

describe('scheduleDue — disabled', () => {
  it('never fires a disabled schedule, whatever the clock says', () => {
    const s = scheduleDue({ ...daily(8), enabled: false }, undefined, MON_0000_UTC + 3_600_000)
    expect(s).toEqual({ due: false, reason: 'disabled' })
  })
})
