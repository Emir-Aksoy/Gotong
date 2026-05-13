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

describe('WorkflowRunner — conditional branches (when)', () => {
  it('skips a step whose `when` evaluates to false; downstream refs see undefined', async () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: cond
  trigger: { capability: go }
  steps:
    - id: prep
      dispatch:
        strategy: { kind: capability, capabilities: [prep] }
        payload: $trigger.payload
    - id: maybe-notify
      when: $trigger.payload.urgent == true
      dispatch:
        strategy: { kind: capability, capabilities: [notify] }
        payload: $prep.output
    - id: finalize
      dispatch:
        strategy: { kind: capability, capabilities: [finalize] }
        payload:
          prep_out: $prep.output
          notify_out: $maybe-notify.output
  output: $finalize.output
`
    const def = parseWorkflow(yaml)
    const { hub, calls } = makeStubHub((call) => {
      if (call.strategy.kind === 'capability' && call.strategy.capabilities[0] === 'prep') {
        return ok(nextTaskId(), 'PREPPED', 'prep-bot')
      }
      if (call.strategy.kind === 'capability' && call.strategy.capabilities[0] === 'notify') {
        return ok(nextTaskId(), 'NOTIFIED', 'notify-bot')
      }
      return ok(nextTaskId(), { final: true, notify_out: call.payload }, 'final-bot')
    })

    // urgent: false → maybe-notify should be skipped
    const runner = new WorkflowRunner({ definition: def, hub })
    const out = await runner.onTask(makeTask({ urgent: false }))
    if (out.kind !== 'ok') throw new Error('expected ok')

    // 2 calls only — prep + finalize. notify is skipped.
    expect(calls).toHaveLength(2)
    expect(calls[0]!.strategy).toEqual({ kind: 'capability', capabilities: ['prep'] })
    expect(calls[1]!.strategy).toEqual({ kind: 'capability', capabilities: ['finalize'] })
    // The finalize payload threaded $maybe-notify.output → undefined
    expect(calls[1]!.payload).toEqual({
      prep_out: 'PREPPED',
      notify_out: undefined,
    })
  })

  it('runs the step when `when` is true', async () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: cond2
  trigger: { capability: go }
  steps:
    - id: notify
      when: $trigger.payload.urgent == true
      dispatch:
        strategy: { kind: capability, capabilities: [notify] }
        payload: hi
  output: $notify.output
`
    const def = parseWorkflow(yaml)
    const { hub, calls } = makeStubHub(() => ok(nextTaskId(), 'NOTIFIED', 'mock'))
    const runner = new WorkflowRunner({ definition: def, hub })
    const out = await runner.onTask(makeTask({ urgent: true }))
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(out.output).toBe('NOTIFIED')
    expect(calls).toHaveLength(1)
  })

  it('skips a parallel step when its `when` is false', async () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: cond-parallel
  trigger: { capability: go }
  steps:
    - id: fanout
      when: $trigger.payload.do_fanout == true
      parallel: true
      branches:
        - id: a
          dispatch:
            strategy: { kind: capability, capabilities: [x] }
            payload: 1
        - id: b
          dispatch:
            strategy: { kind: capability, capabilities: [y] }
            payload: 2
    - id: tail
      dispatch:
        strategy: { kind: capability, capabilities: [tail] }
        payload: { upstream: $fanout.output }
  output: $tail.output
`
    const def = parseWorkflow(yaml)
    const { hub, calls } = makeStubHub(() => ok(nextTaskId(), 'TAIL', 'tail-bot'))
    const runner = new WorkflowRunner({ definition: def, hub })
    const out = await runner.onTask(makeTask({ do_fanout: false }))
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(calls).toHaveLength(1) // only tail
    expect(calls[0]!.payload).toEqual({ upstream: undefined })
  })

  it('schema rejects an invalid `when` predicate at parse time', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: bad-when
  trigger: { capability: go }
  steps:
    - id: s1
      when: $trigger.payload.x ==
      dispatch:
        strategy: { kind: capability, capabilities: [x] }
        payload: hi
`
    expect(() => parseWorkflow(yaml)).toThrow(/not a valid predicate/)
  })

  it('records a runtime when-failure as `failed` (e.g. bad ref shape)', async () => {
    // `$step.field` referring to a parallel step's branches table — that's
    // a runtime error from `lookupRef`, not a missing key.
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: badref
  trigger: { capability: go }
  steps:
    - id: fan
      parallel: true
      branches:
        - id: a
          dispatch:
            strategy: { kind: capability, capabilities: [x] }
            payload: 1
    - id: gated
      when: $fan.zzz.output == "x"
      dispatch:
        strategy: { kind: capability, capabilities: [y] }
        payload: hi
`
    const def = parseWorkflow(yaml)
    const { hub } = makeStubHub(() => ok(nextTaskId(), 'a-done', 'a-bot'))
    const runner = new WorkflowRunner({ definition: def, hub })
    const out = await runner.onTask(makeTask({}))
    expect(out.kind).toBe('failed')
    if (out.kind !== 'failed') throw new Error('expected failed')
    expect(out.error).toMatch(/step 'gated' failed/)
    expect(out.error).toMatch(/when '\$fan\.zzz\.output == "x"' threw/)
  })
})

describe('WorkflowRunner — resume from disk (v0.3)', () => {
  // Same three-step workflow used by all resume tests. `mid` is the
  // step that's marked still-running on disk when the host crashed.
  const RESUMABLE_YAML = `
schema: aipehub.workflow/v1
workflow:
  id: three-step
  trigger: { capability: go }
  steps:
    - id: head
      dispatch:
        strategy: { kind: capability, capabilities: [head] }
        payload: $trigger.payload
    - id: mid
      dispatch:
        strategy: { kind: capability, capabilities: [mid] }
        payload: { from_head: $head.output }
    - id: tail
      dispatch:
        strategy: { kind: capability, capabilities: [tail] }
        payload: { from_mid: $mid.output }
  output: $tail.output
`

  function partialState(overrides?: Partial<RunState>): RunState {
    return {
      runId: 'r_resume_1',
      workflowId: 'three-step',
      triggeredByTaskId: 'task_origin',
      triggerPayload: { kicked: true },
      steps: [
        {
          stepId: 'head',
          startedAt: 100,
          endedAt: 110,
          status: 'done',
          attempts: 1,
          subTaskIds: ['sub_head'],
          output: 'HEAD_OUTPUT',
        },
      ],
      startedAt: 100,
      status: 'running',
      ...overrides,
    }
  }

  it('skips already-done steps and runs only the remainder', async () => {
    const def = parseWorkflow(RESUMABLE_YAML)
    const { hub, calls } = makeStubHub((c) => {
      if (c.payload && typeof c.payload === 'object' && 'from_head' in c.payload) {
        return ok(nextTaskId(), 'MID_OUTPUT', 'mid-bot')
      }
      return ok(nextTaskId(), 'TAIL_OUTPUT', 'tail-bot')
    })
    const runner = new WorkflowRunner({ definition: def, hub })

    const out = await runner.resumeRun(partialState())
    expect(out).toBe('TAIL_OUTPUT')
    // head was already done → not redispatched. mid + tail → 2 calls.
    expect(calls).toHaveLength(2)
    expect(calls[0]!.payload).toEqual({ from_head: 'HEAD_OUTPUT' })
    expect(calls[1]!.payload).toEqual({ from_mid: 'MID_OUTPUT' })
  })

  it('re-runs a step that was mid-flight (status running) by dropping its record', async () => {
    const def = parseWorkflow(RESUMABLE_YAML)
    let midAttempts = 0
    const { hub, calls } = makeStubHub((c) => {
      if (c.payload && typeof c.payload === 'object' && 'from_head' in c.payload) {
        midAttempts += 1
        return ok(nextTaskId(), 'MID_FRESH', 'mid-bot')
      }
      return ok(nextTaskId(), 'TAIL_OUTPUT', 'tail-bot')
    })
    const runner = new WorkflowRunner({ definition: def, hub })

    // mid was mid-flight when the host died — it has a stale 'running' record
    const state = partialState({
      steps: [
        partialState().steps[0]!,
        {
          stepId: 'mid',
          startedAt: 200,
          status: 'running',
          attempts: 1,
          subTaskIds: ['sub_mid_stale'],
        },
      ],
    })
    await runner.resumeRun(state)
    // mid got re-run from scratch (head reused)
    expect(midAttempts).toBe(1)
    // The stale "running" mid record was dropped in favour of the new one.
    expect(state.steps.find((s) => s.stepId === 'mid')!.subTaskIds).not.toContain('sub_mid_stale')
    expect(calls.map((c) => c.strategy.kind === 'capability' && c.strategy.capabilities[0])).toEqual(['mid', 'tail'])
  })

  it('writes the resumed state back to disk on each step', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aipehub-resume-'))
    try {
      const def = parseWorkflow(RESUMABLE_YAML)
      const store = new RunStore(tmp)
      store.ensureDirs()
      const { hub } = makeStubHub(() => ok(nextTaskId(), 'OUT', 'bot'))
      const runner = new WorkflowRunner({ definition: def, hub, runStore: store })

      const initial = partialState()
      await store.write(initial)
      await runner.resumeRun(initial)

      const onDisk = JSON.parse(readFileSync(store.pathFor(initial.runId), 'utf8')) as RunState
      expect(onDisk.status).toBe('done')
      expect(onDisk.endedAt).toBeDefined()
      expect(onDisk.steps.map((s) => s.stepId)).toEqual(['head', 'mid', 'tail'])
      expect(onDisk.finalOutput).toBe('OUT')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('persists a fresh failure (and does not throw) when resume hits halt failure', async () => {
    const def = parseWorkflow(RESUMABLE_YAML)
    const { hub } = makeStubHub((c) => {
      if (c.strategy.kind === 'capability' && c.strategy.capabilities[0] === 'mid') {
        return fail(nextTaskId(), 'mid blew up on resume', 'mid-bot')
      }
      return ok(nextTaskId(), 'unused', 'bot')
    })
    const runner = new WorkflowRunner({ definition: def, hub })

    const initial = partialState()
    const out = await runner.resumeRun(initial)
    expect(out).toBeUndefined()
    expect(initial.status).toBe('failed')
    expect(initial.error).toMatch(/mid blew up on resume/)
  })

  it('refuses to resume a run that is not in `running` status', async () => {
    const def = parseWorkflow(RESUMABLE_YAML)
    const { hub } = makeStubHub(() => ok(nextTaskId(), 'x', 'b'))
    const runner = new WorkflowRunner({ definition: def, hub })

    await expect(runner.resumeRun(partialState({ status: 'done' }))).rejects.toThrow(/not 'running'/)
  })

  it('refuses to resume a run that targets a different workflowId', async () => {
    const def = parseWorkflow(RESUMABLE_YAML)
    const { hub } = makeStubHub(() => ok(nextTaskId(), 'x', 'b'))
    const runner = new WorkflowRunner({ definition: def, hub })

    await expect(
      runner.resumeRun(partialState({ workflowId: 'something-else' })),
    ).rejects.toThrow(/does not match this runner/)
  })
})
