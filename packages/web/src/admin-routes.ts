/**
 * Route handlers for the admin-console operational endpoints that aren't
 * already in their own module (identity / agents / services / uploads /
 * workflow each have their own file).
 *
 * Extracted from server.ts (C1 god-object split). Mirrors the pattern of
 * agents-routes.ts / services-routes.ts:
 *   - narrow ctx projection (AdminRoutesCtx)
 *   - single entry point handleAdminRoute(), returns true when it handled
 *     the request (including the 401 path — a sent 401 IS handled), false
 *     when the path/method matched nothing here so handle() falls through
 *   - shared HTTP helpers from ./http-helpers.js
 *
 * Routes handled:
 *   POST   /api/admin/admins                       invite a sister admin
 *   DELETE /api/admin/admins/:id                   revoke an admin
 *   GET    /api/admin/secrets                       list provider/agent keys
 *   PUT    /api/admin/secrets/:provider            set a workspace key
 *   DELETE /api/admin/secrets/:provider            clear a workspace key
 *   GET    /api/admin/feedback/inbound             hub-mesh inbound feedback
 *   GET    /api/admin/growth-reports               list growth reports
 *   GET    /api/admin/growth-reports/download      stream one report md
 *   GET    /api/admin/applications                 pending HELLO admissions
 *   POST   /api/admin/applications/:id/approve     approve an application
 *   POST   /api/admin/applications/:id/reject      reject an application
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody, sendJson } from './http-helpers.js'
import {
  createLogger,
  type AdminRecord,
  type FeedbackQuery,
  type GrowthReportsAdminSurface,
  type Hub,
  type Space,
} from '@aipehub/core'

const log = createLogger('admin-routes')

export interface AdminRoutesCtx {
  hub: Hub
  space: Space
  /** 503 when undefined — the personal-growth team isn't loaded. */
  growthReports: GrowthReportsAdminSurface | undefined
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

export async function handleAdminRoute(
  ctx: AdminRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  // --- admin: invite (mint a new admin) -----------------------------------
  // Sister-admin onboarding. The current admin POSTs { displayName }; the
  // server mints a fresh admin row + plaintext token and returns it ONCE.
  // The current admin shares the token with the invitee out-of-band (Signal /
  // 1Password / etc) — there is no email step on purpose.
  if (method === 'POST' && path === '/api/admin/admins') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const body = (await readJsonBody(req).catch(() => ({}))) as { displayName?: string }
    const displayName = (body.displayName ?? '').trim()
    if (!displayName) { sendJson(res, { error: 'displayName required' }, 400); return true }
    if (displayName.length > 80) { sendJson(res, { error: 'displayName too long' }, 400); return true }
    const { admin: created, token } = await ctx.space.createAdmin(displayName)
    sendJson(res, {
      ok: true,
      admin: { id: created.id, displayName: created.displayName, createdAt: created.createdAt },
      token,                // plaintext, shown ONCE
    })
    return true
  }

  // --- admin: revoke another admin ---------------------------------------
  const revokeAdminMatch = path.match(/^\/api\/admin\/admins\/([^/]+)$/)
  if (method === 'DELETE' && revokeAdminMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const targetId = decodeURIComponent(revokeAdminMatch[1]!)
    // Don't let an admin lock themselves out by deleting their own row
    // while sessions still point at it — they can `logout` for that.
    if (targetId === admin.id) {
      sendJson(res, { error: 'cannot revoke yourself; use logout' }, 400)
      return true
    }
    const remaining = (await ctx.space.admins()).filter((a) => a.id !== targetId)
    if (remaining.length === 0) {
      sendJson(res, { error: 'refusing to revoke last admin' }, 400)
      return true
    }
    const ok = await ctx.space.removeAdmin(targetId)
    if (!ok) { sendJson(res, { error: `unknown admin ${targetId}` }, 404); return true }
    sendJson(res, { ok: true })
    return true
  }

  // --- admin: workspace API-key secrets (v2.1) ---------------------------
  // Three endpoints let an admin manage workspace-level provider API
  // keys (anthropic, openai, …) through the browser. Keys are encrypted
  // at rest with AES-256-GCM (see `@aipehub/core/secrets.ts`). The
  // plaintext NEVER appears in a GET response — only the "is configured"
  // status. Listing per-agent overrides goes through the same secrets
  // file but its plaintext is set / cleared via the agent edit form.

  if (method === 'GET' && path === '/api/admin/secrets') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const providers = await ctx.space.listProviderApiKeys()
    const agents = await ctx.space.listAgentApiKeys()
    // The env-derived defaults are also surfaced so the UI can show
    // "anthropic ✓ (from environment)" vs "✓ (workspace key)".
    sendJson(res, {
      providers,
      agents,
      env: {
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        openai: !!process.env.OPENAI_API_KEY,
      },
    })
    return true
  }

  const setSecretMatch = path.match(/^\/api\/admin\/secrets\/([^/]+)$/)
  if (method === 'PUT' && setSecretMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const provider = decodeURIComponent(setSecretMatch[1]!)
    if (provider !== 'anthropic' && provider !== 'openai') {
      sendJson(res, { error: `unknown provider '${provider}'` }, 400)
      return true
    }
    const body = (await readJsonBody(req).catch(() => ({}))) as { apiKey?: string }
    if (typeof body.apiKey !== 'string' || body.apiKey.length === 0) {
      sendJson(res, { error: 'body must be { apiKey: "..." }' }, 400)
      return true
    }
    await ctx.space.setProviderApiKey(provider, body.apiKey)
    // Spawning of already-running agents doesn't pick up new keys until
    // they're restarted; tell the operator clearly. Future managed
    // agents will see the new key automatically.
    sendJson(res, { ok: true, note: 'workspace key updated; restart affected agents to apply' })
    return true
  }

  if (method === 'DELETE' && setSecretMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const provider = decodeURIComponent(setSecretMatch[1]!)
    const ok = await ctx.space.removeProviderApiKey(provider)
    if (!ok) { sendJson(res, { error: `no key set for '${provider}'` }, 404); return true }
    sendJson(res, { ok: true })
    return true
  }

  // --- Hub-mesh feedback inbound (M8) -------------------------------------
  // Shows evaluations OTHER hubs have written about us, pulled via the
  // mesh feedback protocol. Read-only — write happens on the evaluator
  // side via `hub.feedback.appendEntry(...)` over the link.
  //
  // Query params (all optional):
  //   taskRunId   — restrict to one workflow run
  //   fromHub     — restrict to one evaluator hub id
  //   status      — pending|delivered|read|rejected
  //   unreadOnly  — 'true' shorthand for status=pending
  //
  // Entries are returned sorted by createdAt descending (most recent first).
  if (method === 'GET' && path === '/api/admin/feedback/inbound') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true

    const url = new URL(req.url ?? '/', 'http://localhost')
    const filter: FeedbackQuery = {}
    const taskRunId = url.searchParams.get('taskRunId')
    const fromHub = url.searchParams.get('fromHub')
    const status = url.searchParams.get('status')
    const unreadOnly = url.searchParams.get('unreadOnly')

    if (taskRunId) filter.taskRunId = taskRunId
    if (fromHub) filter.evaluatorHub = fromHub
    if (
      status === 'pending' ||
      status === 'delivered' ||
      status === 'read' ||
      status === 'rejected'
    ) {
      filter.status = status
    } else if (unreadOnly === 'true' || unreadOnly === '1') {
      filter.status = 'delivered'
    }

    const entries = ctx.hub.inboundFeedback.query(filter)
    entries.sort((a, b) => b.createdAt - a.createdAt)
    sendJson(res, { entries })
    return true
  }

  // --- Growth reports (v2.4 personal-growth-flow) -------------------------
  // Two routes, both admin-only and both 503 when the host didn't
  // wire a `growthReports` surface (i.e. the personal-growth team
  // isn't loaded). The admin UI checks the list endpoint's 503
  // response and hides the panel cleanly.

  if (method === 'GET' && path === '/api/admin/growth-reports') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.growthReports) {
      sendJson(res, { error: 'growth reports not enabled' }, 503)
      return true
    }
    try {
      const reports = await ctx.growthReports.list()
      sendJson(res, { reports })
    } catch (err) {
      log.error('growth-reports list failed', { err })
      sendJson(res, { error: 'list failed' }, 500)
    }
    return true
  }

  // GET /api/admin/growth-reports/download?path=reports/<caseId>/<file>.md
  // Streams the markdown back as `text/markdown; charset=utf-8` with a
  // `Content-Disposition: attachment` header so the browser saves it.
  // Inline rendering can come later — markdown isn't a content-type
  // browsers display natively, so the download UX is right for v0.2.
  if (method === 'GET' && path === '/api/admin/growth-reports/download') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.growthReports) {
      sendJson(res, { error: 'growth reports not enabled' }, 503)
      return true
    }
    // Pull `?path=...` from the URL — we never trust the path to
    // route the request; `growthReports.read` is the only thing
    // that resolves it against the artifact handle (which itself
    // sanitises via service-artifact-file's `sanitisePath`).
    const url = new URL(req.url ?? '/', 'http://localhost')
    const reportPath = url.searchParams.get('path')
    if (!reportPath) {
      sendJson(res, { error: 'missing path' }, 400)
      return true
    }
    try {
      const { markdown } = await ctx.growthReports.read(reportPath)
      const filename = reportPath.split('/').pop() ?? 'report.md'
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
        'cache-control': 'no-store',
      })
      res.end(markdown)
    } catch (err) {
      log.warn('growth-reports read failed', { path: reportPath, err })
      sendJson(res, { error: 'not found' }, 404)
    }
    return true
  }

  // --- admin: applications -----------------------------------------------
  if (method === 'GET' && path === '/api/admin/applications') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    sendJson(res, { applications: ctx.hub.pendingApplications() })
    return true
  }

  const approveMatch = path.match(/^\/api\/admin\/applications\/([^/]+)\/approve$/)
  if (method === 'POST' && approveMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const appId = decodeURIComponent(approveMatch[1]!)
    const ok = ctx.hub.approveApplication(appId, admin.id)
    if (!ok) { sendJson(res, { error: `unknown application ${appId}` }, 404); return true }
    sendJson(res, { ok: true })
    return true
  }

  const rejectAppMatch = path.match(/^\/api\/admin\/applications\/([^/]+)\/reject$/)
  if (method === 'POST' && rejectAppMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const appId = decodeURIComponent(rejectAppMatch[1]!)
    const body = (await readJsonBody(req).catch(() => ({}))) as { reason?: string }
    const ok = ctx.hub.rejectApplication(appId, body?.reason || 'rejected by admin', admin.id)
    if (!ok) { sendJson(res, { error: `unknown application ${appId}` }, 404); return true }
    sendJson(res, { ok: true })
    return true
  }

  return false
}
