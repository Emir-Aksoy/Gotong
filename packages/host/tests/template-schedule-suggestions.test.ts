/**
 * FDE-M3 — tests for the installed-pack schedule-suggestion registry
 * (`template-schedule-suggestions.json`).
 *
 * What these pin (store posture is verbatim the M1b connector-slot registry):
 *   1. record → list round-trip preserves workflowId/cadence/inputs/note;
 *      human-readable JSON with a top-level packs[].
 *   2. Install identity: re-record replaces (last install wins); recording []
 *      REMOVES the entry (a reinstall that dropped `schedules` stops nagging).
 *   3. Advisory failure posture: missing file → [], corrupt → [], malformed
 *      entry skipped, next record() repairs the file, blank pack no-op.
 *   4. FDE-M3-specific: the persisted cadence re-runs the SAME normaliser as
 *      parse/fire on load — a hand-edited cadence that no longer parses drops
 *      the entry rather than surfacing a guess (LIFE fail posture).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  TEMPLATE_SCHEDULE_SUGGESTIONS_FILE,
  createScheduleSuggestionStore,
} from '../src/template-schedule-suggestions.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gotong-sched-sugg-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const store = () =>
  createScheduleSuggestionStore({ spaceDir: dir, now: () => Date.UTC(2026, 6, 6) })

const DAILY8 = { kind: 'daily', hour: 8, tzOffsetMinutes: 480 } as const

describe('createScheduleSuggestionStore', () => {
  it('lists [] when no pack was ever recorded (no file)', async () => {
    expect(await store().list()).toEqual([])
  })

  it('round-trips a recorded pack with full suggestion fields', async () => {
    const s = store()
    await s.record('morning-brief-hub', [
      { workflowId: 'morning-brief', cadence: DAILY8, inputs: { focus: '高效开始这一天' }, note: '装完补人启用' },
      { workflowId: 'weekly-review', cadence: { kind: 'weekly', weekday: 1, hour: 9, tzOffsetMinutes: 0 } },
    ])
    const rows = await s.list()
    expect(rows).toEqual([
      {
        pack: 'morning-brief-hub',
        installedAt: '2026-07-06T00:00:00.000Z',
        schedules: [
          {
            workflowId: 'morning-brief',
            cadence: DAILY8,
            inputs: { focus: '高效开始这一天' },
            note: '装完补人启用',
          },
          {
            workflowId: 'weekly-review',
            cadence: { kind: 'weekly', weekday: 1, hour: 9, tzOffsetMinutes: 0 },
          },
        ],
      },
    ])
    const raw = JSON.parse(
      await readFile(join(dir, TEMPLATE_SCHEDULE_SUGGESTIONS_FILE), 'utf8'),
    )
    expect(Array.isArray(raw.packs)).toBe(true)
  })

  it('replaces on re-record (last install wins) and keeps other packs', async () => {
    const s = store()
    await s.record('pack-a', [{ workflowId: 'wf-1', cadence: DAILY8 }])
    await s.record('pack-b', [{ workflowId: 'wf-2', cadence: DAILY8 }])
    await s.record('pack-a', [{ workflowId: 'wf-3', cadence: DAILY8 }])
    const rows = await s.list()
    expect(rows.map((r) => r.pack).sort()).toEqual(['pack-a', 'pack-b'])
    expect(rows.find((r) => r.pack === 'pack-a')?.schedules).toEqual([
      { workflowId: 'wf-3', cadence: DAILY8 },
    ])
  })

  it('recording zero suggestions removes the pack entry', async () => {
    const s = store()
    await s.record('pack-a', [{ workflowId: 'wf-1', cadence: DAILY8 }])
    await s.record('pack-a', [])
    expect(await s.list()).toEqual([])
  })

  it('a blank pack name is a no-op', async () => {
    const s = store()
    await s.record('   ', [{ workflowId: 'wf-1', cadence: DAILY8 }])
    expect(await s.list()).toEqual([])
  })

  it('corrupt JSON / wrong top-level shape → []', async () => {
    const file = join(dir, TEMPLATE_SCHEDULE_SUGGESTIONS_FILE)
    await writeFile(file, '{not json', 'utf8')
    expect(await store().list()).toEqual([])
    await writeFile(file, JSON.stringify(['nope']), 'utf8')
    expect(await store().list()).toEqual([])
  })

  it('skips a malformed pack entry, the rest survive', async () => {
    await writeFile(
      join(dir, TEMPLATE_SCHEDULE_SUGGESTIONS_FILE),
      JSON.stringify({
        packs: [
          { pack: 'good', installedAt: 'x', schedules: [{ workflowId: 'wf', cadence: DAILY8 }] },
          { pack: '', schedules: [] }, // empty pack name
          { pack: 'no-schedules-array' },
          { pack: 'no-workflow-id', schedules: [{ cadence: DAILY8 }] },
        ],
      }),
      'utf8',
    )
    const rows = await store().list()
    expect(rows.map((r) => r.pack)).toEqual(['good'])
  })

  it('a hand-edited cadence that no longer normalises drops the entry (never guess)', async () => {
    await writeFile(
      join(dir, TEMPLATE_SCHEDULE_SUGGESTIONS_FILE),
      JSON.stringify({
        packs: [
          { pack: 'bad-cadence', installedAt: 'x', schedules: [{ workflowId: 'wf', cadence: { kind: 'daily', hour: 24 } }] },
          { pack: 'good', installedAt: 'x', schedules: [{ workflowId: 'wf', cadence: DAILY8 }] },
        ],
      }),
      'utf8',
    )
    const rows = await store().list()
    expect(rows.map((r) => r.pack)).toEqual(['good'])
  })

  it('the next record() rewrites (repairs) a corrupt file', async () => {
    const file = join(dir, TEMPLATE_SCHEDULE_SUGGESTIONS_FILE)
    await writeFile(file, '{not json', 'utf8')
    const s = store()
    await s.record('pack-a', [{ workflowId: 'wf-1', cadence: DAILY8 }])
    expect(JSON.parse(await readFile(file, 'utf8')).packs).toHaveLength(1)
    expect(await s.list()).toHaveLength(1)
  })
})
