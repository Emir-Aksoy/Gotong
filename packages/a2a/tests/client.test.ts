/**
 * Phase 18 C-M2 — @gotong/a2a client + wire-type builders.
 *
 * No network: `fetchImpl` is injected with a capturing fake so we can assert
 * the exact JSON-RPC request shape AND the reply parsing / error mapping.
 */

import { describe, expect, it } from 'vitest'

import {
  a2aSend,
  A2aClientError,
  agentMessage,
  buildSendRequest,
  messageText,
  textPart,
  userMessage,
} from '../src/index.js'

/** A capturing fake `fetch`: records calls, returns whatever `handler` builds. */
function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return handler(url, init)
  }) as unknown as typeof fetch
  return { fn, calls }
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('a2aSend (Phase 18 C-M2)', () => {
  it('POSTs a well-formed message/send request and returns the reply text', async () => {
    const { fn, calls } = fakeFetch(() =>
      jsonResponse({ jsonrpc: '2.0', id: 7, result: agentMessage('pong', 'm-reply') }),
    )

    const reply = await a2aSend('https://hub.example.com/a2a', 'tok-123', 'ping', {
      fetchImpl: fn,
      messageId: 'm-1',
      requestId: 7,
      peerId: 'hubA',
    })
    expect(reply).toBe('pong')

    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]!
    expect(url).toBe('https://hub.example.com/a2a')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok-123')
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-gotong-peer-id']).toBe('hubA')

    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 7,
      method: 'message/send',
      params: {
        message: {
          role: 'user',
          kind: 'message',
          messageId: 'm-1',
          parts: [{ kind: 'text', text: 'ping' }],
        },
      },
    })
  })

  it('omits X-Gotong-Peer-Id when no peerId is given (generic A2A agent)', async () => {
    const { fn, calls } = fakeFetch(() =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: agentMessage('ok', 'm') }),
    )
    await a2aSend('https://ext.example/a2a', 'tok', 'hi', { fetchImpl: fn })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-gotong-peer-id']).toBeUndefined()
    expect(headers.authorization).toBe('Bearer tok')
  })

  it('throws A2aClientError with the JSON-RPC code on an error result', async () => {
    const { fn } = fakeFetch(() =>
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'suspended' } }),
    )
    await expect(a2aSend('u', 't', 'x', { fetchImpl: fn })).rejects.toMatchObject({
      name: 'A2aClientError',
      code: -32001,
    })
  })

  it('throws A2aClientError with the HTTP status on a non-2xx response', async () => {
    const { fn } = fakeFetch(() => new Response('nope', { status: 401 }))
    await expect(a2aSend('u', 't', 'x', { fetchImpl: fn })).rejects.toMatchObject({ code: 401 })
  })

  it('throws when the body is not valid JSON', async () => {
    const { fn } = fakeFetch(
      () => new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } }),
    )
    await expect(a2aSend('u', 't', 'x', { fetchImpl: fn })).rejects.toThrow(/not valid JSON/)
  })

  it('throws when the result carries no message parts', async () => {
    const { fn } = fakeFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }))
    await expect(a2aSend('u', 't', 'x', { fetchImpl: fn })).rejects.toThrow(/no message result/)
  })

  it('wraps a transport throw as A2aClientError', async () => {
    const fn = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const err = await a2aSend('u', 't', 'x', { fetchImpl: fn }).catch((e) => e)
    expect(err).toBeInstanceOf(A2aClientError)
    expect((err as Error).message).toMatch(/transport error/)
  })
})

describe('wire-type builders (Phase 18 C-M2)', () => {
  it('messageText concatenates every text part', () => {
    expect(messageText(agentMessage('a', 'm'))).toBe('a')
    expect(
      messageText({ role: 'agent', kind: 'message', messageId: 'm', parts: [textPart('a'), textPart('b')] }),
    ).toBe('ab')
  })

  it('userMessage wraps a single text part with role user', () => {
    expect(userMessage('hi', 'm-9')).toEqual({
      role: 'user',
      kind: 'message',
      messageId: 'm-9',
      parts: [{ kind: 'text', text: 'hi' }],
    })
  })

  it('buildSendRequest produces the full JSON-RPC envelope', () => {
    expect(buildSendRequest('hi', { messageId: 'm', requestId: 3 })).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'message/send',
      params: {
        message: { role: 'user', kind: 'message', messageId: 'm', parts: [{ kind: 'text', text: 'hi' }] },
      },
    })
  })
})
