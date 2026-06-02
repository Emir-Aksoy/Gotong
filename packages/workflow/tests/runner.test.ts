import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  AncestryNode,
  DispatchStrategy,
  ParticipantId,
  Task,
  TaskResult,
} from '@aipehub/core'

import {
  RunStore,
  WorkflowRevisionError,
  WorkflowRunner,
  parseWorkflow,
  workflowParticipantId,
  type DefinitionResolver,
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
  ancestry?: readonly AncestryNode[]
  dataClasses?: readonly string[]
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
      if (opts.ancestry !== undefined) call.ancestry = opts.ancestry
      if (opts.dataClasses !== undefined) call.dataClasses = opts.dataClasses
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

describe('WorkflowRunner — branch-level `when` (P2)', () => {
  // Each test builds the same fan-out: two branches a + b, each
  // gated by a different `when` reading from $trigger.payload.
  const FANOUT_YAML = `
schema: aipehub.workflow/v1
workflow:
  id: fanout-when
  trigger: { capability: go }
  steps:
    - id: fan
      parallel: true
      branches:
        - id: a
          when: $trigger.payload.do_a == true
          dispatch:
            strategy: { kind: capability, capabilities: [a] }
            payload: { hi: "from a" }
        - id: b
          when: $trigger.payload.do_b == true
          dispatch:
            strategy: { kind: capability, capabilities: [b] }
            payload: { hi: "from b" }
`

  it('skips both branches → step is done with output = { a: undefined, b: undefined }', async () => {
    const def = parseWorkflow(FANOUT_YAML)
    const { hub, calls } = makeStubHub(() => ok(nextTaskId(), 'unused', 'bot'))
    const runner = new WorkflowRunner({ definition: def, hub })

    const out = await runner.onTask(makeTask({ do_a: false, do_b: false }))
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(calls).toHaveLength(0)
    expect(out.output).toEqual({ a: undefined, b: undefined })
  })

  it('runs only the un-gated branch when one when is false', async () => {
    const def = parseWorkflow(FANOUT_YAML)
    const { hub, calls } = makeStubHub((c) => {
      const cap = c.strategy.kind === 'capability' ? c.strategy.capabilities[0] : '?'
      return ok(nextTaskId(), `${cap}-output`, `${cap}-bot`)
    })
    const runner = new WorkflowRunner({ definition: def, hub })

    const out = await runner.onTask(makeTask({ do_a: true, do_b: false }))
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(calls).toHaveLength(1)
    expect((calls[0]!.strategy as { capabilities: string[] }).capabilities).toEqual(['a'])
    expect(out.output).toEqual({ a: 'a-output', b: undefined })
  })

  it('skipped branches do not appear in subTaskIds (no Hub dispatch happened)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aipehub-branch-when-'))
    try {
      const def = parseWorkflow(FANOUT_YAML)
      const store = new RunStore(tmp)
      store.ensureDirs()
      const { hub } = makeStubHub((c) => {
        const cap = c.strategy.kind === 'capability' ? c.strategy.capabilities[0] : '?'
        return ok(`task-${cap}`, `${cap}-out`, `${cap}-bot`)
      })
      const runner = new WorkflowRunner({ definition: def, hub, runStore: store })

      await runner.onTask(makeTask({ do_a: true, do_b: false }))
      const runIds = await store.listRunIds()
      const state = await store.read(runIds[0]!)
      const fanRecord = state!.steps.find((s) => s.stepId === 'fan')!
      expect(fanRecord.status).toBe('done')
      expect(fanRecord.subTaskIds).toEqual(['task-a'])
      expect(fanRecord.output).toEqual({ a: 'a-out', b: undefined })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('a parent-step `when: false` short-circuits before branch predicates evaluate', async () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: fanout-gated
  trigger: { capability: go }
  steps:
    - id: fan
      parallel: true
      when: $trigger.payload.run_fan == true
      branches:
        - id: a
          when: $trigger.payload.do_a == true
          dispatch:
            strategy: { kind: capability, capabilities: [a] }
            payload: 1
`
    const def = parseWorkflow(yaml)
    const { hub, calls } = makeStubHub(() => ok(nextTaskId(), 'x', 'b'))
    const runner = new WorkflowRunner({ definition: def, hub })

    const out = await runner.onTask(makeTask({ run_fan: false, do_a: true }))
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(calls).toHaveLength(0)
    // Parent step status is 'skipped' → $fan.output is undefined for
    // anything downstream (we only have one step here, so out.output
    // falls back to lastStepOutput which is undefined).
    expect(out.output).toBeUndefined()
  })

  it('a runtime `when` error in a branch is logged as a failure (no Hub call)', async () => {
    // `$missing.output` for an unknown step → undefined → comparison
    // works (it's just "not equal to true"), so we need a different
    // trigger. Use a ref into a parallel step's branches map which is
    // an actual lookupRef error.
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: branch-when-error
  trigger: { capability: go }
  steps:
    - id: pre
      parallel: true
      branches:
        - id: a
          dispatch:
            strategy: { kind: capability, capabilities: [a] }
            payload: 1
    - id: fan
      parallel: true
      branches:
        - id: x
          when: $pre.zzz.output == "ok"
          dispatch:
            strategy: { kind: capability, capabilities: [x] }
            payload: 1
`
    const def = parseWorkflow(yaml)
    const { hub, calls } = makeStubHub((c) => {
      const cap = c.strategy.kind === 'capability' ? c.strategy.capabilities[0] : '?'
      return ok(nextTaskId(), `${cap}-out`, `${cap}-bot`)
    })
    const runner = new WorkflowRunner({ definition: def, hub })

    const out = await runner.onTask(makeTask({}))
    // Only `pre.a` ran; `fan.x` was gated by a broken predicate.
    expect(calls).toHaveLength(1)
    // The fan step's failure mode defaults to halt → workflow fails.
    expect(out.kind).toBe('failed')
    if (out.kind !== 'failed') throw new Error('expected failed')
    expect(out.error).toMatch(/branch 'x'/)
    expect(out.error).toMatch(/when '\$pre\.zzz\.output == "ok"' threw/)
  })

  it('schema rejects an invalid branch-level `when` at parse time', () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: bad-branch-when
  trigger: { capability: go }
  steps:
    - id: fan
      parallel: true
      branches:
        - id: a
          when: $trigger.payload.x ==
          dispatch:
            strategy: { kind: capability, capabilities: [a] }
            payload: 1
`
    expect(() => parseWorkflow(yaml)).toThrow(/branches\[0\]\.when is not a valid predicate/)
  })
})

// =========================================================================
// B2.2.2 — `task.origin` transit through the runner. The runner must
// re-stamp the triggering task's origin on every inner dispatch so the
// org-level quota gate inside `LlmAgent.preCallHook` sees the original
// dispatcher's userId, not the runner's synthetic id.
// =========================================================================

describe('WorkflowRunner — origin transit (B2.2.2)', () => {
  function makeTaskWithOrigin(
    payload: unknown,
    origin: { orgId: string; userId: string },
  ): Task {
    return {
      id: 'trigger-task-with-origin',
      from: 'admin',
      origin,
      strategy: { kind: 'capability', capabilities: ['run-editorial'] },
      payload,
      createdAt: 1700000000000,
    }
  }

  function makeOriginStubHub(): {
    hub: HubLike
    calls: Array<{ origin?: { orgId: string; userId: string } }>
  } {
    const calls: Array<{ origin?: { orgId: string; userId: string } }> = []
    const hub: HubLike = {
      async dispatch(opts) {
        calls.push(opts.origin ? { origin: opts.origin } : {})
        return ok(nextTaskId(), 'done', 'mock-agent')
      },
    }
    return { hub, calls }
  }

  it('stamps origin on every inner dispatch when the triggering task carries one', async () => {
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
        payload: { draft: $draft.output }
`
    const def = parseWorkflow(yaml)
    const { hub, calls } = makeOriginStubHub()
    const runner = new WorkflowRunner({ definition: def, hub })

    const task = makeTaskWithOrigin(
      { topic: 'tea' },
      { orgId: 'local', userId: 'user-7' },
    )
    await runner.handleTask(task)

    expect(calls).toHaveLength(2)
    expect(calls[0]?.origin).toEqual({ orgId: 'local', userId: 'user-7' })
    expect(calls[1]?.origin).toEqual({ orgId: 'local', userId: 'user-7' })
  })

  it('omits origin on inner dispatches when the triggering task has none', async () => {
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
`
    const def = parseWorkflow(yaml)
    const { hub, calls } = makeOriginStubHub()
    const runner = new WorkflowRunner({ definition: def, hub })

    const task = makeTask({ topic: 'tea' }) // no origin — admin-style trigger
    await runner.handleTask(task)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.origin).toBeUndefined()
  })

  it('persists origin into RunState; resume re-uses it on remaining steps', async () => {
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
        payload: { draft: $draft.output }
`
    const def = parseWorkflow(yaml)
    const dir = mkdtempSync(join(tmpdir(), 'aipehub-wf-origin-resume-'))
    try {
      const runStore = new RunStore(dir)

      // First run: fail after step 1 so we get a partial RunState on disk.
      let attemptOne = true
      const hub1: HubLike = {
        async dispatch(opts) {
          if (attemptOne && opts.payload && typeof opts.payload === 'object' && 'draft' in (opts.payload as object)) {
            return fail(nextTaskId(), 'boom', 'mock-agent')
          }
          return ok(nextTaskId(), opts.payload ?? null, 'mock-agent')
        },
      }
      const runner1 = new WorkflowRunner({ definition: def, hub: hub1, runStore })
      const task = makeTaskWithOrigin(
        { topic: 'tea' },
        { orgId: 'local', userId: 'user-9' },
      )
      try {
        await runner1.handleTask(task)
      } catch {
        /* expected: halt failure throws */
      }

      // Read the persisted RunState — origin must be there.
      const allIds = await runStore.listRunIds()
      expect(allIds).toHaveLength(1)
      const state = (await runStore.read(allIds[0]!)) as RunState
      expect(state.triggeredByOrigin).toEqual({
        orgId: 'local',
        userId: 'user-9',
      })

      // Reset its status so resumeRun accepts it, and resume with a healthy
      // hub; the re-dispatch of step 2 should still carry the origin.
      state.status = 'running'
      attemptOne = false
      const originSeenOnResume: Array<{ orgId: string; userId: string } | undefined> = []
      const hub2: HubLike = {
        async dispatch(opts) {
          originSeenOnResume.push(opts.origin)
          return ok(nextTaskId(), opts.payload ?? null, 'mock-agent')
        },
      }
      const runner2 = new WorkflowRunner({ definition: def, hub: hub2, runStore })
      await runner2.resumeRun(state)
      // step 1 was already 'done' on disk so it isn't re-dispatched; only
      // step 2 (review) fires — and it carries the persisted origin.
      expect(originSeenOnResume).toEqual([
        { orgId: 'local', userId: 'user-9' },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('WorkflowRunner — dispatch ancestry', () => {
  it('extends the triggering task ancestry onto every inner dispatch', async () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: editorial
  trigger: { capability: run-editorial }
  steps:
    - id: draft
      dispatch:
        strategy: { kind: capability, capabilities: [draft] }
        payload: $trigger.payload
`
    const def = parseWorkflow(yaml)
    const { hub, calls } = makeStubHub(() => ok(nextTaskId(), 'done', 'mock-agent'))
    const runner = new WorkflowRunner({ definition: def, hub })
    const task: Task = {
      ...makeTask({ topic: 'tea' }),
      ancestry: [{ taskId: 'root-agent-task', by: 'architect' }],
    }

    await runner.handleTask(task)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.ancestry).toEqual([
      { taskId: 'root-agent-task', by: 'architect' },
      { taskId: 'trigger-task-1', by: 'workflow:editorial' },
    ])
  })
})

describe('WorkflowRunner — suspended child tasks', () => {
  it('parks the workflow and resumes from the suspended child result', async () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: editorial
  trigger: { capability: run-editorial }
  steps:
    - id: long
      dispatch:
        strategy: { kind: capability, capabilities: [long-running] }
        payload: $trigger.payload
    - id: finish
      dispatch:
        strategy: { kind: capability, capabilities: [finish] }
        payload: { long: $long.output }
`
    const def = parseWorkflow(yaml)
    const childResults = new Map<string, TaskResult>()
    const calls: DispatchCall[] = []
    const hub: HubLike = {
      async dispatch(opts) {
        calls.push({
          from: opts.from,
          strategy: opts.strategy,
          payload: opts.payload,
          ...(opts.ancestry !== undefined ? { ancestry: opts.ancestry } : {}),
        })
        if (calls.length === 1) {
          const suspended: TaskResult = {
            kind: 'suspended',
            taskId: 'child-long-1',
            by: 'long-agent',
            resumeAt: 1700000005000,
            ts: 1700000000000,
          }
          childResults.set('child-long-1', suspended)
          return suspended
        }
        return ok(nextTaskId(), opts.payload, 'finish-agent')
      },
      taskResult(taskId) {
        return childResults.get(taskId)
      },
    }
    const runner = new WorkflowRunner({ definition: def, hub })

    let suspendedState: unknown
    try {
      await runner.onTask(makeTask({ topic: 'tea' }))
      throw new Error('expected workflow task to suspend')
    } catch (err) {
      expect((err as Error).name).toBe('SuspendTaskError')
      expect((err as { resumeAt: number }).resumeAt).toBe(1700000005000)
      suspendedState = (err as { state: unknown }).state
    }

    childResults.set('child-long-1', ok('child-long-1', 'child output', 'long-agent'))
    const resumed = await runner.onResume(makeTask({ topic: 'tea' }), suspendedState)

    expect(resumed.kind).toBe('ok')
    if (resumed.kind === 'ok') {
      expect(resumed.output).toEqual({ long: 'child output' })
    }
    expect(calls).toHaveLength(2)
    expect(calls[1]!.payload).toEqual({ long: 'child output' })
  })
})

describe('WorkflowRunner — revision binding (Phase 15)', () => {
  function oneStepDef(
    id: string,
    triggerCap: string,
    stepCap: string,
    payload: unknown,
  ): WorkflowDefinition {
    return {
      schema: 'aipehub.workflow/v1',
      id,
      trigger: { capability: triggerCap },
      steps: [
        { id: 's', dispatch: { strategy: { kind: 'capability', capabilities: [stepCap] }, payload } },
      ],
      output: '$s.output',
    }
  }

  function fixedResolver(
    currentRev: number,
    byRev: Record<number, WorkflowDefinition>,
  ): DefinitionResolver {
    return {
      current: () => ({ revision: currentRev, definition: byRev[currentRev]! }),
      byRevision: (r) => {
        const d = byRev[r]
        if (!d) throw new WorkflowRevisionError(`no revision ${r}`, 'revision_missing')
        return d
      },
    }
  }

  function runningState(over: Partial<RunState>): RunState {
    return {
      runId: 'r1',
      workflowId: 'wf',
      triggeredByTaskId: 't',
      triggerPayload: {},
      steps: [],
      startedAt: 1,
      status: 'running',
      ...over,
    }
  }

  function trigger(cap: string): Task {
    return {
      id: 't',
      from: 'admin',
      strategy: { kind: 'capability', capabilities: [cap] },
      payload: {},
      createdAt: 1,
    }
  }

  const firstCap = (c: DispatchCall): unknown =>
    c.strategy.kind === 'capability' ? c.strategy.capabilities[0] : undefined

  it('a new run stamps definitionRevision from resolver.current()', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aipehub-rev-stamp-'))
    try {
      const def = oneStepDef('wf', 'go', 'do', 'p')
      const store = new RunStore(tmp)
      store.ensureDirs()
      const { hub } = makeStubHub(() => ok(nextTaskId(), 'OUT', 'bot'))
      const runner = new WorkflowRunner({
        definition: def,
        hub,
        runStore: store,
        resolver: fixedResolver(7, { 7: def }),
        idGenerator: () => 'run-stamp',
      })
      await runner.handleTask(trigger('go'))
      const onDisk = JSON.parse(readFileSync(store.pathFor('run-stamp'), 'utf8')) as RunState
      expect(onDisk.definitionRevision).toBe(7)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('a runner with no resolver stamps revision 1 (single-revision back-compat)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aipehub-rev-default-'))
    try {
      const def = oneStepDef('wf', 'go', 'do', 'p')
      const store = new RunStore(tmp)
      store.ensureDirs()
      const { hub } = makeStubHub(() => ok(nextTaskId(), 'OUT', 'bot'))
      const runner = new WorkflowRunner({
        definition: def,
        hub,
        runStore: store,
        idGenerator: () => 'run-default',
      })
      await runner.handleTask(trigger('go'))
      const onDisk = JSON.parse(readFileSync(store.pathFor('run-default'), 'utf8')) as RunState
      expect(onDisk.definitionRevision).toBe(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('a fresh run binds to the current revision', async () => {
    const rev1 = oneStepDef('wf', 'go', 'rev1-cap', 'rev1-payload')
    const rev2 = oneStepDef('wf', 'go', 'rev2-cap', 'rev2-payload')
    const { hub, calls } = makeStubHub(() => ok(nextTaskId(), 'OUT', 'bot'))
    const runner = new WorkflowRunner({
      definition: rev1,
      hub,
      resolver: fixedResolver(2, { 1: rev1, 2: rev2 }),
    })
    await runner.handleTask(trigger('go'))
    expect(calls).toHaveLength(1)
    expect(firstCap(calls[0]!)).toBe('rev2-cap')
    expect(calls[0]!.payload).toBe('rev2-payload')
  })

  it('resume executes the revision the run STARTED under, not the current one (no drift)', async () => {
    const rev1 = oneStepDef('wf', 'go', 'rev1-cap', 'rev1-payload')
    const rev2 = oneStepDef('wf', 'go', 'rev2-cap', 'rev2-payload')
    const { hub, calls } = makeStubHub(() => ok(nextTaskId(), 'OUT', 'bot'))
    // current() is rev2 — but the run below is stamped rev1, so it must run rev1.
    const runner = new WorkflowRunner({
      definition: rev2,
      hub,
      resolver: fixedResolver(2, { 1: rev1, 2: rev2 }),
    })
    await runner.resumeRun(runningState({ definitionRevision: 1, steps: [] }))
    expect(calls).toHaveLength(1)
    expect(firstCap(calls[0]!)).toBe('rev1-cap')
    expect(calls[0]!.payload).toBe('rev1-payload')
  })

  it('a legacy run with no definitionRevision falls back to the current revision', async () => {
    const def = oneStepDef('wf', 'go', 'do', 'p')
    const { hub, calls } = makeStubHub(() => ok(nextTaskId(), 'OUT', 'bot'))
    const runner = new WorkflowRunner({ definition: def, hub, resolver: fixedResolver(1, { 1: def }) })
    const out = await runner.resumeRun(runningState({ steps: [] })) // no definitionRevision
    expect(out).toBe('OUT')
    expect(calls).toHaveLength(1)
  })

  it('resume throws WorkflowRevisionError when the stamped revision is gone', async () => {
    const def = oneStepDef('wf', 'go', 'do', 'p')
    const { hub } = makeStubHub(() => ok(nextTaskId(), 'OUT', 'bot'))
    const runner = new WorkflowRunner({ definition: def, hub, resolver: fixedResolver(1, { 1: def }) })
    await expect(
      runner.resumeRun(runningState({ definitionRevision: 99, steps: [] })),
    ).rejects.toBeInstanceOf(WorkflowRevisionError)
  })

  it('the definition getter reflects the resolver current revision', () => {
    const rev1 = oneStepDef('wf', 'go', 'rev1-cap', 'p1')
    const rev2 = oneStepDef('wf', 'go', 'rev2-cap', 'p2')
    const { hub } = makeStubHub(() => ok('x', 'y', 'b'))
    const runner = new WorkflowRunner({
      definition: rev1,
      hub,
      resolver: fixedResolver(2, { 1: rev1, 2: rev2 }),
    })
    const step0 = runner.definition.steps[0]!
    const cap =
      step0.dispatch.strategy.kind === 'capability' ? step0.dispatch.strategy.capabilities[0] : undefined
    expect(cap).toBe('rev2-cap')
  })
})

// v5 C-M2 — node-level I/O authorization. A node's declared `dataClasses` ride
// onto the dispatched Task.dataClasses so the per-link OUTBOUND data-class gate
// (enforced on the federation wrapper) authorizes federated dispatch per node.
// The runner is transport-agnostic — it just stamps; the host E2E proves the
// gate fires (peer-kb-isolation pattern). Here we pin the stamp itself.
describe('WorkflowRunner — node-level data classes (v5 C-M2)', () => {
  it('stamps a node-declared dataClasses onto the dispatch', async () => {
    const def: WorkflowDefinition = {
      schema: 'aipehub.workflow/v1',
      id: 'io-auth',
      trigger: { capability: 'run-io' },
      steps: [
        {
          id: 'send-pii',
          dispatch: {
            strategy: { kind: 'capability', capabilities: ['remote-svc'] },
            payload: { ssn: '...' },
            dataClasses: ['pii'],
          },
        },
      ],
      onFailure: 'halt',
    }
    const { hub, calls } = makeStubHub(() => ok('send-pii', 'done', 'mock'))
    const r = new WorkflowRunner({ definition: def, hub })
    await r.onTask(makeTask({}))
    expect(calls).toHaveLength(1)
    expect(calls[0].dataClasses).toEqual(['pii'])
  })

  it('per-node — different nodes carry different (or no) data classes', async () => {
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: io-auth-multi
  trigger: { capability: run-io }
  steps:
    - id: public-step
      dispatch:
        strategy: { kind: capability, capabilities: [remote-svc] }
        payload: { note: hi }
        dataClasses: [public]
    - id: pii-step
      dispatch:
        strategy: { kind: capability, capabilities: [remote-svc] }
        payload: { ssn: x }
        dataClasses: [pii, confidential]
    - id: bare-step
      dispatch:
        strategy: { kind: capability, capabilities: [remote-svc] }
        payload: { x: 1 }
`
    const def = parseWorkflow(yaml)
    const { hub, calls } = makeStubHub(() => ok('s', 'ok', 'mock'))
    const r = new WorkflowRunner({ definition: def, hub })
    await r.onTask(makeTask({}))
    expect(calls).toHaveLength(3)
    expect(calls[0].dataClasses).toEqual(['public'])
    expect(calls[1].dataClasses).toEqual(['pii', 'confidential'])
    expect(calls[2].dataClasses).toBeUndefined() // a bare node stamps nothing
  })
})
