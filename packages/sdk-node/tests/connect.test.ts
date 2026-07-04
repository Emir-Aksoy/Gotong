import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentParticipant, Hub, type Task, type TranscriptEntry } from '@gotong/core'
import { serveWebSocket, type WebSocketTransportHandle } from '@gotong/transport-ws'

import { connect, type Session, type SessionState } from '../src/index.js'

class NoopAgent extends AgentParticipant {
  constructor(id: string, capabilities: readonly string[] = []) {
    super({ id, capabilities })
  }
  protected async handleTask(_task: Task): Promise<unknown> {
    return { ok: true }
  }
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

describe('sdk-node — connect', () => {
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
    await wsHandle.close()
    await hub.stop()
  })

  it('connect(...) resolves on WELCOME — state is ready, sessionId non-empty', async () => {
    session = await connect({
      url: wsHandle.url,
      agents: [new NoopAgent('sdk-agent', ['work'])],
      autoReconnect: false,
    })

    expect(session.state).toBe('ready')
    expect(session.sessionId).toBeTruthy()
    expect(typeof session.sessionId).toBe('string')
  })

  it('connected agent appears in hub.participants()', async () => {
    session = await connect({
      url: wsHandle.url,
      agents: [new NoopAgent('sdk-agent-2', ['work'])],
      autoReconnect: false,
    })
    // a tiny beat for registration to flush
    await waitFor(() => hub.registry.has('sdk-agent-2'))
    expect(hub.participants().map((p) => p.id)).toContain('sdk-agent-2')
  })

  it('session.close() transitions closing -> closed and triggers participant_left', async () => {
    const states: SessionState[] = []
    session = await connect({
      url: wsHandle.url,
      agents: [new NoopAgent('sdk-agent-3', [])],
      autoReconnect: false,
      onStateChange: (s) => states.push(s),
    })
    await waitFor(() => hub.registry.has('sdk-agent-3'))

    await session.close()
    expect(session.state).toBe('closed')
    expect(states).toContain('closing')
    expect(states).toContain('closed')

    // give the server cleanup a tick
    await new Promise((r) => setTimeout(r, 50))

    const entries: TranscriptEntry[] = hub.transcript.all()
    const left = entries.find(
      (e) => e.kind === 'participant_left' && e.data.id === 'sdk-agent-3',
    )
    expect(left).toBeDefined()
  })
})
