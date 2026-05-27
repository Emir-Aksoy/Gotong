/**
 * Phase 11 M2 — suspended_tasks CRUD coverage.
 *
 * Coverage:
 *   - persistSuspendedTask: insert + read-back / replace on duplicate
 *     taskId / `state` null vs undefined / boundary validation
 *   - getSuspendedTask: absent → null / present → typed record
 *   - listDueSuspendedTasks: only rows with resume_at <= now, ordered
 *     ASC, bounded by limit / empty result when nothing's due / now &
 *     limit guard
 *   - removeSuspendedTask: 1 on hit / 0 on miss / empty taskId guard
 *   - listSuspendedTasksByAgent: filter + order
 *   - state JSON round-trip: undefined → null persisted / object →
 *     deep-equal restored / null → null
 *
 * All tests use `:memory:` SQLite — no disk side effects.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IdentityError, IdentityStore, openIdentityStore } from '../src/index.js'

describe('IdentityStore — suspended_tasks (Phase 11 M2)', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:' })
  })

  afterEach(() => {
    store.close()
  })

  // --- persist + read-back ---------------------------------------------------

  it('persists a row and reads it back', () => {
    store.persistSuspendedTask({
      taskId: 't1',
      agentId: 'a1',
      hubId: 'hub-A',
      originUserId: 'u1',
      resumeAt: 10_000,
      state: { step: 'awaiting-rss' },
      taskJson: '{"id":"t1"}',
    })
    const got = store.getSuspendedTask('t1')
    expect(got).not.toBeNull()
    expect(got!.taskId).toBe('t1')
    expect(got!.agentId).toBe('a1')
    expect(got!.hubId).toBe('hub-A')
    expect(got!.originUserId).toBe('u1')
    expect(got!.resumeAt).toBe(10_000)
    expect(got!.state).toEqual({ step: 'awaiting-rss' })
    expect(got!.taskJson).toBe('{"id":"t1"}')
    expect(got!.createdAt).toBeTypeOf('number')
  })

  it('returns null for an absent taskId', () => {
    expect(store.getSuspendedTask('missing')).toBeNull()
  })

  it('hubId / originUserId omitted → persisted as null', () => {
    store.persistSuspendedTask({
      taskId: 't2',
      agentId: 'a',
      resumeAt: 1,
      state: null,
      taskJson: '{}',
    })
    const got = store.getSuspendedTask('t2')!
    expect(got.hubId).toBeNull()
    expect(got.originUserId).toBeNull()
    expect(got.state).toBeNull()
  })

  it('state undefined → persisted as null (single sentinel for absent)', () => {
    store.persistSuspendedTask({
      taskId: 't3',
      agentId: 'a',
      resumeAt: 1,
      state: undefined,
      taskJson: '{}',
    })
    expect(store.getSuspendedTask('t3')!.state).toBeNull()
  })

  it('state with nested objects round-trips JSON faithfully', () => {
    const state = {
      step: 'mid',
      ctx: { history: [1, 2, 3], flags: { ok: true, n: null } },
    }
    store.persistSuspendedTask({
      taskId: 't4',
      agentId: 'a',
      resumeAt: 1,
      state,
      taskJson: '{}',
    })
    expect(store.getSuspendedTask('t4')!.state).toEqual(state)
  })

  it('INSERT OR REPLACE — re-persisting same taskId overwrites', () => {
    store.persistSuspendedTask({
      taskId: 't5',
      agentId: 'a',
      resumeAt: 100,
      state: { round: 1 },
      taskJson: '{}',
    })
    store.persistSuspendedTask({
      taskId: 't5',
      agentId: 'a',
      resumeAt: 200, // bumped
      state: { round: 2 },
      taskJson: '{}',
    })
    const got = store.getSuspendedTask('t5')!
    expect(got.resumeAt).toBe(200)
    expect(got.state).toEqual({ round: 2 })
  })

  // --- input validation ------------------------------------------------------

  it('persistSuspendedTask: rejects empty taskId', () => {
    expect(() =>
      store.persistSuspendedTask({
        taskId: '',
        agentId: 'a',
        resumeAt: 1,
        state: null,
        taskJson: '{}',
      }),
    ).toThrow(IdentityError)
  })

  it('persistSuspendedTask: rejects empty agentId', () => {
    expect(() =>
      store.persistSuspendedTask({
        taskId: 't',
        agentId: '',
        resumeAt: 1,
        state: null,
        taskJson: '{}',
      }),
    ).toThrow(IdentityError)
  })

  it('persistSuspendedTask: rejects non-finite resumeAt', () => {
    expect(() =>
      store.persistSuspendedTask({
        taskId: 't',
        agentId: 'a',
        resumeAt: NaN,
        state: null,
        taskJson: '{}',
      }),
    ).toThrow(IdentityError)
  })

  it('persistSuspendedTask: rejects non-string taskJson', () => {
    expect(() =>
      store.persistSuspendedTask({
        taskId: 't',
        agentId: 'a',
        resumeAt: 1,
        state: null,
        // @ts-expect-error — invalid type intentional
        taskJson: { id: 't' },
      }),
    ).toThrow(IdentityError)
  })

  // --- listDueSuspendedTasks -------------------------------------------------

  it('lists only rows with resume_at <= now, ordered ASC', () => {
    store.persistSuspendedTask({
      taskId: 't-soon',
      agentId: 'a',
      resumeAt: 5,
      state: null,
      taskJson: '{}',
    })
    store.persistSuspendedTask({
      taskId: 't-now',
      agentId: 'a',
      resumeAt: 10,
      state: null,
      taskJson: '{}',
    })
    store.persistSuspendedTask({
      taskId: 't-later',
      agentId: 'a',
      resumeAt: 1_000_000,
      state: null,
      taskJson: '{}',
    })
    const due = store.listDueSuspendedTasks({ now: 10 })
    expect(due.map((r) => r.taskId)).toEqual(['t-soon', 't-now'])
  })

  it('empty result when nothing is due', () => {
    store.persistSuspendedTask({
      taskId: 't',
      agentId: 'a',
      resumeAt: 1_000_000,
      state: null,
      taskJson: '{}',
    })
    expect(store.listDueSuspendedTasks({ now: 1 })).toEqual([])
  })

  it('limit bounds returned rows', () => {
    for (let i = 0; i < 5; i++) {
      store.persistSuspendedTask({
        taskId: `t-${i}`,
        agentId: 'a',
        resumeAt: i,
        state: null,
        taskJson: '{}',
      })
    }
    const got = store.listDueSuspendedTasks({ now: 100, limit: 3 })
    expect(got.map((r) => r.taskId)).toEqual(['t-0', 't-1', 't-2'])
  })

  it('listDueSuspendedTasks: rejects non-finite now / negative limit', () => {
    expect(() => store.listDueSuspendedTasks({ now: NaN })).toThrow(IdentityError)
    expect(() => store.listDueSuspendedTasks({ limit: -1 })).toThrow(IdentityError)
  })

  // --- removeSuspendedTask ---------------------------------------------------

  it('removeSuspendedTask returns 1 on hit, 0 on miss', () => {
    store.persistSuspendedTask({
      taskId: 't-rm',
      agentId: 'a',
      resumeAt: 1,
      state: null,
      taskJson: '{}',
    })
    expect(store.removeSuspendedTask('t-rm')).toBe(1)
    expect(store.getSuspendedTask('t-rm')).toBeNull()
    expect(store.removeSuspendedTask('t-rm')).toBe(0)
    expect(store.removeSuspendedTask('never-existed')).toBe(0)
  })

  it('removeSuspendedTask: rejects empty taskId', () => {
    expect(() => store.removeSuspendedTask('')).toThrow(IdentityError)
  })

  // --- listSuspendedTasksByAgent ---------------------------------------------

  it('lists by agent, ordered by resume_at ASC', () => {
    store.persistSuspendedTask({
      taskId: 'a-1',
      agentId: 'a',
      resumeAt: 200,
      state: null,
      taskJson: '{}',
    })
    store.persistSuspendedTask({
      taskId: 'a-2',
      agentId: 'a',
      resumeAt: 100,
      state: null,
      taskJson: '{}',
    })
    store.persistSuspendedTask({
      taskId: 'b-1',
      agentId: 'b',
      resumeAt: 50,
      state: null,
      taskJson: '{}',
    })
    expect(store.listSuspendedTasksByAgent('a').map((r) => r.taskId)).toEqual([
      'a-2',
      'a-1',
    ])
    expect(store.listSuspendedTasksByAgent('b').map((r) => r.taskId)).toEqual([
      'b-1',
    ])
    expect(store.listSuspendedTasksByAgent('nobody')).toEqual([])
    expect(store.listSuspendedTasksByAgent('')).toEqual([])
  })

  // --- survives close + reopen (migration sanity) ---------------------------

  it('schema migration applied on a fresh DB lets persist work', () => {
    // openIdentityStore already ran migrations in beforeEach; if v=9
    // ever regressed, the persist call would error with "no such
    // table". This test pins that behaviour.
    expect(() =>
      store.persistSuspendedTask({
        taskId: 't-mig',
        agentId: 'a',
        resumeAt: 1,
        state: null,
        taskJson: '{}',
      }),
    ).not.toThrow()
  })
})
