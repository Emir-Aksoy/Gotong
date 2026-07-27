/**
 * me-panel-data.ts — SDUI C1-a. Member-facing read-only projections for the
 * panel's HUB-INTERNAL named data sources (`schedules.mine` / `tasks.mine` /
 * `status.hub`). The renderer fetches these via GET /api/me/panel/data/* and
 * the web layer pins userId from the session — this module never trusts a
 * caller-supplied id beyond passing it through `ownerDir`'s safety assert.
 *
 * Disclosure argument, per source (no new surface is invented here):
 *  - `schedules.mine` — the SEN-M4 `ButlerScheduleSurface` projection, reused
 *    as-is: rows are filtered to the exact session user; ownership already IS
 *    the disclosure boundary (the sweeper dispatches on that same userId).
 *  - `tasks.mine`     — the member's OWN task notebook (TN), read with the
 *    TN-M2 observer snapshot (missing/corrupt → [] and nothing else; the
 *    butler's turn stays the file's only writer). The free-form working
 *    `note` is deliberately NOT projected — the list needs title + progress.
 *  - `status.hub`     — the SEN-M1 patrol card face (`derivePatrolCards`, the
 *    ONE authority for red/yellow verdicts). Any member can already pull the
 *    same cards through the benign `hub_health` tool; this is the same
 *    projection over HTTP, not a wider one. Full HealthSnapshot detail
 *    (agent rows, connector inventory) structurally stays out.
 *
 * Every getter is three-state honest: surface not wired → null (the renderer
 * shows "source not enabled"), wired but empty → [], data → rows.
 */
import { join } from 'node:path'

import { readTaskNotesSnapshot } from '@gotong/personal-butler'
import { ownerDir } from '@gotong/service-memory-file'

import type { AdminHealthSurface } from './admin-health.js'
import { derivePatrolCards } from './personal-butler-patrol.js'
import type { ButlerScheduleSurface } from './personal-butler-schedules.js'

export interface MePanelDataDeps {
  /** Butler memory root (`<space>/butler/memory`) — the TN notebook lives per-user under it. */
  memoryRoot: string
  /** Lazy — main.ts assigns these refs after construction (onboarding.health 同款惯例). */
  schedules: () => ButlerScheduleSurface | undefined
  health: () => AdminHealthSurface | undefined
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }
}

export interface MePanelScheduleRow {
  workflowId: string
  cadence:
    | { kind: 'daily'; hour: number; tzOffsetMinutes: number }
    | { kind: 'weekly'; weekday: number; hour: number; tzOffsetMinutes: number }
    | { kind: 'interval'; everyMs: number }
    | null
  enabled: boolean
  valid: boolean
  lastFiredMark: string | null
}

export interface MePanelTaskRow {
  id: string
  title: string
  stepsDone: number
  stepsTotal: number
  updatedAt: number
}

export interface MePanelStatusCard {
  id: string
  severity: 'red' | 'yellow'
  label: string
  fact: string
}

export interface MePanelData {
  schedulesForUser(userId: string): Promise<MePanelScheduleRow[] | null>
  tasksForUser(userId: string): Promise<MePanelTaskRow[] | null>
  hubStatus(): Promise<MePanelStatusCard[] | null>
}

export function buildMePanelData(deps: MePanelDataDeps): MePanelData {
  return {
    async schedulesForUser(userId) {
      const surface = deps.schedules()
      if (!surface) return null
      // The SEN-M4 projection already filters by exact userId and copies
      // defensively — pass rows through untouched (one projection, one truth).
      return surface.listForUser(userId)
    },

    async tasksForUser(userId) {
      // ownerDir asserts the id shape before any path assembly (traversal
      // guard), same boundary the notebook itself writes under.
      let file: string
      try {
        file = join(ownerDir(deps.memoryRoot, { kind: 'user', id: userId }), 'tasks.json')
      } catch {
        return []
      }
      const tasks = await readTaskNotesSnapshot(file)
      return tasks
        .filter((t) => t.status === 'open')
        .map((t) => ({
          id: t.id,
          title: t.title,
          stepsDone: t.steps.filter((s) => s.done).length,
          stepsTotal: t.steps.length,
          updatedAt: t.updatedAt,
        }))
    },

    async hubStatus() {
      const surface = deps.health()
      if (!surface) return null
      try {
        return derivePatrolCards(await surface.snapshot()).map((c) => ({
          id: c.id,
          severity: c.severity,
          label: c.label,
          fact: c.fact,
        }))
      } catch (err) {
        // A failing health probe must not 500 the panel — the renderer's
        // "load failed" state is the honest answer.
        deps.logger?.warn('me-panel-data: health snapshot failed', { err })
        return []
      }
    },
  }
}
