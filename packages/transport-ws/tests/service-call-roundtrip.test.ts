/**
 * End-to-end SERVICE_CALL roundtrip — real WebSocket server, real client
 * frames. Verifies HELLO.services declaration flows into a working
 * router, SERVICE_CALL produces SERVICE_RESULT, and the absence of a
 * gateway falls back to forbidden_service.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { Hub } from '@gotong/core'
import {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type ClientFrame,
  type Frame,
  type ServiceOwner,
} from '@gotong/protocol'

import {
  serveWebSocket,
  type ServiceCallGateway,
  type WebSocketTransportHandle,
} from '../src/index.js'

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
        send: (frame) => ws.send(encodeFrame(frame)),
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

class FakeMemoryHandle {
  log: Array<{ kind: string; text: string }> = []

  async remember(entry: { kind: string; text: string }): Promise<{ id: string }> {
    this.log.push(entry)
    return { id: `e${this.log.length}` }
  }

  async recall(_q: unknown): Promise<Array<{ id: string; text: string }>> {
    return this.log.map((e, i) => ({ id: `e${i + 1}`, text: e.text }))
  }
}

class FakeGateway implements ServiceCallGateway {
  handles = new Map<string, FakeMemoryHandle>()
  detachCalls: ServiceOwner[] = []

  async attach(spec: {
    type: string
    impl: string
    owner: ServiceOwner
    config: unknown
  }): Promise<{ handle: unknown }> {
    const key = `${spec.type}:${spec.impl}:${spec.owner.kind}/${spec.owner.id}`
    let h = this.handles.get(key)
    if (!h) {
      h = new FakeMemoryHandle()
      this.handles.set(key, h)
    }
    return { handle: h }
  }

  async detachFor(owner: ServiceOwner): Promise<void> {
    this.detachCalls.push(owner)
  }
}

describe('transport-ws — SERVICE_CALL end-to-end', () => {
  let hub: Hub
  let wsHandle: WebSocketTransportHandle
  let gateway: FakeGateway
  let client: FakeClient | undefined

  beforeEach(async () => {
    hub = Hub.inMemory()
    await hub.start()
    gateway = new FakeGateway()
    wsHandle = await serveWebSocket(hub, {
      port: 0,
      services: gateway,
    })
  })

  afterEach(async () => {
    if (client) {
      await client.close()
      client = undefined
    }
    await wsHandle.close()
    await hub.stop()
  })

  it('HELLO with services → SERVICE_CALL roundtrips through the gateway', async () => {
    client = await openClient(wsHandle.url)
    client.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'coach', capabilities: ['draft'] }],
      services: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
    })
    const welcome = await client.recv()
    expect(welcome.type).toBe('WELCOME')

    // Remember then recall — verifies both directions of the contract.
    client.send({
      type: 'SERVICE_CALL',
      callId: 'c-1',
      from: 'coach',
      service: { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'coach' } },
      method: 'remember',
      args: [{ kind: 'episodic', text: 'hello from sidecar' }],
    })
    const rememberResult = await client.recv()
    expect(rememberResult.type).toBe('SERVICE_RESULT')
    if (rememberResult.type !== 'SERVICE_RESULT') return
    expect(rememberResult.callId).toBe('c-1')
    expect(rememberResult.ok).toBe(true)

    client.send({
      type: 'SERVICE_CALL',
      callId: 'c-2',
      from: 'coach',
      service: { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'coach' } },
      method: 'recall',
      args: [{ k: 10 }],
    })
    const recallResult = await client.recv()
    expect(recallResult.type).toBe('SERVICE_RESULT')
    if (recallResult.type !== 'SERVICE_RESULT') return
    expect(recallResult.ok).toBe(true)
    if (!recallResult.ok) return
    expect(recallResult.value).toEqual([{ id: 'e1', text: 'hello from sidecar' }])

    // The fake gateway should have been touched exactly once (lazy attach).
    expect(gateway.handles.size).toBe(1)
  })

  it('forbidden_service when HELLO declared no services', async () => {
    client = await openClient(wsHandle.url)
    client.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'a1', capabilities: ['w'] }],
      // no services field — v1.0 behaviour
    })
    await client.recv() // WELCOME
    client.send({
      type: 'SERVICE_CALL',
      callId: 'c-x',
      from: 'a1',
      service: { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'a1' } },
      method: 'recall',
      args: [{}],
    })
    const result = await client.recv()
    expect(result.type).toBe('SERVICE_RESULT')
    if (result.type !== 'SERVICE_RESULT') return
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('forbidden_service')
  })

  it('wildcard owner pattern allows different case ids', async () => {
    client = await openClient(wsHandle.url)
    client.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'coach', capabilities: ['draft'] }],
      services: [
        { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*' } },
      ],
    })
    await client.recv() // WELCOME

    // Two different case ids → both should attach independently.
    for (const caseId of ['case-A', 'case-B']) {
      client.send({
        type: 'SERVICE_CALL',
        callId: `c-${caseId}`,
        from: 'coach',
        service: { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: caseId } },
        method: 'remember',
        args: [{ kind: 'episodic', text: `from ${caseId}` }],
      })
      const result = await client.recv()
      expect(result.type).toBe('SERVICE_RESULT')
      if (result.type !== 'SERVICE_RESULT') return
      expect(result.ok).toBe(true)
    }
    expect(gateway.handles.size).toBe(2)
  })

  it('forbidden_owner when concrete owner doesn’t match any pattern', async () => {
    client = await openClient(wsHandle.url)
    client.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'coach', capabilities: ['draft'] }],
      services: [
        // Declare only the agent/self owner.
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
    })
    await client.recv() // WELCOME

    client.send({
      type: 'SERVICE_CALL',
      callId: 'c-bad',
      from: 'coach',
      // Try to call as workflow-run — not declared.
      service: { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: 'X' } },
      method: 'recall',
      args: [{}],
    })
    const result = await client.recv()
    expect(result.type).toBe('SERVICE_RESULT')
    if (result.type !== 'SERVICE_RESULT') return
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('forbidden_owner')
    expect(gateway.handles.size).toBe(0) // never reached the gateway
  })

  it('disconnect dispose detaches every lazy-attached owner', async () => {
    client = await openClient(wsHandle.url)
    client.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'coach', capabilities: ['draft'] }],
      services: [
        { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*' } },
      ],
    })
    await client.recv() // WELCOME

    for (const c of ['A', 'B', 'C']) {
      client.send({
        type: 'SERVICE_CALL',
        callId: `c-${c}`,
        from: 'coach',
        service: { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: c } },
        method: 'remember',
        args: [{ kind: 'episodic', text: c }],
      })
      await client.recv()
    }
    expect(gateway.handles.size).toBe(3)

    await client.close()
    client = undefined

    // Wait for the server's async detach loop to run.
    const start = Date.now()
    while (gateway.detachCalls.length < 3 && Date.now() - start < 1000) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(gateway.detachCalls).toHaveLength(3)
    expect(gateway.detachCalls.map((o) => o.id).sort()).toEqual(['A', 'B', 'C'])
  })
})

describe('transport-ws — SERVICE_CALL without gateway', () => {
  let hub: Hub
  let wsHandle: WebSocketTransportHandle
  let client: FakeClient | undefined

  beforeEach(async () => {
    hub = Hub.inMemory()
    await hub.start()
    // No `services` option → SERVICE_CALL must be rejected.
    wsHandle = await serveWebSocket(hub, { port: 0 })
  })

  afterEach(async () => {
    if (client) await client.close()
    await wsHandle.close()
    await hub.stop()
  })

  it('v1.1 client + v1.0-style server (no gateway) → forbidden_service', async () => {
    client = await openClient(wsHandle.url)
    client.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'a1', capabilities: [] }],
      services: [
        // Client declares services, but the transport has no gateway —
        // we expect HELLO to still succeed (gating policy is unchanged)
        // and the first SERVICE_CALL to come back forbidden_service.
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
    })
    await client.recv() // WELCOME

    client.send({
      type: 'SERVICE_CALL',
      callId: 'c-x',
      from: 'a1',
      service: { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'a1' } },
      method: 'recall',
      args: [{}],
    })
    const result = await client.recv()
    expect(result.type).toBe('SERVICE_RESULT')
    if (result.type !== 'SERVICE_RESULT') return
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('forbidden_service')
  })
})
