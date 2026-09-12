import type { MemoryEntry, NewMemoryEntry } from '@gotong/services-sdk'
import { formatTurnTime, temporalOf, type TurnTime } from './temporal.js'
import { PersonalMemoryError } from './errors.js'
import { calendarOf, formatCalendar, type CalendarReferences } from './calendar.js'

export interface UserEvidence {
  sourceId: string
  text: string
  temporal?: TurnTime
  calendar?: CalendarReferences
  scope?: string
}

const MAX_SOURCES = 8
const MAX_QUOTE_CHARS = 4000
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}
function scopeOf(meta: Record<string, unknown> | undefined): string | undefined | null {
  // Both aliases are used by existing filters; contradictory ownership is not unscoped.
  if (['userId', 'user'].some(key => Object.hasOwn(meta ?? {}, key) && typeof meta![key] !== 'string')) return null
  if (meta?.userId !== undefined && meta.user !== undefined && meta.userId !== meta.user) return null
  return (meta?.userId ?? meta?.user) as string | undefined
}
function quoteAt(text: string, raw: Record<string, unknown>): string | undefined {
  const { start, end } = raw
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length || end - start > MAX_QUOTE_CHARS) return undefined
  return text.slice(start, end)
}

/** Marked-but-invalid evidence is protected too: never feed it to a lossy fallback. */
export function hasEvidenceBoundary(e: Pick<MemoryEntry, 'meta'>): boolean {
  return ['temporal', 'userSpan', 'evidence', 'calendar'].some(key => Object.hasOwn(e.meta ?? {}, key))
}

/** Spans are produced at capture/packing time, never inferred from textual role labels. */
export function evidenceSources(e: MemoryEntry): UserEvidence[] {
  const scope = scopeOf(e.meta)
  if (scope === null) return []
  const envelope = record(e.meta?.evidence)
  if (Object.hasOwn(e.meta ?? {}, 'evidence')) {
    if (envelope?.v !== 1 || !Array.isArray(envelope.sources) || !envelope.sources.length || envelope.sources.length > MAX_SOURCES) return []
    const out: UserEvidence[] = []
    for (const value of envelope.sources) {
      const s = record(value)
      if (!s || typeof s.sourceId !== 'string' || !s.sourceId.trim() || s.sourceId.length > 200 || s.speaker !== 'user') return []
      const text = quoteAt(e.text, s)
      if (!text) return []
      const temporal = temporalOf({ meta: { temporal: s.temporal } })
      if (s.temporal !== undefined && !temporal) return []
      const calendar = calendarOf(s.calendar, text, temporal)
      if (Object.hasOwn(s, 'calendar') && !calendar) return []
      out.push({ sourceId: s.sourceId, text, ...(temporal ? { temporal } : {}), ...(calendar ? { calendar } : {}), ...(scope !== undefined ? { scope } : {}) })
    }
    return uniqueSources(out) ?? []
  }
  const span = record(e.meta?.userSpan)
  if (span?.v !== 1 || (Object.hasOwn(span, 'complete') && span.complete !== true)) return []
  const text = quoteAt(e.text, span)
  if (!text) return []
  const temporal = temporalOf(e)
  if (e.meta?.temporal !== undefined && !temporal) return []
  const calendar = calendarOf(e.meta?.calendar, text, temporal)
  if (Object.hasOwn(e.meta ?? {}, 'calendar') && !calendar) return []
  return [{ sourceId: e.id, text, ...(temporal ? { temporal } : {}), ...(calendar ? { calendar } : {}), ...(scope !== undefined ? { scope } : {}) }]
}

function uniqueSources(sources: readonly UserEvidence[]): UserEvidence[] | undefined {
  const found = new Map<string, UserEvidence>()
  for (const s of sources) {
    if (!s.sourceId.trim() || s.sourceId.length > 200 || !s.text || s.text.length > MAX_QUOTE_CHARS) return undefined
    const prior = found.get(s.sourceId)
    if (prior && JSON.stringify(prior) !== JSON.stringify(s)) return undefined
    found.set(s.sourceId, s)
  }
  return [...found.values()]
}

/** Exact user text is the durable payload. The model cannot replace it with a paraphrase. */
export function packEvidence(sources: readonly UserEvidence[], cap: number, extra: Record<string, unknown> = {}): NewMemoryEntry | undefined {
  const unique = uniqueSources(sources)
  if (!unique?.length || unique.length > MAX_SOURCES || !Number.isFinite(cap) || cap <= 0) return undefined
  const scope = unique[0]!.scope
  const extraScope = scopeOf(extra)
  if (extraScope === null || unique.some(s => s.scope !== scope) || (extraScope !== undefined && extraScope !== scope)) return undefined
  let text = ''
  const spans: Record<string, unknown>[] = []
  for (const source of unique) {
    if (source.temporal && !temporalOf({ meta: { temporal: source.temporal } })) return undefined
    if (Object.hasOwn(source, 'calendar') && !calendarOf(source.calendar, source.text, source.temporal)) return undefined
    if (text) text += '\n'
    const start = text.length
    text += source.text
    spans.push({ sourceId: source.sourceId, speaker: 'user', start, end: text.length,
      ...(source.temporal ? { temporal: source.temporal } : {}), ...(source.calendar ? { calendar: source.calendar } : {}) })
  }
  const meta = { ...extra }
  delete meta.temporal
  delete meta.userSpan
  delete meta.calendar
  if (scope !== undefined && scopeOf(meta) === undefined) meta.userId = scope
  meta.evidence = { v: 1, sources: spans }
  const packed: NewMemoryEntry = { kind: 'semantic', text, meta }
  return Buffer.byteLength(JSON.stringify(packed), 'utf8') <= cap ? packed : undefined
}

export function renderEvidence(e: MemoryEntry): string | undefined {
  if (!Object.hasOwn(e.meta ?? {}, 'evidence') && !Object.hasOwn(e.meta ?? {}, 'calendar')) return undefined
  const sources = evidenceSources(e)
  if (!sources.length) return '[invalid evidence; not a verified user fact]'
  return sources.map(s => `[source ${JSON.stringify(s.sourceId)}; user quote; ${s.temporal ? formatTurnTime(s.temporal) : 'turn-time: unknown'}${s.calendar ? `; ${formatCalendar(s.calendar, s.text)}` : ''}] ${JSON.stringify(s.text)}`).join(' ')
}

export function prepareEvidenceCompaction(
  candidates: readonly MemoryEntry[], cap: number, meta: Record<string, unknown>,
  required: readonly MemoryEntry[] = [],
): { entry: NewMemoryEntry; consumed: MemoryEntry[] } | undefined {
  // A conflict anywhere in this batch must not be resolved by input order or cap pressure.
  if (!uniqueSources([...required, ...candidates].flatMap(evidenceSources))) return undefined
  const sources: UserEvidence[] = []
  for (const e of required) {
    const evidence = evidenceSources(e)
    if (!evidence.length) return undefined
    sources.push(...evidence)
  }
  const consumed: MemoryEntry[] = []
  let entry: NewMemoryEntry | undefined
  for (const candidate of candidates) {
    const evidence = evidenceSources(candidate)
    if (!evidence.length) continue
    const packed = packEvidence([...sources, ...evidence], cap, meta)
    if (!packed) continue
    entry = packed
    sources.push(...evidence)
    consumed.push(candidate)
  }
  return entry && consumed.length ? { entry, consumed } : undefined
}

/** Validate the backend's saved representation before any source is forgotten. */
export function assertEvidenceSaved(expected: NewMemoryEntry, actual: MemoryEntry): void {
  const source = evidenceSources({ ...expected, id: actual.id, ts: actual.ts })
  if (!source.length || JSON.stringify(source) !== JSON.stringify(evidenceSources(actual))) {
    throw new PersonalMemoryError('evidence_write_mismatch', 'Saved memory did not preserve the source evidence; originals retained')
  }
}
