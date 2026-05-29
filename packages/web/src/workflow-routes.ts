/**
 * /api/admin/workflows/* — workflow CRUD + AI assistant routes.
 *
 * Extracted from server.ts (P3 audit cleanup — server.ts is 3700+ lines)
 * following the same shape as identity-routes.ts / me-routes.ts:
 *
 *   - Shared HTTP helpers (sendJson / readJsonBody / readTextBody) from
 *     ./http-helpers.js — the C3 cleanup that folded the per-route copies.
 *   - Narrow `WorkflowRoutesCtx` projection of server.ts's HandlerCtx —
 *     only the fields these handlers need (hub, workflows surface,
 *     workflow-assist surface, plus the parent's `requireAdmin` closure
 *     so we don't duplicate v3 admin auth machinery).
 *   - One entry point `handleWorkflowRoute(ctx, req, res, method, path,
 *     url): Promise<boolean>` — returns true iff the request was handled.
 *
 * # Route inventory
 *
 *   GET    /api/admin/workflows                      — list registered workflows
 *   POST   /api/admin/workflows/import               — YAML/JSON → register
 *   POST   /api/admin/workflows/assist               — Phase 13 M3 AI draft
 *   GET    /api/admin/workflows/runs                 — list recorded runs
 *   GET    /api/admin/workflows/runs/:id             — read one run
 *   DELETE /api/admin/workflows/:id                  — unregister + delete YAML
 *
 * Auth: every route is admin-gated via the host-supplied `requireAdmin`.
 * When the host didn't wire `workflows` (embedded / test mode), CRUD
 * endpoints return 404 so the admin UI can hide the panel; when assist
 * is absent (no LLM key / disabled), 503.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody, readTextBody, sendJson } from './http-helpers.js'

import type { AdminRecord, Hub } from '@aipehub/core'

import type {
  WorkflowAssistSurface,
  WorkflowAssistContextHints,
  WorkflowSurface,
} from './server.js'

// ---------------------------------------------------------------------------
// Context — narrow projection of server.ts's HandlerCtx. Only the bits
// these routes touch, plus the `requireAdmin` closure so we don't have
// to re-export the v3 admin auth internals.
// ---------------------------------------------------------------------------

export interface WorkflowRoutesCtx {
  hub: Hub
  workflows: WorkflowSurface | undefined
  workflowAssist: WorkflowAssistSurface | undefined
  /**
   * The parent's admin gate. On rejection (401 / 429) this closure
   * writes the response itself and returns `null`; on success it
   * returns the resolved `AdminRecord`. Workflow handlers short-
   * circuit when it returns null.
   */
  requireAdmin(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<AdminRecord | null>
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Try to handle a request against the workflow route set. Returns
 * `true` iff the request matched (and the response was written by us /
 * the auth gate); the caller's main switch then falls through.
 *
 * Important: the DELETE /api/admin/workflows/:id pattern MUST be tested
 * AFTER the /runs sub-routes; the dispatcher inside this function
 * already does so. Don't reorder.
 */
export async function handleWorkflowRoute(
  ctx: WorkflowRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  url: URL,
): Promise<boolean> {
  // GET /api/admin/workflows — list
  if (method === 'GET' && path === '/api/admin/workflows') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return true
    }
    try {
      const list = await ctx.workflows.list()
      sendJson(res, { workflows: list })
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }

  // POST /api/admin/workflows/import — accept YAML or JSON body
  if (method === 'POST' && path === '/api/admin/workflows/import') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return true
    }
    const raw = await readTextBody(req).catch(() => '')
    if (!raw) { sendJson(res, { error: 'empty body' }, 400); return true }
    try {
      const summary = await ctx.workflows.importFromText(raw)
      sendJson(res, { ok: true, workflow: summary })
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400)
    }
    return true
  }

  // POST /api/admin/workflows/assist — Phase 13 M3 natural-language draft.
  // The host wires `ctx.workflowAssist` to a `WorkflowAssistantAgent`
  // registered at boot (capability=`workflow:assist`). When absent (no
  // LLM key resolved, or operator set `AIPE_ASSISTANT_DISABLED=1`),
  // respond 503 so the admin UI can hide the "AI assistant" button
  // cleanly.
  //
  // Request body (JSON):
  //   { description: string, contextHints?: WorkflowAssistContextHints }
  // Response body (200):
  //   { ok: true, yaml, explanation, raw, draftStatus, validationError?,
  //     by?, stopReason?, deepCheck? }
  //   - `deepCheck` (Phase 13 M4) is populated iff the request carried
  //     `contextHints` AND the YAML parsed cleanly. Caller treats
  //     `deepCheck.ok=false` as a yellow "warnings" state — admin can
  //     still save, but the workflow references hub entities that don't
  //     currently exist. See WorkflowDeepCheckResult in server.ts.
  // Response body (4xx/5xx): { error: string }
  if (method === 'POST' && path === '/api/admin/workflows/assist') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.workflowAssist) {
      sendJson(res, { error: 'workflow assistant not enabled on this host' }, 503)
      return true
    }
    const body = (await readJsonBody(req).catch(() => undefined)) as
      | { description?: unknown; contextHints?: WorkflowAssistContextHints }
      | undefined
    const description =
      body && typeof body.description === 'string' ? body.description : ''
    if (description.trim().length === 0) {
      sendJson(res, { error: 'description is required (non-empty string)' }, 400)
      return true
    }
    try {
      const result = await ctx.workflowAssist.assist({
        description,
        ...(body?.contextHints ? { contextHints: body.contextHints } : {}),
        by: admin.id,
      })
      sendJson(res, { ok: true, ...result })
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }

  // List recorded workflow runs. Both /runs and /runs/:id are wired
  // before the catch-all DELETE /:id route so a runId can never get
  // routed as a workflow id.
  if (method === 'GET' && path === '/api/admin/workflows/runs') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return true
    }
    const workflowIdRaw = url.searchParams.get('workflowId') ?? undefined
    const limitRaw = url.searchParams.get('limit')
    const opts: { workflowId?: string; limit?: number } = {}
    if (workflowIdRaw) opts.workflowId = workflowIdRaw
    if (limitRaw !== null) {
      const n = Number(limitRaw)
      if (Number.isFinite(n) && n >= 0) opts.limit = Math.min(1000, Math.floor(n))
    }
    try {
      const runs = await ctx.workflows.listRuns(opts)
      sendJson(res, { runs })
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }

  const readRunMatch = path.match(/^\/api\/admin\/workflows\/runs\/([^/]+)$/)
  if (method === 'GET' && readRunMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return true
    }
    const runId = decodeURIComponent(readRunMatch[1]!)
    try {
      const run = await ctx.workflows.readRun(runId)
      if (run == null) {
        sendJson(res, { error: `unknown run '${runId}'` }, 404)
        return true
      }
      sendJson(res, { run })
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }

  // DELETE /api/admin/workflows/:id — unregister + delete YAML.
  // Wired LAST so the /runs sub-routes can never get caught here.
  const deleteWorkflowMatch = path.match(/^\/api\/admin\/workflows\/([^/]+)$/)
  if (method === 'DELETE' && deleteWorkflowMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return true
    }
    const id = decodeURIComponent(deleteWorkflowMatch[1]!)
    try {
      await ctx.workflows.remove(id)
      sendJson(res, { ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // "not loaded" → 404, everything else → 400
      const status = /not loaded|unknown/i.test(msg) ? 404 : 400
      sendJson(res, { error: msg }, status)
    }
    return true
  }

  return false
}
