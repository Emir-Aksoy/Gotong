/**
 * Phase 11 M3 — `Hub.resumeTask` re-entry path.
 *
 * Coverage:
 *   - routes through participant.onResume when implemented
 *   - falls back to onTask when onResume is absent
 *   - returns no_participant when agent isn't registered
 *   - returns no_participant when participant has neither hook
 *   - writes both `task_resumed` (signal) and `task_result` (outcome)
 *     transcript entries — never a fresh `task` entry
 *   - state is forwarded verbatim to onResume
 *   - suspend-again: onResume throws SuspendTaskError → notifier
 *     called → result.kind='suspended'
 *   - regular throw from onResume → kind='failed'
 *   - worker slot incLoad/decLoad invariant on every path
 */
import { describe, expect, it, vi } from 'vitest'

import { Hub } from '../src/hub.js'
import { AgentParticipant } from '../src/participants/agent.js'
import { SuspendTaskError } from '../src/suspend.js'
import type {
  ParticipantId,
  Task,
  TaskResult,
  TranscriptEntry,
} from '../src/types.js'

function makeTask(id = 'task-resumed-1'): Task {
  return {
    id,
    from: 'system',
    strategy: { kind: 'explicit', to: 'agent-a' },
    payload: { original: 'payload' },
    createdAt: 1_000,
  }
}

class ResumableAgent extends AgentParticipant {
  public seenResumeStates: unknown[] = []
  public seenTaskCalls: number = 0
  constructor(
    id: string,
    private readonly resumeReply: unknown = { wokeUp: true },
  ) {
    super({ id, capabilities: ['nap'] })
  }
  protected async handleTask(_t: Task): Promise<unknown> {
    this.seenTaskCalls++
    return { ranAsTask: true }
  }
  protected override async handleResume(_t: Task, state: unknown): Promise<unknown> {
    this.seenResumeStates.push(state)
    return this.resumeReply
  }
}

class NoResumeAgent extends AgentParticipant {
  public seenTaskCalls: number = 0
  constructor(id: string) {
    super({ id, capabilities: ['nap'] })
  }
  protected async handleTask(_t: Task): Promise<unknown> {
    this.seenTaskCalls++
    return { fellBackToOnTask: true }
  }
  // No handleResume override → AgentParticipant default delegates
  // to handleTask, hitting our seenTaskCalls increment.
}

class SuspendAgainAgent extends AgentParticipant {
  constructor(
    id: string,
    private readonly resumeAt: number,
    private readonly state: unknown,
  ) {
    super({ id, capabilities: ['nap'] })
  }
  protected async handleTask(_t: Task): Promise<unknown> {
    throw new SuspendTaskError({ resumeAt: this.resumeAt, state: this.state })
  }
  // A real suspend-again agent OVERRIDES handleResume to decide, on each wake,
  // whether to nap another window — the legitimate re-suspend pattern. (The
  // L11 guard rejects re-suspending via the *default* handleResume, which can
  // never make progress; deliberate re-suspend must be explicit like this.)
  protected override async handleResume(_t: Task, _state: unknown): Promise<unknown> {
    throw new SuspendTaskError({ resumeAt: this.resumeAt, state: this.state })
  }
}

class BoomyResumeAgent extends AgentParticipant {
  constructor(id: string) {
    super({ id, capabilities: ['nap'] })
  }
  protected async handleTask(_t: Task): Promise<unknown> {
    return null
  }
  protected override async handleResume(
    _t: Task,
    _state: unknown,
  ): Promise<unknown> {
    throw new Error('resume crashed')
  }
}

// Captures the exact Task object handed to onResume, so a test can assert
// what the resume path did (or didn't) carry across — R10 deadline strip.
class DeadlineRecordingAgent extends AgentParticipant {
  public resumedWith: Task[] = []
  constructor(id: string) {
    super({ id, capabilities: ['nap'] })
  }
  protected async handleTask(_t: Task): Promise<unknown> {
    return null
  }
  protected override async handleResume(t: Task, _state: unknown): Promise<unknown> {
    this.resumedWith.push(t)
    return { ok: true }
  }
}

describe('Hub.resumeTask — happy path', () => {
  it('invokes onResume with the supplied state', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    const agent = new ResumableAgent('napper', { resumed: true })
    hub.register(agent)

    const task = makeTask()
    const result = await hub.resumeTask(
      'napper' as ParticipantId,
      task,
      { round: 2 },
    )

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.output).toEqual({ resumed: true })
      expect(result.by).toBe('napper')
      expect(result.taskId).toBe(task.id)
    }
    expect(agent.seenResumeStates).toEqual([{ round: 2 }])
    expect(agent.seenTaskCalls).toBe(0)
    await hub.stop()
  })

  it('falls back to onTask when participant has no override', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    const agent = new NoResumeAgent('plain')
    hub.register(agent)

    const result = await hub.resumeTask(
      'plain' as ParticipantId,
      makeTask(),
      { dropped: 'ignored' },
    )

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.output).toEqual({ fellBackToOnTask: true })
    }
    // Default AgentParticipant.handleResume forwards to handleTask
    // so the same handler ran — the participant just doesn't know
    // it's being resumed. That's the contract.
    expect(agent.seenTaskCalls).toBe(1)
    await hub.stop()
  })

  it('writes both task_resumed and task_result transcript entries', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    const events: TranscriptEntry[] = []
    hub.onEvent((e) => events.push(e))
    hub.register(new ResumableAgent('napper'))

    await hub.resumeTask('napper' as ParticipantId, makeTask(), { ok: true })

    const resumed = events.filter((e) => e.kind === 'task_resumed')
    const results = events.filter((e) => e.kind === 'task_result')
    expect(resumed.length).toBe(1)
    expect(results.length).toBe(1)
    // Critical: no fresh `task` entry is written — that would
    // duplicate the original dispatch in the transcript.
    expect(events.filter((e) => e.kind === 'task').length).toBe(0)
    if (resumed[0]?.kind === 'task_resumed') {
      expect(resumed[0].data.by).toBe('napper')
    }
    await hub.stop()
  })

  it('worker slot is released after happy-path resume', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new ResumableAgent('napper'))

    await hub.resumeTask('napper' as ParticipantId, makeTask(), {})
    expect(hub.registry.loadOf('napper' as ParticipantId)).toBe(0)
    await hub.stop()
  })
})

describe('Hub.resumeTask — error paths', () => {
  it('returns no_participant when agent is not registered', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    const result = await hub.resumeTask(
      'ghost' as ParticipantId,
      makeTask(),
      null,
    )
    expect(result.kind).toBe('no_participant')
    if (result.kind === 'no_participant') {
      expect(result.reason).toMatch(/not registered/)
    }
    await hub.stop()
  })

  it('returns failed and surfaces error message when handleResume throws', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new BoomyResumeAgent('boomer'))

    const result = await hub.resumeTask(
      'boomer' as ParticipantId,
      makeTask(),
      null,
    )
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toBe('resume crashed')
      expect(result.by).toBe('boomer')
    }
    expect(hub.registry.loadOf('boomer' as ParticipantId)).toBe(0)
    await hub.stop()
  })
})

describe('Hub.resumeTask — suspend-again', () => {
  it('catches SuspendTaskError on resume, calls notifier, returns kind=suspended', async () => {
    const notifier = vi.fn().mockResolvedValue(undefined)
    const hub = Hub.inMemory({ suspendNotifier: notifier })
    await hub.start()
    hub.register(new SuspendAgainAgent('chainer', 55_555, { round: 2 }))

    const task = makeTask()
    const result = await hub.resumeTask(
      'chainer' as ParticipantId,
      task,
      { round: 1 },
    )

    expect(result.kind).toBe('suspended')
    if (result.kind === 'suspended') {
      expect(result.resumeAt).toBe(55_555)
      expect(result.by).toBe('chainer')
    }
    expect(notifier).toHaveBeenCalledTimes(1)
    const args = notifier.mock.calls[0]!
    expect(args[1]).toBe('chainer')
    expect(args[2]).toEqual({ resumeAt: 55_555, state: { round: 2 } })
    expect(hub.registry.loadOf('chainer' as ParticipantId)).toBe(0)
    await hub.stop()
  })

  it('degrades to failed when notifier rejects on suspend-again', async () => {
    const notifier = vi.fn().mockRejectedValue(new Error('disk full'))
    const hub = Hub.inMemory({ suspendNotifier: notifier })
    await hub.start()
    hub.register(new SuspendAgainAgent('chainer', 99, null))

    const result = await hub.resumeTask(
      'chainer' as ParticipantId,
      makeTask(),
      null,
    )
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toMatch(/suspend persist failed: disk full/)
    }
    expect(hub.registry.loadOf('chainer' as ParticipantId)).toBe(0)
    await hub.stop()
  })

  it('suspend-again still works without a notifier (non-durable)', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new SuspendAgainAgent('chainer', 42, null))

    const result = await hub.resumeTask(
      'chainer' as ParticipantId,
      makeTask(),
      null,
    )
    expect(result.kind).toBe('suspended')
    if (result.kind === 'suspended') {
      expect(result.resumeAt).toBe(42)
    }
    await hub.stop()
  })
})

describe('Hub.resumeTask — R10 stale deadline strip', () => {
  it('strips a stale deadlineMs before handing the task to onResume', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    const agent = new DeadlineRecordingAgent('clocky')
    hub.register(agent)

    // The task parked back when its deadline was still live; by resume time
    // that absolute epoch is long past. A naive carry-through would let a
    // deadline-enforcing scheduler instantly read `deadline_expired`.
    const task: Task = { ...makeTask(), deadlineMs: 1 }
    const result = await hub.resumeTask('clocky' as ParticipantId, task, {})

    expect(result.kind).toBe('ok')
    expect(agent.resumedWith).toHaveLength(1)
    expect(agent.resumedWith[0]!.deadlineMs).toBeUndefined()
    // The rest of the envelope rides across untouched.
    expect(agent.resumedWith[0]!.id).toBe(task.id)
    expect(agent.resumedWith[0]!.payload).toEqual(task.payload)
    expect(agent.resumedWith[0]!.strategy).toEqual(task.strategy)
    await hub.stop()
  })

  it('leaves a deadline-free task unchanged (no-op strip)', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    const agent = new DeadlineRecordingAgent('clocky')
    hub.register(agent)

    const task = makeTask() // no deadlineMs
    await hub.resumeTask('clocky' as ParticipantId, task, {})

    expect(agent.resumedWith[0]!.deadlineMs).toBeUndefined()
    expect(agent.resumedWith[0]!.id).toBe(task.id)
    await hub.stop()
  })

  it('re-persists a deadline-free envelope when the participant suspends again', async () => {
    const notifier = vi.fn().mockResolvedValue(undefined)
    const hub = Hub.inMemory({ suspendNotifier: notifier })
    await hub.start()
    hub.register(new SuspendAgainAgent('chainer', 777, { round: 2 }))

    const task: Task = { ...makeTask(), deadlineMs: 5 }
    const result = await hub.resumeTask(
      'chainer' as ParticipantId,
      task,
      { round: 1 },
    )

    expect(result.kind).toBe('suspended')
    // The task forwarded to the notifier for re-persistence must NOT carry
    // the stale deadline, so the *next* resume stays clean too — the strip
    // is durable, not just applied to the in-flight onResume call.
    expect(notifier).toHaveBeenCalledTimes(1)
    const persistedTask = notifier.mock.calls[0]![0] as Task
    expect(persistedTask.deadlineMs).toBeUndefined()
    expect(persistedTask.id).toBe(task.id)
    await hub.stop()
  })
})
