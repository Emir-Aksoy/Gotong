import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  HumanParticipant,
  type DispatchStrategy,
  type Hub,
  type ParticipantId,
  type TaskId,
} from '@aipehub/core'

/**
 * Reference web UI for AipeHub.
 *
 * Two co-existing surfaces:
 *
 *   - `/`        — worker view (any browser, no auth). Lets a person join
 *                  the hub as a HumanParticipant, see pending tasks assigned
 *                  to them, approve/reject those tasks.
 *   - `/admin`   — admin view. Gated by an admin token (env
 *                  `AIPE_ADMIN_TOKEN` or `serveWeb(hub, { adminToken })`).
 *                  First visit with `?token=…` writes an HttpOnly cookie;
 *                  subsequent visits use the cookie.
 *
 * Embeds a tiny Node http server that:
 *   - serves a vanilla-JS SPA per route from packages/web/static
 *   - streams HubEvents to clients over SSE at /api/stream
 *   - exposes admin-only endpoints to approve agent admission, dispatch
 *     tasks, and write evaluations
 *
 * No express, no bundler, no framework — just an addressable surface for
 * the humans in the room.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
// dist/server.js is one level below the package root, so the static dir is ../static
const STATIC_DIR = join(__dirname, '..', 'static')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

const ADMIN_COOKIE = 'aipehub_admin'
const ADMIN_COOKIE_MAX_AGE_S = 7 * 24 * 3600

export interface WebServerOptions {
  port?: number
  host?: string
  /**
   * Admin authentication token. If unset, falls back to env
   * `AIPE_ADMIN_TOKEN`. If both are unset, the admin surface is unreachable
   * (no `/admin` route, no admin APIs) — only the worker view is exposed.
   *
   * First visit with `?token=<value>` writes an HttpOnly cookie; later
   * requests authenticate via the cookie or via `Authorization: Bearer
   * <value>`.
   */
  adminToken?: string
}

export interface WebServerHandle {
  readonly host: string
  readonly port: number
  readonly url: string
  readonly adminEnabled: boolean
  close(): Promise<void>
}

interface SseClient {
  res: ServerResponse
}

export function serveWeb(hub: Hub, opts: WebServerOptions = {}): Promise<WebServerHandle> {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 3000
  const adminToken = opts.adminToken ?? process.env.AIPE_ADMIN_TOKEN ?? ''
  const adminEnabled = adminToken.length > 0
  /** Cookie session ids that have been validated against `adminToken`. */
  const adminSessions = new Set<string>()
  const sseClients = new Set<SseClient>()

  const unsubscribe = hub.onEvent((event) => {
    const payload = `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`
    for (const c of sseClients) {
      try {
        c.res.write(payload)
      } catch {
        /* client disappeared; cleanup happens on 'close' */
      }
    }
  })

  const ctx: HandlerCtx = { hub, adminToken, adminEnabled, adminSessions, sseClients }

  const server = createServer((req, res) => {
    handle(ctx, req, res).catch((err) => {
      console.error('[aipehub-web] handler threw:', err)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(`server error: ${err instanceof Error ? err.message : String(err)}`)
      } else {
        try { res.end() } catch { /* ignore */ }
      }
    })
  })

  return new Promise<WebServerHandle>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const addr = server.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      const url = `http://${host}:${actualPort}`
      console.log(`[aipehub-web] listening at ${url}`)
      if (adminEnabled) {
        console.log(`[aipehub-web] admin: ${url}/admin?token=${adminToken}`)
        console.log(`[aipehub-web] workers: ${url}/`)
      } else {
        console.log(`[aipehub-web] admin disabled (set AIPE_ADMIN_TOKEN to enable)`)
      }
      resolve({
        host,
        port: actualPort,
        url,
        adminEnabled,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            unsubscribe()
            for (const c of sseClients) {
              try { c.res.end() } catch { /* ignore */ }
            }
            sseClients.clear()
            server.close((err) => (err ? rejectClose(err) : resolveClose()))
          }),
      })
    })
  })
}

// --- handler context --------------------------------------------------------

interface HandlerCtx {
  hub: Hub
  adminToken: string
  adminEnabled: boolean
  adminSessions: Set<string>
  sseClients: Set<SseClient>
}

async function handle(
  ctx: HandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  const method = req.method ?? 'GET'

  // --- SSE stream ---------------------------------------------------------
  if (method === 'GET' && path === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    const client: SseClient = { res }
    ctx.sseClients.add(client)
    req.on('close', () => ctx.sseClients.delete(client))
    return
  }

  // --- state snapshot -----------------------------------------------------
  if (method === 'GET' && path === '/api/state') {
    sendJson(res, snapshotState(ctx.hub))
    return
  }

  // --- who am I -----------------------------------------------------------
  if (method === 'GET' && path === '/api/whoami') {
    sendJson(res, {
      role: isAdminReq(ctx, req) ? 'admin' : 'guest',
      adminEnabled: ctx.adminEnabled,
    })
    return
  }

  // --- admin login --------------------------------------------------------
  // GET /admin?token=xxx: validate, mint cookie, redirect to /admin/
  // GET /admin (no token): serve admin.html if cookie valid, else 401 page
  if (method === 'GET' && (path === '/admin' || path === '/admin/')) {
    if (!ctx.adminEnabled) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('admin disabled — set AIPE_ADMIN_TOKEN to enable')
      return
    }
    const supplied = url.searchParams.get('token') ?? ''
    if (supplied) {
      if (supplied !== ctx.adminToken) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('invalid token')
        return
      }
      const sid = randomBytes(24).toString('hex')
      ctx.adminSessions.add(sid)
      res.writeHead(302, {
        'set-cookie': `${ADMIN_COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ADMIN_COOKIE_MAX_AGE_S}`,
        location: '/admin/',
      })
      res.end()
      return
    }
    if (!isAdminReq(ctx, req)) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><meta charset=utf-8><title>AipeHub admin</title><body style="font-family:sans-serif;max-width:30rem;margin:6rem auto;color:#333"><h1>401 — admin token required</h1><p>Open this page with <code>?token=YOUR_TOKEN</code> appended to the URL.</p></body>')
      return
    }
    await serveStatic(res, 'admin.html')
    return
  }

  // --- admin logout -------------------------------------------------------
  if (method === 'POST' && path === '/api/admin/logout') {
    const sid = readCookie(req, ADMIN_COOKIE)
    if (sid) ctx.adminSessions.delete(sid)
    res.writeHead(200, {
      'set-cookie': `${ADMIN_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      'content-type': 'application/json; charset=utf-8',
    })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // --- admin: applications -----------------------------------------------
  if (method === 'GET' && path === '/api/admin/applications') {
    if (!requireAdmin(ctx, req, res)) return
    sendJson(res, { applications: ctx.hub.pendingApplications() })
    return
  }

  const approveMatch = path.match(/^\/api\/admin\/applications\/([^/]+)\/approve$/)
  if (method === 'POST' && approveMatch) {
    if (!requireAdmin(ctx, req, res)) return
    const appId = decodeURIComponent(approveMatch[1]!)
    const ok = ctx.hub.approveApplication(appId, 'admin')
    if (!ok) {
      sendJson(res, { error: `unknown application ${appId}` }, 404)
      return
    }
    sendJson(res, { ok: true })
    return
  }

  const rejectAppMatch = path.match(/^\/api\/admin\/applications\/([^/]+)\/reject$/)
  if (method === 'POST' && rejectAppMatch) {
    if (!requireAdmin(ctx, req, res)) return
    const appId = decodeURIComponent(rejectAppMatch[1]!)
    const body = (await readJsonBody(req).catch(() => ({}))) as { reason?: string }
    const ok = ctx.hub.rejectApplication(appId, body?.reason || 'rejected by admin', 'admin')
    if (!ok) {
      sendJson(res, { error: `unknown application ${appId}` }, 404)
      return
    }
    sendJson(res, { ok: true })
    return
  }

  // --- admin: dispatch ----------------------------------------------------
  if (method === 'POST' && path === '/api/admin/dispatch') {
    if (!requireAdmin(ctx, req, res)) return
    const body = (await readJsonBody(req).catch(() => ({}))) as {
      strategy?: DispatchStrategy
      payload?: unknown
      title?: string
      priority?: number
    }
    if (!body?.strategy) {
      sendJson(res, { error: 'missing strategy' }, 400)
      return
    }
    // fire and forget the eventual result — the transcript will carry it
    ctx.hub.dispatch({
      from: 'admin',
      strategy: body.strategy,
      payload: body.payload ?? {},
      title: body.title,
      priority: body.priority,
    }).catch((err) => console.error('[aipehub-web] dispatch failed:', err))
    sendJson(res, { ok: true })
    return
  }

  // --- admin: evaluation --------------------------------------------------
  if (method === 'POST' && path === '/api/admin/evaluate') {
    if (!requireAdmin(ctx, req, res)) return
    const body = (await readJsonBody(req).catch(() => ({}))) as {
      taskId?: TaskId
      rating?: number
      comment?: string
    }
    if (!body?.taskId) {
      sendJson(res, { error: 'missing taskId' }, 400)
      return
    }
    const ev = ctx.hub.evaluate({
      taskId: body.taskId,
      by: 'admin',
      rating: body.rating,
      comment: body.comment,
    })
    sendJson(res, { ok: true, evaluation: ev })
    return
  }

  // --- worker: join (register a HumanParticipant) -------------------------
  if (method === 'POST' && path === '/api/workers') {
    const body = (await readJsonBody(req).catch(() => ({}))) as {
      id?: string
      capabilities?: string[]
    }
    if (!body?.id || typeof body.id !== 'string') {
      sendJson(res, { error: 'id is required' }, 400)
      return
    }
    if (ctx.hub.participant(body.id)) {
      sendJson(res, { error: `id '${body.id}' already taken` }, 409)
      return
    }
    const human = new HumanParticipant({
      id: body.id,
      capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
    })
    ctx.hub.register(human)
    sendJson(res, { ok: true, id: human.id, capabilities: human.capabilities })
    return
  }

  // --- worker: leave ------------------------------------------------------
  const workerLeave = path.match(/^\/api\/workers\/([^/]+)$/)
  if (method === 'DELETE' && workerLeave) {
    const id = decodeURIComponent(workerLeave[1]!)
    const p = ctx.hub.participant(id)
    if (!p || p.kind !== 'human') {
      sendJson(res, { error: `no human worker ${id}` }, 404)
      return
    }
    ctx.hub.unregister(id)
    sendJson(res, { ok: true })
    return
  }

  // --- task action (any human's pending task; v1.1 keeps this open) -------
  const taskAction = path.match(/^\/api\/tasks\/([^/]+)\/(complete|reject)$/)
  if (method === 'POST' && taskAction) {
    const taskId = decodeURIComponent(taskAction[1]!)
    const action = taskAction[2] as 'complete' | 'reject'
    const body = (await readJsonBody(req).catch(() => ({}))) as {
      output?: unknown
      error?: string
    }

    const human = findHumanWithPending(ctx.hub, taskId)
    if (!human) {
      sendJson(res, { error: `no human has task ${taskId} pending` }, 404)
      return
    }

    const ok =
      action === 'complete'
        ? human.complete(taskId, body?.output ?? null)
        : human.reject(taskId, body?.error ?? 'rejected via web UI')

    if (!ok) {
      sendJson(res, { error: 'task is no longer pending' }, 409)
      return
    }
    sendJson(res, { ok: true })
    return
  }

  // --- static files -------------------------------------------------------
  if (method === 'GET') {
    // Root → worker.html (admin lives at /admin)
    const requested = path === '/' ? 'worker.html' : path.replace(/^\//, '')
    await serveStatic(res, requested)
    return
  }

  res.writeHead(405)
  res.end()
}

// --- admin auth helpers ----------------------------------------------------

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    if (k === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

function readBearer(req: IncomingMessage): string | undefined {
  const auth = req.headers['authorization']
  if (typeof auth !== 'string') return undefined
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
  return m ? m[1]!.trim() : undefined
}

function isAdminReq(ctx: HandlerCtx, req: IncomingMessage): boolean {
  if (!ctx.adminEnabled) return false
  const bearer = readBearer(req)
  if (bearer && bearer === ctx.adminToken) return true
  const sid = readCookie(req, ADMIN_COOKIE)
  return !!sid && ctx.adminSessions.has(sid)
}

function requireAdmin(
  ctx: HandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (isAdminReq(ctx, req)) return true
  sendJson(res, { error: 'admin auth required' }, 401)
  return false
}

// --- snapshot / lookup -----------------------------------------------------

function snapshotState(hub: Hub) {
  const participants = hub.registry.all().map((p) => ({
    id: p.id,
    kind: p.kind,
    capabilities: p.capabilities,
    load: hub.registry.loadOf(p.id),
  }))
  const pending: Array<{
    taskId: TaskId
    assignedTo: ParticipantId
    title?: string
    payload: unknown
    createdAt: number
  }> = []
  for (const p of hub.registry.byKind('human')) {
    if (p instanceof HumanParticipant) {
      for (const t of p.pending()) {
        pending.push({
          taskId: t.id,
          assignedTo: p.id,
          title: t.title,
          payload: t.payload,
          createdAt: t.createdAt,
        })
      }
    }
  }
  return {
    participants,
    transcript: hub.transcript.all(),
    pending,
    pendingApplications: hub.pendingApplications(),
  }
}

function findHumanWithPending(hub: Hub, taskId: TaskId): HumanParticipant | undefined {
  for (const p of hub.registry.byKind('human')) {
    if (p instanceof HumanParticipant) {
      if (p.pending().some((t) => t.id === taskId)) return p
    }
  }
  return undefined
}

// --- http helpers ----------------------------------------------------------

async function serveStatic(res: ServerResponse, requested: string): Promise<void> {
  const safe = normalize(requested)
  if (safe.startsWith('..') || safe.includes(`..${sep}`)) {
    res.writeHead(400); res.end(); return
  }
  const full = join(STATIC_DIR, safe)
  if (!full.startsWith(STATIC_DIR + sep) && full !== STATIC_DIR) {
    res.writeHead(400); res.end(); return
  }
  try {
    const data = await readFile(full)
    const ext = extname(safe)
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    res.end(data)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    throw err
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (chunk) => {
      buf += chunk
      if (buf.length > 1_000_000) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => {
      if (!buf) return resolve(undefined)
      try {
        resolve(JSON.parse(buf))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}
