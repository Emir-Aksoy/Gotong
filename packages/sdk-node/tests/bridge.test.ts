import { describe, expect, it } from 'vitest'

import { AgentParticipant, Hub, type Task } from '@gotong/core'

import { TeamBridgeAgent } from '../src/bridge.js'

// These tests exercise the bridge in-process — no WebSocket. The bridge
// is just an AgentParticipant whose onTask forwards into a local Hub,
// so we can build two in-memory Hubs, register the bridge on the
// upstream side, and verify the result-reframing logic end to end.

class WriterBot extends AgentParticipant {
  constructor() {
    super({ id: 'writer-bot', capabilities: ['draft'] })
  }
  protected handleTask(task: Task): unknown {
    const topic = (task.payload as { topic?: string }).topic ?? '?'
    return { text: `wrote about ${topic}` }
  }
}

class AngryBot extends AgentParticipant {
  constructor() {
    super({ id: 'angry-bot', capabilities: ['fail'] })
  }
  protected handleTask(_task: Task): unknown {
    throw new Error('boom')
  }
}

describe('TeamBridgeAgent — federation', () => {
  it('forwards an ok task and reframes the result with localBy provenance', async () => {
    const local = Hub.inMemory()
    await local.start()
    local.register(new WriterBot())

    const upstream = Hub.inMemory()
    await upstream.start()
    const bridge = new TeamBridgeAgent({
      id: 'alice-team',
      capabilities: ['draft'],
      localHub: local,
    })
    upstream.register(bridge)

    const result = await upstream.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: { topic: 'federation', capabilities: ['draft'] },
      title: 'draft about federation',
    })

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('alice-team')           // upstream sees the bridge
      const out = result.output as {
        localBy: string
        localTaskId: string
        output: { text: string }
      }
      expect(out.localBy).toBe('writer-bot')         // provenance preserved
      expect(out.output.text).toContain('federation')
    }

    await upstream.stop()
    await local.stop()
  })

  it('reframes a local failure with "local team (<id>): …" prefix', async () => {
    const local = Hub.inMemory()
    await local.start()
    local.register(new AngryBot())

    const upstream = Hub.inMemory()
    await upstream.start()
    upstream.register(
      new TeamBridgeAgent({
        id: 'alice-team',
        capabilities: ['fail'],
        localHub: local,
      }),
    )

    const result = await upstream.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['fail'] },
      payload: { capabilities: ['fail'] },
    })

    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.by).toBe('alice-team')
      expect(result.error).toContain('local team (angry-bot):')
      expect(result.error).toContain('boom')
    }

    await upstream.stop()
    await local.stop()
  })

  it('returns no_participant when the local team has nothing for the requested cap', async () => {
    const local = Hub.inMemory()
    await local.start()
    local.register(new WriterBot())

    const upstream = Hub.inMemory()
    await upstream.start()
    upstream.register(
      new TeamBridgeAgent({
        id: 'alice-team',
        capabilities: ['review'],   // we advertise review upward …
        localHub: local,             // … but local team only has 'draft'
      }),
    )

    const result = await upstream.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['review'] },
      payload: { capabilities: ['review'] },
    })

    expect(result.kind).toBe('no_participant')
    if (result.kind === 'no_participant') {
      expect(result.reason).toContain('local team has no matching participant')
    }

    await upstream.stop()
    await local.stop()
  })

  it('respects a custom mapTask that rewrites strategy + title', async () => {
    const local = Hub.inMemory()
    await local.start()
    local.register(new WriterBot())

    const upstream = Hub.inMemory()
    await upstream.start()
    upstream.register(
      new TeamBridgeAgent({
        id: 'alice-team',
        capabilities: ['anything'],
        localHub: local,
        mapTask: () => ({
          strategy: { kind: 'capability', capabilities: ['draft'] },
          title: 'rerouted',
        }),
      }),
    )

    const result = await upstream.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['anything'] },
      payload: { topic: 'rewrite-me' },   // no `capabilities` field
      title: 'upstream title',
    })

    expect(result.kind).toBe('ok')

    // local transcript should show the rewritten title (prefixed because
    // tagLocalTasks defaults to true)
    const localTasks = local.tasks()
    expect(localTasks).toHaveLength(1)
    expect(localTasks[0]!.task.title).toBe('[upstream] rerouted')

    await upstream.stop()
    await local.stop()
  })
})
