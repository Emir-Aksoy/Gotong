/**
 * LIFE-L1-M3 — tests for the schedule admin surface + the sweeper's manual fire.
 *
 * What these pin:
 *   1. upsert mints an id when absent, stores the NORMALISED row (tz default
 *      filled), and refuses a row that can't be trusted — file untouched.
 *   2. Round-trip safety: upsert/remove of one row never destroys a foreign
 *      hand-written row that doesn't normalise (it lists as valid:false).
 *   3. remove drops the row AND its orphan state mark; absent id → false.
 *   4. list merges the fact-file mark beside the intent.
 *   5. fireNow ignores due/enabled (试跑 semantics) but NOT the member gate:
 *      unrunnable refuses; success dispatches through the gate and writes the
 *      mark so the same member-local day won't auto-fire again.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@aipehub/core'

import type { ButlerWorkflowSummary } from '../src/personal-butler-workflows.js'
import { createWorkflowScheduleAdminSurface } from '../src/workflow-schedule-admin.js'
import {
  WORKFLOW_SCHEDULES_FILE,
  WORKFLOW_SCHEDULES_STATE_FILE,
  WorkflowScheduleSweeper,
} from '../src/workflow-schedule-sweeper.js'

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
}

// 2026-07-06 00:00 UTC = 08:00 Malaysia (Monday).
const MON_0800_LOCAL = Date.UTC(2026, 6, 6, 0, 0, 0)

const publishedSummary = (id: string): ButlerWorkflowSummary => ({
  id,
  name: id,
  triggerCapability: `cap.${id}`,
  state: 'published',
  surfaceMe: {
    enabled: true,
    inputSchema: [{ id: 'topic' }, { id: 'case_id' }],
  },
})

function makeFakes(opts?: { summaries?: ButlerWorkflowSummary[]; dispatchThrowsSync?: boolean }) {
  const calls: Array<Record<string, unknown>> = []
  const workflows = {
    async list(): Promise<ButlerWorkflowSummary[]> {
      return opts?.summaries ?? [publishedSummary('wf-brief')]
    },
  }
  const hub = {
    dispatch(input: Record<string, unknown>): Promise<unknown> {
      if (opts?.dispatchThrowsSync) throw new Error('hub rejected synchronously')
      calls.push(input)
      return Promise.resolve({ kind: 'ok' })
    },
  }
  return { workflows, hub, calls }
}

const row = (over?: Record<string, unknown>) => ({
  id: 'sched-1',
  workflowId: 'wf-brief',
  userId: 'u-emir',
  cadence: { kind: 'daily', hour: 8, tzOffsetMinutes: 480 },
  enabled: true,
  ...over,
})

describe('workflow-schedule admin surface', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aipe-wfsched-admin-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function make(fakes = makeFakes(), nowMs = MON_0800_LOCAL) {
    const sweeper = new WorkflowScheduleSweeper({
      spaceDir: dir,
      workflows: fakes.workflows,
      hub: fakes.hub,
      logger: silentLogger,
      clock: () => nowMs,
    })
    const admin = createWorkflowScheduleAdminSurface({
      spaceDir: dir,
      sweeper,
      logger: silentLogger,
    })
    return { admin, sweeper, fakes }
  }

  it('upsert mints an id, fills the tz default, and persists the normalised row', async () => {
    const { admin } = make()
    const out = await admin.upsert({
      workflowId: 'wf-brief',
      userId: 'u-emir',
      cadence: { kind: 'daily', hour: 8 },
      enabled: true,
    })
    if (!out.ok) throw new Error('expected ok')
    expect(out.schedule.id).toMatch(/^sched-/)
    expect(out.schedule.cadence).toEqual({ kind: 'daily', hour: 8, tzOffsetMinutes: 480 })

    const onDisk = JSON.parse(await readFile(join(dir, WORKFLOW_SCHEDULES_FILE), 'utf8'))
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0].id).toBe(out.schedule.id)
    expect(onDisk[0].cadence.tzOffsetMinutes).toBe(480)
  })

  it('upsert refuses an untrustworthy row and leaves the file untouched', async () => {
    const { admin } = make()
    const out = await admin.upsert({ workflowId: 'wf-brief', cadence: { kind: 'cron' } })
    expect(out).toEqual({ ok: false, error: 'invalid_schedule' })
    await expect(readFile(join(dir, WORKFLOW_SCHEDULES_FILE), 'utf8')).rejects.toThrow()
  })

  it('upsert replaces by id and round-trips a foreign invalid row untouched', async () => {
    const foreign = { id: 'draft-x', note: '手写草稿，还没配 cadence' }
    await writeFile(join(dir, WORKFLOW_SCHEDULES_FILE), JSON.stringify([foreign, row()]), 'utf8')
    const { admin } = make()

    const out = await admin.upsert(row({ cadence: { kind: 'daily', hour: 9 } }))
    if (!out.ok) throw new Error('expected ok')

    const onDisk = JSON.parse(await readFile(join(dir, WORKFLOW_SCHEDULES_FILE), 'utf8'))
    expect(onDisk).toHaveLength(2)
    expect(onDisk[0]).toEqual(foreign) // untouched, byte-for-byte content
    expect(onDisk[1].cadence.hour).toBe(9)

    const views = await admin.list()
    expect(views.find((v) => v.id === 'draft-x')?.valid).toBe(false)
    expect(views.find((v) => v.id === 'sched-1')?.valid).toBe(true)
  })

  it('remove drops the row and its orphan mark; absent id → false', async () => {
    await writeFile(join(dir, WORKFLOW_SCHEDULES_FILE), JSON.stringify([row()]), 'utf8')
    await writeFile(
      join(dir, WORKFLOW_SCHEDULES_STATE_FILE),
      JSON.stringify({ 'sched-1': '2026-07-05', other: 'kept' }),
      'utf8',
    )
    const { admin } = make()

    expect(await admin.remove('nope')).toBe(false)
    expect(await admin.remove('sched-1')).toBe(true)

    const onDisk = JSON.parse(await readFile(join(dir, WORKFLOW_SCHEDULES_FILE), 'utf8'))
    expect(onDisk).toEqual([])
    const state = JSON.parse(await readFile(join(dir, WORKFLOW_SCHEDULES_STATE_FILE), 'utf8'))
    expect(state).toEqual({ other: 'kept' })
  })

  it('list merges the fact-file mark beside the intent', async () => {
    await writeFile(join(dir, WORKFLOW_SCHEDULES_FILE), JSON.stringify([row()]), 'utf8')
    await writeFile(
      join(dir, WORKFLOW_SCHEDULES_STATE_FILE),
      JSON.stringify({ 'sched-1': '2026-07-05' }),
      'utf8',
    )
    const { admin } = make()
    const views = await admin.list()
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ id: 'sched-1', valid: true, lastFiredMark: '2026-07-05' })
  })

  it('fire dispatches a DISABLED row through the member gate and writes the mark', async () => {
    // 试跑 semantics: enabled=false and already-fired-today both yield to an
    // explicit human ask — but the member gate still applies (next test).
    await writeFile(
      join(dir, WORKFLOW_SCHEDULES_FILE),
      JSON.stringify([row({ enabled: false, inputs: { topic: 'news', case_id: 'u-attacker' } })]),
      'utf8',
    )
    const { admin, fakes } = make()
    const out = await admin.fire('sched-1')
    expect(out).toEqual({
      ok: true,
      scheduleId: 'sched-1',
      workflowId: 'wf-brief',
      userId: 'u-emir',
      mark: '2026-07-06',
    })
    expect(fakes.calls).toHaveLength(1)
    expect(fakes.calls[0]!.payload).toEqual({ topic: 'news', case_id: 'u-emir' })

    const state = JSON.parse(await readFile(join(dir, WORKFLOW_SCHEDULES_STATE_FILE), 'utf8'))
    expect(state['sched-1']).toBe('2026-07-06')
  })

  it('fire maps the failure ladder: not_found / invalid / unrunnable / dispatch_failed', async () => {
    await writeFile(
      join(dir, WORKFLOW_SCHEDULES_FILE),
      JSON.stringify([{ id: 'bad', cadence: { kind: 'cron' } }, row()]),
      'utf8',
    )
    const { admin } = make(makeFakes({ summaries: [{ ...publishedSummary('wf-brief'), state: 'draft' }] }))
    expect(await admin.fire('nope')).toEqual({ ok: false, reason: 'not_found' })
    expect(await admin.fire('bad')).toEqual({ ok: false, reason: 'invalid' })
    expect(await admin.fire('sched-1')).toEqual({ ok: false, reason: 'unrunnable' })

    const throwing = make(makeFakes({ dispatchThrowsSync: true }))
    expect(await throwing.admin.fire('sched-1')).toEqual({ ok: false, reason: 'dispatch_failed' })
    // dispatch never reached the hub → no mark written
    await expect(readFile(join(dir, WORKFLOW_SCHEDULES_STATE_FILE), 'utf8')).rejects.toThrow()
  })
})
