/**
 * Admin routes for zero-LLM workflow schedules (LIFE-L1-M3) — the web CRUD +
 * manual-fire surface over the host's schedule files. Web stays a thin
 * requireAdmin → surface → echo; the host `WorkflowScheduleAdminSurface` owns
 * file IO, row validation, and the ONE dispatch path (the sweeper's `fireNow`,
 * which runs the same member-facing gate as `run_my_workflow`: published +
 * surface.me + role + force-set member scope key). Web carries ZERO
 * `@aipehub/host` runtime dependency — it mirrors the surface structurally,
 * exactly like `SettingOpsSurface`.
 *
 *   GET    /api/admin/workflow-schedules            list rows (intent + mark,
 *                                                   invalid rows flagged)
 *   POST   /api/admin/workflow-schedules            upsert one row (id minted
 *                                                   when absent) — 400 on a row
 *                                                   that doesn't normalise
 *   DELETE /api/admin/workflow-schedules/:id        remove — 404 when absent
 *   POST   /api/admin/workflow-schedules/:id/fire   manual 试跑: ignores the due
 *                                                   gate AND `enabled`, but NOT
 *                                                   the member gate; writes the
 *                                                   fired mark (so a daily row
 *                                                   won't re-fire the same day)
 *
 * Fire failures map: not_found → 404; invalid / unrunnable → 409 (the on-disk
 * row or its workflow refuses as configured — fix config, retry); dispatch
 * failure → 500.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminRecord } from '@aipehub/core'

import { readJsonBody, sendJson } from './http-helpers.js'

/** Duck-typed mirror of the host's `WorkflowScheduleView`. */
export interface WorkflowScheduleView {
  id: string
  workflowId: string
  userId: string
  cadence: unknown
  inputs?: Record<string, unknown>
  enabled: boolean
  valid: boolean
  lastFiredMark?: string
}

/** Duck-typed mirror of the host's `ScheduleFireResult`. */
export type WorkflowScheduleFireResult =
  | { ok: true; scheduleId: string; workflowId: string; userId: string; mark: string }
  | { ok: false; reason: 'not_found' | 'invalid' | 'unrunnable' | 'dispatch_failed' }

/** Host-injected surface; `createWorkflowScheduleAdminSurface` satisfies it. */
export interface WorkflowScheduleAdminSurface {
  list(): Promise<WorkflowScheduleView[]>
  upsert(
    raw: unknown,
  ): Promise<{ ok: true; schedule: WorkflowScheduleView } | { ok: false; error: string }>
  remove(id: string): Promise<boolean>
  fire(id: string): Promise<WorkflowScheduleFireResult>
}

export interface WorkflowScheduleRoutesCtx {
  workflowSchedules?: WorkflowScheduleAdminSurface
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

const BASE = '/api/admin/workflow-schedules'

const FIRE_STATUS: Record<string, number> = {
  not_found: 404,
  invalid: 409,
  unrunnable: 409,
  dispatch_failed: 500,
}

/**
 * Handle the admin workflow-schedule routes. Returns `true` iff the request
 * matched `/api/admin/workflow-schedules[/...]` (and was answered).
 */
export async function handleWorkflowScheduleRoute(
  ctx: WorkflowScheduleRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false

  const admin = await ctx.requireAdmin(req, res)
  if (!admin) return true
  const surface = ctx.workflowSchedules
  if (!surface) {
    sendJson(res, { error: 'workflow schedules not enabled on this host' }, 503)
    return true
  }

  // Collection: GET list / POST upsert.
  if (path === BASE) {
    if (method === 'GET') {
      sendJson(res, { schedules: await surface.list() })
      return true
    }
    if (method === 'POST') {
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, { error: 'invalid JSON body' }, 400)
        return true
      }
      const out = await surface.upsert(body)
      if (!out.ok) {
        // The row didn't normalise — the host refuses to store what it would
        // refuse to run (same fail posture as the sweeper: never guess).
        sendJson(res, { error: out.error }, 400)
        return true
      }
      sendJson(res, { schedule: out.schedule })
      return true
    }
    sendJson(res, { error: `method ${method} not allowed` }, 405)
    return true
  }

  // Member: DELETE /:id and POST /:id/fire.
  const rest = decodeURIComponent(path.slice(BASE.length + 1))
  if (rest.endsWith('/fire')) {
    const id = rest.slice(0, -'/fire'.length)
    if (method !== 'POST' || id.length === 0) {
      sendJson(res, { error: `method ${method} not allowed` }, 405)
      return true
    }
    const out = await surface.fire(id)
    if (!out.ok) {
      sendJson(res, { error: out.reason }, FIRE_STATUS[out.reason] ?? 500)
      return true
    }
    sendJson(res, out)
    return true
  }
  if (method === 'DELETE' && rest.length > 0 && !rest.includes('/')) {
    const removed = await surface.remove(rest)
    if (!removed) {
      sendJson(res, { error: 'schedule not found' }, 404)
      return true
    }
    sendJson(res, { ok: true })
    return true
  }
  sendJson(res, { error: 'not found' }, 404)
  return true
}
