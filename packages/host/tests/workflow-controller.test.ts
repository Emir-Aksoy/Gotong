import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, InMemoryStorage } from '@aipehub/core'
import { RunStore } from '@aipehub/workflow'

import { WorkflowController, createWorkflowController } from '../src/workflow-controller.js'
import { loadWorkflows } from '../src/workflow-loader.js'

const SAMPLE = `
schema: aipehub.workflow/v1
workflow:
  id: editorial
  name: 中文编辑
  description: writer → reviewer
  trigger: { capability: run-editorial }
  steps:
    - id: draft
      dispatch:
        strategy: { kind: capability, capabilities: [draft] }
        payload: $trigger.payload
    - id: review
      dispatch:
        strategy: { kind: capability, capabilities: [review] }
        payload: { draft: $draft.output }
`

describe('WorkflowController', () => {
  let tmp: string
  let definitionsDir: string
  let hub: Hub

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-wf-ctrl-'))
    definitionsDir = join(tmp, 'workflows', 'definitions')
    hub = new Hub({ storage: new InMemoryStorage() })
    await hub.start()
  })
  afterEach(async () => {
    await hub.stop()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('list() is empty when no workflows are loaded', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    expect(await c.list()).toEqual([])
  })

  it('createWorkflowController pre-populates from a boot report', async () => {
    // Drive the loader through a fake boot.
    mkdirSync(definitionsDir, { recursive: true })
    writeFileSync(join(definitionsDir, 'editorial.yaml'), SAMPLE)
    const report = await loadWorkflows({ hub, dir: definitionsDir, spaceRoot: tmp })
    expect(report.loaded).toHaveLength(1)
    const c = createWorkflowController(
      { hub, definitionsDir, spaceRoot: tmp },
      report,
    )
    const list = await c.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: 'editorial',
      participantId: 'workflow:editorial',
      triggerCapability: 'run-editorial',
      stepCount: 2,
      name: '中文编辑',
      description: 'writer → reviewer',
    })
    expect(list[0]!.file).toMatch(/editorial\.yaml$/)
  })

  it('importFromText() writes to disk and registers a runner', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    const summary = await c.importFromText(SAMPLE)
    expect(summary.id).toBe('editorial')
    expect(summary.participantId).toBe('workflow:editorial')

    // file landed
    const filePath = join(definitionsDir, 'editorial.yaml')
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf8')).toBe(SAMPLE)

    // runner registered
    const p = hub.registry.get('workflow:editorial')
    expect(p).toBeDefined()
    expect(p?.capabilities).toEqual(['run-editorial'])

    // tmp file cleaned up
    expect(existsSync(`${filePath}.tmp`)).toBe(false)
  })

  it('importFromText() rejects duplicate ids', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    await c.importFromText(SAMPLE)
    await expect(c.importFromText(SAMPLE)).rejects.toThrow(/already loaded/)
  })

  it('importFromText() surfaces schema errors verbatim (no file written)', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    await expect(c.importFromText('not a workflow')).rejects.toThrow()
    // definitions dir might not even exist yet
    if (existsSync(definitionsDir)) {
      const { readdirSync } = await import('node:fs')
      expect(readdirSync(definitionsDir)).toEqual([])
    }
  })

  it('sanitises file name for ids containing colons', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    const yaml = SAMPLE.replace('id: editorial', 'id: team:editorial')
    const summary = await c.importFromText(yaml)
    expect(summary.id).toBe('team:editorial')
    expect(summary.file).toMatch(/team__editorial\.yaml$/)
    expect(existsSync(summary.file!)).toBe(true)
  })

  describe('remove()', () => {
    it('unregisters the runner and deletes the YAML file', async () => {
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      const summary = await c.importFromText(SAMPLE)
      expect(hub.registry.get('workflow:editorial')).toBeDefined()
      expect(existsSync(summary.file!)).toBe(true)

      await c.remove('editorial')

      expect(hub.registry.get('workflow:editorial')).toBeUndefined()
      expect(existsSync(summary.file!)).toBe(false)
      expect(await c.list()).toEqual([])
    })

    it('throws on unknown id', async () => {
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      await expect(c.remove('nope')).rejects.toThrow(/not loaded/)
    })

    it('allows re-importing after removal', async () => {
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      await c.importFromText(SAMPLE)
      await c.remove('editorial')
      // No longer in the way — reimport should succeed.
      const summary = await c.importFromText(SAMPLE)
      expect(summary.id).toBe('editorial')
      expect(hub.registry.get('workflow:editorial')).toBeDefined()
    })
  })

  describe('listRuns() / readRun() — run history pass-through', () => {
    // The controller is a thin wrapper around RunStore — these tests
    // just confirm the wiring is correct (data flows in/out, the
    // workflowId filter is honoured, missing ids return null).

    it('returns runs written through the same space root', async () => {
      const store = new RunStore(tmp)
      store.ensureDirs()
      await store.write({
        runId: 'r_1',
        workflowId: 'editorial',
        triggeredByTaskId: 't_1',
        triggerPayload: { topic: 'hi' },
        steps: [],
        startedAt: 100,
        endedAt: 200,
        status: 'done',
      })
      await store.write({
        runId: 'r_2',
        workflowId: 'other',
        triggeredByTaskId: 't_2',
        triggerPayload: {},
        steps: [],
        startedAt: 300,
        status: 'running',
      })

      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })

      const all = await c.listRuns()
      expect(all.map((r) => r.runId)).toEqual(['r_2', 'r_1'])

      const onlyEditorial = await c.listRuns({ workflowId: 'editorial' })
      expect(onlyEditorial.map((r) => r.runId)).toEqual(['r_1'])
    })

    it('resumeRunningRuns() abandons runs whose workflow is no longer loaded', async () => {
      // Drop a "running" run on disk for a workflow id that we never
      // import — controller should close it out as failed.
      const store = new RunStore(tmp)
      store.ensureDirs()
      await store.write({
        runId: 'r_orphan',
        workflowId: 'long-gone',
        triggeredByTaskId: 't_orphan',
        triggerPayload: {},
        steps: [],
        startedAt: 1,
        status: 'running',
      })

      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      const r = await c.resumeRunningRuns()
      expect(r).toEqual({ resumed: 0, abandoned: 1 })

      const recovered = await c.readRun('r_orphan')
      expect(recovered).not.toBeNull()
      expect(recovered!.status).toBe('failed')
      expect(recovered!.error).toMatch(/no longer loaded/)
      expect(recovered!.endedAt).toBeDefined()
    })

    it('resumeRunningRuns() skips runs that already reached a terminal status', async () => {
      const store = new RunStore(tmp)
      store.ensureDirs()
      // One done, one failed — neither should be touched.
      await store.write({
        runId: 'r_done',
        workflowId: 'editorial',
        triggeredByTaskId: 't_d',
        triggerPayload: {},
        steps: [],
        startedAt: 1,
        endedAt: 2,
        status: 'done',
        finalOutput: 'kept',
      })
      await store.write({
        runId: 'r_failed',
        workflowId: 'editorial',
        triggeredByTaskId: 't_f',
        triggerPayload: {},
        steps: [],
        startedAt: 1,
        endedAt: 2,
        status: 'failed',
        error: 'original error',
      })

      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      const r = await c.resumeRunningRuns()
      expect(r).toEqual({ resumed: 0, abandoned: 0 })

      const done = await c.readRun('r_done')
      expect(done!.status).toBe('done')
      expect(done!.finalOutput).toBe('kept')

      const failed = await c.readRun('r_failed')
      expect(failed!.status).toBe('failed')
      expect(failed!.error).toBe('original error')
    })

    it('readRun() returns the full state, or null when missing', async () => {
      const store = new RunStore(tmp)
      store.ensureDirs()
      await store.write({
        runId: 'r_x',
        workflowId: 'editorial',
        triggeredByTaskId: 't_x',
        triggerPayload: { hi: 1 },
        steps: [
          { stepId: 'draft', startedAt: 1, endedAt: 2, status: 'done', attempts: 1, subTaskIds: ['sub_a'], output: 'ok' },
        ],
        startedAt: 1,
        endedAt: 3,
        status: 'done',
        finalOutput: 'final',
      })

      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })

      const got = await c.readRun('r_x')
      expect(got).not.toBeNull()
      expect(got!.runId).toBe('r_x')
      expect(got!.steps).toHaveLength(1)
      expect(got!.finalOutput).toBe('final')

      expect(await c.readRun('nope')).toBeNull()
    })
  })
})
