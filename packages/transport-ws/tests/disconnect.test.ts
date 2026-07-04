import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { Hub, type TranscriptEntry } from '@gotong/core'
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

describe('transport-ws — disconnect', () => {
  let hub: Hub
  let wsHandle: WebSocketTransportHandle

  beforeEach(async () => {
    hub = Hub.inMemory()
    await hub.start()
    wsHandle = await serveWebSocket(hub, { port: 0 })
  })

  afterEach(async () => {
    await wsHandle.close()
    await hub.stop()
  })

  it('client disconnect with in-flight task -> dispatch resolves failed with remote_disconnect + transcript has participant_left', async () => {
    const client = await openClient(wsHandle.url)

    client.send({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'agent-1', capabilities: ['work'] }],
    })

    const welcome = await client.recv()
    expect(welcome.type).toBe('WELCOME')

    await waitFor(() => hub.registry.has('agent-1'))

    const dispatchP = hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['work'] },
      payload: { x: 1 },
    })

    // wait for TASK frame to arrive (i.e. task is in-flight on the remote side)
    const taskFrame = await client.recv()
    expect(taskFrame.type).toBe('TASK')

    // do NOT reply; just slam the connection shut
    await client.close()

    const result = await dispatchP
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toBe('remote_disconnect')
      expect(result.by).toBe('agent-1')
    }

    // give the transcript append a microtick
    await new Promise((r) => setTimeout(r, 20))
    const entries: TranscriptEntry[] = hub.transcript.all()
    const left = entries.find(
      (e) => e.kind === 'participant_left' && e.data.id === 'agent-1',
    )
    expect(left).toBeDefined()
  })
})
