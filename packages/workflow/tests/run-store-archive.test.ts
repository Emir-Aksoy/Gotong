import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RunStore, type RunState } from '../src/index.js'

/**
 * Route B P0-M3 (M3-M1) — `RunStore.archiveRuns` bounds the active run scan.
 *
 * Mirrors the transcript archive (M2-M2): old TERMINAL runs move into
 * `runs/archive/`, which the non-recursive `listRunIds` skips, so boot-resume /
 * listRuns / metrics walk O(tail) instead of O(all). These pin every guard
 * independently so each is falsifiable (改坏即红):
 *   - empty options are a no-op (never archive by accident);
 *   - a `running` run is NEVER archived (resume safety — the highest-stakes one);
 *   - `keepLast` protects the newest terminal runs;
 *   - `before` only archives runs that ended before the cutoff;
 *   - the two combine as AND (unprotected AND old enough);
 *   - archived runs stay readable for audit, and leave the active scan.
 */

let tmp: string
let store: RunStore

function makeRun(
  over: Partial<RunState> & Pick<RunState, 'runId' | 'workflowId' | 'startedAt' | 'status'>,
): RunState {
  return {
    triggeredByTaskId: 't_x',
    triggerPayload: { hi: 'there' },
    steps: [],
    ...over,
  }
}

/** A finished run keyed at `end` for both startedAt and endedAt. */
function terminal(runId: string, end: number, status: RunState['status'] = 'done'): RunState {
  return makeRun({ runId, workflowId: 'wf', startedAt: end, endedAt: end, status, finalOutput: `out-${runId}` })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aipehub-runarchive-'))
  store = new RunStore(tmp)
  store.ensureDirs()
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('RunStore.archiveRuns (Route B P0-M3 M3-M1)', () => {
  it('moves old terminal runs out of the active scan; archived stay readable', async () => {
    for (const end of [100, 200, 300, 400, 500]) await store.write(terminal(`r_${end}`, end))

    // keepLast:2 protects the 2 newest (r_500, r_400) ⇒ 3 archived.
    const moved = await store.archiveRuns({ keepLast: 2 })
    expect(new Set(moved)).toEqual(new Set(['r_300', 'r_200', 'r_100']))

    // Active scans now see only the retained tail.
    expect((await store.listRunIds()).sort()).toEqual(['r_400', 'r_500'])
    expect((await store.listRuns()).map((r) => r.runId)).toEqual(['r_500', 'r_400'])

    // Archived runs left the active path but are fully retrievable for audit.
    expect((await store.listArchivedRunIds()).sort()).toEqual(['r_100', 'r_200', 'r_300'])
    expect(await store.read('r_100')).toBeNull() // gone from active
    const archived = await store.readArchived('r_100')
    expect(archived?.runId).toBe('r_100')
    expect(archived?.finalOutput).toBe('out-r_100') // full state, not a summary
  })

  it('NEVER archives a running run, even when it is the oldest (resume safety)', async () => {
    // The running run is the oldest by time key — a naive "archive oldest" would
    // grab it. The status guard must keep it on the active path for boot-resume.
    await store.write(makeRun({ runId: 'r_run', workflowId: 'wf', startedAt: 50, status: 'running' }))
    await store.write(terminal('r_done1', 100))
    await store.write(terminal('r_done2', 200))

    const moved = await store.archiveRuns({ keepLast: 0 }) // archive ALL eligible
    expect(new Set(moved)).toEqual(new Set(['r_done1', 'r_done2']))
    expect(moved).not.toContain('r_run')

    // The running run is still on the active path (resume can find it)…
    expect(await store.listRunIds()).toEqual(['r_run'])
    // …and was never moved into the archive.
    expect(await store.listArchivedRunIds()).not.toContain('r_run')
  })

  it('also protects a human-inbox-parked run (status stays "running")', async () => {
    // A parked HITL run carries status:'running' with a suspended step — the
    // same guard must keep it active so the inbox resolve can resume it.
    await store.write(
      makeRun({
        runId: 'r_parked',
        workflowId: 'wf',
        startedAt: 10,
        status: 'running',
        steps: [{ stepId: 's1', startedAt: 11, status: 'suspended', attempts: 1, subTaskIds: [], resumeAt: 9_999_999_999_000 }],
      }),
    )
    await store.write(terminal('r_done', 500))

    const moved = await store.archiveRuns({ keepLast: 0 })
    expect(moved).toEqual(['r_done'])
    expect(await store.listRunIds()).toEqual(['r_parked'])
  })

  it('only archives runs that ended before `before`', async () => {
    for (const end of [100, 200, 300]) await store.write(terminal(`r_${end}`, end))

    const moved = await store.archiveRuns({ before: 250 })
    expect(new Set(moved)).toEqual(new Set(['r_100', 'r_200'])) // < 250 only
    expect((await store.listRunIds()).sort()).toEqual(['r_300']) // 300 >= 250 kept
  })

  it('combines keepLast and before as AND (unprotected AND old enough)', async () => {
    for (const end of [100, 200, 300, 400, 500]) await store.write(terminal(`r_${end}`, end))

    // keepLast:1 protects r_500; before:350 spares r_400 (>=350) but archives
    // r_300/r_200/r_100. A run must be BOTH unprotected AND old to move.
    const moved = await store.archiveRuns({ keepLast: 1, before: 350 })
    expect(new Set(moved)).toEqual(new Set(['r_300', 'r_200', 'r_100']))
    expect((await store.listRunIds()).sort()).toEqual(['r_400', 'r_500'])
  })

  it('is a no-op with empty options — never archives by accident', async () => {
    for (const end of [100, 200, 300]) await store.write(terminal(`r_${end}`, end))

    expect(await store.archiveRuns()).toEqual([])
    expect(await store.archiveRuns({})).toEqual([])
    // All runs stay active and no archive dir is created.
    expect((await store.listRunIds()).length).toBe(3)
    expect(existsSync(store.archiveDir)).toBe(false)
  })

  it('returns [] when the runs dir is missing', async () => {
    const fresh = new RunStore(join(tmp, 'never-touched'))
    expect(await fresh.archiveRuns({ keepLast: 0 })).toEqual([])
    expect(await fresh.listArchivedRunIds()).toEqual([])
    expect(await fresh.readArchived('whatever')).toBeNull()
  })
})
