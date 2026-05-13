import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentParticipant, Hub, type Task } from '@aipehub/core'
import { serveWebSocket, type WebSocketTransportHandle } from '@aipehub/transport-ws'

import { connect, type Session } from '../src/index.js'

class DoneAgent extends AgentParticipant {
  constructor() {
    super({ id: 'done-agent', capabilities: ['work'] })
  }
  protected async handleTask(_task: Task): Promise<unknown> {
    return { done: true }
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

describe('sdk-node — task roundtrip', () => {
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

  it('hub.dispatch capability=work resolves ok with { done: true }', async () => {
    session = await connect({
      url: wsHandle.url,
      agents: [new DoneAgent()],
      autoReconnect: false,
    })
    await waitFor(() => hub.registry.has('done-agent'))

    const result = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['work'] },
      payload: { input: 42 },
    })

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('done-agent')
      expect(result.output).toEqual({ done: true })
    }
  })
})
