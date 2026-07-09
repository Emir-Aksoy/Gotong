/**
 * A2 时段问候 + 上次对话间隔 — the zero-LLM card that greets by time-of-day and
 * acknowledges a real gap since the member last talked.
 *
 * Pins: (1) pure helpers — 时段 buckets, fuzzy gap text, tz hour; (2) last-seen
 * file I/O (missing/corrupt → first contact, atomic roundtrip); (3) the probe's
 * gate — first contact → null (but persists), active chat (< threshold) → null,
 * a real gap → a card carrying the 时段 + gap, and NOW is persisted every turn.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  GAP_GREET_MS,
  buildButlerLastSeenProbe,
  buildLastSeenCard,
  formatGap,
  hourInZone,
  partOfDay,
  readLastSeen,
  writeLastSeen,
} from '../src/personal-butler-last-seen.js'

describe('partOfDay', () => {
  it('buckets the hour into a 时段 + greeting', () => {
    expect(partOfDay(2).label).toBe('深夜')
    expect(partOfDay(7).greeting).toBe('早上好')
    expect(partOfDay(12).label).toBe('中午')
    expect(partOfDay(15).greeting).toBe('下午好')
    expect(partOfDay(21).label).toBe('晚上')
  })
  it('stays neutral when the tz is unknown (hour < 0)', () => {
    expect(partOfDay(-1)).toEqual({ label: '现在', greeting: '你好' })
  })
})

describe('formatGap', () => {
  it('is deliberately fuzzy: minutes, hours, days', () => {
    expect(formatGap(30 * 60_000)).toBe('约 30 分钟')
    expect(formatGap(5 * 3_600_000)).toBe('约 5 小时')
    expect(formatGap(2 * 86_400_000)).toBe('约 2 天')
  })
})

describe('hourInZone', () => {
  it('reads the wall-clock hour in the given tz', () => {
    // 2025-07-08 14:34Z → 22:xx in +08:00.
    expect(hourInZone(1_751_985_240_000, 'Asia/Shanghai')).toBe(22)
    expect(hourInZone(1_751_985_240_000, 'UTC')).toBe(14)
  })
  it('returns -1 for an unusable tz', () => {
    expect(hourInZone(1_751_985_240_000, 'Not/AZone')).toBe(-1)
  })
})

describe('buildLastSeenCard', () => {
  it('carries the 时段, a greeting hint, and the gap', () => {
    const card = buildLastSeenCard(5 * 3_600_000, 21)
    expect(card).toContain('现在是晚上')
    expect(card).toContain('约 5 小时')
    expect(card).toContain('晚上好')
  })
})

describe('last-seen file I/O', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'gotong-lastseen-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('missing file → null (first contact)', async () => {
    expect(await readLastSeen(join(dir, 'nope.json'))).toBeNull()
  })
  it('corrupt / wrong-shape → null', async () => {
    const f = join(dir, 'bad.json')
    await writeFile(f, 'not json', 'utf8')
    expect(await readLastSeen(f)).toBeNull()
    await writeFile(f, JSON.stringify({ at: 'nope' }), 'utf8')
    expect(await readLastSeen(f)).toBeNull()
  })
  it('atomic write → read roundtrip', async () => {
    const f = join(dir, 'sub', 'last-seen.json') // mkdir -p on write
    await writeLastSeen(f, 1_700_000_000_000)
    expect(await readLastSeen(f)).toBe(1_700_000_000_000)
  })
})

describe('buildButlerLastSeenProbe — gap gating', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'gotong-lastseen-probe-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('first contact → null, but persists NOW for next turn', async () => {
    const f = join(dir, 'ls.json')
    const T = 1_751_985_240_000
    const probe = buildButlerLastSeenProbe({ file: f, now: () => T, timeZone: 'Asia/Shanghai' })
    expect(await probe()).toBeNull()
    expect(await readLastSeen(f)).toBe(T) // persisted
  })

  it('active chat (gap < threshold) → null, no re-greeting', async () => {
    const f = join(dir, 'ls.json')
    const T0 = 1_751_985_240_000
    await writeLastSeen(f, T0)
    const probe = buildButlerLastSeenProbe({
      file: f,
      now: () => T0 + 10 * 60_000, // 10 minutes later
      timeZone: 'Asia/Shanghai',
    })
    expect(await probe()).toBeNull()
  })

  it('a real gap (≥ 3h) → a card with the 时段 + gap; NOW re-persisted', async () => {
    const f = join(dir, 'ls.json')
    const T0 = 1_751_985_240_000 // 22:34 Shanghai
    await writeLastSeen(f, T0)
    const later = T0 + 10 * 3_600_000 // +10h → 08:34 next day
    const probe = buildButlerLastSeenProbe({ file: f, now: () => later, timeZone: 'Asia/Shanghai' })
    const card = await probe()
    expect(card).toContain('现在是早上')
    expect(card).toContain('约 10 小时')
    expect(await readLastSeen(f)).toBe(later) // advanced
  })

  it('honors a custom threshold', async () => {
    const f = join(dir, 'ls.json')
    const T0 = 1_751_985_240_000
    await writeLastSeen(f, T0)
    const probe = buildButlerLastSeenProbe({
      file: f,
      now: () => T0 + 5 * 60_000, // 5 min
      timeZone: 'Asia/Shanghai',
      gapThresholdMs: 60_000, // 1 min → 5min gap crosses it
    })
    expect(await probe()).not.toBeNull()
  })

  it('GAP_GREET_MS is 3 hours', () => {
    expect(GAP_GREET_MS).toBe(3 * 60 * 60 * 1000)
  })
})
