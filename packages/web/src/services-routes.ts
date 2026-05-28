/**
 * Route handlers for Hub Services admin (plugins, trash, sweep).
 *
 * Extracted from server.ts in the P3 audit cleanup.
 *
 * Routes handled:
 *   GET    /api/admin/services/plugins                       list plugins
 *   GET    /api/admin/services/owners/:type/:impl/:ok/:oid   describe plugin data
 *   DELETE /api/admin/services/owners/:type/:impl/:ok/:oid   soft-delete
 *   GET    /api/admin/services/trash                         list trash
 *   POST   /api/admin/services/trash/:t/:i/:id/restore       restore
 *   DELETE /api/admin/services/trash/:t/:i/:id                hard-delete
 *   POST   /api/admin/services/sweep                         manual sweep
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminRecord, ServicesAdminSurface } from '@aipehub/core'

// -- types ----------------------------------------------------------------

export interface ServicesRoutesCtx {
  services?: ServicesAdminSurface
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

// -- HTTP helpers ---------------------------------------------------------

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > 1_000_000) { req.destroy(); reject(new Error('body too large')) }
    })
    req.on('end', () => {
      if (!buf) return resolve(undefined)
      try { resolve(JSON.parse(buf)) } catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

/**
 * Translate a services-sdk typed error to an HTTP status. Pattern-matches
 * on error name (stable string constants) to avoid importing the sdk.
 */
function sendServiceError(res: ServerResponse, err: unknown): void {
  const e = err as { name?: string; message?: string }
  const name = e?.name ?? ''
  const msg = e?.message ?? String(err)
  let status = 500
  if (name === 'PluginNotFoundError') status = 404
  else if (name === 'TrashRestoreConflictError') status = 409
  else if (name === 'ServiceConfigError') status = 400
  sendJson(res, { error: msg, code: name || 'unknown' }, status)
}

// -- route handler --------------------------------------------------------

/**
 * Handle `/api/admin/services/*` routes.
 * Returns `true` if the request was handled, `false` otherwise.
 */
export async function handleServicesRoute(
  ctx: ServicesRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  // --- list plugins ---
  if (method === 'GET' && path === '/api/admin/services/plugins') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.services) { sendJson(res, { error: 'services not enabled' }, 503); return true }
    sendJson(res, { plugins: ctx.services.listPlugins() })
    return true
  }

  // --- describe one (plugin, owner) pair ---
  const describeMatch = path.match(
    /^\/api\/admin\/services\/owners\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/,
  )

  if (method === 'GET' && describeMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.services) { sendJson(res, { error: 'services not enabled' }, 503); return true }
    const [, type, impl, ownerKind, ownerId] = describeMatch
    try {
      const snap = await ctx.services.describe({
        type: decodeURIComponent(type!),
        impl: decodeURIComponent(impl!),
        owner: { kind: decodeURIComponent(ownerKind!), id: decodeURIComponent(ownerId!) },
      })
      sendJson(res, { snapshot: snap })
    } catch (err) {
      sendServiceError(res, err)
    }
    return true
  }

  // --- soft-delete owner's data for one plugin ---
  if (method === 'DELETE' && describeMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.services) { sendJson(res, { error: 'services not enabled' }, 503); return true }
    const [, type, impl, ownerKind, ownerId] = describeMatch
    const raw = await readJsonBody(req).catch(() => undefined)
    const body = (raw && typeof raw === 'object' ? raw : {}) as { reason?: string }
    try {
      const ref = await ctx.services.softDelete({
        type: decodeURIComponent(type!),
        impl: decodeURIComponent(impl!),
        owner: { kind: decodeURIComponent(ownerKind!), id: decodeURIComponent(ownerId!) },
        by: admin.id,
        ...(typeof body.reason === 'string' && body.reason.length > 0 ? { reason: body.reason } : {}),
      })
      sendJson(res, { ok: true, ref })
    } catch (err) {
      sendServiceError(res, err)
    }
    return true
  }

  // --- list trash ---
  if (method === 'GET' && path === '/api/admin/services/trash') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.services) { sendJson(res, { error: 'services not enabled' }, 503); return true }
    try {
      const all = await ctx.services.listTrash()
      const sorted = [...all].sort((a, b) => b.deletedAt - a.deletedAt)
      sendJson(res, { trash: sorted })
    } catch (err) {
      sendServiceError(res, err)
    }
    return true
  }

  // --- restore trash entry ---
  const restoreMatch = path.match(/^\/api\/admin\/services\/trash\/([^/]+)\/([^/]+)\/([^/]+)\/restore$/)
  if (method === 'POST' && restoreMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.services) { sendJson(res, { error: 'services not enabled' }, 503); return true }
    const [, type, impl, id] = restoreMatch
    const t = decodeURIComponent(type!)
    const i = decodeURIComponent(impl!)
    const refId = decodeURIComponent(id!)
    try {
      const all = await ctx.services.listTrash()
      const ref = all.find((r) => r.type === t && r.impl === i && r.id === refId)
      if (!ref) { sendJson(res, { error: 'trash entry not found' }, 404); return true }
      await ctx.services.restore(ref)
      sendJson(res, { ok: true })
    } catch (err) {
      sendServiceError(res, err)
    }
    return true
  }

  // --- hard-delete trash entry ---
  const hardDeleteMatch = path.match(/^\/api\/admin\/services\/trash\/([^/]+)\/([^/]+)\/([^/]+)$/)
  if (method === 'DELETE' && hardDeleteMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.services) { sendJson(res, { error: 'services not enabled' }, 503); return true }
    const [, type, impl, id] = hardDeleteMatch
    const t = decodeURIComponent(type!)
    const i = decodeURIComponent(impl!)
    const refId = decodeURIComponent(id!)
    try {
      const all = await ctx.services.listTrash()
      const ref = all.find((r) => r.type === t && r.impl === i && r.id === refId)
      if (!ref) { sendJson(res, { error: 'trash entry not found' }, 404); return true }
      await ctx.services.hardDelete(ref)
      sendJson(res, { ok: true })
    } catch (err) {
      sendServiceError(res, err)
    }
    return true
  }

  // --- manual sweep ---
  if (method === 'POST' && path === '/api/admin/services/sweep') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.services) { sendJson(res, { error: 'services not enabled' }, 503); return true }
    try {
      if (!ctx.services.sweepExpired) {
        sendJson(res, { error: 'manual sweep not supported by this host' }, 405)
        return true
      }
      const out = await ctx.services.sweepExpired()
      sendJson(res, { ok: true, ...out })
    } catch (err) {
      sendServiceError(res, err)
    }
    return true
  }

  return false
}
