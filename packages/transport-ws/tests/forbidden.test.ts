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

describe('transport-ws — forbidden / unknown', () => {
  let hub: Hub
  let wsHandle: WebSocketTransportHandle
  let client: FakeClient | undefined

  beforeEach(async () => {
    hub = Hub.inMemory()
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

  it('PUBLISH with from=non-owned id -> ERROR forbidden_publish', async () => {
    client = await openClient(wsHandle.url)
    client.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'agent-1', capabilities: [] }],
    })
    const welcome = await client.recv()
    expect(welcome.type).toBe('WELCOME')

    client.send({
      type: 'PUBLISH',
      from: 'someone-else',
      channel: '#general',
      body: 'hi',
    })

    const reply = await client.recv()
    expect(reply.type).toBe('ERROR')
    if (reply.type === 'ERROR') {
      expect(reply.code).toBe('forbidden_publish')
    }
  })

  it('RESULT for unknown taskId -> ERROR unknown_task', async () => {
    client = await openClient(wsHandle.url)
    client.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'agent-1', capabilities: [] }],
    })
    const welcome = await client.recv()
    expect(welcome.type).toBe('WELCOME')

    client.send({
      type: 'RESULT',
      result: {
        kind: 'ok',
        taskId: 'task-does-not-exist',
        by: 'agent-1',
        output: {},
        ts: Date.now(),
      },
    })

    const reply = await client.recv()
    expect(reply.type).toBe('ERROR')
    if (reply.type === 'ERROR') {
      expect(reply.code).toBe('unknown_task')
    }
  })
})
