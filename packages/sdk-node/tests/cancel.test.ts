import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentParticipant, Hub, type Task, type TaskId } from '@gotong/core'
import { serveWebSocket, type WebSocketTransportHandle } from '@gotong/transport-ws'

import { connect, type Session } from '../src/index.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

class FastAgent extends AgentParticipant {
  constructor() {
    super({ id: 'fast', capabilities: ['work'] })
  }
  protected async handleTask(_task: Task): Promise<unknown> {
    return { who: 'fast' }
  }
}

interface CancelRecord {
  taskId: TaskId
  reason: string
}

class SlowAgent extends AgentParticipant {
  cancellations: CancelRecord[] = []
  constructor() {
    super({ id: 'slow', capabilities: ['work'] })
  }
  protected async handleTask(_task: Task): Promise<unknown> {
    await sleep(500)
    return { who: 'slow' }
  }
  override onTaskCancelled(taskId: TaskId, reason: string): void {
    this.cancellations.push({ taskId, reason })
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

describe('sdk-node — cancel notification', () => {
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

  it('slow agent receives onTaskCancelled when the fast one wins broadcast', async () => {
    const slow = new SlowAgent()
    const fast = new FastAgent()

    session = await connect({
      url: wsHandle.url,
      agents: [fast, slow],
      autoReconnect: false,
    })

    await waitFor(() => hub.registry.has('fast') && hub.registry.has('slow'))

    const result = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'broadcast', capabilities: ['work'] },
      payload: {},
    })

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('fast')
    }

    // wait briefly for the CANCEL frame to reach the slow agent
    await waitFor(() => slow.cancellations.length > 0, 1000)

    expect(slow.cancellations.length).toBe(1)
    const c = slow.cancellations[0]!
    expect(typeof c.taskId).toBe('string')
    expect(c.taskId.length).toBeGreaterThan(0)
    expect(c.reason).toMatch(/broadcast/)
  })
})
