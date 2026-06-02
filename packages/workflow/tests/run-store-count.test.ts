import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RunStore, type RunState } from '../src/index.js'

/**
 * Route B P0-M3 (M3-M3) — `RunStore.countRuns` gives `/metrics` an EXACT
 * by-status tally over the active run set, replacing the old fixed 2000-row
 * sample. These pin each guard independently (改坏即红):
 *   - all four statuses are seeded, so an absent status reports 0 (not missing);
 *   - the tally + total are correct;
 *   - archived runs are excluded (the scan reads the active path only) — which
 *     is what makes the count O(tail) once retention prunes;
 *   - the workflowId filter narrows the count;
 *   - an empty/missing dir reports zeros, never throws.
 */

let tmp: string
let store: RunStore

function makeRun(
  over: Partial<RunState> & Pick<RunState, 'runId' | 'workflowId' | 'startedAt' | 'status'>,
): RunState {
  return { triggeredByTaskId: 't_x', triggerPayload: {}, steps: [], ...over }
}

function terminal(runId: string, end: number, workflowId = 'wf'): RunState {
  return makeRun({ runId, workflowId, startedAt: end, endedAt: end, status: 'done' })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aipehub-runcount-'))
  store = new RunStore(tmp)
  store.ensureDirs()
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('RunStore.countRuns (Route B P0-M3 M3-M3)', () => {
  it('tallies active runs by status with all four statuses seeded', async () => {
    await store.write(makeRun({ runId: 'r1', workflowId: 'wf', startedAt: 10, status: 'running' }))
    await store.write(terminal('r2', 20))
    await store.write(terminal('r3', 30))
    await store.write(makeRun({ runId: 'r4', workflowId: 'wf', startedAt: 40, endedAt: 41, status: 'failed' }))

    const counts = await store.countRuns()
    // `cancelled: 0` present despite no cancelled run ⇒ the seed is what's tested.
    expect(counts).toEqual({ total: 4, byStatus: { running: 1, done: 2, failed: 1, cancelled: 0 } })
  })

  it('excludes archived runs — the count is over the active path only', async () => {
    for (const end of [100, 200, 300]) await store.write(terminal(`r_${end}`, end))
    await store.write(makeRun({ runId: 'r_run', workflowId: 'wf', startedAt: 50, status: 'running' }))
    expect((await store.countRuns()).total).toBe(4)

    // Prune the 3 terminal runs into runs/archive/.
    await store.archiveRuns({ keepLast: 0 })

    const counts = await store.countRuns()
    expect(counts.total).toBe(1) // only the running run remains active
    expect(counts.byStatus).toEqual({ running: 1, done: 0, failed: 0, cancelled: 0 })
  })

  it('filters by workflowId', async () => {
    await store.write(terminal('a1', 10, 'wf_a'))
    await store.write(terminal('b1', 20, 'wf_b'))
    await store.write(makeRun({ runId: 'a2', workflowId: 'wf_a', startedAt: 30, status: 'running' }))

    const counts = await store.countRuns({ workflowId: 'wf_a' })
    expect(counts.total).toBe(2)
    expect(counts.byStatus.running).toBe(1)
    expect(counts.byStatus.done).toBe(1)
  })

  it('returns zeros for an empty / missing runs dir', async () => {
    const fresh = new RunStore(join(tmp, 'never-touched'))
    expect(await fresh.countRuns()).toEqual({
      total: 0,
      byStatus: { running: 0, done: 0, failed: 0, cancelled: 0 },
    })
  })
})
