import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  HumanParticipant,
  type AdminRecord,
  type DispatchStrategy,
  type Hub,
  type ParticipantId,
  type Space,
  type TaskId,
  type WorkerRecord,
} from '@aipehub/core'

/**
 * Reference web UI for AipeHub (v2.0 — file-first).
 *
 * The whole admin / worker story is anchored to the Hub's Space:
 *
 *   - admins, agent allowlist, and workers live in space.admins() /
 *     space.agents() / space.workers()
 *   - admin sessions and worker sessions are persisted under
 *     space/runtime/{admin,worker}-sessions.json so a server restart
 *     does not log anyone out
 *   - pending agent admissions are written by `hub.requestAdmission(...)`
 *     to space/runtime/pending-apps.json
 *
 * Two co-existing surfaces:
 *
 *   - `/`        — worker view (open). A person joins as a HumanParticipant
 *                  by POSTing { id, capabilities } to /api/workers; the
 *                  server mints an HttpOnly cookie tied to a row in
 *                  workers.json. No browser storage is used.
 *   - `/admin`   — admin console. Gated by an admin token verified against
 *                  space.admins() (multi-admin supported). First visit with
 *                  `?token=…` writes an HttpOnly cookie tied to a row in
 *                  runtime/admin-sessions.json.
 *
 * The server also exposes a task panel (`/api/tasks`) and retry endpoint
 * (`/api/admin/tasks/:id/retry`) wired to `hub.tasks()` / `hub.retry()`.
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
const WORKER_COOKIE = 'aipehub_worker'
const COOKIE_MAX_AGE_S = 7 * 24 * 3600

export interface WebServerOptions {
  port?: number
  host?: string
  /**
   * Add `Secure` flag to admin / worker cookies and upgrade SameSite from
   * `Lax` to `Strict`. Required for production HTTPS deployment (browsers
   * refuse to send `Secure` cookies over HTTP, so leave this **off** for
   * local / LAN HTTP development). Default false. Cookies are always
   * `HttpOnly`.
   */
  cookieSecure?: boolean
  /**
   * Hostnames the server will accept on the `Host:` and `Origin:` headers
   * of state-changing requests (POST / DELETE). Reject anything else with
   * 403. Defaults to "no check" (only safe on localhost-bound dev). For
   * production, pass `['hub.example.com']` so a third-party page can't
   * CSRF-trigger admin actions through a logged-in browser. The "host:port"
   * combination must match exactly; protocol is checked against
   * `cookieSecure` (https vs http).
   */
  allowedHosts?: readonly string[]
  /**
   * Per-IP rate limit on admin-token verification (`/admin?token=…`).
   * Anti-bruteforce. Default `{ max: 10, windowSec: 60 }`. Set `max: 0`
   * to disable.
   */
  adminLoginRateLimit?: { max: number; windowSec: number }
}

export interface WebServerHandle {
  readonly host: string
  readonly port: number
  readonly url: string
  close(): Promise<void>
}

interface SseClient {
  res: ServerResponse
}

/**
 * Boot the web server. The Hub **must** be bound to a Space (`new Hub({
 * space })`) — admin and worker auth read identity from disk. If you only
 * need an in-memory transcript and no admin / worker auth, use the v1.x
 * surface and pass `adminToken` directly; that path is gone in v2.0.
 */
export function serveWeb(hub: Hub, opts: WebServerOptions = {}): Promise<WebServerHandle> {
  if (!hub.space) {
    return Promise.reject(
      new Error(
        '@aipehub/web v2.0 requires hub.space — construct the Hub with `new Hub({ space })`. The in-memory path was removed; use Space.openOrInit(dir, ...) first.',
      ),
    )
  }
  const space = hub.space
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 3000
  const cookieSecure = opts.cookieSecure ?? false
  const allowedHosts = opts.allowedHosts ? new Set(opts.allowedHosts) : undefined
  const rateLimitOpts = opts.adminLoginRateLimit ?? { max: 10, windowSec: 60 }
  const adminLoginLimiter = new RateLimiter(rateLimitOpts.max, rateLimitOpts.windowSec * 1000)
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

  const ctx: HandlerCtx = {
    hub,
    space,
    sseClients,
    cookieSecure,
    allowedHosts,
    adminLoginLimiter,
  }

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
    server.listen(port, host, async () => {
      const addr = server.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      const url = `http://${host}:${actualPort}`
      console.log(`[aipehub-web] listening at ${url}`)
      const admins = await space.admins()
      if (admins.length > 0) {
        console.log(`[aipehub-web] ${admins.length} admin(s) configured. /admin requires their token; first-time URL: ${url}/admin?token=<TOKEN>`)
      } else {
        console.log(`[aipehub-web] no admins yet. Run \`Space.createAdmin(name)\` (or the helper in your launcher) to mint one.`)
      }
      console.log(`[aipehub-web] workers: ${url}/`)
      resolve({
        host,
        port: actualPort,
        url,
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
  space: Space
  sseClients: Set<SseClient>
  cookieSecure: boolean
  allowedHosts: Set<string> | undefined
  adminLoginLimiter: RateLimiter
}

/**
 * Tiny in-memory sliding-window rate limiter — sufficient for the
 * "small体验版" scale this codebase targets. Behind Caddy the client IP
 * comes from `X-Forwarded-For` (first hop); on bare localhost it falls
 * back to `req.socket.remoteAddress`. Replace with Redis when you have
 * a real fleet.
 */
class RateLimiter {
  private hits = new Map<string, number[]>()
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  /** true if allowed, false if over budget. Records the hit when allowed. */
  check(key: string): boolean {
    if (this.max <= 0) return true
    const now = Date.now()
    const list = this.hits.get(key) ?? []
    const fresh = list.filter((t) => now - t < this.windowMs)
    if (fresh.length >= this.max) {
      this.hits.set(key, fresh)
      return false
    }
    fresh.push(now)
    this.hits.set(key, fresh)
    return true
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  // Allow inline styles + scripts for the SPA. The static admin/worker
  // pages are first-party; no third-party loads. CSP could be tightened
  // further if the SPA is rewritten to drop inline event handlers.
  'content-security-policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'",
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd.length > 0) {
    const first = fwd.split(',')[0]?.trim()
    if (first) return first
  }
  return req.socket.remoteAddress ?? 'unknown'
}

/**
 * Reject cross-origin state-changing requests. Defence in depth on top of
 * SameSite cookies: a misconfigured browser or a same-site subdomain
 * attacker can sometimes get around SameSite=Lax for top-level POST. The
 * Origin (or Referer) and Host headers must agree.
 *
 * Returns true if request should be allowed, false if rejected (and 403
 * already written to res).
 */
function checkOrigin(
  ctx: HandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (!ctx.allowedHosts) return true                   // strict-check disabled
  const host = req.headers.host
  if (!host || !ctx.allowedHosts.has(host)) {
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('forbidden: untrusted host')
    return false
  }
  const origin = req.headers.origin
  if (origin) {
    let parsed: URL
    try { parsed = new URL(origin) } catch {
      res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden: bad origin'); return false
    }
    // protocol must match HTTPS posture, host must be on the allow-list
    const wantProto = ctx.cookieSecure ? 'https:' : null
    if (wantProto && parsed.protocol !== wantProto) {
      res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden: insecure origin'); return false
    }
    if (!ctx.allowedHosts.has(parsed.host)) {
      res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden: cross-origin'); return false
    }
  }
  // No Origin header on same-origin GET-form POSTs is fine; SameSite=Strict
  // already protects those once we're cookieSecure.
  return true
}

async function handle(
  ctx: HandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  const method = req.method ?? 'GET'

  // Security headers on every response (SSE excluded — no-cache already
  // disables intermediaries; CSP on SSE breaks nothing but adds nothing)
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v)

  // --- healthz (load balancer / systemd / uptime monitors) ----------------
  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }

  // --- CSRF defence: writes must originate from an allowed host ---------
  // GET/HEAD/OPTIONS are exempt (no side effects, browsers won't preflight
  // simple GETs anyway). For everything else, require Host + Origin match
  // when allowedHosts is configured.
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    if (!checkOrigin(ctx, req, res)) return
  }

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
    const config = await ctx.space.config()
    sendJson(res, {
      ...(await snapshotState(ctx.hub, ctx.space)),
      space: await ctx.space.meta(),
      config: { defaultLang: config.defaultLang, gating: config.gating },
    })
    return
  }

  // --- who am I -----------------------------------------------------------
  if (method === 'GET' && path === '/api/whoami') {
    const admin = await ctx.space.findAdminSession(readCookie(req, ADMIN_COOKIE))
    if (admin) {
      sendJson(res, { role: 'admin', id: admin.principalId })
      return
    }
    const workerSession = await ctx.space.findWorkerSession(readCookie(req, WORKER_COOKIE))
    if (workerSession) {
      const worker = (await ctx.space.workers()).find((w) => w.id === workerSession.principalId)
      if (worker) {
        // Auto-rehydrate: if the worker has a valid session but isn't live
        // in the registry (typical right after a host restart), register
        // them on the spot. This makes the file the truth — "I am known
        // in workers.json + my cookie is valid" === "I am present".
        if (!ctx.hub.participant(worker.id)) {
          ctx.hub.register(new HumanParticipant({ id: worker.id, capabilities: worker.capabilities }))
        }
        sendJson(res, { role: 'worker', id: worker.id, capabilities: worker.capabilities })
        return
      }
    }
    sendJson(res, { role: 'guest' })
    return
  }

  // --- admin login --------------------------------------------------------
  if (method === 'GET' && (path === '/admin' || path === '/admin/')) {
    const supplied = url.searchParams.get('token') ?? ''
    if (supplied) {
      const ip = clientIp(req)
      if (!ctx.adminLoginLimiter.check(ip)) {
        res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' })
        res.end('too many login attempts; try again in a minute')
        return
      }
      const admin = await ctx.space.verifyAdminToken(supplied)
      if (!admin) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('invalid token')
        return
      }
      const sid = randomBytes(24).toString('hex')
      await ctx.space.addAdminSession(sid, admin.id)
      res.writeHead(302, {
        'set-cookie': cookieValue(ADMIN_COOKIE, sid, ctx.cookieSecure),
        location: '/admin/',
      })
      res.end()
      return
    }
    const sess = await ctx.space.findAdminSession(readCookie(req, ADMIN_COOKIE))
    if (!sess) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><meta charset=utf-8><title>AipeHub admin</title><body style="font-family:sans-serif;max-width:30rem;margin:6rem auto;color:#333"><h1>401 — admin token required</h1><p>Open this page with <code>?token=YOUR_TOKEN</code> appended.</p></body>')
      return
    }
    await serveStatic(res, 'admin.html')
    return
  }

  // --- admin logout -------------------------------------------------------
  if (method === 'POST' && path === '/api/admin/logout') {
    const sid = readCookie(req, ADMIN_COOKIE)
    if (sid) await ctx.space.removeAdminSession(sid)
    res.writeHead(200, {
      'set-cookie': expireCookie(ADMIN_COOKIE, ctx.cookieSecure),
      'content-type': 'application/json; charset=utf-8',
    })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // --- admin: invite (mint a new admin) -----------------------------------
  // Sister-admin onboarding. The current admin POSTs { displayName }; the
  // server mints a fresh admin row + plaintext token and returns it ONCE.
  // The current admin shares the token with the invitee out-of-band (Signal /
  // 1Password / etc) — there is no email step on purpose.
  if (method === 'POST' && path === '/api/admin/admins') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const body = (await readJsonBody(req).catch(() => ({}))) as { displayName?: string }
    const displayName = (body.displayName ?? '').trim()
    if (!displayName) { sendJson(res, { error: 'displayName required' }, 400); return }
    if (displayName.length > 80) { sendJson(res, { error: 'displayName too long' }, 400); return }
    const { admin: created, token } = await ctx.space.createAdmin(displayName)
    sendJson(res, {
      ok: true,
      admin: { id: created.id, displayName: created.displayName, createdAt: created.createdAt },
      token,                // plaintext, shown ONCE
    })
    return
  }

  // --- admin: revoke another admin ---------------------------------------
  const revokeAdminMatch = path.match(/^\/api\/admin\/admins\/([^/]+)$/)
  if (method === 'DELETE' && revokeAdminMatch) {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const targetId = decodeURIComponent(revokeAdminMatch[1]!)
    // Don't let an admin lock themselves out by deleting their own row
    // while sessions still point at it — they can `logout` for that.
    if (targetId === admin.id) {
      sendJson(res, { error: 'cannot revoke yourself; use logout' }, 400)
      return
    }
    const remaining = (await ctx.space.admins()).filter((a) => a.id !== targetId)
    if (remaining.length === 0) {
      sendJson(res, { error: 'refusing to revoke last admin' }, 400)
      return
    }
    const ok = await ctx.space.removeAdmin(targetId)
    if (!ok) { sendJson(res, { error: `unknown admin ${targetId}` }, 404); return }
    sendJson(res, { ok: true })
    return
  }

  // --- admin: applications -----------------------------------------------
  if (method === 'GET' && path === '/api/admin/applications') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    sendJson(res, { applications: ctx.hub.pendingApplications() })
    return
  }

  const approveMatch = path.match(/^\/api\/admin\/applications\/([^/]+)\/approve$/)
  if (method === 'POST' && approveMatch) {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const appId = decodeURIComponent(approveMatch[1]!)
    const ok = ctx.hub.approveApplication(appId, admin.id)
    if (!ok) { sendJson(res, { error: `unknown application ${appId}` }, 404); return }
    sendJson(res, { ok: true })
    return
  }

  const rejectAppMatch = path.match(/^\/api\/admin\/applications\/([^/]+)\/reject$/)
  if (method === 'POST' && rejectAppMatch) {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const appId = decodeURIComponent(rejectAppMatch[1]!)
    const body = (await readJsonBody(req).catch(() => ({}))) as { reason?: string }
    const ok = ctx.hub.rejectApplication(appId, body?.reason || 'rejected by admin', admin.id)
    if (!ok) { sendJson(res, { error: `unknown application ${appId}` }, 404); return }
    sendJson(res, { ok: true })
    return
  }

  // --- admin: dispatch ----------------------------------------------------
  if (method === 'POST' && path === '/api/admin/dispatch') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const body = (await readJsonBody(req).catch(() => ({}))) as {
      strategy?: DispatchStrategy
      payload?: unknown
      title?: string
      priority?: number
    }
    if (!body?.strategy) { sendJson(res, { error: 'missing strategy' }, 400); return }
    ctx.hub.dispatch({
      from: admin.id,
      strategy: body.strategy,
      payload: body.payload ?? {},
      title: body.title,
      priority: body.priority,
    }).catch((err) => console.error('[aipehub-web] dispatch failed:', err))
    sendJson(res, { ok: true })
    return
  }

  // --- admin: retry -------------------------------------------------------
  const retryMatch = path.match(/^\/api\/admin\/tasks\/([^/]+)\/retry$/)
  if (method === 'POST' && retryMatch) {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const taskId = decodeURIComponent(retryMatch[1]!)
    try {
      ctx.hub.retry(taskId, admin.id).catch((err) =>
        console.error('[aipehub-web] retry failed:', err),
      )
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400)
      return
    }
    sendJson(res, { ok: true })
    return
  }

  // --- admin: evaluation --------------------------------------------------
  if (method === 'POST' && path === '/api/admin/evaluate') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const body = (await readJsonBody(req).catch(() => ({}))) as {
      taskId?: TaskId
      rating?: number
      comment?: string
    }
    if (!body?.taskId) { sendJson(res, { error: 'missing taskId' }, 400); return }
    const ev = ctx.hub.evaluate({
      taskId: body.taskId,
      by: admin.id,
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
      sendJson(res, { error: `id '${body.id}' is already live in this space` }, 409)
      return
    }
    const caps = Array.isArray(body.capabilities) ? body.capabilities : []
    // If the worker exists in workers.json already (returning after a leave),
    // we'd need their old token to re-claim. v2.0: simplest UX — disallow
    // re-creating an existing worker id; ask them to pick another or hand
    // them an admin recovery flow later.
    const known = await ctx.space.workers()
    if (known.some((w) => w.id === body.id)) {
      sendJson(res, { error: `id '${body.id}' is reserved by another session — pick another nickname` }, 409)
      return
    }
    const { worker, token } = await ctx.space.createWorker(body.id, caps)
    const human = new HumanParticipant({ id: worker.id, capabilities: worker.capabilities })
    ctx.hub.register(human)
    const sid = randomBytes(24).toString('hex')
    await ctx.space.addWorkerSession(sid, worker.id)
    res.writeHead(200, {
      'set-cookie': cookieValue(WORKER_COOKIE, sid, ctx.cookieSecure),
      'content-type': 'application/json; charset=utf-8',
    })
    res.end(JSON.stringify({
      ok: true,
      id: worker.id,
      capabilities: worker.capabilities,
      // The plaintext token is never used by the browser, but we surface it
      // so a CLI worker (or curl test) can authenticate without cookies.
      token,
    }))
    return
  }

  // --- worker: leave ------------------------------------------------------
  const workerLeave = path.match(/^\/api\/workers\/([^/]+)$/)
  if (method === 'DELETE' && workerLeave) {
    const sid = readCookie(req, WORKER_COOKIE)
    const sess = await ctx.space.findWorkerSession(sid)
    const id = decodeURIComponent(workerLeave[1]!)
    if (!sess || sess.principalId !== id) {
      sendJson(res, { error: 'not your worker session' }, 403)
      return
    }
    const p = ctx.hub.participant(id)
    if (p && p.kind === 'human') ctx.hub.unregister(id)
    await ctx.space.removeWorker(id)
    if (sid) await ctx.space.removeWorkerSession(sid)
    res.writeHead(200, {
      'set-cookie': expireCookie(WORKER_COOKIE, ctx.cookieSecure),
      'content-type': 'application/json; charset=utf-8',
    })
    res.end(JSON.stringify({ ok: true }))
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

async function requireAdmin(
  ctx: HandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<AdminRecord | null> {
  // Bearer token: verify against admins.json directly (for CLI callers).
  // Rate-limited like the browser login path — same anti-bruteforce budget.
  const bearer = readBearer(req)
  if (bearer) {
    if (!ctx.adminLoginLimiter.check(clientIp(req))) {
      res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' })
      res.end('too many auth attempts; try again in a minute')
      return null
    }
    const admin = await ctx.space.verifyAdminToken(bearer)
    if (admin) return admin
  }
  // Cookie-based session (no rate limit — cookie is already a signed-in proof)
  const sid = readCookie(req, ADMIN_COOKIE)
  const sess = await ctx.space.findAdminSession(sid)
  if (sess) {
    const admins = await ctx.space.admins()
    const a = admins.find((x) => x.id === sess.principalId)
    if (a) return a
  }
  sendJson(res, { error: 'admin auth required' }, 401)
  return null
}

function cookieValue(name: string, value: string, secure: boolean): string {
  // Production (HTTPS): Secure + Strict — refuses to send the cookie on any
  // cross-site navigation, which closes the main remaining CSRF gap that
  // SameSite=Lax leaves open (top-level GET-form POST).
  // Dev (HTTP / LAN): no Secure, Lax — allows opening admin URL from email /
  // chat links during onboarding.
  const sameSite = secure ? 'Strict' : 'Lax'
  const sec = secure ? '; Secure' : ''
  return `${name}=${value}; HttpOnly; SameSite=${sameSite}${sec}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`
}
function expireCookie(name: string, secure: boolean): string {
  const sameSite = secure ? 'Strict' : 'Lax'
  const sec = secure ? '; Secure' : ''
  return `${name}=; HttpOnly; SameSite=${sameSite}${sec}; Path=/; Max-Age=0`
}

// --- snapshot / lookup -----------------------------------------------------

async function snapshotState(hub: Hub, space: Space) {
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
  // Surface the known persona registry too (worker.json + agents.json) so
  // the admin UI can show "people we've seen" not just "people currently
  // online".
  const knownAdmins = (await space.admins()).map((a) => publicAdmin(a))
  const knownWorkers = (await space.workers()).map((w) => publicWorker(w))
  return {
    participants,
    transcript: hub.transcript.all(),
    pending,
    pendingApplications: hub.pendingApplications(),
    tasks: hub.tasks(),
    known: { admins: knownAdmins, workers: knownWorkers },
  }
}

function publicAdmin(a: AdminRecord) {
  return { id: a.id, displayName: a.displayName, createdAt: a.createdAt }
}
function publicWorker(w: WorkerRecord) {
  return {
    id: w.id,
    capabilities: w.capabilities,
    createdAt: w.createdAt,
    lastSeen: w.lastSeen,
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
      try { resolve(JSON.parse(buf)) }
      catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}
