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

import type { TaskResult } from '@aipehub/core'
import { buildSendRequest, type A2AResponse } from '@aipehub/a2a'

import { A2aServer, type A2aServerOptions } from '../src/a2a-server.js'

interface DispatchArgs {
  from: string
  strategy: { kind: string; capabilities?: string[] }
  payload: { text?: string }
  origin?: { orgId?: string; userId?: string }
}

function makeServer(opts: { result?: TaskResult; defaultCapability?: string } = {}) {
  const calls: DispatchArgs[] = []
  const result: TaskResult =
    opts.result ?? { kind: 'ok', taskId: 't1', by: 'agent', output: 'pong', ts: 1 }
  const hub = {
    dispatch: async (a: DispatchArgs) => {
      calls.push(a)
      return result
    },
  }
  const server = new A2aServer({
    hub: hub as unknown as A2aServerOptions['hub'],
    resolvePeerToken: (pid) => (pid === 'hubA' ? 'secret-token' : null),
    ...(opts.defaultCapability !== undefined ? { defaultCapability: opts.defaultCapability } : {}),
    newMessageId: () => 'reply-msg-id',
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

function sendBody(text: string, metadata?: Record<string, unknown>): string {
  return JSON.stringify(
    buildSendRequest(text, { messageId: 'm-1', requestId: 9, ...(metadata ? { metadata } : {}) }),
  )
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
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: {} })
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

  it('maps a suspended result to -32001', async () => {
    const { server } = makeServer({
      defaultCapability: 'chat',
      result: { kind: 'suspended', taskId: 't', by: 'a', resumeAt: 9_999_999_999_000, ts: 1 },
    })
    const { res, out } = fakeRes()
    await server.handle(fakeReq({ headers: AUTH, body: sendBody('x') }), res)
    expect(parse(out).error?.code).toBe(-32001)
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
