/**
 * LIFE-L1-M2 — tests for the workflow-schedule sweeper.
 *
 * What these pin (all with a fake catalog + fake hub, real files in a temp dir):
 *   1. No intent file ⇒ silent no-op (feature unused costs nothing).
 *   2. A due daily row dispatches through the member gate: declared inputs
 *      copied, scope key FORCE-SET to the row's member, capability from the
 *      resolved workflow — and the mark lands in the STATE file, so the same
 *      tick re-run is `already-fired`.
 *   3. Invalid rows are counted + skipped while valid rows still fire.
 *   4. A due row whose workflow isn't runnable (not published / no surface.me)
 *      is loudly unrunnable and its mark is NOT written (fixing the workflow
 *      lets the same day still fire).
 *   5. A synchronous dispatch throw leaves the mark unwritten (next tick
 *      retries); catalog outage fires nothing (fail closed).
 *   6. A corrupt state file degrades to never-fired instead of wedging shut.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@gotong/core'

import type { ButlerWorkflowSummary } from '../src/personal-butler-workflows.js'
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

// 2026-07-06 00:00 UTC = 08:00 Malaysia (Monday) — at-hour for an 08:00 daily.
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

interface DispatchCall {
  from: string
  origin: { orgId: string; userId: string }
  strategy: { kind: 'capability'; capabilities: string[] }
  payload: Record<string, unknown>
  title: string
}

function makeFakes(opts?: {
  summaries?: ButlerWorkflowSummary[]
  listThrows?: boolean
  dispatchThrowsSync?: boolean
}) {
  const calls: DispatchCall[] = []
  const workflows = {
    async list(): Promise<ButlerWorkflowSummary[]> {
      if (opts?.listThrows) throw new Error('catalog offline')
      return opts?.summaries ?? [publishedSummary('wf-brief')]
    },
  }
  const hub = {
    dispatch(input: DispatchCall): Promise<unknown> {
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
  inputs: { topic: 'news', case_id: 'u-attacker', extra: 'dropped' },
  enabled: true,
  ...over,
})

describe('WorkflowScheduleSweeper', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gotong-wfsched-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function sweeper(fakes: ReturnType<typeof makeFakes>, nowMs = MON_0800_LOCAL) {
    return new WorkflowScheduleSweeper({
      spaceDir: dir,
      workflows: fakes.workflows,
      hub: fakes.hub,
      logger: silentLogger,
      clock: () => nowMs,
    })
  }

  async function writeIntent(rows: unknown[]): Promise<void> {
    await writeFile(join(dir, WORKFLOW_SCHEDULES_FILE), JSON.stringify(rows), 'utf8')
  }

  it('is a silent no-op when the intent file does not exist', async () => {
    const fakes = makeFakes()
    const out = await sweeper(fakes).runOnce()
    expect(out).toEqual({ fired: [], notDue: 0, invalid: 0, unrunnable: [] })
    expect(fakes.calls).toHaveLength(0)
  })

  it('fires a due daily row through the member gate and persists the mark', async () => {
    await writeIntent([row()])
    const fakes = makeFakes()
    const s = sweeper(fakes)

    const out = await s.runOnce()
    expect(out.fired).toEqual(['sched-1'])
    expect(fakes.calls).toHaveLength(1)
    const call = fakes.calls[0]!
    // Declared input copied; scope key FORCE-SET to the row's member (the
    // hand-written case_id 'u-attacker' must be overwritten); undeclared extras dropped.
    expect(call.payload).toEqual({ topic: 'news', case_id: 'u-emir' })
    expect(call.origin).toEqual({ orgId: 'local', userId: 'u-emir' })
    expect(call.strategy).toEqual({ kind: 'capability', capabilities: ['cap.wf-brief'] })

    const state = JSON.parse(await readFile(join(dir, WORKFLOW_SCHEDULES_STATE_FILE), 'utf8'))
    expect(state['sched-1']).toBe('2026-07-06')

    // Same tick again → already fired today, nothing new.
    const again = await s.runOnce()
    expect(again.fired).toEqual([])
    expect(again.notDue).toBe(1)
    expect(fakes.calls).toHaveLength(1)
  })

  it('skips invalid rows while valid rows still fire', async () => {
    await writeIntent([
      { id: 'bad', cadence: { kind: 'cron', expr: '*' } }, // missing fields + bad cadence
      row(),
    ])
    const fakes = makeFakes()
    const out = await sweeper(fakes).runOnce()
    expect(out.invalid).toBe(1)
    expect(out.fired).toEqual(['sched-1'])
  })

  it('holds a not-yet-due row without dispatching', async () => {
    await writeIntent([row()])
    const fakes = makeFakes()
    // 07:00 member-local — an hour early.
    const out = await sweeper(fakes, MON_0800_LOCAL - 3_600_000).runOnce()
    expect(out).toMatchObject({ fired: [], notDue: 1 })
    expect(fakes.calls).toHaveLength(0)
  })

  it('flags a due row whose workflow is not runnable and does NOT mark it', async () => {
    await writeIntent([row()])
    // Catalog has the workflow but unpublished — the member gate must refuse.
    const fakes = makeFakes({
      summaries: [{ ...publishedSummary('wf-brief'), state: 'draft' }],
    })
    const out = await sweeper(fakes).runOnce()
    expect(out.unrunnable).toEqual(['sched-1'])
    expect(fakes.calls).toHaveLength(0)
    // No state file written — publishing the workflow lets today still fire.
    await expect(readFile(join(dir, WORKFLOW_SCHEDULES_STATE_FILE), 'utf8')).rejects.toThrow()
  })

  it('leaves the mark unwritten on a synchronous dispatch throw (next tick retries)', async () => {
    await writeIntent([row()])
    const fakes = makeFakes({ dispatchThrowsSync: true })
    const out = await sweeper(fakes).runOnce()
    expect(out.fired).toEqual([])
    await expect(readFile(join(dir, WORKFLOW_SCHEDULES_STATE_FILE), 'utf8')).rejects.toThrow()
  })

  it('fires nothing when the catalog list throws (fail closed)', async () => {
    await writeIntent([row()])
    const fakes = makeFakes({ listThrows: true })
    const out = await sweeper(fakes).runOnce()
    expect(out.fired).toEqual([])
    expect(out.unrunnable).toEqual(['sched-1'])
    expect(fakes.calls).toHaveLength(0)
  })

  it('treats a corrupt state file as never-fired instead of wedging shut', async () => {
    await writeIntent([row()])
    await writeFile(join(dir, WORKFLOW_SCHEDULES_STATE_FILE), '{{{not json', 'utf8')
    const fakes = makeFakes()
    const out = await sweeper(fakes).runOnce()
    expect(out.fired).toEqual(['sched-1'])
  })

  it('fires an interval row immediately, then honours the elapsed gate', async () => {
    await writeIntent([row({ id: 'poll', cadence: { kind: 'interval', everyMs: 120_000 } })])
    const fakes = makeFakes()
    const first = await sweeper(fakes, MON_0800_LOCAL).runOnce()
    expect(first.fired).toEqual(['poll'])
    const tooSoon = await sweeper(fakes, MON_0800_LOCAL + 60_000).runOnce()
    expect(tooSoon).toMatchObject({ fired: [], notDue: 1 })
    const elapsed = await sweeper(fakes, MON_0800_LOCAL + 120_000).runOnce()
    expect(elapsed.fired).toEqual(['poll'])
    expect(fakes.calls).toHaveLength(2)
  })
})
