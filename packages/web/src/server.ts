import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  HumanParticipant,
  createLogger,
  type AdminRecord,
  type AgentRecord,
  type DispatchStrategy,
  type Hub,
  type ManagedAgentLifecycle,
  type ManagedAgentSpec,
  type ParticipantId,
  type Space,
  type TaskId,
  type WorkerRecord,
} from '@aipehub/core'

const log = createLogger('web')

import {
  AGENT_SCHEMA_V1,
  TEAM_SCHEMA_V1,
  ManifestError,
  parseManifest,
  renderAgentManifest,
  validateUsesArray,
  type ParsedAgent,
} from './manifest.js'

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
  /**
   * Optional managed-agent lifecycle. The host process passes its
   * `AgentSupervisor` here; the Web layer then calls `lifecycle.start
   * (record)` after persisting a new agent and `lifecycle.stop(id)`
   * before removing one. Without this, the agent management API still
   * **persists** records to disk, but no live participant is registered
   * on the Hub — useful for embedded use without a supervisor (e.g.
   * tests).
   */
  lifecycle?: ManagedAgentLifecycle
  /**
   * Optional workflow controller. The host wires this to
   * `@aipehub/workflow` so the admin UI can list / import workflows
   * without the Web package taking a runtime dep on the workflow
   * runner. When absent, the workflow API endpoints return 404.
   */
  workflows?: WorkflowSurface
}

/**
 * Public surface the Web layer talks to when answering workflow API
 * calls. Implemented by the host (`packages/host/src/workflow-controller.ts`)
 * — kept as a duck-typed interface here so `@aipehub/web` does not pull
 * `@aipehub/workflow` into its dependency closure.
 */
export interface WorkflowSurface {
  list(): Promise<WorkflowSummary[]>
  /**
   * Parse the supplied YAML / JSON, write it to the on-disk definitions
   * directory, and register a live `WorkflowRunner` on the Hub. Returns
   * the summary of the newly-loaded workflow.
   *
   * Throws on schema errors (the Web layer surfaces `err.message`
   * verbatim) or when the workflow id already exists. The host
   * implementation guarantees atomic writes (tmp + rename).
   */
  importFromText(text: string): Promise<WorkflowSummary>
  /**
   * Unregister a loaded workflow and delete its YAML file from disk.
   * Throws if the id is unknown. In-flight tasks already dispatched to
   * the runner are not cancelled; the Hub finishes them normally.
   */
  remove(id: string): Promise<void>
  /**
   * List recorded runs from disk, newest first. Pass `workflowId` to
   * narrow to a single workflow. `limit` caps the result count.
   */
  listRuns(opts?: { workflowId?: string; limit?: number }): Promise<WorkflowRunSummary[]>
  /**
   * Full run record for a given runId, including per-step output and
   * `finalOutput` / `error`. Returns `null` when no such run exists.
   */
  readRun(runId: string): Promise<unknown>
}

export interface WorkflowSummary {
  id: string
  participantId: string
  name?: string
  description?: string
  triggerCapability: string
  stepCount: number
  /**
   * Absolute path of the YAML file backing this workflow on disk, or
   * `null` if the runner was registered programmatically (no file).
   */
  file: string | null
}

/**
 * Slim projection of a workflow run for the admin "run history" list.
 * Structurally compatible with `@aipehub/workflow`'s `RunSummary` type
 * but duplicated here so the Web layer stays decoupled from the
 * workflow runtime.
 */
export interface WorkflowRunSummary {
  runId: string
  workflowId: string
  triggeredByTaskId: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  startedAt: number
  endedAt?: number
  stepCount: number
  error?: string
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
    lifecycle: opts.lifecycle,
    workflows: opts.workflows,
  }

  const server = createServer((req, res) => {
    handle(ctx, req, res).catch((err) => {
      log.error('handler threw', { url: req.url, method: req.method, err })
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
      log.info('listening', { url })
      const admins = await space.admins()
      if (admins.length > 0) {
        log.info('admins configured', {
          count: admins.length,
          adminUrl: `${url}/admin?token=<TOKEN>`,
        })
      } else {
        log.info('no admins yet — run Space.createAdmin(name) to mint one')
      }
      log.info('worker URL', { url: `${url}/` })
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
  lifecycle: ManagedAgentLifecycle | undefined
  workflows: WorkflowSurface | undefined
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
    const adminSession = await ctx.space.findAdminSession(readCookie(req, ADMIN_COOKIE))
    if (adminSession) {
      const adminRow = (await ctx.space.admins()).find((a) => a.id === adminSession.principalId)
      sendJson(res, {
        role: 'admin',
        id: adminSession.principalId,
        contributionOptOut: adminRow?.contributionOptOut ?? false,
      })
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
        sendJson(res, {
          role: 'worker',
          id: worker.id,
          capabilities: worker.capabilities,
          contributionOptOut: worker.contributionOptOut ?? false,
        })
        return
      }
    }
    sendJson(res, { role: 'guest' })
    return
  }

  // --- self-service contribution opt-out toggle --------------------------
  // Both admins and workers can flip their own preference. Affects only
  // tasks **they publish** afterward (per spec: opt-out is publisher-
  // scoped). Already-dispatched tasks keep whatever stamp they had.
  if (method === 'POST' && path === '/api/me/contribution-opt-out') {
    const body = (await readJsonBody(req).catch(() => ({}))) as { value?: boolean }
    if (typeof body.value !== 'boolean') {
      sendJson(res, { error: 'body must be { value: boolean }' }, 400)
      return
    }
    const adminSession = await ctx.space.findAdminSession(readCookie(req, ADMIN_COOKIE))
    if (adminSession) {
      const updated = await ctx.space.setAdminContributionOptOut(adminSession.principalId, body.value)
      if (!updated) { sendJson(res, { error: 'unknown admin' }, 404); return }
      sendJson(res, { ok: true, role: 'admin', contributionOptOut: updated.contributionOptOut ?? false })
      return
    }
    const workerSession = await ctx.space.findWorkerSession(readCookie(req, WORKER_COOKIE))
    if (workerSession) {
      const updated = await ctx.space.setWorkerContributionOptOut(workerSession.principalId, body.value)
      if (!updated) { sendJson(res, { error: 'unknown worker' }, 404); return }
      sendJson(res, { ok: true, role: 'worker', contributionOptOut: updated.contributionOptOut ?? false })
      return
    }
    sendJson(res, { error: 'sign in first' }, 401)
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

  // --- admin: workspace API-key secrets (v2.1) ---------------------------
  // Three endpoints let an admin manage workspace-level provider API
  // keys (anthropic, openai, …) through the browser. Keys are encrypted
  // at rest with AES-256-GCM (see `@aipehub/core/secrets.ts`). The
  // plaintext NEVER appears in a GET response — only the "is configured"
  // status. Listing per-agent overrides goes through the same secrets
  // file but its plaintext is set / cleared via the agent edit form.

  if (method === 'GET' && path === '/api/admin/secrets') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
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
    return
  }

  const setSecretMatch = path.match(/^\/api\/admin\/secrets\/([^/]+)$/)
  if (method === 'PUT' && setSecretMatch) {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const provider = decodeURIComponent(setSecretMatch[1]!)
    if (provider !== 'anthropic' && provider !== 'openai') {
      sendJson(res, { error: `unknown provider '${provider}'` }, 400)
      return
    }
    const body = (await readJsonBody(req).catch(() => ({}))) as { apiKey?: string }
    if (typeof body.apiKey !== 'string' || body.apiKey.length === 0) {
      sendJson(res, { error: 'body must be { apiKey: "..." }' }, 400)
      return
    }
    await ctx.space.setProviderApiKey(provider, body.apiKey)
    // Spawning of already-running agents doesn't pick up new keys until
    // they're restarted; tell the operator clearly. Future managed
    // agents will see the new key automatically.
    sendJson(res, { ok: true, note: 'workspace key updated; restart affected agents to apply' })
    return
  }

  if (method === 'DELETE' && setSecretMatch) {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const provider = decodeURIComponent(setSecretMatch[1]!)
    const ok = await ctx.space.removeProviderApiKey(provider)
    if (!ok) { sendJson(res, { error: `no key set for '${provider}'` }, 404); return }
    sendJson(res, { ok: true })
    return
  }

  // --- admin: managed agents (v2.1) --------------------------------------
  // Six routes that let an admin manage the host's in-process LLM-agent
  // pool from the browser. The pool is materialised by an `AgentSupervisor`
  // running in the host process; we talk to it via the optional `lifecycle`
  // hook passed on `serveWeb({ lifecycle })`. Without a lifecycle these
  // endpoints still persist records (so the next host boot would replay
  // them) but no live participant is spawned in this process — useful
  // for embedded tests.

  // List all managed agents currently in agents.json. Public to admins.
  if (method === 'GET' && path === '/api/admin/agents') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const agents = await ctx.space.agents()
    const liveIds = new Set(ctx.hub.participants().map((p) => p.id))
    sendJson(res, {
      agents: agents.map((a) => ({
        id: a.id,
        allowedCapabilities: a.allowedCapabilities,
        displayName: a.displayName,
        managed: a.managed,             // undefined for externally-connected agents
        createdAt: a.createdAt,
        lastSeen: a.lastSeen,
        online: liveIds.has(a.id),
      })),
    })
    return
  }

  // What providers can the host actually spawn right now (based on env)?
  if (method === 'GET' && path === '/api/admin/agents/providers') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    // No lifecycle → no managed agents possible → empty list.
    const providers = ctx.lifecycle ? await ctx.lifecycle.availableProviders() : []
    sendJson(res, { providers })
    return
  }

  // Create one managed agent. Body = ParsedAgent shape (id / caps /
  // managed). On success the lifecycle.start spawns the live LlmAgent.
  if (method === 'POST' && path === '/api/admin/agents') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>
    let parsed: ParsedAgent
    try {
      parsed = validateAgentBody(body)
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400)
      return
    }
    if ((await ctx.space.agents()).some((a) => a.id === parsed.id)) {
      sendJson(res, { error: `agent '${parsed.id}' already exists; use PUT to edit` }, 409)
      return
    }
    // Provider availability check is **soft** now: a missing key is OK
    // because the caller can attach a per-agent override on this same
    // POST via the `apiKey` field. We only block if neither workspace
    // default, env, nor per-agent override is present.
    if (ctx.lifecycle) {
      const avail = new Set(await ctx.lifecycle.availableProviders())
      const hasApiKey = typeof (body as { apiKey?: unknown }).apiKey === 'string' && (body as { apiKey?: string }).apiKey!.length > 0
      if (!avail.has(parsed.managed.provider) && !hasApiKey) {
        sendJson(
          res,
          { error: `provider '${parsed.managed.provider}' has no API key (set a workspace default or attach one to this agent)` },
          400,
        )
        return
      }
      // openai-compatible has no workspace/env fallback by design (each
      // baseURL is a different vendor). Reject upfront if the caller
      // forgot the per-agent key instead of persisting a stub the host
      // will refuse to spawn on the next boot.
      if (parsed.managed.provider === 'openai-compatible' && !hasApiKey) {
        sendJson(
          res,
          { error: `provider 'openai-compatible' requires a per-agent apiKey (workspace keys don't apply)` },
          400,
        )
        return
      }
    }
    const record = await ctx.space.upsertAgent({
      id: parsed.id,
      allowedCapabilities: parsed.capabilities,
      displayName: parsed.displayName,
      managed: parsed.managed,
    })
    // If the body carries a per-agent apiKey, save it before spawning
    // so the pool's resolveApiKey() finds it. The plaintext is encrypted
    // on disk; it never appears in any subsequent response.
    const inlineKey = (body as { apiKey?: string }).apiKey
    if (typeof inlineKey === 'string' && inlineKey.length > 0) {
      await ctx.space.setAgentApiKey(parsed.id, inlineKey)
    }
    if (ctx.lifecycle) {
      try {
        await ctx.lifecycle.start(record)
      } catch (err) {
        // Persist the record but tell the caller spawn failed — they can
        // edit + retry without re-uploading the manifest.
        sendJson(res, {
          ok: false,
          warning: 'persisted but failed to spawn',
          error: err instanceof Error ? err.message : String(err),
        }, 500)
        return
      }
    }
    sendJson(res, { ok: true, agent: publicAgent(record, ctx.hub) })
    return
  }

  // Bulk import from a manifest (YAML or JSON in the request body — the
  // parser sniffs the format). Returns the list of created agents.
  if (method === 'POST' && path === '/api/admin/agents/import') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const raw = await readTextBody(req).catch(() => '')
    if (!raw) { sendJson(res, { error: 'empty body' }, 400); return }
    let manifest
    try {
      manifest = parseManifest(raw)
    } catch (err) {
      const msg = err instanceof ManifestError ? err.message : (err instanceof Error ? err.message : String(err))
      sendJson(res, { error: msg }, 400)
      return
    }
    const existing = new Set((await ctx.space.agents()).map((a) => a.id))
    const skipped: string[] = []
    const created: AgentRecord[] = []
    const avail = ctx.lifecycle ? new Set(await ctx.lifecycle.availableProviders()) : null
    for (const a of manifest.agents) {
      if (existing.has(a.id)) { skipped.push(a.id); continue }
      // Import doesn't carry per-agent keys (templates never embed them),
      // so we still hard-block on missing keys. Hint how to fix.
      if (avail && !avail.has(a.managed.provider)) {
        sendJson(res, {
          error: `agent '${a.id}' uses provider '${a.managed.provider}' but no key is configured — set the workspace default first, then re-import`,
        }, 400)
        return
      }
      const rec = await ctx.space.upsertAgent({
        id: a.id,
        allowedCapabilities: a.capabilities,
        displayName: a.displayName,
        managed: a.managed,
      })
      created.push(rec)
      existing.add(a.id)
    }
    // Best-effort spawn pass. Failures are collected but don't roll back
    // the persisted records — operator can retry via the edit path.
    const spawnErrors: { id: string; error: string }[] = []
    if (ctx.lifecycle) {
      for (const rec of created) {
        try { await ctx.lifecycle.start(rec) }
        catch (err) {
          spawnErrors.push({ id: rec.id, error: err instanceof Error ? err.message : String(err) })
        }
      }
    }
    sendJson(res, {
      ok: true,
      created: created.map((r) => publicAgent(r, ctx.hub)),
      skipped,
      spawnErrors,
      team: manifest.schema === TEAM_SCHEMA_V1
        ? { name: manifest.teamName, description: manifest.teamDescription }
        : undefined,
    })
    return
  }

  // --- workflows (v2.1) ------------------------------------------------
  // The Web layer does not depend on `@aipehub/workflow` directly — it
  // talks to `ctx.workflows` (a duck-typed `WorkflowSurface`) which the
  // host wires up. When the surface is absent (embedded use, tests
  // without the workflow runner), these endpoints respond 404 so the
  // admin UI can hide the panel.

  if (method === 'GET' && path === '/api/admin/workflows') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return
    }
    try {
      const list = await ctx.workflows.list()
      sendJson(res, { workflows: list })
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return
  }

  if (method === 'POST' && path === '/api/admin/workflows/import') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return
    }
    const raw = await readTextBody(req).catch(() => '')
    if (!raw) { sendJson(res, { error: 'empty body' }, 400); return }
    try {
      const summary = await ctx.workflows.importFromText(raw)
      sendJson(res, { ok: true, workflow: summary })
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400)
    }
    return
  }

  // List recorded workflow runs. Both /runs and /runs/:id are wired
  // before the catch-all DELETE /:id route so a runId can never get
  // routed as a workflow id.
  if (method === 'GET' && path === '/api/admin/workflows/runs') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return
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
    return
  }

  const readRunMatch = path.match(/^\/api\/admin\/workflows\/runs\/([^/]+)$/)
  if (method === 'GET' && readRunMatch) {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return
    }
    const runId = decodeURIComponent(readRunMatch[1]!)
    try {
      const run = await ctx.workflows.readRun(runId)
      if (run == null) {
        sendJson(res, { error: `unknown run '${runId}'` }, 404)
        return
      }
      sendJson(res, { run })
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return
  }

  const deleteWorkflowMatch = path.match(/^\/api\/admin\/workflows\/([^/]+)$/)
  if (method === 'DELETE' && deleteWorkflowMatch) {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return
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
    return
  }

  // Edit one. Same body shape as POST. Lifecycle.start on the new
  // record reloads the live agent (stop+start).
  const editAgentMatch = path.match(/^\/api\/admin\/agents\/([^/]+)$/)
  if (method === 'PUT' && editAgentMatch) {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const id = decodeURIComponent(editAgentMatch[1]!)
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>
    // Lock id from the URL — body can't rename. Saves a class of bugs.
    body.id = id
    let parsed: ParsedAgent
    try {
      parsed = validateAgentBody(body)
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400)
      return
    }
    const existing = (await ctx.space.agents()).find((a) => a.id === id)
    if (!existing) { sendJson(res, { error: `unknown agent '${id}'` }, 404); return }
    if (ctx.lifecycle) {
      const avail = new Set(await ctx.lifecycle.availableProviders())
      const hasInlineKey = typeof (body as { apiKey?: unknown }).apiKey === 'string' && (body as { apiKey?: string }).apiKey!.length > 0
      const hasStoredKey = (await ctx.space.getAgentApiKey(id).catch(() => null)) !== null
      if (!avail.has(parsed.managed.provider) && !hasInlineKey && !hasStoredKey) {
        sendJson(
          res,
          { error: `provider '${parsed.managed.provider}' has no API key` },
          400,
        )
        return
      }
      // openai-compatible-specific: edit can't strip the per-agent key.
      // The `apiKey` field has tri-state semantics: undefined = keep
      // current, "" = clear, "<non-empty>" = replace. We compute the
      // post-edit state and reject if it leaves an openai-compatible
      // agent without any key (since workspace/env can't cover for it).
      if (parsed.managed.provider === 'openai-compatible') {
        const editKey = (body as { apiKey?: unknown }).apiKey
        const willClear = editKey === ''
        const willSet = typeof editKey === 'string' && editKey.length > 0
        const willHaveKey = willSet || (!willClear && hasStoredKey)
        if (!willHaveKey) {
          sendJson(
            res,
            { error: `provider 'openai-compatible' requires a per-agent apiKey (workspace keys don't apply)` },
            400,
          )
          return
        }
      }
    }
    const record = await ctx.space.upsertAgent({
      id,
      allowedCapabilities: parsed.capabilities,
      displayName: parsed.displayName,
      managed: parsed.managed,
    })
    // PUT can rotate (or remove) the per-agent key. `apiKey: ""` means
    // "remove the override and fall back to workspace / env".
    const editKey = (body as { apiKey?: string }).apiKey
    if (typeof editKey === 'string') {
      if (editKey.length === 0) {
        await ctx.space.removeAgentApiKey(id).catch(() => { /* no-op */ })
      } else {
        await ctx.space.setAgentApiKey(id, editKey)
      }
    }
    if (ctx.lifecycle) {
      try {
        await ctx.lifecycle.start(record)   // reload semantics: stop+start
      } catch (err) {
        sendJson(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
        return
      }
    }
    sendJson(res, { ok: true, agent: publicAgent(record, ctx.hub) })
    return
  }

  // Remove. Lifecycle.stop first so the live agent leaves the registry,
  // then erase from agents.json. A managed agent that fails to stop
  // (e.g. its provider is mid-call) is still removed from disk — the
  // next boot won't bring it back.
  if (method === 'DELETE' && editAgentMatch) {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const id = decodeURIComponent(editAgentMatch[1]!)
    if (ctx.lifecycle) {
      await ctx.lifecycle.stop(id).catch((err) => log.error('lifecycle stop failed', { id, err }))
    }
    const ok = await ctx.space.removeAgent(id)
    if (!ok) { sendJson(res, { error: `unknown agent '${id}'` }, 404); return }
    sendJson(res, { ok: true })
    return
  }

  // Download one agent as a v1 manifest. JSON only (YAML round-trip is
  // not needed for export — the user can convert if they like).
  const exportAgentMatch = path.match(/^\/api\/admin\/agents\/([^/]+)\/export$/)
  if (method === 'GET' && exportAgentMatch) {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const id = decodeURIComponent(exportAgentMatch[1]!)
    const rec = (await ctx.space.agents()).find((a) => a.id === id)
    if (!rec) { sendJson(res, { error: `unknown agent '${id}'` }, 404); return }
    if (!rec.managed) {
      sendJson(res, { error: `agent '${id}' is externally-connected (no managed spec to export)` }, 400)
      return
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${encodeURIComponent(id)}.aipehub-agent.json"`,
    })
    res.end(JSON.stringify(renderAgentManifest(rec), null, 2))
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
      weight?: number
      countContribution?: boolean
      /**
       * If `true`, the server awaits the dispatch result before answering
       * (subject to `timeoutMs`). Default `false` keeps the historic
       * fire-and-forget behaviour for the admin SPA. The MCP server uses
       * `wait: true` so a tool call can return the actual TaskResult.
       */
      wait?: boolean
      /** Max ms to wait when `wait: true`. Defaults to 60_000. Clamped to [1000, 600_000]. */
      timeoutMs?: number
    }
    if (!body?.strategy) { sendJson(res, { error: 'missing strategy' }, 400); return }
    // The publisher's saved preference defaults the task's flag. An
    // explicit `countContribution` in the request body overrides per-call
    // (lets future UI offer "ad-hoc opt-out for this one task" without
    // toggling the global switch). `false` from preference + `true` from
    // request body == counted; vice versa == opted-out.
    const publisherDefault = admin.contributionOptOut ? false : true
    const countContribution =
      typeof body.countContribution === 'boolean' ? body.countContribution : publisherDefault
    const dispatchOpts = {
      from: admin.id,
      strategy: body.strategy,
      payload: body.payload ?? {},
      title: body.title,
      priority: body.priority,
      weight: body.weight,
      countContribution,
    }
    if (body.wait === true) {
      const rawTimeout = typeof body.timeoutMs === 'number' ? body.timeoutMs : 60_000
      const timeoutMs = Math.max(1000, Math.min(600_000, rawTimeout))
      try {
        const result = await Promise.race([
          ctx.hub.dispatch(dispatchOpts),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('dispatch wait timeout')), timeoutMs),
          ),
        ])
        sendJson(res, { ok: true, result })
      } catch (err) {
        sendJson(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 504)
      }
      return
    }
    ctx.hub.dispatch(dispatchOpts).catch((err) => log.error('dispatch failed', { err }))
    sendJson(res, { ok: true })
    return
  }

  // --- leaderboard (visible to admins AND workers — visibility is the
  //     point: "everyone sees everyone's contributions"). Optional `from`
  //     / `to` query params; default = all-time. ------------------------
  if (method === 'GET' && path === '/api/leaderboard') {
    const from = parseTsParam(url.searchParams.get('from'))
    const to = parseTsParam(url.searchParams.get('to'))
    sendJson(res, ctx.hub.leaderboard({ from, to }))
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
        log.error('retry failed', { taskId, err }),
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

/**
 * Read the body as raw text. Used by /api/admin/agents/import which
 * accepts either YAML or JSON. Same 1MB cap as `readJsonBody` so a
 * runaway upload can't OOM the server.
 */
function readTextBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (chunk) => {
      buf += chunk
      if (buf.length > 1_000_000) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => resolve(buf))
    req.on('error', reject)
  })
}

/**
 * Validate the POST/PUT body for /api/admin/agents. Accepts the same
 * `agent: {...}` shape as the v1 manifest (without the schema wrapper)
 * — that way the admin UI form posts the same fields it'd write into a
 * YAML file.
 */
function validateAgentBody(body: Record<string, unknown>): ParsedAgent {
  if (typeof body.id !== 'string' || body.id.length === 0) {
    throw new ManifestError(`id is required`)
  }
  if (body.id.length > 80) throw new ManifestError(`id too long`)
  if (!/^[a-zA-Z0-9_.:-]+$/.test(body.id)) {
    throw new ManifestError(`id may only contain letters, digits, '_', '.', ':', '-'`)
  }
  const caps = body.capabilities
  if (!Array.isArray(caps)) throw new ManifestError(`capabilities must be an array`)
  const capabilities: string[] = []
  for (const c of caps) {
    if (typeof c !== 'string' || c.length === 0) throw new ManifestError(`capabilities must contain non-empty strings`)
    capabilities.push(c)
  }
  const provider = body.provider
  if (
    provider !== 'anthropic' &&
    provider !== 'openai' &&
    provider !== 'openai-compatible' &&
    provider !== 'mock'
  ) {
    throw new ManifestError(`provider must be 'anthropic', 'openai', 'openai-compatible' or 'mock'`)
  }
  const system = body.system
  if (typeof system !== 'string' || system.length === 0) throw new ManifestError(`system is required`)
  // openai-compatible additionally requires a baseURL. We validate it
  // here so the API rejects bad inputs before they hit the supervisor.
  if (provider === 'openai-compatible') {
    if (typeof body.baseURL !== 'string' || body.baseURL.length === 0) {
      throw new ManifestError(`baseURL is required when provider is 'openai-compatible'`)
    }
  }
  const managed: ManagedAgentSpec = { kind: 'llm', provider, system }
  if (typeof body.model === 'string' && body.model.length > 0) managed.model = body.model
  if (typeof body.weightDefault === 'number' && Number.isFinite(body.weightDefault)) {
    managed.weightDefault = body.weightDefault
  }
  if (provider === 'openai-compatible') {
    managed.baseURL = body.baseURL as string
    if (typeof body.providerLabel === 'string' && body.providerLabel.length > 0) {
      managed.providerLabel = body.providerLabel
    }
  }
  // Hub Services declarations (v2.2). Same plugin-agnostic checks as
  // the manifest path — both routes must accept identical shapes so
  // an admin can switch between "paste YAML" and "fill the form"
  // without losing any field.
  if (body.uses !== undefined) {
    managed.uses = validateUsesArray(body.uses, 'uses')
  }
  const out: ParsedAgent = { id: body.id, capabilities, managed }
  if (typeof body.displayName === 'string') out.displayName = body.displayName
  return out
}

/** Public-safe projection of an AgentRecord for the API. */
function publicAgent(rec: AgentRecord, hub: Hub) {
  return {
    id: rec.id,
    allowedCapabilities: rec.allowedCapabilities,
    displayName: rec.displayName,
    managed: rec.managed,
    createdAt: rec.createdAt,
    lastSeen: rec.lastSeen,
    online: hub.participant(rec.id) != null,
  }
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

/**
 * Parse a `?from=` / `?to=` query param as a UNIX-ms timestamp. Returns
 * `undefined` for missing or unparseable inputs so the Hub's defaults
 * (`from=0`, `to=now+1`) take over.
 */
function parseTsParam(raw: string | null): number | undefined {
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return undefined
  return n
}
