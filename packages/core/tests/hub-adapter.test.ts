/**
 * HubAsParticipant — M1 of the hub-mesh implementation.
 *
 * The adapter wraps an inner Hub so it can be registered into another
 * Hub as a normal Participant. These tests pin the four behaviours that
 * make the wrapper a real first-class peer:
 *
 *   1. registers + dispatches: outer can route to inner via capability
 *   2. capabilities is live: changes to inner reflect immediately
 *   3. taskId is relabelled: outer-task.id matches result.taskId
 *   4. message bridge: outer-publish reaches inner-subscribers
 */

import { describe, expect, it } from 'vitest'

import { Hub } from '../src/hub.js'
import { AgentParticipant } from '../src/participants/agent.js'
import { HubAsParticipant } from '../src/participants/hub-adapter.js'
import type { Message, Task } from '../src/types.js'

class EchoAgent extends AgentParticipant {
  constructor(id: string, capabilities: readonly string[]) {
    super({ id, capabilities })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    return { echoedFrom: this.id, payload: task.payload }
  }
}

class FailAgent extends AgentParticipant {
  constructor(id: string, capabilities: readonly string[]) {
    super({ id, capabilities })
  }
  protected async handleTask(): Promise<unknown> {
    throw new Error('intentional failure')
  }
}

const flush = () => new Promise<void>((r) => setImmediate(r))

describe('HubAsParticipant', () => {
  it('outer hub dispatches by capability into inner hub via the adapter', async () => {
    const inner = Hub.inMemory()
    const outer = Hub.inMemory()
    await Promise.all([inner.start(), outer.start()])

    inner.register(new EchoAgent('inner-writer', ['draft']))

    const wrapper = new HubAsParticipant({ id: 'peer-inner', inner })
    outer.register(wrapper)

    const result = await outer.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: { topic: 'mesh' },
    })

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      // The outer hub sees the wrapper as the responding participant.
      expect(result.by).toBe('peer-inner')
      // Payload is whatever the inner agent produced.
      expect(result.output).toMatchObject({ echoedFrom: 'inner-writer' })
    }

    await outer.stop()
    await inner.stop()
  })

  it('capabilities getter reflects inner hub mutations live', async () => {
    const inner = Hub.inMemory()
    await inner.start()

    const wrapper = new HubAsParticipant({ id: 'peer', inner })
    expect(wrapper.capabilities).toEqual([])

    inner.register(new EchoAgent('a', ['x', 'y']))
    expect([...wrapper.capabilities].sort()).toEqual(['x', 'y'])

    inner.register(new EchoAgent('b', ['y', 'z']))
    expect([...wrapper.capabilities].sort()).toEqual(['x', 'y', 'z'])

    inner.unregister('a')
    expect([...wrapper.capabilities].sort()).toEqual(['y', 'z'])

    await inner.stop()
  })

  it('result.taskId is relabelled to the outer task id', async () => {
    const inner = Hub.inMemory()
    const outer = Hub.inMemory()
    await Promise.all([inner.start(), outer.start()])

    inner.register(new EchoAgent('inner-a', ['cap']))
    outer.register(new HubAsParticipant({ id: 'peer', inner }))

    const result = await outer.dispatch({
      from: 'system',
      // Route via the wrapper using capability; inner has the agent
      // that owns 'cap'. (Explicit `to: 'peer'` would forward the
      // strategy verbatim and inner would no_participant — covered by
      // the next test.)
      strategy: { kind: 'capability', capabilities: ['cap'] },
      payload: {},
    })

    // The outer hub's transcript records a task with id X. The inner hub
    // generated its own id Y internally. The relabel guarantees the
    // outer hub gets X back so it can correlate.
    expect(result.kind).toBe('ok')
    const outerTask = outer.transcript
      .all()
      .find((e) => e.kind === 'task')
    expect(outerTask).toBeDefined()
    if (outerTask?.kind === 'task') {
      expect(result.taskId).toBe(outerTask.data.id)
    }

    await outer.stop()
    await inner.stop()
  })

  it('relabels failure results as well', async () => {
    const inner = Hub.inMemory()
    const outer = Hub.inMemory()
    await Promise.all([inner.start(), outer.start()])

    inner.register(new FailAgent('inner-fail', ['boom']))
    outer.register(new HubAsParticipant({ id: 'peer', inner }))

    const result = await outer.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['boom'] },
      payload: {},
    })

    expect(result.kind).toBe('failed')
    const outerTask = outer.transcript
      .all()
      .find((e) => e.kind === 'task')
    if (outerTask?.kind === 'task' && result.kind === 'failed') {
      expect(result.taskId).toBe(outerTask.data.id)
      expect(result.error).toMatch(/intentional failure/)
    }

    await outer.stop()
    await inner.stop()
  })

  it('relabels no_participant when inner hub has no capability match', async () => {
    const inner = Hub.inMemory()
    const outer = Hub.inMemory()
    await Promise.all([inner.start(), outer.start()])

    // inner registers an agent with capability 'y' — but the wrapper
    // declares 'y' in its capabilities (live getter), so outer's
    // capability-dispatch to 'y' reaches the wrapper. Inside, inner
    // dispatches by capability 'z' (which the inner agent does NOT have)
    // — but we test via explicit dispatch from outer to a ghost id
    // INSIDE inner: outer routes to wrapper, wrapper forwards strategy
    // verbatim, inner returns no_participant.
    inner.register(new EchoAgent('only-y', ['y']))
    outer.register(new HubAsParticipant({ id: 'peer', inner }))

    const result = await outer.dispatch({
      from: 'system',
      strategy: { kind: 'explicit', to: 'peer' }, // routes to wrapper
      // wrapper's onTask hands task verbatim to inner.dispatch — strategy
      // says "to: 'peer'" which inner does NOT have; inner returns
      // no_participant. The wrapper relabels it.
      payload: {},
    })

    expect(result.kind).toBe('no_participant')
    const outerTask = outer.transcript
      .all()
      .find((e) => e.kind === 'task')
    if (outerTask?.kind === 'task' && result.kind === 'no_participant') {
      expect(result.taskId).toBe(outerTask.data.id)
    }

    await outer.stop()
    await inner.stop()
  })

  it('onMessage forwards to inner hub publish so inner subscribers receive', async () => {
    const inner = Hub.inMemory()
    const outer = Hub.inMemory()
    await Promise.all([inner.start(), outer.start()])

    const received: Message[] = []
    class Listener extends AgentParticipant {
      protected async handleTask(): Promise<unknown> {
        return {}
      }
      protected handleMessage(msg: Message): void {
        received.push(msg)
      }
    }
    const listener = new Listener({ id: 'inner-listener' })
    inner.register(listener)
    inner.subscribe('inner-listener', 'announcements')

    const wrapper = new HubAsParticipant({ id: 'peer', inner })
    outer.register(wrapper)
    // Subscribe wrapper to the outer channel; outer publish -> wrapper.onMessage
    outer.subscribe('peer', 'announcements')

    outer.publish({
      from: 'system',
      channel: 'announcements',
      body: { hello: 'mesh' },
    })

    await flush()
    await flush()

    expect(received.length).toBeGreaterThanOrEqual(1)
    expect(received[0].channel).toBe('announcements')
    expect(received[0].body).toMatchObject({ hello: 'mesh' })

    await outer.stop()
    await inner.stop()
  })

  it('two layers of nesting work: outer -> middle wrapper -> inner agent', async () => {
    // Verifies that wrappers compose: a Hub registered as participant in
    // another Hub, which is itself registered in a third Hub.
    const inner = Hub.inMemory()
    const middle = Hub.inMemory()
    const outer = Hub.inMemory()
    await Promise.all([inner.start(), middle.start(), outer.start()])

    inner.register(new EchoAgent('deep', ['multilayer']))
    middle.register(new HubAsParticipant({ id: 'inner-peer', inner }))
    outer.register(new HubAsParticipant({ id: 'middle-peer', inner: middle }))

    const result = await outer.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['multilayer'] },
      payload: { depth: 3 },
    })

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('middle-peer')
      expect(result.output).toMatchObject({ echoedFrom: 'deep' })
    }

    await outer.stop()
    await middle.stop()
    await inner.stop()
  })
})
