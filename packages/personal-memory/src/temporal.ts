import type { MemoryEntry } from '@gotong/services-sdk'
import { PersonalMemoryError } from './errors.js'

/** Local receipt of a new turn, never a claim about when its event happened. */
export interface TurnTime {
  v: 1
  observedAt: number
  timeZone: string
  basis: 'turn-start'
}

function validTime(at: unknown): at is number {
  return typeof at === 'number' && Number.isFinite(at) && Number.isFinite(new Date(at).getTime())
}

function validZone(zone: unknown): zone is string {
  if (zone === 'UTC') return true
  if (typeof zone !== 'string' || zone.length === 0) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch { return false }
}

export function observeTurnTime(observedAt = Date.now(), timeZone?: string): TurnTime {
  if (!validTime(observedAt)) throw new PersonalMemoryError('invalid_turn_time', 'Invalid local turn clock')
  let zone = timeZone
  if (zone === undefined) {
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone } catch { zone = 'UTC' }
  }
  return { v: 1, observedAt, timeZone: validZone(zone) ? zone : 'UTC', basis: 'turn-start' }
}

export function temporalOf(entry: Pick<MemoryEntry, 'meta'>): TurnTime | undefined {
  const raw = entry.meta?.temporal
  if (!raw || typeof raw !== 'object') return undefined
  const t = raw as Record<string, unknown>
  if (t.v !== 1 || t.basis !== 'turn-start' || !validTime(t.observedAt) || !validZone(t.timeZone)) return undefined
  return { v: 1, observedAt: t.observedAt, timeZone: t.timeZone, basis: 'turn-start' }
}

/** Stable absolute labels keep relative words from drifting on later recall. */
export function formatTurnTime(time: TurnTime): string {
  if (time.timeZone === 'UTC') {
    const utc = new Date(time.observedAt).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
    return `turn-start: ${utc} UTC; event-time: unspecified`
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: time.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(time.observedAt)
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `turn-start: ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${time.timeZone}; event-time: unspecified`
}
