import { describe, expect, it } from 'vitest'
import type { Task } from '@gotong/core'
import { saveTurnTime, loadTurnTime } from '../src/turn-evidence-state.js'
import { observeTurnTime } from '../src/temporal.js'

describe('persisted original-turn binding', () => {
  const task = { id: 't', from: 'user:alice', payload: 'private original quote' } as Task
  const temporal = observeTurnTime(1700000000000, 'UTC')
  const scope = { userId: 'alice' }
  const state = saveTurnTime({ working: 'preserved' }, task, 'butler', scope, temporal)

  it('survives serialization without duplicating the raw quote', () => {
    expect(JSON.stringify(state)).not.toContain('private original quote')
    expect(loadTurnTime(JSON.parse(JSON.stringify(state)), task, 'butler', scope)).toEqual(temporal)
    expect(state.working).toBe('preserved')
  })
  it('refuses another task, member, agent or altered user payload', () => {
    expect(loadTurnTime(state, { ...task, id: 'other' }, 'butler', scope)).toBeUndefined()
    expect(loadTurnTime(state, { ...task, from: 'user:bob' }, 'butler', scope)).toBeUndefined()
    expect(loadTurnTime(state, { ...task, payload: 'approved' }, 'butler', scope)).toBeUndefined()
    expect(loadTurnTime(state, task, 'other-agent', scope)).toBeUndefined()
    expect(loadTurnTime(state, task, 'butler', { userId: 'bob' })).toBeUndefined()
    expect(loadTurnTime({}, task, 'butler', scope)).toBeUndefined()
  })
})
