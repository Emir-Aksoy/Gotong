/**
 * Phase 18 C-M3 — inbound A2A message/send server.
 *
 * No real HTTP: fake IncomingMessage (async-iterable body) + a capturing
 * ServerResponse drive `A2aServer.handle` directly, with a stub hub that
 * records the dispatch it was handed. Pins auth (own bearer domain), the
 * capability-strategy mapping (never explicit), origin stamping, and the
 * result → JSON-RPC mapping.
 */

import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { PeerLinkAcl, TaskResult } from '@aipehub/core'
import { buildSendRequest, buildTasksGetRequest, isA2ATask, type A2AResponse, type A2ATask } from '@aipehub/a2a'

import { A2aServer, type A2aServerOptions } from '../src/a2a-server.js'

/** A `resumeAt` so far out the sweep never fires — HITL / long-park sentinel. */
const NEVER = 9_999_999_999_000

interface DispatchArgs {
  from: string
  strategy: { kind: string; capabilities?: string[] }
  payload: { text?: string }
  origin?: { orgId?: string; userId?: string }
}

function makeServer(opts: {
  result?: TaskResult
  defaultCapability?: string
  resolvePeerAcl?: (peerId: string) => PeerLinkAcl | null
  inboundGate?: (
    peerId: string,
    task: unknown,
  ) => { ok: true } | { ok: false; reason: string }
  /** Drives `hub.taskResult` (what `tasks/get` reads back); default → undefined. */
  taskResult?: (hubTaskId: string) => TaskResult | undefined
  /** Deterministic opaque task-handle minter; default → a counter. */
  newTaskId?: () => string
} = {}) {
  const calls: DispatchArgs[] = []
  const result: TaskResult =
    opts.result ?? { kind: 'ok', taskId: 't1', by: 'agent', output: 'pong', ts: 1 }
  const hub = {
    dispatch: async (a: DispatchArgs) => {
      calls.push(a)
      return result
    },
    taskResult: opts.taskResult ?? (() => undefined),
  }
  let taskSeq = 0
  const server = new A2aServer({
    hub: hub as unknown as A2aServerOptions['hub'],
    // Two known peers (hubA / hubB) so ownership-isolation can be exercised.
    resolvePeerToken: (pid) => (pid === 'hubA' ? 'secret-token' : pid === 'hubB' ? 'token-b' : null),
    ...(opts.defaultCapability !== undefined ? { defaultCapability: opts.defaultCapability } : {}),
    ...(opts.resolvePeerAcl ? { resolvePeerAcl: opts.resolvePeerAcl } : {}),
    ...(opts.inboundGate
      ? { inboundGate: opts.inboundGate as A2aServerOptions['inboundGate'] }
      : {}),
    newMessageId: () => 'reply-msg-id',
    newTaskId: opts.newTaskId ?? (() => `a2a-task-${++taskSeq}`),
  })
  return { server, calls }
}

function fakeReq(opts: {
  method?: string
  headers?: Record<string, string>
  body?: string
}): IncomingMessage {
  const body = opts.body ?? ''
  return {
    method: opts.method ?? 'POST',
    headers: opts.headers ?? {},
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body)
    },
  } as unknown as IncomingMessage
}

function fakeRes() {
  const out = { status: 0, headers: {} as Record<string, string>, body: '' }
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      out.status = status
      if (headers) out.headers = headers
      return res
    },
    end(chunk?: string) {
      if (chunk) out.body = chunk
    },
  } as unknown as ServerResponse
  return { res, out }
}

const AUTH = { 'x-aipe-peer-id': 'hubA', authorization: 'Bearer secret-token' }
const AUTH_B = { 'x-aipe-peer-id': 'hubB', authorization: 'Bearer token-b' }

function sendBody(text: string, metadata?: Record<string, unknown>): string {
  return JSON.stringify(
    buildSendRequest(text, { messageId: 'm-1', requestId: 9, ...(metadata ? { metadata } : {}) }),
  )
}

function tasksGetBody(taskId: string): string {
  return JSON.stringify(buildTasksGetRequest(taskId, 5))
}

/** POST a message/send that suspends; return the opaque a2a task id minted. */
async function parkTask(
  server: A2aServer,
  headers: Record<string, string> = AUTH,
): Promise<string> {
  const { res, out } = fakeRes()
  await server.handle(fakeReq({ headers, body: sendBody('go') }), res)
  const result = parse(out).result
  if (!result || !isA2ATask(result)) throw new Error('expected a Task result')
  return result.id
}

function parse(out: { body: string }): A2AResponse {
  return JSON.parse(out.body) as A2AResponse
}

describe('A2aServer.handle — happy path (Phase 18 C-M3)', () => {
  it('authenticates, dispatches by capability, returns the reply text', async () => {
    const { server, calls } = makeServer({ defaultCapability: 'chat' })
    const { res, out } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: sendBody('ping') }), res)

    expect(out.status).toBe(200)
    const resp = parse(out)
    expect(resp.id).toBe(9)
    expect(resp.error).toBeUndefined()
    expect(resp.result?.role).toBe('agent')
    expect(resp.result?.parts).toEqual([{ kind: 'text', text: 'pong' }])

    // Dispatch was capability-strategy (NEVER explicit) with stamped origin.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.strategy.kind).toBe('capability')
    expect(calls[0]!.strategy.capabilities).toEqual(['chat'])
    expect(calls[0]!.payload.text).toBe('ping')
    expect(calls[0]!.origin).toEqual({ orgId: 'hubA', userId: 'm-1' })
    expect(calls[0]!.from).toBe('hubA')
  })

  it('metadata.skill overrides the default capability', async () => {
    const { server, calls } = makeServer({ defaultCapability: 'chat' })
    const { res } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: sendBody('hi', { skill: 'translate' }) }), res)
    expect(calls[0]!.strategy.capabilities).toEqual(['translate'])
  })

  it('surfaces an object output via its .text field', async () => {
    const { server } = makeServer({
      defaultCapability: 'chat',
      result: { kind: 'ok', taskId: 't', by: 'a', output: { text: 'hello there' }, ts: 1 },
    })
    const { res, out } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: sendBody('x') }), res)
    expect(parse(out).result?.parts).toEqual([{ kind: 'text', text: 'hello there' }])
  })
})

describe('A2aServer.handle — auth (own bearer domain)', () => {
  it('401 when X-Aipe-Peer-Id is missing', async () => {
    const { server, calls } = makeServer({ defaultCapability: 'chat' })
    const { res, out } = fakeRes()
    await server.handle(
      fakeReq({ headers: { authorization: 'Bearer secret-token' }, body: sendBody('x') }),
      res,
    )
    expect(out.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('401 on a wrong bearer (no dispatch)', async () => {
    const { server, calls } = makeServer({ defaultCapability: 'chat' })
    const { res, out } = fakeRes()
    await server.handle(
      fakeReq({ headers: { 'x-aipe-peer-id': 'hubA', authorization: 'Bearer wrong' }, body: sendBody('x') }),
      res,
    )
    expect(out.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('401 for an unknown peer (resolver returns null)', async () => {
    const { server } = makeServer({ defaultCapability: 'chat' })
    const { res, out } = fakeRes()
    await server.handle(
      fakeReq({ headers: { 'x-aipe-peer-id': 'stranger', authorization: 'Bearer secret-token' }, body: sendBody('x') }),
      res,
    )
    expect(out.status).toBe(401)
  })

  it('405 on a non-POST method', async () => {
    const { server } = makeServer({ defaultCapability: 'chat' })
    const { res, out } = fakeRes()
    await server.handle(fakeReq({ method: 'GET', headers: AUTH }), res)
    expect(out.status).toBe(405)
  })
})

describe('A2aServer.handle — JSON-RPC + result mapping', () => {
  it('parse error (-32700) on malformed JSON', async () => {
    const { server } = makeServer({ defaultCapability: 'chat' })
    const { res, out } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: '{not json' }), res)
    expect(out.status).toBe(200)
    expect(parse(out).error?.code).toBe(-32700)
  })

  it('method_not_found (-32601) on an unsupported method', async () => {
    const { server } = makeServer({ defaultCapability: 'chat' })
    const { res, out } = fakeRes()
    // `message/stream` is a real A2A method we deliberately don't serve (no
    // streaming) — and `tasks/get` is now valid, so use a genuinely unknown one.
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/stream', params: {} })
    await server.handle(fakeReq({ headers: AUTH, body }), res)
    expect(parse(out).error?.code).toBe(-32601)
  })

  it('invalid_params (-32602) when no skill and no default capability', async () => {
    const { server, calls } = makeServer({}) // no defaultCapability
    const { res, out } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: sendBody('x') }), res)
    expect(parse(out).error?.code).toBe(-32602)
    expect(calls).toHaveLength(0)
  })

  it('mints a working Task with an opaque id when the dispatch suspends', async () => {
    const { server } = makeServer({
      defaultCapability: 'chat',
      result: { kind: 'suspended', taskId: 'hub-task-internal', by: 'a', resumeAt: NEVER, ts: 1 },
      newTaskId: () => 'a2a-opaque-1',
    })
    const { res, out } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: sendBody('x') }), res)
    const resp = parse(out)
    expect(resp.error).toBeUndefined()
    const task = resp.result as A2ATask
    expect(task.kind).toBe('task')
    expect(task.status.state).toBe('working')
    // The returned handle is OPAQUE — never the internal hub task id (leaking
    // it would let a peer poll another org's task / learn hub naming).
    expect(task.id).toBe('a2a-opaque-1')
    expect(task.id).not.toBe('hub-task-internal')
  })

  it('maps no_participant to -32002', async () => {
    const { server } = makeServer({
      defaultCapability: 'chat',
      result: { kind: 'no_participant', taskId: 't', reason: 'none', ts: 1 },
    })
    const { res, out } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: sendBody('x') }), res)
    expect(parse(out).error?.code).toBe(-32002)
  })

  it('maps a failed result to -32603 with the error message', async () => {
    const { server } = makeServer({
      defaultCapability: 'chat',
      result: { kind: 'failed', taskId: 't', by: 'a', error: 'boom', ts: 1 },
    })
    const { res, out } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: sendBody('x') }), res)
    const resp = parse(out)
    expect(resp.error?.code).toBe(-32603)
    expect(resp.error?.message).toBe('boom')
  })
})

describe('A2aServer.handle — inbound ACL + quota (audit A2)', () => {
  // The bug: A2A ingress is federation's second inbound door and, before the
  // fix, dispatched straight to ANY skill an authenticated peer named —
  // bypassing the per-peer capability allowlist the HubLink path enforces.
  it('denies an off-allowlist skill (peer ACL bypass closed) — no dispatch', async () => {
    const { server, calls } = makeServer({
      defaultCapability: 'chat',
      resolvePeerAcl: () => ({ capabilities: ['chat'] }),
    })
    const { res, out } = fakeRes()
    // peer restricted to 'chat' tries to invoke 'translate' over /a2a
    await server.handle(fakeReq({ headers: AUTH, body: sendBody('x', { skill: 'translate' }) }), res)

    expect(out.status).toBe(200)
    const resp = parse(out)
    expect(resp.error?.code).toBe(-32602) // INVALID_PARAMS
    expect(resp.error?.message).toContain('cross_org_acl_denied')
    expect(resp.error?.message).toContain('capability_denied:translate')
    expect(calls).toHaveLength(0) // never reached the hub
  })

  it('allows an on-allowlist skill (same predicate as the HubLink path)', async () => {
    const { server, calls } = makeServer({
      defaultCapability: 'chat',
      resolvePeerAcl: () => ({ capabilities: ['chat', 'translate'] }),
    })
    const { res, out } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: sendBody('x', { skill: 'translate' }) }), res)

    expect(out.status).toBe(200)
    expect(parse(out).error).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.strategy.capabilities).toEqual(['translate'])
  })

  it('null ACL = accept-all (legacy peers keep working)', async () => {
    const { server, calls } = makeServer({
      defaultCapability: 'chat',
      resolvePeerAcl: () => null,
    })
    const { res, out } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: sendBody('x', { skill: 'anything' }) }), res)
    expect(out.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  it('refuses an over-budget call via the shared per-link quota gate — no dispatch', async () => {
    const { server, calls } = makeServer({
      defaultCapability: 'chat',
      inboundGate: () => ({ ok: false, reason: 'per_link_quota_exceeded' }),
    })
    const { res, out } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: sendBody('x') }), res)

    const resp = parse(out)
    expect(resp.error?.code).toBe(-32603) // INTERNAL
    expect(resp.error?.message).toContain('cross_org_policy_denied')
    expect(resp.error?.message).toContain('per_link_quota_exceeded')
    expect(calls).toHaveLength(0)
  })

  it('lets an in-budget call through the quota gate', async () => {
    const { server, calls } = makeServer({
      defaultCapability: 'chat',
      inboundGate: () => ({ ok: true }),
    })
    const { res } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: sendBody('x') }), res)
    expect(calls).toHaveLength(1)
  })

  it('runs the ACL gate BEFORE the quota gate (deny order)', async () => {
    // An off-list skill must be ACL-denied even if quota would also refuse;
    // the ACL is the cheaper, more specific verdict and runs first.
    let gateCalled = false
    const { server, calls } = makeServer({
      defaultCapability: 'chat',
      resolvePeerAcl: () => ({ capabilities: ['chat'] }),
      inboundGate: () => {
        gateCalled = true
        return { ok: false, reason: 'per_link_quota_exceeded' }
      },
    })
    const { res, out } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: sendBody('x', { skill: 'translate' }) }), res)
    expect(parse(out).error?.message).toContain('cross_org_acl_denied')
    expect(gateCalled).toBe(false) // short-circuited before quota
    expect(calls).toHaveLength(0)
  })
})

describe('A2aServer.handle — tasks/get lifecycle (Route B P1-M8b)', () => {
  const SUSPEND: TaskResult = { kind: 'suspended', taskId: 'h1', by: 'a', resumeAt: NEVER, ts: 1 }

  it('a still-parked task polls back as working (taskResult not yet recorded)', async () => {
    const { server } = makeServer({ defaultCapability: 'chat', result: SUSPEND })
    const id = await parkTask(server)
    const { res, out } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: tasksGetBody(id) }), res)
    const task = parse(out).result as A2ATask
    expect(task.kind).toBe('task')
    expect(task.status.state).toBe('working')
  })

  it('a resumed → ok task polls back as completed, carrying the reply text', async () => {
    const { server } = makeServer({
      defaultCapability: 'chat',
      result: SUSPEND,
      taskResult: (hubTaskId) =>
        hubTaskId === 'h1' ? { kind: 'ok', taskId: 'h1', by: 'a', output: 'final answer', ts: 2 } : undefined,
    })
    const id = await parkTask(server)
    const { res, out } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: tasksGetBody(id) }), res)
    const task = parse(out).result as A2ATask
    expect(task.status.state).toBe('completed')
    expect(task.status.message?.parts).toEqual([{ kind: 'text', text: 'final answer' }])
  })

  it('a resumed → failed task polls back as failed, carrying the error text', async () => {
    const { server } = makeServer({
      defaultCapability: 'chat',
      result: SUSPEND,
      taskResult: () => ({ kind: 'failed', taskId: 'h1', by: 'a', error: 'kaboom', ts: 2 }),
    })
    const id = await parkTask(server)
    const { res, out } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: tasksGetBody(id) }), res)
    const task = parse(out).result as A2ATask
    expect(task.status.state).toBe('failed')
    expect(task.status.message?.parts).toEqual([{ kind: 'text', text: 'kaboom' }])
  })

  it('an unknown task id → TASK_NOT_FOUND (-32001), not an empty Task', async () => {
    const { server } = makeServer({ defaultCapability: 'chat' })
    const { res, out } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: tasksGetBody('does-not-exist') }), res)
    expect(parse(out).error?.code).toBe(-32001)
  })

  it('tasks/get without params.id → INVALID_PARAMS (-32602)', async () => {
    const { server } = makeServer({ defaultCapability: 'chat' })
    const { res, out } = fakeRes()
    const body = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tasks/get', params: {} })
    await server.handle(fakeReq({ headers: AUTH, body }), res)
    expect(parse(out).error?.code).toBe(-32602)
  })

  it('a peer CANNOT poll another peer’s parked task (ownership isolation)', async () => {
    // hubA parks a task; hubB authenticates fine but must not resolve hubA's
    // opaque id — fail-closed TASK_NOT_FOUND (anti-enumeration). hubA still can.
    const { server } = makeServer({
      defaultCapability: 'chat',
      result: SUSPEND,
      taskResult: () => ({ kind: 'ok', taskId: 'h1', by: 'a', output: 'secret', ts: 2 }),
      newTaskId: () => 'a2a-shared-id',
    })
    const id = await parkTask(server, AUTH) // owned by hubA

    const denied = fakeRes()
    await server.handle(fakeReq({ headers: AUTH_B, body: tasksGetBody(id) }), denied.res)
    expect(parse(denied.out).error?.code).toBe(-32001) // hubB → not found

    const owned = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: tasksGetBody(id) }), owned.res)
    expect((parse(owned.out).result as A2ATask).status.state).toBe('completed') // hubA → ok
  })
})
