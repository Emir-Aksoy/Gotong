import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readBearer, readCookie, readJsonBody, sendJson } from './http-helpers.js'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  HumanParticipant,
  createLogger,
  type AdminRecord,
  type DispatchStrategy,
  type GrowthReportsAdminSurface,
  type Hub,
  type ManagedAgentLifecycle,
  type ParticipantId,
  type ServicesAdminSurface,
  type Space,
  type TaskId,
  type WorkerRecord,
} from '@aipehub/core'
import { HttpStats, renderMetrics } from './metrics.js'
import {
  collectBusinessMetrics,
  type MetricsIdentitySource,
} from './business-metrics.js'

const log = createLogger('web')

// Manifest parsing is used by agents-routes.ts (P3 audit cleanup).
// server.ts no longer needs these imports directly.
import { STATIC_ASSETS_BASE64 } from './static-assets.js'
import {
  handleIdentityRoute,
  handlePublicInvitationRoute,
  IDENTITY_COOKIE,
  resolveV4Auth,
  type IdentitySurface,
  type IdentityPeerReputationDTO,
} from './identity-routes.js'
import { handleMeRoute, type InboxSurface, type MeAgentListSurface } from './me-routes.js'
import {
  handleWorkflowRoute,
  type WorkflowGrantSink,
} from './workflow-routes.js'
import { handleAgentsRoute } from './agents-routes.js'
import { handleServicesRoute } from './services-routes.js'
import { handleUploadsRoute } from './uploads-routes.js'
import { handleSetupRoute } from './setup-routes.js'
import { handleAdminRoute } from './admin-routes.js'
import {
  handleMcpRoute,
  handleMcpFederationRoute,
  type McpRegistrySurface,
  type McpFederationSurface,
} from './mcp-routes.js'

import {
  handlePeerManifestRoute,
  type PeerManifestFederationSurface,
} from './peer-routes.js'

export type { PeerManifestFederationSurface, PeerManifestRow } from './peer-routes.js'

export type {
  IdentitySurface,
  IdentityRole,
  IdentityUserDTO,
  IdentitySessionDTO,
  IdentityCredentialDTO,
  IdentityResolved,
  IdentityAuditActorSource,
  IdentityAuditLogEntryDTO,
  IdentityInvitationStatus,
  IdentityInvitationDTO,
  IdentityPeerReputationDTO,
} from './identity-routes.js'

export type {
  McpRegistrySurface,
  McpFederationSurface,
  PeerSharedMcp,
  SharedMcpServerInfo,
} from './mcp-routes.js'

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
  // PWA assets (Phase 12 M9). The web app manifest spec mandates
  // application/manifest+json; the SVG icon needs image/svg+xml so the
  // browser (and the manifest icon loader) treats it as an image.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
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
   * v5 D-M4 — optional host callback to reconcile proactive-heartbeat rows
   * after a managed-agent create / edit / delete. The host wires this to its
   * HeartbeatScheduler (lazily spinning the engine up on first opt-in). When
   * absent, heartbeat config still persists and takes effect on next boot.
   */
  reconcileHeartbeats?: () => Promise<void>
  /**
   * Optional workflow controller. The host wires this to
   * `@aipehub/workflow` so the admin UI can list / import workflows
   * without the Web package taking a runtime dep on the workflow
   * runner. When absent, the workflow API endpoints return 404.
   */
  workflows?: WorkflowSurface
  /**
   * Phase 19 P1-M3 — optional sanitized agent directory for `/api/me/agents`.
   * The host wires a projection of its managed agents that excludes every
   * sensitive field (system prompt / model / provider config / keys). Absent
   * → `/api/me/agents` degrades to an empty list.
   */
  meAgents?: MeAgentListSurface
  /**
   * Phase 13 M3 — optional workflow assistant surface. The host wires
   * `createWorkflowAssistAgent(...)` here when a built-in
   * `WorkflowAssistantAgent` registered successfully. When absent (no
   * LLM key, or operator disabled it via env), the
   * `POST /api/admin/workflows/assist` endpoint returns 503 and the
   * admin UI can hide the "AI assistant" button.
   */
  workflowAssist?: WorkflowAssistSurface
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
   * Phase 16 — optional member task inbox surface. The host wires a
   * `HostInboxService` here. When absent, `GET /api/me/inbox` returns an
   * empty list and `POST /api/me/inbox/:id/resolve` returns 503. Web has no
   * runtime dep on `@aipehub/inbox` — `InboxSurface` is a duck type.
   */
  inbox?: InboxSurface
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
  /**
   * D1 — host's live peer registry. Plumbed into HandleIdentityRouteCtx
   * so /api/admin/identity/peers/* handlers can call invalidate() after
   * each mutation (forces an immediate reconciliation tick instead of
   * waiting for the 5s poll) and read connection status for GET.
   * Optional — when omitted, the routes still work; the response just
   * lacks live `connected` / `backoffAttempts` columns.
   */
  peerRegistry?: {
    invalidate(): void
    status(): Array<{
      peerRowId: string
      peerId: string
      label: string | null
      endpointUrl: string
      connected: boolean
      backoffAttempts: number
    }>
  }
  /**
   * Phase 6 #1 — peer reputation snapshot adapter. Host builds a
   * closure that reads `hub.reputation.all()` and joins with
   * `identity.listPeers()` for labels. Optional — when omitted, the
   * `/api/admin/identity/reputation` endpoint returns 503 and the
   * admin UI hides the dashboard tab gracefully.
   */
  reputation?: {
    snapshot(): IdentityPeerReputationDTO[]
  }
  /**
   * Phase 9 M4 — host-managed file upload surface. Web takes
   * `bytes + mime + filename + by` and writes them through the
   * artifact plugin under a system-owned namespace, returning the
   * artifactId that gets stamped into `LlmFileRefBlock.artifactId`
   * downstream.
   *
   * Why a host injection rather than Web wiring the artifact plugin
   * itself: Web has no dep on `@aipehub/services-sdk` or any plugin
   * impl, by design (`@aipehub/web` is "the HTTP/SPA shell, no plugin
   * surface"). The host owns the lifecycle of plugins, including the
   * system-uploads handle, and surfaces a narrow `put(...)` to Web.
   *
   * When omitted, `/api/admin/uploads` and `/api/me/uploads` return
   * 503. Workflow forms with `type: 'file'` will still render but
   * the submit-time upload will surface a clear error.
   */
  uploads?: UploadSurface
  /**
   * R3 (A2A alignment) — host-injected Agent Card renderer. When wired,
   * `GET /.well-known/agent-card.json` serves the A2A discovery document
   * (public, unauthenticated). When absent, that route 404s. The host
   * builds the card (see `packages/host/src/agent-card.ts`); web only
   * serves the rendered JSON for the request-derived base URL.
   */
  agentCard?: AgentCardSurface
  /**
   * Phase 18 C-M3 — host-injected inbound A2A server. When wired, `POST /a2a`
   * accepts an A2A `message/send` and dispatches into the Hub (own bearer
   * domain — see `A2aServerSurface`). When absent, `/a2a` 404s.
   */
  a2aServer?: A2aServerSurface
  /**
   * #2-M2 — host-injected hub MCP registry surface. When wired, the
   * `/api/admin/mcp-servers` routes install / list / uninstall MCP
   * servers at hub scope, with live propagation to running agents. When
   * absent, those routes 503. The host implements it over Space +
   * LocalAgentPool (see `packages/host/src/main.ts`).
   */
  mcpRegistry?: McpRegistrySurface
  /**
   * #2-M3.4b — host-injected cross-hub MCP federation discovery surface.
   * When wired, `GET /api/admin/mcp-shared` lists the servers connected
   * peers share, so the admin can add a `peer:server` ref by browsing.
   * Absent (peers disabled) → that route 503s. The host implements it
   * over the peer registry + the `mcp.listShared` rpc.
   */
  mcpFederation?: McpFederationSurface
  /**
   * Phase 18 A-M2 — host-injected cross-hub peer capability manifest surface.
   * When wired, `GET /api/admin/peer-manifests` lists each connected peer's
   * advertised capabilities (cached) and `POST .../refresh` refetches them.
   * Absent (peers disabled) → those routes 503. The host implements it over
   * the peer registry + the `peer.manifest` rpc + an in-process cache.
   */
  peerManifests?: PeerManifestFederationSurface
}

/**
 * Narrow host-injected surface for the A2A Agent Card (R3). The host owns
 * the card's content (identity + auth scheme); web passes it the public
 * base URL derived from the request so the card's `url` reflects how the
 * client actually reached the hub.
 */
export interface AgentCardSurface {
  /** Render the Agent Card as a JSON string for the given public base URL. */
  json(baseUrl: string): string
}

/**
 * Phase 18 C-M3 — host-injected inbound A2A server. When wired, `POST /a2a`
 * (and `/a2a/message`) accepts an A2A `message/send` JSON-RPC call, dispatches
 * it into the Hub by capability, and replies with the result. It owns its OWN
 * bearer-auth domain (X-Aipe-Peer-Id + peer token), so the route sits OUTSIDE
 * the admin session / CSRF model. When absent, those routes 404. The host
 * implements it over hub + identity (see `packages/host/src/a2a-server.ts`).
 */
export interface A2aServerSurface {
  /** Authenticate, parse, dispatch, and write the full A2A/JSON-RPC response. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
}

/**
 * Narrow host-injected surface for user file uploads. Implemented in
 * `packages/host/src/main.ts` by wrapping the artifact plugin's
 * system-owned handle.
 */
export interface UploadSurface {
  /**
   * Persist a file. The host's implementation:
   *   1. enforces a hard byte ceiling (see plugin's maxBytesPerFile),
   *   2. enforces the plugin's mime allow-list,
   *   3. writes under `owner: { kind: 'system', id: 'uploads' }` so
   *      uploads are scoped away from agent / user namespaces and
   *      can be GC'd by a separate sweep,
   *   4. returns `artifactId` — an opaque string that any
   *      `LlmArtifactResolver` plumbed through the system-uploads
   *      handle resolves to bytes.
   */
  put(params: {
    bytes: Uint8Array
    declaredMime: string
    filename?: string
    /** Who's uploading — used for audit + filename scoping. */
    by: ParticipantId
    /**
     * Phase 19 P1-M4 — optional path scope segment(s) under the uploads
     * namespace. Member uploads pass `me/<userId>` so they land under
     * `uploads/me/<userId>/...`, giving per-user isolation a member download
     * route can enforce by prefix. Admin uploads omit it (flat namespace).
     * Must be `[A-Za-z0-9_/-]+` with no `..`; the host rejects otherwise.
     */
    scope?: string
  }): Promise<{ artifactId: string; mime: string; size: number }>
  /**
   * Phase 9 M5 — read back an uploaded artifact. Used by the admin
   * UI's `<img>` / `<audio>` / download link tags rendering a payload
   * that contains an `LlmFileRefBlock`. Throws when the artifact is
   * missing (route translates to 404).
   *
   * Same artifact handle that `put` wrote through — no separate
   * authentication: anyone reaching `/api/admin/uploads/:id` already
   * passed admin auth.
   */
  get(artifactId: string): Promise<{ bytes: Uint8Array; mime: string }>
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
   * Like {@link list}, but also includes non-live workflows (draft / review /
   * archived) — the admin operator's full view, so a saved draft is
   * discoverable + publishable. The `/me` member surface never calls this.
   */
  listAll(): Promise<WorkflowSummary[]>
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
   * Like {@link listRuns}, but scoped to runs initiated by one user
   * (`triggeredByOrigin.userId`). Backs the `/me` member workbench so a
   * member sees only their own runs. Newest first. The same host workflow
   * surface structurally satisfies me-routes' narrow `MeRunSurface`.
   */
  listRunsByUser(userId: string, opts?: { workflowId?: string; limit?: number }): Promise<WorkflowRunSummary[]>
  /**
   * Full run record for a given runId, including per-step output and
   * `finalOutput` / `error`. Returns `null` when no such run exists.
   */
  readRun(runId: string): Promise<unknown>

  // --- Phase 15 — workflow lifecycle + revisions -------------------------
  // All return the updated `WorkflowSummary` (state + currentRevision
  // reflect the transition). Throw a duck-typed error carrying `code`
  // (`unknown_workflow` / `illegal_transition` / `capability_immutable` /
  // `revision_missing` / …) which the route maps to an HTTP status. The
  // Web layer never imports the workflow error classes — it reads `.code`.

  /** Save a workflow as a DRAFT (not live). New id, or edit an existing draft. */
  saveDraft(text: string, opts?: { by?: string }): Promise<WorkflowSummary>
  /**
   * Publish a workflow. With `text`, publish that edited content as a new
   * revision; without it, promote the current head (draft/review/deprecated
   * → published).
   */
  publish(id: string, opts?: { text?: string; by?: string }): Promise<WorkflowSummary>
  /** draft → review. */
  submitReview(id: string, opts?: { by?: string }): Promise<WorkflowSummary>
  /** review → draft. */
  backToDraft(id: string, opts?: { by?: string }): Promise<WorkflowSummary>
  /** published → deprecated (soft sunset; stays live, hidden from `/me`). */
  deprecate(id: string, opts?: { by?: string }): Promise<WorkflowSummary>
  /** deprecated → archived (tombstone; unregistered). */
  archive(id: string, opts?: { by?: string }): Promise<WorkflowSummary>
  /** Roll the current published content back to an earlier revision (append-only). */
  rollback(id: string, opts: { targetRevision: number; by?: string }): Promise<WorkflowSummary>
  /** Revision metadata for a workflow, ascending. */
  listRevisions(id: string): Promise<WorkflowRevisionMeta[]>
  /** Full lifecycle view (state, pointers, revisions, history, legal actions). */
  getState(id: string): Promise<WorkflowLifecycleView>
}

/**
 * Phase 13 M3 — host-injected workflow assistant surface. Wraps a
 * registered `WorkflowAssistantAgent` so the Web layer can answer
 * `POST /api/admin/workflows/assist` without taking a runtime dep on
 * `@aipehub/workflow-assistant` / `@aipehub/llm`. Same posture as
 * `WorkflowSurface` above.
 *
 * Absent when:
 *   - operator set `AIPE_ASSISTANT_DISABLED=1`, OR
 *   - the host couldn't resolve an LLM API key for the configured
 *     provider (no org-pool entry, no env fallback).
 * In either case, the route responds 503 and the admin UI hides the
 * "AI assistant" button.
 */
export interface WorkflowAssistSurface {
  assist(input: {
    description: string
    /** Optional hints — agent ids / MCP servers / existing workflow ids in this hub. */
    contextHints?: WorkflowAssistContextHints
    /** Caller (admin) participant id — stamped onto the dispatched task's `from`. */
    by: ParticipantId
  }): Promise<WorkflowAssistResult>
}

/**
 * Mirror of `@aipehub/workflow-assistant`'s `WorkflowAssistantPayload.contextHints`.
 * Kept as a structural duplicate so Web has zero workflow-assistant dep.
 */
export interface WorkflowAssistContextHints {
  agents?: ReadonlyArray<{
    id: string
    capabilities: ReadonlyArray<string>
    description?: string
  }>
  mcpServers?: ReadonlyArray<string>
  existingWorkflowIds?: ReadonlyArray<string>
}

/**
 * Mirror of `@aipehub/workflow-assistant`'s `WorkflowAssistantOutput`. The
 * Web layer returns these fields verbatim in the assist route's JSON body
 * (under `{ ok: true, ...result }`).
 */
export interface WorkflowAssistResult {
  yaml: string
  explanation: string
  raw: string
  draftStatus: 'valid' | 'no_yaml' | 'invalid'
  validationError?: string
  by?: string
  stopReason?: string
  /**
   * Phase 13 M4 — deep structural check result. Present iff the host's
   * assist surface ran the check (host only runs it when the request
   * carried `contextHints` AND the YAML parsed cleanly). Mirrors
   * `WorkflowStructureCheckResult` from `@aipehub/evals` — kept as a
   * duck-typed structural copy so the web layer has zero evals dep.
   */
  deepCheck?: WorkflowDeepCheckResult
}

/** Mirror of `WorkflowStructureCheckResult` (see `@aipehub/evals`). */
export interface WorkflowDeepCheckResult {
  ok: boolean
  violations: ReadonlyArray<WorkflowDeepCheckViolation>
}

/** Mirror of `WorkflowStructureViolation` (see `@aipehub/evals`). */
export interface WorkflowDeepCheckViolation {
  kind:
    | 'unknown_agent'
    | 'unknown_capability'
    | 'bad_ref'
    | 'forward_ref'
    | 'self_trigger_cycle'
    | 'id_collision'
  message: string
  path: string
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
  /**
   * Phase 14 — pass-through of the workflow's `surface.me` block when
   * present. Structurally mirrors `MeSurfaceSpec` in `@aipehub/workflow`
   * (kept `unknown` to avoid a runtime dep). `me-routes.ts` reads it to
   * derive the member-facing `/me` catalog.
   */
  surfaceMe?: unknown
  /**
   * Phase 19 P5 — pass-through of the workflow's `governance` block when
   * present. Structurally mirrors `WorkflowGovernanceSpec` in
   * `@aipehub/workflow` (kept `unknown` to avoid a runtime dep). The admin
   * UI renders it as a risk summary before import/publish.
   */
  governance?: unknown
  stepCount: number
  /**
   * Absolute path of the YAML file backing this workflow on disk, or
   * `null` if the runner was registered programmatically (no file).
   */
  file: string | null
  /** Phase 15 — lifecycle state. Absent only on legacy hosts that predate it. */
  state?: WorkflowLifecycleState
  /** Phase 15 — the revision new runs bind to. Absent for a never-published draft. */
  currentRevision?: number
}

// --- Phase 15 — lifecycle mirror types -------------------------------------
// Structural duplicates of `@aipehub/workflow`'s lifecycle shapes, so the Web
// layer can type the surface + echo the JSON without a runtime dep. Kept loose
// (`action` / `legalActions` as strings) — the routes only forward these.

export type WorkflowLifecycleState =
  | 'draft'
  | 'review'
  | 'published'
  | 'deprecated'
  | 'archived'

export interface WorkflowRevisionMeta {
  revision: number
  contentHash: string
  createdAt: number
  createdBy?: string
  origin: 'import' | 'saveDraft' | 'publish' | 'rollback'
  rolledBackFrom?: number
}

export interface WorkflowTransitionLog {
  at: number
  action: string
  from: WorkflowLifecycleState
  to: WorkflowLifecycleState
  by?: string
  targetRevision?: number
}

export interface WorkflowLifecycleView {
  workflowId: string
  state: WorkflowLifecycleState
  currentRevision?: number
  headRevision: number
  triggerCapability: string
  revisions: WorkflowRevisionMeta[]
  history: WorkflowTransitionLog[]
  legalActions: string[]
  registered: boolean
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
    reconcileHeartbeats: opts.reconcileHeartbeats,
    workflows: opts.workflows,
    meAgents: opts.meAgents,
    workflowAssist: opts.workflowAssist,
    services: opts.services,
    growthReports: opts.growthReports,
    inbox: opts.inbox,
    readinessGate: opts.readinessGate,
    identity: opts.identity,
    peerRegistry: opts.peerRegistry,
    reputation: opts.reputation,
    uploads: opts.uploads,
    agentCard: opts.agentCard,
    a2aServer: opts.a2aServer,
    mcpRegistry: opts.mcpRegistry,
    mcpFederation: opts.mcpFederation,
    peerManifests: opts.peerManifests,
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
  /** v5 D-M4 — see WebServerOptions.reconcileHeartbeats doc above. */
  reconcileHeartbeats: (() => Promise<void>) | undefined
  workflows: WorkflowSurface | undefined
  /** Phase 19 P1-M3 — see WebServerOptions.meAgents doc above. */
  meAgents: MeAgentListSurface | undefined
  /** Phase 13 M3 — see WebServerOptions.workflowAssist doc above. */
  workflowAssist: WorkflowAssistSurface | undefined
  services: ServicesAdminSurface | undefined
  growthReports: GrowthReportsAdminSurface | undefined
  /** Phase 16 — see WebServerOptions.inbox doc above. */
  inbox: InboxSurface | undefined
  readinessGate: { isReady: () => boolean } | undefined
  identity: IdentitySurface | undefined
  /** D1 — see WebServerOptions.peerRegistry doc above. */
  peerRegistry: WebServerOptions['peerRegistry'] | undefined
  /** Phase 6 #1 — see WebServerOptions.reputation doc above. */
  reputation: WebServerOptions['reputation'] | undefined
  /** Phase 9 M4 — see WebServerOptions.uploads doc above. */
  uploads: UploadSurface | undefined
  /** R3 — see WebServerOptions.agentCard doc above. */
  agentCard: AgentCardSurface | undefined
  /** Phase 18 C-M3 — see WebServerOptions.a2aServer doc above. */
  a2aServer: A2aServerSurface | undefined
  /** #2-M2 — see WebServerOptions.mcpRegistry doc above. */
  mcpRegistry: McpRegistrySurface | undefined
  /** #2-M3.4b — see WebServerOptions.mcpFederation doc above. */
  mcpFederation: McpFederationSurface | undefined
  /** Phase 18 A-M2 — see WebServerOptions.peerManifests doc above. */
  peerManifests: PeerManifestFederationSurface | undefined
  /**
   * Counters incremented on every HTTP response. Surfaced via
   * `/api/admin/metrics` so Prometheus can compute 5xx-rate (and a
   * dashboard / alert can fire on \"something's wrong\" without
   * scraping nginx logs). Counts reset on host restart — Prometheus
   * expects counter resets and handles them via `rate()`.
   */
  httpStats: HttpStats
}

// HttpStats moved to metrics.ts (C1 god-object split) — it exists solely
// to feed renderMetrics the per-server response-class counters.

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

  // --- A2A Agent Card (R3) — public discovery document ------------------
  // Unauthenticated by design: /.well-known/* is a public convention and
  // the conservative card carries only identity + auth-scheme declaration
  // (no skills, no participant enumeration). 404 when the host didn't
  // wire it (federation off / library use).
  if (path === '/.well-known/agent-card.json') {
    if (method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'GET' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    if (!ctx.agentCard) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'agent card not enabled' }))
      return
    }
    // Request-derived base URL so the card's `url` reflects how the client
    // actually reached us (correct behind a reverse proxy that sets
    // X-Forwarded-Proto). Falls back to http on direct connections.
    const xfProto = req.headers['x-forwarded-proto']
    const fwdProto = (Array.isArray(xfProto) ? xfProto[0] : xfProto)?.split(',')[0]?.trim()
    const proto = (ctx.trustProxy && fwdProto) || 'http'
    const baseUrl = `${proto}://${req.headers.host ?? 'localhost'}`
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
    })
    res.end(ctx.agentCard.json(baseUrl))
    return
  }

  // --- Inbound A2A (Phase 18 C-M3) --------------------------------------
  // BEFORE the CSRF gate and OUTSIDE requireAdmin: A2A is its own bearer-auth
  // domain (X-Aipe-Peer-Id + peer token), not a browser session, so the CSRF
  // Origin check (which a server-to-server caller can't satisfy) must not run.
  // The host A2aServer owns all auth + dispatch; 404 when not wired.
  if (path === '/a2a' || path === '/a2a/message') {
    if (!ctx.a2aServer) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'a2a not enabled' }))
      return
    }
    await ctx.a2aServer.handle(req, res)
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
    // C1 — even without a v3 admin session, fall through to the
    // unified SPA if the visitor carries a v4 identity cookie. They'll
    // see the role-aware shell (admin tabs for owner/admin, just
    // home+settings for member/viewer). Pure-anonymous visitors get the
    // legacy 401 prompt to nudge them toward the `?token=` flow.
    if (!sess) {
      const v4Cookie = readCookie(req, IDENTITY_COOKIE)
      if (!v4Cookie) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><meta charset=utf-8><title>AipeHub admin</title><body style="font-family:sans-serif;max-width:30rem;margin:6rem auto;color:#333"><h1>401 — admin token required</h1><p>Open this page with <code>?token=YOUR_TOKEN</code> appended, or sign in at <a href="/">/</a>.</p></body>')
        return
      }
    }
    await serveAppHtml(ctx, req, res)
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

  // --- /me redirect (legacy URL, removed in C1c) -------------------------
  // The /me static page was folded into the unified SPA's `home` tab
  // (served under /). A 301 redirect keeps any bookmarks / invitation
  // emails still pointing at /me working — the browser follows the
  // redirect, hits /, and the cookie check there serves the unified
  // SPA with role=member. /api/me/* routes are unchanged.
  if (method === 'GET' && (path === '/me' || path === '/me/')) {
    res.writeHead(301, { location: '/' })
    res.end()
    return
  }

  // --- /invite page (Phase 3 anonymous accept) ---------------------------
  // GET /invite or GET /invite/<token> → serve the static accept page.
  // The page's JS reads the token from window.location.pathname; we
  // don't need to forward it server-side. Anonymous by design — the
  // whole point is the recipient hasn't signed up yet.
  if (
    method === 'GET' &&
    (path === '/invite' ||
      path === '/invite/' ||
      /^\/invite\/[^/?#]+\/?$/.test(path))
  ) {
    await serveStatic(res, 'invite.html')
    return
  }

  // --- /api/me/* (member surface) ----------------------------------------
  // Member-gated routes for "any signed-in user can run their own thing".
  // Auth is checked inside handleMeRoute (v4 session required; any role).
  // Returns 503 when no IdentityStore is wired — the static /me page
  // gracefully shows the error.
  if (path.startsWith('/api/me/')) {
    if (!ctx.identity) {
      sendJson(
        res,
        { error: 'v4 identity store not enabled on this host' },
        503,
      )
      return
    }
    await handleMeRoute(
      {
        identity: ctx.identity,
        hub: ctx.hub,
        growthReports: ctx.growthReports,
        // AUDIT-P3-01/-02: share the v3 admin login limiter so /me
        // dispatch + reports rate-limits live in the same per-process
        // budget machinery. Per-user keys (me-dispatch:<userId> /
        // me-reports:<userId>) don't collide with the IP-keyed login
        // limiter under the same instance.
        loginLimiter: ctx.adminLoginLimiter,
        // Phase 14 — the member-facing /me catalog is DERIVED from the
        // live workflow list (only those declaring surface.me.enabled),
        // not a hardcoded allowlist. Undefined when the host wired no
        // workflow surface; /me workflow routes then degrade to empty.
        workflows: ctx.workflows,
        // Phase 19 P1-M2 — same workflow surface, used for "my recent runs".
        // WorkflowSurface structurally satisfies the narrow MeRunSurface
        // (its listRunsByUser returns the wider WorkflowRunSummary).
        runs: ctx.workflows,
        // Phase 19 P1-M3 — sanitized agent directory; undefined → empty list.
        meAgents: ctx.meAgents,
        // Phase 19 P1-M4 — member file uploads (same UploadSurface as admin,
        // member route scopes by userId); undefined → /api/me/uploads 503.
        uploads: ctx.uploads,
        // Phase 16 — member task inbox; undefined → /me/inbox degrades.
        inbox: ctx.inbox,
      },
      req,
      res,
      method,
      path,
    )
    return
  }

  // --- /api/invites/* (anonymous invitation accept) ----------------------
  // Phase 3 — public surface for redeeming an invitation link. No auth
  // gate here by design (the whole point is the recipient hasn't signed
  // up yet). Rate-limiting on the accept POST lives inside the dispatcher
  // and reuses the v3 admin login limiter under a distinct namespace.
  if (path.startsWith('/api/invites/')) {
    if (!ctx.identity) {
      sendJson(
        res,
        { error: 'v4 identity store not enabled on this host' },
        503,
      )
      return
    }
    const uaRawInv = req.headers['user-agent']
    const userAgentInv = Array.isArray(uaRawInv) ? uaRawInv.join(' ') : uaRawInv
    await handlePublicInvitationRoute(
      {
        identity: ctx.identity,
        cookieSecure: ctx.cookieSecure,
        loginLimiter: ctx.adminLoginLimiter,
        clientIp: clientIp(ctx, req),
        ...(userAgentInv ? { userAgent: userAgentInv } : {}),
      },
      req,
      res,
      method,
      path,
    )
    return
  }

  // --- /api/setup/* (A2.3 first-time bootstrap wizard) -------------------
  // First-time bootstrap wizard routes live in setup-routes.ts (P3 batch 3).
  // Both routes are anonymous / loopback-gated inside the handler — no
  // requireAdmin, because the whole point is the pre-password window before
  // any credential exists. See setup-routes.ts for the loopback trust model.
  if (path.startsWith('/api/setup/')) {
    const handled = await handleSetupRoute(
      { identity: ctx.identity },
      req, res, method, path,
    )
    if (handled) return
  }

  // --- v4 identity routes -------------------------------------------------
  // `/api/admin/identity/*` is the v4 multi-user surface. Auth is handled
  // inside `handleIdentityRoute` — owner is established exclusively by a
  // v4 IdentityStore session / api_key. v3-admin was removed in A2.2.
  // When the host didn't wire an IdentityStore, return 503 so the admin
  // UI can hide the tab.
  if (path.startsWith('/api/admin/identity/')) {
    if (!ctx.identity) {
      sendJson(
        res,
        { error: 'v4 identity store not enabled on this host' },
        503,
      )
      return
    }
    // A2.2 — v3-admin no longer participates in identity-route auth.
    // The owner gate inside handleIdentityRoute now reads v4 session /
    // bearer exclusively. server.ts still verifies v3 admin for the
    // host-level routes (agents, secrets, workflows) further below.
    // V4-AUDIT-06: User-Agent goes into audit rows. Headers can be
    // string | string[]; we coerce to a single string (Node never
    // splits User-Agent in practice, but the type allows for it).
    const uaRaw = req.headers['user-agent']
    const userAgent = Array.isArray(uaRaw) ? uaRaw.join(' ') : uaRaw
    await handleIdentityRoute(
      {
        identity: ctx.identity,
        cookieSecure: ctx.cookieSecure,
        // V4-AUDIT-01 / AUDIT-P3-06: reuse the same `RateLimiter`
        // INSTANCE (avoids a second allocation + GC sweep cycle), but
        // the budgets are PER-NAMESPACE — bearer:<ip>, cookie:<ip>,
        // identity-login:<ip>, invite-accept:<ip>, me-dispatch:<userId>,
        // me-reports:<userId>, owner-mutation:<actorKey> are all
        // independent buckets. This is intentional: an invite-accept
        // flood shouldn't punish a legit user's login attempts on the
        // same IP. The earlier comment claimed "the same per-IP slot,"
        // which was wrong — corrected here.
        loginLimiter: ctx.adminLoginLimiter,
        clientIp: clientIp(ctx, req),
        ...(userAgent ? { userAgent } : {}),
        ...(ctx.peerRegistry ? { peerRegistry: ctx.peerRegistry } : {}),
        ...(ctx.reputation ? { reputation: ctx.reputation } : {}),
      },
      req,
      res,
      method,
      path,
    )
    return
  }

  // --- workflows (v2.1) ------------------------------------------------
  // P3 audit cleanup — these routes used to live inline in this handler
  // (~190 lines around line 1830). Now extracted into workflow-routes.ts;
  // the dispatcher returns true iff it matched the request so we can
  // fall through to the rest of the handler chain otherwise.
  //
  // Auth: each handler in the sub-module calls back into our
  // `requireAdmin` closure so the v3 admin auth machinery (cookies,
  // sessions, rate limiter) stays here in server.ts.
  if (path.startsWith('/api/admin/workflows')) {
    // P2-M5b — workflow RBAC is ON only when the identity store actually
    // carries the grant methods (a current @aipehub/identity); otherwise the
    // routes see `grants: undefined` and skip RBAC (back-compat). The web
    // IdentitySurface intentionally doesn't model identity's full API, so we
    // runtime-check + cast rather than widen the structural type.
    const wfGrants: WorkflowGrantSink | undefined =
      ctx.identity &&
      typeof (ctx.identity as { hasWorkflowGrant?: unknown }).hasWorkflowGrant ===
        'function'
        ? (ctx.identity as unknown as WorkflowGrantSink)
        : undefined
    const handled = await handleWorkflowRoute(
      {
        hub: ctx.hub,
        workflows: ctx.workflows,
        workflowAssist: ctx.workflowAssist,
        // P2-M2 — the IdentityStore structurally satisfies WorkflowAuditSink
        // (writeAuditLog is optional on both). Governance-significant
        // lifecycle transitions write one audit row through it.
        audit: ctx.identity,
        // P2-M5b — resource RBAC. `resolveActor` derives the acting admin's
        // RBAC identity: a v4 owner/admin → that user (operator iff owner); a
        // v3 Space-admin (requireAdmin passed but no v4 user) → operator bypass.
        grants: wfGrants,
        resolveActor: (rq) => {
          if (ctx.identity) {
            const auth = resolveV4Auth(ctx.identity, rq)
            if (auth.user && auth.role) {
              return { userId: auth.user.id, isOperator: auth.role === 'owner' }
            }
          }
          return { userId: null, isOperator: true }
        },
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
      },
      req,
      res,
      method,
      path,
      url,
    )
    if (handled) return
  }

  // Agents CRUD + bundle import live in agents-routes.ts (P3 audit cleanup).
  if (path.startsWith('/api/admin/agents') || path === '/api/admin/bundles/import') {
    const handled = await handleAgentsRoute(
      {
        hub: ctx.hub,
        space: ctx.space,
        lifecycle: ctx.lifecycle,
        reconcileHeartbeats: ctx.reconcileHeartbeats,
        workflows: ctx.workflows,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
      },
      req, res, method, path,
    )
    if (handled) return
  }

  // Hub Services admin (plugins, trash, sweep) in services-routes.ts.
  if (path.startsWith('/api/admin/services')) {
    const handled = await handleServicesRoute(
      {
        services: ctx.services,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
      },
      req, res, method, path,
    )
    if (handled) return
  }

  // File upload / download in uploads-routes.ts.
  if (path === '/api/admin/uploads') {
    const handled = await handleUploadsRoute(
      {
        uploads: ctx.uploads,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
      },
      req, res, method, path,
    )
    if (handled) return
  }

  // Hub MCP server registry (install / list / uninstall) in mcp-routes.ts.
  if (path.startsWith('/api/admin/mcp-servers')) {
    const handled = await handleMcpRoute(
      {
        mcpRegistry: ctx.mcpRegistry,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
      },
      req, res, method, path,
    )
    if (handled) return
  }

  // #2-M3.4b — cross-hub federation discovery (browse peers' shared servers).
  if (path === '/api/admin/mcp-shared') {
    const handled = await handleMcpFederationRoute(
      {
        mcpFederation: ctx.mcpFederation,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
      },
      req, res, method, path,
    )
    if (handled) return
  }

  // Phase 18 A-M2 — cross-hub peer capability manifest browse + refresh.
  if (path === '/api/admin/peer-manifests' || path === '/api/admin/peer-manifests/refresh') {
    const handled = await handlePeerManifestRoute(
      {
        peerManifests: ctx.peerManifests,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
      },
      req, res, method, path,
    )
    if (handled) return
  }

  // Admin-console ops routes (admins / secrets / feedback / growth /
  // applications) live in admin-routes.ts (C1 god-object split). Called
  // unconditionally — handleAdminRoute does precise method+path matching
  // and returns false (fall through) for anything it doesn't own.
  {
    const handled = await handleAdminRoute(
      {
        hub: ctx.hub,
        space: ctx.space,
        growthReports: ctx.growthReports,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
      },
      req, res, method, path,
    )
    if (handled) return
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
    // P3-M1 — gather the business-metrics snapshot from the host surfaces
    // (workflow runs + identity ledger/suspended). All best-effort: a wholly
    // absent/erroring source yields {} and only the hub metrics render. The
    // `.catch` is belt-and-suspenders — collectBusinessMetrics swallows its
    // own per-family errors, but a scrape must never 500.
    const business = await collectBusinessMetrics({
      workflows: ctx.workflows,
      // ctx.identity structurally carries countSuspendedTasks + aggregateLedger
      // on a current host; the narrow MetricsIdentitySource models just those.
      identity: ctx.identity as unknown as MetricsIdentitySource | undefined,
    }).catch(() => ({}))
    const text = renderMetrics(ctx.hub, { httpStats: ctx.httpStats, business })
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

  // Upload/download routes live in uploads-routes.ts (P3 audit cleanup).
  // The dispatcher is wired further up — see the `/api/admin/uploads` block.

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
    // C1 — root path routing. Visitors with a v4 identity cookie OR a
    // v3 admin cookie get the unified SPA (role meta injected). Pure
    // anonymous visitors keep landing on the v3 worker join page so
    // classroom / demo URLs continue working unchanged.
    if (path === '/') {
      const hasV4 = ctx.identity && readCookie(req, IDENTITY_COOKIE)
      const hasV3 = readCookie(req, ADMIN_COOKIE)
      if (hasV4 || hasV3) {
        await serveAppHtml(ctx, req, res)
        return
      }
      await serveStatic(res, 'worker.html')
      return
    }
    const requested = path.replace(/^\//, '')
    await serveStatic(res, requested)
    return
  }

  res.writeHead(405)
  res.end()
}

// --- admin auth helpers ----------------------------------------------------

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
  let v4AdminChecked = false
  if (bearer && isV4BearerToken(bearer)) {
    v4AdminChecked = true
    const admin = v4AdminFromRequest(ctx, req)
    if (admin) return { kind: 'admin', admin }
  } else if (bearer) {
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
  if (!v4AdminChecked) {
    const v4Admin = v4AdminFromRequest(ctx, req)
    if (v4Admin) return { kind: 'admin', admin: v4Admin }
  }
  return { kind: 'none' }
}

function isV4BearerToken(token: string): boolean {
  return token.startsWith('aipk_') || token.startsWith('adm_')
}

function v4AdminFromRequest(ctx: HandlerCtx, req: IncomingMessage): AdminRecord | null {
  if (!ctx.identity) return null
  const auth = resolveV4Auth(ctx.identity, req)
  if (!auth.user || (auth.role !== 'owner' && auth.role !== 'admin')) return null
  return {
    id: auth.user.id as ParticipantId,
    displayName: auth.user.displayName ?? auth.user.email,
    tokenHash: `v4:${auth.source}`,
    createdAt: new Date(auth.user.createdAt).toISOString(),
  }
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

  // AUDIT-P3-07: baseline security headers for every static response.
  // Applied uniformly (not just HTML) — the cost is bytes-per-response,
  // the benefit is defense-in-depth without per-page bookkeeping.
  //   X-Content-Type-Options: nosniff — MIME-sniffing prevention.
  //   X-Frame-Options: DENY — clickjacking prevention (admin / me /
  //     invite must never be embedded in a third-party page).
  //   Referrer-Policy: no-referrer — no token / state leaks via Referer
  //     to any subresource the page might fetch.
  // Note: full CSP is intentionally NOT added here — admin.js uses
  // inline event handlers in a few places; a strict CSP would break
  // them and demands a separate refactor.
  const securityHeaders: Record<string, string> = {
    'content-type': contentType,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  }

  // Production path: embedded asset map. Populated by
  // scripts/build-static-assets.mjs; works in node, bun, and bun --compile
  // single-file binaries (where filesystem reads relative to import.meta.url
  // are not available).
  const embedded = getEmbeddedAsset(key)
  if (embedded) {
    res.writeHead(200, securityHeaders)
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
    res.writeHead(200, securityHeaders)
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

/**
 * C1 — serve `app.html` (the unified SPA shell) with the viewer's v4
 * role injected into the `<meta name="x-aipehub-role">` tag.
 *
 * Role resolution order:
 *   1. v4 identity cookie → `identity.getSessionByToken().role` —
 *      authoritative for member / viewer / admin / owner.
 *   2. v3 admin cookie (legacy `/admin?token=` flow, or admins migrated
 *      forward from Phase 1) → treated as 'owner'-equivalent for SPA
 *      rendering. v3 admin is unconditional access; the role-aware tab
 *      filter would otherwise lock these accounts out of the new shell
 *      until they re-login via v4.
 *   3. Neither → empty string. app.js sees `''` and renders the
 *      anonymous login form; server-side enforcement is unchanged
 *      (every API route still runs its own auth gate).
 *
 * The injected meta is a RENDER HINT only — never a security boundary.
 * A user who forges a v4 cookie that fails server validation will see
 * the tab matching the forged role but every API call returns 401/403
 * because they don't have a real session.
 */
async function serveAppHtml(
  ctx: HandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let role = ''
  // v4 cookie first.
  if (ctx.identity) {
    const tok = readCookie(req, IDENTITY_COOKIE)
    if (tok) {
      try {
        const r = ctx.identity.getSessionByToken(tok)
        if (r) role = r.role
      } catch {
        // bad/expired cookie — treat as anonymous; the SPA will show
        // the login form. Don't leak the error to the client.
      }
    }
  }
  // v3 admin fallback.
  if (!role) {
    const sid = readCookie(req, ADMIN_COOKIE)
    if (sid) {
      const sess = await ctx.space.findAdminSession(sid)
      if (sess) role = 'owner'
    }
  }

  const securityHeaders = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  }

  // Same dual-source pattern as serveStatic — embedded base64 in prod,
  // filesystem fallback in dev. The cache keeps app.html as a Buffer;
  // we toString() per request because the role differs per call. The
  // template body is small (~37 KB) so the per-request encode is cheap
  // — well under a memory-cache cost for keying per role.
  let raw: string | null = null
  const embedded = getEmbeddedAsset('app.html')
  if (embedded) {
    raw = embedded.toString('utf8')
  } else {
    try {
      raw = (await readFile(join(STATIC_DIR, 'app.html'))).toString('utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('app.html missing — run packages/web build:assets')
        return
      }
      throw err
    }
  }

  // Single, idempotent substitution. The placeholder is `<!--AIPE_ROLE-->`
  // — anything else (legitimate user content, future translated strings)
  // is left intact. Role values are validated against a small enum so
  // an attacker who somehow stuffed garbage into the session can't break
  // out of the meta attribute.
  const ALLOWED_ROLES = new Set(['owner', 'admin', 'member', 'viewer'])
  const safeRole = ALLOWED_ROLES.has(role) ? role : ''
  const out = raw.replace('<!--AIPE_ROLE-->', safeRole)

  res.writeHead(200, securityHeaders)
  res.end(out)
}

// validateAgentBody, publicAgent, readRawBody moved to
// agents-routes.ts / uploads-routes.ts (P3 audit cleanup).

/**
 * Translate a `@aipehub/services-sdk` typed error to an HTTP status.
 * The web layer doesn't import the sdk's errors (it stays decoupled
 * from the services package). We pattern-match on the error name —
 * those names are stable string constants set in the sdk's
 * `new.target.name` and round-trip across module boundaries.
 */
// sendServiceError moved to services-routes.ts (P3 audit cleanup).

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
