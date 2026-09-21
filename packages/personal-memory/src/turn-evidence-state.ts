import { createHash } from 'node:crypto'
import type { Task } from '@gotong/core'
import { extractUserText } from './capture.js'
import { temporalOf, type TurnTime } from './temporal.js'

const KEY = '__memoryTurn'

/** Binding only, never a second persisted copy of the user's plaintext. */
function binding(task: Task, agent: string, scope?: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify([
    task.id, task.from, agent, scope?.userId ?? null, scope?.user ?? null, extractUserText(task),
  ])).digest('hex')
}

export function saveTurnTime(state: Record<string, unknown>, task: Task, agent: string,
  scope: Record<string, unknown> | undefined, temporal: TurnTime): Record<string, unknown> {
  return { ...state, [KEY]: { binding: binding(task, agent, scope), temporal } }
}

/** Called only on server-persisted suspend state, never model tool arguments. */
export function loadTurnTime(state: unknown, task: Task, agent: string,
  scope?: Record<string, unknown>): TurnTime | undefined {
  if (!state || typeof state !== 'object') return undefined
  const saved = (state as Record<string, unknown>)[KEY]
  if (!saved || typeof saved !== 'object') return undefined
  const record = saved as Record<string, unknown>
  if (record.binding !== binding(task, agent, scope)) return undefined
  return temporalOf({ meta: { temporal: record.temporal } })
}
