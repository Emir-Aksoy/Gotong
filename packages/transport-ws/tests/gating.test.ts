import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { Hub } from '@aipehub/core'
import {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type ClientFrame,
  type Frame,
} from '@aipehub/protocol'

import { serveWebSocket, type WebSocketTransportHandle } from '../src/index.js'

// --- inline FakeClient (matches handshake.test.ts) ---------------------------

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('transport-ws — gating: admin-approval (v1.1)', () => {
  let hub: Hub
  let wsHandle: WebSocketTransportHandle
  const clients: FakeClient[] = []

  beforeEach(async () => {
    hub = Hub.inMemory()
    await hub.start()
    wsHandle = await serveWebSocket(hub, { port: 0, gating: 'admin-approval' })
  })

  afterEach(async () => {
    for (const c of clients) {
      try {
        await c.close()
      } catch { /* ignore */ }
    }
    clients.length = 0
    await wsHandle.close()
    await hub.stop()
  })

  it('HELLO with admin-approval -> client hangs in AWAIT_APPROVAL; hub.pendingApplications() lists it', async () => {
    const c = await openClient(wsHandle.url)
    clients.push(c)

    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'writer', capabilities: ['draft'] }],
    })

    // wait long enough that an 'open' transport would have responded
    await sleep(60)
    expect(hub.pendingApplications()).toHaveLength(1)
    expect(hub.pendingApplications()[0]!.agents[0]!.id).toBe('writer')
    // agent must NOT be registered yet
    expect(hub.participants().map((p) => p.id)).not.toContain('writer')
    // transcript has agent_pending
    expect(hub.transcript.all().some((e) => e.kind === 'agent_pending')).toBe(true)
  })

  it('approveApplication -> WELCOME arrives and agent is registered', async () => {
    const c = await openClient(wsHandle.url)
    clients.push(c)
    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'writer', capabilities: ['draft'] }],
    })
    await sleep(40)
    const app = hub.pendingApplications()[0]!
    expect(hub.approveApplication(app.id, 'admin')).toBe(true)

    const reply = await c.recv()
    expect(reply.type).toBe('WELCOME')
    expect(hub.participants().map((p) => p.id)).toContain('writer')
    expect(hub.pendingApplications()).toHaveLength(0)
  })

  it('rejectApplication -> REJECT auth_failed with the supplied reason; socket closes', async () => {
    const c = await openClient(wsHandle.url)
    clients.push(c)
    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'sketchy', capabilities: [] }],
    })
    await sleep(40)
    const app = hub.pendingApplications()[0]!
    hub.rejectApplication(app.id, 'no thanks', 'admin')

    const reply = await c.recv()
    expect(reply.type).toBe('REJECT')
    if (reply.type === 'REJECT') {
      expect(reply.code).toBe('auth_failed')
      expect(reply.message).toContain('no thanks')
    }
    expect(hub.participants().map((p) => p.id)).not.toContain('sketchy')
  })

  it('client disconnects during AWAIT_APPROVAL -> application is cleaned up with client_disconnected', async () => {
    const c = await openClient(wsHandle.url)
    clients.push(c)
    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'flaky', capabilities: [] }],
    })
    await sleep(40)
    expect(hub.pendingApplications()).toHaveLength(1)
    const appId = hub.pendingApplications()[0]!.id

    // client gives up
    await c.close()
    await sleep(40)

    expect(hub.pendingApplications()).toHaveLength(0)
    const reject = hub.transcript.all().find(
      (e) => e.kind === 'agent_rejected' && e.data.applicationId === appId,
    )
    expect(reject).toBeTruthy()
    if (reject?.kind === 'agent_rejected') {
      expect(reject.data.reason).toBe('client_disconnected')
    }
  })

  it('multi-agent HELLO -> all approved together, all registered', async () => {
    const c = await openClient(wsHandle.url)
    clients.push(c)
    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [
        { id: 'a1', capabilities: ['x'] },
        { id: 'a2', capabilities: ['y'] },
      ],
    })
    await sleep(40)
    const app = hub.pendingApplications()[0]!
    expect(app.agents.map((a) => a.id)).toEqual(['a1', 'a2'])
    hub.approveApplication(app.id, 'admin')

    const reply = await c.recv()
    expect(reply.type).toBe('WELCOME')
    const ids = hub.participants().map((p) => p.id)
    expect(ids).toContain('a1')
    expect(ids).toContain('a2')
  })

  it('authenticate failure short-circuits before admission (no application created)', async () => {
    await wsHandle.close()
    wsHandle = await serveWebSocket(hub, {
      port: 0,
      gating: 'admin-approval',
      authenticate: () => false,
    })
    const c = await openClient(wsHandle.url)
    clients.push(c)
    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'whatever', capabilities: [] }],
      apiKey: 'bad',
    })
    const reply = await c.recv()
    expect(reply.type).toBe('REJECT')
    if (reply.type === 'REJECT') expect(reply.code).toBe('auth_failed')
    expect(hub.pendingApplications()).toHaveLength(0)
  })

  it('gating="open" (default) bypasses admission entirely — sanity', async () => {
    await wsHandle.close()
    wsHandle = await serveWebSocket(hub, { port: 0 /* no gating */ })
    const c = await openClient(wsHandle.url)
    clients.push(c)
    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'free', capabilities: [] }],
    })
    const reply = await c.recv()
    expect(reply.type).toBe('WELCOME')
    expect(hub.pendingApplications()).toHaveLength(0)
  })
})
