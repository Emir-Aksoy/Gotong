/**
 * Route B P1-M8a — A2A task lifecycle wire types + client.
 *
 * Pins the Task builders, the Message/Task discriminator, and the two new
 * client paths (`a2aSendRaw` returns the raw result; `a2aGetTask` polls), plus
 * the contract that the BLOCKING `a2aSend` surfaces a returned Task as a typed
 * error carrying `.taskId` (so a caller knows to poll rather than treat it as a
 * hard failure). No network — `fetchImpl` is injected.
 */

import { describe, expect, it } from 'vitest'

import {
  a2aGetTask,
  a2aSend,
  a2aSendRaw,
  A2aClientError,
  agentMessage,
  buildTasksGetRequest,
  completedTask,
  failedTask,
  isA2ATask,
  isTerminalTaskState,
  workingTask,
  A2A_METHOD_TASKS_GET,
  A2A_TERMINAL_TASK_STATES,
} from '../src/index.js'

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return handler(url, init)
  }) as unknown as typeof fetch
  return { fn, calls }
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}

describe('task builders (Route B P1-M8a)', () => {
  it('workingTask is a non-terminal Task with state working', () => {
    const t = workingTask('a2a-task-1')
    expect(t).toEqual({ id: 'a2a-task-1', kind: 'task', status: { state: 'working' } })
    expect(isA2ATask(t)).toBe(true)
    expect(isTerminalTaskState(t.status.state)).toBe(false)
  })

  it('completedTask carries the reply text as the status message', () => {
    const t = completedTask('a2a-1', 'pong', 'm-reply')
    expect(t.status.state).toBe('completed')
    expect(t.status.message).toEqual(agentMessage('pong', 'm-reply'))
    expect(isTerminalTaskState(t.status.state)).toBe(true)
  })

  it('failedTask carries the error text as the status message', () => {
    const t = failedTask('a2a-1', 'boom', 'm-err')
    expect(t.status.state).toBe('failed')
    expect(t.status.message).toEqual(agentMessage('boom', 'm-err'))
    expect(isTerminalTaskState(t.status.state)).toBe(true)
  })

  it('optional contextId / timestamp ride through when set, stay off otherwise', () => {
    expect(workingTask('x', { contextId: 'ctx-9', timestamp: '2026-01-01T00:00:00Z' })).toEqual({
      id: 'x',
      kind: 'task',
      contextId: 'ctx-9',
      status: { state: 'working', timestamp: '2026-01-01T00:00:00Z' },
    })
    // No keys leak when omitted (deterministic wire shape).
    expect(Object.keys(workingTask('x'))).toEqual(['id', 'kind', 'status'])
  })

  it('A2A_TERMINAL_TASK_STATES is exactly the terminal set', () => {
    expect([...A2A_TERMINAL_TASK_STATES].sort()).toEqual(['canceled', 'completed', 'failed'])
  })

  it('buildTasksGetRequest produces the full JSON-RPC envelope', () => {
    expect(buildTasksGetRequest('a2a-task-7', 3)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: A2A_METHOD_TASKS_GET,
      params: { id: 'a2a-task-7' },
    })
  })
})

describe('a2aGetTask (Route B P1-M8a)', () => {
  it('POSTs tasks/get with the task id and returns the Task', async () => {
    const { fn, calls } = fakeFetch(() =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: completedTask('a2a-9', 'done', 'm') }),
    )
    const task = await a2aGetTask('https://hub/a2a', 'tok', 'a2a-9', { fetchImpl: fn, peerId: 'hubA' })
    expect(task.status.state).toBe('completed')

    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body).toEqual({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'a2a-9' } })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-aipe-peer-id']).toBe('hubA')
    expect(headers.authorization).toBe('Bearer tok')
  })

  it('throws A2aClientError with the JSON-RPC code on TaskNotFound (-32001)', async () => {
    const { fn } = fakeFetch(() =>
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'task not found' } }),
    )
    await expect(a2aGetTask('u', 't', 'nope', { fetchImpl: fn })).rejects.toMatchObject({
      name: 'A2aClientError',
      code: -32001,
    })
  })

  it('throws when the result is a Message rather than a Task', async () => {
    const { fn } = fakeFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: agentMessage('x', 'm') }))
    await expect(a2aGetTask('u', 't', 'x', { fetchImpl: fn })).rejects.toThrow(/not a Task/)
  })
})

describe('a2aSendRaw + a2aSend task handling (Route B P1-M8a)', () => {
  it('a2aSendRaw returns the Message result as-is', async () => {
    const { fn } = fakeFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: agentMessage('pong', 'm') }))
    const result = await a2aSendRaw('u', 't', 'ping', { fetchImpl: fn })
    expect(isA2ATask(result)).toBe(false)
  })

  it('a2aSendRaw returns the Task result as-is (remote suspended)', async () => {
    const { fn } = fakeFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: workingTask('a2a-7') }))
    const result = await a2aSendRaw('u', 't', 'ping', { fetchImpl: fn })
    expect(isA2ATask(result)).toBe(true)
    if (isA2ATask(result)) expect(result.id).toBe('a2a-7')
  })

  it('a2aSend surfaces a returned Task as a typed error carrying .taskId', async () => {
    const { fn } = fakeFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: workingTask('a2a-park-1') }))
    const err = await a2aSend('u', 't', 'ping', { fetchImpl: fn }).catch((e) => e)
    expect(err).toBeInstanceOf(A2aClientError)
    expect((err as A2aClientError).taskId).toBe('a2a-park-1')
    expect((err as Error).message).toMatch(/poll tasks\/get/)
  })
})
