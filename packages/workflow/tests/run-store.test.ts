import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  tmp = mkdtempSync(join(tmpdir(), 'gotong-runstore-'))
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

  // `ensureDirs()` memoizes because `WorkflowRunner.persist()` calls it before
  // every step write — two synchronous stats per step, re-answering a settled
  // question. These two pin both halves of that trade.
  it('ensureDirs() does no work once the tree is known to exist', async () => {
    expect(existsSync(store.runsDir)).toBe(true)
    rmSync(store.root, { recursive: true, force: true })
    store.ensureDirs()
    // Deliberately still gone: the memo means a bare ensureDirs() is free, and
    // recovery is `write()`'s job (next test) rather than a stat on every step.
    expect(existsSync(store.runsDir)).toBe(false)
  })

  it('write() recreates a tree deleted behind its back', async () => {
    await store.write(makeRun({ runId: 'r_1', workflowId: 'wf_a', startedAt: 1, status: 'done' }))
    rmSync(store.root, { recursive: true, force: true })

    await store.write(makeRun({ runId: 'r_2', workflowId: 'wf_a', startedAt: 2, status: 'done' }))

    expect((await store.read('r_2'))?.runId).toBe('r_2')
    expect(await store.read('r_1')).toBeNull() // the wipe really happened
  })

  it('write() still propagates non-ENOENT failures', async () => {
    // The retry is scoped to "the directory vanished". Anything else must
    // surface, not get quietly retried into the same wall. Parking a directory
    // on the tmp path makes the write fail EISDIR — a real errno, no mocking.
    mkdirSync(`${store.pathFor('r_x')}.tmp`, { recursive: true })
    await expect(
      store.write(makeRun({ runId: 'r_x', workflowId: 'wf_a', startedAt: 1, status: 'done' })),
    ).rejects.toMatchObject({ code: 'EISDIR' })
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

describe('RunStore.listByUser', () => {
  function userRun(
    runId: string,
    userId: string | undefined,
    over: Partial<RunState> & Pick<RunState, 'workflowId' | 'startedAt' | 'status'>,
  ): RunState {
    return makeRun({
      runId,
      ...(userId ? { triggeredByOrigin: { orgId: 'local', userId } } : {}),
      ...over,
    })
  }

  it('isolates runs by the initiating user (triggeredByOrigin.userId)', async () => {
    await store.write(userRun('r_alice1', 'alice', { workflowId: 'wf_a', startedAt: 100, status: 'done' }))
    await store.write(userRun('r_bob1', 'bob', { workflowId: 'wf_a', startedAt: 200, status: 'done' }))
    await store.write(userRun('r_alice2', 'alice', { workflowId: 'wf_b', startedAt: 300, status: 'running' }))

    const alice = await store.listByUser('alice')
    expect(alice.map((r) => r.runId)).toEqual(['r_alice2', 'r_alice1'])

    const bob = await store.listByUser('bob')
    expect(bob.map((r) => r.runId)).toEqual(['r_bob1'])
  })

  it('degrades (skips) pre-attribution runs with no triggeredByOrigin', async () => {
    // Old run file written before /me/dispatch stamped origin — must not
    // crash and must not leak into any user's view.
    await store.write(userRun('r_legacy', undefined, { workflowId: 'wf_a', startedAt: 100, status: 'done' }))
    await store.write(userRun('r_alice', 'alice', { workflowId: 'wf_a', startedAt: 200, status: 'done' }))

    expect((await store.listByUser('alice')).map((r) => r.runId)).toEqual(['r_alice'])
    // The legacy run is invisible to everyone — never matches a userId.
    expect(await store.listByUser('')).toEqual([])
  })

  it('respects workflowId filter and limit', async () => {
    await store.write(userRun('r_a1', 'alice', { workflowId: 'wf_a', startedAt: 100, status: 'done' }))
    await store.write(userRun('r_b1', 'alice', { workflowId: 'wf_b', startedAt: 200, status: 'done' }))
    await store.write(userRun('r_a2', 'alice', { workflowId: 'wf_a', startedAt: 300, status: 'done' }))

    expect((await store.listByUser('alice', { workflowId: 'wf_a' })).map((r) => r.runId)).toEqual(['r_a2', 'r_a1'])
    expect((await store.listByUser('alice', { limit: 1 })).map((r) => r.runId)).toEqual(['r_a2'])
  })

  it('returns [] when runs dir is missing', async () => {
    const fresh = new RunStore(join(tmp, 'never-touched'))
    expect(await fresh.listByUser('alice')).toEqual([])
  })
})

// Route B P0-M5 — crash consistency (fault injection). RunStore.write is
// atomic (write `<file>.tmp` → rename), so a `kill -9` mid-write leaves the
// committed run untouched and at most an orphan `<id>.json.tmp` that was never
// renamed. These inject exactly those crash artifacts and pin that the next
// boot ignores them without losing or double-counting a committed run. Each
// guard is falsifiable: drop the `.tmp` filter in listRunIds and the orphan
// surfaces as a phantom run; drop the per-file try/catch in the scan and one
// corrupt file aborts the whole list.
describe('RunStore crash consistency (Route B P0-M5)', () => {
  it('ignores an orphan .tmp left by a crash before rename; the committed run survives', async () => {
    const ok = makeRun({ runId: 'r_ok', workflowId: 'wf_a', startedAt: 100, status: 'done', endedAt: 110, finalOutput: 'committed' })
    await store.write(ok)

    // A crash after writeFile(tmp) but before rename(tmp,file) leaves a fully
    // formed body under `<id>.json.tmp`. It must NEVER be adopted as a run —
    // the rename is the commit point, and it never happened.
    const orphan = makeRun({ runId: 'r_crash', workflowId: 'wf_a', startedAt: 200, status: 'running' })
    writeFileSync(join(store.runsDir, 'r_crash.json.tmp'), JSON.stringify(orphan, null, 2), 'utf8')

    // The id list excludes the orphan (this is the load-bearing `.tmp` filter).
    expect(await store.listRunIds()).toEqual(['r_ok'])
    // The committed run is whole (atomic rename never tears it).
    expect(await store.read('r_ok')).toEqual(ok)
    // Neither the summary scan nor the metrics count sees the orphan.
    expect((await store.listRuns()).map((r) => r.runId)).toEqual(['r_ok'])
    expect((await store.countRuns()).total).toBe(1)
  })

  it('skips an intact-but-corrupt run file instead of aborting the whole list', async () => {
    const ok = makeRun({ runId: 'r_ok', workflowId: 'wf_a', startedAt: 100, status: 'done', endedAt: 110 })
    await store.write(ok)
    // Disk corruption / a torn flush can leave a committed `.json` that no
    // longer parses. One bad file must not sink the list or the count.
    writeFileSync(join(store.runsDir, 'r_bad.json'), '{ "runId": "r_bad", trunc', 'utf8')

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await store.listRuns()).map((r) => r.runId)).toEqual(['r_ok'])
      expect((await store.countRuns()).total).toBe(1)
    } finally {
      errSpy.mockRestore()
    }
  })
})
