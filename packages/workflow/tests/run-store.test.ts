import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RunStore, type RunState } from '../src/index.js'

let tmp: string
let store: RunStore

function makeRun(overrides: Partial<RunState> & Pick<RunState, 'runId' | 'workflowId' | 'startedAt' | 'status'>): RunState {
  return {
    triggeredByTaskId: 't_x',
    triggerPayload: { hi: 'there' },
    steps: [],
    ...overrides,
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aipehub-runstore-'))
  store = new RunStore(tmp)
  store.ensureDirs()
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('RunStore.write / read / pathFor', () => {
  it('roundtrips a run via the atomic write/read pair', async () => {
    const state = makeRun({
      runId: 'r_1',
      workflowId: 'wf_a',
      startedAt: 1000,
      endedAt: 1010,
      status: 'done',
      finalOutput: 'ok',
    })
    await store.write(state)
    expect(store.pathFor('r_1')).toBe(join(store.runsDir, 'r_1.json'))
    const back = await store.read('r_1')
    expect(back).toEqual(state)
  })

  it('read() returns null for missing files', async () => {
    expect(await store.read('nope')).toBeNull()
  })
})

describe('RunStore.listRuns', () => {
  it('sorts by startedAt desc and projects only summary fields', async () => {
    await store.write(makeRun({ runId: 'r_old', workflowId: 'wf_a', startedAt: 100, status: 'done', endedAt: 110, finalOutput: 'huge payload here' }))
    await store.write(makeRun({ runId: 'r_new', workflowId: 'wf_a', startedAt: 500, status: 'running', steps: [
      { stepId: 's1', startedAt: 501, status: 'done', attempts: 1, subTaskIds: [] },
    ] }))
    await store.write(makeRun({ runId: 'r_mid', workflowId: 'wf_b', startedAt: 300, status: 'failed', endedAt: 310, error: 'kaboom' }))

    const rows = await store.listRuns()
    expect(rows.map((r) => r.runId)).toEqual(['r_new', 'r_mid', 'r_old'])

    const newRow = rows[0]!
    expect(newRow).toEqual({
      runId: 'r_new',
      workflowId: 'wf_a',
      triggeredByTaskId: 't_x',
      status: 'running',
      startedAt: 500,
      stepCount: 1,
    })
    expect('finalOutput' in newRow).toBe(false)

    const midRow = rows[1]!
    expect(midRow.status).toBe('failed')
    expect(midRow.endedAt).toBe(310)
    expect(midRow.error).toBe('kaboom')
  })

  it('filters by workflowId', async () => {
    await store.write(makeRun({ runId: 'r_a1', workflowId: 'wf_a', startedAt: 100, status: 'done' }))
    await store.write(makeRun({ runId: 'r_b1', workflowId: 'wf_b', startedAt: 200, status: 'done' }))
    await store.write(makeRun({ runId: 'r_a2', workflowId: 'wf_a', startedAt: 300, status: 'done' }))

    const onlyA = await store.listRuns({ workflowId: 'wf_a' })
    expect(onlyA.map((r) => r.runId)).toEqual(['r_a2', 'r_a1'])
  })

  it('respects limit (kept after sort)', async () => {
    for (let i = 0; i < 5; i++) {
      await store.write(makeRun({ runId: `r_${i}`, workflowId: 'wf', startedAt: i * 100, status: 'done' }))
    }
    const top2 = await store.listRuns({ limit: 2 })
    expect(top2.map((r) => r.runId)).toEqual(['r_4', 'r_3'])
  })

  it('returns [] when runs dir is missing', async () => {
    const fresh = new RunStore(join(tmp, 'never-touched'))
    expect(await fresh.listRuns()).toEqual([])
  })
})
