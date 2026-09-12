import { isDeepStrictEqual } from 'node:util'
import { temporalOf, type TurnTime } from './temporal.js'

export interface CalendarRange {
  start: string
  end: string
  precision: 'day' | 'week'
}
export interface CalendarReferences {
  v: 1
  references: { start: number; end: number; range?: CalendarRange }[]
  overflow: boolean
}

const MAX_REFERENCES = 4
const MAX_TEXT = 4000
const DAY = 86_400_000
const DAYS: Record<string, number> = { 今天: 0, 昨天: -1, 前天: -2, 明天: 1, 后天: 2 }
const WEEKS: Record<string, number> = { 本周: 0, 这周: 0, 上周: -1, 上上周: -2, 下周: 1, 下下周: 2 }
const RELATIVE = Object.keys({ ...DAYS, ...WEEKS }).sort((a, b) => b.length - a.length).join('|')
const COMPOUND_BEFORE = new RegExp(`(?:${RELATIVE})(?:的)?$`)
const COMPOUND_AFTER = new RegExp(`^(?:的)?(?:${RELATIVE})`)
const YEAR_MODIFIER = /(?:去年|前年|今年|明年|后年|那年|同年|(?:\d+|[一二三四五六七八九十两]+)年(?:前|后)?)(?:的)?\s*$/

// A deliberately finite lexicon, not a general natural-language date parser.
const EXPRESSIONS = /(?<!\d)(?:\d{4}-\d{1,2}-\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)(?!\d)|(?<![上下一大])(?:上上周|下下周|上周|下周|本周|这周)(?![一二三四五六日天末\d])|(?<!大)(?:今天|昨天|前天|明天|后天)/g

function date(year: number, month: number, day: number): Date | undefined {
  if (year < 1 || year > 9999) return undefined
  const d = new Date(0)
  d.setUTCFullYear(year, month - 1, day)
  d.setUTCHours(0, 0, 0, 0)
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : undefined
}

function localDay(time: TurnTime | undefined): Date | undefined {
  const t = temporalOf({ meta: { temporal: time } })
  if (!t) return undefined
  if (t.timeZone === 'UTC') {
    const d = new Date(t.observedAt)
    return date(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      calendar: 'gregory', numberingSystem: 'latn', timeZone: t.timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit', era: 'short',
    }).formatToParts(t.observedAt)
    const p = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return p.era === 'AD' ? date(Number(p.year), Number(p.month), Number(p.day)) : undefined
  } catch { return undefined }
}

function rangeFor(phrase: string, day: Date | undefined): CalendarRange | undefined {
  let start: Date | undefined
  let precision: 'day' | 'week' = 'day'
  const absolute = /^(\d{4})(?:-|年)(\d{1,2})(?:-|月)(\d{1,2})日?$/.exec(phrase)
  if (absolute) start = date(Number(absolute[1]), Number(absolute[2]), Number(absolute[3]))
  else if (day) {
    // Arithmetic is on Gregorian date labels, never elapsed hours in a DST zone.
    if (Object.hasOwn(DAYS, phrase)) start = new Date(day.getTime() + DAYS[phrase]! * DAY)
    else if (Object.hasOwn(WEEKS, phrase)) {
      precision = 'week'
      start = new Date(day.getTime() + (WEEKS[phrase]! * 7 - (day.getUTCDay() + 6) % 7) * DAY)
    }
  }
  if (!start) return undefined
  const end = new Date(start.getTime() + (precision === 'week' ? 7 : 1) * DAY)
  if (start.getUTCFullYear() < 1 || end.getUTCFullYear() > 9999) return undefined
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), precision }
}

/** Persist only on new capture. A date reference is not an assertion that an event occurred. */
export function captureCalendar(text: string, temporal?: TurnTime): CalendarReferences | undefined {
  if (!text || text.length > MAX_TEXT) return undefined
  const day = localDay(temporal)
  const references: CalendarReferences['references'] = []
  let overflow = false
  for (const match of text.matchAll(EXPRESSIONS)) {
    const before = text.slice(0, match.index)
    const after = text.slice(match.index + match[0].length)
    // Refuse known lexical collisions and compound anchors rather than guessing their semantics.
    if (YEAR_MODIFIER.test(before) || COMPOUND_BEFORE.test(before) || COMPOUND_AFTER.test(after) ||
      (match[0] === '后天' && after.startsWith('性'))) continue
    if (references.length === MAX_REFERENCES) { overflow = true; break }
    const range = rangeFor(match[0], day)
    references.push({ start: match.index, end: match.index + match[0].length, ...(range ? { range } : {}) })
  }
  return references.length ? { v: 1, references, overflow } : undefined
}

/** Validate using the original anchor only; absent metadata is never backfilled on read. */
export function calendarOf(raw: unknown, text: string, temporal?: TurnTime): CalendarReferences | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const expected = captureCalendar(text, temporal)
  return expected && isDeepStrictEqual(raw, expected) ? expected : undefined
}

export function formatCalendar(calendar: CalendarReferences, text: string): string {
  const refs = calendar.references.map(ref => {
    const phrase = JSON.stringify(text.slice(ref.start, ref.end))
    return ref.range ? `${phrase}=[${ref.range.start}, ${ref.range.end}) ${ref.range.precision}` : `${phrase}=unknown`
  })
  if (calendar.overflow) refs.push('additional date references omitted')
  return `date refs (original turn; not event claims): ${refs.join('; ')}`
}
