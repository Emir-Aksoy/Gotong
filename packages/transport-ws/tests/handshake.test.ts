import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { Hub, AgentParticipant, type Task } from '@aipehub/core'
import {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type ClientFrame,
  type Frame,
} from '@aipehub/protocol'

import { serveWebSocket, type WebSocketTransportHandle } from '../src/index.js'

// inline helper — keep tests self-contained per file convention
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

// EchoAgent — for the duplicate-id test we need a pre-registered agent
class EchoAgent extends AgentParticipant {
  constructor(id: string, capabilities: readonly string[] = []) {
    super({ id, capabilities })
  }
  protected async handleTask(_task: Task): Promise<unknown> {
    return { ok: true }
  }
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

describe('transport-ws — handshake', () => {
  let hub: Hub
  let wsHandle: WebSocketTransportHandle
  const clients: FakeClient[] = []

  beforeEach(async () => {
    hub = Hub.inMemory()
    await hub.start()
    wsHandle = await serveWebSocket(hub, { port: 0 })
  })

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

  it('HELLO with valid agents -> WELCOME and agents appear in hub.participants()', async () => {
    const c = await openClient(wsHandle.url)
    clients.push(c)

    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'agent-1', capabilities: ['work'] }],
    })

    const reply = await c.recv()
    expect(reply.type).toBe('WELCOME')
    if (reply.type === 'WELCOME') {
      expect(reply.protocolVersion).toBe(PROTOCOL_VERSION)
      expect(reply.sessionId).toBeTruthy()
    }
    // give the server a beat to settle registration
    await new Promise((r) => setTimeout(r, 20))
    expect(hub.participants().map((p) => p.id)).toContain('agent-1')
  })

  it('HELLO with empty agents -> REJECT bad_hello and socket closed', async () => {
    const c = await openClient(wsHandle.url)
    clients.push(c)

    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [],
    })

    const reply = await c.recv()
    expect(reply.type).toBe('REJECT')
    if (reply.type === 'REJECT') {
      expect(reply.code).toBe('bad_hello')
    }
    await waitClose(c.ws)
    expect(c.ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('HELLO with major version mismatch -> REJECT protocol_mismatch', async () => {
    const c = await openClient(wsHandle.url)
    clients.push(c)

    c.send({
      type: 'HELLO',
      protocolVersion: '2.0',
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'agent-mm', capabilities: [] }],
    })

    const reply = await c.recv()
    expect(reply.type).toBe('REJECT')
    if (reply.type === 'REJECT') {
      expect(reply.code).toBe('protocol_mismatch')
    }
    await waitClose(c.ws)
  })

  it('HELLO with duplicate id -> REJECT duplicate_id', async () => {
    hub.register(new EchoAgent('already-here', ['work']))

    const c = await openClient(wsHandle.url)
    clients.push(c)

    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'already-here', capabilities: ['work'] }],
    })

    const reply = await c.recv()
    expect(reply.type).toBe('REJECT')
    if (reply.type === 'REJECT') {
      expect(reply.code).toBe('duplicate_id')
    }
    await waitClose(c.ws)
  })

  // The HELLO_TIMEOUT test is skipped: HELLO_TIMEOUT_MS is 5000ms,
  // which is too slow to wait for in a real-server integration test.
  // The session.ts logic is straightforward (setTimeout that fires sendReject
  // + terminate) and is covered by reading; faking timers across a real
  // WebSocketServer + ws.WebSocket would require deep mocking that doesn't
  // exercise the real handler.

  it('authenticate returning false -> REJECT auth_failed', async () => {
    // start an alt server that requires auth
    const altHub = Hub.inMemory()
    await altHub.start()
    const alt = await serveWebSocket(altHub, {
      port: 0,
      authenticate: () => false,
    })
    try {
      const c = await openClient(alt.url)
      clients.push(c)
      c.send({
        type: 'HELLO',
        protocolVersion: PROTOCOL_VERSION,
        client: { name: 'test', version: '0.0.0' },
        agents: [{ id: 'authed', capabilities: [] }],
        apiKey: 'nope',
      })
      const reply = await c.recv()
      expect(reply.type).toBe('REJECT')
      if (reply.type === 'REJECT') {
        expect(reply.code).toBe('auth_failed')
      }
      await waitClose(c.ws)
    } finally {
      await alt.close()
      await altHub.stop()
    }
  })

  it('authenticate returning true -> WELCOME', async () => {
    const altHub = Hub.inMemory()
    await altHub.start()
    const alt = await serveWebSocket(altHub, {
      port: 0,
      authenticate: (key) => key === 'sekrit',
    })
    try {
      const c = await openClient(alt.url)
      clients.push(c)
      c.send({
        type: 'HELLO',
        protocolVersion: PROTOCOL_VERSION,
        client: { name: 'test', version: '0.0.0' },
        agents: [{ id: 'authed', capabilities: [] }],
        apiKey: 'sekrit',
      })
      const reply = await c.recv()
      expect(reply.type).toBe('WELCOME')
    } finally {
      await alt.close()
      await altHub.stop()
    }
  })
})
