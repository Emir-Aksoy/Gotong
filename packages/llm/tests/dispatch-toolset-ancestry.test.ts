/**
 * Phase 10 M2 — DispatchToolset ancestry inheritance.
 *
 * Validates that:
 *   1. `runForTask(task, fn)` scopes per-task context (taskId +
 *      inherited ancestry) into AsyncLocalStorage for the duration
 *      of `fn`, so concurrent tasks on the same toolset instance
 *      see their own values without bleeding.
 *   2. `callTool` invoked inside `runForTask` appends the current
 *      task's frame (`{taskId, by: self}`) onto the inherited
 *      ancestry before forwarding to `hub.dispatch`.
 *   3. With no current task context (toolset used outside an
 *      LlmAgent loop) `callTool` does NOT pass an `ancestry` field
 *      — equivalent to a root dispatch.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AncestryNode, ParticipantId, TaskResult } from '@aipehub/core'

import {
  DispatchToolset,
  type DispatchSurface,
} from '../src/dispatch-toolset.js'

function okResult(): TaskResult {
  return {
    kind: 'ok',
    taskId: 'sub-task',
    by: 'sub' as ParticipantId,
    output: 'done',
    ts: 1,
  }
}

function makeHub() {
  const dispatch = vi.fn<DispatchSurface['dispatch']>(async () => okResult())
  const hub: DispatchSurface = { dispatch }
  return { hub, dispatch }
}

describe('DispatchToolset.runForTask + ancestry passthrough', () => {
  it('passes no ancestry field when runForTask was never called', async () => {
    const { hub, dispatch } = makeHub()
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    await ts.callTool('dispatch_task', { agentId: 'sub', payload: 'x' })
    const arg = dispatch.mock.calls[0][0]
    expect('ancestry' in arg).toBe(false)
  })

  it('appends current-task frame onto inherited ancestry chain', async () => {
    const { hub, dispatch } = makeHub()
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    const inherited: AncestryNode[] = [
      { taskId: 'root-task', by: 'root' as ParticipantId },
    ]
    await ts.runForTask(
      { id: 'current-task', from: 'me', ancestry: inherited },
      async () => {
        await ts.callTool('dispatch_task', { agentId: 'sub', payload: 'x' })
      },
    )

    const arg = dispatch.mock.calls[0][0]
    expect(arg.ancestry).toEqual([
      { taskId: 'root-task', by: 'root' },
      { taskId: 'current-task', by: 'me' },
    ])
  })

  it('omits ancestry when current task is root (no inherited chain)', async () => {
    const { hub, dispatch } = makeHub()
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    // Root task — no ancestry on it
    await ts.runForTask(
      { id: 'root-task', from: 'user' },
      async () => {
        await ts.callTool('dispatch_task', { agentId: 'sub', payload: 'x' })
      },
    )

    // child gets [{taskId: root-task, by: me}] — single-element chain,
    // so it IS passed to the hub.
    const arg = dispatch.mock.calls[0][0]
    expect(arg.ancestry).toEqual([{ taskId: 'root-task', by: 'me' }])
  })

  it('uses selfId (not the dispatched-target id) for the appended frame', async () => {
    const { hub, dispatch } = makeHub()
    const ts = DispatchToolset.create({
      hub,
      selfId: 'architect' as ParticipantId,
      allowedAgents: ['writer' as ParticipantId],
    })
    await ts.runForTask({ id: 'task-x', from: 'user' }, async () => {
      await ts.callTool('dispatch_task', { agentId: 'writer', payload: 'x' })
    })
    const arg = dispatch.mock.calls[0][0]
    expect(arg.ancestry?.[arg.ancestry.length - 1]).toEqual({
      taskId: 'task-x',
      by: 'architect',
    })
  })

  it('does not mutate the inherited ancestry array', async () => {
    const { hub } = makeHub()
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    const inherited: AncestryNode[] = [
      { taskId: 'root', by: 'root' as ParticipantId },
    ]
    const inheritedSnapshot = [...inherited]
    await ts.runForTask(
      { id: 'task', from: 'me', ancestry: inherited },
      async () => {
        await ts.callTool('dispatch_task', { agentId: 'sub', payload: 'x' })
      },
    )
    expect(inherited).toEqual(inheritedSnapshot)
  })

  it('returns the inner fn\'s value through runForTask', async () => {
    const { hub } = makeHub()
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
    })
    const out = await ts.runForTask(
      { id: 't', from: 'me' },
      async () => 'inner-return',
    )
    expect(out).toBe('inner-return')
  })
})

describe('DispatchToolset — AsyncLocalStorage concurrent task isolation', () => {
  it('two concurrent tasks see their own ancestry, not each other\'s', async () => {
    // Capture every (from, ancestry) the hub sees so we can verify
    // the toolset wires the right frame to the right dispatch even
    // when both calls interleave.
    const seen: Array<{
      from: string
      ancestry: readonly AncestryNode[] | undefined
    }> = []
    const hub: DispatchSurface = {
      dispatch: async (opts) => {
        seen.push({ from: opts.from, ancestry: opts.ancestry })
        return okResult()
      },
    }
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })

    // Two parallel runForTask scopes; each yields between enterWith
    // and the dispatch so the async chains interleave — the test
    // would fail if the toolset used enterWith (shared mutable
    // binding) or any other approach that doesn't scope per-call.
    const chainA = ts.runForTask(
      {
        id: 'task-A',
        from: 'me',
        ancestry: [{ taskId: 'root-A', by: 'rootA' }],
      },
      async () => {
        await Promise.resolve()
        await ts.callTool('dispatch_task', { agentId: 'sub', payload: 'a' })
      },
    )
    const chainB = ts.runForTask(
      {
        id: 'task-B',
        from: 'me',
        ancestry: [{ taskId: 'root-B', by: 'rootB' }],
      },
      async () => {
        await Promise.resolve()
        await ts.callTool('dispatch_task', { agentId: 'sub', payload: 'b' })
      },
    )
    await Promise.all([chainA, chainB])

    expect(seen.length).toBe(2)
    const a = seen.find((s) =>
      s.ancestry?.some((n) => n.taskId === 'root-A'),
    )
    const b = seen.find((s) =>
      s.ancestry?.some((n) => n.taskId === 'root-B'),
    )
    expect(a?.ancestry).toEqual([
      { taskId: 'root-A', by: 'rootA' },
      { taskId: 'task-A', by: 'me' },
    ])
    expect(b?.ancestry).toEqual([
      { taskId: 'root-B', by: 'rootB' },
      { taskId: 'task-B', by: 'me' },
    ])
  })

  it('runForTask in one chain does NOT leak into a sibling chain that never called it', async () => {
    const seen: Array<readonly AncestryNode[] | undefined> = []
    const hub: DispatchSurface = {
      dispatch: async (opts) => {
        seen.push(opts.ancestry)
        return okResult()
      },
    }
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })

    const chainA = ts.runForTask(
      {
        id: 'task-A',
        from: 'me',
        ancestry: [{ taskId: 'root', by: 'root' as ParticipantId }],
      },
      async () => {
        await Promise.resolve()
        await ts.callTool('dispatch_task', { agentId: 'sub', payload: 'a' })
      },
    )

    // chain B: never enters runForTask, expects no ancestry
    const chainB = (async () => {
      await Promise.resolve()
      await ts.callTool('dispatch_task', { agentId: 'sub', payload: 'b' })
    })()

    await Promise.all([chainA, chainB])
    const withAncestry = seen.filter((s) => s !== undefined)
    const withoutAncestry = seen.filter((s) => s === undefined)
    expect(withAncestry.length).toBe(1)
    expect(withoutAncestry.length).toBe(1)
  })
})

describe('LlmAgentToolset.runForTask contract — DispatchToolset accepts the wider Task shape', () => {
  it('accepts a Task-like object with id/from/ancestry shapes', async () => {
    const { hub } = makeHub()
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    await expect(
      ts.runForTask({ id: 't1', from: 'me' }, async () => 1),
    ).resolves.toBe(1)
    await expect(
      ts.runForTask({ id: 't2', from: 'me', ancestry: [] }, async () => 2),
    ).resolves.toBe(2)
    await expect(
      ts.runForTask(
        { id: 't3', from: 'me', ancestry: [{ taskId: 'r', by: 'r' }] },
        async () => 3,
      ),
    ).resolves.toBe(3)
  })
})
