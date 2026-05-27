/**
 * Phase 11 M2 — DefaultScheduler suspend-aware runOne path.
 *
 * Validates the scheduler's behaviour when a participant throws
 * `SuspendTaskError`:
 *
 *   1. Explicit dispatch — calls notifySuspend, returns 'suspended'.
 *   2. Capability dispatch — same path.
 *   3. Broadcast dispatch — does NOT call notifySuspend; treats
 *      the candidate as a failure and lets the other candidates race.
 *   4. notifySuspend rejection — degrades to 'failed' (no ghost
 *      task left on the worker / no terminal-result ambiguity).
 *   5. notifySuspend unset — still returns 'suspended', just not
 *      durable.
 *   6. Plain (non-suspend) errors still go through the regular
 *      failed path untouched.
 *   7. Worker slot is released regardless (incLoad/decLoad invariant).
 */
import { describe, expect, it, vi } from 'vitest'

import { Hub } from '../src/hub.js'
import { AgentParticipant } from '../src/participants/agent.js'
import { SuspendTaskError } from '../src/suspend.js'
import type { ParticipantId, Task } from '../src/types.js'

class SuspendingAgent extends AgentParticipant {
  constructor(
    id: string,
    caps: readonly string[],
    private readonly resumeAt: number,
    private readonly state: unknown,
  ) {
    super({ id, capabilities: caps })
  }
  protected async handleTask(_t: Task): Promise<unknown> {
    throw new SuspendTaskError({ resumeAt: this.resumeAt, state: this.state })
  }
}

class ThrowingAgent extends AgentParticipant {
  constructor(id: string, caps: readonly string[]) {
    super({ id, capabilities: caps })
  }
  protected async handleTask(_t: Task): Promise<unknown> {
    throw new Error('plain failure')
  }
}

class EchoAgent extends AgentParticipant {
  constructor(
    id: string,
    caps: readonly string[],
    private readonly reply: unknown = { ok: true },
  ) {
    super({ id, capabilities: caps })
  }
  protected async handleTask(_t: Task): Promise<unknown> {
    return this.reply
  }
}

describe('scheduler suspend path — explicit dispatch', () => {
  it('returns kind=suspended and invokes notifySuspend with task + by + payload', async () => {
    const notifySuspend = vi.fn().mockResolvedValue(undefined)
    const hub = Hub.inMemory({ suspendNotifier: notifySuspend })
    await hub.start()
    hub.register(new SuspendingAgent('napper', ['nap'], 12345, { step: 'wait' }))

    const res = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'explicit', to: 'napper' as ParticipantId },
      payload: { hello: 'world' },
    })

    expect(res.kind).toBe('suspended')
    if (res.kind === 'suspended') {
      expect(res.by).toBe('napper')
      expect(res.resumeAt).toBe(12345)
    }
    expect(notifySuspend).toHaveBeenCalledTimes(1)
    const args = notifySuspend.mock.calls[0]!
    expect(args[1]).toBe('napper')
    expect(args[2]).toEqual({ resumeAt: 12345, state: { step: 'wait' } })
    // Worker slot must be released even on the suspend path.
    expect(hub.registry.loadOf('napper' as ParticipantId)).toBe(0)
    await hub.stop()
  })

  it('degrades to failed when notifySuspend rejects', async () => {
    const notifySuspend = vi.fn().mockRejectedValue(new Error('sqlite locked'))
    const hub = Hub.inMemory({ suspendNotifier: notifySuspend })
    await hub.start()
    hub.register(new SuspendingAgent('napper', ['nap'], 999, null))

    const res = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'explicit', to: 'napper' as ParticipantId },
      payload: null,
    })

    expect(res.kind).toBe('failed')
    if (res.kind === 'failed') {
      expect(res.error).toMatch(/suspend persist failed: sqlite locked/)
    }
    expect(hub.registry.loadOf('napper' as ParticipantId)).toBe(0)
    await hub.stop()
  })

  it('returns suspended even without notifySuspend wired (non-durable mode)', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new SuspendingAgent('napper', ['nap'], 42, { x: 1 }))

    const res = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'explicit', to: 'napper' as ParticipantId },
      payload: null,
    })

    expect(res.kind).toBe('suspended')
    if (res.kind === 'suspended') {
      expect(res.resumeAt).toBe(42)
    }
    await hub.stop()
  })
})

describe('scheduler suspend path — capability dispatch', () => {
  it('routes a suspending capability holder through the same persist path', async () => {
    const notifySuspend = vi.fn().mockResolvedValue(undefined)
    const hub = Hub.inMemory({ suspendNotifier: notifySuspend })
    await hub.start()
    hub.register(new SuspendingAgent('worker', ['heavy'], 7777, { phase: 1 }))

    const res = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['heavy'] },
      payload: null,
    })

    expect(res.kind).toBe('suspended')
    expect(notifySuspend).toHaveBeenCalledTimes(1)
    await hub.stop()
  })
})

describe('scheduler suspend path — broadcast disqualifies but does not persist', () => {
  it('treats a suspending candidate as failed; another ok candidate wins', async () => {
    const notifySuspend = vi.fn().mockResolvedValue(undefined)
    const hub = Hub.inMemory({ suspendNotifier: notifySuspend })
    await hub.start()
    hub.register(new SuspendingAgent('napper', ['claim'], 1_000, null))
    hub.register(new EchoAgent('quick', ['claim'], { winner: 'quick' }))

    const res = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'broadcast', capabilities: ['claim'] },
      payload: null,
    })

    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.by).toBe('quick')
    }
    // The whole point: broadcast must NOT persist a suspend, since
    // the task already terminated via another candidate's `ok`.
    expect(notifySuspend).not.toHaveBeenCalled()
    await hub.stop()
  })

  it('if all broadcast candidates suspend, result is failed (none persisted)', async () => {
    const notifySuspend = vi.fn().mockResolvedValue(undefined)
    const hub = Hub.inMemory({ suspendNotifier: notifySuspend })
    await hub.start()
    hub.register(new SuspendingAgent('a', ['x'], 1, null))
    hub.register(new SuspendingAgent('b', ['x'], 2, null))

    const res = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'broadcast', capabilities: ['x'] },
      payload: null,
    })

    expect(res.kind).toBe('failed')
    if (res.kind === 'failed') {
      expect(res.error).toMatch(/suspended during broadcast/)
    }
    expect(notifySuspend).not.toHaveBeenCalled()
    await hub.stop()
  })
})

describe('scheduler suspend path — plain errors still go to failed', () => {
  it('non-suspend throws do not call notifySuspend', async () => {
    const notifySuspend = vi.fn().mockResolvedValue(undefined)
    const hub = Hub.inMemory({ suspendNotifier: notifySuspend })
    await hub.start()
    hub.register(new ThrowingAgent('boomer', ['boom']))

    const res = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'explicit', to: 'boomer' as ParticipantId },
      payload: null,
    })

    expect(res.kind).toBe('failed')
    if (res.kind === 'failed') {
      expect(res.error).toBe('plain failure')
    }
    expect(notifySuspend).not.toHaveBeenCalled()
    await hub.stop()
  })
})
