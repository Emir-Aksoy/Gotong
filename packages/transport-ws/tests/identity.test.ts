import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { Hub } from '@gotong/core'
import {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type ClientFrame,
  type Frame,
} from '@gotong/protocol'

import {
  serveWebSocket,
  type AuthenticateResult,
  type WebSocketTransportHandle,
} from '../src/index.js'

/**
 * v0.4 — per-agent identity: an authenticate callback can return
 * { ok: true, allowedAgents: [...] } to bind an API key to a set of agent ids.
 * HELLO is rejected with 'forbidden_agent' if any declared id is not allowed.
 *
 * Tests live here (not handshake.test.ts) to keep the v0.1 file an unchanged
 * regression baseline.
 */

interface FakeClient {
  ws: WebSocket
  recv(): Promise<Frame>
  send(frame: ClientFrame): void
  close(): Promise<void>
}

function openClient(url: string): Promise<FakeClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const inbox: Frame[] = []
    const waiters: Array<(f: Frame) => void> = []

    ws.on('message', (data) => {
      const r = decodeFrame(data.toString())
      if (!r.ok) return
      const next = waiters.shift()
      if (next) next(r.frame)
      else inbox.push(r.frame)
    })
    ws.once('error', (err) => reject(err))
    ws.once('open', () => {
      resolve({
        ws,
        recv: () =>
          new Promise<Frame>((res, rej) => {
            const f = inbox.shift()
            if (f) return res(f)
            const onClose = () => rej(new Error('socket closed before frame'))
            ws.once('close', onClose)
            waiters.push((frame) => {
              ws.off('close', onClose)
              res(frame)
            })
          }),
        send: (frame: ClientFrame) => {
          ws.send(encodeFrame(frame))
        },
        close: () =>
          new Promise<void>((res) => {
            if (ws.readyState === WebSocket.CLOSED) return res()
            ws.once('close', () => res())
            try {
              ws.close()
            } catch {
              /* ignore */
            }
          }),
      })
    })
  })
}

async function waitClose(ws: WebSocket, timeoutMs = 1000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs)
    ws.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

describe('transport-ws — per-agent identity (v0.4)', () => {
  let hub: Hub
  let wsHandle: WebSocketTransportHandle
  const clients: FakeClient[] = []

  async function startWith(authenticate: (k: string | undefined) => AuthenticateResult): Promise<void> {
    hub = Hub.inMemory()
    await hub.start()
    wsHandle = await serveWebSocket(hub, { port: 0, authenticate })
  }

  afterEach(async () => {
    for (const c of clients) {
      try {
        await c.close()
      } catch {
        /* ignore */
      }
    }
    clients.length = 0
    await wsHandle.close()
    await hub.stop()
  })

  it('{ ok: true, allowedAgents: [...] } — HELLO with allowed id -> WELCOME', async () => {
    await startWith((k) => {
      if (k === 'k-writer') return { ok: true, allowedAgents: ['writer'] }
      return false
    })
    const c = await openClient(wsHandle.url)
    clients.push(c)
    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'writer', capabilities: ['draft'] }],
      apiKey: 'k-writer',
    })
    const reply = await c.recv()
    expect(reply.type).toBe('WELCOME')
    await new Promise((r) => setTimeout(r, 20))
    expect(hub.participants().map((p) => p.id)).toContain('writer')
  })

  it('{ ok: true, allowedAgents: [...] } — HELLO with disallowed id -> REJECT forbidden_agent', async () => {
    await startWith(() => ({ ok: true, allowedAgents: ['writer'] }))
    const c = await openClient(wsHandle.url)
    clients.push(c)
    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'reviewer', capabilities: ['review'] }],
      apiKey: 'whatever',
    })
    const reply = await c.recv()
    expect(reply.type).toBe('REJECT')
    if (reply.type === 'REJECT') {
      expect(reply.code).toBe('forbidden_agent')
      expect(reply.message).toContain('reviewer')
    }
    await waitClose(c.ws)
    expect(hub.participants().map((p) => p.id)).not.toContain('reviewer')
  })

  it('{ ok: true, allowedAgents: [...] } — HELLO with mixed allowed/disallowed rolls back fully', async () => {
    await startWith(() => ({ ok: true, allowedAgents: ['writer'] }))
    const c = await openClient(wsHandle.url)
    clients.push(c)
    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [
        { id: 'writer', capabilities: ['draft'] },
        { id: 'reviewer', capabilities: ['review'] },
      ],
      apiKey: 'whatever',
    })
    const reply = await c.recv()
    expect(reply.type).toBe('REJECT')
    if (reply.type === 'REJECT') {
      expect(reply.code).toBe('forbidden_agent')
    }
    await waitClose(c.ws)
    // CRITICAL: rollback — writer must not have been left in the registry
    const ids = hub.participants().map((p) => p.id)
    expect(ids).not.toContain('writer')
    expect(ids).not.toContain('reviewer')
  })

  it("{ ok: true, allowedAgents: '*' } — explicit wildcard accepts any id", async () => {
    await startWith(() => ({ ok: true, allowedAgents: '*' }))
    const c = await openClient(wsHandle.url)
    clients.push(c)
    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [
        { id: 'a1', capabilities: [] },
        { id: 'a2', capabilities: [] },
      ],
      apiKey: 'k',
    })
    const reply = await c.recv()
    expect(reply.type).toBe('WELCOME')
    await new Promise((r) => setTimeout(r, 20))
    const ids = hub.participants().map((p) => p.id)
    expect(ids).toContain('a1')
    expect(ids).toContain('a2')
  })

  it('{ ok: false, reason } — REJECT auth_failed forwards the reason verbatim', async () => {
    await startWith(() => ({ ok: false, reason: 'revoked: contact admin' }))
    const c = await openClient(wsHandle.url)
    clients.push(c)
    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'a1', capabilities: [] }],
      apiKey: 'old-key',
    })
    const reply = await c.recv()
    expect(reply.type).toBe('REJECT')
    if (reply.type === 'REJECT') {
      expect(reply.code).toBe('auth_failed')
      expect(reply.message).toBe('revoked: contact admin')
    }
    await waitClose(c.ws)
  })

  it('legacy boolean true still accepts everything (back-compat with v0.1)', async () => {
    await startWith(() => true)
    const c = await openClient(wsHandle.url)
    clients.push(c)
    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'any-id-allowed', capabilities: [] }],
      apiKey: 'k',
    })
    const reply = await c.recv()
    expect(reply.type).toBe('WELCOME')
  })

  it('async authenticate is awaited', async () => {
    await startWith(async (k) => {
      await new Promise((r) => setTimeout(r, 30))
      return k === 'good' ? { ok: true, allowedAgents: ['writer'] } : false
    })
    const c = await openClient(wsHandle.url)
    clients.push(c)
    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'writer', capabilities: ['draft'] }],
      apiKey: 'good',
    })
    const reply = await c.recv()
    expect(reply.type).toBe('WELCOME')
  })
})
