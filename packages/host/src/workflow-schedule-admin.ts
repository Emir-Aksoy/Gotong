/**
 * workflow-schedule-admin.ts — LIFE-L1-M3: the admin CRUD surface over the two
 * schedule files, injected into web's duck-typed `WorkflowScheduleAdminSurface`
 * (web declares the shape, host satisfies it — SURFACE-PATTERN, zero web→host
 * runtime dependency).
 *
 * Ownership split, on purpose:
 *   - CRUD here touches ONLY the intent file (`workflow-schedules.json`), plus
 *     one best-effort state-key drop on remove. The DISPATCH path (manual fire)
 *     stays on the sweeper's `fireNow` — there is exactly one way a schedule
 *     reaches the hub.
 *   - Rows the admin API did not write are round-tripped verbatim: a hand-edited
 *     draft row that doesn't normalise yet survives every upsert/remove of OTHER
 *     rows (it surfaces in `list` as `valid: false` instead of being destroyed).
 *
 * Writes are last-write-wins on a small JSON array — the admin surface is a
 * single-operator console, not a concurrent store. The sweeper only READS the
 * intent file, so CRUD never races the sweep's own writes (those go to the
 * state file; the one benign overlap is documented on `fireNow`).
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { Logger } from '@aipehub/core'

import {
  normalizeWorkflowSchedule,
  type ScheduleCadence,
} from './workflow-schedule-core.js'
import {
  readScheduleFileRaw,
  readScheduleState,
  writeScheduleState,
  WORKFLOW_SCHEDULES_FILE,
  type ScheduleFireResult,
  type WorkflowScheduleSweeper,
} from './workflow-schedule-sweeper.js'

/** One schedule as the admin UI sees it — intent + the fact-file mark beside it.
 *  `valid: false` rows are shown (with whatever ids they carry) but never run. */
export interface WorkflowScheduleView {
  id: string
  workflowId: string
  userId: string
  cadence: ScheduleCadence | null
  inputs?: Record<string, unknown>
  enabled: boolean
  valid: boolean
  lastFiredMark?: string
}

export type WorkflowScheduleUpsertResult =
  | { ok: true; schedule: WorkflowScheduleView }
  | { ok: false; error: 'invalid_schedule' }

export interface WorkflowScheduleAdminService {
  list(): Promise<WorkflowScheduleView[]>
  upsert(raw: unknown): Promise<WorkflowScheduleUpsertResult>
  remove(id: string): Promise<boolean>
  fire(id: string): Promise<ScheduleFireResult>
}

function rawId(row: unknown): string | undefined {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined
  const id = (row as { id?: unknown }).id
  return typeof id === 'string' && id.trim().length > 0 ? id : undefined
}

/** Best-effort view of a row that failed normalisation — shown, never run. */
function invalidView(row: unknown, mark: string | undefined): WorkflowScheduleView {
  const r = row && typeof row === 'object' && !Array.isArray(row) ? (row as Record<string, unknown>) : {}
  return {
    id: typeof r.id === 'string' ? r.id : '',
    workflowId: typeof r.workflowId === 'string' ? r.workflowId : '',
    userId: typeof r.userId === 'string' ? r.userId : '',
    cadence: null,
    enabled: false,
    valid: false,
    ...(mark !== undefined ? { lastFiredMark: mark } : {}),
  }
}

export function createWorkflowScheduleAdminSurface(opts: {
  spaceDir: string
  sweeper: WorkflowScheduleSweeper
  logger: Logger
}): WorkflowScheduleAdminService {
  const { spaceDir, sweeper, logger } = opts

  async function writeIntent(rows: unknown[]): Promise<void> {
    await writeFile(
      join(spaceDir, WORKFLOW_SCHEDULES_FILE),
      JSON.stringify(rows, null, 2),
      'utf8',
    )
  }

  return {
    async list() {
      const [{ rows }, state] = await Promise.all([
        readScheduleFileRaw(spaceDir),
        readScheduleState(spaceDir),
      ])
      return rows.map((row) => {
        const mark = (() => {
          const id = rawId(row)
          return id !== undefined ? state[id] : undefined
        })()
        const def = normalizeWorkflowSchedule(row)
        if (!def) return invalidView(row, mark)
        return {
          id: def.id,
          workflowId: def.workflowId,
          userId: def.userId,
          cadence: def.cadence,
          ...(def.inputs ? { inputs: def.inputs } : {}),
          enabled: def.enabled,
          valid: true,
          ...(mark !== undefined ? { lastFiredMark: mark } : {}),
        }
      })
    },

    async upsert(raw) {
      // Mint an id before normalising (normalise refuses empty ids), then store
      // the NORMALISED row — the file stays self-documenting (tz default filled,
      // interval floor applied) instead of echoing whatever the caller sent.
      const base =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {}
      const id = rawId(base) ?? `sched-${randomUUID().slice(0, 8)}`
      const def = normalizeWorkflowSchedule({ ...base, id })
      if (!def) return { ok: false, error: 'invalid_schedule' }
      const { rows } = await readScheduleFileRaw(spaceDir)
      const idx = rows.findIndex((r) => rawId(r) === id)
      if (idx >= 0) rows[idx] = def
      else rows.push(def)
      await writeIntent(rows)
      logger.info('workflow-schedule upserted', { scheduleId: def.id, workflowId: def.workflowId })
      return {
        ok: true,
        schedule: {
          id: def.id,
          workflowId: def.workflowId,
          userId: def.userId,
          cadence: def.cadence,
          ...(def.inputs ? { inputs: def.inputs } : {}),
          enabled: def.enabled,
          valid: true,
        },
      }
    },

    async remove(id) {
      const { rows } = await readScheduleFileRaw(spaceDir)
      const kept = rows.filter((r) => rawId(r) !== id)
      if (kept.length === rows.length) return false
      await writeIntent(kept)
      // Drop the orphan mark so re-creating the same id later starts fresh
      // (best-effort — losing this write costs nothing but a stale key).
      const state = await readScheduleState(spaceDir)
      if (id in state) {
        delete state[id]
        await writeScheduleState(spaceDir, state, logger)
      }
      logger.info('workflow-schedule removed', { scheduleId: id })
      return true
    },

    fire(id) {
      return sweeper.fireNow(id)
    },
  }
}
