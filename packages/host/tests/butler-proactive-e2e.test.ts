/**
 * butler-proactive-e2e.test.ts — the S3-M2 acceptance gate for the resident
 * butler's PROACTIVE daily brief.
 *
 * A member opts in ("每天早上跟我说声早"); the `ButlerProactiveSweeper` polls the
 * per-user opt-in file and, once it's at/after the member's local hour and not
 * already sent today, composes a short brief (LLM at the edge — injected here) and
 * pushes it to their IM. This pins the whole S3-M2 contract on the real config
 * store + the real sweep, with deterministic (no-LLM) compose + push:
 *
 *   set_daily_brief tool → proactive.json → sweep (due gate) → compose → push.
 *
 * Plus the things that make it trustworthy: DEFAULT-OFF (a member with no opt-in
 * gets nothing), the once-per-member-local-day dedup, the "nothing to say → stay
 * silent but still count the day" idle convention, a delivery MISS that does NOT
 * mark (so it retries), and no-leak (alice's brief never touches bob's namespace).
 */

import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type Logger } from '@aipehub/core'

import {
  ButlerProactiveSweeper,
  memberLocalNow,
  readButlerProactiveConfig,
  writeButlerProactiveConfig,
  DEFAULT_BRIEF_HOUR,
  DEFAULT_TZ_OFFSET_MIN,
} from '../src/personal-butler-proactive.js'
import { buildButlerDailyBriefToolset } from '../src/personal-butler-daily-brief.js'

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

/** Malaysia +08:00, the default the butler serves. */
const OFFSET = 480

/** UTC instant for a member-LOCAL wall-clock (offset +08:00). local H = UTC (H-8). */
function utcForMemberLocal(y: number, mo0: number, d: number, hour: number): number {
  return Date.UTC(y, mo0, d, hour, 0, 0) - OFFSET * 60_000
}

// ---------------------------------------------------------------------------
// memberLocalNow — pure, host-TZ-independent
// ---------------------------------------------------------------------------

describe('memberLocalNow (pure)', () => {
  it('derives the member-local hour + date from a UTC instant + offset', () => {
    // 2026-07-01 09:00 member-local (+08:00) = 2026-07-01T01:00Z.
    const r = memberLocalNow(Date.UTC(2026, 6, 1, 1, 0, 0), OFFSET)
    expect(r.hour).toBe(9)
    expect(r.date).toBe('2026-07-01')
  })

  it('rolls the local date across the UTC day boundary', () => {
    // 2026-07-01 06:00 member-local = 2026-06-30T22:00Z — still the member's July 1.
    const r = memberLocalNow(Date.UTC(2026, 5, 30, 22, 0, 0), OFFSET)
    expect(r.hour).toBe(6)
    expect(r.date).toBe('2026-07-01')
  })
})

// ---------------------------------------------------------------------------
// Config store + set_daily_brief tool
// ---------------------------------------------------------------------------

describe('proactive config store + set_daily_brief tool', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aipe-butler-proactive-cfg-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('round-trips a config; absent = null', async () => {
    expect(await readButlerProactiveConfig(root, 'alice')).toBeNull()
    await writeButlerProactiveConfig(root, 'alice', {
      enabled: true,
      hour: 8,
      tzOffsetMinutes: OFFSET,
      lastSentDate: '2026-07-01',
    })
    expect(await readButlerProactiveConfig(root, 'alice')).toEqual({
      enabled: true,
      hour: 8,
      tzOffsetMinutes: OFFSET,
      lastSentDate: '2026-07-01',
    })
  })

  it('opt-in writes an enabled config with the given hour; defaults tz', async () => {
    const tools = buildButlerDailyBriefToolset({ userId: 'alice', rootDir: root })
    const out = await tools.callTool('set_daily_brief', { enabled: true, hour: 8 })
    expect(out.isError).toBeFalsy()
    expect((out.content[0] as { text: string }).text).toContain('每天')
    expect(await readButlerProactiveConfig(root, 'alice')).toEqual({
      enabled: true,
      hour: 8,
      tzOffsetMinutes: DEFAULT_TZ_OFFSET_MIN,
    })
  })

  it('enabling without an hour defaults to the morning hour', async () => {
    const tools = buildButlerDailyBriefToolset({ userId: 'alice', rootDir: root })
    await tools.callTool('set_daily_brief', { enabled: true })
    const cfg = await readButlerProactiveConfig(root, 'alice')
    expect(cfg?.enabled).toBe(true)
    expect(cfg?.hour).toBe(DEFAULT_BRIEF_HOUR)
  })

  it('opt-out disables but keeps the prior hour', async () => {
    const tools = buildButlerDailyBriefToolset({ userId: 'alice', rootDir: root })
    await tools.callTool('set_daily_brief', { enabled: true, hour: 7 })
    const out = await tools.callTool('set_daily_brief', { enabled: false })
    expect((out.content[0] as { text: string }).text).toContain('不主动打扰')
    expect(await readButlerProactiveConfig(root, 'alice')).toEqual({
      enabled: false,
      hour: 7,
      tzOffsetMinutes: DEFAULT_TZ_OFFSET_MIN,
    })
  })

  it('a fresh turn-ON drops a stale lastSentDate (so a just-requested brief can fire today)', async () => {
    // Simulate a prior send, then disable, then re-enable — the dedup mark must NOT
    // suppress today's just-requested brief.
    await writeButlerProactiveConfig(root, 'alice', {
      enabled: false,
      hour: 8,
      tzOffsetMinutes: OFFSET,
      lastSentDate: '2026-07-01',
    })
    const tools = buildButlerDailyBriefToolset({ userId: 'alice', rootDir: root })
    await tools.callTool('set_daily_brief', { enabled: true, hour: 8 })
    const cfg = await readButlerProactiveConfig(root, 'alice')
    expect(cfg?.enabled).toBe(true)
    expect(cfg?.lastSentDate).toBeUndefined() // dropped on disabled→enabled
  })

  it('toggling the hour while already ON keeps the dedup mark (no double-send today)', async () => {
    await writeButlerProactiveConfig(root, 'alice', {
      enabled: true,
      hour: 8,
      tzOffsetMinutes: OFFSET,
      lastSentDate: '2026-07-01',
    })
    const tools = buildButlerDailyBriefToolset({ userId: 'alice', rootDir: root })
    await tools.callTool('set_daily_brief', { enabled: true, hour: 9 })
    const cfg = await readButlerProactiveConfig(root, 'alice')
    expect(cfg?.hour).toBe(9)
    expect(cfg?.lastSentDate).toBe('2026-07-01') // kept — already ON, not a fresh turn-on
  })

  it('rejects a non-boolean enabled', async () => {
    const tools = buildButlerDailyBriefToolset({ userId: 'alice', rootDir: root })
    const out = await tools.callTool('set_daily_brief', { hour: 8 } as Record<string, unknown>)
    expect(out.isError).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Sweeper acceptance gate
// ---------------------------------------------------------------------------

describe('butler-proactive-e2e — opt-in → due → compose → push (acceptance gate)', () => {
  let root: string
  /** Controllable compose (LLM at the edge, stubbed) + push (F1, stubbed). */
  let composeCalls: string[]
  let briefText: string | null
  let pushed: Array<{ userId: string; text: string }>
  let pushDelivered: boolean
  let nowMs: number

  function makeSweeper(): ButlerProactiveSweeper {
    return new ButlerProactiveSweeper({
      rootDir: root,
      composeBrief: async (userId: string) => {
        composeCalls.push(userId)
        return briefText
      },
      push: async (userId: string, text: string) => {
        pushed.push({ userId, text })
        return pushDelivered ? { delivered: true } : { delivered: false, reason: 'no_bridge' }
      },
      logger: silentLogger,
      now: () => nowMs,
    })
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aipe-butler-proactive-'))
    composeCalls = []
    briefText = '早安,今天也照顾好自己。'
    pushed = []
    pushDelivered = true
    // alice opts in for a brief at member-local 08:00; bob has a namespace but no opt-in.
    await buildButlerDailyBriefToolset({ userId: 'alice', rootDir: root }).callTool('set_daily_brief', {
      enabled: true,
      hour: 8,
    })
    await mkdir(join(root, 'user', 'bob'), { recursive: true })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('does not fire before the member-local hour', async () => {
    nowMs = utcForMemberLocal(2026, 6, 1, 6) // 06:00 local, before hour 8
    const sweeper = makeSweeper()
    expect(await sweeper.runOnceForMember('alice')).toEqual({ fired: false, reason: 'before-hour' })
    await sweeper.runOnce()
    expect(pushed).toHaveLength(0)
    expect(composeCalls).toHaveLength(0) // gated BEFORE compose — no wasted LLM call
    expect((await readButlerProactiveConfig(root, 'alice'))?.lastSentDate).toBeUndefined()
  })

  it('fires once at/after the hour, marks the day, and never touches another member', async () => {
    nowMs = utcForMemberLocal(2026, 6, 1, 9) // 09:00 local, past hour 8
    const sweeper = makeSweeper()
    await sweeper.runOnce()

    // alice got exactly her brief; the day is marked.
    expect(pushed).toEqual([{ userId: 'alice', text: '早安,今天也照顾好自己。' }])
    expect((await readButlerProactiveConfig(root, 'alice'))?.lastSentDate).toBe('2026-07-01')
    // bob (namespace but no opt-in) was never composed for or pushed to — no-leak.
    expect(composeCalls).toEqual(['alice'])
    expect(await readButlerProactiveConfig(root, 'bob')).toBeNull()

    // A second sweep the SAME day does not re-send (dedup).
    expect(await sweeper.runOnceForMember('alice')).toEqual({ fired: false, reason: 'already-today' })
    await sweeper.runOnce()
    expect(pushed).toHaveLength(1)
  })

  it('a disabled member is skipped', async () => {
    await buildButlerDailyBriefToolset({ userId: 'alice', rootDir: root }).callTool('set_daily_brief', {
      enabled: false,
    })
    nowMs = utcForMemberLocal(2026, 6, 1, 9)
    const sweeper = makeSweeper()
    expect(await sweeper.runOnceForMember('alice')).toEqual({ fired: false, reason: 'disabled' })
    await sweeper.runOnce()
    expect(pushed).toHaveLength(0)
  })

  it('nothing-to-say stays silent but still marks the day (one attempt/day)', async () => {
    briefText = null // composer declines (no curated profile / SKIP)
    nowMs = utcForMemberLocal(2026, 6, 1, 9)
    const sweeper = makeSweeper()
    expect(await sweeper.runOnceForMember('alice')).toEqual({ fired: false, reason: 'nothing-to-say' })
    expect(pushed).toHaveLength(0) // silent
    expect((await readButlerProactiveConfig(root, 'alice'))?.lastSentDate).toBe('2026-07-01') // marked
  })

  it('a delivery miss is NOT marked and retries the next tick', async () => {
    nowMs = utcForMemberLocal(2026, 6, 2, 9) // 2026-07-02 09:00 local
    pushDelivered = false
    const sweeper = makeSweeper()

    expect(await sweeper.runOnceForMember('alice')).toEqual({ fired: false, reason: 'delivery-failed' })
    expect(pushed).toHaveLength(1) // attempted
    expect((await readButlerProactiveConfig(root, 'alice'))?.lastSentDate).toBeUndefined() // NOT marked

    // Bridge comes back up — the very next tick (same day) retries and lands.
    pushDelivered = true
    expect(await sweeper.runOnceForMember('alice')).toEqual({ fired: true })
    expect(pushed).toHaveLength(2) // retried
    expect((await readButlerProactiveConfig(root, 'alice'))?.lastSentDate).toBe('2026-07-02') // now marked
  })

  it('fires again on a NEW member-local day', async () => {
    // Day 1 fires + marks.
    nowMs = utcForMemberLocal(2026, 6, 1, 9)
    let sweeper = makeSweeper()
    await sweeper.runOnce()
    expect(pushed).toHaveLength(1)

    // Day 2, past the hour → fires again (dedup is per member-local DATE).
    nowMs = utcForMemberLocal(2026, 6, 2, 9)
    sweeper = makeSweeper()
    expect(await sweeper.runOnceForMember('alice')).toEqual({ fired: true })
    expect(pushed).toHaveLength(2)
    expect((await readButlerProactiveConfig(root, 'alice'))?.lastSentDate).toBe('2026-07-02')
  })
})
