// H22 regression: a HELLO that declares more than `MAX_HELLO_AGENTS`
// agents must be rejected with `bad_hello` BEFORE any agent ends up
// in the Hub registry. Pre-3.4 a malicious client could send a HELLO
// with 10 000 agent entries; each would land in registry memory until
// the session closed — a cheap memory-exhaustion vector.
//
// We assert two things:
//   1. The reject + terminate happens for any HELLO over the limit.
//   2. The Hub registry stays empty after the reject — the cap fires
//      BEFORE per-agent processing.
//
// See AUDIT-v3.3.md finding H22.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { Hub } from '@gotong/core'
import {
  MAX_HELLO_AGENTS,
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type Frame,
} from '@gotong/protocol'

import { serveWebSocket, type WebSocketTransportHandle } from '../src/index.js'

interface FakeClient {
  ws: WebSocket
  recv(): Promise<Frame>
  send(frame: unknown): void
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
        send: (frame: unknown) => {
          ws.send(encodeFrame(frame as never))
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

describe('HELLO.agents length cap (H22)', () => {
  let hub: Hub
  let wsHandle: WebSocketTransportHandle
  const clients: FakeClient[] = []

  beforeEach(async () => {
    hub = Hub.inMemory()
    await hub.start()
    // Raise maxPayload because building a 257-agent HELLO produces a
    // frame in the tens of KiB — comfortably under our default of
    // 256 KiB, but we set it explicitly so the test is robust to a
    // future tightening of the default. The audit point is about the
    // app-level agents.length cap, not the WS-frame size cap.
    wsHandle = await serveWebSocket(hub, { port: 0, maxPayload: 1_048_576 })
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

  it('exports the documented cap', () => {
    expect(MAX_HELLO_AGENTS).toBe(256)
  })

  it('accepts MAX_HELLO_AGENTS agents (boundary)', async () => {
    const c = await openClient(wsHandle.url)
    clients.push(c)

    const agents = Array.from({ length: MAX_HELLO_AGENTS }, (_, i) => ({
      id: `agent-${i}`,
      capabilities: ['work'],
    }))

    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents,
    })

    const reply = await c.recv()
    expect(reply.type).toBe('WELCOME')
    // All MAX_HELLO_AGENTS agents land in the registry.
    expect(hub.participants().length).toBe(MAX_HELLO_AGENTS)
  })

  it('rejects MAX_HELLO_AGENTS + 1 agents with bad_hello and terminates the socket', async () => {
    const c = await openClient(wsHandle.url)
    clients.push(c)

    const agents = Array.from({ length: MAX_HELLO_AGENTS + 1 }, (_, i) => ({
      id: `agent-${i}`,
      capabilities: ['work'],
    }))

    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents,
    })

    const reply = await c.recv()
    expect(reply.type).toBe('REJECT')
    if (reply.type === 'REJECT') {
      expect(reply.code).toBe('bad_hello')
      // Diagnostic must mention both the offending count and the cap.
      expect(reply.message).toContain(String(MAX_HELLO_AGENTS + 1))
      expect(reply.message).toContain(String(MAX_HELLO_AGENTS))
    }

    // Socket must terminate after the reject.
    await waitClose(c.ws, 2000)
    expect(c.ws.readyState).toBe(WebSocket.CLOSED)

    // CRITICAL: registry is empty — the cap fired BEFORE any per-agent
    // processing. If a future refactor moves the check after the
    // registration loop, this assertion catches it.
    expect(hub.participants().length).toBe(0)
  })

  it('rejects a flagrantly oversized HELLO without exhausting memory', async () => {
    // 5 000 agents — well above the cap. The server must terminate
    // the connection without spending O(N) work per agent. We're not
    // timing the rejection here (test framework would be unreliable
    // for sub-millisecond checks), but we ARE asserting that the
    // session.ts cap path is reached and the registry stays empty.
    const c = await openClient(wsHandle.url)
    clients.push(c)

    const agents = Array.from({ length: 5000 }, (_, i) => ({
      id: `flood-${i}`,
      capabilities: ['work'],
    }))

    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'flooder', version: '0.0.0' },
      agents,
    })

    const reply = await c.recv()
    expect(reply.type).toBe('REJECT')
    if (reply.type === 'REJECT') expect(reply.code).toBe('bad_hello')

    await waitClose(c.ws, 2000)
    expect(hub.participants().length).toBe(0)
  })

  it('empty agents array is still rejected (existing behaviour preserved)', async () => {
    // H22 doesn't change the lower bound — empty HELLO.agents was
    // already a `bad_hello`, and the diagnostic should still mention
    // "non-empty" rather than the new "exceeds limit" message.
    const c = await openClient(wsHandle.url)
    clients.push(c)

    c.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'empty', version: '0.0.0' },
      agents: [],
    })

    const reply = await c.recv()
    expect(reply.type).toBe('REJECT')
    if (reply.type === 'REJECT') {
      expect(reply.code).toBe('bad_hello')
      expect(reply.message).toContain('non-empty')
    }
  })
})
