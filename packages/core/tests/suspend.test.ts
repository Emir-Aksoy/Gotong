/**
 * Phase 11 M1 — SuspendTaskError + AgentParticipant resume hooks.
 *
 * Pure API-layer coverage. The scheduler integration that actually
 * parks tasks lands in Phase 11 M2; this file only validates the
 * surface user code writes against:
 *
 *   - The error class carries the right fields and is recognisable
 *     via instanceof and the cross-realm-safe `isSuspendTaskError`.
 *   - `AgentParticipant.onTask` re-throws SuspendTaskError instead of
 *     converting it to a `failed` TaskResult.
 *   - `AgentParticipant.onResume` exists, defaults to re-running
 *     `handleTask`, and routes through `handleResume` when overridden.
 *   - `handleResume` can itself throw SuspendTaskError ("suspend again").
 */
import { describe, expect, it } from 'vitest'

import { AgentParticipant } from '../src/participants/agent.js'
import { SuspendTaskError, isSuspendTaskError } from '../src/suspend.js'
import type { Task } from '../src/types.js'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    from: 'system',
    strategy: { kind: 'explicit', to: 'agent-a' },
    payload: null,
    createdAt: Date.now(),
    ...overrides,
  }
}

// --- SuspendTaskError shape --------------------------------------------------

describe('SuspendTaskError', () => {
  it('captures resumeAt and state', () => {
    const at = Date.now() + 5_000
    const e = new SuspendTaskError({ resumeAt: at, state: { step: 'await-rss' } })
    expect(e.resumeAt).toBe(at)
    expect(e.state).toEqual({ step: 'await-rss' })
  })

  it('has name = "SuspendTaskError" and an Error-ish message', () => {
    const e = new SuspendTaskError({ resumeAt: Date.now() + 1_000 })
    expect(e.name).toBe('SuspendTaskError')
    expect(e.message).toMatch(/SuspendTaskError: resume at /)
    expect(e).toBeInstanceOf(Error)
  })

  it('omitting state leaves it undefined', () => {
    const e = new SuspendTaskError({ resumeAt: Date.now() + 1_000 })
    expect(e.state).toBeUndefined()
  })

  it('is recognised by isSuspendTaskError via instanceof', () => {
    const e = new SuspendTaskError({ resumeAt: Date.now() })
    expect(isSuspendTaskError(e)).toBe(true)
  })

  it('isSuspendTaskError rejects unrelated values', () => {
    expect(isSuspendTaskError(new Error('boom'))).toBe(false)
    expect(isSuspendTaskError(null)).toBe(false)
    expect(isSuspendTaskError(undefined)).toBe(false)
    expect(isSuspendTaskError('SuspendTaskError')).toBe(false)
    expect(isSuspendTaskError({})).toBe(false)
  })

  it('isSuspendTaskError falls back to duck-typing for cross-realm copies', () => {
    // Simulate a separate-bundle copy: looks like SuspendTaskError but
    // its constructor identity differs (instanceof would return false).
    const lookalike = { name: 'SuspendTaskError', resumeAt: Date.now() + 1_000, state: null }
    expect(isSuspendTaskError(lookalike)).toBe(true)
  })

  it('isSuspendTaskError requires both name and resumeAt to duck-type', () => {
    // Name only — likely a different error type that happens to share a name.
    expect(isSuspendTaskError({ name: 'SuspendTaskError' })).toBe(false)
    // resumeAt only without name — definitely not.
    expect(isSuspendTaskError({ resumeAt: Date.now() })).toBe(false)
  })
})

// --- AgentParticipant.onTask suspend re-throw -------------------------------

describe('AgentParticipant.onTask', () => {
  it('returns ok when handleTask returns normally', async () => {
    class A extends AgentParticipant {
      protected async handleTask(_t: Task): Promise<unknown> {
        return { ran: true }
      }
    }
    const a = new A({ id: 'a' })
    const r = await a.onTask(makeTask())
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.output).toEqual({ ran: true })
    }
  })

  it('returns failed when handleTask throws a normal error', async () => {
    class A extends AgentParticipant {
      protected async handleTask(_t: Task): Promise<unknown> {
        throw new Error('boom')
      }
    }
    const a = new A({ id: 'a' })
    const r = await a.onTask(makeTask())
    expect(r.kind).toBe('failed')
    if (r.kind === 'failed') {
      expect(r.error).toBe('boom')
    }
  })

  it('re-throws SuspendTaskError instead of converting to failed', async () => {
    class A extends AgentParticipant {
      protected async handleTask(_t: Task): Promise<unknown> {
        throw new SuspendTaskError({ resumeAt: 1_000, state: { x: 1 } })
      }
    }
    const a = new A({ id: 'a' })
    await expect(a.onTask(makeTask())).rejects.toBeInstanceOf(SuspendTaskError)
  })

  it('does not lose state when re-throwing', async () => {
    class A extends AgentParticipant {
      protected async handleTask(_t: Task): Promise<unknown> {
        throw new SuspendTaskError({ resumeAt: 42, state: { hello: 'world' } })
      }
    }
    const a = new A({ id: 'a' })
    try {
      await a.onTask(makeTask())
      expect.fail('expected throw')
    } catch (e) {
      expect(isSuspendTaskError(e)).toBe(true)
      if (isSuspendTaskError(e)) {
        expect(e.resumeAt).toBe(42)
        expect(e.state).toEqual({ hello: 'world' })
      }
    }
  })
})

// --- AgentParticipant.onResume hooks ----------------------------------------

describe('AgentParticipant.onResume', () => {
  it('default handleResume falls back to handleTask, ignoring state', async () => {
    let handleTaskCalls = 0
    class A extends AgentParticipant {
      protected async handleTask(_t: Task): Promise<unknown> {
        handleTaskCalls++
        return { fresh: true }
      }
    }
    const a = new A({ id: 'a' })
    const r = await a.onResume(makeTask(), { wakeup: 'reason' })
    expect(handleTaskCalls).toBe(1)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.output).toEqual({ fresh: true })
    }
  })

  it('routes through overridden handleResume with state passthrough', async () => {
    class A extends AgentParticipant {
      protected async handleTask(_t: Task): Promise<unknown> {
        return { fresh: true }
      }
      protected override async handleResume(_t: Task, state: unknown): Promise<unknown> {
        return { resumed: true, restored: state }
      }
    }
    const a = new A({ id: 'a' })
    const r = await a.onResume(makeTask(), { step: 'mid' })
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.output).toEqual({ resumed: true, restored: { step: 'mid' } })
    }
  })

  it('returns failed when handleResume throws a normal error', async () => {
    class A extends AgentParticipant {
      protected async handleTask(_t: Task): Promise<unknown> {
        return null
      }
      protected override async handleResume(_t: Task, _state: unknown): Promise<unknown> {
        throw new Error('resume blew up')
      }
    }
    const a = new A({ id: 'a' })
    const r = await a.onResume(makeTask(), {})
    expect(r.kind).toBe('failed')
    if (r.kind === 'failed') {
      expect(r.error).toBe('resume blew up')
    }
  })

  it('re-throws SuspendTaskError from handleResume (suspend again)', async () => {
    class A extends AgentParticipant {
      protected async handleTask(_t: Task): Promise<unknown> {
        return null
      }
      protected override async handleResume(_t: Task, _state: unknown): Promise<unknown> {
        throw new SuspendTaskError({ resumeAt: 999, state: { round: 2 } })
      }
    }
    const a = new A({ id: 'a' })
    await expect(a.onResume(makeTask(), { round: 1 })).rejects.toBeInstanceOf(SuspendTaskError)
  })
})
