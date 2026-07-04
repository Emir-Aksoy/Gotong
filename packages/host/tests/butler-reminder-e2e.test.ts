/**
 * butler-reminder-e2e.test.ts — the S3-M1 acceptance gate for the resident
 * butler's reminders.
 *
 * A member asks the butler to remind them; the butler's benign `set_reminder`
 * tool dispatches to the `ReminderParticipant`, which PARKS a one-shot task with a
 * FINITE resumeAt; the Phase 11 resume sweep fires it at the time and pushes the
 * text back to the member's IM. This proves the whole chain on a real Hub with a
 * production-shaped suspendNotifier + a manual sweep (the same lightweight harness
 * the A2A long-running-step gate uses):
 *
 *   set_reminder tool → hub.dispatch → broker parks (finite resumeAt) → sweep
 *   resumes → injected push fires「【提醒】…」to the member.
 *
 * Plus the two things a deterministic demo can't: a bad time NEVER parks (the
 * broker throws, the tool refuses), and a fired reminder always reaches whoever
 * SET it (origin over a payload-spoofed userId — defence in depth).
 */

import { describe, it, expect } from 'vitest'

import { Hub, InMemoryStorage, type Task, type TaskResult } from '@gotong/core'

import {
  ReminderParticipant,
  REMINDER_CAPABILITY,
  REMINDER_PARTICIPANT_ID,
  parseReminderPayload,
  ReminderError,
} from '../src/reminder-participant.js'
import { buildButlerRemindersToolset } from '../src/personal-butler-reminders.js'

const NEVER_RESUME_AT = 9_999_999_999_000

// ---------------------------------------------------------------------------
// parseReminderPayload — pure validation
// ---------------------------------------------------------------------------

describe('parseReminderPayload (pure)', () => {
  // 2026-07-01T06:00:00Z — a fixed "now" the fixtures are relative to.
  const NOW = Date.UTC(2026, 6, 1, 6, 0, 0)

  it('accepts a well-formed future ISO with offset', () => {
    const r = parseReminderPayload(
      { userId: 'alice', when: '2026-07-01T14:30:00+08:00', text: '  喝水  ' },
      NOW,
    )
    expect(r.userId).toBe('alice')
    expect(r.text).toBe('喝水') // trimmed
    expect(r.whenMs).toBe(Date.parse('2026-07-01T14:30:00+08:00'))
    expect(r.whenMs).toBeGreaterThan(NOW)
  })

  it('rejects a time with no explicit offset (host-TZ ambiguous)', () => {
    expect(() => parseReminderPayload({ userId: 'a', when: '2026-07-01T14:30:00', text: 'x' }, NOW))
      .toThrowError(ReminderError)
    try {
      parseReminderPayload({ userId: 'a', when: '2026-07-01T14:30:00', text: 'x' }, NOW)
    } catch (e) {
      expect((e as ReminderError).code).toBe('missing_offset')
    }
  })

  it('rejects a past time', () => {
    try {
      parseReminderPayload({ userId: 'a', when: '2026-07-01T05:00:00Z', text: 'x' }, NOW)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ReminderError).code).toBe('in_past')
    }
  })

  it('rejects a time beyond the one-year window', () => {
    try {
      parseReminderPayload({ userId: 'a', when: '2027-08-01T00:00:00Z', text: 'x' }, NOW)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ReminderError).code).toBe('too_far')
    }
  })

  it('rejects an unparseable time that still looks offset-suffixed', () => {
    try {
      parseReminderPayload({ userId: 'a', when: 'not-a-date+08:00', text: 'x' }, NOW)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ReminderError).code).toBe('bad_time')
    }
  })

  it('rejects empty text', () => {
    try {
      parseReminderPayload({ userId: 'a', when: '2026-07-01T14:30:00+08:00', text: '   ' }, NOW)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ReminderError).code).toBe('empty_text')
    }
  })

  it('rejects a non-object / missing userId payload', () => {
    expect(() => parseReminderPayload('nope', NOW)).toThrowError(ReminderError)
    try {
      parseReminderPayload({ when: '2026-07-01T14:30:00+08:00', text: 'x' }, NOW)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ReminderError).code).toBe('invalid_payload')
    }
  })
})

// ---------------------------------------------------------------------------
// Real-stack acceptance gate
// ---------------------------------------------------------------------------

/** A parked row, captured exactly as the host's SQLite suspendNotifier captures it. */
interface Parked {
  task: Task
  by: string
  state: unknown
  resumeAt: number
}

/** Build a Hub with a production-shaped suspendNotifier that captures parks, a
 * registered ReminderParticipant whose push is recorded, and a manual sweep. */
async function boot() {
  const parked = new Map<string, Parked>()
  const pushed: Array<{ userId: string; text: string }> = []

  const hub = new Hub({
    storage: new InMemoryStorage(),
    suspendNotifier: (task, by, s) => {
      parked.set(task.id, { task, by, state: s.state, resumeAt: s.resumeAt })
    },
  })
  await hub.start()

  hub.register(
    new ReminderParticipant({
      push: (userId, text) => {
        pushed.push({ userId, text })
        return Promise.resolve({ delivered: true })
      },
    }),
  )

  /** One sweep tick: resume every parked row; drop those that settle. */
  async function sweep(): Promise<void> {
    for (const row of [...parked.values()]) {
      const result: TaskResult = await hub.resumeTask(row.by, row.task, row.state)
      if (result.kind !== 'suspended') parked.delete(row.task.id)
    }
  }

  return { hub, parked, pushed, sweep }
}

describe('butler-reminder-e2e — set_reminder → park → sweep → push (acceptance gate)', () => {
  it('schedules a reminder that fires to the member on resume', async () => {
    const r = await boot()
    const tools = buildButlerRemindersToolset({ userId: 'alice', hub: r.hub })

    const when = new Date(Date.now() + 30 * 60_000).toISOString() // 30 min out, UTC 'Z'
    const out = await tools.callTool('set_reminder', { when, text: '喝水' })

    // The tool confirms inline (the butler turn never suspended).
    expect(out.isError).toBeFalsy()
    expect(out.content[0]).toMatchObject({ type: 'text' })
    expect((out.content[0] as { text: string }).text).toContain('已设定提醒')

    // Exactly one parked row, on the reminder broker, at a FINITE resumeAt = the
    // reminder instant (a TIMER wakes it, unlike an inbox's NEVER_RESUME_AT).
    expect(r.parked.size).toBe(1)
    const row = [...r.parked.values()][0]
    expect(row.by).toBe(REMINDER_PARTICIPANT_ID)
    expect(row.resumeAt).toBe(Date.parse(when))
    expect(row.resumeAt).toBeLessThan(NEVER_RESUME_AT)
    expect(r.pushed).toHaveLength(0) // not fired yet

    // The sweep fires it: push receives the reminder, and the row settles (removed).
    await r.sweep()
    expect(r.pushed).toEqual([{ userId: 'alice', text: '【提醒】喝水' }])
    expect(r.parked.size).toBe(0)
  })

  it('refuses a past time — never parks, never pushes', async () => {
    const r = await boot()
    const tools = buildButlerRemindersToolset({ userId: 'alice', hub: r.hub })

    const past = new Date(Date.now() - 60_000).toISOString()
    const out = await tools.callTool('set_reminder', { when: past, text: '喝水' })

    expect(out.isError).toBe(true)
    expect((out.content[0] as { text: string }).text).toContain('过去')
    expect(r.parked.size).toBe(0) // broker threw before parking
    expect(r.pushed).toHaveLength(0)
  })

  it('refuses a naive time with no timezone offset', async () => {
    const r = await boot()
    const tools = buildButlerRemindersToolset({ userId: 'alice', hub: r.hub })

    const out = await tools.callTool('set_reminder', { when: '2026-12-31T09:00:00', text: 'x' })

    expect(out.isError).toBe(true)
    expect((out.content[0] as { text: string }).text).toContain('时区偏移')
    expect(r.parked.size).toBe(0)
  })

  it('fires to whoever SET the reminder (origin over a spoofed payload userId)', async () => {
    const r = await boot()
    // Dispatch RAW (bypassing the tool) with a spoofed payload.userId but the real
    // origin = 'alice'. handleResume prefers task.origin.userId — defence in depth,
    // so a reminder always reaches its setter, never a payload-injected target.
    const when = new Date(Date.now() + 30 * 60_000).toISOString()
    const result = (await r.hub.dispatch({
      from: 'alice',
      origin: { orgId: 'local', userId: 'alice' },
      strategy: { kind: 'capability', capabilities: [REMINDER_CAPABILITY] },
      payload: { userId: 'mallory', when, text: '密' },
      title: 'raw reminder',
    })) as TaskResult
    expect(result.kind).toBe('suspended')

    await r.sweep()
    expect(r.pushed).toEqual([{ userId: 'alice', text: '【提醒】密' }])
  })
})
