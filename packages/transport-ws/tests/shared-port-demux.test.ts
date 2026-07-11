/**
 * Shared-port demux (D1 fix).
 *
 * `host/src/main.ts` runs federation peers AND remote agents on ONE ws
 * port: it hands `serveWebSocket`'s server to `PeerRegistry`, which used
 * to attach a SECOND, blind `'connection'` listener. Both an agent
 * `Session` and a mesh `HubLink` then grabbed every socket — and the
 * Session, seeing a `MESH_HELLO` as an illegal first frame in
 * `AWAIT_HELLO`, called `terminate()` and killed the peer's handshake
 * before its ACK could flush. Real single-port federation never
 * completed a handshake.
 *
 * Every prior mesh test used a BARE `WebSocketServer` with only
 * `acceptHubLinks` attached, so none exercised the production topology.
 * These tests do: one `serveWebSocket`, a mesh acceptor registered via
 * `routeMeshTo`, and BOTH a mesh peer and an agent handshaking on the
 * same port — in either order (the old bug was order-sensitive because
 * the Session listener was registered first).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { Hub, type HubLink } from '@gotong/core'
import {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type ClientFrame,
  type Frame,
} from '@gotong/protocol'

import {
  acceptHubLinks,
  connectHubLink,
  serveWebSocket,
  type WebSocketTransportHandle,
} from '../src/index.js'

interface FakeAgent {
  ws: WebSocket
  recv(): Promise<Frame>
  send(frame: ClientFrame): void
  close(): Promise<void>
}

function openAgent(url: string): Promise<FakeAgent> {
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
        send: (frame: ClientFrame) => ws.send(encodeFrame(frame)),
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

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function helloWelcome(agent: FakeAgent, id: string): Promise<void> {
  agent.send({
    type: 'HELLO',
    protocolVersion: PROTOCOL_VERSION,
    client: { name: 'test', version: '0.0.0' },
    agents: [{ id, capabilities: ['work'] }],
  })
  const welcome = await agent.recv()
  expect(welcome.type).toBe('WELCOME')
}

describe('transport-ws — shared-port demux (D1 fix)', () => {
  let hub: Hub
  let handle: WebSocketTransportHandle
  let detachMesh: (() => void) | undefined
  let inboundLinks: HubLink[]

  beforeEach(async () => {
    hub = Hub.inMemory()
    await hub.start()
    handle = await serveWebSocket(hub, { port: 0 })
    inboundLinks = []
    // Wire the federation mesh acceptor into the SAME server's demux —
    // exactly what the host does via `acceptInbound: ws.routeMeshTo`.
    detachMesh = acceptHubLinks({
      register: (h) => handle.routeMeshTo(h),
      selfId: 'hub-b',
      onLink: (link) => inboundLinks.push(link),
    })
  })

  afterEach(async () => {
    detachMesh?.()
    for (const l of inboundLinks) await l.close().catch(() => {})
    await handle.close()
    await hub.stop()
  })

  it('a mesh peer handshakes on the same port an agent server owns', async () => {
    // This is the exact handshake the old sibling-listener bug killed:
    // connectHubLink throws if the handshake fails or times out.
    const link = await connectHubLink({ url: handle.url, selfId: 'hub-a' })
    expect(link.status).toBe('open')
    await waitFor(() => inboundLinks.length === 1)
    expect(inboundLinks[0]?.status).toBe('open')
    await link.close()
  })

  it('an agent still handshakes on that same shared port', async () => {
    const agent = await openAgent(handle.url)
    await helloWelcome(agent, 'agent-1')
    await waitFor(() => hub.registry.has('agent-1'))
    await agent.close()
  })

  it('mesh-first then agent both succeed (demux is order-independent)', async () => {
    const link = await connectHubLink({ url: handle.url, selfId: 'hub-a' })
    expect(link.status).toBe('open')
    const agent = await openAgent(handle.url)
    await helloWelcome(agent, 'agent-2')
    await waitFor(() => hub.registry.has('agent-2') && inboundLinks.length === 1)
    await agent.close()
    await link.close()
  })

  it('agent-first then mesh both succeed (demux is order-independent)', async () => {
    const agent = await openAgent(handle.url)
    await helloWelcome(agent, 'agent-3')
    await waitFor(() => hub.registry.has('agent-3'))
    const link = await connectHubLink({ url: handle.url, selfId: 'hub-a' })
    expect(link.status).toBe('open')
    await waitFor(() => inboundLinks.length === 1)
    await agent.close()
    await link.close()
  })

  it('without a registered mesh acceptor the agent path is unchanged', async () => {
    // Detach the mesh acceptor: the server falls back to the byte-identical
    // agent-only fast path (no first-frame peek).
    detachMesh?.()
    detachMesh = undefined
    const agent = await openAgent(handle.url)
    await helloWelcome(agent, 'agent-4')
    await waitFor(() => hub.registry.has('agent-4'))
    await agent.close()
  })
})
