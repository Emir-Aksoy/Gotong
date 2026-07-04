/**
 * Phase 10 M2 — Hub.dispatch ancestry tracking + depth + cycle gates.
 *
 * Validates the wire-level contract DispatchToolset (in @gotong/llm)
 * relies on. The toolset code itself is tested in
 * @gotong/llm/tests/dispatch-toolset-ancestry.test.ts; this file
 * covers the core/hub side in isolation so a regression here is
 * traceable without crossing package boundaries.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, readMaxDispatchDepth } from '../src/hub.js'
import { AgentParticipant } from '../src/participants/agent.js'
import type { AncestryNode, ParticipantId, Task, TaskResult } from '../src/types.js'

class EchoAgent extends AgentParticipant {
  constructor(id: string, capabilities: readonly string[]) {
    super({ id, capabilities })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    return { from: this.id, payload: task.payload }
  }
}

function node(taskId: string, by: string): AncestryNode {
  return { taskId, by: by as ParticipantId }
}

function makeChain(length: number, byPrefix = 'a'): AncestryNode[] {
  const out: AncestryNode[] = []
  for (let i = 0; i < length; i++) {
    out.push(node(`task-${i}`, `${byPrefix}${i}`))
  }
  return out
}

describe('Hub.dispatch ancestry — passthrough', () => {
  it('omits ancestry field on root dispatches (no opts.ancestry)', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('writer', ['draft']))
    await hub.dispatch({
      from: 'root' as ParticipantId,
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'x',
    })
    const taskEntry = hub.transcript.all().find((e) => e.kind === 'task')!
    expect(taskEntry).toBeDefined()
    const t = (taskEntry as { data: Task }).data
    expect('ancestry' in t).toBe(false)
    await hub.stop()
  })

  it('omits ancestry field when an empty array is passed (transcript stays clean)', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('writer', ['draft']))
    await hub.dispatch({
      from: 'root' as ParticipantId,
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'x',
      ancestry: [],
    })
    const taskEntry = hub.transcript.all().find((e) => e.kind === 'task')!
    const t = (taskEntry as { data: Task }).data
    expect('ancestry' in t).toBe(false)
    await hub.stop()
  })

  it('attaches non-empty ancestry to the persisted Task', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('writer', ['draft']))
    const chain = [node('root-task', 'root-agent')]
    await hub.dispatch({
      from: 'writer' as ParticipantId,
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'x',
      ancestry: chain,
    })
    const taskEntry = hub.transcript.all().find((e) => e.kind === 'task')!
    const t = (taskEntry as { data: Task }).data
    expect(t.ancestry).toEqual(chain)
    await hub.stop()
  })
})

describe('Hub.dispatch ancestry — depth gate', () => {
  it('rejects when ancestry length equals MAX_DISPATCH_DEPTH', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('writer', ['draft']))
    const chain = makeChain(readMaxDispatchDepth(), 'agent')
    const result = await hub.dispatch({
      from: 'newcomer' as ParticipantId,
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'x',
      ancestry: chain,
    })
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toBe('dispatch_depth_exceeded')
      expect(result.by).toBe('scheduler')
    }
    await hub.stop()
  })

  it('allows ancestry length equal to MAX_DISPATCH_DEPTH - 1 (boundary)', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('writer', ['draft']))
    const chain = makeChain(readMaxDispatchDepth() - 1, 'agent')
    const result = await hub.dispatch({
      from: 'newcomer' as ParticipantId,
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'x',
      ancestry: chain,
    })
    expect(result.kind).toBe('ok')
    await hub.stop()
  })

  it('records rejected dispatch as task + failed-result pair in transcript', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    const chain = makeChain(readMaxDispatchDepth(), 'agent')
    await hub.dispatch({
      from: 'newcomer' as ParticipantId,
      strategy: { kind: 'explicit', to: 'writer' as ParticipantId },
      payload: 'x',
      ancestry: chain,
    })
    const kinds = hub.transcript.all().map((e) => e.kind)
    const lastTwo = kinds.slice(-2)
    expect(lastTwo).toEqual(['task', 'task_result'])
    const lastResultEntry = hub.transcript.all().findLast(
      (e) => e.kind === 'task_result',
    )
    const r = (lastResultEntry as { data: TaskResult }).data
    expect(r.kind).toBe('failed')
    await hub.stop()
  })
})

describe('Hub.dispatch ancestry — cycle gate', () => {
  it('rejects when explicit target already appears as an ancestor `by` (A→B→A)', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('alice', ['x']))
    hub.register(new EchoAgent('bob', ['y']))
    // alice ran the root task; now bob (the agent who alice
    // dispatched to) wants to dispatch back to alice — cycle.
    const chain = [node('root', 'alice')]
    const result = await hub.dispatch({
      from: 'bob' as ParticipantId,
      strategy: { kind: 'explicit', to: 'alice' as ParticipantId },
      payload: 'x',
      ancestry: chain,
    })
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') expect(result.error).toBe('dispatch_cycle')
    await hub.stop()
  })

  it('allows explicit target not on the chain even with a non-empty ancestry', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('writer', ['draft']))
    const chain = [node('root', 'alice'), node('mid', 'bob')]
    const result = await hub.dispatch({
      from: 'carol' as ParticipantId,
      strategy: { kind: 'explicit', to: 'writer' as ParticipantId },
      payload: 'x',
      ancestry: chain,
    })
    expect(result.kind).toBe('ok')
    await hub.stop()
  })

  it('allows an agent to re-dispatch a task it itself executed (self-recursion bounded by depth)', async () => {
    // alice is on chain; alice is also new `from`. The dispatcher being
    // already on the chain is NOT a cycle — recursing agents are
    // legitimate. The depth gate stops actual infinite loops.
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('writer', ['draft']))
    const chain = [node('root', 'alice')]
    const result = await hub.dispatch({
      from: 'alice' as ParticipantId,
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'x',
      ancestry: chain,
    })
    expect(result.kind).toBe('ok')
    await hub.stop()
  })

  it('does not check cycle on capability strategy (matcher hasn\'t picked yet)', async () => {
    // alice already executed a task on the chain; a capability dispatch
    // that *could* match alice is not pre-rejected — the matcher might
    // pick bob, and even if alice gets picked the depth gate bounds it.
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('alice', ['ambiguous']))
    hub.register(new EchoAgent('bob', ['ambiguous']))
    const chain = [node('root', 'alice')]
    const result = await hub.dispatch({
      from: 'carol' as ParticipantId,
      strategy: { kind: 'capability', capabilities: ['ambiguous'] },
      payload: 'x',
      ancestry: chain,
    })
    expect(result.kind).toBe('ok')
    await hub.stop()
  })
})

describe('readMaxDispatchDepth', () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.GOTONG_MAX_DISPATCH_DEPTH
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.GOTONG_MAX_DISPATCH_DEPTH
    else process.env.GOTONG_MAX_DISPATCH_DEPTH = saved
  })

  it('defaults to 5 when env var unset', () => {
    delete process.env.GOTONG_MAX_DISPATCH_DEPTH
    expect(readMaxDispatchDepth()).toBe(5)
  })

  it('honours a valid override', () => {
    process.env.GOTONG_MAX_DISPATCH_DEPTH = '12'
    expect(readMaxDispatchDepth()).toBe(12)
  })

  it('falls back to default for non-numeric input', () => {
    process.env.GOTONG_MAX_DISPATCH_DEPTH = 'banana'
    expect(readMaxDispatchDepth()).toBe(5)
  })

  it('falls back to default for out-of-range input (<1)', () => {
    process.env.GOTONG_MAX_DISPATCH_DEPTH = '0'
    expect(readMaxDispatchDepth()).toBe(5)
  })

  it('falls back to default for out-of-range input (>50)', () => {
    process.env.GOTONG_MAX_DISPATCH_DEPTH = '999'
    expect(readMaxDispatchDepth()).toBe(5)
  })

  it('falls back to default for non-integer input', () => {
    process.env.GOTONG_MAX_DISPATCH_DEPTH = '3.5'
    expect(readMaxDispatchDepth()).toBe(5)
  })
})
