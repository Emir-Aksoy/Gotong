/**
 * Phase 18 C-M4 — A2aRemoteParticipant (outbound A2A edge).
 *
 * No network: `fetchImpl` is a capturing fake. We drive the participant via
 * its public `onTask` (the scheduler's entry point) so we exercise the real
 * AgentParticipant envelope wrapping: a returned value → `kind: 'ok'`, a thrown
 * `A2aClientError` → `kind: 'failed'`.
 */

import type { Task } from '@aipehub/core'
import { describe, expect, it } from 'vitest'

import { A2aRemoteParticipant, agentMessage } from '../src/index.js'

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

/** Minimal well-formed task for a capability dispatch. */
function makeTask(payload: unknown): Task {
  return {
    id: 't-1',
    from: 'caller',
    strategy: { kind: 'capability', capabilities: ['translate'] },
    payload,
  }
}

describe('A2aRemoteParticipant (Phase 18 C-M4)', () => {
  it('forwards task text to the remote and returns its reply as ok output { text }', async () => {
    const { fn, calls } = fakeFetch(() =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: agentMessage('bonjour', 'm-r') }),
    )
    const p = new A2aRemoteParticipant({
      id: 'fr-translator',
      capabilities: ['translate'],
      url: 'https://peer.example/a2a',
      token: 'tok-xyz',
      peerId: 'hubA',
      targetSkill: 'translate',
      fetchImpl: fn,
    })

    const result = await p.onTask(makeTask({ text: 'hello' }))

    expect(result.kind).toBe('ok')
    expect(result).toMatchObject({ by: 'fr-translator', output: { text: 'bonjour' } })

    // Outbound envelope: url, bearer, our peer id header, and the targeted skill.
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]!
    expect(url).toBe('https://peer.example/a2a')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok-xyz')
    expect(headers['x-aipe-peer-id']).toBe('hubA')
    const body = JSON.parse(init.body as string)
    expect(body.method).toBe('message/send')
    expect(body.params.message.parts).toEqual([{ kind: 'text', text: 'hello' }])
    expect(body.params.message.metadata).toEqual({ skill: 'translate' })
  })

  it('omits x-aipe-peer-id and metadata.skill when not configured (generic A2A agent)', async () => {
    const { fn, calls } = fakeFetch(() =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: agentMessage('ok', 'm') }),
    )
    const p = new A2aRemoteParticipant({
      id: 'ext',
      capabilities: ['ask'],
      url: 'https://ext.example/a2a',
      token: 'tok',
      fetchImpl: fn,
    })

    await p.onTask(makeTask('plain string payload'))

    const { init } = calls[0]!
    const headers = init.headers as Record<string, string>
    expect(headers['x-aipe-peer-id']).toBeUndefined()
    const body = JSON.parse(init.body as string)
    expect(body.params.message.metadata).toBeUndefined()
    // A bare string payload is sent verbatim as the text.
    expect(body.params.message.parts).toEqual([{ kind: 'text', text: 'plain string payload' }])
  })

  it('JSON-stringifies a structured payload that has no text field', async () => {
    const { fn, calls } = fakeFetch(() =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: agentMessage('ok', 'm') }),
    )
    const p = new A2aRemoteParticipant({
      id: 'ext',
      capabilities: ['ask'],
      url: 'u',
      token: 't',
      fetchImpl: fn,
    })

    await p.onTask(makeTask({ a: 1, b: 'two' }))

    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.params.message.parts[0].text).toBe(JSON.stringify({ a: 1, b: 'two' }))
  })

  it('maps a remote HTTP error to a failed task result (not a throw)', async () => {
    const { fn } = fakeFetch(() => new Response('nope', { status: 502 }))
    const p = new A2aRemoteParticipant({
      id: 'ext',
      capabilities: ['ask'],
      url: 'u',
      token: 't',
      fetchImpl: fn,
    })

    const result = await p.onTask(makeTask({ text: 'hi' }))

    expect(result.kind).toBe('failed')
    expect(result).toMatchObject({ by: 'ext' })
    if (result.kind === 'failed') expect(result.error).toMatch(/HTTP 502/)
  })

  it('maps a remote JSON-RPC error to a failed task result', async () => {
    const { fn } = fakeFetch(() =>
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } }),
    )
    const p = new A2aRemoteParticipant({
      id: 'ext',
      capabilities: ['ask'],
      url: 'u',
      token: 't',
      fetchImpl: fn,
    })

    const result = await p.onTask(makeTask({ text: 'hi' }))

    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') expect(result.error).toMatch(/-32603/)
  })
})
