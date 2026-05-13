import { describe, expect, it, vi } from 'vitest'

import { Hub } from '../src/hub.js'
import { AgentParticipant } from '../src/participants/agent.js'
import { HumanParticipant } from '../src/participants/human.js'
import type { Task, TranscriptEntry } from '../src/types.js'

const flush = () => new Promise<void>((r) => setImmediate(r))

class EchoAgent extends AgentParticipant {
  constructor(id: string, capabilities: readonly string[]) {
    super({ id, capabilities })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    return { echoedFrom: this.id, payload: task.payload }
  }
}

describe('Hub (end-to-end)', () => {
  it('capability dispatch reaches the right agent; transcript has task then task_result', async () => {
    const hub = new Hub()
    await hub.start()
    hub.register(new EchoAgent('writer', ['draft']))
    hub.register(new EchoAgent('reviewer', ['review']))

    const result = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['review'] },
      payload: { topic: 'ts' },
    })

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('reviewer')
      expect(result.output).toMatchObject({ echoedFrom: 'reviewer' })
    }

    const kinds = hub.transcript.all().map((e) => e.kind)
    const lastTwo = kinds.slice(-2)
    expect(lastTwo).toEqual(['task', 'task_result'])
    await hub.stop()
  })

  it('explicit dispatch to a nonexistent id returns no_participant', async () => {
    const hub = new Hub()
    await hub.start()
    const result = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'explicit', to: 'ghost' },
      payload: {},
    })
    expect(result.kind).toBe('no_participant')
    await hub.stop()
  })

  it('register / unregister produce participant_joined / participant_left entries', async () => {
    const hub = new Hub()
    await hub.start()
    const a = new EchoAgent('a', [])
    hub.register(a)
    const back = hub.unregister('a')
    expect(back).toBe(a)

    const kinds = hub.transcript.all().map((e) => e.kind)
    expect(kinds).toContain('participant_joined')
    expect(kinds).toContain('participant_left')
    const joinIdx = kinds.indexOf('participant_joined')
    const leaveIdx = kinds.indexOf('participant_left')
    expect(joinIdx).toBeLessThan(leaveIdx)
    await hub.stop()
  })

  it('publish reaches subscribers but not the sender', async () => {
    const hub = new Hub()
    await hub.start()
    const onAlice = vi.fn()
    const onBob = vi.fn()
    class Listener extends AgentParticipant {
      constructor(id: string, private readonly cb: (m: unknown) => void) {
        super({ id })
      }
      protected async handleTask(): Promise<unknown> {
        return null
      }
      protected handleMessage(msg: unknown): void {
        this.cb(msg)
      }
    }
    hub.register(new Listener('alice', onAlice))
    hub.register(new Listener('bob', onBob))
    hub.subscribe('alice', '#general')
    hub.subscribe('bob', '#general')

    hub.publish({ from: 'alice', channel: '#general', body: 'hello' })
    await flush()
    expect(onAlice).not.toHaveBeenCalled()
    expect(onBob).toHaveBeenCalledTimes(1)
    await hub.stop()
  })

  it('onEvent fires for every transcript entry', async () => {
    const hub = new Hub()
    await hub.start()
    const events: TranscriptEntry[] = []
    const off = hub.onEvent((e) => events.push(e))

    hub.register(new EchoAgent('a', ['x']))
    const human = new HumanParticipant({ id: 'h' })
    hub.register(human)

    await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['x'] },
      payload: {},
    })

    // sanity: the seqs should be monotonically increasing 1..n
    expect(events.map((e) => e.seq)).toEqual(
      events.map((_, i) => i + 1),
    )
    // expected kinds: join, join, task, task_result
    const kinds = events.map((e) => e.kind)
    expect(kinds).toEqual([
      'participant_joined',
      'participant_joined',
      'task',
      'task_result',
    ])

    off()
    const before = events.length
    hub.unregister('a')
    expect(events.length).toBe(before) // unsubscribed
    await hub.stop()
  })
})
