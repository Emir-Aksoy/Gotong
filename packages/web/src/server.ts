import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readBearer, readCookie, readJsonBody, sendJson } from './http-helpers.js'
import { serveStatic, serveAppHtml } from './static-routes.js'
import {
  SECURITY_HEADERS,
  clientIp,
  checkOrigin,
  readBearerToken,
  constantTimeEqual,
} from './security-helpers.js'

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
} from '@gotong/core'
import { HttpStats, renderMetrics } from './metrics.js'
import {
  collectBusinessMetrics,
  type MetricsIdentitySource,
} from './business-metrics.js'

const log = createLogger('web')

// Manifest parsing is used by agents-routes.ts (P3 audit cleanup).
// server.ts no longer needs these imports directly.
import {
  handleIdentityRoute,
  handlePublicInvitationRoute,
  IDENTITY_COOKIE,
  resolveV4Auth,
  type IdentitySurface,
  type IdentityPeerReputationDTO,
} from './identity-routes.js'
import {
  handleMeRoute,
  type InboxSurface,
  type MeAgentListSurface,
  type MeAgentAdminSurface,
  type MeAgentGrantsSurface,
  type MeCredentialsSurface,
  type ButlerMemorySurface,
  type MeImSurface,
  type MeWorkflowEditSurface,
  type MeWorkflowCreateSurface,
  type MeHubStewardSurface,
} from './me-routes.js'
import {
  handleWorkflowRoute,
  type WorkflowGrantSink,
} from './workflow-routes.js'
import { handleWizardAdminRoute, type WorkflowWizardSurface } from './wizard-routes.js'
import { handleAgentsRoute, type AgentGrantSink, type ConnectorSlotSink, type LlmKeyProbe, type RoutingProbeSurface } from './agents-routes.js'
import { handleTemplateAcceptanceRoute, type TemplateAcceptanceSurface } from './template-acceptance-routes.js'
import { handleAdminStewardRoute } from './admin-steward-routes.js'
import { handleServicesRoute } from './services-routes.js'
import { handleUploadsRoute } from './uploads-routes.js'
import { handleSetupRoute, isBootstrapPending, isLoopbackReq, type SetupRoutesCtx } from './setup-routes.js'
import { handleAdminRoute } from './admin-routes.js'
import {
  handleMcpRoute,
  handleMcpFederationRoute,
  handleMcpConnectorsRoute,
  type McpRegistrySurface,
  type McpFederationSurface,
} from './mcp-routes.js'

import {
  handlePeerManifestRoute,
} from './peer-routes.js'
import {
  handlePeerSummaryRoute,
  handlePeerSummaryAlertRoute,
  type PeerSummaryFederationSurface,
} from './peer-summary-routes.js'
import { handleTemplateRoute, type TemplatePersonnelSource } from './template-routes.js'
import {
  type PeerManifestFederationSurface,
} from './peer-routes.js'
import { handleOidcRoute, type OidcLoginSurface } from './oidc-routes.js'
import { handleOidcAdminRoute, type OidcProviderAdminSurface } from './oidc-admin-routes.js'
import { handleOAuthConnectCallbackRoute, handleOAuthConnectAdminRoute, type OAuthConnectSurface } from './oauth-connect-routes.js'
import { handleOAuthConnectorAdminRoute, type OAuthConnectorAdminSurface } from './oauth-connector-admin-routes.js'
import { handleSamlRoute, type SamlLoginSurface } from './saml-routes.js'
import { handleSamlAdminRoute, type SamlProviderAdminSurface } from './saml-admin-routes.js'
import { handleA2aAdminRoute, type A2aAgentAdminSurface } from './a2a-admin-routes.js'
import { handleAcpAdminRoute, type AcpAgentAdminSurface } from './acp-admin-routes.js'
import { handleSettingRoute, type SettingOpsSurface } from './setting-routes.js'
import {
  handleWorkflowScheduleRoute,
  type WorkflowScheduleAdminSurface,
} from './workflow-schedule-routes.js'

export type { PeerManifestFederationSurface, PeerManifestRow } from './peer-routes.js'
export type {
  PeerSummaryFederationSurface,
  PeerSummaryRow,
  PeerSummary,
  PeerSummaryHistoryQuery,
  PeerSummaryTrendPoint,
  PeerSummaryAlertRule,
  PeerSummaryAlertBreach,
  PeerSummaryAlertRuleAddInput,
  PeerSummaryAlertRuleUpdateInput,
  PeerSummaryAlertFiring,
  PeerSummaryAlertFiringQuery,
  PeerSummaryAlertChannel,
  PeerSummaryAlertChannelAddInput,
  PeerSummaryAlertChannelUpdateInput,
  PeerSummaryAlertDeliveryResult,
} from './peer-summary-routes.js'
export type { OidcLoginSurface } from './oidc-routes.js'
export type { OidcProviderAdminSurface, OidcProviderView } from './oidc-admin-routes.js'
export type { OAuthConnectSurface } from './oauth-connect-routes.js'
export type { OAuthConnectorAdminSurface, OAuthConnectorView } from './oauth-connector-admin-routes.js'
export type { SamlLoginSurface } from './saml-routes.js'
export type { SamlProviderAdminSurface, SamlProviderView } from './saml-admin-routes.js'
export type { A2aAgentAdminSurface, A2aAgentView } from './a2a-admin-routes.js'
export type { AcpAgentAdminSurface, AcpAgentView } from './acp-admin-routes.js'
export type {
  SettingOpsSurface,
  SettingOpsActor,
  SettingCommandInfo,
  SettingOpsResult,
  SettingTier,
} from './setting-routes.js'
export type {
  WorkflowScheduleAdminSurface,
  WorkflowScheduleView,
  WorkflowScheduleFireResult,
} from './workflow-schedule-routes.js'

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
 * Reference web UI for Gotong (v2.0 — file-first).
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

// Static-asset serving (STATIC_DIR / embedded-asset cache / MIME /
// serveStatic / serveAppHtml) moved to ./static-routes.js (#19 megalith
// split). Imported below.

const ADMIN_COOKIE = 'gotong_admin'
const WORKER_COOKIE = 'gotong_worker'
const COOKIE_MAX_AGE_S = 7 * 24 * 3600

// ── Type surface extracted to ./server-types.ts (assembly-layer line-budget
// relief). Pure type declarations: WebServerOptions + every injected *Surface
// duck type + the workflow view mirrors. Imported back here for local
// signatures, and re-exported so `./server.js` stays the single import point
// for consumers and tests. See server-types.ts header for the full story.
import type {
  WebServerOptions,
  WebServerHandle,
  UploadSurface,
  WorkflowRunSummary,
  WorkflowSurface,
  AgentCardSurface,
  A2aServerSurface,
  AdminHealthSurface,
  ResourceInventorySurface,
  ResourceAdaptationSurface,
  WorkflowAssistSurface,
  LlmKeyTestSurface,
} from './server-types.js'
export type {
  WebServerOptions,
  AgentCardSurface,
  A2aServerSurface,
  UploadSurface,
  WorkflowSurface,
  HealthSnapshot,
  AdminHealthSurface,
  ResInventoryLlmKeyRow,
  ResInventoryEndpointRow,
  ResInventoryCliRow,
  ResInventoryMcpRow,
  ResInventorySnapshot,
  ResourceInventorySurface,
  ResAdaptationProposal,
  ResourceAdaptationSurface,
  WorkflowAssistSurface,
  LlmKeyTestSurface,
  LlmKeyTestResult,
  WorkflowAssistContextHints,
  WorkflowAssistResult,
  WorkflowDeepCheckResult,
  WorkflowDeepCheckViolation,
  WorkflowSummary,
  CrossHubStepView,
  WorkflowGraphView,
  WorkflowGraphNode,
  WorkflowGraphDestination,
  WorkflowGraphCrossHub,
  WorkflowGraphEdge,
  WorkflowLifecycleState,
  WorkflowRevisionMeta,
  WorkflowTransitionLog,
  WorkflowLifecycleView,
  WorkflowRunSummary,
  WebServerHandle,
} from './server-types.js'

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
        '@gotong/web v2.0 requires hub.space — construct the Hub with `new Hub({ space })`. The in-memory path was removed; use Space.openOrInit(dir, ...) first.',
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
    llmKeyProbe: opts.llmKeyProbe,
    routingProbe: opts.routingProbe,
    connectorSlots: opts.connectorSlots,
    templateAcceptance: opts.templateAcceptance,
    scheduleSuggestions: opts.scheduleSuggestions,
    adminHealth: opts.adminHealth,
    resourceInventory: opts.resourceInventory,
    resourceAdaptation: opts.resourceAdaptation,
    reconcileHeartbeats: opts.reconcileHeartbeats,
    workflows: opts.workflows,
    templatePersonnel: opts.templatePersonnel,
    meAgents: opts.meAgents,
    meAgentAdmin: opts.meAgentAdmin,
    meAgentGrants: opts.meAgentGrants,
    meCredentials: opts.meCredentials,
    butlerMemory: opts.butlerMemory,
    meIm: opts.meIm,
    workflowAssist: opts.workflowAssist,
    llmKeyTest: opts.llmKeyTest,
    imHotStart: opts.imHotStart,
    bootstrapPending: () => isBootstrapPending(opts.identity),
    services: opts.services,
    growthReports: opts.growthReports,
    inbox: opts.inbox,
    workflowEdit: opts.workflowEdit,
    workflowCreate: opts.workflowCreate,
    workflowWizard: opts.workflowWizard,
    hubSteward: opts.hubSteward,
    operatorSteward: opts.operatorSteward,
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
    peerSummaries: opts.peerSummaries,
    oidcLogin: opts.oidcLogin,
    oauthConnect: opts.oauthConnect,
    oauthConnectorAdmin: opts.oauthConnectorAdmin,
    samlLogin: opts.samlLogin,
    oidcAdmin: opts.oidcAdmin,
    samlAdmin: opts.samlAdmin,
    a2aAgents: opts.a2aAgents,
    acpAgents: opts.acpAgents,
    settingOps: opts.settingOps,
    workflowSchedules: opts.workflowSchedules,
    httpStats: new HttpStats(),
    metricsToken: opts.metricsToken,
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
  llmKeyProbe: LlmKeyProbe | undefined
  /** MR-M5 — see WebServerOptions.routingProbe doc (server-types.ts). */
  routingProbe: RoutingProbeSurface | undefined
  connectorSlots: ConnectorSlotSink | undefined
  templateAcceptance: TemplateAcceptanceSurface | undefined
  scheduleSuggestions: WebServerOptions['scheduleSuggestions']
  adminHealth: AdminHealthSurface | undefined
  /** RES-M1 — see WebServerOptions.resourceInventory doc above. */
  resourceInventory: ResourceInventorySurface | undefined
  /** RES-M2 — see WebServerOptions.resourceAdaptation doc above. */
  resourceAdaptation: ResourceAdaptationSurface | undefined
  /** v5 D-M4 — see WebServerOptions.reconcileHeartbeats doc above. */
  reconcileHeartbeats: (() => Promise<void>) | undefined
  workflows: WorkflowSurface | undefined
  /** v5 B-M3 — see WebServerOptions.templatePersonnel doc above. */
  templatePersonnel: TemplatePersonnelSource | undefined
  /** Phase 19 P1-M3 — see WebServerOptions.meAgents doc above. */
  meAgents: MeAgentListSurface | undefined
  /** v5 A-M2 — see WebServerOptions.meAgentAdmin doc above. */
  meAgentAdmin: MeAgentAdminSurface | undefined
  /** v5 A-M4 — see WebServerOptions.meAgentGrants doc above. */
  meAgentGrants: MeAgentGrantsSurface | undefined
  /** v5 A-M3 — see WebServerOptions.meCredentials doc above. */
  meCredentials: MeCredentialsSurface | undefined
  butlerMemory: ButlerMemorySurface | undefined
  /** GO-LIVE GL-1c — see WebServerOptions.meIm doc above. */
  meIm: MeImSurface | undefined
  /** Phase 13 M3 — see WebServerOptions.workflowAssist doc above. */
  workflowAssist: WorkflowAssistSurface | undefined
  /** ease-of-use ① — see WebServerOptions.llmKeyTest doc above. */
  llmKeyTest: LlmKeyTestSurface | undefined
  /** DEPLOY-B2 — see WebServerOptions.imHotStart doc above. */
  imHotStart: SetupRoutesCtx['imHotStart'] | undefined
  /**
   * DEPLOY-C followup — serveAppHtml's bootstrap-window render hint
   * (static-routes AppHtmlCtx.bootstrapPending). Closes over the identity
   * option so setup-routes' isBootstrapPending stays the single source of
   * truth for "is the first-run window open".
   */
  bootstrapPending: () => boolean
  services: ServicesAdminSurface | undefined
  growthReports: GrowthReportsAdminSurface | undefined
  /** Phase 16 — see WebServerOptions.inbox doc above. */
  inbox: InboxSurface | undefined
  /** WFEDIT-M3 — see WebServerOptions.workflowEdit doc above. */
  workflowEdit: MeWorkflowEditSurface | undefined
  /** ARCH-M6 — see WebServerOptions.workflowCreate doc above. */
  workflowCreate: MeWorkflowCreateSurface | undefined
  /** WIZ-M4 — see WebServerOptions.workflowWizard doc above. */
  workflowWizard: WorkflowWizardSurface | undefined
  /** SW-M6 — see WebServerOptions.hubSteward doc above. */
  hubSteward: MeHubStewardSurface | undefined
  /** SW-M9 A-M6 — see WebServerOptions.operatorSteward doc above. */
  operatorSteward: MeHubStewardSurface | undefined
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
  /** v5 E5-M3 — see WebServerOptions.peerSummaries doc above. */
  peerSummaries: PeerSummaryFederationSurface | undefined
  /** Route B P1-M4e — see WebServerOptions.oidcLogin doc above. */
  oidcLogin: OidcLoginSurface | undefined
  /** C-M2-M3 — outbound OAuth connect (begin admin-gated, callback public). */
  oauthConnect: OAuthConnectSurface | undefined
  /** C-M2-M5a — outbound OAuth connector CRUD (admin). */
  oauthConnectorAdmin: OAuthConnectorAdminSurface | undefined
  /** Route B P1-M5e — see WebServerOptions.samlLogin doc above. */
  samlLogin: SamlLoginSurface | undefined
  /** Route B P1-M4f — see WebServerOptions.oidcAdmin doc above. */
  oidcAdmin: OidcProviderAdminSurface | undefined
  /** Route B P1-M5f — see WebServerOptions.samlAdmin doc above. */
  samlAdmin: SamlProviderAdminSurface | undefined
  /** Route B P1-M11c — see WebServerOptions.a2aAgents doc above. */
  a2aAgents: A2aAgentAdminSurface | undefined
  /** ACP-OUT-M3 — see WebServerOptions.acpAgents doc above. */
  acpAgents: AcpAgentAdminSurface | undefined
  /** setting-ops M4 — see WebServerOptions.settingOps doc above. */
  settingOps: SettingOpsSurface | undefined
  /** LIFE-L1-M3 — see WebServerOptions.workflowSchedules doc above. */
  workflowSchedules: WorkflowScheduleAdminSurface | undefined
  /**
   * Counters incremented on every HTTP response. Surfaced via
   * `/api/admin/metrics` so Prometheus can compute 5xx-rate (and a
   * dashboard / alert can fire on \"something's wrong\" without
   * scraping nginx logs). Counts reset on host restart — Prometheus
   * expects counter resets and handles them via `rate()`.
   */
  httpStats: HttpStats
  /** Route B P0-M7 — see WebServerOptions.metricsToken doc above. */
  metricsToken: string | undefined
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
 *   `@gotong/web`'s package surface.
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

// SECURITY_HEADERS / clientIp / checkOrigin / readBearerToken /
// constantTimeEqual moved to ./security-helpers.js (#19 megalith split).

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

  // --- JWKS (STD-M1) — public signing keys for the card's JWS signatures ----
  // Same public convention as the card; 404 when the host didn't wire a card
  // OR when card signing is off (jwks() returns null).
  if (path === '/.well-known/jwks.json') {
    if (method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'GET' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    const jwks = ctx.agentCard?.jwks?.() ?? null
    if (!jwks) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'jwks not enabled' }))
      return
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
    })
    res.end(jwks)
    return
  }

  // --- Inbound A2A (Phase 18 C-M3) --------------------------------------
  // BEFORE the CSRF gate and OUTSIDE requireAdmin: A2A is its own bearer-auth
  // domain (X-Gotong-Peer-Id + peer token), not a browser session, so the CSRF
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

  // --- Public OIDC login (Route B P1-M4e) -------------------------------
  // BEFORE the CSRF gate and OUTSIDE requireAdmin: these are top-level browser
  // navigations (the IdP redirect to /callback carries no Origin header and no
  // session yet), so the CSRF Origin check must not run. The callback mints the
  // identity cookie on success; the host surface owns all OIDC auth + policy.
  if (await handleOidcRoute({ oidcLogin: ctx.oidcLogin, cookieSecure: ctx.cookieSecure }, req, res, method, path)) {
    return
  }

  // C-M2-M3 — public outbound OAuth connect callback (state-protected; the
  // begin half is admin-gated below). Pre-CSRF like the OIDC callback.
  if (await handleOAuthConnectCallbackRoute({ oauthConnect: ctx.oauthConnect }, req, res, method, path)) {
    return
  }

  // --- Public SAML 2.0 SP login (Route B P1-M5e) ------------------------
  // BEFORE the CSRF gate and OUTSIDE requireAdmin. /start is a top-level browser
  // navigation; the ACS is a CROSS-SITE form POST auto-submitted by the IdP — it
  // carries no Origin/CSRF token, so the Origin check must not run. Authenticity
  // comes from the SIGNED assertion (pinned IdP cert), not same-origin; the host
  // surface owns all SAML auth + policy and the ACS mints the identity cookie.
  if (await handleSamlRoute({ samlLogin: ctx.samlLogin, cookieSecure: ctx.cookieSecure }, req, res, method, path)) {
    return
  }

  // --- Internal metrics scrape (Route B P0-M7) --------------------------
  // BEFORE the CSRF gate and OUTSIDE requireAdmin: a Prometheus scraper is a
  // server-to-server client with no browser session, so it satisfies neither
  // the admin cookie nor the CSRF Origin check. This route has its own
  // bearer-token domain (GOTONG_METRICS_TOKEN), letting an operator scrape the
  // SAME body as /api/admin/metrics WITHOUT minting a machine admin (which
  // would widen the admin surface to a scraper credential).
  //
  // Fail-closed: when the token is unset the route 404s — indistinguishable
  // from "no such endpoint", so an unconfigured deployment exposes no
  // anonymous metrics. Set + correct bearer → 200; set + wrong/absent bearer
  // → 401 via constant-time compare (no token-length/prefix timing oracle).
  if (method === 'GET' && path === '/metrics') {
    if (!ctx.metricsToken) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'metrics scrape not enabled' }))
      return
    }
    const presented = readBearerToken(req)
    if (!presented || !constantTimeEqual(presented, ctx.metricsToken)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    // Identical snapshot to /api/admin/metrics: business metrics are
    // best-effort (a scrape must never 500 — collectBusinessMetrics swallows
    // its own per-family errors, the `.catch` is belt-and-suspenders) and the
    // hub metrics always render.
    const business = await collectBusinessMetrics({
      workflows: ctx.workflows,
      identity: ctx.identity as unknown as MetricsIdentitySource | undefined,
    }).catch(() => ({}))
    const text = renderMetrics(ctx.hub, { httpStats: ctx.httpStats, business })
    res.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    })
    res.end(text)
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

  // --- federation self-identity (ease-of-use ④-M1) ------------------------
  // Lightweight read for the pairing-code wizard: the self peerId a partner
  // hub must register us under (= our space hubId, the same value stamped on
  // every outbound federation HELLO) plus our WS port so the UI can suggest a
  // sensible endpoint default. Neither value is secret — the hubId is already
  // broadcast to every peer — but gate behind admin/worker auth to avoid
  // anonymous enumeration, mirroring /api/state. The externally-reachable
  // endpoint URL is genuinely operator knowledge (proxy / TLS / port-forward),
  // so the wizard only DEFAULTS it from these and lets the operator confirm.
  if (method === 'GET' && path === '/api/federation/self') {
    if (!(await requireAdminOrWorker(ctx, req, res))) return
    const config = await ctx.space.config()
    const meta = await ctx.space.meta()
    sendJson(res, { hubId: meta.hubId ?? null, wsPort: config.wsPort })
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
        res.end('<!doctype html><meta charset=utf-8><title>Gotong admin</title><body style="font-family:sans-serif;max-width:30rem;margin:6rem auto;color:#333"><h1>401 — admin token required</h1><p>Open this page with <code>?token=YOUR_TOKEN</code> appended, or sign in at <a href="/">/</a>.</p></body>')
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
        // v5 A-M2 — member agent ownership + self-service CRUD; undefined → 503.
        meAgentAdmin: ctx.meAgentAdmin,
        // v5 A-M4 — member agent access-grant sharing; undefined → 503.
        meAgentGrants: ctx.meAgentGrants,
        // v5 A-M3 — member API-credential management; undefined → 503.
        meCredentials: ctx.meCredentials,
        // Personal Butler M6c — member butler-memory privacy view; undefined →
        // empty snapshot (GET) / 503 (forget/export).
        butlerMemory: ctx.butlerMemory,
        // GO-LIVE GL-1c — member IM-account linking; undefined → 503.
        meIm: ctx.meIm,
        // Phase 19 P1-M4 — member file uploads (same UploadSurface as admin,
        // member route scopes by userId); undefined → /api/me/uploads 503.
        uploads: ctx.uploads,
        // Phase 16 — member task inbox; undefined → /me/inbox degrades.
        inbox: ctx.inbox,
        // WFEDIT-M3 — member NL workflow editing; undefined → /me/workflows/:id
        // edit + editable routes return 503.
        workflowEdit: ctx.workflowEdit,
        // ARCH-M6 — member NL workflow AUTHORING + explain; undefined →
        // /me/workflows/create + /me/workflows/:id/explain return 503.
        workflowCreate: ctx.workflowCreate,
        // WIZ-M4 — 六段建流向导; undefined → /me/workflows/wizard/* returns 503.
        workflowWizard: ctx.workflowWizard,
        // SW-M6 — the hub steward ("管家"); undefined → /me/steward/* returns 503.
        hubSteward: ctx.hubSteward,
        // ease-of-use ①TC-ME — member "test connection" for a BYO key; the SAME
        // probe surface the setup/admin routes use. undefined → /api/me/test-llm-key
        // returns 503. Member route is provider-restricted + no baseURL (no SSRF).
        llmKeyTest: ctx.llmKeyTest,
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
  // The writes are gated inside the handler on two trust anchors: loopback
  // socket, or an authenticated operator (`isOperator` below — the same
  // admin resolver every /api/admin/* route uses). Anchor 2 is what lets
  // the wizard run through a Docker port-forward, where the source IP is
  // the bridge gateway and can never be loopback: the operator signs in via
  // the runtime/admin-link.txt URL first. `rate_limited` maps to false →
  // the gate fails closed with 403. See setup-routes.ts for the full model.
  if (path.startsWith('/api/setup/')) {
    const handled = await handleSetupRoute(
      {
        identity: ctx.identity,
        llmKeyTest: ctx.llmKeyTest,
        imHotStart: ctx.imHotStart,
        isOperator: async (r) => (await findAdminFromRequest(ctx, r)).kind === 'admin',
      },
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
  // P2-M5b / v5 E4-M1 — shared resource-RBAC actor resolver for the workflow
  // AND agent admin routes. A v4 owner/admin → that user (operator iff owner);
  // a v3 Space-admin (requireAdmin passed but no v4 user) → operator bypass.
  const resolveResourceActor = (
    rq: IncomingMessage,
  ): { userId: string | null; isOperator: boolean } => {
    if (ctx.identity) {
      const auth = resolveV4Auth(ctx.identity, rq)
      if (auth.user && auth.role) {
        return { userId: auth.user.id, isOperator: auth.role === 'owner' }
      }
    }
    return { userId: null, isOperator: true }
  }
  // WIZ-M4 — 建流向导（admin 面）。必须先于 handleWorkflowRoute 拦截，否则
  // `/api/admin/workflows/wizard/*` 的 `wizard` 段会被当成 workflow id。
  if (path.startsWith('/api/admin/workflows/wizard/')) {
    const handled = await handleWizardAdminRoute(
      {
        wizard: ctx.workflowWizard,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
      },
      req,
      res,
      method,
      path,
    )
    if (handled) return
  }
  if (path.startsWith('/api/admin/workflows')) {
    // P2-M5b — workflow RBAC is ON only when the identity store actually
    // carries the grant methods (a current @gotong/identity); otherwise the
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
        // RBAC identity (shared closure above).
        grants: wfGrants,
        resolveActor: resolveResourceActor,
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
  // Agent CRUD, plus the two manifest *import* paths (bundle + v5 B-M4 template)
  // — they land agents/workflows through the same Space/lifecycle/workflows ctx,
  // so they live alongside agent import here. Template *export* is read-only and
  // routed separately to handleTemplateRoute below.
  if (
    path.startsWith('/api/admin/agents') ||
    path === '/api/admin/bundles/import' ||
    path === '/api/admin/templates/import' ||
    // RES-M3 — apply ONE adaptation proposal (a human-approved constrained agent
    // edit). Lives in agents-routes.ts because the write funnels through the same
    // Space/lifecycle applyAgentEdit path as a manual agent edit.
    path === '/api/admin/resources/adapt'
  ) {
    // v5 E4-M1 — agent resource RBAC mirrors the workflow block: ON only when
    // the identity store actually carries the agent-grant facade; otherwise the
    // routes see `agentGrants: undefined` and every admin passes (back-compat).
    const agentGrants: AgentGrantSink | undefined =
      ctx.identity &&
      typeof (ctx.identity as { hasAgentGrant?: unknown }).hasAgentGrant === 'function'
        ? (ctx.identity as unknown as AgentGrantSink)
        : undefined
    const handled = await handleAgentsRoute(
      {
        hub: ctx.hub,
        space: ctx.space,
        lifecycle: ctx.lifecycle,
        llmKeyProbe: ctx.llmKeyProbe,
        routingProbe: ctx.routingProbe,
        connectorSlots: ctx.connectorSlots,
        templateAcceptance: ctx.templateAcceptance,
        scheduleSuggestions: ctx.scheduleSuggestions,
        reconcileHeartbeats: ctx.reconcileHeartbeats,
        workflows: ctx.workflows,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
        agentGrants,
        resolveActor: resolveResourceActor,
        // RES-M2 — proposal engine for the import post-install checklist.
        resourceAdaptation: ctx.resourceAdaptation,
      },
      req, res, method, path,
    )
    if (handled) return
  }

  // SW-M9 A-M6 — operator-console hub steward ("管家"). Site-wide twin of the
  // member `/api/me/steward/*` routes, behind requireAdmin + a resolved operator
  // userId (the shared `resolveResourceActor` closure). 503 when no operator
  // steward was wired, or when the admin has no v4 user row (no inbox to park a
  // second-confirmation into).
  if (path.startsWith('/api/admin/steward')) {
    const handled = await handleAdminStewardRoute(
      {
        steward: ctx.operatorSteward,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
        resolveActor: resolveResourceActor,
      },
      req,
      res,
      method,
      path,
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

  // ease-of-use ① — admin "test connection" probe. Lets the agent-create
  // form verify a provider+key (and baseURL/model) BEFORE saving an agent
  // that would otherwise silently never reply. Sends one minimal request
  // with the supplied key; never logs it. Mirrors the loopback setup-route
  // version but behind admin auth (remote hosts have no loopback window).
  if (path === '/api/admin/test-llm-key' && method === 'POST') {
    if (!(await requireAdmin(ctx, req, res))) return
    if (!ctx.llmKeyTest) {
      sendJson(res, { error: 'llm key test not available on this host' }, 503)
      return
    }
    let body: unknown
    try { body = await readJsonBody(req) }
    catch { sendJson(res, { error: 'invalid JSON body' }, 400); return }
    const b = (body ?? {}) as {
      provider?: unknown; apiKey?: unknown; baseURL?: unknown; model?: unknown
    }
    const provider = typeof b.provider === 'string' ? b.provider.trim() : ''
    const apiKey = typeof b.apiKey === 'string' ? b.apiKey : ''
    const baseURL = typeof b.baseURL === 'string' && b.baseURL.trim() ? b.baseURL.trim() : undefined
    const model = typeof b.model === 'string' && b.model.trim() ? b.model.trim() : undefined
    if (!provider) { sendJson(res, { error: 'provider is required' }, 400); return }
    if (!apiKey.trim()) { sendJson(res, { error: 'apiKey is required' }, 400); return }
    const result = await ctx.llmKeyTest.testLlmKey({ provider, apiKey, baseURL, model })
    // Verbatim verdict — `ok`/`code`/`message`/`model`/`latencyMs`. The probe
    // never throws, so a 200 here always carries a usable verdict (ok or not).
    sendJson(res, result)
    return
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

  // MCD-M2 — built-in MCP connector directory (browse + one-click install
  // reuses the mcp-servers route above). Pure web constant; admin-gated.
  if (path.startsWith('/api/admin/mcp-connectors')) {
    const handled = await handleMcpConnectorsRoute(
      { requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs) },
      req, res, method, path,
    )
    if (handled) return
  }

  // C-M2-M3 — outbound OAuth connect BEGIN (admin-gated owner action).
  if (
    await handleOAuthConnectAdminRoute(
      { oauthConnect: ctx.oauthConnect, requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs) },
      req, res, method, path,
    )
  ) {
    return
  }

  // C-M2-M5a — outbound OAuth connector CRUD (admin).
  if (
    await handleOAuthConnectorAdminRoute(
      { oauthConnectorAdmin: ctx.oauthConnectorAdmin, requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs) },
      req, res, method, path,
    )
  ) {
    return
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

  // v5 E5-M3 — cross-hub control plane (local footprint + peer summaries).
  // v5 Stream F adds /history for metric trends from persisted snapshots.
  if (
    path === '/api/admin/peer-summaries' ||
    path === '/api/admin/peer-summaries/refresh' ||
    path === '/api/admin/peer-summaries/history'
  ) {
    const handled = await handlePeerSummaryRoute(
      {
        peerSummaries: ctx.peerSummaries,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
      },
      req, res, method, path,
    )
    if (handled) return
  }

  // v5 Stream F-M5 — control-plane alert rules (CRUD) + live alert evaluation.
  if (path === '/api/admin/peer-summary-alerts' || path.startsWith('/api/admin/peer-summary-alerts/')) {
    const handled = await handlePeerSummaryAlertRoute(
      {
        peerSummaries: ctx.peerSummaries,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
      },
      req, res, method, path,
    )
    if (handled) return
  }

  // Route B P1-M4f — admin OIDC provider registry CRUD.
  if (path === '/api/admin/oidc/providers' || path.startsWith('/api/admin/oidc/providers/')) {
    const handled = await handleOidcAdminRoute(
      {
        oidcAdmin: ctx.oidcAdmin,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
      },
      req, res, method, path,
    )
    if (handled) return
  }

  // Route B P1-M5f — admin SAML provider registry CRUD.
  if (path === '/api/admin/saml/providers' || path.startsWith('/api/admin/saml/providers/')) {
    const handled = await handleSamlAdminRoute(
      {
        samlAdmin: ctx.samlAdmin,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
      },
      req, res, method, path,
    )
    if (handled) return
  }

  // Route B P1-M11c — admin outbound A2A agent registry CRUD.
  if (path === '/api/admin/a2a-agents' || path.startsWith('/api/admin/a2a-agents/')) {
    const handled = await handleA2aAdminRoute(
      {
        a2aAgents: ctx.a2aAgents,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
      },
      req, res, method, path,
    )
    if (handled) return
  }

  // ACP-OUT-M3 — admin outbound ACP agent registry CRUD (Claude Code / Codex).
  if (path === '/api/admin/acp-agents' || path.startsWith('/api/admin/acp-agents/')) {
    const handled = await handleAcpAdminRoute(
      {
        acpAgents: ctx.acpAgents,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
      },
      req, res, method, path,
    )
    if (handled) return
  }

  // setting-ops M4 — the deterministic ops console (status / check / fix-dirs /
  // config + owner config-write). NO destructive routes exist here; the host
  // surface refuses any destructive id via OpsTierError (→ 403). The actor's
  // owner flag (the shared `resolveResourceActor` closure) IS the config-write
  // gate — in a v3/personal hub the admin-token holder is the owner.
  if (path === '/api/admin/setting' || path.startsWith('/api/admin/setting/')) {
    const handled = await handleSettingRoute(
      {
        settingOps: ctx.settingOps,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
        resolveActor: (rq) => {
          const a = resolveResourceActor(rq)
          return { userId: a.userId, isOwner: a.isOperator }
        },
      },
      req, res, method, path,
    )
    if (handled) return
  }

  // LIFE-L1-M3 — zero-LLM workflow schedules: CRUD over the on-disk rows +
  // manual 试跑 fire. The host surface owns validation and the ONE dispatch
  // path (the sweeper's fireNow → same member gate as run_my_workflow).
  if (path === '/api/admin/workflow-schedules' || path.startsWith('/api/admin/workflow-schedules/')) {
    const handled = await handleWorkflowScheduleRoute(
      {
        workflowSchedules: ctx.workflowSchedules,
        scheduleSuggestions: ctx.scheduleSuggestions,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
      },
      req, res, method, path,
    )
    if (handled) return
  }

  // v5 B-M2 + B-M3 — template export. Structure-safe by default; the opt-in
  // includeSecrets / includePersonnel flags ride an encrypted sidecar (key
  // returned separately) and write an audit row. `audit` reuses the identity
  // surface (writeAuditLog optional); `personnel` is the resource_grants reader
  // (undefined → includePersonnel 503s).
  // Export (POST) + Track G gallery catalog (GET list / GET :id) all live in
  // handleTemplateRoute, which does its own precise method+path matching.
  if (
    path === '/api/admin/templates/export' ||
    path === '/api/admin/templates/catalog' ||
    path.startsWith('/api/admin/templates/catalog/')
  ) {
    const handled = await handleTemplateRoute(
      {
        agentSource: ctx.space,
        workflows: ctx.workflows,
        personnel: ctx.templatePersonnel,
        audit: ctx.identity,
        requireAdmin: (rq, rs) => requireAdmin(ctx, rq, rs),
      },
      req, res, method, path,
    )
    if (handled) return
  }

  // FDE-M2 — golden-run acceptance (list recorded packs / run through the
  // member gate). Own module; precise matching inside; absent surface → 503.
  if (path.startsWith('/api/admin/templates/acceptance')) {
    const handled = await handleTemplateAcceptanceRoute(
      {
        templateAcceptance: ctx.templateAcceptance,
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

  // --- admin: hub 体检 (ease-of-use ❷-M1) -------------------------------
  // Read-only health snapshot for the overview panel: managed agents missing
  // an LLM key, MCP servers configured-but-unused, and whether the space dir is
  // still writable. All static (zero-cost) signals — the host owns the
  // aggregation, this route just gates + echoes. 503 when the host didn't wire
  // the surface (embedded use), so the panel can hide itself cleanly.
  if (method === 'GET' && path === '/api/admin/health') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    if (!ctx.adminHealth) {
      sendJson(res, { error: 'health surface unavailable' }, 503)
      return
    }
    sendJson(res, await ctx.adminHealth.snapshot())
    return
  }

  // --- admin: RES-M1 resource inventory (read-only) ---------------------
  // Deterministic snapshot of adaptable local resources (LLM key sources /
  // local model endpoints / CLI agents on PATH / installed MCP servers). The
  // host owns the probe; this route just gates + echoes. EXISTENCE-only — no
  // secret values cross here. 503 when the host didn't wire the surface.
  if (method === 'GET' && path === '/api/admin/resources') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    if (!ctx.resourceInventory) {
      sendJson(res, { error: 'resource inventory surface unavailable' }, 503)
      return
    }
    sendJson(res, await ctx.resourceInventory.inventory())
    return
  }

  // --- admin: RES-M2/M4 adaptation proposals for CURRENT agents ---------
  // The always-on plain-language entrance: run the read-only RES-M2 engine over
  // every managed LLM agent on this hub (not just freshly-imported ones) so the
  // operator can see, any time, "agent X can't run — here's how to adapt it".
  // Strictly read-only: proposals are suggestions; enacting one still requires an
  // explicit per-item apply (POST /api/admin/resources/adapt) = human approval.
  if (method === 'GET' && path === '/api/admin/resources/adaptations') {
    const admin = await requireAdmin(ctx, req, res)
    if (!admin) return
    if (!ctx.resourceAdaptation) {
      sendJson(res, { error: 'resource adaptation surface unavailable' }, 503)
      return
    }
    const agents = (await ctx.space.agents())
      .filter((a) => a.managed?.kind === 'llm')
      .map((a) => ({ id: a.id, provider: a.managed!.provider }))
    const proposals = await ctx.resourceAdaptation.propose({ agents })
    sendJson(res, { proposals })
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
  //     point: "everyone sees everyone's contributions"). Signed-in only:
  //     participant ids + contribution counts are room-internal, not
  //     public (audit P2 — this route used to answer unauthenticated).
  //     Optional `from` / `to` query params; default = all-time. --------
  if (method === 'GET' && path === '/api/leaderboard') {
    if (!(await requireAdminOrWorker(ctx, req, res))) return
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
      // ease-of-use ①-M1 followup — during the loopback first-run bootstrap
      // window (identity wired, single owner, no password yet) serve the
      // unified SPA so the setup wizard surfaces at the web ROOT. Without
      // this, a fresh anonymous browser lands on worker.html and never sees
      // the wizard, making the host's friendly first-run banner ("open / to
      // finish setup — no token needed") a dead end. The wizard's writes
      // (owner-password / owner-llm-key) are themselves loopback-only, so we
      // gate the same way: a remote visitor still gets worker.html. Reverts
      // automatically once the owner sets a password (isBootstrapPending →
      // false). Every API call stays server-gated — this only changes which
      // static shell anonymous loopback gets during a single setup window.
      if (isLoopbackReq(req) && isBootstrapPending(ctx.identity)) {
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

// serveStatic / serveAppHtml moved to ./static-routes.js (#19 megalith split).

// validateAgentBody, publicAgent, readRawBody moved to
// agents-routes.ts / uploads-routes.ts (P3 audit cleanup).

/**
 * Translate a `@gotong/services-sdk` typed error to an HTTP status.
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
