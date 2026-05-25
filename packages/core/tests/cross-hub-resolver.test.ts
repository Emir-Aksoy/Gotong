/**
 * D2 — scheduler-level coverage for the cross-hub explicit-dispatch
 * resolver. Confirms:
 *   - resolver is consulted ONLY when the explicit target is missing locally
 *   - returning null falls through to no_participant
 *   - returning a dispatcher takes over and its result is forwarded
 *   - the dispatcher receives the original task untouched
 *   - exceptions in the dispatcher are caught and surface as no_participant
 *   - resolver is NOT consulted when the target exists locally (local wins)
 *
 * Higher-level wire tests (Hub + PeerRegistry + HubLink) live in
 * packages/host/tests/cross-hub-hitl.test.ts.
 */

import { describe, expect, it, vi } from 'vitest'

import { Registry } from '../src/registry.js'
import {
  DefaultScheduler,
  type CancelNotifier,
  type CrossHubDispatcher,
  type CrossHubExplicitResolver,
  type TaskInvoker,
} from '../src/scheduler.js'
import type { Participant, Task, TaskResult } from '../src/types.js'

function makeTask(to: string, id = 't-x', origin?: Task['origin']): Task {
  return {
    id,
    from: 'system',
    strategy: { kind: 'explicit', to },
    payload: { kind: 'agent-question' },
    createdAt: Date.now(),
    ...(origin ? { origin } : {}),
  }
}

function makeOkResult(id: string, by: string): TaskResult {
  return { kind: 'ok', taskId: id, by, output: { ack: true }, ts: Date.now() }
}

describe('DefaultScheduler — cross-hub explicit resolver (D2)', () => {
  it('falls through to no_participant when no resolver is configured', async () => {
    const registry = new Registry()
    const invoke = vi.fn<Parameters<TaskInvoker>, ReturnType<TaskInvoker>>()
    const s = new DefaultScheduler(registry, invoke, (() => {}) as CancelNotifier)
    const r = await s.dispatch(makeTask('remote-user'))
    expect(r.kind).toBe('no_participant')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('falls through when resolver returns null', async () => {
    const registry = new Registry()
    const invoke = vi.fn<Parameters<TaskInvoker>, ReturnType<TaskInvoker>>()
    const resolver: CrossHubExplicitResolver = vi.fn(() => null)
    const s = new DefaultScheduler(
      registry,
      invoke,
      (() => {}) as CancelNotifier,
      undefined,
      resolver,
    )
    const r = await s.dispatch(makeTask('remote-user'))
    expect(r.kind).toBe('no_participant')
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('routes via the returned dispatcher when resolver matches', async () => {
    const registry = new Registry()
    const invoke = vi.fn<Parameters<TaskInvoker>, ReturnType<TaskInvoker>>()
    const remoteResult = makeOkResult('t-x', 'remote-user')
    const dispatcher: CrossHubDispatcher = vi.fn(async () => remoteResult)
    const resolver: CrossHubExplicitResolver = vi.fn(() => dispatcher)
    const s = new DefaultScheduler(
      registry,
      invoke,
      (() => {}) as CancelNotifier,
      undefined,
      resolver,
    )
    const r = await s.dispatch(makeTask('remote-user'))
    expect(r).toEqual(remoteResult)
    expect(invoke).not.toHaveBeenCalled() // local invoke never runs
  })

  it('passes the task UNTOUCHED to the dispatcher', async () => {
    const registry = new Registry()
    let seen: Task | undefined
    const dispatcher: CrossHubDispatcher = async (t) => {
      seen = t
      return makeOkResult(t.id, 'remote-user')
    }
    const resolver: CrossHubExplicitResolver = () => dispatcher
    const s = new DefaultScheduler(
      registry,
      vi.fn(),
      (() => {}) as CancelNotifier,
      undefined,
      resolver,
    )
    const original = makeTask('remote-user', 't-passthru', {
      orgId: 'hub_remote',
      userId: 'u_42',
    })
    await s.dispatch(original)
    expect(seen).toBe(original) // exact ref, no clone
    expect(seen?.origin?.orgId).toBe('hub_remote')
  })

  it('catches dispatcher exceptions and surfaces no_participant', async () => {
    const registry = new Registry()
    const dispatcher: CrossHubDispatcher = async () => {
      throw new Error('socket closed')
    }
    const resolver: CrossHubExplicitResolver = () => dispatcher
    const s = new DefaultScheduler(
      registry,
      vi.fn(),
      (() => {}) as CancelNotifier,
      undefined,
      resolver,
    )
    const r = await s.dispatch(makeTask('remote-user'))
    expect(r.kind).toBe('no_participant')
    if (r.kind === 'no_participant') {
      expect(r.reason).toContain('socket closed')
    }
  })

  it('LOCAL participant wins — resolver is NOT consulted when local id exists', async () => {
    const registry = new Registry()
    const local: Participant = {
      id: 'local-user',
      kind: 'human',
      capabilities: [],
      onTask: async () => makeOkResult('t-x', 'local-user'),
    }
    registry.register(local)
    const invoke: TaskInvoker = async (p, task) => makeOkResult(task.id, p.id)
    const resolver: CrossHubExplicitResolver = vi.fn(() => async () => {
      throw new Error('should not be called')
    })
    const s = new DefaultScheduler(
      registry,
      invoke,
      (() => {}) as CancelNotifier,
      undefined,
      resolver,
    )
    const r = await s.dispatch(makeTask('local-user'))
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.by).toBe('local-user')
    expect(resolver).not.toHaveBeenCalled()
  })

  it('resolver receives both the targetId and the task', async () => {
    const registry = new Registry()
    let seenId: string | undefined
    let seenTaskId: string | undefined
    const resolver: CrossHubExplicitResolver = (id, task) => {
      seenId = id
      seenTaskId = task.id
      return null // fall through; we just inspect the call
    }
    const s = new DefaultScheduler(
      registry,
      vi.fn(),
      (() => {}) as CancelNotifier,
      undefined,
      resolver,
    )
    await s.dispatch(makeTask('remote-user', 't-inspect'))
    expect(seenId).toBe('remote-user')
    expect(seenTaskId).toBe('t-inspect')
  })
})
