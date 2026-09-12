import { describe, expect, it, vi } from 'vitest'
import { captureCalendar, calendarOf, formatCalendar } from '../src/calendar.js'
import { observeTurnTime } from '../src/temporal.js'

const anchor = (iso = '2026-09-11T12:00:00Z', zone = 'Asia/Shanghai') => observeTurnTime(Date.parse(iso), zone)

describe('original-turn calendar references', () => {
  it('keeps the week before last as a Monday-exclusive-Monday range', () => {
    const text = '我上上周吃过烤肉'
    const calendar = captureCalendar(text, anchor())!
    expect(calendar.references).toEqual([{ start: 1, end: 4, range: { start: '2026-08-24', end: '2026-08-31', precision: 'week' } }])
    expect(calendar.v).toBe(1)
    expect(formatCalendar(calendar, text)).toContain('not event claims')
    expect(formatCalendar(calendar, text)).toContain('[2026-08-24, 2026-08-31)')
  })
  it.each([
    ['今天', '2026-09-11', '2026-09-12'], ['昨天', '2026-09-10', '2026-09-11'],
    ['前天', '2026-09-09', '2026-09-10'], ['明天', '2026-09-12', '2026-09-13'],
    ['后天', '2026-09-13', '2026-09-14'], ['本周', '2026-09-07', '2026-09-14'],
    ['这周', '2026-09-07', '2026-09-14'], ['上周', '2026-08-31', '2026-09-07'],
    ['下周', '2026-09-14', '2026-09-21'], ['下下周', '2026-09-21', '2026-09-28'],
  ])('resolves %s to local calendar days', (text, start, end) => {
    expect(captureCalendar(text, anchor())!.references[0]!.range).toMatchObject({ start, end })
  })
  it.each([
    ['2026-09-11T06:30:00Z', 'America/Los_Angeles', '昨天', '2026-09-09', '2026-09-10'],
    ['2026-09-11T07:30:00Z', 'America/Los_Angeles', '昨天', '2026-09-10', '2026-09-11'],
    ['2024-03-01T00:30:00Z', 'UTC', '昨天', '2024-02-29', '2024-03-01'],
    ['2027-01-01T00:30:00Z', 'UTC', '上周', '2026-12-21', '2026-12-28'],
    ['2026-03-09T06:30:00Z', 'America/Los_Angeles', '本周', '2026-03-02', '2026-03-09'],
    ['2026-11-02T07:30:00Z', 'America/Los_Angeles', '本周', '2026-10-26', '2026-11-02'],
  ])('handles midnight/leap/year/DST at %s', (iso, zone, text, start, end) => {
    expect(captureCalendar(text, anchor(iso, zone))!.references[0]!.range).toMatchObject({ start, end })
  })
  it('supports exact absolute dates without inventing a time of day or year', () => {
    for (const text of ['2024-02-29', '2024年2月29日']) {
      expect(captureCalendar(text)!.references[0]!.range).toEqual({ start: '2024-02-29', end: '2024-03-01', precision: 'day' })
    }
    expect(captureCalendar('9月11日')).toBeUndefined()
  })
  it('does not normalize invalid dates or unsupported phrase suffixes', () => {
    for (const text of ['2025-02-29', '2026-13-01', '2026年4月31日']) {
      expect(captureCalendar(text)!.references[0]!.range).toBeUndefined()
    }
    for (const text of ['上上上周', '大前天', '上周三', '上周末']) expect(captureCalendar(text, anchor())).toBeUndefined()
  })
  it('keeps unanchored relative dates unknown rather than reading the current clock', () => {
    const c = captureCalendar('昨天')!
    expect(c.references).toEqual([{ start: 0, end: 2 }])
    expect(formatCalendar(c, '昨天')).toContain('unknown')
  })
  it.each(['去年今天', '去年的今天', '前年上周', '两年前的昨天', '2024年的今天',
    '后天性心脏病', '昨天的明天', '上周的今天', '上上周今天'])('does not extract misleading fragments from %s', text => {
    expect(captureCalendar(text, anchor())).toBeUndefined()
  })
  it('still accepts separate date clauses and ordinary day suffixes', () => {
    const text = '昨天晚上休息，今天吃饭，后天见'
    expect(captureCalendar(text, anchor())!.references.map(ref => text.slice(ref.start, ref.end))).toEqual(['昨天', '今天', '后天'])
  })
  it('bounds references and explicitly marks overflow', () => {
    const c = captureCalendar('今天 昨天 前天 明天 后天', anchor())!
    expect(c.references).toHaveLength(4)
    expect(c.overflow).toBe(true)
    expect(formatCalendar(c, '今天 昨天 前天 明天 后天')).toContain('omitted')
  })
  it('does not synthesize metadata on read and rejects forged dates or spans', () => {
    const text = '昨天'
    const c = captureCalendar(text, anchor())!
    expect(calendarOf(undefined, text, anchor())).toBeUndefined()
    expect(calendarOf(c, text, anchor())).toEqual(c)
    expect(calendarOf({ ...c, v: 2 }, text, anchor())).toBeUndefined()
    expect(calendarOf({ ...c, references: [{ ...c.references[0], start: 1 }] }, text, anchor())).toBeUndefined()
    expect(calendarOf(c, text, anchor('2026-10-11T12:00:00Z'))).toBeUndefined()
  })
  it('keeps UTC usable when Intl is unavailable', () => {
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => { throw new Error('unavailable') })
    try { expect(captureCalendar('昨天', anchor('2026-09-11T12:00:00Z', 'UTC'))!.references[0]!.range?.start).toBe('2026-09-10') }
    finally { spy.mockRestore() }
  })
})
