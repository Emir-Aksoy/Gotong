import { describe, expect, it } from 'vitest'

import {
  isLiveState,
  legalActions,
  transition,
  WorkflowLifecycleError,
  type LifecycleAction,
  type LifecycleRecord,
  type LifecycleState,
} from '../src/lifecycle.js'

/** A minimal record in `state`, with an empty history and one revision. */
function rec(state: LifecycleState, over: Partial<LifecycleRecord> = {}): LifecycleRecord {
  return {
    workflowId: 'wf',
    state,
    currentRevision: 1,
    headRevision: 1,
    triggerCapability: 'run-wf',
    revisions: [{ revision: 1, contentHash: 'h', createdAt: 0, origin: 'import' }],
    history: [],
    updatedAt: 0,
    ...over,
  }
}

// The full legal table, mirrored from the implementation so the test is an
// independent spec (not a tautology against the same const).
const LEGAL: Array<[LifecycleState, LifecycleAction, LifecycleState]> = [
  ['draft', 'submitReview', 'review'],
  ['draft', 'publish', 'published'],
  ['review', 'publish', 'published'],
  ['review', 'backToDraft', 'draft'],
  ['published', 'publish', 'published'],
  ['published', 'deprecate', 'deprecated'],
  ['published', 'rollback', 'published'],
  ['deprecated', 'publish', 'published'],
  ['deprecated', 'archive', 'archived'],
]

const ALL_STATES: LifecycleState[] = ['draft', 'review', 'published', 'deprecated', 'archived']
const ALL_ACTIONS: LifecycleAction[] = [
  'submitReview',
  'publish',
  'backToDraft',
  'deprecate',
  'rollback',
  'archive',
]

describe('transition — legal moves', () => {
  for (const [from, action, to] of LEGAL) {
    it(`${from} --${action}--> ${to}`, () => {
      const input = action === 'rollback' ? { at: 100, targetRevision: 1 } : { at: 100 }
      const next = transition(rec(from), action, input)
      expect(next.state).toBe(to)
      expect(next.updatedAt).toBe(100)
      // One audit entry appended, with the right shape.
      expect(next.history).toHaveLength(1)
      expect(next.history[0]).toMatchObject({ at: 100, action, from, to })
    })
  }
})

describe('transition — illegal moves throw', () => {
  const legalSet = new Set(LEGAL.map(([s, a]) => `${s}:${a}`))
  for (const from of ALL_STATES) {
    for (const action of ALL_ACTIONS) {
      if (legalSet.has(`${from}:${action}`)) continue
      it(`${from} --${action}--> ✗ illegal_transition`, () => {
        try {
          transition(rec(from), action, { at: 1, targetRevision: 1 })
          throw new Error('expected transition to throw')
        } catch (err) {
          expect(err).toBeInstanceOf(WorkflowLifecycleError)
          expect((err as WorkflowLifecycleError).code).toBe('illegal_transition')
        }
      })
    }
  }
})

describe('transition — archived is terminal', () => {
  for (const action of ALL_ACTIONS) {
    it(`archived rejects '${action}'`, () => {
      expect(() => transition(rec('archived'), action, { at: 1, targetRevision: 1 })).toThrow(
        WorkflowLifecycleError,
      )
    })
  }
})

describe('transition — rollback specifics', () => {
  it('requires a targetRevision', () => {
    try {
      transition(rec('published'), 'rollback', { at: 1 })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowLifecycleError)
      expect((err as WorkflowLifecycleError).code).toBe('rollback_target_required')
    }
  })

  it('records the target revision in the audit log', () => {
    const next = transition(rec('published', { headRevision: 5, currentRevision: 5 }), 'rollback', {
      at: 200,
      by: 'admin-1',
      targetRevision: 2,
    })
    expect(next.state).toBe('published')
    expect(next.history[0]).toMatchObject({ action: 'rollback', targetRevision: 2, by: 'admin-1' })
  })
})

describe('transition — purity', () => {
  it('does not mutate the input record', () => {
    const before = rec('draft')
    const snapshot = JSON.stringify(before)
    transition(before, 'publish', { at: 9 })
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('does not touch revision pointers (the service layer owns those)', () => {
    const before = rec('published', { currentRevision: 3, headRevision: 3 })
    const next = transition(before, 'deprecate', { at: 1 })
    expect(next.currentRevision).toBe(3)
    expect(next.headRevision).toBe(3)
    expect(next.revisions).toBe(before.revisions)
  })

  it('appends to history rather than replacing it', () => {
    const seeded = rec('draft', {
      history: [{ at: 1, action: 'backToDraft', from: 'review', to: 'draft' }],
    })
    const next = transition(seeded, 'submitReview', { at: 2 })
    expect(next.history).toHaveLength(2)
    expect(next.history[0]!.at).toBe(1)
    expect(next.history[1]).toMatchObject({ at: 2, action: 'submitReview' })
  })
})

describe('isLiveState', () => {
  it('published and deprecated are live; others are not', () => {
    expect(isLiveState('published')).toBe(true)
    expect(isLiveState('deprecated')).toBe(true)
    expect(isLiveState('draft')).toBe(false)
    expect(isLiveState('review')).toBe(false)
    expect(isLiveState('archived')).toBe(false)
  })
})

describe('legalActions', () => {
  it('returns the actions legal from each state', () => {
    expect(new Set(legalActions('draft'))).toEqual(new Set(['submitReview', 'publish']))
    expect(new Set(legalActions('review'))).toEqual(new Set(['publish', 'backToDraft']))
    expect(new Set(legalActions('published'))).toEqual(
      new Set(['publish', 'deprecate', 'rollback']),
    )
    expect(new Set(legalActions('deprecated'))).toEqual(new Set(['publish', 'archive']))
    expect(legalActions('archived')).toEqual([])
  })
})
