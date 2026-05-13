import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  DispatchStrategy,
  ParticipantId,
  Task,
  TaskResult,
} from '@aipehub/core'

import {
  RunStore,
  WorkflowRunner,
  parseWorkflow,
  workflowParticipantId,
  type HubLike,
  type RunState,
  type WorkflowDefinition,
} from '../src/index.js'

// --- stub hub -------------------------------------------------------------

interface DispatchCall {
  from: ParticipantId
  strategy: DispatchStrategy
  payload: unknown
  title?: string
}

function makeStubHub(
  dispatcher: (call: DispatchCall) => TaskResult | Promise<TaskResult>,
): { hub: HubLike; calls: DispatchCall[] } {
  const calls: DispatchCall[] = []
  const hub: HubLike = {
    async dispatch(opts) {
      const call: DispatchCall = {
        from: opts.from,
        strategy: opts.strategy,
        payload: opts.payload,
      }
      if (opts.title !== undefined) call.title = opts.title
      calls.push(call)
      return dispatcher(call)
    },
  }
  return { hub, calls }
}

function ok(taskId: string, output: unknown, by: ParticipantId): TaskResult {
  return { kind: 'ok', taskId, by, output, ts: 1700000000000 }
}
function fail(taskId: string, error: string, by: ParticipantId): TaskResult {
  return { kind: 'failed', taskId, by, error, ts: 1700000000000 }
}

function makeTask(payload: unknown): Task {
  return {
    id: 'trigger-task-1',
    from: 'admin',
    strategy: { kind: 'capability', capabilities: ['run-editorial'] },
    payload,
    createdAt: 1700000000000,
  }
}

const COUNTER = { v: 0 }
function nextTaskId(): string {
  COUNTER.v += 1
  return `subtask-${COUNTER.v}`
}

beforeEach(() => {
  COUNTER.v = 0
})

// --- tests ----------------------------------------------------------------

describe('WorkflowRunner — id and capabilities', () => {
  it('exposes the right participant id and capability', () => {
    const def: WorkflowDefinition = {
      schema: 'aipehub.workflow/v1',
      id: 'editorial',
      trigger: { capability: 'run-editorial' },
      steps: [
        {
          id: 's1',
          dispatch: {
            strategy: { kind: 'capability', capabilities: ['draft'] },
            payload: 'x',
          },
        },
      ],
      onFailure: 'halt',
    }
    const { hub } = makeStubHub(() => ok('s1', 'done', 'mock'))
    const r = new WorkflowRunner({ definition: def, hub })
    expect(r.id).toBe('workflow:editorial')
    expect(r.id).toBe(workflowParticipantId('editorial'))
    expect(r.capabilities).toEqual(['run-editorial'])
    expect(r.kind).toBe('agent')
  })
})

describe('WorkflowRunner — sequential execution', () => {
  it('runs two steps and threads $ref values', async () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: editorial
  trigger: { capability: run-editorial }
  steps:
    - id: draft
      dispatch:
        strategy: { kind: capability, capabilities: [draft] }
        payload: { topic: $trigger.payload.topic }
    - id: review
      dispatch:
        strategy: { kind: capability, capabilities: [review] }
        payload: { draft: $draft.output, original_topic: $trigger.payload.topic }
  output: $review.output
`
    const def = parseWorkflow(yaml)
    const { hub, calls } = makeStubHub((call) => {
      if (
        call.strategy.kind === 'capability' &&
        call.strategy.capabilities[0] === 'draft'
      ) {
        return ok(nextTaskId(), { text: 'draft body' }, 'writer-bot')
      }
      return ok(nextTaskId(), { final: 'reviewed body' }, 'reviewer-bot')
    })
    const runner = new WorkflowRunner({ definition: def, hub })
    const out = await runner.onTask(makeTask({ topic: 'TS' }))

    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(out.output).toEqual({ final: 'reviewed body' })

    expect(calls).toHaveLength(2)
    // step 1: payload references trigger
    expect(calls[0]!.payload).toEqual({ topic: 'TS' })
    expect(calls[0]!.from).toBe('workflow:editorial')
    // step 2: payload references both previous step output and trigger
    expect(calls[1]!.payload).toEqual({
      draft: { text: 'draft body' },
      original_topic: 'TS',
    })
  })

  it('defaults final output to last step output when `workflow.output` is omitted', async () => {
    const def: WorkflowDefinition = {
      schema: 'aipehub.workflow/v1',
      id: 'tail',
      trigger: { capability: 'go' },
      steps: [
        {
          id: 'only',
          dispatch: {
            strategy: { kind: 'capability', capabilities: ['x'] },
            payload: 'hi',
          },
        },
      ],
      onFailure: 'halt',
    }
    const { hub } = makeStubHub(() => ok(nextTaskId(), 'tail-output', 'mock'))
    const runner = new WorkflowRunner({ definition: def, hub })
    const out = await runner.onTask(makeTask({}))
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(out.output).toBe('tail-output')
  })
})

describe('WorkflowRunner — parallel step', () => {
  it('runs branches concurrently and exposes a {branchId: output} record', async () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: fanout
  trigger: { capability: fanout-start }
  steps:
    - id: fanout
      parallel: true
      branches:
        - id: a
          dispatch:
            strategy: { kind: capability, capabilities: [a] }
            payload: a-in
        - id: b
          dispatch:
            strategy: { kind: capability, capabilities: [b] }
            payload: b-in
    - id: collect
      dispatch:
        strategy: { kind: capability, capabilities: [collect] }
        payload:
          a_out: $fanout.a.output
          b_out: $fanout.b.output
`
    const def = parseWorkflow(yaml)
    const { hub, calls } = makeStubHub((call) => {
      if (call.payload === 'a-in') {
        return ok(nextTaskId(), 'A-DONE', 'a-bot')
      }
      if (call.payload === 'b-in') {
        return ok(nextTaskId(), 'B-DONE', 'b-bot')
      }
      return ok(nextTaskId(), { collected: true }, 'collector')
    })
    const runner = new WorkflowRunner({ definition: def, hub })
    const out = await runner.onTask(makeTask({}))
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(out.output).toEqual({ collected: true })
    expect(calls).toHaveLength(3)
    // the collector saw the two branch outputs threaded in
    expect(calls[2]!.payload).toEqual({ a_out: 'A-DONE', b_out: 'B-DONE' })
  })
})

describe('WorkflowRunner — failure handling', () => {
  it('halts and returns failure when a step fails with default policy', async () => {
    const def: WorkflowDefinition = {
      schema: 'aipehub.workflow/v1',
      id: 'tail',
      trigger: { capability: 'go' },
      steps: [
        {
          id: 's1',
          dispatch: {
            strategy: { kind: 'capability', capabilities: ['x'] },
            payload: 'hi',
          },
        },
        {
          id: 's2',
          dispatch: {
            strategy: { kind: 'capability', capabilities: ['y'] },
            payload: 'world',
          },
        },
      ],
      onFailure: 'halt',
    }
    const { hub, calls } = makeStubHub((_call) =>
      fail(nextTaskId(), 'boom', 'broken-bot'),
    )
    const runner = new WorkflowRunner({ definition: def, hub })
    const out = await runner.onTask(makeTask({}))
    expect(out.kind).toBe('failed')
    if (out.kind !== 'failed') throw new Error('expected failed')
    expect(out.error).toMatch(/step 's1' failed/)
    expect(calls).toHaveLength(1) // s2 never ran
  })

  it("'continue' policy at the workflow level keeps going past failures", async () => {
    const def: WorkflowDefinition = {
      schema: 'aipehub.workflow/v1',
      id: 'cleanup',
      trigger: { capability: 'go' },
      steps: [
        {
          id: 'maybe',
          dispatch: {
            strategy: { kind: 'capability', capabilities: ['flaky'] },
            payload: 'try',
          },
        },
        {
          id: 'always',
          dispatch: {
            strategy: { kind: 'capability', capabilities: ['safe'] },
            payload: 'go',
          },
        },
      ],
      onFailure: 'continue',
    }
    const { hub, calls } = makeStubHub((call) => {
      if (call.payload === 'try') return fail(nextTaskId(), 'no', 'flaky-bot')
      return ok(nextTaskId(), 'safe-done', 'safe-bot')
    })
    const runner = new WorkflowRunner({ definition: def, hub })
    const out = await runner.onTask(makeTask({}))
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(out.output).toBe('safe-done')
    expect(calls).toHaveLength(2)
  })

  it("'retry' step policy retries up to `max` times before giving up", async () => {
    const def: WorkflowDefinition = {
      schema: 'aipehub.workflow/v1',
      id: 'r',
      trigger: { capability: 'go' },
      steps: [
        {
          id: 's',
          dispatch: {
            strategy: { kind: 'capability', capabilities: ['flaky'] },
            payload: 'try',
          },
          onFailure: { action: 'retry', max: 2 },
        },
      ],
      onFailure: 'halt',
    }
    let attempts = 0
    const { hub, calls } = makeStubHub((_call) => {
      attempts += 1
      if (attempts < 3) return fail(nextTaskId(), `attempt ${attempts}`, 'flaky')
      return ok(nextTaskId(), 'success-on-3', 'flaky')
    })
    const runner = new WorkflowRunner({ definition: def, hub })
    const out = await runner.onTask(makeTask({}))
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(out.output).toBe('success-on-3')
    expect(calls).toHaveLength(3) // 1 initial + 2 retries
  })
})

describe('WorkflowRunner — file-first persistence', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'workflow-test-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('writes a RunState file under <space>/workflows/runs/<runId>.json', async () => {
    const def: WorkflowDefinition = {
      schema: 'aipehub.workflow/v1',
      id: 'persist-test',
      trigger: { capability: 'go' },
      steps: [
        {
          id: 's1',
          dispatch: {
            strategy: { kind: 'capability', capabilities: ['x'] },
            payload: 'in',
          },
        },
      ],
      onFailure: 'halt',
    }
    const { hub } = makeStubHub(() => ok(nextTaskId(), 'output1', 'mock'))
    const store = new RunStore(tmp)
    const runner = new WorkflowRunner({
      definition: def,
      hub,
      runStore: store,
      idGenerator: () => 'run-fixed-1',
    })
    const out = await runner.onTask(makeTask({}))
    if (out.kind !== 'ok') throw new Error('expected ok')

    const filePath = store.pathFor('run-fixed-1')
    const body = JSON.parse(readFileSync(filePath, 'utf8')) as RunState
    expect(body.runId).toBe('run-fixed-1')
    expect(body.workflowId).toBe('persist-test')
    expect(body.status).toBe('done')
    expect(body.steps).toHaveLength(1)
    expect(body.steps[0]!.stepId).toBe('s1')
    expect(body.steps[0]!.status).toBe('done')
    expect(body.steps[0]!.output).toBe('output1')
    expect(body.finalOutput).toBe('output1')
    expect(body.triggerPayload).toEqual({})
    expect(body.endedAt).toBeGreaterThan(0)
  })

  it('persists a failed run with the failure reason on disk', async () => {
    const def: WorkflowDefinition = {
      schema: 'aipehub.workflow/v1',
      id: 'persist-fail',
      trigger: { capability: 'go' },
      steps: [
        {
          id: 's1',
          dispatch: {
            strategy: { kind: 'capability', capabilities: ['x'] },
            payload: 'in',
          },
        },
      ],
      onFailure: 'halt',
    }
    const { hub } = makeStubHub(() => fail(nextTaskId(), 'kaboom', 'mock'))
    const store = new RunStore(tmp)
    const runner = new WorkflowRunner({
      definition: def,
      hub,
      runStore: store,
      idGenerator: () => 'run-fixed-fail',
    })
    const out = await runner.onTask(makeTask({}))
    expect(out.kind).toBe('failed')

    const body = JSON.parse(
      readFileSync(store.pathFor('run-fixed-fail'), 'utf8'),
    ) as RunState
    expect(body.status).toBe('failed')
    expect(body.error).toMatch(/kaboom/)
    expect(body.steps[0]!.status).toBe('failed')
    expect(body.steps[0]!.error).toMatch(/kaboom/)
  })

  it('listRunIds reflects what landed on disk', async () => {
    const def: WorkflowDefinition = {
      schema: 'aipehub.workflow/v1',
      id: 'multi',
      trigger: { capability: 'go' },
      steps: [
        {
          id: 's1',
          dispatch: {
            strategy: { kind: 'capability', capabilities: ['x'] },
            payload: 'in',
          },
        },
      ],
      onFailure: 'halt',
    }
    const { hub } = makeStubHub(() => ok(nextTaskId(), 'done', 'mock'))
    const store = new RunStore(tmp)
    let counter = 0
    const runner = new WorkflowRunner({
      definition: def,
      hub,
      runStore: store,
      idGenerator: () => `run-${++counter}`,
    })
    await runner.onTask(makeTask({}))
    await runner.onTask(makeTask({}))
    const ids = (await store.listRunIds()).sort()
    expect(ids).toEqual(['run-1', 'run-2'])
  })
})
