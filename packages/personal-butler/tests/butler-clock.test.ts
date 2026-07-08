/**
 * butler-clock — the per-turn current-time card.
 *
 * The butler LEADS its system prompt with a byte-stable frozen block, so time
 * (which changes every minute) can only live in the variable per-turn tail. This
 * pins that the card: (1) renders the injected instant in the requested IANA
 * zone, (2) always prints zone + UTC offset + a UTC anchor so the reading is
 * unambiguous, (3) honors the zone (same instant, different zone → different
 * wall-clock), (4) never throws on a bad zone, and (5) as a probe ALWAYS injects
 * (a butler must always know "now").
 */

import { describe, expect, it } from 'vitest'

import type { Task } from '@gotong/core'

import { buildButlerClockProbe, renderClockCard } from '../src/butler-clock.js'

// 2025-07-08 22:34 in Kuala_Lumpur (UTC+8) == 14:34Z == 07:34 in Los_Angeles.
const FIXED = 1_751_985_240_000
const fakeTask = { id: 't-1' } as unknown as Task

describe('renderClockCard', () => {
  it('renders the instant in the requested zone with weekday, offset, UTC anchor', () => {
    const card = renderClockCard(FIXED, 'Asia/Kuala_Lumpur')
    expect(card).toBe(
      '【当前时间】2025-07-08 星期二 22:34（Asia/Kuala_Lumpur, UTC+08:00）· UTC 2025-07-08T14:34Z',
    )
  })

  it('honors the timezone — the SAME instant reads differently in another zone', () => {
    const kl = renderClockCard(FIXED, 'Asia/Kuala_Lumpur')
    const la = renderClockCard(FIXED, 'America/Los_Angeles')
    expect(kl).toContain('22:34')
    expect(kl).toContain('UTC+08:00')
    expect(la).toContain('07:34')
    expect(la).toContain('UTC-07:00')
    // Both anchor to the SAME absolute UTC instant — only the local render moves.
    expect(kl).toContain('UTC 2025-07-08T14:34Z')
    expect(la).toContain('UTC 2025-07-08T14:34Z')
  })

  it('always includes the IANA zone name it used (unambiguous reading)', () => {
    expect(renderClockCard(FIXED, 'UTC')).toContain('（UTC, UTC+00:00）')
  })

  it('localizes the weekday (locale override)', () => {
    // Same instant, English locale → an English weekday, numeric fields unchanged.
    expect(renderClockCard(FIXED, 'Asia/Kuala_Lumpur', 'en-US')).toContain('Tuesday')
  })

  it('a bad timezone degrades to a UTC ISO card — NEVER throws, never drops the card', () => {
    const card = renderClockCard(FIXED, 'Not/AZone')
    expect(card).toBe('【当前时间】UTC 2025-07-08T14:34Z')
  })
})

describe('buildButlerClockProbe', () => {
  it('ALWAYS injects a non-null card (knowing "now" is table stakes)', async () => {
    const probe = buildButlerClockProbe({ now: () => FIXED, timeZone: 'Asia/Kuala_Lumpur' })
    const card = await probe(fakeTask)
    expect(card).toBe(
      '【当前时间】2025-07-08 星期二 22:34（Asia/Kuala_Lumpur, UTC+08:00）· UTC 2025-07-08T14:34Z',
    )
  })

  it('uses the injected clock so each turn reflects the CURRENT minute', async () => {
    let t = FIXED
    const probe = buildButlerClockProbe({ now: () => t, timeZone: 'Asia/Kuala_Lumpur' })
    expect(await probe(fakeTask)).toContain('22:34')
    t = FIXED + 60_000 // one minute later
    expect(await probe(fakeTask)).toContain('22:35')
  })

  it('defaults are total — no options still yields a card (real system tz)', async () => {
    const card = await buildButlerClockProbe()(fakeTask)
    expect(card).toContain('【当前时间】')
    expect(card).toContain('· UTC ')
  })
})
