/**
 * `butler-router` — per-user multiplexer (BF-M2).
 *
 * The router registers as ONE chat agent but routes by `task.origin.userId` to
 * a per-user butler, lazily built (once) via an injected factory. These tests
 * drive it with a fake butler that records which userId it was built for and
 * which task ids it saw, and assert: routing by userId, memoization (one butler
 * per user), the anon bucket for origin-less tasks, no cross-user leakage, that
 * resume re-creates after a "restart", and that shutdown fans out.
 */

import type { Participant, Task, TaskResult } from '@gotong/core'
import { describe, expect, it } from 'vitest'

import { BUTLER_ANON_USER, createButlerRouter } from '../src/butler-router.js'

function task(id: string, userId?: string): Task {
  return {
    id,
    from: 'user:x',
    strategy: { kind: 'capability', capabilities: ['chat'] },
    payload: { text: 'hi' },
    ...(userId ? { origin: { orgId: 'local', userId } } : {}),
  }
}

interface FakeButler extends Participant {
  readonly forUser: string
  readonly tasks: string[]
  readonly resumes: string[]
  shutdownCalls: number
}

/** A factory that records every butler it builds + the ids each one handled. */
function fakeFactory(): { create: (userId: string) => Participant; created: FakeButler[] } {
  const created: FakeButler[] = []
  const create = (userId: string): Participant => {
    const tasks: string[] = []
    const resumes: string[] = []
    const b: FakeButler = {
      id: 'assistant',
      kind: 'agent',
      capabilities: ['chat'],
      forUser: userId,
      tasks,
      resumes,
      shutdownCalls: 0,
      async onTask(t: Task): Promise<TaskResult> {
        tasks.push(t.id)
        return { kind: 'ok', taskId: t.id, by: `butler:${userId}`, output: { text: userId }, ts: 1 }
      },
      async onResume(t: Task): Promise<TaskResult> {
        resumes.push(t.id)
        return { kind: 'ok', taskId: t.id, by: `butler:${userId}`, output: { text: `resumed ${userId}` }, ts: 1 }
      },
      async onShutdown(): Promise<void> {
        b.shutdownCalls++
      },
    }
    created.push(b)
    return b
  }
  return { create, created }
}

function okText(res: TaskResult): string {
  expect(res.kind).toBe('ok')
  return ((res as { output: { text: string } }).output).text
}

describe('butler-router — routes by origin.userId', () => {
  it('builds one butler per distinct user and routes each task to the right one', async () => {
    const { create, created } = fakeFactory()
    const router = createButlerRouter({ id: 'assistant', capabilities: ['chat'], createForUser: create })

    expect(okText(await router.onTask!(task('t1', 'alice')))).toBe('alice')
    expect(okText(await router.onTask!(task('t2', 'bob')))).toBe('bob')

    expect(router.size).toBe(2)
    expect(created.map((b) => b.forUser).sort()).toEqual(['alice', 'bob'])
    // No leakage: alice's butler saw only t1, bob's only t2.
    const alice = created.find((b) => b.forUser === 'alice')!
    const bob = created.find((b) => b.forUser === 'bob')!
    expect(alice.tasks).toEqual(['t1'])
    expect(bob.tasks).toEqual(['t2'])
  })

  it('memoizes: the same user reuses one butler across many tasks', async () => {
    const { create, created } = fakeFactory()
    const router = createButlerRouter({ id: 'assistant', capabilities: ['chat'], createForUser: create })

    await router.onTask!(task('t1', 'alice'))
    await router.onTask!(task('t2', 'alice'))
    await router.onTask!(task('t3', 'alice'))

    expect(router.size).toBe(1)
    expect(created).toHaveLength(1)
    expect(created[0]!.tasks).toEqual(['t1', 't2', 't3'])
  })

  it('buckets origin-less tasks into the anon user (and reuses it)', async () => {
    const { create, created } = fakeFactory()
    const router = createButlerRouter({ id: 'assistant', capabilities: ['chat'], createForUser: create })

    await router.onTask!(task('t1')) // no origin
    await router.onTask!(task('t2')) // no origin

    expect(router.size).toBe(1)
    expect(created[0]!.forUser).toBe(BUTLER_ANON_USER)
    expect(created[0]!.tasks).toEqual(['t1', 't2'])
  })

  it('a custom anonUserId overrides the default bucket', async () => {
    const { create, created } = fakeFactory()
    const router = createButlerRouter({
      id: 'assistant',
      capabilities: ['chat'],
      createForUser: create,
      anonUserId: '_ops',
    })
    await router.onTask!(task('t1'))
    expect(created[0]!.forUser).toBe('_ops')
  })
})

describe('butler-router — resume', () => {
  it('routes resume to the same per-user butler (re-creating after a restart)', async () => {
    const { create, created } = fakeFactory()
    const router = createButlerRouter({ id: 'assistant', capabilities: ['chat'], createForUser: create })

    // Simulate a restart: the map starts empty, a resume arrives for a user the
    // router never saw — it must build the butler and route the resume to it.
    const res = await router.onResume!(task('t1', 'alice'), { some: 'state' })
    expect(okText(res)).toBe('resumed alice')
    expect(router.size).toBe(1)
    expect(created[0]!.forUser).toBe('alice')
    expect(created[0]!.resumes).toEqual(['t1'])
    expect(created[0]!.tasks).toEqual([]) // resume did NOT call onTask
  })

  it('a resume and a later task for the same user hit ONE butler', async () => {
    const { create, created } = fakeFactory()
    const router = createButlerRouter({ id: 'assistant', capabilities: ['chat'], createForUser: create })

    await router.onTask!(task('t1', 'alice'))
    await router.onResume!(task('t1', 'alice'), {})

    expect(router.size).toBe(1)
    expect(created).toHaveLength(1)
    expect(created[0]!.tasks).toEqual(['t1'])
    expect(created[0]!.resumes).toEqual(['t1'])
  })

  it('falls back to onTask when a butler has no onResume', async () => {
    // A factory returning a participant WITHOUT onResume — the documented
    // scheduler fallback is onTask(task).
    const seen: string[] = []
    const router = createButlerRouter({
      id: 'assistant',
      capabilities: ['chat'],
      createForUser: (userId): Participant => ({
        id: 'assistant',
        kind: 'agent',
        capabilities: ['chat'],
        async onTask(t: Task): Promise<TaskResult> {
          seen.push(`task:${t.id}`)
          return { kind: 'ok', taskId: t.id, by: `b:${userId}`, output: { text: userId }, ts: 1 }
        },
      }),
    })

    const res = await router.onResume!(task('t1', 'alice'), {})
    expect(okText(res)).toBe('alice')
    expect(seen).toEqual(['task:t1'])
  })
})

describe('butler-router — lifecycle', () => {
  it('mirrors id / kind / capabilities from options', () => {
    const { create } = fakeFactory()
    const router = createButlerRouter({ id: 'assistant', capabilities: ['chat', 'help'], createForUser: create })
    expect(router.id).toBe('assistant')
    expect(router.kind).toBe('agent')
    expect(router.capabilities).toEqual(['chat', 'help'])
  })

  it('onShutdown fans out to every spawned butler', async () => {
    const { create, created } = fakeFactory()
    const router = createButlerRouter({ id: 'assistant', capabilities: ['chat'], createForUser: create })

    await router.onTask!(task('t1', 'alice'))
    await router.onTask!(task('t2', 'bob'))
    await router.onShutdown!()

    expect(created).toHaveLength(2)
    expect(created.every((b) => b.shutdownCalls === 1)).toBe(true)
  })

  it('one butler throwing in onShutdown does not block the others', async () => {
    const created: Array<{ forUser: string; shutdownCalls: number }> = []
    const router = createButlerRouter({
      id: 'assistant',
      capabilities: ['chat'],
      createForUser: (userId): Participant => {
        const rec = { forUser: userId, shutdownCalls: 0 }
        created.push(rec)
        return {
          id: 'assistant',
          kind: 'agent',
          capabilities: ['chat'],
          async onTask(t: Task): Promise<TaskResult> {
            return { kind: 'ok', taskId: t.id, by: 'b', output: { text: userId }, ts: 1 }
          },
          async onShutdown(): Promise<void> {
            rec.shutdownCalls++
            if (userId === 'alice') throw new Error('boom')
          },
        }
      },
    })

    await router.onTask!(task('t1', 'alice'))
    await router.onTask!(task('t2', 'bob'))
    await expect(router.onShutdown!()).resolves.toBeUndefined()
    expect(created.every((b) => b.shutdownCalls === 1)).toBe(true) // both ran
  })
})
