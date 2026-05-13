import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentParticipant, Hub, type Task } from '@aipehub/core'
import { serveWebSocket, type WebSocketTransportHandle } from '@aipehub/transport-ws'

import { connect, type Session, type SessionState } from '../src/index.js'

class NoopAgent extends AgentParticipant {
  constructor(id: string) {
    super({ id, capabilities: ['work'] })
  }
  protected async handleTask(_task: Task): Promise<unknown> {
    return { ok: true }
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
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

describe('sdk-node — reconnect', () => {
  let hub: Hub
  let wsHandle: WebSocketTransportHandle
  let session: Session | undefined

  beforeEach(async () => {
    hub = Hub.inMemory()
    await hub.start()
    wsHandle = await serveWebSocket(hub, { port: 0 })
  })

  afterEach(async () => {
    if (session && session.state !== 'closed') {
      await session.close()
    }
    session = undefined
    if (wsHandle) {
      try {
        await wsHandle.close()
      } catch {
        /* may already be closed by the test */
      }
    }
    await hub.stop()
  })

  it('kill the connection -> SDK enters reconnecting -> session.close() reaches closed', async () => {
    const states: SessionState[] = []
    session = await connect({
      url: wsHandle.url,
      agents: [new NoopAgent('rc-agent')],
      autoReconnect: true,
      reconnectInitialBackoffMs: 100,
      reconnectMaxBackoffMs: 200,
      onStateChange: (s) => states.push(s),
    })
    expect(session.state).toBe('ready')

    await waitFor(() => hub.registry.has('rc-agent'))

    // close the server (and therefore all sessions); SDK should
    // observe close and start reconnecting (against nothing — that's fine)
    await wsHandle.close()

    await waitFor(() => states.includes('reconnecting'))

    // tear it down cleanly
    await session.close()
    expect(session.state).toBe('closed')
    expect(states).toContain('closed')
  })

  it('reconnect against a fresh server on the same port -> state returns to ready', async () => {
    const port = wsHandle.port
    const states: SessionState[] = []
    session = await connect({
      url: wsHandle.url,
      agents: [new NoopAgent('rc-agent-2')],
      autoReconnect: true,
      reconnectInitialBackoffMs: 100,
      reconnectMaxBackoffMs: 200,
      onStateChange: (s) => states.push(s),
    })
    expect(session.state).toBe('ready')
    await waitFor(() => hub.registry.has('rc-agent-2'))

    // Tear down the old transport and start a new one on the same port
    // with a brand-new hub.
    await wsHandle.close()
    await hub.stop()

    hub = Hub.inMemory()
    await hub.start()
    // re-bind the same port; race vs SDK retries — we expect to win because
    // the OS releases the port immediately on close()
    wsHandle = await serveWebSocket(hub, { port })

    // expect SDK to walk through reconnecting -> connecting -> ready
    await waitFor(() => states.includes('reconnecting'), 2000)
    await waitFor(() => session!.state === 'ready', 4000)
    expect(states).toContain('reconnecting')
    expect(states).toContain('ready')

    // and the new server saw the agent register
    await waitFor(() => hub.registry.has('rc-agent-2'), 1000)
    expect(hub.registry.has('rc-agent-2')).toBe(true)
  })
})
