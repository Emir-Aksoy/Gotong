/**
 * server-types.ts — the Web server's public type surface, extracted from
 * server.ts to keep the assembly-layer line budget in check (GUARD line-budget
 * gate). This file is PURE type declarations, zero runtime.
 *
 * It holds `WebServerOptions` (the host's duck-typed injection contract) plus
 * every `*Surface` the host implements, and the structural view mirrors of
 * `@gotong/workflow` types the admin UI echoes verbatim. server.ts imports the
 * few it needs for local signatures and re-exports ALL of them, so `./server.js`
 * stays the single import point for consumers and tests (they import surface
 * types directly from '../src/server.js').
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  GrowthReportsAdminSurface,
  Hub,
  ManagedAgentLifecycle,
  ParticipantId,
  ServicesAdminSurface,
  Space,
} from '@gotong/core'
import type { IdentitySurface, IdentityPeerReputationDTO } from './identity-routes.js'
import type {
  InboxSurface,
  MeAgentListSurface,
  MeAgentAdminSurface,
  MeAgentGrantsSurface,
  MeCredentialsSurface,
  ButlerMemorySurface,
  MeImSurface,
  MeWorkflowEditSurface,
  MeWorkflowCreateSurface,
  MeHubStewardSurface,
} from './me-routes.js'
import type { WorkflowWizardSurface } from './wizard-routes.js'
import type { ConnectorSlotSink, LlmKeyProbe, ScheduleSuggestionSink } from './agents-routes.js'
import type { TemplateAcceptanceSurface } from './template-acceptance-routes.js'
import type { SetupRoutesCtx } from './setup-routes.js'
import type { McpRegistrySurface, McpFederationSurface } from './mcp-routes.js'
import type { PeerSummaryFederationSurface } from './peer-summary-routes.js'
import type { TemplatePersonnelSource } from './template-routes.js'
import type { PeerManifestFederationSurface } from './peer-routes.js'
import type { OidcLoginSurface } from './oidc-routes.js'
import type { OidcProviderAdminSurface } from './oidc-admin-routes.js'
import type { SamlLoginSurface } from './saml-routes.js'
import type { SamlProviderAdminSurface } from './saml-admin-routes.js'
import type { A2aAgentAdminSurface } from './a2a-admin-routes.js'
import type { AcpAgentAdminSurface } from './acp-admin-routes.js'
import type { SettingOpsSurface } from './setting-routes.js'
import type { WorkflowScheduleAdminSurface } from './workflow-schedule-routes.js'

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
   * ease-of-use ③-M1 — optional LLM-key probe for the template-import
   * post-install checklist. The host wires it to LocalAgentPool. Absent →
   * the "agent X still needs a key" advisories are omitted.
   */
  llmKeyProbe?: LlmKeyProbe
  /**
   * FDE-M1b — optional durable sink for template-declared connector slots
   * (`requires.connectors`), recorded at import so the admin 体检 shows slot
   * status persistently. The host wires its ConnectorSlotStore. Absent →
   * slots are reported in the install response only.
   */
  connectorSlots?: ConnectorSlotSink
  /**
   * FDE-M2 — golden-run acceptance surface (record at import + list + run
   * through the member gate with zero-LLM judging). The host wires
   * `createTemplateAcceptanceService`. Absent → acceptance routes 503 and
   * install-time recording is skipped (response-only reporting).
   */
  templateAcceptance?: TemplateAcceptanceSurface
  /**
   * FDE-M3 — optional durable sink+source for template schedule suggestions
   * (`schedules[]`): recorded at import, read back by the admin 定时卡's
   * suggestion rows. The host wires its ScheduleSuggestionStore (which must
   * also expose `list()`). Absent → suggestions live in the install response
   * only and GET /suggestions answers empty.
   */
  scheduleSuggestions?: ScheduleSuggestionSink & {
    list(): Promise<
      readonly {
        pack: string
        installedAt: string
        schedules: readonly {
          workflowId: string
          cadence: unknown
          inputs?: Record<string, unknown>
          note?: string
        }[]
      }[]
    >
  }
  /**
   * ❷-M1 — optional read-only "hub 体检" aggregator for the admin overview
   * panel. The host wires `createAdminHealthService`. Absent → the
   * `GET /api/admin/health` route answers 503 and the panel hides.
   */
  adminHealth?: AdminHealthSurface
  /**
   * RES-M1 — optional read-only resource inventory (LLM key sources / local
   * model endpoints / CLI agents on PATH / installed MCP servers) for the
   * "resource adaptation" admin panel. Host wires `createResourceInventoryService`.
   * Absent → `GET /api/admin/resources` answers 503 and the panel hides.
   */
  resourceInventory?: ResourceInventorySurface
  /**
   * RES-M2 — optional adaptation proposal engine. Host wires
   * `createResourceAdaptationService`. Absent → the template-import response
   * carries no `adaptations` and the resource panel shows no proposals.
   */
  resourceAdaptation?: ResourceAdaptationSurface
  /**
   * v5 D-M4 — optional host callback to reconcile proactive-heartbeat rows
   * after a managed-agent create / edit / delete. The host wires this to its
   * HeartbeatScheduler (lazily spinning the engine up on first opt-in). When
   * absent, heartbeat config still persists and takes effect on next boot.
   */
  reconcileHeartbeats?: () => Promise<void>
  /**
   * Optional workflow controller. The host wires this to
   * `@gotong/workflow` so the admin UI can list / import workflows
   * without the Web package taking a runtime dep on the workflow
   * runner. When absent, the workflow API endpoints return 404.
   */
  workflows?: WorkflowSurface
  /**
   * v5 B-M3 — optional "who-can-access this agent" reader for the template
   * export's `includePersonnel` opt-in. The host wires it to identity's
   * resource_grants; when absent, an `includePersonnel` export fails closed
   * (503) instead of silently shipping an empty personnel block.
   */
  templatePersonnel?: TemplatePersonnelSource
  /**
   * Phase 19 P1-M3 — optional sanitized agent directory for `/api/me/agents`.
   * The host wires a projection of its managed agents that excludes every
   * sensitive field (system prompt / model / provider config / keys). Absent
   * → `/api/me/agents` degrades to an empty list.
   */
  meAgents?: MeAgentListSurface
  /**
   * v5 A-M2 — optional member agent ownership + self-service CRUD surface for
   * `/api/me/agents` (create / list-owned / update / delete). Ownership grants
   * live in identity, so the host wires this only when identity is present;
   * absent → those routes return 503 (the read-only directory still works).
   */
  meAgentAdmin?: MeAgentAdminSurface
  /**
   * v5 A-M4 — optional member agent access-grant surface for
   * `/api/me/agents/:id/grants` (an owner shares their agent with other
   * principals). Grants live in identity, so the host wires this only when
   * identity is present; absent → those routes return 503 (empty list on GET).
   */
  meAgentGrants?: MeAgentGrantsSurface
  /**
   * v5 A-M3 — optional member API-credential surface for `/api/me/credentials`
   * ("bring your own key"). Keys live in the identity vault, so the host wires
   * this only when identity is present; absent → those routes return 503.
   */
  meCredentials?: MeCredentialsSurface
  /**
   * Personal Butler M6c — optional member butler-memory privacy view for
   * `/api/me/butler/memory` ("what does my butler remember about me", forget /
   * export). The host opens the per-user memory handle by session userId;
   * absent → GET degrades to an empty snapshot, mutations return 503.
   */
  butlerMemory?: ButlerMemorySurface
  /**
   * GO-LIVE GL-1c — optional member IM-linking surface for `/api/me/im/*`
   * (mint a binding code, list/disconnect the caller's own IM bindings).
   * Bindings live in identity, so the host wires this only when identity is
   * present; absent → those routes return 503 (empty list on GET).
   */
  meIm?: MeImSurface
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
   * ease-of-use ① — optional "test connection" probe. The host always
   * wires this (it needs no config — it uses the key the caller types).
   * When absent (e.g. a test harness that doesn't provide it), the
   * `POST /api/setup/test-llm-key` and `POST /api/admin/test-llm-key`
   * endpoints return 503 and the UI can hide the 测试连接 button.
   */
  llmKeyTest?: LlmKeyTestSurface
  /**
   * DEPLOY-B2 — optional IM-bridge hot-start surface for the first-run
   * wizard's IM step (duck-typed to the host's `startPlatform` seam).
   * Absent → the setup route still saves the token to vault and reports
   * "starts on next boot".
   */
  imHotStart?: SetupRoutesCtx['imHotStart']
  /**
   * Optional Hub Services admin surface (PR-11). The host wires
   * `hubServices.asAdminSurface()` here. When absent, all
   * `/api/admin/services/...` endpoints return 503 so the admin UI
   * can hide the tab cleanly. Web has no runtime dep on
   * `@gotong/services-sdk` — the surface is plain types in `@gotong/core`.
   */
  services?: ServicesAdminSurface
  /**
   * Optional personal-growth reports admin surface (v2.4). The host
   * wires a `GrowthReportsAdmin` instance here when it has loaded
   * the personal-growth team. When absent, the two
   * `/api/admin/growth-reports*` endpoints return 503 so the admin
   * UI can hide the panel. Web has no runtime dep on the host —
   * the surface is plain types in `@gotong/core`.
   */
  growthReports?: GrowthReportsAdminSurface
  /**
   * Phase 16 — optional member task inbox surface. The host wires a
   * `HostInboxService` here. When absent, `GET /api/me/inbox` returns an
   * empty list and `POST /api/me/inbox/:id/resolve` returns 503. Web has no
   * runtime dep on `@gotong/inbox` — `InboxSurface` is a duck type.
   */
  inbox?: InboxSurface
  /**
   * WFEDIT-M3 — optional member natural-language workflow-edit surface. The
   * host wires a `MeWorkflowEditService` here. When absent,
   * `GET /api/me/workflows/:id/editable` and `POST /api/me/workflows/:id/edit`
   * return 503 so the member UI can hide the "用大白话改这个工作流" panel. Web
   * has no runtime dep on the host — `MeWorkflowEditSurface` is a duck type.
   */
  workflowEdit?: MeWorkflowEditSurface
  /**
   * ARCH-M6 — optional member natural-language workflow-AUTHOR surface ("工作流
   * 架构师"). The host wires a `MeWorkflowCreateService` here. When absent,
   * `POST /api/me/workflows/create` and `POST /api/me/workflows/:id/explain`
   * return 503 so the member UI can hide the "用大白话新建工作流" panel. Web
   * has no runtime dep on the host — `MeWorkflowCreateSurface` is a duck type.
   */
  workflowCreate?: MeWorkflowCreateSurface
  /**
   * WIZ-M4 — optional 六段建流向导 surface (host wires `WorkflowWizardService`).
   * When absent, `/api/admin/workflows/wizard/*` and `/api/me/workflows/wizard/*`
   * return 503. Duck type — web has no runtime dep on the host.
   */
  workflowWizard?: WorkflowWizardSurface
  /**
   * SW-M6 — optional hub steward ("管家") surface. The host wires a
   * `HostStewardService` here. When absent, `POST /api/me/steward/plan` and
   * `/apply` return 503 so the member UI can hide the "管家" chat panel. Web has
   * no runtime dep on `@gotong/hub-steward` — `MeHubStewardSurface` is a duck
   * type, and the action it forwards is `unknown` (the host validates it).
   */
  hubSteward?: MeHubStewardSurface
  /**
   * SW-M9 A-M6 — optional OPERATOR-console hub steward surface. The host wires a
   * SECOND `HostStewardService` here (the site-wide operator one). When absent,
   * `POST /api/admin/steward/{plan,apply}` return 503 so the admin UI can hide
   * the operator 管家 panel. Same `MeHubStewardSurface` duck type as `hubSteward`
   * (the operator service satisfies the identical plan/apply shape); the action
   * it forwards is `unknown` (the host validates + re-tiers it).
   */
  operatorSteward?: MeHubStewardSurface
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
   * dep on `@gotong/identity` — `IdentitySurface` is a structural
   * type in `./identity-routes`, satisfied by `IdentityStore` from
   * the package.
   *
   * The v4 IdentityStore session cookie (`gotong_identity`) is also
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
      /** REL-3 — last inbound frame from this peer (epoch-ms), null when down. */
      lastSeenAt?: number | null
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
   * itself: Web has no dep on `@gotong/services-sdk` or any plugin
   * impl, by design (`@gotong/web` is "the HTTP/SPA shell, no plugin
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
  /**
   * v5 E5-M3 — host-injected control-plane surface. When wired,
   * `GET /api/admin/peer-summaries` returns this hub's own privacy-safe
   * footprint plus each connected peer's voluntarily-shared summary (counts
   * only); `POST .../refresh` refetches. Absent (peers disabled) → 503. Backed
   * by the peer registry + the `peer.summary` rpc + an in-process cache.
   */
  peerSummaries?: PeerSummaryFederationSurface
  /**
   * Route B P1-M4e — host-injected OIDC login surface. When wired, the public
   * `/api/auth/oidc/{providers,start,callback}` routes let a browser log in via
   * a configured IdP (the callback mints the SAME identity cookie a password
   * login does). Absent → `/providers` returns an empty list and start/callback
   * bounce to `/?oidc_error=not_enabled`. The host implements it over its
   * OidcLoginService + the provider config store.
   */
  oidcLogin?: OidcLoginSurface
  /**
   * Route B P1-M5e — host-injected SAML 2.0 SP login surface. When wired, the
   * public `/api/auth/saml/{providers,metadata,start,acs}` routes let a browser
   * log in via a configured IdP (the ACS POST mints the SAME identity cookie a
   * password login does). Absent → `/providers` returns an empty list and
   * start/acs bounce to `/?saml_error=not_enabled`. The host implements it over
   * its SamlLoginService + the SAML provider config store.
   */
  samlLogin?: SamlLoginSurface
  /**
   * Route B P1-M4f — host-injected OIDC provider registry (admin CRUD). When
   * wired, `/api/admin/oidc/providers[/:id]` lets an admin register the IdPs the
   * hub accepts SSO from. Absent (no identity store) → those routes 503. The
   * client_secret is write-only: accepted on input, never echoed back.
   */
  oidcAdmin?: OidcProviderAdminSurface
  /**
   * Route B P1-M5f — host-injected SAML provider registry (admin CRUD). When
   * wired, `/api/admin/saml/providers[/:id]` lets an admin register the IdPs the
   * hub accepts SAML assertions from. Absent (no identity store) → those routes
   * 503. Unlike OIDC there is no secret: `idpCert` is a public X.509 verification
   * key, so it is returned in full (admins must see which cert is pinned).
   */
  samlAdmin?: SamlProviderAdminSurface
  /**
   * Route B P1-M11c — host-injected outbound A2A agent registry (admin CRUD).
   * When wired, `/api/admin/a2a-agents[/:id]` lets an admin register the external
   * A2A agents this hub forwards capability dispatches to (replacing the Phase 18
   * `GOTONG_A2A_AGENTS` env blob). Absent (no identity store) → those routes 503.
   * Like SAML there is no secret in the view: `tokenEnv` is the env-var NAME the
   * bearer is read from, and the view also carries host-joined runtime liveness.
   */
  a2aAgents?: A2aAgentAdminSurface
  /**
   * ACP-OUT-M3 — host-injected outbound ACP agent registry (admin CRUD). When
   * wired, `/api/admin/acp-agents[/:id]` lets an admin register the coding agents
   * (Claude Code / Codex) this hub drives over long-lived ACP sessions. Absent
   * (no identity store) → those routes 503. There is NO secret in the view at all
   * (ACP rides the agent's own login); the view carries host-joined runtime
   * liveness so the UI can show "saved but inactive: disabled" honestly.
   */
  acpAgents?: AcpAgentAdminSurface
  /**
   * setting-ops M4 — host-injected deterministic ops console surface (the WEB
   * face of `ops-core`). When wired, `/api/admin/setting/*` lets an admin run the
   * read / safe-mutate / config-write(owner) ops commands and browse the whole
   * lifecycle catalog. Absent → those routes 503 and the console tab hides. There
   * are deliberately NO destructive routes: cold-start / restore /
   * rotate-master-key are CLI-only by physics, and the host surface's
   * `runOpsCommand` chokepoint refuses any destructive id reached via `/run`.
   */
  settingOps?: SettingOpsSurface
  /**
   * LIFE-L1-M3 — zero-LLM workflow schedules. When wired,
   * `/api/admin/workflow-schedules` gives the admin CRUD over the on-disk
   * schedule rows plus a manual 试跑 fire (which dispatches through the same
   * member gate the sweep uses). Absent → those routes 503.
   */
  workflowSchedules?: WorkflowScheduleAdminSurface
  /**
   * Route B P0-M7 — bearer token for the internal `/metrics` scrape route.
   * When set, a Prometheus scraper presenting `Authorization: Bearer <token>`
   * gets the same OpenMetrics body as `/api/admin/metrics` WITHOUT a browser
   * session or a machine-admin token (which would widen the admin surface).
   * Fail-closed: when this is `undefined` the route 404s — an unconfigured
   * deployment exposes no anonymous metrics endpoint. The host sources it
   * from `GOTONG_METRICS_TOKEN` (empty/unset → undefined).
   */
  metricsToken?: string
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
 * bearer-auth domain (X-Gotong-Peer-Id + peer token), so the route sits OUTSIDE
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
 * — kept as a duck-typed interface here so `@gotong/web` does not pull
 * `@gotong/workflow` into its dependency closure.
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
  /**
   * Exact count of active runs by status (archived runs excluded), optionally
   * scoped to one `workflowId`. Backs the `/metrics` workflow-run gauges. The
   * scan is O(active), which run retention bounds — replacing the old fixed
   * 2000-row sample. `total` equals the sum of `byStatus`.
   */
  countRuns(opts?: { workflowId?: string }): Promise<{ total: number; byStatus: Record<string, number> }>

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
  /**
   * v5 B-M2 — the authored YAML text for `id`, for template export. Returns
   * the exact text that imported (guaranteed re-parseable), or null when the
   * id is unknown / its file is missing. The host reads `definitions/<id>.yaml`.
   */
  exportDefinitionText(id: string): Promise<string | null>
  /**
   * v5 Stream G day-5 — fetch the executing peer's transcript of ONE cross-hub
   * step (the post-launch transcript CHAIN). The host resolves the step's
   * persisted `executedBy` + `peerTaskId`, reaches the peer link, and calls the
   * opt-in `peer.transcript` rpc. Returns a duck-typed discriminated verdict:
   * `{ ok: true, slice }` or `{ ok: false, code, message }` where `code` is one
   * of `unknown_run` / `unknown_step` / `not_cross_hub` / `no_link` /
   * `fetch_failed` (the last covers a peer that hasn't opted into sharing). The
   * Web layer maps the first two to 404 and renders the rest inline. OPTIONAL —
   * a host built without a peer-link resolver (single-hub) may omit it, and the
   * route then answers 404.
   *
   * PB — pass `branchId` to target ONE branch of a parallel step (the per-branch
   * executor/handle maps); omitted ⇒ the step-level fields (a simple step). The
   * route reads it from the `?branch=` query string.
   */
  fetchPeerStepTranscript?(runId: string, stepId: string, branchId?: string): Promise<unknown>
  /**
   * DAG-M3 — read-only graph projection of one workflow, for the admin UI's
   * "view flow chart" affordance. Returns the `{ nodes, edges }` view (the host
   * stamps off-hub destinations onto matching nodes) or `null` for an unknown id
   * (the route then 404s). Pure projection — never mutates the definition or
   * touches how the runner executes it. OPTIONAL so a legacy host without it
   * leaves the route answering 404 + the admin UI hiding the affordance.
   */
  graphOf?(id: string): Promise<WorkflowGraphView | null>
}

/**
 * ❷-M1 — read-only "hub 体检" snapshot echoed to the admin overview panel.
 * Mirror of the host's `HealthSnapshot` (the host owns the aggregation; the
 * Web layer is a thin requireAdmin → JSON echo, so it never imports the host).
 * Every field is a zero-cost STATIC signal — no LLM ping happens here (that's a
 * per-agent manual button in ②-M2).
 */
export interface HealthSnapshot {
  agents: {
    id: string
    provider: string
    /** true = managed LLM agent whose API key does not currently resolve. */
    missingKey: boolean
    online: boolean
  }[]
  agentsMissingKey: number
  managedCount: number
  onlineCount: number
  mcpServers: { name: string; wired: boolean }[]
  mcpUnwired: number
  spaceWritable: boolean
  spacePath: string
  /**
   * EH-M1 配置进度计数 — 喂体检面板「下一步建议」常驻引导。verbatim echo, web
   * 不解读; 派生文案 + CTA 在前端 (i18n)。可选: host 未接 workflow controller 时
   * 整个缺席 (诚实的「未知」), 前端据此跳过工作流相关建议。
   */
  workflowCount?: number
  publishedWorkflowCount?: number
  runCount?: number
  checkedAt: string
}

/**
 * ❷-M1 — host-injected hub health surface. The host wires the aggregation
 * (`createAdminHealthService`); absent when a host is embedded without it, in
 * which case `GET /api/admin/health` answers 503 and the panel hides itself.
 */
export interface AdminHealthSurface {
  snapshot(): Promise<HealthSnapshot>
}

/**
 * RES-M1 — read-only resource inventory rows. Mirrored here (duck-typed) so the
 * Web layer echoes the host snapshot with zero host runtime dependency, exactly
 * like `HealthSnapshot`. EXISTENCE-only: `*Set` / `*Configured` are booleans, no
 * secret key material ever crosses this boundary.
 */
export interface ResInventoryLlmKeyRow {
  provider: string
  envVar?: string
  envSet: boolean
  vaultConfigured: boolean
}
export interface ResInventoryEndpointRow {
  label: string
  url: string
  reachable: boolean
}
export interface ResInventoryCliRow {
  command: string
  label: string
  found: boolean
  apiKeyEnv?: string
  apiKeyEnvSet?: boolean
}
export interface ResInventoryMcpRow {
  name: string
}
export interface ResInventorySnapshot {
  llmKeys: ResInventoryLlmKeyRow[]
  localEndpoints: ResInventoryEndpointRow[]
  cliAgents: ResInventoryCliRow[]
  mcpServers: ResInventoryMcpRow[]
  checkedAt: string
}

/**
 * RES-M1 — host-injected resource inventory surface. Absent when a host is
 * embedded without it, in which case `GET /api/admin/resources` answers 503 and
 * the admin resource-adaptation panel hides itself.
 */
export interface ResourceInventorySurface {
  inventory(): Promise<ResInventorySnapshot>
}

/**
 * RES-M2 — adaptation proposal, mirrored (duck-typed) so the Web layer can carry
 * host-produced proposals with zero host runtime dependency. Pure data: a
 * proposal never enacts anything (RES-M3 apply does, on explicit human approval).
 * `applicable` splits enactable (agent-update) from advisory (human action). The
 * kind-specific fields are a permissive superset — web echoes them verbatim.
 */
export interface ResAdaptationProposal {
  kind: 'use_local_endpoint' | 'switch_provider' | 'set_env_key' | 'wire_mcp_server'
  id: string
  title: string
  detail: string
  applicable: boolean
  agentId?: string
  fromProvider?: string
  toProvider?: string
  keySource?: 'env' | 'vault'
  endpointLabel?: string
  suggestedBaseURL?: string
  provider?: string
  envVar?: string
  slotName?: string
  candidateServer?: string
}

/**
 * RES-M2 — host-injected adaptation proposal surface. Absent → the import
 * checklist carries no `adaptations` and the resource panel omits proposals.
 */
export interface ResourceAdaptationSurface {
  propose(input: {
    agents: readonly { id: string; provider: string }[]
    kbSlots?: readonly { name: string; useMcpServer?: string }[]
  }): Promise<ResAdaptationProposal[]>
}

/**
 * Phase 13 M3 — host-injected workflow assistant surface. Wraps a
 * registered `WorkflowAssistantAgent` so the Web layer can answer
 * `POST /api/admin/workflows/assist` without taking a runtime dep on
 * `@gotong/workflow-assistant` / `@gotong/llm`. Same posture as
 * `WorkflowSurface` above.
 *
 * Absent when:
 *   - operator set `GOTONG_ASSISTANT_DISABLED=1`, OR
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
    /**
     * ARCH-M2/M3 — authoring vs explain. Default 'author' (generate a fresh
     * draft from `description`). 'explain' echoes `subjectYaml` verbatim and
     * produces ONLY a depth-controlled prose explanation of that existing
     * workflow (no regeneration; yaml + graph derive from the subject).
     */
    mode?: 'author' | 'explain'
    /** ARCH — explanation depth. Default 'brief'; affects prose only. */
    detail?: 'oneliner' | 'brief' | 'detailed'
    /** ARCH — the existing workflow YAML to explain (required when mode==='explain'). */
    subjectYaml?: string
    /** Caller (admin) participant id — stamped onto the dispatched task's `from`. */
    by: ParticipantId
  }): Promise<WorkflowAssistResult>
}

/**
 * ease-of-use ① — structural mirror of `@gotong/host`'s `LlmKeyTestSurface`.
 * Kept as a duck-typed duplicate so Web stays free of any host/llm runtime
 * dependency (same posture as `WorkflowAssistSurface`). The host wires the
 * real probe; Web only forwards the typed JSON back to the browser.
 */
export interface LlmKeyTestSurface {
  testLlmKey(input: {
    provider: string
    apiKey: string
    baseURL?: string
    model?: string
  }): Promise<LlmKeyTestResult>
}

/** Mirror of `@gotong/host`'s `LlmKeyTestResult`. */
export interface LlmKeyTestResult {
  ok: boolean
  model: string
  latencyMs: number
  /** Stable code the UI maps to localized words; absent when `ok:true`. */
  code?: string
  /** Short, key-scrubbed diagnostic (never contains the key). */
  message?: string
}

/**
 * Mirror of `@gotong/workflow-assistant`'s `WorkflowAssistantPayload.contextHints`.
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
 * Mirror of `@gotong/workflow-assistant`'s `WorkflowAssistantOutput`. The
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
   * `WorkflowStructureCheckResult` from `@gotong/evals` — kept as a
   * duck-typed structural copy so the web layer has zero evals dep.
   */
  deepCheck?: WorkflowDeepCheckResult
  /**
   * ARCH-M1 — the bound flowchart, the "工作流图片介绍". Present iff
   * `draftStatus==='valid'`. Pure projection of the parsed YAML
   * (`projectWorkflowGraph`), so it's consistent with what will actually
   * run. The admin UI renders it inline as a downloadable SVG. Reuses the
   * `WorkflowGraphView` duck-type already defined for the DAG viz route.
   */
  graph?: WorkflowGraphView
}

/** Mirror of `WorkflowStructureCheckResult` (see `@gotong/evals`). */
export interface WorkflowDeepCheckResult {
  ok: boolean
  violations: ReadonlyArray<WorkflowDeepCheckViolation>
}

/** Mirror of `WorkflowStructureViolation` (see `@gotong/evals`). */
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
   * `PayloadFieldSpec` in `@gotong/workflow`'s types — kept as
   * `unknown` here to avoid a runtime dep on the workflow package.
   */
  payloadSchema?: unknown
  /**
   * Phase 14 — pass-through of the workflow's `surface.me` block when
   * present. Structurally mirrors `MeSurfaceSpec` in `@gotong/workflow`
   * (kept `unknown` to avoid a runtime dep). `me-routes.ts` reads it to
   * derive the member-facing `/me` catalog.
   */
  surfaceMe?: unknown
  /**
   * Phase 19 P5 — pass-through of the workflow's `governance` block when
   * present. Structurally mirrors `WorkflowGovernanceSpec` in
   * `@gotong/workflow` (kept `unknown` to avoid a runtime dep). The admin
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
  /**
   * Stream G day-2 / H — pass-through of the host's `crossHubSteps`: the
   * workflow steps that dispatch OFF this hub (a capability no local participant
   * serves, served instead by a connected mesh peer [`kind:'peer'`] or an
   * external A2A agent [`kind:'a2a'`]). Present (non-empty) only when the host
   * has such a destination. The admin UI renders it as a "this step leaves the
   * hub" indicator before launch — pure visibility; the dispatch is unchanged.
   */
  crossHubSteps?: CrossHubStepView[]
}

/** Stream G day-2 / H — one workflow step that dispatches OFF this hub. */
export interface CrossHubStepView {
  /** The step id (or `${stepId}/${branchId}` for a parallel branch). */
  stepId: string
  /** The capability no local participant serves. */
  capability: string
  /** The off-hub destination's id (peer hub id or A2A agent id). */
  peer: string
  /** The destination's human label, when set. */
  peerLabel: string | null
  /**
   * Destination kind: `'peer'` (mesh hub — may gate the step for inbox
   * approval) or `'a2a'` (external A2A agent — fires immediately). Absent ⇒
   * treat as `'peer'`.
   */
  kind?: 'peer' | 'a2a'
}

// --- DAG viz — read-only graph mirror types --------------------------------
// Structural duplicates of `@gotong/workflow`'s `WorkflowGraphView` family, so
// the Web layer can type the surface + echo the JSON verbatim without a runtime
// dep on the workflow package. The `graph` route returns these fields as-is.

export interface WorkflowGraphView {
  workflowId: string
  nodes: WorkflowGraphNode[]
  edges: WorkflowGraphEdge[]
}

export interface WorkflowGraphNode {
  id: string
  kind: 'trigger' | 'step' | 'parallel' | 'branch' | 'output'
  label: string
  description?: string
  destination?: WorkflowGraphDestination
  when?: string
  dataClasses?: string[]
  readsTrigger?: boolean
  branchNodeIds?: string[]
  parentId?: string
  /** Stamped by the host when this node's dispatch leaves the hub. */
  crossHub?: WorkflowGraphCrossHub
}

export interface WorkflowGraphDestination {
  kind: 'capability' | 'explicit' | 'broadcast'
  capabilities: string[]
  to?: string
}

export interface WorkflowGraphCrossHub {
  peer: string
  peerLabel: string | null
  kind: 'peer' | 'a2a'
}

export interface WorkflowGraphEdge {
  from: string
  to: string
  kind: 'sequence' | 'data'
}

// --- Phase 15 — lifecycle mirror types -------------------------------------
// Structural duplicates of `@gotong/workflow`'s lifecycle shapes, so the Web
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
 * Structurally compatible with `@gotong/workflow`'s `RunSummary` type
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
