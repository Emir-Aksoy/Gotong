import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { AgentParticipant, Hub, type Task } from '@aipehub/core'
import {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type ClientFrame,
  type Frame,
} from '@aipehub/protocol'

import { serveWebSocket, type WebSocketTransportHandle } from '../src/index.js'

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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timeout')
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

class FastLocalAgent extends AgentParticipant {
  constructor(id: string) {
    super({ id, capabilities: ['review'] })
  }
  protected async handleTask(_task: Task): Promise<unknown> {
    return { reviewed: true }
  }
}

describe('transport-ws — broadcast cancel', () => {
  let hub: Hub
  let wsHandle: WebSocketTransportHandle
  let client: FakeClient | undefined

  beforeEach(async () => {
    hub = new Hub()
    await hub.start()
    wsHandle = await serveWebSocket(hub, { port: 0 })
  })

  afterEach(async () => {
    if (client) {
      await client.close()
      client = undefined
    }
    await wsHandle.close()
    await hub.stop()
  })

  it('local agent wins broadcast; remote receives CANCEL', async () => {
    // local fast agent
    hub.register(new FastLocalAgent('local-fast'))

    // remote (slow / never replies) agent over the wire
    client = await openClient(wsHandle.url)
    client.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'remote-slow', capabilities: ['review'] }],
    })
    const welcome = await client.recv()
    expect(welcome.type).toBe('WELCOME')

    await waitFor(() => hub.registry.has('remote-slow'))

    const dispatchP = hub.dispatch({
      from: 'system',
      strategy: { kind: 'broadcast', capabilities: ['review'] },
      payload: { document: 'hello' },
    })

    // we expect TWO frames to come back to this remote client:
    // - TASK (initial fan-out)
    // - CANCEL (because the local-fast agent won)
    // Order is: TASK first (sent during dispatch), then CANCEL
    // (sent when the winner resolves first).
    const first = await client.recv()
    expect(first.type).toBe('TASK')
    if (first.type !== 'TASK') throw new Error('expected TASK')
    const taskId = first.task.id

    const second = await client.recv()
    expect(second.type).toBe('CANCEL')
    if (second.type === 'CANCEL') {
      expect(second.recipient).toBe('remote-slow')
      expect(second.taskId).toBe(taskId)
    }

    const result = await dispatchP
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('local-fast')
    }
  })
})
