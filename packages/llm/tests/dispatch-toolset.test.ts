import { describe, expect, it, vi } from 'vitest'
import type {
  DispatchStrategy,
  ParticipantId,
  TaskResult,
} from '@aipehub/core'
import {
  DispatchToolset,
  type DispatchSurface,
} from '../src/dispatch-toolset.js'

function okResult(output: unknown = 'done'): TaskResult {
  return {
    kind: 'ok',
    taskId: 'task-1',
    by: 'sub' as ParticipantId,
    output,
    ts: 1,
  }
}

function makeHub(result: TaskResult) {
  const dispatch = vi.fn<DispatchSurface['dispatch']>(async () => result)
  const hub: DispatchSurface = { dispatch }
  return { hub, dispatch }
}

function textOf(r: { content: ReadonlyArray<unknown> }): string {
  const block = r.content[0] as { type?: string; text?: string }
  return block?.text ?? ''
}

describe('DispatchToolset.listTools', () => {
  it('lists a single dispatch_task tool by default', async () => {
    const { hub } = makeHub(okResult())
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    const tools = await ts.listTools()
    expect(tools.length).toBe(1)
    expect(tools[0].name).toBe('dispatch_task')
    expect((tools[0].inputSchema as { type: string }).type).toBe('object')
  })

  it('honours toolName override', async () => {
    const { hub } = makeHub(okResult())
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      toolName: 'spawn',
    })
    const tools = await ts.listTools()
    expect(tools[0].name).toBe('spawn')
  })

  it('lists allow-listed agents in the agentId description', async () => {
    const { hub } = makeHub(okResult())
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['writer' as ParticipantId, 'reviewer' as ParticipantId],
    })
    const tools = await ts.listTools()
    const schema = tools[0].inputSchema as {
      properties: { agentId: { description: string } }
    }
    expect(schema.properties.agentId.description).toContain('writer')
    expect(schema.properties.agentId.description).toContain('reviewer')
  })

  it('signals empty allow-lists in descriptions', async () => {
    const { hub } = makeHub(okResult())
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
    })
    const tools = await ts.listTools()
    const schema = tools[0].inputSchema as {
      properties: {
        agentId: { description: string }
        capability: { description: string }
      }
    }
    expect(schema.properties.agentId.description).toMatch(/No agents/)
    expect(schema.properties.capability.description).toMatch(
      /No capabilities/,
    )
  })
})

describe('DispatchToolset.callTool — input validation', () => {
  it('rejects unknown tool name', async () => {
    const { hub, dispatch } = makeHub(okResult())
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    const r = await ts.callTool('other', { agentId: 'sub', payload: 'x' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/unknown tool/)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects missing agentId + capability', async () => {
    const { hub } = makeHub(okResult())
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
    })
    const r = await ts.callTool('dispatch_task', { payload: 'x' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/agentId.*capability/)
  })

  it('rejects both agentId and capability at once', async () => {
    const { hub } = makeHub(okResult())
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
      allowedCapabilities: ['code'],
    })
    const r = await ts.callTool('dispatch_task', {
      agentId: 'sub',
      capability: 'code',
      payload: 'x',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/mutually exclusive/)
  })

  it('rejects empty-string targets as if they were missing', async () => {
    const { hub } = makeHub(okResult())
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    const r = await ts.callTool('dispatch_task', {
      agentId: '',
      capability: '',
      payload: 'x',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/agentId.*capability/)
  })

  it('rejects missing payload field', async () => {
    const { hub } = makeHub(okResult())
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    const r = await ts.callTool('dispatch_task', { agentId: 'sub' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/payload/)
  })

  it('accepts payload === null (presence, not truthiness)', async () => {
    const { hub, dispatch } = makeHub(okResult())
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    const r = await ts.callTool('dispatch_task', {
      agentId: 'sub',
      payload: null,
    })
    expect(r.isError).toBeFalsy()
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ payload: null }),
    )
  })
})

describe('DispatchToolset.callTool — authorization', () => {
  it('rejects agentId not in allow-list without dispatching', async () => {
    const { hub, dispatch } = makeHub(okResult())
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    const r = await ts.callTool('dispatch_task', {
      agentId: 'other',
      payload: 'x',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/allow-list/)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects capability not in allow-list without dispatching', async () => {
    const { hub, dispatch } = makeHub(okResult())
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedCapabilities: ['code'],
    })
    const r = await ts.callTool('dispatch_task', {
      capability: 'design',
      payload: 'x',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/allow-list/)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects any capability when no allow-list configured', async () => {
    const { hub } = makeHub(okResult())
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      // allowedAgents only — capability path disabled
      allowedAgents: ['sub' as ParticipantId],
    })
    const r = await ts.callTool('dispatch_task', {
      capability: 'anything',
      payload: 'x',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/allow-list/)
  })
})

describe('DispatchToolset.callTool — happy-path dispatch', () => {
  it('explicit dispatch forwards the correct strategy + selfId', async () => {
    const { hub, dispatch } = makeHub(okResult('hello'))
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    const r = await ts.callTool('dispatch_task', {
      agentId: 'sub',
      payload: { topic: 'x' },
      title: 'test',
      deadlineMs: 9999,
    })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toBe('hello')
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith({
      from: 'me',
      strategy: { kind: 'explicit', to: 'sub' } satisfies DispatchStrategy,
      payload: { topic: 'x' },
      title: 'test',
      deadlineMs: 9999,
    })
  })

  it('capability dispatch forwards the correct strategy', async () => {
    const { hub, dispatch } = makeHub(okResult())
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedCapabilities: ['code'],
    })
    await ts.callTool('dispatch_task', {
      capability: 'code',
      payload: 'go',
    })
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        strategy: {
          kind: 'capability',
          capabilities: ['code'],
        } satisfies DispatchStrategy,
      }),
    )
  })

  it('omits optional fields when not provided', async () => {
    const { hub, dispatch } = makeHub(okResult())
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    await ts.callTool('dispatch_task', { agentId: 'sub', payload: 'x' })
    expect(dispatch).toHaveBeenCalledWith({
      from: 'me',
      strategy: { kind: 'explicit', to: 'sub' },
      payload: 'x',
      title: undefined,
      deadlineMs: undefined,
    })
  })
})

describe('DispatchToolset.callTool — result mapping', () => {
  it('passes through string output verbatim', async () => {
    const { hub } = makeHub(okResult('plain text result'))
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    const r = await ts.callTool('dispatch_task', {
      agentId: 'sub',
      payload: 'x',
    })
    expect(textOf(r)).toBe('plain text result')
  })

  it('JSON-stringifies non-string output', async () => {
    const { hub } = makeHub(okResult({ score: 42 }))
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    const r = await ts.callTool('dispatch_task', {
      agentId: 'sub',
      payload: 'x',
    })
    expect(textOf(r)).toBe('{"score":42}')
  })

  it('maps failed TaskResult to isError + error reason', async () => {
    const { hub } = makeHub({
      kind: 'failed',
      taskId: 'task-1',
      by: 'sub' as ParticipantId,
      error: 'boom',
      ts: 1,
    })
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    const r = await ts.callTool('dispatch_task', {
      agentId: 'sub',
      payload: 'x',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/task-1 failed: boom/)
  })

  it('maps cancelled TaskResult to isError + reason', async () => {
    const { hub } = makeHub({
      kind: 'cancelled',
      taskId: 'task-1',
      reason: 'user pressed stop',
      ts: 1,
    })
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    const r = await ts.callTool('dispatch_task', {
      agentId: 'sub',
      payload: 'x',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/cancelled: user pressed stop/)
  })

  it('maps no_participant TaskResult to isError', async () => {
    const { hub } = makeHub({
      kind: 'no_participant',
      taskId: 'task-1',
      reason: 'nobody offers cap',
      ts: 1,
    })
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedCapabilities: ['code'],
    })
    const r = await ts.callTool('dispatch_task', {
      capability: 'code',
      payload: 'x',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/no_participant: nobody offers cap/)
  })

  it('catches hub.dispatch throw and returns isError', async () => {
    const hub: DispatchSurface = {
      dispatch: vi.fn(async () => {
        throw new Error('network down')
      }),
    }
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    const r = await ts.callTool('dispatch_task', {
      agentId: 'sub',
      payload: 'x',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/dispatch threw.*network down/)
  })

  it('catches non-Error throws too', async () => {
    const hub: DispatchSurface = {
      dispatch: vi.fn(async () => {
        // Some legacy code paths throw string. Stay alive anyway.
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'weird'
      }),
    }
    const ts = DispatchToolset.create({
      hub,
      selfId: 'me' as ParticipantId,
      allowedAgents: ['sub' as ParticipantId],
    })
    const r = await ts.callTool('dispatch_task', {
      agentId: 'sub',
      payload: 'x',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/dispatch threw.*weird/)
  })
})
