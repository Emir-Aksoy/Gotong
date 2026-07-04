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

describe('transport-ws — task roundtrip', () => {
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

  it('dispatch -> TASK frame -> RESULT frame -> ok result', async () => {
    client = await openClient(wsHandle.url)

    client.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'agent-1', capabilities: ['work'] }],
    })

    const welcome = await client.recv()
    expect(welcome.type).toBe('WELCOME')

    // wait until the participant lands in the registry
    await waitFor(() => hub.registry.has('agent-1'))

    // Race-safe: kick off the dispatch first, but await it AFTER we've
    // pulled the TASK frame off the wire and posted RESULT back.
    const dispatchP = hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['work'] },
      payload: { x: 1 },
    })

    const taskFrame = await client.recv()
    expect(taskFrame.type).toBe('TASK')
    if (taskFrame.type !== 'TASK') throw new Error('expected TASK frame')
    expect(taskFrame.recipient).toBe('agent-1')
    expect(taskFrame.task.payload).toEqual({ x: 1 })

    client.send({
      type: 'RESULT',
      result: {
        kind: 'ok',
        taskId: taskFrame.task.id,
        by: 'agent-1',
        output: { y: 2 },
        ts: Date.now(),
      },
    })

    const result = await dispatchP
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('agent-1')
      expect(result.output).toEqual({ y: 2 })
    }
  })
})
