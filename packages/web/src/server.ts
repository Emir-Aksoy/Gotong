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
  type FeedbackQuery,
  type GrowthReportsAdminSurface,
  type Hub,
  type ManagedAgentLifecycle,
  type ManagedAgentSpec,
  type ParticipantId,
  type ServiceTrashRef,
  type ServicesAdminSurface,
  type Space,
  type TaskId,
  type WorkerRecord,
} from '@aipehub/core'
import { PROTOCOL_VERSION } from '@aipehub/protocol'

const log = createLogger('web')

import {
  AGENT_SCHEMA_V1,
  BUNDLE_SCHEMA_V1,
  TEAM_SCHEMA_V1,
  ManifestError,
  parseBundle,
  parseManifest,
  renderAgentManifest,
  validateUsesArray,
  type ParsedAgent,
} from './manifest.js'
import { STATIC_ASSETS_BASE64 } from './static-assets.js'
import {
  handleIdentityRoute,
  type IdentitySurface,
} from './identity-routes.js'

export type {
  IdentitySurface,
  IdentityRole,
  IdentityUserDTO,
  IdentitySessionDTO,
  IdentityCredentialDTO,
  IdentityResolved,
  IdentityAuditActorSource,
  IdentityAuditLogEntryDTO,
} from './identity-routes.js'

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
// dist/server.js is one level below the package root, so the static dir is ../static.
// Only used as a development fallback when STATIC_ASSETS_BASE64 is empty (i.e.
// someone is running source-tree files directly without first running
// `pnpm -C packages/web build:assets`). Production builds — npm install,
// docker, bun --compile single-file binary — all serve from the embedded
// in-memory map below.
const STATIC_DIR = join(__dirname, '..', 'static')

// Decode-once cache. The base64 map is constant; the first request per asset
// pays the decode cost, every subsequent request gets a cached Buffer. Using
// the global Buffer (Node + Bun both have it) keeps this runtime-agnostic.
const STATIC_ASSETS_CACHE = new Map<string, Buffer>()

function getEmbeddedAsset(name: string): Buffer | undefined {
  const cached = STATIC_ASSETS_CACHE.get(name)
  if (cached) return cached
  const b64 = STATIC_ASSETS_BASE64[name]
  if (b64 === undefined) return undefined
  const buf = Buffer.from(b64, 'base64')
  STATIC_ASSETS_CACHE.set(name, buf)
  return buf
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Built-in templates (templates/bundles/*.yaml) are copied under
  // static/builtin-bundles/ at build time and served directly. The
  // text/* MIME lets the admin UI's bundle-import "use built-in" button
  // fetch and read them as plain text without binary decoding.
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
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
   * Per-IP rate limit on worker self-registration
   * (`POST /api/workers`). Default `{ max: 30, windowSec: 60 }`. Set
   * `max: 0` to disable.
   *
   * Worker creation is intentionally open so anyone can pick a
   * nickname and join the room without admin involvement, but without
   * a rate limit the same anonymous remote could mint thousands of
   * worker rows (each one persisted to `workers.json` + a live
   * `HumanParticipant` on the Hub) in seconds. The default budget is
   * generous enough that a real classroom rejoining doesn't trip
   * (~30 distinct nicknames per minute per IP) but cheap enough that
   * a script can't fill the workspace dir.
   */
  workerCreateRateLimit?: { max: number; windowSec: number }
  /**
   * Trust the `X-Forwarded-For` header when computing the per-request
   * client IP (used for rate-limit keying). Default `false`.
   *
   * Set this to `true` ONLY when the host is behind a reverse proxy
   * (Caddy, nginx, an LB) that you control and that overwrites or
   * appends to XFF reliably. With the default `false`, the rate limiter
   * keys on `socket.remoteAddress`, which is the proxy's IP — fine for
   * single-tenant deploys, but if you actually need per-real-client
   * rate limiting behind a proxy, flip this on.
   *
   * Important: when `false`, attackers cannot bypass the limiter by
   * spoofing XFF; when `true`, your proxy MUST overwrite the header
   * (do not pass through client-supplied XFF) or the limiter becomes
   * trivially bypassable.
   */
  trustProxy?: boolean
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
  /**
   * Optional Hub Services admin surface (PR-11). The host wires
   * `hubServices.asAdminSurface()` here. When absent, all
   * `/api/admin/services/...` endpoints return 503 so the admin UI
   * can hide the tab cleanly. Web has no runtime dep on
   * `@aipehub/services-sdk` — the surface is plain types in `@aipehub/core`.
   */
  services?: ServicesAdminSurface
  /**
   * Optional personal-growth reports admin surface (v2.4). The host
   * wires a `GrowthReportsAdmin` instance here when it has loaded
   * the personal-growth team. When absent, the two
   * `/api/admin/growth-reports*` endpoints return 503 so the admin
   * UI can hide the panel. Web has no runtime dep on the host —
   * the surface is plain types in `@aipehub/core`.
   */
  growthReports?: GrowthReportsAdminSurface
  /**
   * Optional readiness gate. When set, `GET /readyz` returns 200
   * once `isReady()` first returns true, and 503 with a JSON
   * `{ error: 'starting' }` body before then. Without this option
   * `/readyz` aliases `/healthz` (always 200) — backward-compatible.
   *
   * `/healthz` is **liveness** (the process is alive enough to answer
   * an HTTP request); `/readyz` is **readiness** (the process has
   * finished bootstrap and is ready to serve real traffic). Separating
   * the two lets a Kubernetes-style probe avoid restarting the pod
   * during the workflow-resume grace period (P6 in the v3.1 audit).
   *
   * The gate is read once per `/readyz` request — no caching — so a
   * caller can flip the flag freely. Typical use: start with
   * `{ isReady: () => false }`, then after `resumeRunningRuns()` and
   * any other boot work finishes, swap to `{ isReady: () => true }`.
   * Easiest pattern is a let-binding closure (see host main.ts).
   */
  readinessGate?: { isReady: () => boolean }
  /**
   * Optional v4 identity store. When set, `/api/admin/identity/*`
   * endpoints become live; without it those routes return 503 so the
   * admin UI can hide the user-management tab. Web takes no runtime
   * dep on `@aipehub/identity` — `IdentitySurface` is a structural
   * type in `./identity-routes`, satisfied by `IdentityStore` from
   * the package.
   *
   * The v4 IdentityStore session cookie (`aipehub_identity`) is also
   * accepted by `requireAdmin` as a fallback when no v3 cookie /
   * Bearer is present — this lets users who logged in via the v4
   * surface reach v3 admin endpoints with the same browser session.
   */
  identity?: IdentitySurface
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
  /**
   * Optional dispatch-form field schema (v2.4). When present, the
   * admin UI renders a workflow-specific dispatch form (one input
   * per field) instead of the generic JSON textarea. Shape mirrors
   * `PayloadFieldSpec` in `@aipehub/workflow`'s types — kept as
   * `unknown` here to avoid a runtime dep on the workflow package.
   */
  payloadSchema?: unknown
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
  const trustProxy = opts.trustProxy ?? false
  const rateLimitOpts = opts.adminLoginRateLimit ?? { max: 10, windowSec: 60 }
  const adminLoginLimiter = new RateLimiter(rateLimitOpts.max, rateLimitOpts.windowSec * 1000)
  const workerLimitOpts = opts.workerCreateRateLimit ?? { max: 30, windowSec: 60 }
  const workerCreateLimiter = new RateLimiter(
    workerLimitOpts.max,
    workerLimitOpts.windowSec * 1000,
  )
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
    trustProxy,
    adminLoginLimiter,
    workerCreateLimiter,
    lifecycle: opts.lifecycle,
    workflows: opts.workflows,
    services: opts.services,
    growthReports: opts.growthReports,
    readinessGate: opts.readinessGate,
    identity: opts.identity,
    httpStats: new HttpStats(),
  }

  const server = createServer((req, res) => {
    // Record the final status code as soon as the response is fully
    // flushed. 'finish' fires regardless of which writeHead the
    // handler took, so we capture all paths (200 OK / 4xx admin
    // rejects / 5xx handler throws / SSE clients that disconnected).
    // SSE streams emit 'close' but not 'finish' — we attach to both
    // so a long-lived SSE that errors mid-stream still gets counted.
    let recorded = false
    const recordOnce = () => {
      if (recorded) return
      recorded = true
      ctx.httpStats.record(res.statusCode)
    }
    res.on('finish', recordOnce)
    res.on('close', recordOnce)
    handle(ctx, req, res).catch((err) => {
      // H18: do NOT leak `err.message` to the client. It can carry
      // filesystem paths, SQL snippets, stack-trace residue — every one
      // of which helps an attacker map the deployment. Mint a short
      // request-id so an operator reading logs can still match the
      // user-visible 500 to the full trace. See AUDIT-v3.3.md finding
      // H18.
      const requestId = randomBytes(6).toString('hex')
      log.error('handler threw', {
        requestId,
        url: req.url,
        method: req.method,
        err,
      })
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(`internal server error (requestId=${requestId})`)
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

      // v2.5 — auto-register every admin as a HumanParticipant on the
      // Hub so they can RECEIVE tasks dispatched at them by `kind:
      // 'explicit', to: <admin-id>`. Workers already self-register on
      // /api/me; admins didn't have a parallel path because the
      // historical task surface only DISPATCHED from admins, never TO
      // them. HITL changes that: a PG interviewer that detects "info
      // too thin" sends a follow-up question task to the admin who
      // started the workflow run, and that dispatch returns
      // 'no_participant' unless the admin is sitting in the registry.
      // Registering here makes admins always present from boot — same
      // semantics as workers post-rehydrate.
      //
      // Capabilities: admins have an open-ended toolkit (they triage
      // everything), so we mark them as capability-less here. Agent-
      // question dispatches use `kind: explicit`, which doesn't
      // consult capabilities, so this doesn't affect routing.
      for (const a of admins) {
        if (!hub.participant(a.id)) {
          hub.register(new HumanParticipant({ id: a.id, capabilities: [] }))
        }
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
  trustProxy: boolean
  adminLoginLimiter: RateLimiter
  workerCreateLimiter: RateLimiter
  lifecycle: ManagedAgentLifecycle | undefined
  workflows: WorkflowSurface | undefined
  services: ServicesAdminSurface | undefined
  growthReports: GrowthReportsAdminSurface | undefined
  readinessGate: { isReady: () => boolean } | undefined
  identity: IdentitySurface | undefined
  /**
   * Counters incremented on every HTTP response. Surfaced via
   * `/api/admin/metrics` so Prometheus can compute 5xx-rate (and a
   * dashboard / alert can fire on \"something's wrong\" without
   * scraping nginx logs). Counts reset on host restart — Prometheus
   * expects counter resets and handles them via `rate()`.
   */
  httpStats: HttpStats
}

/**
 * Per-server response counters. Indexed by status_class (2xx / 3xx /
 * 4xx / 5xx) — a single-dimension axis keeps cardinality low. We
 * deliberately don't track per-route counters here: the AipeHub admin
 * surface has hundreds of endpoints (admin + worker + SSE + auth + …)
 * and routes that take ids in the path would explode label cardinality.
 *
 * Operators who need per-route visibility can put a reverse proxy
 * (Caddy / nginx) in front and scrape its logs — that's what those
 * layers are for. AipeHub's metrics are about \"is the host healthy\"
 * not \"is this specific endpoint slow.\"
 */
export class HttpStats {
  /** byStatusClass: '2xx' / '3xx' / '4xx' / '5xx' → count. */
  readonly byStatusClass = new Map<string, number>()

  /** Record a single response. Called from the server's 'finish' hook. */
  record(statusCode: number): void {
    if (!Number.isFinite(statusCode) || statusCode < 0) return
    // Status codes outside the 1xx-5xx range get bucketed into a synthetic
    // 'other' label so we don't drop them silently. Servers that emit
    // 0 (a quirk on some socket-closed-early paths) end up there too.
    const klass =
      statusCode >= 100 && statusCode < 600
        ? `${Math.floor(statusCode / 100)}xx`
        : 'other'
    this.byStatusClass.set(klass, (this.byStatusClass.get(klass) ?? 0) + 1)
  }
}

/** Default upper bound on the `hits` map; sweep is force-triggered above. */
export const DEFAULT_RATE_LIMITER_MAX_KEYS = 10_000

/**
 * Tiny in-memory sliding-window rate limiter — sufficient for the
 * "small体验版" scale this codebase targets. Behind Caddy the client IP
 * comes from `X-Forwarded-For` (first hop); on bare localhost it falls
 * back to `req.socket.remoteAddress`. Replace with Redis when you have
 * a real fleet.
 *
 * v3.4 hardening:
 *
 *   - H19: the underlying `hits` Map is periodically swept so an
 *     attacker rotating source IPs cannot grow the Map without bound.
 *     A `check()` call only GC's its OWN key's old timestamps; without
 *     the sweep, every never-revisited IP leaves an entry behind
 *     forever. Sweep fires when either `sweepIntervalMs` has elapsed
 *     or the Map crosses `maxKeys`. Worst-case memory is
 *     `O(maxKeys * max)` integers — under default settings that's a
 *     few MB, not gigabytes.
 *
 *   - H21: `peek` + `recordFailure` lets callers separate "is the
 *     budget exhausted?" from "this attempt failed". The admin-cookie
 *     lookup path uses them so a legitimate signed-in admin never
 *     consumes budget on a successful lookup — only attackers spraying
 *     random sids burn through it.
 *
 * See AUDIT-v3.3.md findings H19 and H21.
 *
 * @internal exported for direct unit tests; not re-exported from
 *   `@aipehub/web`'s package surface.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>()
  private lastSweep = Date.now()
  private readonly maxKeys: number
  private readonly sweepIntervalMs: number
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    opts: { maxKeys?: number; sweepIntervalMs?: number } = {},
  ) {
    this.maxKeys = opts.maxKeys ?? DEFAULT_RATE_LIMITER_MAX_KEYS
    // Default sweep cadence == one window. That bounds the lag between
    // a key's last hit expiring and the GC dropping its entry to a
    // single window.
    this.sweepIntervalMs = opts.sweepIntervalMs ?? windowMs
  }
  /** true if allowed, false if over budget. Records the hit when allowed. */
  check(key: string): boolean {
    this.maybeSweep()
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
  /**
   * Inspect the budget without recording a hit. Used by the admin-cookie
   * lookup path (H21) so a legitimate signed-in admin doesn't burn quota
   * just by being authenticated — only failed lookups call
   * {@link recordFailure}.
   */
  peek(key: string): boolean {
    this.maybeSweep()
    if (this.max <= 0) return true
    const now = Date.now()
    const list = this.hits.get(key) ?? []
    const fresh = list.filter((t) => now - t < this.windowMs)
    // Keep the freshened list — saves the next call from re-filtering
    // and matters for sweep correctness when the window has passed.
    if (fresh.length !== list.length) this.hits.set(key, fresh)
    return fresh.length < this.max
  }
  /**
   * Record a failed attempt. Counterpart to {@link peek}. Use only when
   * the auth attempt definitely failed — successful lookups should not
   * count against the attacker's quota for a given IP.
   */
  recordFailure(key: string): void {
    if (this.max <= 0) return
    this.maybeSweep()
    const now = Date.now()
    const list = this.hits.get(key) ?? []
    const fresh = list.filter((t) => now - t < this.windowMs)
    fresh.push(now)
    this.hits.set(key, fresh)
  }
  /** Test-only — expose the Map size so the H19 GC regression can assert it. */
  size(): number {
    return this.hits.size
  }
  /**
   * Drop entries whose hits have all expired. Called implicitly at the
   * head of every public method; the actual sweep only runs when either
   * the sweep timer has elapsed or the Map has grown past `maxKeys`.
   *
   * Cost: O(N) over the Map at sweep time — but the sweep cadence is at
   * least `windowMs` (default 1 min for the login limiter, 1 min for
   * worker-create), so amortised per-call cost stays O(1).
   */
  private maybeSweep(): void {
    const now = Date.now()
    if (now - this.lastSweep < this.sweepIntervalMs && this.hits.size < this.maxKeys) {
      return
    }
    this.lastSweep = now
    for (const [k, list] of this.hits) {
      const fresh = list.filter((t) => now - t < this.windowMs)
      if (fresh.length === 0) {
        this.hits.delete(k)
      } else if (fresh.length !== list.length) {
        this.hits.set(k, fresh)
      }
    }
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

/**
 * Per-request client IP, used for rate-limit keying.
 *
 * Honours `X-Forwarded-For` ONLY when the host was started with
 * `trustProxy: true` (see `WebServerOptions`). Otherwise XFF is
 * ignored — a remote attacker can set the header on every request
 * to defeat a naïve rate limiter, so we don't trust it by default.
 *
 * When `trustProxy` is on, callers are expected to be behind a
 * proxy that overwrites XFF (Caddy `reverse_proxy` and nginx
 * `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`
 * both do). If the proxy passes through client-supplied XFF
 * untouched, the limiter is again trivially bypassable — that's
 * a proxy-config bug, not a server bug.
 */
function clientIp(ctx: HandlerCtx, req: IncomingMessage): string {
  if (ctx.trustProxy) {
    const fwd = req.headers['x-forwarded-for']
    if (typeof fwd === 'string' && fwd.length > 0) {
      const first = fwd.split(',')[0]?.trim()
      if (first) return first
    }
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

  // --- healthz (liveness — process is alive enough to answer HTTP) -------
  // Always 200. Load balancers / systemd / k8s liveness probes restart
  // the process when this returns non-200. Boot status (have we finished
  // workflow resume? are plugins attached?) belongs to `/readyz`, not
  // here — restarting a slow-booting pod is the opposite of what an
  // operator wants.
  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }

  // --- readyz (readiness — bootstrap finished, real traffic safe) --------
  // 200 once the readiness gate (set by the host after resumeRunningRuns
  // + any other boot work) flips. 503 before that. When no gate is
  // supplied (older callers / library use), aliases `/healthz` — same
  // 200 forever — so this remains backward-compatible.
  if (path === '/readyz') {
    const ready = ctx.readinessGate ? ctx.readinessGate.isReady() : true
    if (ready) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ready')
    } else {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'starting' }))
    }
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
  // Auth-gated: SSE leaks the full Hub event firehose (task payloads,
  // evaluations, service-trash refs, pending applications). Pre-3.1
  // this was anonymous, which let any port-reachable peer dump every
  // dispatched task in real time. Require either an admin session or
  // a worker session to subscribe.
  if (method === 'GET' && path === '/api/stream') {
    if (!(await requireAdminOrWorker(ctx, req, res))) return
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
  // Auth-gated: returns the full transcript + admins/workers/tasks
  // dump. Pre-3.1 this was anonymous and exposed every operational
  // detail of the room. Require admin or worker auth; the response
  // payload is unchanged either way (room state is the same for all
  // signed-in principals — admins use the same view).
  if (method === 'GET' && path === '/api/state') {
    if (!(await requireAdminOrWorker(ctx, req, res))) return
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
      // Session-fixation defence: if the visitor already carries a
      // valid admin cookie, refuse to overwrite it via a URL token.
      // Otherwise an attacker who owns ANY valid admin token (e.g. an
      // ex-admin who saved their old recovery link) can phish a
      // currently-logged-in admin into visiting `/admin?token=<attacker_token>`;
      // the response would set a fresh cookie bound to the attacker's
      // admin row, silently substituting the victim's session. By
      // making the visitor explicitly POST /api/admin/logout first,
      // the cookie change becomes intentional.
      const existing = await ctx.space.findAdminSession(readCookie(req, ADMIN_COOKIE))
      if (existing) {
        res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(
          'already signed in as a different admin session.\n' +
            'sign out first (POST /api/admin/logout) and reopen the link.',
        )
        return
      }
      const ip = clientIp(ctx, req)
      // Namespaced key (`bearer:`) keeps Bearer/admin-token attempts
      // separate from the cookie-probing limiter slice introduced for
      // H21. Same IP, two independent budgets — one for "spray random
      // tokens at /admin?token=...", one for "spray random cookie
      // sids at any auth-checking endpoint" — so an attacker can't
      // double their effective quota by switching auth modes.
      if (!ctx.adminLoginLimiter.check(`bearer:${ip}`)) {
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

  // --- v4 identity routes -------------------------------------------------
  // `/api/admin/identity/*` is the v4 multi-user surface. Auth is handled
  // inside `handleIdentityRoute` (owner is established by EITHER a valid
  // v3 admin OR a v4 IdentityStore session). When the host didn't wire
  // an IdentityStore, return 503 so the admin UI can hide the tab.
  if (path.startsWith('/api/admin/identity/')) {
    if (!ctx.identity) {
      sendJson(
        res,
        { error: 'v4 identity store not enabled on this host' },
        503,
      )
      return
    }
    // We compute `isV3Admin` here (cheap) so handleIdentityRoute can
    // skip a redundant lookup. Note: this does NOT enforce v3 admin —
    // a missing v3 admin is fine if the caller has a v4 session.
    let isV3Admin = false
    const adminResolution = await findAdminFromRequest(ctx, req)
    if (adminResolution.kind === 'rate_limited') {
      res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' })
      res.end('too many auth attempts; try again in a minute')
      return
    }
    if (adminResolution.kind === 'admin') isV3Admin = true
    // V4-AUDIT-06: User-Agent goes into audit rows. Headers can be
    // string | string[]; we coerce to a single string (Node never
    // splits User-Agent in practice, but the type allows for it).
    const uaRaw = req.headers['user-agent']
    const userAgent = Array.isArray(uaRaw) ? uaRaw.join(' ') : uaRaw
    await handleIdentityRoute(
      {
        identity: ctx.identity,
        cookieSecure: ctx.cookieSecure,
        isV3Admin,
        // V4-AUDIT-01: share the v3 limiter so an attacker cannot get
        // extra budget by switching between v3 admin login and v4
        // identity login — both consume the same per-IP slot, just
        // under different namespaces (`bearer:`/`cookie:`/`identity-login:`).
        loginLimiter: ctx.adminLoginLimiter,
        clientIp: clientIp(ctx, req),
        ...(userAgent ? { userAgent } : {}),
      },
      req,
      res,
      method,
      path,
    )
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

  // --- bundle import (v2.4 personal-growth-ready) -------------------------
  //
  // One-call upload that:
  //   1. upserts every agent in `bundle.team`
  //   2. (optional) applies the supplied `apiKey` to every openai-
  //      compatible agent in the team — solves the "new user has to
  //      paste a DeepSeek key into 7 agents" friction
  //   3. forwards `bundle.workflow` (if present) to the workflow importer
  //   4. spawns every agent it just upserted (best-effort)
  //
  // Body: JSON `{ yaml: string, apiKey?: string }`.
  // Response: `{ ok, bundle, team: {created, skipped, spawnErrors}, workflow }`.
  //
  // Why a separate endpoint (rather than extending /agents/import):
  // bundle import has materially different semantics — it talks to the
  // workflow surface, it accepts a key (which agents/import never has),
  // and the response shape carries workflow info. Keeping them separate
  // means /agents/import stays backward-compatible (template authors
  // who curl yaml at it keep working) and the bundle endpoint is free
  // to evolve.
  if (method === 'POST' && path === '/api/admin/bundles/import') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const rawBody = await readTextBody(req).catch(() => '')
    if (!rawBody) { sendJson(res, { error: 'empty body' }, 400); return }
    let body: { yaml?: unknown; apiKey?: unknown }
    try {
      body = JSON.parse(rawBody)
    } catch (err) {
      sendJson(res, {
        error: `body must be JSON {"yaml": "<bundle yaml>", "apiKey": "<optional key>"} — got: ${err instanceof Error ? err.message : String(err)}`,
      }, 400)
      return
    }
    if (typeof body.yaml !== 'string' || body.yaml.length === 0) {
      sendJson(res, { error: 'body.yaml is required (non-empty string)' }, 400)
      return
    }
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.length > 0
      ? body.apiKey
      : undefined

    let bundle
    try {
      bundle = parseBundle(body.yaml)
    } catch (err) {
      const msg = err instanceof ManifestError ? err.message : (err instanceof Error ? err.message : String(err))
      sendJson(res, { error: msg }, 400)
      return
    }

    // Upsert agents. We apply the apiKey first (so the spawn after
    // upsert has the key in place) and skip ones that already exist
    // unchanged — same semantics as /agents/import. A bundle re-import
    // is therefore safe: existing agents stay put, the workflow gets
    // re-loaded.
    const existing = new Set((await ctx.space.agents()).map((a) => a.id))
    const created: AgentRecord[] = []
    const skipped: string[] = []
    for (const a of bundle.team.agents) {
      if (existing.has(a.id)) { skipped.push(a.id); continue }
      const rec = await ctx.space.upsertAgent({
        id: a.id,
        allowedCapabilities: a.capabilities,
        displayName: a.displayName,
        managed: a.managed,
      })
      // Apply the supplied key to every openai-compatible agent. This
      // is the one and only place we touch encrypted secret storage;
      // anthropic / openai agents read from workspace defaults so they
      // don't need a per-agent key.
      if (apiKey && a.managed.provider === 'openai-compatible') {
        try { await ctx.space.setAgentApiKey(a.id, apiKey) }
        catch (err) {
          log.warn('bundle import: failed to set per-agent key', { id: a.id, err })
        }
      }
      created.push(rec)
      existing.add(a.id)
    }

    // Best-effort spawn. Failures don't roll back — the operator can
    // re-edit any broken agent from the agents tab.
    const spawnErrors: { id: string; error: string }[] = []
    if (ctx.lifecycle) {
      for (const rec of created) {
        try { await ctx.lifecycle.start(rec) }
        catch (err) {
          spawnErrors.push({ id: rec.id, error: err instanceof Error ? err.message : String(err) })
        }
      }
    }

    // Forward the embedded workflow yaml to the workflow runner.
    // Workflow import failures don't roll back the agents either —
    // the agents are usable on their own (capability dispatch) even
    // without the workflow.
    let workflowSummary: unknown = undefined
    let workflowError: string | undefined
    if (bundle.workflowYaml) {
      if (!ctx.workflows) {
        workflowError = 'workflows surface not enabled on this host — agents were imported but the bundle workflow is unavailable'
      } else {
        try {
          workflowSummary = await ctx.workflows.importFromText(bundle.workflowYaml)
        } catch (err) {
          workflowError = err instanceof Error ? err.message : String(err)
        }
      }
    }

    sendJson(res, {
      ok: true,
      bundle: {
        name: bundle.bundleName,
        description: bundle.bundleDescription,
      },
      team: {
        created: created.map((r) => publicAgent(r, ctx.hub)),
        skipped,
        spawnErrors,
      },
      workflow: workflowSummary,
      workflowError,
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
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return

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

  // --- Hub Services admin (v2.2) ------------------------------------------
  // All endpoints require admin auth. When the host didn't supply a
  // services surface (Hub Services failed to bootstrap, or this is an
  // embedded use without the host wiring), every route returns 503 so
  // the UI can hide the tab cleanly rather than render a half-broken
  // page. Errors get translated to status:
  //   PluginNotFoundError      → 404
  //   TrashRestoreConflictError → 409
  //   ServiceConfigError       → 400
  //   everything else          → 500

  if (method === 'GET' && path === '/api/admin/services/plugins') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    if (!ctx.services) { sendJson(res, { error: 'services not enabled' }, 503); return }
    sendJson(res, { plugins: ctx.services.listPlugins() })
    return
  }

  // Describe one (plugin, owner) pair. Returns `{ snapshot: null }`
  // (HTTP 200) when the plugin has no data for the owner — the admin
  // UI uses that to keep the row in the table greyed out.
  const describeMatch = path.match(
    /^\/api\/admin\/services\/owners\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/,
  )
  if (method === 'GET' && describeMatch) {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    if (!ctx.services) { sendJson(res, { error: 'services not enabled' }, 503); return }
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
    return
  }

  // Soft-delete an owner's data for one plugin.
  if (method === 'DELETE' && describeMatch) {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    if (!ctx.services) { sendJson(res, { error: 'services not enabled' }, 503); return }
    const [, type, impl, ownerKind, ownerId] = describeMatch
    // readJsonBody returns undefined on empty body. Treat that as
    // "no reason supplied" rather than throwing.
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
    return
  }

  // List all trash entries across plugins. Sorted newest-first so the
  // admin UI shows recent trash at the top.
  if (method === 'GET' && path === '/api/admin/services/trash') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    if (!ctx.services) { sendJson(res, { error: 'services not enabled' }, 503); return }
    try {
      const all = await ctx.services.listTrash()
      const sorted = [...all].sort((a, b) => b.deletedAt - a.deletedAt)
      sendJson(res, { trash: sorted })
    } catch (err) {
      sendServiceError(res, err)
    }
    return
  }

  // Restore via POST so the body can carry the full ServiceTrashRef
  // (the path alone doesn't have all the fields the plugin needs).
  // Returns 409 if the original owner slot is occupied.
  const restoreMatch = path.match(/^\/api\/admin\/services\/trash\/([^/]+)\/([^/]+)\/([^/]+)\/restore$/)
  if (method === 'POST' && restoreMatch) {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    if (!ctx.services) { sendJson(res, { error: 'services not enabled' }, 503); return }
    const [, type, impl, id] = restoreMatch
    const t = decodeURIComponent(type!)
    const i = decodeURIComponent(impl!)
    const refId = decodeURIComponent(id!)
    try {
      // Find the ref in the union — saves an admin from having to
      // POST the whole TrashRef body. The set is small (admin trash);
      // a linear scan is fine.
      const all = await ctx.services.listTrash()
      const ref = all.find((r) => r.type === t && r.impl === i && r.id === refId)
      if (!ref) { sendJson(res, { error: 'trash entry not found' }, 404); return }
      await ctx.services.restore(ref)
      sendJson(res, { ok: true })
    } catch (err) {
      sendServiceError(res, err)
    }
    return
  }

  // Hard delete one trash entry. Irreversible.
  const hardDeleteMatch = path.match(/^\/api\/admin\/services\/trash\/([^/]+)\/([^/]+)\/([^/]+)$/)
  if (method === 'DELETE' && hardDeleteMatch) {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    if (!ctx.services) { sendJson(res, { error: 'services not enabled' }, 503); return }
    const [, type, impl, id] = hardDeleteMatch
    const t = decodeURIComponent(type!)
    const i = decodeURIComponent(impl!)
    const refId = decodeURIComponent(id!)
    try {
      const all = await ctx.services.listTrash()
      const ref = all.find((r) => r.type === t && r.impl === i && r.id === refId)
      if (!ref) { sendJson(res, { error: 'trash entry not found' }, 404); return }
      await ctx.services.hardDelete(ref)
      sendJson(res, { ok: true })
    } catch (err) {
      sendServiceError(res, err)
    }
    return
  }

  // --- Growth reports (v2.4 personal-growth-flow) -------------------------
  // Two routes, both admin-only and both 503 when the host didn't
  // wire a `growthReports` surface (i.e. the personal-growth team
  // isn't loaded). The admin UI checks the list endpoint's 503
  // response and hides the panel cleanly.

  if (method === 'GET' && path === '/api/admin/growth-reports') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    if (!ctx.growthReports) {
      sendJson(res, { error: 'growth reports not enabled' }, 503)
      return
    }
    try {
      const reports = await ctx.growthReports.list()
      sendJson(res, { reports })
    } catch (err) {
      log.error('growth-reports list failed', { err })
      sendJson(res, { error: 'list failed' }, 500)
    }
    return
  }

  // GET /api/admin/growth-reports/download?path=reports/<caseId>/<file>.md
  // Streams the markdown back as `text/markdown; charset=utf-8` with a
  // `Content-Disposition: attachment` header so the browser saves it.
  // Inline rendering can come later — markdown isn't a content-type
  // browsers display natively, so the download UX is right for v0.2.
  if (method === 'GET' && path === '/api/admin/growth-reports/download') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    if (!ctx.growthReports) {
      sendJson(res, { error: 'growth reports not enabled' }, 503)
      return
    }
    // Pull `?path=...` from the URL — we never trust the path to
    // route the request; `growthReports.read` is the only thing
    // that resolves it against the artifact handle (which itself
    // sanitises via service-artifact-file's `sanitisePath`).
    const url = new URL(req.url ?? '/', 'http://localhost')
    const reportPath = url.searchParams.get('path')
    if (!reportPath) {
      sendJson(res, { error: 'missing path' }, 400)
      return
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
    return
  }

  // Manual sweep — admin button "purge expired now". Returns the same
  // `{ scanned, purged }` shape the periodic sweeper logs.
  if (method === 'POST' && path === '/api/admin/services/sweep') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    if (!ctx.services) { sendJson(res, { error: 'services not enabled' }, 503); return }
    try {
      if (!ctx.services.sweepExpired) {
        sendJson(res, { error: 'manual sweep not supported by this host' }, 405)
        return
      }
      const out = await ctx.services.sweepExpired()
      sendJson(res, { ok: true, ...out })
    } catch (err) {
      sendServiceError(res, err)
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
  // next boot won't bring it back. After the record is gone we ping
  // `lifecycle.onAgentRemoved` (PR-10) so the host can soft-delete
  // every Hub Service this agent's data lives in; failures here are
  // logged but never roll back the deletion.
  if (method === 'DELETE' && editAgentMatch) {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const id = decodeURIComponent(editAgentMatch[1]!)
    if (ctx.lifecycle) {
      await ctx.lifecycle.stop(id).catch((err) => log.error('lifecycle stop failed', { id, err }))
    }
    const ok = await ctx.space.removeAgent(id)
    if (!ok) { sendJson(res, { error: `unknown agent '${id}'` }, 404); return }
    if (ctx.lifecycle?.onAgentRemoved) {
      await ctx.lifecycle.onAgentRemoved(id).catch((err) =>
        log.error('lifecycle.onAgentRemoved failed', { id, err }),
      )
    }
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

  // --- admin: prometheus-style metrics (v1.2 observability) ---------------
  // Returns a plain-text response in OpenMetrics / Prometheus format.
  // Scrape-friendly: no JSON, stable key names, HELP/TYPE annotations.
  // Auth-required (admin) because the leaderboard exposes participant ids.
  if (method === 'GET' && path === '/api/admin/metrics') {
    // Pass the per-server httpStats through so /metrics surfaces
    // HTTP response-class counters. Counter resets across host
    // restart are expected and handled by Prometheus's rate().
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const text = renderMetrics(ctx.hub, { httpStats: ctx.httpStats })
    res.writeHead(200, {
      // OpenMetrics content-type so Prometheus's scraper does the right thing.
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    })
    res.end(text)
    return
  }

  // --- admin: SERVICE_CALL audit (v1.1 services-over-ws) ----------------
  // Returns the most recent `service_call` transcript entries (newest-first).
  // Caps default at 200 to keep the response small; admins who need more
  // can pass `?limit=N` (max 2000). Used by the admin UI's services audit
  // panel and by smoke tests verifying SERVICE_CALL frames left a trail.
  if (method === 'GET' && path === '/api/admin/transcript/service-calls') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const requested = Number.parseInt(u.searchParams.get('limit') || '200', 10)
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(2000, requested)) : 200
    const filter = (u.searchParams.get('type') || '').trim() || null
    const all = ctx.hub.transcript.all()
    const calls = []
    for (let i = all.length - 1; i >= 0 && calls.length < limit; i--) {
      const e = all[i]!
      if (e.kind !== 'service_call') continue
      const data = e.data as { type: string }
      if (filter && data.type !== filter) continue
      calls.push({ seq: e.seq, ts: e.ts, ...e.data })
    }
    sendJson(res, { calls })
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
    // Rate-limit worker creation per-IP so an anonymous remote can't
    // mint thousands of worker rows + live HumanParticipants on the
    // Hub. Default budget (30/min) is generous enough for a classroom
    // rejoining over flaky WiFi.
    if (!ctx.workerCreateLimiter.check(clientIp(ctx, req))) {
      res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' })
      res.end('too many worker registrations; try again in a minute')
      return
    }
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

  // --- task action --------------------------------------------------------
  // Auth-gated: the caller must be either an admin (who can act on
  // any human's behalf, e.g. closing out an abandoned assignment) or
  // the worker whose HumanParticipant id matches the task's assignee.
  // Pre-3.1 this endpoint was anonymous, which let anyone who could
  // observe a taskId on /api/stream (also anonymous pre-3.1) forge
  // results for any human's pending task.
  const taskAction = path.match(/^\/api\/tasks\/([^/]+)\/(complete|reject)$/)
  if (method === 'POST' && taskAction) {
    const taskId = decodeURIComponent(taskAction[1]!)
    const action = taskAction[2] as 'complete' | 'reject'

    const human = findHumanWithPending(ctx.hub, taskId)
    if (!human) {
      sendJson(res, { error: `no human has task ${taskId} pending` }, 404)
      return
    }
    if (!(await requireAdminOrTaskAssignee(ctx, req, res, human.id))) return

    const body = (await readJsonBody(req).catch(() => ({}))) as {
      output?: unknown
      error?: string
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

/**
 * Pure check — return the admin behind the request, or `null`, without
 * writing to `res`. Use {@link requireAdmin} when the caller wants the
 * auto-401-on-miss behaviour; use this when you need to compose admin
 * auth with a fallback (e.g. "admin OR the worker who owns this task"
 * — see {@link requireAdminOrTaskAssignee}).
 *
 * Returns:
 *   - `{ kind: 'admin', admin }` on Bearer/cookie hit
 *   - `{ kind: 'rate_limited' }` when Bearer was tried but the IP is
 *     over budget (caller must write 429 if it wants to bail here)
 *   - `{ kind: 'none' }` when neither path matched
 */
async function findAdminFromRequest(
  ctx: HandlerCtx,
  req: IncomingMessage,
): Promise<
  | { kind: 'admin'; admin: AdminRecord }
  | { kind: 'rate_limited' }
  | { kind: 'none' }
> {
  const ip = clientIp(ctx, req)
  const bearer = readBearer(req)
  if (bearer) {
    // Symmetric to the cookie path below (H21). `peek` BEFORE the
    // verify so an attacker can't churn token-lookup IO indefinitely,
    // but `recordFailure` ONLY when verify returns null — otherwise
    // a legitimate Bearer holder (MCP server, CI script, polling SPA)
    // would burn 1 quota point per authenticated request, which means
    // any client making > max requests/window gets falsely rate-limited
    // despite never having a single failed auth. Before this fix the
    // Bearer side used `check` (always consumes), so a workflow-runs
    // poll every 5s tripped the 10/60s limit after the 10th request.
    if (!ctx.adminLoginLimiter.peek(`bearer:${ip}`)) {
      return { kind: 'rate_limited' }
    }
    const admin = await ctx.space.verifyAdminToken(bearer)
    if (admin) return { kind: 'admin', admin }
    ctx.adminLoginLimiter.recordFailure(`bearer:${ip}`)
  }
  const sid = readCookie(req, ADMIN_COOKIE)
  if (sid) {
    // H21 — cookie-probing defence. `findAdminSession` reads
    // `runtime/admin-sessions.json` from disk; an attacker spraying
    // random sids could churn that file IO indefinitely without ever
    // tripping the Bearer limiter above, because they never set an
    // Authorization header. We `peek` the budget BEFORE the lookup so
    // the legitimate path (valid sid resolves on the first try) never
    // burns quota — only failed lookups call `recordFailure`. The
    // namespaced key (`cookie:`) keeps this budget independent of the
    // Bearer side so a logged-in admin doing API calls can't be DoS'd
    // by an attacker filling the Bearer slot with bad tokens.
    if (!ctx.adminLoginLimiter.peek(`cookie:${ip}`)) {
      return { kind: 'rate_limited' }
    }
    const sess = await ctx.space.findAdminSession(sid)
    if (sess) {
      const admins = await ctx.space.admins()
      const a = admins.find((x) => x.id === sess.principalId)
      if (a) return { kind: 'admin', admin: a }
    }
    // The sid was supplied but resolved to no admin — record the failure
    // so an attacker's quota burns down. Success path above already
    // returned without touching the limiter.
    ctx.adminLoginLimiter.recordFailure(`cookie:${ip}`)
  }
  return { kind: 'none' }
}

/**
 * Pure check — return the worker behind the request, or `null`. Does
 * not write to `res`. The worker cookie is set by `POST /api/workers`
 * and stays valid until logout or session expiry.
 */
async function findCurrentWorker(
  ctx: HandlerCtx,
  req: IncomingMessage,
): Promise<WorkerRecord | null> {
  const sid = readCookie(req, WORKER_COOKIE)
  if (!sid) return null
  const sess = await ctx.space.findWorkerSession(sid)
  if (!sess) return null
  const workers = await ctx.space.workers()
  return workers.find((w) => w.id === sess.principalId) ?? null
}

async function requireAdmin(
  ctx: HandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<AdminRecord | null> {
  const r = await findAdminFromRequest(ctx, req)
  if (r.kind === 'rate_limited') {
    res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' })
    res.end('too many auth attempts; try again in a minute')
    return null
  }
  if (r.kind === 'admin') return r.admin
  sendJson(res, { error: 'admin auth required' }, 401)
  return null
}

/**
 * Authn for endpoints that any signed-in principal may read (admin
 * dashboard fields or workers viewing their own room). Either an
 * admin cookie/Bearer or a worker cookie unlocks the route. The
 * caller is responsible for any per-principal authorisation (e.g.
 * projecting state down to what the worker may see).
 */
async function requireAdminOrWorker(
  ctx: HandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ admin?: AdminRecord; worker?: WorkerRecord } | null> {
  const a = await findAdminFromRequest(ctx, req)
  if (a.kind === 'rate_limited') {
    res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' })
    res.end('too many auth attempts; try again in a minute')
    return null
  }
  if (a.kind === 'admin') return { admin: a.admin }
  const worker = await findCurrentWorker(ctx, req)
  if (worker) return { worker }
  sendJson(res, { error: 'auth required' }, 401)
  return null
}

/**
 * Authz for `POST /api/tasks/:id/(complete|reject)` — either an admin
 * (who can act on any human's behalf) or the worker whose
 * `HumanParticipant.id` matches the task's assignee.
 */
async function requireAdminOrTaskAssignee(
  ctx: HandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
  assigneeId: ParticipantId,
): Promise<true | null> {
  const a = await findAdminFromRequest(ctx, req)
  if (a.kind === 'rate_limited') {
    res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' })
    res.end('too many auth attempts; try again in a minute')
    return null
  }
  if (a.kind === 'admin') return true
  const worker = await findCurrentWorker(ctx, req)
  if (worker && worker.id === assigneeId) return true
  sendJson(res, { error: 'auth required (admin or assigned worker)' }, 403)
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

  // Normalise to forward slashes so the lookup key matches what the
  // generator emitted (it always uses '/' regardless of the host OS).
  const key = safe.split(sep).join('/')
  const ext = extname(safe)
  const contentType = MIME[ext] ?? 'application/octet-stream'

  // Production path: embedded asset map. Populated by
  // scripts/build-static-assets.mjs; works in node, bun, and bun --compile
  // single-file binaries (where filesystem reads relative to import.meta.url
  // are not available).
  const embedded = getEmbeddedAsset(key)
  if (embedded) {
    res.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'no-cache',
    })
    res.end(embedded)
    return
  }

  // Dev fallback: read from disk. Only reached when the build:assets
  // generator hasn't been run yet (fresh checkout, `pnpm dev`-style
  // workflow, or someone editing static/ files and serving without a
  // rebuild). Identical 404 semantics as before.
  const full = join(STATIC_DIR, safe)
  if (!full.startsWith(STATIC_DIR + sep) && full !== STATIC_DIR) {
    res.writeHead(400); res.end(); return
  }
  try {
    const data = await readFile(full)
    res.writeHead(200, {
      'content-type': contentType,
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
 * Render `hub` state as a Prometheus / OpenMetrics text exposition.
 *
 * Format spec: https://prometheus.io/docs/instrumenting/exposition_formats/
 *
 * Choice of metrics (deliberately narrow — every counter / gauge below is
 * derived from data the hub already keeps in memory or the transcript;
 * no new bookkeeping required):
 *
 *   - `aipehub_protocol_version`       1, labelled with the wire version.
 *   - `aipehub_participants` gauge      total live participants by kind.
 *   - `aipehub_tasks_total` counter     completed tasks by terminal kind.
 *   - `aipehub_pending_applications` gauge  unresolved HELLO admissions.
 *   - `aipehub_service_calls_total` counter  SERVICE_CALL frames by outcome.
 *   - `aipehub_service_call_duration_ms_sum` counter / `_count` —
 *     classic sum/count pair giving you a per-(type,impl) mean over time.
 *
 * Histogram buckets are NOT exposed — they'd require runtime bookkeeping
 * the hub doesn't have. Mean + count is enough for first-pass dashboards;
 * v1.3 streaming RFC tracks adding bucket support.
 *
 * **Performance**: walks the transcript once. With a typical 1k-10k entry
 * transcript and Prometheus's 15-30s scrape interval, this is negligible.
 * If a deployment hits 100k+ entries the right next step is to maintain a
 * rolling counter — out of scope for v1.2.
 */
/**
 * Bucket boundaries for the service-call latency histogram, in
 * milliseconds. Chosen to cover the realistic span of in-process
 * (memory plugin: sub-millisecond) and IO-bound (datastore: tens to
 * hundreds of ms) calls without ballooning cardinality. The `+Inf`
 * bucket is appended automatically and matches every observation.
 *
 * Bucket choice rationale:
 *   5/10 ms      — separates in-process memory hits from anything
 *                  that touched disk
 *   25/50/100 ms — typical sqlite + file IO
 *   250/500 ms   — pathological slowness; an alert can fire on
 *                  growth here
 *   1000/2500/5000/+Inf — runaway / timeout territory
 */
const SERVICE_CALL_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const

/** Options recognised by {@link renderMetrics}. */
export interface RenderMetricsOptions {
  /**
   * Per-server HTTP response counters to surface alongside the
   * Hub-derived metrics. Pass `ctx.httpStats` from the server; the
   * metric is omitted when this is undefined (callers that scrape
   * /metrics from a non-server context — tests, scripts — won't see
   * HTTP-related output).
   */
  httpStats?: HttpStats
}

export function renderMetrics(hub: Hub, opts: RenderMetricsOptions = {}): string {
  const lines: string[] = []
  const w = (...ls: string[]) => { for (const l of ls) lines.push(l) }

  // --- protocol version (info-style metric) ----------------------------------
  w(
    '# HELP aipehub_protocol_version Wire protocol version (info metric).',
    '# TYPE aipehub_protocol_version gauge',
    `aipehub_protocol_version{version="${PROTOCOL_VERSION_LITERAL}"} 1`,
    '',
  )

  // --- participants by kind ---------------------------------------------------
  const participants = hub.participants()
  const byKind: Record<string, number> = {}
  for (const p of participants) {
    byKind[p.kind] = (byKind[p.kind] ?? 0) + 1
  }
  w(
    '# HELP aipehub_participants Number of live participants, by kind.',
    '# TYPE aipehub_participants gauge',
  )
  for (const [kind, count] of Object.entries(byKind)) {
    w(`aipehub_participants{kind="${escapeLabel(kind)}"} ${count}`)
  }
  if (Object.keys(byKind).length === 0) {
    // Emit a zero so the metric exists even before anyone joins.
    w('aipehub_participants 0')
  }
  w('')

  // --- task outcomes (counter from transcript) -------------------------------
  // Aggregating from transcript means counters reset on host restart — fine
  // for Prometheus (which expects counter resets), and avoids extra state.
  const taskCounts: Record<string, number> = { ok: 0, failed: 0, cancelled: 0, no_participant: 0 }
  let pendingApps = 0
  // SERVICE_CALL audit metrics.
  const svcCalls: Record<string, number> = {}     // key: "type|impl|outcome"
  const svcDurSum: Record<string, number> = {}    // key: "type|impl"
  const svcDurCnt: Record<string, number> = {}    // key: "type|impl"
  // Histogram bucket counts. Each value is a cumulative-count array
  // aligned with SERVICE_CALL_BUCKETS_MS + a trailing `+Inf` slot
  // (Prometheus histograms are cumulative: each `le="X"` includes
  // every observation ≤ X). Keyed by `type|impl` so service-call
  // latency can be sliced per backing plugin.
  const svcDurBuckets: Record<string, number[]> = {}

  for (const e of hub.transcript.all()) {
    if (e.kind === 'task_result') {
      taskCounts[e.data.kind] = (taskCounts[e.data.kind] ?? 0) + 1
    } else if (e.kind === 'service_call') {
      const d = e.data as { type: string; impl: string; outcome: string; durationMs: number }
      const okey = `${d.type}|${d.impl}|${d.outcome}`
      svcCalls[okey] = (svcCalls[okey] ?? 0) + 1
      const dkey = `${d.type}|${d.impl}`
      // Prometheus convention: durations are non-negative. Clamp at zero to
      // defend against clock skew (Date.now() going backwards mid-call) and
      // bogus client-reported negatives. Without this, sum-counters can
      // decrease across scrapes — a violation that breaks rate() queries.
      const dur =
        Number.isFinite(d.durationMs) && d.durationMs >= 0 ? d.durationMs : 0
      svcDurSum[dkey] = (svcDurSum[dkey] ?? 0) + dur
      svcDurCnt[dkey] = (svcDurCnt[dkey] ?? 0) + 1
      // Bucket the observation. Cumulative semantics: increment every
      // bucket whose upper bound is ≥ the duration, including the
      // trailing +Inf slot (index = SERVICE_CALL_BUCKETS_MS.length).
      let buckets = svcDurBuckets[dkey]
      if (!buckets) {
        buckets = new Array(SERVICE_CALL_BUCKETS_MS.length + 1).fill(0)
        svcDurBuckets[dkey] = buckets
      }
      for (let i = 0; i < SERVICE_CALL_BUCKETS_MS.length; i++) {
        if (dur <= SERVICE_CALL_BUCKETS_MS[i]!) buckets[i]! += 1
      }
      // Trailing slot is the +Inf bucket and is always initialised
      // to 0 by `new Array(...).fill(0)` above — the non-null
      // assertion just tells TS what we already know.
      buckets[SERVICE_CALL_BUCKETS_MS.length]! += 1 // +Inf — matches everything
    }
  }
  pendingApps = hub.pendingApplications().length

  w(
    '# HELP aipehub_tasks_total Tasks that reached a terminal state, by kind.',
    '# TYPE aipehub_tasks_total counter',
  )
  for (const [kind, n] of Object.entries(taskCounts)) {
    w(`aipehub_tasks_total{kind="${escapeLabel(kind)}"} ${n}`)
  }
  w('')

  w(
    '# HELP aipehub_pending_applications Unresolved admission applications waiting on admin.',
    '# TYPE aipehub_pending_applications gauge',
    `aipehub_pending_applications ${pendingApps}`,
    '',
  )

  // --- SERVICE_CALL counters --------------------------------------------------
  w(
    '# HELP aipehub_service_calls_total SERVICE_CALL frames resolved, by outcome.',
    '# TYPE aipehub_service_calls_total counter',
  )
  if (Object.keys(svcCalls).length === 0) {
    w('aipehub_service_calls_total 0')
  } else {
    for (const [key, n] of Object.entries(svcCalls)) {
      const [type, impl, outcome] = key.split('|') as [string, string, string]
      w(
        `aipehub_service_calls_total{type="${escapeLabel(type)}",impl="${escapeLabel(impl)}",outcome="${escapeLabel(outcome)}"} ${n}`,
      )
    }
  }
  w('')

  w(
    '# HELP aipehub_service_call_duration_ms_sum Cumulative latency of all SERVICE_CALL frames.',
    '# TYPE aipehub_service_call_duration_ms_sum counter',
  )
  for (const [key, n] of Object.entries(svcDurSum)) {
    const [type, impl] = key.split('|') as [string, string]
    w(
      `aipehub_service_call_duration_ms_sum{type="${escapeLabel(type)}",impl="${escapeLabel(impl)}"} ${n}`,
    )
  }
  w('')

  w(
    '# HELP aipehub_service_call_duration_ms_count Count of SERVICE_CALL frames (mate of the _sum series).',
    '# TYPE aipehub_service_call_duration_ms_count counter',
  )
  for (const [key, n] of Object.entries(svcDurCnt)) {
    const [type, impl] = key.split('|') as [string, string]
    w(
      `aipehub_service_call_duration_ms_count{type="${escapeLabel(type)}",impl="${escapeLabel(impl)}"} ${n}`,
    )
  }
  w('')

  // --- SERVICE_CALL latency histogram ----------------------------------------
  // Buckets enable Prometheus `histogram_quantile()` for p50 / p95 /
  // p99 latencies. The naming and shape follow Prom convention: emit
  // each `<metric>_bucket{le="..."}` line cumulatively, with `+Inf` as
  // the topmost slot. Sum / count are deliberately re-used from the
  // existing `_sum` / `_count` counters above — Prometheus accepts
  // both pre-existing and re-declared metrics, and we already emit
  // them with the same names a histogram would.
  w(
    '# HELP aipehub_service_call_duration_ms Histogram of SERVICE_CALL frame durations (ms), cumulative buckets.',
    '# TYPE aipehub_service_call_duration_ms histogram',
  )
  if (Object.keys(svcDurBuckets).length === 0) {
    // Emit a single +Inf zero-count bucket so the metric exists from
    // the very first scrape (some dashboards complain about
    // \"no data\" if the series never appears).
    w('aipehub_service_call_duration_ms_bucket{le="+Inf"} 0')
  } else {
    for (const [key, counts] of Object.entries(svcDurBuckets)) {
      const [type, impl] = key.split('|') as [string, string]
      const typeLabel = `type="${escapeLabel(type)}",impl="${escapeLabel(impl)}"`
      for (let i = 0; i < SERVICE_CALL_BUCKETS_MS.length; i++) {
        w(
          `aipehub_service_call_duration_ms_bucket{${typeLabel},le="${SERVICE_CALL_BUCKETS_MS[i]}"} ${counts[i]}`,
        )
      }
      w(
        `aipehub_service_call_duration_ms_bucket{${typeLabel},le="+Inf"} ${counts[SERVICE_CALL_BUCKETS_MS.length]}`,
      )
    }
  }
  w('')

  // --- HTTP responses (by status class) --------------------------------------
  // Only emitted when the caller supplied an HttpStats object — i.e.
  // when /metrics is being scraped from a live server. Tests and
  // out-of-band callers that pass just `hub` still get a clean output.
  if (opts.httpStats) {
    w(
      '# HELP aipehub_http_responses_total HTTP responses sent, bucketed by status class (2xx/3xx/4xx/5xx/other).',
      '# TYPE aipehub_http_responses_total counter',
    )
    const classes = opts.httpStats.byStatusClass
    if (classes.size === 0) {
      // Zero-row variant so /metrics has the series even before any
      // request arrives (rate() on a never-existed series returns
      // NaN; an explicit zero turns the dashboard into a clean line
      // at 0 rps).
      for (const klass of ['2xx', '3xx', '4xx', '5xx']) {
        w(`aipehub_http_responses_total{class="${klass}"} 0`)
      }
    } else {
      // Iterate the seen classes, plus emit zeros for any of the
      // canonical four that haven't seen traffic yet, so dashboards
      // querying \"rate(... {class='5xx'} [5m])\" don't return
      // NaN before the first 5xx appears.
      const canonical = ['2xx', '3xx', '4xx', '5xx']
      const seen = new Set(classes.keys())
      for (const klass of canonical) {
        const n = classes.get(klass) ?? 0
        w(`aipehub_http_responses_total{class="${klass}"} ${n}`)
        seen.delete(klass)
      }
      // Any non-canonical class ('other' / '1xx') the server saw.
      for (const klass of seen) {
        w(
          `aipehub_http_responses_total{class="${escapeLabel(klass)}"} ${classes.get(klass) ?? 0}`,
        )
      }
    }
  }
  // Trailing newline — Prometheus accepts both with/without, but the
  // de-facto convention is one.
  return lines.join('\n') + '\n'
}

// Prometheus label values: backslash, double-quote, and newline are
// the only chars that need escaping. Everything else is opaque.
function escapeLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

// Stable string alias used inside `renderMetrics`. Hoisted so the
// label literal doesn't materialise per-scrape.
const PROTOCOL_VERSION_LITERAL: string = PROTOCOL_VERSION

/**
 * Translate a `@aipehub/services-sdk` typed error to an HTTP status.
 * The web layer doesn't import the sdk's errors (it stays decoupled
 * from the services package). We pattern-match on the error name —
 * those names are stable string constants set in the sdk's
 * `new.target.name` and round-trip across module boundaries.
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
