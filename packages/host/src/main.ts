/**
 * Production Gotong host binary.
 *
 * Reads its configuration from environment variables (12-factor style) so
 * the same image / build can be promoted from staging to production via
 * environment alone. No demo agent is registered; no test traffic is
 * generated. All state lives in the directory pointed at by GOTONG_SPACE.
 *
 * Environment:
 *
 *   GOTONG_SPACE              directory to open / init. Default `.gotong`.
 *   GOTONG_HOST               bind address (default 127.0.0.1 — pair with a
 *                           reverse proxy that terminates TLS).
 *   GOTONG_WEB_PORT           default 3000.
 *   GOTONG_WS_PORT            default 4000.
 *   GOTONG_GATING             'open' | 'admin-approval' (default 'admin-approval')
 *   GOTONG_COOKIE_SECURE      '1' to add the Secure + SameSite=Strict cookie
 *                           flags. Required behind HTTPS. Default '0'.
 *   GOTONG_ALLOWED_HOSTS      Comma-separated list of host[:port] values
 *                           accepted on Host: and Origin: for state-changing
 *                           requests. Example "hub.example.com". Empty
 *                           disables the check (only safe on loopback).
 *   GOTONG_ALLOW_INSECURE     '1' to downgrade the boot security self-check
 *                           (Route B P0-M6) from fail-closed to a warning.
 *                           Only for a network-exposed host whose reverse
 *                           proxy already validates Host and terminates TLS.
 *   GOTONG_ADMIN_RATE_MAX     admin login attempts allowed per IP per window
 *                           (default 10; 0 disables).
 *   GOTONG_ADMIN_RATE_SEC     window for the rate limit in seconds (default 60).
 *   GOTONG_DEFAULT_LANG       'zh' | 'en' (default 'zh')
 *   GOTONG_HEARTBEAT_MS       transport heartbeat interval (default 30000)
 *   GOTONG_SPACE_NAME         label written into space.json on first init
 *   GOTONG_ADMIN_DISPLAY_NAME first admin's display name (default 'Operator')
 *   GOTONG_WORKFLOWS_DIR      directory of workflow YAML/JSON files to
 *                           auto-load on boot. Default
 *                           `<GOTONG_SPACE>/workflows/definitions`. Each
 *                           parseable file becomes a registered
 *                           `WorkflowRunner` participant; failed files
 *                           are logged and skipped.
 *
 *   --- transcript retention (Route B P0-M2; OFF by default) ---
 *
 *   GOTONG_TRANSCRIPT_KEEP_SEGMENTS  keep this many newest sealed transcript
 *                           segments in the boot load path; archive older
 *                           ones into `<GOTONG_SPACE>/archive/`. Bounds boot
 *                           load to O(tail). Unset ⇒ no archiving.
 *   GOTONG_TRANSCRIPT_ARCHIVE_DAYS   archive sealed segments whose newest
 *                           entry is older than this many days. May be
 *                           combined with KEEP_SEGMENTS (both must hold).
 *                           Archived bytes stay on disk for audit/export;
 *                           a malformed value fails the boot loudly.
 *   GOTONG_RUN_KEEP           keep this many newest TERMINAL workflow runs on
 *                           the active scan path; archive older ones into
 *                           `workflows/runs/archive/`. Bounds boot-resume /
 *                           run-history / metrics scans to O(tail). A
 *                           `running` run is never archived. Unset ⇒ off.
 *   GOTONG_RUN_ARCHIVE_DAYS   archive terminal runs that ended more than this
 *                           many days ago. May be combined with GOTONG_RUN_KEEP
 *                           (both must hold). Archived runs stay reachable for
 *                           audit; a malformed value fails the boot loudly.
 *   GOTONG_LEDGER_KEEP_DAYS   prune usage-ledger (billing) rows older than this
 *                           many days at boot, bounding the append-only ledger.
 *                           The retained window stays exportable (Phase 17
 *                           CSV/JSONL). Unset ⇒ off; a malformed value fails
 *                           the boot loudly. Sibling knobs with the same
 *                           semantics for the other append-only tables:
 *   GOTONG_AUDIT_KEEP_DAYS            audit_log
 *   GOTONG_PEER_SUMMARY_KEEP_DAYS     peer_summary_snapshots (trend history)
 *   GOTONG_ALERT_FIRINGS_KEEP_DAYS    peer_summary_alert_firings (resolved only;
 *                                   open firings are never pruned)
 *
 *   --- structured logging (default ON, see @gotong/core/logger) ---
 *
 *   GOTONG_LOG_LEVEL          'silent' | 'trace' | 'debug' | 'info' | 'warn'
 *                           | 'error' | 'fatal'  (default 'info')
 *   GOTONG_LOG_FORMAT         'json' | 'pretty'  (default: 'pretty' when
 *                           stdout is a TTY, else 'json' for machine
 *                           consumption / log shippers)
 *   GOTONG_LOG_DISABLED       '1' to suppress all log output. Takes
 *                           precedence over LEVEL and FORMAT.
 *
 * On first launch the space dir is created and a one-time admin URL is
 * written to `<GOTONG_SPACE>/runtime/admin-link.txt` (mode 0o600). The
 * boot banner on stdout tells the operator where to read it. Writing
 * the URL to a file — instead of `console.log`-ing it — keeps the
 * plaintext token out of `journalctl`, `docker logs`, `pm2 logs`, and
 * any other log shipper that captures process stdout. Anyone who can
 * read the workspace directory can already mint a fresh admin via
 * `gotong-host mint-admin-token`; this just removes the easy log-mining
 * shortcut. See AUDIT-v3.3.md finding H20.
 *
 * On subsequent launches the printout shows just the /admin entry —
 * admins keep their existing cookies / tokens.
 *
 * The process responds to SIGTERM and SIGINT by closing the listeners,
 * draining the SSE clients, stopping the hub, and exiting cleanly.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Hub, Space, createLogger, type Logger, type McpServerSpec, type Participant, type RemoteHubViaLink, type SpaceConfig, type Task } from '@gotong/core'
import {
  AUDIT_ACTIONS,
  openIdentityStore,
  principalKey,
  userPrincipal,
  resolveMasterKeyProvider,
  type IdentityStore,
  type PeerRegistration,
  type A2aOutboundAgent,
  type AcpOutboundAgent,
} from '@gotong/identity'

import { OrgApiPool } from './org-api-pool.js'

import { BAKED_VERSION } from './version.js'
import { createAgentCardSurface } from './agent-card.js'
import { FileAgentCardSigner } from './agent-card-signing.js'
import { auditBootSecurity, formatBootSecurityReport, isLoopbackHost } from './boot-security.js'
import {
  firstRunSetupBanner,
  openUrl,
  parseOpenBrowserEnv,
  shouldOpenBrowser,
} from './first-run-banner.js'
import { resolveProfileEnv, profileBannerLines } from './profile.js'
import { rotateMasterKey } from './rotate-master-key.js'
import { applyRetentionPolicies, parseRetentionPolicies } from './retention.js'
import { recoverMasterKeyRotation } from './master-key-recovery.js'
import { applyRunRetention, parseRunRetention } from './run-retention.js'
import { armRetentionSweeper } from './retention-sweeper.js'
import { applyTranscriptRetention, parseTranscriptRetention } from './transcript-retention.js'
import { describe } from './transcript-line.js'
import { parseButlerEnv } from './butler-env.js'
import { wirePeers } from './wire-peers.js'
import { writeAdminLinkFile } from './admin-link.js'
import {
  env,
  envInt,
  envBool,
  envList,
  pkgVersion,
  mintAdminTokenCmd,
  rotateMasterKeyCmd,
  printUsage,
} from './main-cli.js'
import { friendlyBootError } from './boot-error.js'
import { installProcessSafetyNet } from './process-safety.js'

const log = createLogger('host')
import { serveWebSocket } from '@gotong/transport-ws'
import { PeerRegistry, buildPeerTokenResolver } from './peer-registry.js'
import { A2aServer } from './a2a-server.js'
import { A2aOutboundManager } from './a2a-outbound.js'
import { AcpOutboundManager } from './acp-outbound.js'
import { acpApprovalItemFor } from './acp-escalation.js'
import { type ImBridgesHandle } from './im-bridge.js'
import { armImBridgeWiring } from './im-bridge-wiring.js'
import { OidcClient } from './oidc-client.js'
import { OidcLoginService } from './oidc-login-service.js'
import { createOAuthConnectSurface } from './oauth-connect-service.js'
import { makeOAuthSecretSource } from './oauth-secret-source.js'
import { OAuthTokenRefresher } from './oauth-token-refresh.js'
import { createOAuthConnectorAdminSurface } from './oauth-connector-admin.js'
import { SamlLoginService } from './saml-login-service.js'
import { buildSpMetadata, SamlError } from '@gotong/saml'
import {
  serveWeb,
  buildTemplateCatalog,
  BUILTIN_MCP_CONNECTORS,
  type WebServerOptions,
  type OidcLoginSurface,
  type OidcProviderAdminSurface,
  type SamlLoginSurface,
  type SamlProviderAdminSurface,
  type A2aAgentAdminSurface,
  type A2aAgentView,
  type AcpAgentAdminSurface,
  type AcpAgentView,
} from '@gotong/web'

/**
 * Phase 18 B-M3 — resolve the org owner's user id (the default approver for
 * outbound cross-org sends). Scans memberships; a bootstrapped hub has exactly
 * one owner. Returns null only on an unbootstrapped / owner-less store, in
 * which case the approval gate stays unwired (logged where it's consumed).
 */
function findOwnerUserId(identity: IdentityStore): string | null {
  for (const u of identity.listUsers()) {
    if (identity.getMembership(u.id)?.role === 'owner') return u.id
  }
  return null
}

// Route B P1-M11b — outbound A2A agents moved from the `GOTONG_A2A_AGENTS` env
// blob to identity-backed config (`a2a_outbound_agents`, M11a) materialised by
// `A2aOutboundManager`. Same source-of-truth model as peers / OIDC / SAML
// (store + admin API, no env), so they persist and are admin-editable. The
// registration block lives in main() where identity is in scope.

import { createAdminHealthService, type AdminHealthSurface } from './admin-health.js'
import { RoutingHealthTracker } from './routing-health.js'
import { readOutageSnapshotFile } from './llm-outage.js'
import { BUTLER_PATROL_INTERVAL_MS } from './personal-butler-patrol.js'
import { createConnectorSlotStore } from './template-connector-slots.js'
import { createScheduleSuggestionStore } from './template-schedule-suggestions.js'
import { createTemplateAcceptanceService } from './template-acceptance.js'
import { createResourceInventoryService } from './resource-inventory.js'
import { createResourceAdaptationService } from './resource-adaptation.js'
import { createSettingOpsService } from './setting-ops-service.js'
import { LocalAgentPool, type ButlerFactory } from './local-agent-pool.js'
import { loadPricingTable } from './pricing.js'
import { McpProxyHost, fetchPeerSharedMcp } from './mcp-proxy.js'
import {
  PeerManifestHost,
  buildLocalManifest,
  createPeerManifestFederation,
  type PeerManifestFederation,
} from './peer-manifest.js'
import {
  PeerSummaryHost,
  PEER_SUMMARY_METHODS,
  buildLocalSummary,
  createPeerSummaryFederation,
  type BuildSummaryDeps,
  type PeerSummaryFederation,
} from './peer-summary.js'
import { PeerTranscriptHost, PEER_TRANSCRIPT_METHODS } from './peer-transcript.js'
import { GrowthReportsAdmin } from './services/growth-reports-admin.js'
import {
  BINARY_SAFE_PLUGINS,
  bootstrapServices,
  isCompiledBinary,
  LifecycleSweeper,
  type HubServices,
} from './services/index.js'
import { createUploadSurface } from './uploads.js'
import { createWorkflowController, type PeerCapabilityView } from './workflow-controller.js'
import { formatLoadReport, loadWorkflows } from './workflow-loader.js'
import {
  checkAgentsFile,
  definitionsReport,
  formatCheckReport,
  type WorkspaceCheckReport,
} from './workspace-check.js'
import { HostInboxService } from './inbox-service.js'
import { FileCrossHubMarkerStore } from './cross-hub-marker.js'
import { MeWorkflowEditService } from './me-workflow-edit-service.js'
import { MeWorkflowCreateService } from './me-workflow-create-service.js'
import { createWorkflowWizard } from './wizard-wiring.js'
import { HostMeAgentService } from './me-agent-service.js'
import { HostMeAgentGrantsService } from './me-agent-grants-service.js'
import { HostMeCredentialsService } from './me-credentials-service.js'
import { HostButlerMemoryService } from './butler-memory-service.js'
// BF-M4 — the resident butler fold-in: the registered `chat` agent is built as a
// per-user `ButlerRouter` (one memory namespace per member) so the IM channel's
// many bound users each get a butler that remembers ONLY them across sessions.
// Assembly lives in personal-butler-factory.ts; main.ts only wires refs.
import { buildButlerBackupOps } from './personal-butler-backup.js'
import { buildButlerFactory } from './personal-butler-factory.js'
import { butlerEmbedderFromEnv } from './butler-embedder.js'
import { butlerHearingFromEnv } from './butler-hearing.js'
import { butlerVoiceFromEnv } from './butler-voice.js'
import {
  buildOnboardingKeyCheck,
  type ButlerOnboardingKeyCheck,
} from './personal-butler-onboarding.js'
import { butlerApprovalItemFor, butlerResolvePushback } from './personal-butler-escalation.js'
import { ButlerMaintenanceSweeper } from './personal-butler-maintenance.js'
import { armButlerSweeps } from './personal-butler-sweeps.js'
import { createWorkflowScheduleAdminSurface } from './workflow-schedule-admin.js'
import { WorkflowScheduleSweeper } from './workflow-schedule-sweeper.js'
import { HostMeImService } from './me-im-service.js'
import { ApprovalGatedParticipant } from './outbound-approval.js'
import { armHeartbeatEngine } from './heartbeat-engine.js'
import { FileInboxStore, HumanInboxParticipant, HUMAN_CAPABILITY } from '@gotong/inbox'
import {
  createWorkflowAssistAgent,
  resolveWorkflowAssistConfig,
} from './workflow-assist-agent.js'
import { createLlmKeyTestSurface } from './llm-key-test.js'
import {
  createHubStewardService,
  resolveStewardConfig,
  OPERATOR_STEWARD_IDS,
  type StewardWorkflowDirectory,
  type StewardAgentDirectory,
  type StewardWorkflowEditor,
} from './hub-steward-service.js'
import type { ButlerWorkflowCreateSource } from './personal-butler-workflow-create.js'
import type { ButlerWorkflowSurface } from './personal-butler-workflows.js'
import type {
  ButlerRunSurface,
  ButlerAgentSurface,
  ButlerUsageSurface,
} from './personal-butler-observe.js'
import type {
  ButlerOwnedAgentSource,
  ButlerAdaptationSource,
} from './personal-butler-diagnose.js'
import type { ButlerAskRosterSource } from './personal-butler-ask-agent.js'
import { buildButlerPeerSurface, type ButlerPeerSurface } from './personal-butler-peers.js'
import { buildButlerLlmSurface, type ButlerLlmSurface } from './personal-butler-llms.js'
import { buildButlerScheduleSurface, type ButlerScheduleSurface } from './personal-butler-schedules.js'
import { detectButlerWebSearchSpecs } from './butler-web-search.js'
import type { ButlerWizardSource } from './personal-butler-workflow-wizard.js'
import { ReminderParticipant } from './reminder-participant.js'
import type { LlmProvider } from '@gotong/llm'
import { HostOperatorAgentService } from './operator-agent-service.js'
import { OperatorWorkflowEditService } from './operator-workflow-edit-service.js'
import { operatorStewardWorkflowDirectory } from './operator-workflow-directory.js'
import { HostStewardSensitiveExecutors } from './steward-sensitive.js'
import { buildOperatorStewardSystemPrompt } from '@gotong/hub-steward'

// CLI flags handled before any work — keep these cheap and side-effect free
// so `npx @gotong/host --help` exits in milliseconds without trying to
// open a workspace dir on disk.
const ARGV = process.argv.slice(2)

if (ARGV.includes('--help') || ARGV.includes('-h')) {
  printUsage()
  process.exit(0)
}
if (ARGV.includes('--version') || ARGV.includes('-V')) {
  process.stdout.write(`${pkgVersion()}\n`)
  process.exit(0)
}

// Subcommand: `gotong-host mint-admin-token [displayName]`
// Mints a fresh admin against the GOTONG_SPACE workspace WITHOUT starting
// the Hub / listeners. Use when the first-run admin URL got lost
// (window closed, .command script went away, scrollback gone). Reads
// GOTONG_SPACE / GOTONG_HOST / GOTONG_WEB_PORT / GOTONG_COOKIE_SECURE from the
// environment so the printed URL matches your deployment.
if (ARGV[0] === 'mint-admin-token') {
  await mintAdminTokenCmd(ARGV[1])
  process.exit(0)
}

// Subcommand: `gotong-host rotate-master-key` (Route B P0-M4d)
// Rotates the identity vault master key (KEK) without starting the Hub.
// Envelope encryption (M4b) makes this O(1): the single data key is
// re-wrapped under a freshly generated key, secret rows are untouched.
// local-file provider only — env/kms keys are rotated out of band.
if (ARGV[0] === 'rotate-master-key') {
  rotateMasterKeyCmd()
  process.exit(0)
}

async function main(): Promise<void> {
  // A rejected background timer (butler sweeps etc.) must degrade to a log line,
  // not crash the host on Node's default unhandledRejection → exit (audit P1).
  installProcessSafetyNet(log)
  const SPACE_DIR = env('GOTONG_SPACE', '.gotong')!

  // Build the SpaceConfig overrides from env. Anything unset falls back to
  // the values already on disk (or DEFAULT_CONFIG on first init).
  const configOverride: Partial<SpaceConfig> = {}
  if (env('GOTONG_HOST') !== undefined) configOverride.host = env('GOTONG_HOST')!
  if (env('GOTONG_WEB_PORT') !== undefined) configOverride.webPort = envInt('GOTONG_WEB_PORT', 3000)
  if (env('GOTONG_WS_PORT') !== undefined) configOverride.wsPort = envInt('GOTONG_WS_PORT', 4000)
  if (env('GOTONG_GATING') !== undefined) {
    const g = env('GOTONG_GATING')!
    if (g !== 'open' && g !== 'admin-approval') {
      throw new Error(`GOTONG_GATING must be 'open' or 'admin-approval'; got '${g}'`)
    }
    configOverride.gating = g
  }
  if (env('GOTONG_COOKIE_SECURE') !== undefined) configOverride.cookieSecure = envBool('GOTONG_COOKIE_SECURE', false)
  if (env('GOTONG_DEFAULT_LANG') !== undefined) {
    const l = env('GOTONG_DEFAULT_LANG')!
    if (l !== 'zh' && l !== 'en') {
      throw new Error(`GOTONG_DEFAULT_LANG must be 'zh' or 'en'; got '${l}'`)
    }
    configOverride.defaultLang = l
  }
  if (env('GOTONG_HEARTBEAT_MS') !== undefined) {
    configOverride.heartbeatIntervalMs = envInt('GOTONG_HEARTBEAT_MS', 30_000)
  }

  const { space, adminToken } = await Space.openOrInit(SPACE_DIR, {
    name: env('GOTONG_SPACE_NAME', 'Gotong')!,
    adminDisplayName: env('GOTONG_ADMIN_DISPLAY_NAME', 'Operator')!,
    config: configOverride,
  })

  // On every boot, re-apply env config so GOTONG_* always wins over what's on
  // disk (matches "12-factor: config flows from the environment").
  if (Object.keys(configOverride).length > 0) {
    await space.updateConfig(configOverride)
  }
  const config = await space.config()

  // Route B P0-M6 — boot-time security self-check, fail-closed. Runs as early
  // as possible (config resolved, before any socket is opened or identity is
  // touched) so an exposed-but-undefended host never reaches the listen call.
  // Loopback deployments (the default) produce zero violations → no-op.
  const allowedHosts = envList('GOTONG_ALLOWED_HOSTS')
  {
    const secViolations = auditBootSecurity({
      host: config.host,
      cookieSecure: config.cookieSecure,
      allowedHosts,
      allowInsecure: envBool('GOTONG_ALLOW_INSECURE', false),
    })
    for (const v of secViolations) {
      if (v.severity === 'warn') {
        log.warn(`boot security: ${v.code}`, {
          message: v.message,
          remediation: v.remediation,
        })
      }
    }
    const fatals = secViolations.filter((v) => v.severity === 'fatal')
    if (fatals.length > 0) {
      console.error(formatBootSecurityReport(fatals, { fatal: true }))
      process.exit(1)
    }
  }

  // v4 identity layer. Opens (or creates) `<space>/identity.sqlite`, bootstraps
  // an `owner` user with NO credentials (A2.2: the first operator gets a
  // password via the C1 setup wizard, or `gotong-host mint-admin-token` as the
  // emergency fallback). Idempotent: subsequent boots return `bootstrapped:
  // false` and never mutate. The legacy v3 `/admin?token=...` (printed at boot
  // bottom) stays valid for host-level admin routes, not `/api/admin/identity/*`.
  let identity: IdentityStore | undefined
  let orgApiPool: OrgApiPool | undefined
  try {
    // Route B P0-M5 — recover from an interrupted master-key rotation BEFORE
    // we load the live key. A crash between P0-M4d's DB re-wrap and its
    // key-file promote leaves `<keyfile>.next` holding the only key that
    // unwraps the vault; loading the stale live key below would brick it.
    // local-file only; best-effort (a failure here must not block boot — the
    // normal path still fails loudly if the key genuinely can't open the vault).
    try {
      const rec = recoverMasterKeyRotation(SPACE_DIR, env('GOTONG_MASTER_KEY_PROVIDER'))
      if (rec.action !== 'none') {
        log.info('identity: master key rotation recovery', { action: rec.action, reason: rec.reason })
      }
    } catch (err) {
      log.warn('identity: master key rotation recovery failed (continuing)', { err })
    }
    // B1.2 / Route B P0-M4a — resolve the vault master key through a
    // pluggable provider. Default `local-file` creates the 0600 key file
    // on first run (a wrong-length pre-existing key throws — a stale key
    // means existing vault rows can't decrypt, so fail loudly). Set
    // GOTONG_MASTER_KEY_PROVIDER=env + GOTONG_MASTER_KEY (64 hex) to inject the
    // key from a secret manager without touching disk; =kms-stub is a
    // reserved seam that fails closed.
    const masterKeyProvider = resolveMasterKeyProvider({
      kind: env('GOTONG_MASTER_KEY_PROVIDER'),
      localFilePath: join(SPACE_DIR, 'identity-master.key'),
      envKeyMaterial: env('GOTONG_MASTER_KEY'),
      envKeyEncoding: 'hex',
    })
    // describe() is log-safe (source label only, never key bytes).
    log.info('identity: master key provider', { source: masterKeyProvider.describe() })
    const masterKey = masterKeyProvider.load()
    identity = openIdentityStore({
      dbPath: join(SPACE_DIR, 'identity.sqlite'),
      masterKey,
    })
    const ib = identity.bootstrap({
      ownerEmail: env('GOTONG_OWNER_EMAIL', 'admin@local')!,
      ownerDisplayName: env('GOTONG_ADMIN_DISPLAY_NAME', 'Operator')!,
    })
    if (ib.bootstrapped) {
      log.info('identity: bootstrapped owner', { userId: ib.ownerUserId })
    } else {
      log.info('identity: already populated', {
        users: identity.countUsers(),
      })
    }
    // Phase 7 M4 — env override for org mode. Without GOTONG_MODE the
    // store auto-detects (personal when single-user, team otherwise)
    // and auto-promotes on 2nd user or first invitation. GOTONG_MODE
    // pins a specific value, useful for:
    //   - team deployments that don't want the auto-detect ever firing
    //   - personal hubs that want to stay personal even after testing
    //     invitations
    const modeOverride = process.env.GOTONG_MODE
    if (modeOverride === 'personal' || modeOverride === 'team') {
      identity.setOrgMode(modeOverride)
      log.info('identity: org_mode pinned from GOTONG_MODE', { mode: modeOverride })
    } else if (modeOverride !== undefined && modeOverride !== '') {
      log.warn('identity: GOTONG_MODE invalid, ignored', {
        value: modeOverride,
        expected: "'personal' | 'team'",
      })
    }
    log.info('identity: org_mode', { mode: identity.getOrgMode() })
    // B1.2 — org-level LLM key pool wraps the vault. Created here so
    // both LocalAgentPool (key resolution chain) and any future B-tier
    // consumer (knowledge service, mcp pool) share the same memoised
    // view of org-owned credentials.
    orgApiPool = new OrgApiPool({ identity })
  } catch (err) {
    // Degrade gracefully: if SQLite open / migrate / master-key load
    // failed, log loudly but keep the host up. Pre-v4 auth paths
    // (Space.admins) still work and the LLM key chain falls back to
    // the v3 workspace store + env — the operator just loses access
    // to v4-only surfaces (identity routes + org-pool key resolution).
    log.error('identity: bootstrap failed (continuing without v4 identity)', { err })
    identity = undefined
    orgApiPool = undefined
  }

  // V4-AUDIT-05: periodically reap expired session rows. Bearer auth
  // (V4-AUDIT-04 fix) mints 60s-TTL sessions on every request — without
  // this sweep, expired rows accumulate forever. 1h cadence is a balance
  // between "DB doesn't bloat" and "sweep doesn't churn IO". `unref()`
  // so the timer never holds the event loop open after a graceful stop.
  let identityCleanupTimer: NodeJS.Timeout | undefined
  let usageSweepTimer: NodeJS.Timeout | undefined
  let orgQuotaSweepTimer: NodeJS.Timeout | undefined
  // v5 Stream F day-3 — control-plane alert delivery sweep. OPT-IN: fires every
  // GOTONG_PEER_SUMMARY_ALERT_SWEEP_MS (0 / unset = off) to edge-trigger breaches
  // into firings + POST webhooks. Off by default — point-in-time evaluation in
  // the admin UI is unchanged; proactive delivery is a deliberate enable.
  let alertSweepTimer: NodeJS.Timeout | undefined
  // Phase 11 M3 — resume sweep. Fires every GOTONG_RESUME_SWEEP_MS
  // (default 30 s); each tick reads due rows from suspended_tasks
  // and re-dispatches them via Hub.resumeTask.
  let resumeSweepTimer: NodeJS.Timeout | undefined
  // One-shot grace timer that kicks off the boot-time workflow resume scan
  // (see far below). Tracked like the sweeps so shutdown can cancel it —
  // otherwise a stop within the grace window leaves it to fire into a
  // half-torn-down host.
  let resumeKickoffTimer: NodeJS.Timeout | undefined
  if (identity) {
    const sweep = (): void => {
      try {
        const r = identity!.cleanupExpiredSessions()
        if (r.removed > 0) {
          log.info('identity: expired sessions cleaned', { removed: r.removed })
        }
      } catch (err) {
        log.error('identity: session cleanup failed', { err })
      }
    }
    identityCleanupTimer = setInterval(sweep, 60 * 60 * 1000)
    identityCleanupTimer.unref?.()

    // B2.3 — periodic usage-counter sweep. checkAndIncrement auto-rolls
    // on call, so this only matters for listUsage freshness on counters
    // nobody touched this period (admin dashboards, future E1 per-org
    // aggregation). 1h cadence matches the hourly-boundary granularity:
    // any longer and a counter could appear "stuck on yesterday" for
    // hours after midnight in admin UI.
    const sweepUsage = (): void => {
      try {
        const r = identity!.sweepUsageCounters()
        if (r.rolled > 0) {
          log.info('identity: usage counters rolled', {
            rolled: r.rolled,
            ...r.byPeriod,
          })
        }
      } catch (err) {
        log.error('identity: usage sweep failed', { err })
      }
    }
    usageSweepTimer = setInterval(sweepUsage, 60 * 60 * 1000)
    usageSweepTimer.unref?.()

    // E1 — per-org soft quota sweep. After usage_counters are fresh
    // (sweepUsage has just run), walk every configured org_quota row and
    // emit an audit_log entry on state TRANSITIONS only (ok⇄warn⇄over).
    // The store's checkOrgQuotaThreshold writes lastState atomically so
    // re-checks at the same state are silent — admins see one event per
    // threshold crossing, not one per tick.
    //
    // Soft: we never refuse a call here. The per-user checkAndIncrement
    // remains the only hard gate; this layer is operator visibility.
    const sweepOrgQuotas = (): void => {
      try {
        const quotas = identity!.listOrgQuotas()
        if (quotas.length === 0) return
        for (const q of quotas) {
          try {
            const r = identity!.checkOrgQuotaThreshold(q.metric, q.period)
            if (!r.transitioned) continue
            // Map state → audit action. Recover covers any transition
            // INTO 'ok' (from warn or over). The reverse direction
            // (warn → over) emits ORG_QUOTA_OVER, etc.
            let action: string
            if (r.state === 'ok') action = AUDIT_ACTIONS.ORG_QUOTA_RECOVER
            else if (r.state === 'warn') action = AUDIT_ACTIONS.ORG_QUOTA_WARN
            else action = AUDIT_ACTIONS.ORG_QUOTA_OVER
            identity!.writeAuditLog({
              action,
              actorSource: 'system',
              metadata: {
                metric: r.metric,
                period: r.period,
                quota: r.quota,
                usage: r.usage,
                pct: r.pct,
                warnPct: r.warnPct,
                previousState: r.previousState,
                state: r.state,
              },
            })
            log.info('org quota state transition', {
              metric: r.metric,
              period: r.period,
              from: r.previousState,
              to: r.state,
              pct: r.pct,
            })
          } catch (err) {
            log.error('org quota check failed', {
              metric: q.metric,
              period: q.period,
              err,
            })
          }
        }
      } catch (err) {
        log.error('org quota sweep failed', { err })
      }
    }
    orgQuotaSweepTimer = setInterval(sweepOrgQuotas, 60 * 60 * 1000)
    orgQuotaSweepTimer.unref?.()
  }

  // D2 — cross-hub HITL routing. PeerRegistry is constructed later
  // (it needs the ws handle); we plumb it in via a mutable holder so
  // the resolver closure can see the registry once it exists. Until
  // then, the resolver returns null and the scheduler falls through
  // to the normal "no such participant" path.
  //
  // The resolver only fires for explicit dispatches whose target is
  // NOT locally registered AND whose task carries an origin (the
  // sender's hub id). That matches the cross-hub HITL pattern: a
  // federated task ran on this hub, the agent now needs to ask its
  // originating user a question, and the dispatch target is a user
  // id over on `task.origin.orgId`.
  let peerRegistryRef: PeerRegistry | undefined
  // Stream H — forward ref to the outbound A2A manager (built further down,
  // after createWorkflowController) so the workflow controller's off-hub
  // capability view can also enumerate live external A2A agents lazily.
  let a2aOutboundRef: A2aOutboundManager | undefined
  // Phase 11 M2 — SuspendTaskError → this notifier persists the parked task.
  // Wired only when identity opened (otherwise non-durable suspend: agents
  // still get the 'suspended' result shape but parks don't survive a process
  // restart). `hubId` is a fixed sentinel; the row is keyed by task_id alone.
  // Route B P0-M2 (M3b) — boot-time transcript retention. MUST run before
  // `new Hub({space})`: the Hub's FileStorage caches its high-water seq at
  // construction (M3a), so the checkpoint that archiving writes has to be on
  // disk first. Off by default (no env ⇒ parse returns undefined ⇒ no-op).
  // A malformed env throws here (loud misconfig); the archive itself is
  // best-effort so a filesystem hiccup never blocks the boot.
  const retentionPolicy = parseTranscriptRetention(process.env, Date.now())
  if (retentionPolicy) {
    try {
      const { moved } = await applyTranscriptRetention(space.storage(), retentionPolicy)
      if (moved.length > 0) {
        log.info('transcript retention applied', {
          archived: moved.length,
          keepLast: retentionPolicy.keepLast,
          before: retentionPolicy.before,
        })
      }
    } catch (err) {
      log.warn('transcript retention failed — booting with the full transcript', { err })
    }
  }

  const identityForSuspend = identity
  // ACP-HITL — set further down (near the ACP outbound manager) once the member
  // inbox + an owner are resolved. The notifier funnels every park, so it asks
  // this sink to turn an ACP permission park into a /me approval item; it is a
  // no-op for every other kind of park (and unset when escalation isn't wired).
  let acpEscalationSink: ((task: Task, by: string, state: unknown) => Promise<void>) | undefined
  // BF-M4 — the sibling sink for the resident butler. A governed butler action
  // parks with a `ButlerGateState`; this turns that park into a /me approval item
  // (no-op for a pure-memory butler, which never parks for approval). Set further
  // down once the member inbox is resolved; the approver is the MEMBER themselves
  // (you clear your own butler's dangerous moves), taken from `task.origin.userId`.
  let butlerEscalationSink: ((task: Task, by: string, state: unknown) => Promise<void>) | undefined
  const hub = new Hub({
    space,
    crossHubResolver: (_to, task) => {
      if (!peerRegistryRef || !task.origin) return null
      const link = peerRegistryRef.linkForHub(task.origin.orgId)
      if (!link) return null
      return (t) => link.dispatch(t)
    },
    ...(identityForSuspend
      ? {
          suspendNotifier: async (task, by, suspend) => {
            // JSON.stringify of `task` may throw on circular payloads;
            // we let it propagate so the scheduler's catch turns the
            // whole suspend into a `failed` result rather than
            // silently writing a broken row.
            identityForSuspend.persistSuspendedTask({
              taskId: task.id,
              agentId: by,
              hubId: 'local',
              originUserId: task.origin?.userId ?? null,
              resumeAt: suspend.resumeAt,
              state: suspend.state,
              taskJson: JSON.stringify(task),
            })
            // An outbound ACP agent that escalated a destructive tool becomes a
            // /me approval here (the leaf adapter can't reach the inbox). Awaited
            // so the item exists before dispatch returns `suspended`.
            await acpEscalationSink?.(task, by, suspend.state)
            // BF-M4 — same for a resident butler that parked a governed action.
            // Returns null (no write) for every non-governed park, so calling it
            // for every suspend is safe (no double-write with the ACP / inbox /
            // approval-gate sinks, which key off their own state shapes).
            await butlerEscalationSink?.(task, by, suspend.state)
          },
        }
      : {}),
  })
  await hub.start()

  hub.onEvent((e) => {
    process.stdout.write(`[hub][seq=${String(e.seq).padStart(2, '0')}] ${describe(e)}\n`)
  })

  // Phase 11 M3 — resume sweep. Every GOTONG_RESUME_SWEEP_MS (default
  // 30_000 ms; clamped to [1_000, 600_000]) scan suspended_tasks
  // for rows where resume_at <= now, re-enter each via
  // `hub.resumeTask`, then conditionally remove the row (kept on
  // suspend-again — INSERT OR REPLACE already refreshed it).
  //
  // A reentrancy guard prevents two ticks from racing if a slow
  // sweep (lots of due rows + slow agents) crosses the next
  // interval. We don't queue — the next tick will pick up whatever
  // remained.
  if (identity) {
    const swept = identity
    const rawInterval = Number(process.env.GOTONG_RESUME_SWEEP_MS ?? '30000')
    const sweepIntervalMs = Number.isFinite(rawInterval) && rawInterval >= 1_000
      ? Math.min(rawInterval, 600_000)
      : 30_000
    // R9 — how long a resume claim may be held before the reclaimer treats it
    // as crashed and returns the row to the unclaimed pool. Must comfortably
    // exceed the longest plausible single resume (an LLM tool loop can run for
    // minutes), since reclaiming a still-running resume risks an at-least-once
    // re-run. Default 10 min; floored at 2 sweep intervals so a claim is never
    // reclaimed before the next tick even runs; clamped to [1 min, 1 h].
    const rawClaimTtl = Number(process.env.GOTONG_RESUME_CLAIM_TTL_MS ?? '600000')
    const claimTtlMs = Math.min(
      Math.max(
        Number.isFinite(rawClaimTtl) && rawClaimTtl > 0 ? rawClaimTtl : 600_000,
        sweepIntervalMs * 2,
        60_000,
      ),
      3_600_000,
    )
    let sweepInflight = false
    const sweepResume = async (): Promise<void> => {
      if (sweepInflight) return
      sweepInflight = true
      try {
        // R9 — reclaim claims whose owner crashed mid-resume (claimed but
        // never removed) before listing, so a stranded row reappears as due.
        // Best-effort: a failure here just means this tick skips reclamation.
        try {
          const reclaimed = swept.reclaimStaleSuspendedClaims(Date.now() - claimTtlMs)
          if (reclaimed > 0) {
            log.warn('resume sweep: reclaimed stale claims', { count: reclaimed })
          }
        } catch (err) {
          log.error('resume sweep: reclaimStaleSuspendedClaims failed', { err })
        }
        const due = swept.listDueSuspendedTasks({ now: Date.now(), limit: 100 })
        for (const row of due) {
          // R9 — atomically claim the row before touching it. If we lost the
          // race (a concurrent tick, or another host sharing this store, got
          // there first), skip: the winner owns the resume. This makes the
          // path multi-node-ready and shrinks the crash-replay window to
          // "after claim, before terminal remove" (still at-least-once, but
          // the reclaimer bounds how long such a row stays stranded).
          if (!swept.claimSuspendedTask(row.taskId, Date.now())) continue
          if (row.corrupt) {
            // Corrupt `state` blob (truncated/garbled write). The store
            // flagged it instead of throwing — which previously aborted
            // the whole batch and re-threw every tick, starving all
            // other parked tasks. Drop it: a half-parsed state can't be
            // resumed without re-entering the agent into a broken state.
            log.error('resume sweep: corrupt suspended state — dropping row', {
              taskId: row.taskId,
            })
            try { swept.removeSuspendedTask(row.taskId) } catch { /* noop */ }
            continue
          }
          let task: Task
          try {
            task = JSON.parse(row.taskJson) as Task
          } catch (err) {
            // Corrupt task_json — drop the row so the sweep doesn't
            // loop on it forever. Operator gets a log entry.
            log.error('resume sweep: corrupt task_json — dropping row', {
              taskId: row.taskId,
              err,
            })
            try { swept.removeSuspendedTask(row.taskId) } catch { /* noop */ }
            continue
          }
          try {
            const result = await hub.resumeTask(row.agentId, task, row.state)
            // Only remove the row when the participant produced a
            // terminal outcome (ok / failed / cancelled / no_participant).
            // A suspend-again already wrote a fresh row via the
            // notifier's INSERT OR REPLACE — removing here would
            // delete the just-renewed entry.
            if (result.kind !== 'suspended') {
              try { swept.removeSuspendedTask(row.taskId) } catch (err) {
                log.error('resume sweep: removeSuspendedTask failed', {
                  taskId: row.taskId,
                  err,
                })
              }
            }
          } catch (err) {
            // Shouldn't happen — hub.resumeTask catches all in-handler
            // errors and returns a TaskResult. Log defensively in case
            // a future refactor regresses.
            log.error('resume sweep: hub.resumeTask threw unexpectedly', {
              taskId: row.taskId,
              err,
            })
          }
        }
      } catch (err) {
        log.error('resume sweep: listDueSuspendedTasks failed', { err })
      } finally {
        sweepInflight = false
      }
    }
    resumeSweepTimer = setInterval(() => { void sweepResume() }, sweepIntervalMs)
    resumeSweepTimer.unref?.()
    log.info('resume sweep started', { intervalMs: sweepIntervalMs })
  }

  // v5 Stream D — proactive heartbeat engine. Arming (broker + scheduler build
  // + boot reconcile) lives in heartbeat-engine.ts for the GUARD-M2 line
  // budget; it stays fully dormant until an agent opts in, and a store-less hub
  // never arms it. The returned reconcile hook is forwarded to agent CRUD.
  let reconcileHeartbeats: (() => Promise<void>) | undefined
  if (identity) {
    ;({ reconcileHeartbeats } = await armHeartbeatEngine({ identity, space, hub, log }))
  }

  // Hub Services (memory / artifact / datastore plugins). Plugin load
  // failures are non-fatal: a bad plugin shows up in the boot log but
  // the host continues to start. Agents whose yaml `uses:` references
  // a missing plugin will fail at spawn time. The instance is held so
  // we can `shutdownAll` on graceful exit.
  let services: HubServices | undefined
  let sweeper: LifecycleSweeper | undefined
  try {
    // In `bun --compile` single-file binary mode, omit
    // `@gotong/service-datastore-sqlite` from the auto-seeded
    // plugins.json so operators don't see a spurious "failed to load"
    // warning on every first run — `better-sqlite3`'s native bindings
    // can't be embedded by the bundler. npm / docker / source runs
    // keep the full default seed.
    const boot = await bootstrapServices({
      space,
      hub,
      ...(isCompiledBinary() ? { seedPlugins: BINARY_SAFE_PLUGINS } : {}),
    })
    services = boot.services
    if (boot.seeded) {
      log.info('services: bootstrapped (seeded)', {
        path: `${SPACE_DIR}/services/plugins.json`,
        ready: boot.ready.map((p) => `${p.type}:${p.impl}`),
      })
    } else {
      log.info('services: bootstrapped', {
        ready: boot.ready.map((p) => `${p.type}:${p.impl}`),
        errors: boot.errors.map((e) => e.packageName),
      })
    }
    // Background sweep: hard-delete trash entries past their
    // expiresAt. Default cadence is 1h — see LifecycleSweeper. The
    // first tick runs on the next microtask so a host that booted
    // with already-expired entries from a previous run drains right
    // away.
    sweeper = new LifecycleSweeper({ services })
    sweeper.start()
  } catch (err) {
    // `bootstrapServices` itself should never throw — its internals
    // are all best-effort. But if it does (e.g. permission denied
    // writing the seed manifest), we log and continue: a host without
    // services is degraded but still useful for non-service agents.
    log.error('services: bootstrap failed (continuing without services)', { err })
  }

  // The LocalAgentPool materialises every `agents.json` row that carries
  // a `managed` spec into a live LlmAgent on the Hub. Not a separate
  // service — just a piece of host startup. Run before the Web server
  // boots so API responses include managed agents from the first call.
  // `services` is passed through so agents with `uses:` declarations
  // get their handles attached at spawn time (PR-8). When services
  // failed to bootstrap, agents without `uses:` still spawn normally;
  // agents with `uses:` fail loudly with a clear log line.
  // Phase 17 — effective model price table for the usage/cost ledger.
  // Defaults built-in; an operator drops `<GOTONG_SPACE>/pricing.json` to
  // override per-model. A malformed file throws here (fail loud at boot
  // rather than silently bill at the wrong rate).
  const pricingTable = loadPricingTable(join(SPACE_DIR, 'pricing.json'))

  // Phase 9 M4 — admin/member file uploads. Wires the artifact plugin's
  // 'file' impl to a system-shared 'uploads' namespace so /api/admin/uploads
  // can persist a multimodal payload before it lands on a workflow.
  // The plugin must be loaded (it's in the default seed); attach
  // failure is non-fatal — `uploads` stays undefined and Web responds
  // 503 cleanly. Same posture as `services` / `identity` / `peerRegistry`.
  // Created BEFORE the agent pool so the pool can hand each provider an
  // `artifactResolver` — without it a multimodal payload referencing an
  // upload (`file_ref` / `artifact_ref`) fails inside the provider with
  // "artifact_ref source requires an artifactResolver" (audit P1).
  let uploads: Awaited<ReturnType<typeof createUploadSurface>> | undefined
  if (services) {
    try {
      uploads = await createUploadSurface({ services, logger: log })
      log.info('uploads: shared/uploads handle attached')
    } catch (err) {
      log.warn('uploads: attach failed — /api/admin/uploads will be 503', { err })
    }
  }
  const uploadsRef = uploads

  // BF-M4 — the resident butler fold-in. A `chat`-capable managed LLM row
  // spawns as a per-user `ButlerRouter` instead of a plain `LlmAgent`: SAME id
  // (admin / lifecycle / restart / test-connection unchanged) but routed by
  // `task.origin.userId` to a butler with that member's OWN memory namespace —
  // what makes the IM bot REMEMBER each member across sessions. ON by default
  // (`GOTONG_BUTLER` ∈ {0,false,off,no} turns it OFF; per-agent
  // `managed.butler: false` opts a row out). Gains cross-session memory + the
  // row's benign tools (inline), plus the BF-M7 governed action set when the
  // member services exist — each APPROVAL-GATED to /me (`GOTONG_BUTLER_GOVERNED`
  // off ⇒ pure-memory). Memory lives under the SAME `<space>/butler/memory`
  // subtree the /me privacy view reads — one and the same bytes.
  // 所有 GOTONG_BUTLER* 旋钮(开关方向、级联、周期钳位)解析在 butler-env.ts,
  // 那里有它们仨条不好从代码读出来的语义 + 单测。
  const {
    memoryRoot: butlerMemoryRoot, defaultOn: butlerDefaultOn, governedOn: butlerGovernedOn,
    memoryLinksOn: butlerMemoryLinksOn, maintenanceOn: butlerMaintenanceOn, maintenanceMs: butlerMaintenanceMs,
    memoryGitOn: butlerMemoryGitOn, memoryReconcileOn: butlerMemoryReconcileOn,
    memoryLibrarianOn: butlerMemoryLibrarianOn, proactiveOn: butlerProactiveOn, proactiveMs: butlerProactiveMs,
    runBroadcastOn: butlerRunBroadcastOn, runBroadcastMs: butlerRunBroadcastMs,
  } = parseButlerEnv(process.env, space.root)
  // M-EMB1 — opt-in real embedder for 阿同 recall (unset ⇒ local default, byte-identical).
  const butlerEmbedder = butlerEmbedderFromEnv()
  if (butlerEmbedder) log.info(butlerEmbedder.disclosure, { dataLeavesBox: butlerEmbedder.dataLeavesBox })
  // VOICE-M3/ASR-M3 — opt-in 语音嘴+耳(URL/_KEY 共享;_MODEL+_VOICE 开嘴、_ASR_MODEL 开耳;未配 ⇒ 字节不变)。
  const butlerVoice = butlerVoiceFromEnv()
  if (butlerVoice) log.info(butlerVoice.disclosure, { dataLeavesBox: butlerVoice.dataLeavesBox })
  const butlerHearing = butlerHearingFromEnv()
  if (butlerHearing) log.info(butlerHearing.disclosure, { dataLeavesBox: butlerHearing.dataLeavesBox })
  // BF-M7 — governed set(建/改/删自己的 agent+改工作流)逐项 park 到 /me;执行器=/me steward 同一服务(闸不越面);refs lazy 读,缺 ⇒ 纯记忆。
  let butlerGovernedAgentsRef: StewardAgentDirectory | undefined
  let butlerGovernedWorkflowEditorRef: StewardWorkflowEditor | undefined
  // BE-M3 — the butler's governed "用大白话给我建个工作流" verb reuses the member
  // 工作流架构师 (`MeWorkflowCreateService`): NL→YAML, local-only (cross-hub reject),
  // draft-never-live. Ref assigned once that service exists (only when workflowAssist
  // is present). Absent ⇒ the `create_workflow` gate isn't composed at all.
  let butlerWorkflowCreateRef: ButlerWorkflowCreateSource | undefined
  // S1-M1 — benign "run my workflow" catalog; forward-declared `let` read at
  // butler-build (controller built further down). Absent ⇒ no run-workflow tool.
  let butlerWorkflowsRef: ButlerWorkflowSurface | undefined
  // BE-M1 — benign READ "eyes" (runs / helpers / own usage), same projections
  // the /me panels read, member-scoped server-side (no-leak). Lazy `let`s
  // assigned once controller / agent projection / ledger exist further down.
  let butlerObserveRunsRef: ButlerRunSurface | undefined
  let butlerObserveAgentsRef: ButlerAgentSurface | undefined
  let butlerObserveUsageRef: ButlerUsageSurface | undefined
  // BE-M2 — the butler's benign "体检我的助手" diagnosis: runs the RES-M2 pure
  // engine over the member's OWNED agents (scoped, no-leak) and reports what's
  // wrong + how to fix. The FIX reuses the existing governed `edit_agent` (only a
  // native provider-switch is butler-enactable; the rest is advisory → admin
  // panel). Refs assigned once the member-agent lister + adaptation service exist.
  let butlerDiagnoseOwnedRef: ButlerOwnedAgentSource | undefined
  let butlerDiagnoseAdaptRef: ButlerAdaptationSource | undefined
  // BE-M4 — benign "问我自己的助手" one-shot dispatch (no-leak via listOwned); ref absent ⇒ tool off.
  let butlerAskRosterRef: ButlerAskRosterSource | undefined
  // NET-M1 — the butler's benign network eye: sanitized mesh roster (no
  // endpoint/token/ACL detail). Ref assigned once the peer registry exists.
  let butlerPeerRosterRef: ButlerPeerSurface | undefined
  let butlerLlmRosterRef: ButlerLlmSurface | undefined
  let butlerSchedulesRef: ButlerScheduleSurface | undefined // SEN-M4 定时投影(admin list 同源)
  // WIZ-M4c — benign 建流向导 compose (组装→缺口→校验闭环), proposal-only; save
  // hands off to governed create_workflow. Ref needs workflowAssist; absent ⇒
  // tool off (same degradation as the /me wizard routes' 503).
  let butlerWizardRef: ButlerWizardSource | undefined
  // S2-M2 — the benign "整理一下记忆" tool resolves the distillation provider
  // (the butler's own model) through the agent pool, which is built further down.
  // Forward-declared `let` read at butler-build time (same lazy pattern). Absent ⇒
  // the butler simply has no consolidate tool; a null result at call time is a
  // friendly refusal. Assigned right after `localAgents.start()`.
  let butlerProviderBuilderRef: (() => Promise<LlmProvider | null>) | undefined
  // S2-M1 — the /me butler-memory privacy service doubles as the IM answer to
  // "你记得我什么": the butler's `show_my_memory` tool reads through the SAME
  // service (same bytes, same projection) so what it says it remembers and what
  // the member can see / erase are one source of truth. Constructed with the
  // other member services further down; forward-declared `let` read at
  // butler-build time (same lazy pattern).
  let butlerMemoryViewRef: HostButlerMemoryService | undefined
  let butlerPendingInboxRef: HostInboxService | undefined // A1 — /me pending inbox for the待办 reminder card
  // BF-M8 — the background memory-maintenance sweep: per member, on a 6h cadence,
  // consolidate captured episodic into the curated semantic profile (蒸馏) and
  // record it to STATUS.md (/me's "上次维护" line). ON by default whenever the
  // butler is on; opt out with GOTONG_BUTLER_MAINTENANCE ∈ {0,false,off,no}. Cadence
  // via GOTONG_BUTLER_MAINTENANCE_MS (clamped [1min, 24h]). Constructed after the
  // agent pool exists (it borrows the pool's provider-resolution); see below.
  // (旋钮解析全在 butler-env.ts;S3-M2 主动晨报、BE-M5 运行播报同理。)
  // CARE-M4 — 活体校验 closure, bound after the pool starts (below); the
  // onboarding toolset reads it lazily so an early butler answers honestly.
  let butlerOnboardingKeyCheckRef: ButlerOnboardingKeyCheck | undefined
  // AFR-M7 — 阿同恢复层 ops(status/pack/提醒共用):打包是凭证级动作(身份档
  // 含 hub 签名钥),owner/admin 判定钉在 ops 里服务端权威;identity 缺席 = 不装。
  const identityForBackup = identity
  const butlerBackupOps = identityForBackup
    ? buildButlerBackupOps({
        spaceRoot: space.root,
        membershipRole: (uid) => identityForBackup.getMembership(uid)?.role,
        peerCreatedTimes: () => identityForBackup.listPeers().map((p) => p.createdAt),
      })
    : undefined
  // Per-user butler assembly lives in personal-butler-factory.ts (GUARD
  // extraction); refs() reads the forward-declared refs at butler-build time.
  const butlerFactory: ButlerFactory = buildButlerFactory({
    hub,
    logger: log,
    memoryRoot: butlerMemoryRoot,
    governedOn: butlerGovernedOn,
    maintenanceOn: butlerMaintenanceOn,
    proactiveOn: butlerProactiveOn,
    runBroadcastOn: butlerRunBroadcastOn,
    embedder: butlerEmbedder?.embed,
    memoryLinks: butlerMemoryLinksOn,
    refs: () => ({
      governedAgents: butlerGovernedAgentsRef,
      workflowEditor: butlerGovernedWorkflowEditorRef,
      workflowCreate: butlerWorkflowCreateRef,
      workflows: butlerWorkflowsRef,
      observeRuns: butlerObserveRunsRef,
      observeAgents: butlerObserveAgentsRef,
      observeUsage: butlerObserveUsageRef,
      diagnoseOwned: butlerDiagnoseOwnedRef,
      diagnoseAdapt: butlerDiagnoseAdaptRef,
      askRoster: butlerAskRosterRef,
      peerRoster: butlerPeerRosterRef,
      llmRoster: butlerLlmRosterRef,
      schedules: butlerSchedulesRef,
      wizard: butlerWizardRef,
      providerBuilder: butlerProviderBuilderRef,
      memoryView: butlerMemoryViewRef,
      pendingInbox: butlerPendingInboxRef,
      memberPush: butlerPushRef, // DUO-M2 escalate result push-back (lazy IM ref)
    }),
    // CARE-M4 — 开箱陪跑: zero-LLM 现状卡 injection at the free-chat entry +
    // the read-only key 活体校验. Health rides the SAME lazy adminHealth ref
    // the patrol uses; lang is the host's resolved default (never re-read env).
    onboarding: {
      stateFile: join(space.root, 'butler', 'onboarding-state.json'),
      health: () => patrolHealthRef,
      keyCheck: () => butlerOnboardingKeyCheckRef,
      lang: config.defaultLang,
    },
    ...(butlerBackupOps ? { backupOps: butlerBackupOps } : {}),
    // SEN-M5 — 成员名单投影源(岔口 A 全员见名+角色+id;email 结构性不进投影)。
    ...(identityForBackup
      ? { members: { users: () => identityForBackup.listUsers(),
          membershipRole: (uid: string) => identityForBackup.getMembership(uid)?.role ?? null } }
      : {}),
  })

  // MR-M3 — shared per-provider routing-health projection, fed by every routed
  // provider the pool builds, read by the health service below (in-memory; see routing-health.ts).
  const routingHealth = new RoutingHealthTracker()
  const localAgents = new LocalAgentPool({
    butlerFactory,
    butlerDefaultOn,
    // WSE — TAVILY/BRAVE_API_KEY 在环境里 ⇒ 管家自动挂官方搜索(read 工具面),同名让位。
    butlerBonusMcpSpecs: detectButlerWebSearchSpecs(process.env),
    hub,
    space,
    services,
    orgApiPool,
    pricingTable,
    routingHealth,
    // Audit P1 — managed agents resolve artifact/file refs via the shared uploads handle.
    ...(uploadsRef
      ? { artifactResolver: (artifactId: string) => uploadsRef.get(artifactId) }
      : {}),
    // Phase 6 #2 — onAuthFailure: vault-keyed 401 revokes + audits + flushes OrgApiPool.
    // C-M2-M4a — `${OAUTH_ACCESS_TOKEN}` → live connector token, inert w/o.
    ...(identity ? { identity, mcpSecretSource: makeOAuthSecretSource(identity) } : {}),
    // #2-M3 — cross-hub MCP refs resolve the peer link lazily (forward `let` below);
    // reading at call time lets RemoteMcpToolset's offline path handle it.
    peerLinkResolver: (peerId) => peerRegistryRef?.linkForHub(peerId) ?? null,
  })
  await localAgents.start()

  // S2-M2 — bind the provider builder the on-demand "整理记忆" tool uses (same
  // source as the 6h sweep's `buildProvider`), read lazily at butler-build time.
  // Assigned unconditionally; the factory still gates on `butlerMaintenanceOn`.
  butlerProviderBuilderRef = () => localAgents.buildButlerProvider()
  // LSA-M1 — 阿同自省自己的模型链(脱敏无 key):pool 配置候选链 ⊕ routingHealth 健康叠加。
  butlerLlmRosterRef = buildButlerLlmSurface({ roster: () => localAgents.butlerLlmRoster(), health: () => routingHealth.snapshot() })
  // CARE-M4 — 活体校验 rides the pool's key-resolution chain + read-only models GET.
  butlerOnboardingKeyCheckRef = buildOnboardingKeyCheck({
    resolveTarget: (agentId) => localAgents.resolveLlmProbeTarget(agentId),
  })

  // BF-M8 — butler memory-maintenance sweep: pool provider + NA-M5 model override
  // (both per-tick), walks user/* distilling episodic → profiles + STATUS.md.
  let butlerMaintenanceSweeper: ButlerMaintenanceSweeper | undefined
  if (butlerMaintenanceOn) {
    butlerMaintenanceSweeper = new ButlerMaintenanceSweeper({
      rootDir: butlerMemoryRoot,
      buildProvider: () => localAgents.buildButlerProvider(),
      resolveModel: () => localAgents.butlerMaintenanceModel(),
      logger: log,
      intervalMs: butlerMaintenanceMs,
      gitSnapshot: butlerMemoryGitOn,
      links: butlerMemoryLinksOn,
      reconcile: butlerMemoryReconcileOn,
      librarian: butlerMemoryLibrarianOn,
    })
    butlerMaintenanceSweeper.start()
  }

  // Growth-reports admin surface — only meaningful if the personal-growth team is
  // loaded. The accessor closure re-resolves on every web call so admin/restart of
  // the synthesist agent picks up cleanly.
  const growthReports = new GrowthReportsAdmin({
    artifactAccessor: () => {
      const ctx = localAgents.liveServicesFor('growth-synthesist')
      return ctx?.artifact
    },
  })

  // Workflow runners. Optional — the loader silently no-ops when the directory
  // doesn't exist (users not using workflows see no extra log). Errors are per-file;
  // one bad workflow never blocks boot. The loader only parses; the controller adopts
  // each definition through the versioning service, which registers the runner (Phase 15).
  const workflowsDir = env('GOTONG_WORKFLOWS_DIR', join(SPACE_DIR, 'workflows', 'definitions'))!
  const workflowReport = await loadWorkflows({ dir: workflowsDir })
  const wfMsg = formatLoadReport(workflowReport)
  if (wfMsg) log.info('workflow loader', { report: wfMsg })

  // VALID-M3 — deterministic (non-AI) review of the definitions we just loaded.
  // The workflow loader already SKIPS a file it can't parse (workflowReport.failed)
  // and the agent pool already SKIPS a row it can't spawn, but both degrade
  // SILENTLY — one typo buries a workflow/agent behind a single quiet log line.
  // Surface them together in ONE loud banner so the operator sees, at boot,
  // exactly which files won't load. Reuses the SAME validators `gotong check`
  // runs (the loader's own report + checkAgentsFile), so a clean boot means what
  // the CLI means — no second source of truth. The config 体检 is enforced
  // separately above by `auditBootSecurity` (fail-closed on its fatals), so this
  // banner is definitions-only.
  //
  // Posture is the operator's locked decision: default = warn loud + keep
  // serving (one bad file must never take down a live hub); GOTONG_STRICT_DEFINITIONS
  // = refuse to start (CI / strict deploys) by exiting BEFORE the web server binds.
  // Note: a wholly malformed agents.json (not a bad row) already throws inside the
  // agent pool above; `gotong check` is the friendly pre-boot tool for that case.
  const agentsCheck = await checkAgentsFile(join(SPACE_DIR, 'agents.json'))
  const defns: WorkspaceCheckReport = definitionsReport(workflowReport, agentsCheck)
  if (defns.errors > 0) {
    const banner = formatCheckReport(defns)
    log.warn('definition check found problems', {
      workflowsBad: defns.workflows.bad,
      agentsBad: defns.agents.bad,
    })
    if (envBool('GOTONG_STRICT_DEFINITIONS', false)) {
      console.error('\n=== Gotong 定义校验失败 / definition check failed ===')
      console.error(banner)
      console.error(
        `\nFATAL: GOTONG_STRICT_DEFINITIONS is set and ${defns.errors} definition file(s)/row(s) are broken — refusing to start.\n` +
          `       Fix the files above (or run \`gotong check\`), or unset\n` +
          `       GOTONG_STRICT_DEFINITIONS to start anyway (the broken ones are skipped).\n`,
      )
      process.exit(1)
    }
    console.warn('\n=== Gotong 定义校验警告 / definition check warning ===')
    console.warn(banner)
    console.warn(
      `\n⚠ The ${defns.errors} broken definition(s) above were SKIPPED — the hub is\n` +
        `  starting WITHOUT them. Fix them and restart, or set GOTONG_STRICT_DEFINITIONS=1\n` +
        `  to refuse to start on a broken file.\n`,
    )
  }

  // Stream G day-2 / H — off-hub capability view for "this step leaves the
  // hub" flags on workflow summaries. Read LAZILY via forward-declared refs:
  // both the peer registry and the A2A manager are built further down, but
  // this closure only fires when an admin summary is projected (an HTTP
  // request long after boot), so it sees the live state.
  //
  // Two sources, mesh peers FIRST so they win attribution on a shared cap:
  //   - `kind:'peer'` — a connected peer's advertised caps ARE the registered
  //     wrapper participant's `.capabilities` (G-M1: outboundCaps →
  //     remoteCapabilities), the same source dispatch routing consults.
  //   - `kind:'a2a'` — a live external A2A agent's caps. We list stored agents
  //     and keep only the ones currently registered (`statusOf().active`), so
  //     a token-less / disabled row isn't flagged as a reachable destination.
  //
  // Extracted to a named const (not inlined in the controller config) so the
  // WFEDIT member-edit service locks the cross-hub 出入口 against the EXACT same
  // peer view the controller's cross-hub-step detection uses — no drift between
  // "what the UI flags as cross-hub" and "what the editor refuses to change".
  const peerCapabilitiesView: PeerCapabilityView = {
    peerCapabilities: () => {
      const peers = (peerRegistryRef?.status() ?? [])
        .filter((s) => s.connected)
        .map((s) => {
          const wrapper = hub.registry.get(s.peerId)
          return {
            peer: s.peerId,
            label: s.label,
            capabilities: wrapper ? [...wrapper.capabilities] : [],
            kind: 'peer' as const,
          }
        })
      const a2a = (a2aOutboundRef?.liveCapabilities() ?? []).map((e) => ({
        ...e,
        kind: 'a2a' as const,
      }))
      return [...peers, ...a2a]
    },
  }

  // WFEDIT-S2 — one sticky cross-hub marker store, shared between the controller
  // (which CAPTURES the off-hub capabilities of a workflow on every write while
  // peers are connected) and the member edit service (which CONSULTS it so the
  // boundary lock holds even when the destination peer is offline at edit time).
  // File-first under <space>/workflows/cross-hub/; no identity table.
  const crossHubMarkers = new FileCrossHubMarkerStore(SPACE_DIR)

  const workflowController = await createWorkflowController(
    {
      hub,
      definitionsDir: workflowsDir,
      spaceRoot: SPACE_DIR,
      peerCapabilities: peerCapabilitiesView,
      crossHubMarkers,
      // Stream G day-5 — resolve a cross-hub step's peer-hub id to its live link
      // so `fetchPeerStepTranscript` can pull the off-hub trace on demand. Same
      // lazy forward-ref as `peerLinkResolver` above (line ~1142) and the cross-
      // hub MCP path: read at request time, never at boot. A mesh hop's
      // `executedBy` IS the peer-hub wire id `linkForHub` keys on.
      peerLinkResolver: (peerId) => peerRegistryRef?.linkForHub(peerId) ?? null,
    },
    workflowReport,
  )
  // S1-M1 — hand the live published catalog to the resident butler's benign
  // "run my workflow" tool (read lazily at butler-build time). The controller's
  // `list()` returns exactly the member-facing summaries the run gate reads.
  butlerWorkflowsRef = workflowController
  // BE-M1 — wire the butler's benign read "eyes":
  //  • runs   — the SAME controller `/api/me/runs` reads; `listRunsByUser` is
  //             scoped to the caller's `triggeredByOrigin.userId` server-side.
  //  • agents — the sanitized member-facing roster (below), shared verbatim with
  //             `/api/me/agents` so there's ONE projection to keep leak-free.
  //  • usage  — this member's usage ledger, aggregated per model, filtered by
  //             `userId` in SQL so alice's butler can never sum bob's bill.
  butlerObserveRunsRef = workflowController
  // The sanitized "my AI helpers" projection — single source for the /me route
  // and the butler's `list_my_agents` eye (id/label/capabilities/online only; a
  // system prompt / model / provider config / per-agent key never leave here).
  const meAgentsSurface = {
    async listForMembers() {
      const recs = await space.agents()
      const liveIds = new Set(hub.participants().map((p) => p.id))
      return recs.map((a) => ({
        id: a.id,
        label: a.displayName ?? a.id,
        capabilities: [...a.allowedCapabilities],
        online: liveIds.has(a.id),
        // v5 D-M4 — expose only the on/off flag; interval + checklist stay host-side.
        ...(a.managed?.heartbeat?.enabled ? { heartbeat: { enabled: true } } : {}),
      }))
    },
  }
  butlerObserveAgentsRef = meAgentsSurface
  if (identity) {
    const idStore = identity
    butlerObserveUsageRef = {
      aggregateForUser: (userId: string) =>
        idStore.aggregateLedger({ groupBy: 'model', userId }),
    }
  }

  // Route B P0-M3-M2 — boot-time workflow-run retention. Prune old TERMINAL
  // runs into `runs/archive/` BEFORE the deferred resume scan (and every later
  // listRuns / metrics walk) so the active scan stays O(tail) instead of O(all
  // runs ever). OFF by default (no env ⇒ undefined ⇒ skip); a malformed value
  // throws here so the boot fails loudly. Archiving itself is best-effort: a
  // failure logs and the host boots with the full (unpruned) run history.
  // Safe to run now — a `running` run is never archived (M3-M1 invariant), so
  // this only removes terminal runs the resume scan would skip anyway.
  const runRetentionPolicy = parseRunRetention(process.env, Date.now())
  if (runRetentionPolicy) {
    try {
      const { archived } = await applyRunRetention(workflowController, runRetentionPolicy)
      if (archived.length > 0) {
        log.info('workflow run retention applied', {
          archived: archived.length,
          keepLast: runRetentionPolicy.keepLast,
          before: runRetentionPolicy.before,
        })
      }
    } catch (err) {
      log.warn('workflow run retention failed — booting with the full run history', { err })
    }
  }

  // Boot-time retention for the identity store's append-only tables
  // (usage_ledger / audit_log / peer_summary_snapshots /
  // peer_summary_alert_firings — one GOTONG_*_KEEP_DAYS knob each, all OFF by
  // default). Parse runs before the identity guard so a malformed env fails
  // the boot loudly even on a degraded (no-identity) host; the prunes are
  // best-effort per table and skipped without an identity store. Every
  // retained window stays exportable via the Phase 17 CSV/JSONL routes.
  const retentionPolicies = parseRetentionPolicies(process.env, Date.now())
  if (retentionPolicies.length > 0 && identity) {
    for (const r of applyRetentionPolicies(identity, retentionPolicies)) {
      if (r.error !== undefined) {
        log.warn('retention failed — booting with the full table', {
          table: r.table,
          err: r.error,
        })
      } else if ((r.pruned ?? 0) > 0) {
        log.info('retention applied', { table: r.table, pruned: r.pruned, before: r.before })
      }
    }
  }

  // Perf audit A⑤ — re-apply the SAME retention policies every 6h at runtime
  // (cutoffs re-anchored per tick). Null when no retention env is set: zero
  // timers, byte-identical host. See retention-sweeper.ts for why re-applying
  // against the live hub is safe (throwaway storage / sealed-only / terminal-only).
  const retentionSweeper = armRetentionSweeper({
    env: process.env,
    storage: () => space.storage(),
    runs: workflowController,
    identity: identity ?? null,
    log,
  })

  // Phase 13 M3 — host-built-in workflow assistant agent. Registers a
  // `WorkflowAssistantAgent` on the hub (cap=`workflow:assist`) and
  // exposes a duck-typed surface for the Web layer's
  // `POST /api/admin/workflows/assist` route. Returns null (and the
  // route stays 503) when GOTONG_ASSISTANT_DISABLED=1 or no LLM API key
  // can be resolved for the configured provider — non-AI hosts pay zero
  // boot cost beyond the env probe.
  const assistConfig = resolveWorkflowAssistConfig()
  const workflowAssist = assistConfig
    ? createWorkflowAssistAgent({
        hub,
        config: assistConfig,
        ...(orgApiPool ? { orgApiPool } : {}),
        logger: log,
      })
    : null

  // WFEDIT — the OpenClaw-style member workflow editor. A member describes a
  // change in plain language; the service runs it through the AI assistant,
  // locks the cross-hub 出入口 (trigger + egress, via the SAME peer view the
  // controller uses), and persists as a new revision (publish if live, draft
  // otherwise). Needs BOTH an LLM assistant (to author the YAML) AND identity
  // (for per-workflow editor RBAC); absent either → null → the /me edit routes
  // degrade to 503. Persistence + the structure hard-gate are the controller's
  // existing publish/saveDraft, so this adds no new write path.
  // MCD-M4 — installed hub MCP server names for the architect's contextHints.
  // The assistant renders these as "Available MCP servers:" so it authors/edits
  // around components that are already wired (少编造后端). Names only — deepCheck
  // never validates MCP server names (they're not capabilities). Reads the live
  // on-disk registry per call; best-effort (the services swallow any failure).
  const mcpServerNames = async (): Promise<string[]> =>
    (await space.mcpServers()).map((r) => r.spec.name)

  const meWorkflowEdit =
    workflowAssist && identity
      ? new MeWorkflowEditService({
          grants: identity,
          workflows: workflowController,
          assist: workflowAssist,
          participants: () => hub.participants(),
          peerCapabilities: peerCapabilitiesView,
          mcpServerNames,
          // WFEDIT-S2 — same store the controller captures into, so an offline
          // peer can't open a window to silently retarget a cross-hub hop.
          crossHubMarkers,
        })
      : null

  // ARCH-M5/M6 — the member-facing "工作流架构师": author a brand-new workflow
  // from plain language (rejecting any cross-hub egress — members are local-only)
  // + explain any catalog workflow at an adjustable depth (with its flowchart).
  // Same duck-typed deps as the editor MINUS the sticky cross-hub markers (a
  // brand-new workflow has no prior egress to protect) and with NO draft cap by
  // default (opt-in anti-abuse — `perMemberDraftCap`/`countOwnedDrafts` stay off).
  const meWorkflowCreate =
    workflowAssist && identity
      ? new MeWorkflowCreateService({
          grants: identity,
          workflows: workflowController,
          assist: workflowAssist,
          participants: () => hub.participants(),
          peerCapabilities: peerCapabilitiesView,
          mcpServerNames,
        })
      : null

  // allowedHosts is resolved earlier (Route B P0-M6 boot self-check).
  const adminRateMax = envInt('GOTONG_ADMIN_RATE_MAX', 10)
  const adminRateSec = envInt('GOTONG_ADMIN_RATE_SEC', 60)

  const ws = await serveWebSocket(hub, {
    host: config.host,
    port: config.wsPort,
    gating: config.gating,
    // Protocol v1.1 SERVICE_CALL support — only enabled when
    // bootstrapServices succeeded (i.e. `services` is defined). When
    // absent, remote agents that declare `services` in HELLO will get
    // `forbidden_service` on every SERVICE_CALL — graceful degradation.
    //
    // HubServices satisfies ServiceCallGateway structurally (attach +
    // detachFor signatures align; HubServices's richer return types are
    // tolerated under structural typing).
    ...(services ? { services } : {}),
  })

  // D1 — Peer Registry. Polls identity.peers every GOTONG_PEER_POLL_MS
  // (default 5s) and reconciles outbound HubLinks; shares ws.server
  // for inbound peer HELLO acceptance. Disabled when identity is
  // unwired (federation requires v4 identity) OR when the operator
  // explicitly skipped it via GOTONG_PEERS_DISABLED=1.
  let peerRegistry: PeerRegistry | undefined
  // #2-M3 — cross-hub MCP proxy (provider side). Lazily connects shared
  // servers on first peer call; credentials resolve here, never cross the
  // link. Built only when peers are enabled (it's wired as the registry's
  // rpcResponder). `close()` runs on shutdown.
  let mcpProxy: McpProxyHost | undefined
  // #2-M3.4b — consumer-side discovery surface for the admin UI: aggregate
  // each connected peer's shared servers (via the mcp.listShared rpc) so an
  // agent's `useMcpServers` can be filled by browsing, not typing. Wired
  // only when peers are on (same block as the registry / proxy).
  let mcpFederation: WebServerOptions['mcpFederation']
  // Phase 18 A-M2 — cross-hub peer capability manifest discovery surface for
  // the admin UI. In-process cache over the registry; refreshed on demand.
  // Wired in the same block as the registry / proxy (peers on).
  let peerFederation: PeerManifestFederation | undefined
  let peerSummaryFederation: PeerSummaryFederation | undefined
  // Phase 16/18 — the member task inbox store is built HERE (ahead of the peers
  // block) so the Phase 18 outbound approval gate and the human-step broker
  // (registered further down) share the EXACT same store. Only with identity
  // wired — durable parking (suspended_tasks) and /me both require a v4 user.
  let inboxStore: FileInboxStore | undefined
  if (identity) {
    inboxStore = new FileInboxStore(SPACE_DIR)
    inboxStore.ensureDirs()
    // BF-M4/M7 — wire the butler escalation sink now that the inbox exists. The
    // approver is the MEMBER who owns the parked task (`origin.userId`): a
    // PERSONAL butler escalates to the very person it serves. A governed action
    // (BF-M7) parks with a `pending` gate → `butlerApprovalItemFor` shapes a /me
    // approval item; a pure-memory / non-governed park returns null → no-op.
    const store = inboxStore
    butlerEscalationSink = async (task, by, state) => {
      const approver = task.origin?.userId
      if (!approver) return // no member to approve (operator/anon park) → nothing to write
      const item = butlerApprovalItemFor(task, by, state, { approver })
      if (item) await store.write(item)
    }
  }
  if (identity && process.env.GOTONG_PEERS_DISABLED !== '1') {
    // 联邦整条腿的接线在 wire-peers.ts —— 那里也写着它到底依赖什么。
    // 「装不装」留在这儿:联邦要 v4 身份,那是装配层的决定。
    const wired = await wirePeers({
      hub,
      identity,
      space,
      logger: log,
      // D1 fix — 入站 mesh 骑 serveWebSocket 的首帧 demux,不是另起 ws.wss 监听器。
      acceptInbound: (h) => ws.routeMeshTo(h),
      inboxStore,
      approverUserId: findOwnerUserId(identity),
      workflows: workflowController,
    })
    mcpProxy = wired.mcpProxy
    peerRegistry = wired.peerRegistry
    // D2 — 让 Hub 的跨 hub resolver 闭包看见这个 registry。
    peerRegistryRef = wired.peerRegistry
    butlerPeerRosterRef = wired.peerRoster
    mcpFederation = wired.mcpFederation
    peerFederation = wired.peerFederation
    peerSummaryFederation = wired.peerSummaryFederation
    alertSweepTimer = wired.alertSweepTimer
  }
  // Readiness flag — flips to true after workflow resume finishes (see
  // the setTimeout block below). `/readyz` reads this; `/healthz` is
  // always 200. Splitting liveness from readiness lets k8s-style probes
  // hold the pod in `NotReady` during the resume grace window instead
  // of restarting it.
  let bootReady = false

  // R3 (A2A alignment) — Agent Card discovery surface. Conservative card:
  // identity + auth scheme only, no skills (see agent-card.ts). Served
  // public at /.well-known/agent-card.json. Bearer is advertised whenever
  // inbound peer auth is active (peer registry on).
  const cardMeta = await space.meta()
  // C-M1 — skill advertisement is OFF by default (see AgentCardSurfaceDeps).
  const advertiseSkills = envBool('GOTONG_A2A_ADVERTISE_SKILLS', false)
  const selfHubIdForCard = cardMeta.hubId ?? 'self'
  // STD-M1 — card signing is OFF by default (unset = byte-identical card). When
  // on, the hub loads/creates a P-256 signing key in the workspace and the card
  // is served with a JWS `signatures[]` + a JWKS at /.well-known/jwks.json.
  const cardSigner = envBool('GOTONG_A2A_SIGN_CARD', false)
    ? new FileAgentCardSigner(join(space.root, 'agent-card-signing.key'))
    : null
  if (cardSigner) log.info('agent-card: signing on', { alg: 'ES256', kid: cardSigner.kid() })
  const agentCard = createAgentCardSurface({
    // NET-M4 — owner curation file beats env enumeration; read per request so
    // edits go live without a restart. Absent file = legacy behavior unchanged.
    curationFile: join(space.root, 'agent-card.json'),
    nameFallback: cardMeta.name || cardMeta.hubId || 'Gotong',
    version: BAKED_VERSION,
    description: cardMeta.description,
    hasPeerRegistry: !!peerRegistry,
    advertiseSkills,
    enumerateSkills: () =>
      buildLocalManifest(
        hub,
        selfHubIdForCard,
        new Set((peerRegistry?.status() ?? []).map((r) => r.peerId)),
      ).capabilities.map((cap) => ({ id: cap.id, name: cap.id })),
    signer: cardSigner,
    log,
  })

  // #2-M2 — hub MCP server registry surface: persist to the Space +
  // propagate live into running opted-in agents via LocalAgentPool.
  const mcpRegistry = {
    list: () => space.mcpServers(),
    install: async (spec: McpServerSpec, description?: string, shared?: boolean) => {
      // `shared` is tri-state: include it (even `false`) only when the
      // caller specified it, so a plain re-install (changing a command,
      // toggling nothing) preserves the stored federation flag.
      const stored = await space.upsertMcpServer({
        spec,
        ...(description ? { description } : {}),
        ...(shared !== undefined ? { shared } : {}),
      })
      await localAgents.installMcpServer(stored)
      return stored
    },
    uninstall: async (name: string) => {
      const removed = await space.removeMcpServer(name)
      if (removed) await localAgents.uninstallMcpServer(name)
      return removed
    },
  }

  // Phase 16 — member task inbox. A workflow's `human:` step dispatches to the
  // `gotong.human/v1` capability; the broker parks it as an inbox item and
  // suspends (Phase 11). A member resolves it from /me, and HostInboxService
  // runs the two-step resume (child broker → parent workflow run). Gated on
  // identity: durable parking lives in suspended_tasks + /me needs a v4 user —
  // so without identity there is no inbox. The store was built earlier (Phase 18
  // approval gate shares it). Butler push-back ref (S1-M3): the IM bridges that
  // expose `pushToMember` start ~500 lines below, so forward-declare it — the
  // resolve hook reads it lazily, assigned after `startImBridges` returns.
  let butlerPushRef: ImBridgesHandle['pushToMember']

  let inboxService: HostInboxService | undefined
  if (identity && inboxStore) {
    hub.register(new HumanInboxParticipant({ store: inboxStore }))
    inboxService = new HostInboxService({
      hub,
      store: inboxStore,
      identity,
      logger: log,
      // S1-M3 — once a member resolves a butler governed-action approval, push the
      // butler's own closing message back to their IM. `butlerResolvePushback`
      // owns the discrimination (only `source:'butler'` items) + phrasing (the
      // resumed turn's ok text, for approve AND reject); a workflow human step
      // leaves `source` unset and returns null here, so it never pushes.
      onResolved: ({ item, childResult }) => {
        const text = butlerResolvePushback(item, childResult)
        if (text) void butlerPushRef?.(item.userId, text)
      },
    })
    log.info('member task inbox enabled', { capability: HUMAN_CAPABILITY })
  }
  butlerPendingInboxRef = inboxService // A1 — feed the /me pending inbox to the butler待办 card

  // S3-M1 — the resident butler's reminder broker. Registered on the SAME
  // butler-on gate as the `set_reminder` tool (a butler feature; disabling the
  // butler disables it coherently). It needs neither identity nor the inbox — it
  // parks a one-shot task with a FINITE resumeAt and the Phase 11 sweep fires it,
  // pushing the text to the member's IM via the F1 `pushToMember`. That ref is
  // assigned after the IM bridges start (~500 lines down), so the `push` closure
  // reads it LAZILY — a reminder set before the bridges are up still delivers once
  // they are, and one whose timer fires before any bridge exists logs a non-delivery
  // (best-effort). Fixed id so the sweep re-finds it across a restart.
  if (butlerDefaultOn) {
    hub.register(
      new ReminderParticipant({
        push: (userId, msg) =>
          butlerPushRef
            ? butlerPushRef(userId, msg)
            : Promise.resolve({ delivered: false, reason: 'no_bridge' }),
        logger: log,
      }),
    )
  }

  // S3-M2 + BE-M5 + CARE-M3 + TN-M2 — arm the butler's background sweeps. Push is
  // the F1 `pushToMember` read LAZILY (bridges start later); posture per module.
  const butlerSweeps = armButlerSweeps({
    memoryRoot: butlerMemoryRoot,
    push: (userId, msg) =>
      butlerPushRef
        ? butlerPushRef(userId, msg)
        : Promise.resolve({ delivered: false, reason: 'no_bridge' }),
    logger: log,
    proactive: {
      on: butlerProactiveOn,
      intervalMs: butlerProactiveMs,
      buildProvider: () => localAgents.buildButlerProvider(),
      mcpReadTools: () => localAgents.butlerMcpReadToolset(), // B2 — connectors for enriched brief
    },
    runBroadcast: {
      on: butlerRunBroadcastOn,
      intervalMs: butlerRunBroadcastMs,
      runs: butlerObserveRunsRef,
    },
    // CARE-M3 — 巡检骑管家总开关,零新旋钮;health lazy getter(adminHealth 在下方才建,首 tick 前就位)。
    patrol: {
      on: butlerDefaultOn,
      intervalMs: BUTLER_PATROL_INTERVAL_MS,
      stateFile: join(space.root, 'butler', 'patrol-state.json'),
      health: () => patrolHealthRef,
      // CARE-M6 — 同 CARE-M2 那份断供状态文件;巡检读它,持续断供超阈值升级红牌
      // (恢复静默,交给 CARE-M2/M5 的即时「✅ 恢复了」)。
      outageFile: join(space.root, 'runtime', 'llm-outage.json'),
    },
    // TN-M2 — 卡壳任务提醒骑管家总开关;零 LLM 纯时间戳分诊,节律常量零新旋钮。
    taskNudge: { on: butlerDefaultOn },
    // AFR-M7 — 备份陈旧提醒(同意面镜像巡检=开了播报的 owner/admin 才收)。
    ...(butlerBackupOps ? { backupNudge: { on: butlerDefaultOn, ops: butlerBackupOps } } : {}),
  })
  let patrolHealthRef: AdminHealthSurface | undefined

  // LIFE-L1 乙案 — zero-LLM workflow schedules; default-on, no knob (missing intent file = free no-op).
  const workflowScheduleSweeper = new WorkflowScheduleSweeper(
    { spaceDir: space.root, workflows: workflowController, hub, logger: log })
  workflowScheduleSweeper.start()
  // LIFE-L1-M3 admin CRUD surface, shared: web routes + SEN-M4 阿同成员向投影同一实例。
  const workflowSchedules = createWorkflowScheduleAdminSurface(
    { spaceDir: space.root, sweeper: workflowScheduleSweeper, logger: log })
  butlerSchedulesRef = buildButlerScheduleSurface({ admin: workflowSchedules })

  // Phase 18 C-M4 + Route B P1-M11b — outbound A2A agents. Each stored entry
  // (identity `a2a_outbound_agents`) becomes a local Participant, so a normal
  // capability dispatch reaches out over A2A message/send (the mirror of the
  // inbound A2aServer below). The bearer is resolved from `process.env[tokenEnv]`
  // at registration time — never stored — so a row whose env var is unset is
  // kept but inactive (logged). The manager also lets the admin CRUD routes
  // push add/update/delete onto the running hub without a restart (M11c).
  let a2aOutbound: A2aOutboundManager | undefined
  if (identity) {
    // Item 2 (Y) — an outbound A2A agent flagged `requireApprovalOutbound` is
    // wrapped in an ApprovalGatedParticipant: each send parks for a /me approval
    // before it leaves the hub. The approver is the org owner, the same one the
    // ACP escalation and the Phase 18 mesh outbound gate use. A row that requires
    // approval but has no inbox/owner stays persisted-but-inactive (fail-closed).
    const a2aApprover = inboxStore ? findOwnerUserId(identity) : null
    a2aOutbound = new A2aOutboundManager({
      hub,
      source: identity,
      logger: log,
      // Item 2 — per-agent outbound quota window (mirrors GOTONG_PEER_LINK_QUOTA_WINDOW_MS).
      quotaWindowMs: envInt('GOTONG_A2A_OUTBOUND_QUOTA_WINDOW_MS', 60_000),
      ...(inboxStore && a2aApprover ? { approvalInbox: inboxStore, approver: a2aApprover } : {}),
    })
    a2aOutbound.registerAllFromStore()
    // Stream H — let the workflow controller's off-hub capability view see live
    // external A2A agents (lazy closure forward-declared above).
    a2aOutboundRef = a2aOutbound
  }

  // ACP-OUT-M2/M4 — OpenClaw-style outbound ACP agents. Each stored row
  // (identity `acp_outbound_agents`) becomes a local Participant that drives a
  // coding agent (Claude Code / Codex) over a long-lived ACP session: spawn once,
  // hold the session, dispatch many tasks. Unlike A2A there is no secret to
  // resolve — an ACP bridge rides the underlying agent's own login. The manager
  // also lets the admin CRUD routes push add/update/delete onto the running hub
  // without a restart. NOTE: ACP agents are LOCAL participants, not cross-hub
  // destinations, so they are NOT fed into the workflow off-hub capability view.
  let acpOutbound: AcpOutboundManager | undefined
  if (identity) {
    // ACP-HITL — when a member inbox + an owner exist, a destructive coding
    // action ESCALATES to a /me approval (the sink writes the item; resolve runs
    // the two-step recovery) instead of being denied inline. GOTONG_ACP_DANGER=deny
    // forces the old hard-deny for unattended hubs (no one to approve → a park
    // would wait forever). The approver is the org owner, mirroring the Phase 18
    // outbound cross-org approval gate.
    const forceDeny = process.env.GOTONG_ACP_DANGER === 'deny'
    const acpApprover = inboxStore && !forceDeny ? findOwnerUserId(identity) : null
    let escalateDanger = false
    if (inboxStore && acpApprover) {
      const store = inboxStore
      const approver = acpApprover
      acpEscalationSink = async (task, by, state) => {
        const item = acpApprovalItemFor(task, by, state, { approver })
        if (item) await store.write(item)
      }
      escalateDanger = true
      log.info('outbound ACP destructive actions escalate to /me approval', { approver })
    }
    acpOutbound = new AcpOutboundManager({
      hub,
      source: identity,
      logger: log,
      escalateDanger,
      // Item 2 — per-agent outbound quota window (mirrors GOTONG_PEER_LINK_QUOTA_WINDOW_MS).
      quotaWindowMs: envInt('GOTONG_ACP_OUTBOUND_QUOTA_WINDOW_MS', 60_000),
    })
    acpOutbound.registerAllFromStore()
  }

  // GO-LIVE GL-1 — outbound IM bridges (Telegram, …). OFF unless a bridge's
  // env is set, so an existing deployment is byte-for-byte unaffected. Telegram
  // long-polls (no public endpoint), which is exactly what lets a home box
  // behind NAT run a hub with zero tunnelling — the IM cloud is the public
  // relay. Members link their IM identity by DMing the bot `/bind <code>` with a
  // code issued in the admin UI / 我的; every dispatch then carries the bound
  // `origin.userId`. Needs identity for the binding store.
  //
  // setting-ops M5 — the DECLARATION lives here (the `HostMeImService` closure
  // below reads it lazily), but the actual `startImBridges(...)` call is DEFERRED
  // to just before `serveWeb` so the IM `/setting` console can be wired with the
  // SAME live `adminHealth` surface the overview panel uses (built ~400 lines
  // down). Until then `imBridges` is `undefined`, exactly as before.
  let imBridges: ImBridgesHandle | undefined

  // Phase 18 C-M3 — inbound A2A message/send endpoint. OFF by default (it
  // exposes the hub to external A2A callers); enable with
  // GOTONG_A2A_INBOUND_ENABLED. Auth reuses the per-peer vault token via
  // buildPeerTokenResolver; GOTONG_A2A_INBOUND_CAPABILITY is the fallback
  // dispatch capability for messages without an explicit metadata.skill.
  let a2aServer: A2aServer | undefined
  if (identity && envBool('GOTONG_A2A_INBOUND_ENABLED', false)) {
    const a2aDefaultCap = env('GOTONG_A2A_INBOUND_CAPABILITY')
    const identityForA2a = identity
    a2aServer = new A2aServer({
      hub,
      resolvePeerToken: buildPeerTokenResolver(identity, (level, msg, c) =>
        log[level](msg, c as Record<string, unknown> | undefined),
      ),
      // Audit A2 — A2A is federation's second inbound door; give it the same
      // per-peer inbound ACL + quota the HubLink path enforces, or a peer
      // restricted to capability X could invoke anything over /a2a.
      resolvePeerAcl: (peerId) => identityForA2a.getPeerByPeerId(peerId)?.acl ?? null,
      ...(peerRegistry
        ? { inboundGate: peerRegistry.inboundGateForPeer.bind(peerRegistry) }
        : {}),
      ...(a2aDefaultCap ? { defaultCapability: a2aDefaultCap } : {}),
      logger: log,
    })
    log.info('inbound A2A server enabled', { defaultCapability: a2aDefaultCap ?? '(none)' })
  }

  // v5 A-M2 — member agent ownership + self-service CRUD. Ownership grants live
  // in identity, so this is wired only when identity is present; otherwise the
  // /api/me/agents CRUD routes 503 (the read-only directory still works).
  const meAgentAdmin = identity
    ? new HostMeAgentService({ space, hub, identity, lifecycle: localAgents })
    : undefined

  // BF-M7 — hand the butler its governed executors now the member services exist;
  // the butlerFactory closure reads these forward-refs LAZILY (per-user first task,
  // long after this line). `meWorkflowEdit` null (no workflowAssist) ⇒ no `edit_workflow`.
  butlerGovernedAgentsRef = meAgentAdmin
  // BE-M2 — same member-agent lister feeds the butler's benign "体检" tool the
  // member's OWNED agents (id + declared provider), scoped by userId (no-leak).
  butlerDiagnoseOwnedRef = meAgentAdmin
  // BE-M4 — and the "问我自己的助手" switchboard's no-leak roster (owned agents only).
  butlerAskRosterRef = meAgentAdmin
  butlerGovernedWorkflowEditorRef = meWorkflowEdit ?? undefined
  // BE-M3 — hand the butler the member 工作流架构师 so its governed create_workflow
  // gate can author. Null when there's no workflowAssist ⇒ the gate isn't composed
  // (main.ts's Option-B branch: agent verbs work, no workflow authoring/editing).
  butlerWorkflowCreateRef = meWorkflowCreate ?? undefined

  // v5 A-M3 — member API-credential ("bring your own key") management. Keys
  // live in the vault, so this is wired only when identity is present; the
  // /api/me/credentials routes 503 otherwise.
  const meCredentials = identity
    ? new HostMeCredentialsService({ identity })
    : undefined

  // Personal Butler M6c — the member's "what does my butler remember about me"
  // privacy view (read profile + recent captures, forget one/all, export). It's
  // read-only over the framework — needs only a per-user memory rootDir, NOT a
  // registered butler agent — so it's ALWAYS wired (the butler agent fold-in is
  // deferred per design §八; until then the view simply reads an empty tree).
  // The rootDir is the SAME subtree a folded-in butler will read/write per user,
  // so "what the butler remembers" and "what the member can erase" are one and
  // the same bytes. The per-user namespace (openButlerMemory) is the no-leak
  // boundary — the route forces the session userId, never a client value.
  const butlerMemory = new HostButlerMemoryService({
    rootDir: join(space.root, 'butler', 'memory'),
    logger: log,
  })
  // S2-M1 — hand the same service to the butler factory's "你记得我什么" tool.
  butlerMemoryViewRef = butlerMemory

  // GO-LIVE GL-1c — member IM-account linking. The binding code a member mints
  // here is what they DM to the bot as `/bind <code>`; bindings live in
  // identity, so this is wired only when identity is present (/api/me/im 503s
  // otherwise). `isEnabled` is a live read of the bridge handle declared above
  // — the panel hides "connect" when no bridge is running so a member isn't
  // handed a code nothing can consume.
  // DEPLOY-B1: the handle now exists even with zero running bridges (hot-start
  // seam), so "enabled" must count LIVE bridges, not handle presence — a member
  // is never handed a bind code nothing can consume, and the panel flips on by
  // itself the moment the wizard hot-starts a bridge.
  const meIm = identity
    ? new HostMeImService({ identity, isEnabled: () => (imBridges?.bridges.length ?? 0) > 0 })
    : undefined

  // v5 A-M4 — member agent access-grant sharing (an owner shares their agent
  // with other principals). Grants live in identity's resource_grants table, so
  // this is wired only when identity is present; /api/me/agents/:id/grants 503s
  // otherwise.
  const meAgentGrants = identity
    ? new HostMeAgentGrantsService({ identity })
    : undefined

  // SW (hub-steward, 管家) — the OpenClaw-style steward. A member types plain
  // language in the /me SPA; the steward PROPOSES a structured action, the host
  // re-classifies it server-side (the client tier is never trusted), and runs it
  // through the SAME member services (HostMeAgentService + MeWorkflowEditService),
  // so RBAC + member limits + the cross-hub 出入口 lock are reused by construction.
  // DANGEROUS (delete_agent) + CROSS_HUB (cross-hub workflow edit) tiers route to
  // the Phase 16 inbox for the user's mandated second confirmation. Wired only
  // when the member agent service + the workflow editor + identity are all present
  // (and a steward LLM key resolves); absent any → null → /api/me/steward/* 503s.
  const stewardConfig = resolveStewardConfig()
  const hubSteward =
    stewardConfig && meAgentAdmin && meWorkflowEdit && identity
      ? (() => {
          // `identity` is a `let` (narrowing doesn't cross the closure) — capture
          // a const so the directory's grant check stays type-sound.
          const identityStore = identity
          // The steward's workflow snapshot: the member's editor-grantable
          // workflows, each flagged cross-hub from the SAME `crossHubSteps` the
          // WFEDIT editor + the admin "leaves your hub" preview use (no drift).
          const stewardWorkflows: StewardWorkflowDirectory = {
            async listForUser(userId) {
              const all = await workflowController.listAll()
              return all
                .filter((s) =>
                  identityStore.hasResourceGrant(
                    'workflow',
                    s.id,
                    userPrincipal(userId),
                    'editor',
                  ),
                )
                .map((s) => ({
                  id: s.id,
                  ...(s.name ? { name: s.name } : {}),
                  crossHub: (s.crossHubSteps?.length ?? 0) > 0,
                }))
            },
          }
          return createHubStewardService({
            hub,
            config: stewardConfig,
            agents: meAgentAdmin,
            workflows: stewardWorkflows,
            workflowEditor: meWorkflowEdit,
            // When present, DANGEROUS / CROSS_HUB tiers park at the approval
            // broker; absent (no inbox) they degrade to `needs_approval`.
            inbox: inboxStore,
            orgApiPool,
            logger: log,
          })
        })()
      : null

  // SW-M9 A-M7 — the OPERATOR-console steward (`/api/admin/steward/*`), the
  // site-wide twin of `hubSteward`. Same `createHubStewardService`, parameterized
  // with `OPERATOR_STEWARD_IDS` (disjoint agent / cap / broker ids, A-M1) + the
  // operator system prompt + a SITE-WIDE agent executor (`HostOperatorAgentService`)
  // + a grant-free workflow editor (`OperatorWorkflowEditService` — the cross-hub
  // 出入口 lock STILL holds) + an all-workflows directory. Those operator executors
  // are constructed ONLY here, so a member's chat input can never reach a site-wide
  // write — the privilege IS the injected dependency (A-M2 / A-M3), not a runtime
  // flag. DANGEROUS + CROSS_HUB tiers still park in the operator's OWN /me inbox
  // under the disjoint operator broker for the user's mandated second confirmation
  // (A-M6 gates the admin route on a server-resolved operator userId). Same wiring
  // conditions as the member steward — identity (owner grants + approval
  // persistence) + the assistant (YAML authoring).
  const operatorSteward =
    stewardConfig && identity && workflowAssist
      ? createHubStewardService({
          hub,
          config: stewardConfig,
          agents: new HostOperatorAgentService({
            space,
            lifecycle: localAgents,
            grants: identity,
            ...(reconcileHeartbeats ? { reconcileHeartbeats } : {}),
          }),
          workflows: operatorStewardWorkflowDirectory(workflowController),
          workflowEditor: new OperatorWorkflowEditService({
            workflows: workflowController,
            assist: workflowAssist,
            participants: () => hub.participants(),
            peerCapabilities: peerCapabilitiesView,
            crossHubMarkers,
          }),
          inbox: inboxStore,
          orgApiPool,
          logger: log,
          ids: OPERATOR_STEWARD_IDS,
          systemOverride: buildOperatorStewardSystemPrompt(),
          // B-M2 — this is the operator console: the four sensitive writes
          // (credentials / peer / security) tier as `dangerous` (always inbox)
          // instead of `forbidden`. The member steward above omits this flag.
          operator: true,
          // B-M3 — gate 2 of the double gate: the sensitive executors are
          // constructed ONLY here. The member steward never receives them, so
          // even a future mis-tier can't run a site-wide write there (the
          // privilege IS the injected dependency). `set_credential_ref` resolves
          // the secret from a host env var named by the action — the steward
          // chain never carries plaintext. `identity` is narrowed non-null by the
          // `&& identity &&` guard above (same as `grants: identity`).
          sensitive: new HostStewardSensitiveExecutors({ identity }),
        })
      : null

  // Route B P1-M4e — browser SSO via configured OIDC IdPs. Wired only when
  // identity is present (the provider registry + (issuer,sub)→user links + the
  // session it mints all live there). Absent → /api/auth/oidc/* degrades: the
  // provider list is empty and start/callback bounce to ?oidc_error=not_enabled.
  // The OidcClient does the real network discovery + JWKS + token exchange; the
  // surface only exposes the three things web needs (list, begin, complete) and
  // filters the provider list to enabled IdPs with no secret.
  let oidcLogin: OidcLoginSurface | undefined
  let oidcAdmin: OidcProviderAdminSurface | undefined
  if (identity) {
    const idForOidc = identity
    const oidcService = new OidcLoginService(idForOidc, new OidcClient())
    oidcLogin = {
      listProviders: () =>
        idForOidc
          .listOidcProviders()
          .filter((p) => p.enabled)
          .map((p) => ({ id: p.id, label: p.label, issuer: p.issuer })),
      begin: (providerId) => oidcService.begin(providerId),
      complete: (input) => oidcService.complete(input),
    }
    // Route B P1-M4f — provider registry CRUD (admin). Thin pass-through to the
    // identity OIDC facade; the store keeps the client_secret in the vault and
    // its public projection never carries it, so web only ever sees
    // `hasClientSecret`.
    oidcAdmin = {
      list: () => idForOidc.listOidcProviders(),
      add: (input) => idForOidc.addOidcProvider(input),
      update: (id, patch) => idForOidc.updateOidcProvider(id, patch),
      remove: (id) => idForOidc.removeOidcProvider(id),
    }
  }
  // C-M2-M3 — outbound OAuth connect surface. Same identity gate as OIDC.
  const oauthConnect = identity ? createOAuthConnectSurface(identity) : undefined
  // C-M2-M5a — outbound OAuth connector CRUD surface (admin). Vault-backed.
  const oauthConnectorAdmin = identity ? createOAuthConnectorAdminSurface(identity) : undefined
  // C-M2-M4b — keep connected oauth tokens fresh so a respawned toolset never
  // injects an expired bearer; inert w/o connectors, stopped in shutdown drain.
  const oauthRefresher = identity ? new OAuthTokenRefresher(identity, { logger: log }) : undefined
  oauthRefresher?.start()

  // Route B P1-M5e — browser SSO via configured SAML 2.0 IdPs. Wired only when
  // identity is present (the provider registry + (idpEntityId,NameID)→user links
  // + the session it mints all live there). Absent → /api/auth/saml/* degrades:
  // the provider list is empty and start/acs bounce to ?saml_error=not_enabled.
  //
  // The ACS URL must be a STABLE absolute URL the IdP can POST back to (it's
  // baked into the AuthnRequest and re-checked against the response Recipient),
  // so it can't be request-derived like the agent card. Source it from
  // GOTONG_PUBLIC_URL (the externally-reachable base, e.g. behind a proxy);
  // fall back to host:port for local dev. Production behind TLS MUST set it.
  let samlLogin: SamlLoginSurface | undefined
  let samlAdmin: SamlProviderAdminSurface | undefined
  if (identity) {
    const idForSaml = identity
    const publicBase = (env('GOTONG_PUBLIC_URL') ?? `http://${config.host}:${config.webPort}`).replace(/\/+$/, '')
    const samlAcsUrl = `${publicBase}/api/auth/saml/acs`
    const samlService = new SamlLoginService(idForSaml, { acsUrl: samlAcsUrl })
    samlLogin = {
      listProviders: () =>
        idForSaml
          .listSamlProviders()
          .filter((p) => p.enabled)
          .map((p) => ({ id: p.id, label: p.label })),
      begin: (providerId) => samlService.begin(providerId),
      complete: (input) => samlService.complete(input),
      metadata: (providerId) => {
        const p = idForSaml.getSamlProvider(providerId)
        if (!p) throw new SamlError('saml_provider_not_found', `no SAML provider ${providerId}`)
        return buildSpMetadata({ spEntityId: p.spEntityId, acsUrl: samlAcsUrl })
      },
    }
    // Route B P1-M5f — provider registry CRUD (admin). Thin pass-through to the
    // identity SAML facade. Unlike OIDC there is no secret: `idpCert` is a public
    // X.509 verification key, so the projection carries it in full (admins audit
    // which cert is pinned).
    samlAdmin = {
      list: () => idForSaml.listSamlProviders(),
      add: (input) => idForSaml.addSamlProvider(input),
      update: (id, patch) => idForSaml.updateSamlProvider(id, patch),
      remove: (id) => idForSaml.removeSamlProvider(id),
    }
  }

  // Route B P1-M11c — outbound A2A agent registry CRUD (admin). Joins identity's
  // a2a_outbound_agents facade with the A2aOutboundManager so each edit both
  // PERSISTS and takes effect on the running hub (refresh/remove), and the view
  // reports honest runtime liveness. `tokenEnv` is the env-var NAME, not the
  // bearer, so it rides the projection in full (an admin must know which var to
  // set); the secret itself never touches the DB or an HTTP body.
  let a2aAgentAdmin: A2aAgentAdminSurface | undefined
  if (identity && a2aOutbound) {
    const idForA2a = identity
    const mgr = a2aOutbound
    const toView = (a: A2aOutboundAgent, st: { active: boolean; reason?: string }): A2aAgentView => ({
      id: a.id,
      capabilities: a.capabilities,
      url: a.url,
      tokenEnv: a.tokenEnv,
      peerId: a.peerId,
      targetSkill: a.targetSkill,
      lifecycle: a.lifecycle, // Stream H2-OUT — null = blocking (legacy)
      // Item 2 (Z-M1) — outbound gate config; copy the readonly allowlist to a
      // mutable array for the view (null = allow all).
      allowedDataClasses: a.allowedDataClasses ? [...a.allowedDataClasses] : null,
      outboundQuotaBudget: a.outboundQuotaBudget,
      requireApprovalOutbound: a.requireApprovalOutbound,
      enabled: a.enabled,
      label: a.label,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      active: st.active,
      ...(st.reason ? { inactiveReason: st.reason } : {}),
    })
    a2aAgentAdmin = {
      list: () => idForA2a.listA2aAgents().map((a) => toView(a, mgr.statusOf(a.id))),
      add: (input) => {
        const a = idForA2a.addA2aAgent(input)
        return toView(a, mgr.refresh(a.id))
      },
      update: (id, patch) => {
        const a = idForA2a.updateA2aAgent(id, patch)
        return toView(a, mgr.refresh(id))
      },
      remove: (id) => {
        const ok = idForA2a.removeA2aAgent(id)
        if (ok) mgr.remove(id)
        return ok
      },
    }
  }

  // ACP-OUT-M4 — outbound ACP agent registry CRUD (admin). Joins identity's
  // acp_outbound_agents facade with the AcpOutboundManager so each edit both
  // PERSISTS and takes effect on the running hub (refresh/remove), and the view
  // reports honest runtime liveness. There is no secret of any kind: ACP rides
  // the agent's own login, so the whole record (command/args/cwd) rides the
  // projection — nothing ever needs hiding.
  let acpAgentAdmin: AcpAgentAdminSurface | undefined
  if (identity && acpOutbound) {
    const idForAcp = identity
    const mgr = acpOutbound
    const toView = (a: AcpOutboundAgent, st: { active: boolean; reason?: string }): AcpAgentView => ({
      id: a.id,
      capabilities: a.capabilities,
      command: a.command,
      args: a.args,
      cwd: a.cwd,
      // Item 2 (Z-M1) — outbound gate config (governance for a local coding
      // subprocess); copy the readonly allowlist to a mutable array (null = all).
      allowedDataClasses: a.allowedDataClasses ? [...a.allowedDataClasses] : null,
      outboundQuotaBudget: a.outboundQuotaBudget,
      enabled: a.enabled,
      label: a.label,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      active: st.active,
      ...(st.reason ? { inactiveReason: st.reason } : {}),
    })
    acpAgentAdmin = {
      list: () => idForAcp.listAcpAgents().map((a) => toView(a, mgr.statusOf(a.id))),
      add: (input) => {
        const a = idForAcp.addAcpAgent(input)
        return toView(a, mgr.refresh(a.id))
      },
      update: (id, patch) => {
        const a = idForAcp.updateAcpAgent(id, patch)
        return toView(a, mgr.refresh(id))
      },
      remove: (id) => {
        const ok = idForAcp.removeAcpAgent(id)
        if (ok) mgr.remove(id)
        return ok
      },
    }
  }

  // FDE-M1b/M3 — durable template-intent registries: the import route records
  // each installed pack's declared `requires.connectors[]` and `schedules[]`
  // here (via the web-injected sinks below); 体检 / 定时卡 read them back.
  // INTENT only, no personnel — fulfilment is computed live and enabling a
  // suggestion writes a REAL schedule row, so neither file can go stale.
  const connectorSlots = createConnectorSlotStore({ spaceDir: space.root })
  const scheduleSuggestions = createScheduleSuggestionStore({ spaceDir: space.root })

  // FDE-M2 — golden-run acceptance: recorded at template import, run from the
  // admin workflows page THROUGH the member gate as the calling admin, judged
  // zero-LLM by @gotong/evals checkStructure over the run's final output.
  const templateAcceptance = createTemplateAcceptanceService({
    spaceDir: space.root,
    workflows: workflowController,
    hub,
  })

  // ❷-M1 — the read-only "hub 体检" snapshot, lifted to a const so the
  // setting-ops console (below) can reuse the SAME live-health surface for its
  // `status` command. Static signals only; reuses the pool's key-resolution
  // chain so the panel never disagrees with whether an agent will start.
  const adminHealth = createAdminHealthService({
    listAgents: () => space.agents(),
    liveIds: () => new Set(hub.participants().map((p) => p.id)),
    resolvesKey: (id, provider) => localAgents.hasResolvableLlmKey(id, provider),
    listMcpServers: () => space.mcpServers(),
    spacePath: space.root,
    // EH-M1 — 配置进度 (工作流总/可跑 + run 总数) 喂面板「下一步建议」。listAll 含
    // 全状态草稿, list 只含可跑; countRuns 取 active 集。全只读, 零新机制。
    countWorkflows: async () => {
      const [all, live] = await Promise.all([
        workflowController.listAll(),
        workflowController.list(),
      ])
      return { total: all.length, published: live.length }
    },
    countRuns: async () => (await workflowController.countRuns()).total,
    // DEPLOY-B3 — live IM bridge rows for the settings page. `imBridges` is
    // assigned after this closure is built; the `?? []` keeps the boot window
    // honest ("no live bridge yet" is literally true then).
    imStatus: () => imBridges?.status() ?? [],
    // FDE-M1b — flatten the per-pack registry to the rows the 体检 wants;
    // fulfilment (filled) is admin-health's job, not the file's.
    listConnectorSlots: async () =>
      (await connectorSlots.list()).flatMap((p) =>
        p.connectors.map((c) => ({
          pack: p.pack,
          id: c.id,
          optional: c.optional,
          ...(c.hint !== undefined ? { hint: c.hint } : {}),
        })),
      ),
    // CARE-M7 — 断供当下事实上体检面板(同 CARE-M2/M6 那份 runtime/llm-outage.json;
    // 无阈值,面板要即时真相)。readOutageSnapshotFile 无缓存新读 + 损坏当空,不抛。
    readLlmOutage: () => readOutageSnapshotFile(join(space.root, 'runtime', 'llm-outage.json')),
    // MR-M3 — per-provider routing health (degraded fallback candidates), read
    // from the in-memory tracker the pool feeds. Pure, synchronous, never throws.
    routingHealth: () => routingHealth.snapshot(),
  })
  patrolHealthRef = adminHealth

  // RES-M1 — read-only resource inventory for the "resource adaptation" panel.
  // Deterministic + zero-LLM: env/vault EXISTENCE (never key values), bounded
  // localhost model-server probe, PATH existsSync for CLI agents, installed MCP.
  // `listVaultProviders` reuses the pool's non-decrypting provider list.
  const resourceInventory = createResourceInventoryService({
    env: process.env,
    ...(orgApiPool ? { listVaultProviders: () => orgApiPool!.listProviders() } : {}),
    listMcpServers: () => space.mcpServers(),
  })

  // RES-M2 — proposal engine over the RES-M1 inventory. Pure: turns "no key +
  // Ollama up" into a rewire proposal but enacts NOTHING (RES-M3 apply does,
  // on explicit human approval); same live inventory surface as the panel.
  const resourceAdaptation = createResourceAdaptationService({
    inventory: () => resourceInventory.inventory(),
    // Per-agent key probe (spawn's own chain) — inventory only sees provider-
    // level keys; a compat agent (per-agent key by design) would read keyless.
    resolvesKey: (id, provider) => localAgents.hasResolvableLlmKey(id, provider),
  })
  // BE-M2 — the SAME zero-LLM RES-M2 engine the admin 资源适配 panel uses now also
  // backs the resident butler's benign "体检" tool (read-only; enactable fixes go
  // through the existing governed edit_agent). Ref read lazily at butler-build time.
  butlerDiagnoseAdaptRef = resourceAdaptation

  // WIZ-M4 — 六段建流向导（确认→盘点→组装→衡量缺口→提议→校验闭环）。目录五源
  // 每次调用现聚合（participants / MCP 注册表 / RES 探测 / 画廊模板卡片 / 内置
  // 连接器），组装压既有 workflow:assist 面。assist 缺席 → null → 路由 503，与
  // 架构师同降级；缺口补法只提议、装模板走既有画廊安装（人批准），落盘走
  // createFromYaml 同闸。
  const workflowWizard = workflowAssist
    ? createWorkflowWizard({
        assist: workflowAssist,
        sources: {
          participants: () => hub.participants(),
          mcpServers: () => space.mcpServers(),
          inventory: () => resourceInventory.inventory(),
          templateCards: () => buildTemplateCatalog(),
          connectors: () => BUILTIN_MCP_CONNECTORS,
        },
        existingWorkflowIds: async () => (await workflowController.list()).map((w) => w.id),
      })
    : null
  // WIZ-M4c — hand the resident butler the same wizard for its benign
  // plan_workflow (proposal-only; saving stays in the governed create_workflow).
  // Ref read lazily at per-user butler-build time, long after this line.
  butlerWizardRef = workflowWizard ?? undefined

  // setting-ops M4 — the deterministic ops console surface (the WEB face of
  // ops-core). One host service, three surfaces (CLI / web / IM). It binds
  // ops-core's deps ONCE: the space root (env-knob + pricing files default off
  // it — `<space>/gotong.env`, `<space>/pricing.json`, the file the host
  // actually reads at boot), the live `adminHealth` surface for `status`, and
  // the IdentityStore as the config-write audit sink (absent → writes still land,
  // unaudited). The owner gate + destructive-offline chokepoint live in ops-core,
  // driven by the actor flag the web layer resolves.
  const settingOps = createSettingOpsService({
    spaceDir: space.root,
    env: process.env,
    health: adminHealth,
    ...(identity ? { audit: identity } : {}),
  })

  // setting-ops M5 — IM bridges start HERE (deferred): IM `/setting` 复用与 web 同一个 live adminHealth;装配块外迁 im-bridge-wiring.ts。
  if (identity) {
    imBridges = await armImBridgeWiring({
      hub,
      identity,
      log,
      spaceRoot: space.root,
      health: adminHealth,
      defaultLang: config.defaultLang,
      // VOICE-M3/ASR-M3 — opt-in 语音回复+收听;未配 undefined = 字节不变。
      ...(butlerVoice ? { voice: butlerVoice } : {}),
      ...(butlerHearing ? { hearing: butlerHearing } : {}),
      // IMA-M2 — /inbox /approve /deny:读走 InboxStore、写走 HostInboxService(既有权威)。
      ...(inboxStore && inboxService ? { approvals: { store: inboxStore, inbox: inboxService } } : {}),
      // CARE-M5 — 恢复探活骑 onboarding key check 只读活体链;lazy ref 兜未就绪;status==='ok' 才算真恢复。
      probeLiveness: async () => {
        const keyCheck = butlerOnboardingKeyCheckRef
        if (!keyCheck) return false
        try {
          return (await keyCheck()).status === 'ok'
        } catch {
          return false
        }
      },
    })
    // S1-M3 — now that the bridges are live, point the push-back ref at their
    // `pushToMember` (undefined when no reachable dir / no bridge). The inbox
    // resolve hook declared above reads this lazily on each resolve.
    butlerPushRef = imBridges?.pushToMember
  }

  const web = await serveWeb(hub, {
    host: config.host,
    port: config.webPort,
    cookieSecure: config.cookieSecure,
    lifecycle: localAgents,
    // ease-of-use ③-M1 — LLM-key probe for the template-import checklist (reuses the pool's spawn-time key resolution).
    llmKeyProbe: {
      resolvesKey: (id, provider) => localAgents.hasResolvableLlmKey(id, provider),
    },
    // MR-M5 — per-candidate manual 「测试路由」 probe (reuses the pool's spawn-time key→factory chain; breaker-isolated).
    routingProbe: localAgents,
    // FDE-M1b/M3 — durable sinks for template-declared connector slots and
    // schedule suggestions (recorded at import; absent → response-only).
    connectorSlots,
    scheduleSuggestions,
    // FDE-M2 — golden-run acceptance surface (record at import + list + run).
    templateAcceptance,
    // ease-of-use ❷-M1 — read-only "hub 体检" snapshot for the admin overview
    // panel (lifted to a const above so the setting-ops console reuses it).
    adminHealth,
    // RES-M1 — read-only adaptable-resource inventory (built above). Absent
    // surface → route 503s and the panel hides.
    resourceInventory,
    // RES-M2 — adaptation proposal engine over that inventory. Pure/read-only;
    // proposals are enacted only by RES-M3 apply on explicit human approval.
    resourceAdaptation,
    // WIZ-M4 — 建流向导（admin + /me 两组路由压同一个核）。null → 路由 503。
    ...(workflowWizard ? { workflowWizard } : {}),
    // setting-ops M4 — deterministic ops console (status / check / fix-dirs /
    // config + owner config-write). No destructive routes; ops-core's chokepoint
    // refuses cold-start / restore / rotate-master-key (CLI-only by physics).
    settingOps,
    workflowSchedules, // LIFE-L1-M3 CRUD + 试跑(构造在 sweeper 旁); dispatch stays on the sweeper.
    reconcileHeartbeats,
    mcpRegistry,
    mcpFederation,
    peerManifests: peerFederation,
    peerSummaries: peerSummaryFederation,
    workflows: workflowController,
    // v5 B-M3 — "who-can-access this agent" reader for the template export's
    // includePersonnel opt-in. Sourced from identity's resource_grants; absent
    // when identity is unwired, so includePersonnel fails closed (503).
    ...(identity
      ? {
          templatePersonnel: {
            ownersOfAgent: async (agentId: string) =>
              identity
                .listResourceGrants('agent', agentId)
                .map((g) => ({ principal: principalKey(g.principal), perm: g.perm })),
          },
        }
      : {}),
    // Phase 19 P1-M3 — sanitized agent directory for /api/me/agents. Project
    // the managed-agent roster to {id,label,capabilities,online}; the system
    // prompt / model / provider config / per-agent key never leave the host,
    // so a member's "my AI helpers" view can't read another agent's config.
    // BE-M1 — shared with the resident butler's `list_my_agents` eye (defined
    // once, above, next to the butler-observe wiring): ONE sanitized projection
    // so both surfaces stay leak-free together.
    meAgents: meAgentsSurface,
    // v5 A-M2 — member agent ownership + self-service CRUD (undefined → 503).
    ...(meAgentAdmin ? { meAgentAdmin } : {}),
    // v5 A-M4 — member agent access-grant sharing (undefined → 503).
    ...(meAgentGrants ? { meAgentGrants } : {}),
    // v5 A-M3 — member API-credential management (undefined → 503).
    ...(meCredentials ? { meCredentials } : {}),
    // Personal Butler M6c — member butler-memory privacy view (read profile +
    // recent, forget one/all, export). Always wired (read-only over a per-user
    // memory rootDir; no butler-agent dependency).
    butlerMemory,
    // GO-LIVE GL-1c — member IM-account linking (undefined → 503).
    ...(meIm ? { meIm } : {}),
    // Phase 16 — member task inbox; undefined when identity is unwired, in
    // which case /me/inbox degrades (empty list / 503).
    ...(inboxService ? { inbox: inboxService } : {}),
    // WFEDIT — member NL workflow editing; null when no assistant / identity, in
    // which case /api/me/workflows/:id/{editable,edit} return 503.
    ...(meWorkflowEdit ? { workflowEdit: meWorkflowEdit } : {}),
    // ARCH-M6 — member NL workflow AUTHORING ("工作流架构师") + explain; null when
    // no assistant / identity, in which case /api/me/workflows/create and
    // /api/me/workflows/:id/explain return 503.
    ...(meWorkflowCreate ? { workflowCreate: meWorkflowCreate } : {}),
    // SW (hub-steward) — the 管家 conversational surface; null when the member
    // agent service / workflow editor / identity / steward key is missing, in
    // which case /api/me/steward/{plan,apply} return 503.
    ...(hubSteward ? { hubSteward } : {}),
    // NA-M6b — quick-chat NDJSON typing preview; the sinks live on the pool.
    meChatStream: { register: (s) => localAgents.registerChatChunkSink(s), release: (k) => localAgents.releaseChatChunkSink(k) },
    // SW-M9 A-M7 — the OPERATOR-console steward (site-wide twin); null on the same
    // conditions, in which case /api/admin/steward/{plan,apply} return 503.
    ...(operatorSteward ? { operatorSteward } : {}),
    // Phase 13 M3 — null when no API key / disabled; web 503s
    // /api/admin/workflows/assist so the UI hides the AI-assistant button.
    ...(workflowAssist ? { workflowAssist } : {}),
    // ease-of-use ① — "test connection" probe; uses the key the caller types
    // (no host config). Powers the setup-wizard / agent-form 测试连接 buttons.
    llmKeyTest: createLlmKeyTestSurface(),
    // DEPLOY-B2 — the setup wizard's IM step hot-starts the bridge it just
    // wrote a token for, through the B1 seam. Reads `imBridges` lazily so
    // the closure works regardless of construction order; no handle (or no
    // seam) degrades to "saved; starts on next boot" inside the route.
    imHotStart: {
      start: async (platform) => {
        const startPlatform = imBridges?.startPlatform
        if (!startPlatform) return { ok: false as const, reason: 'not_wired' }
        const r = await startPlatform(platform)
        return r.ok
          ? { ok: true as const, source: r.source }
          : { ok: false as const, reason: r.reason, ...(r.detail ? { detail: r.detail } : {}) }
      },
    },
    // services may be undefined if bootstrap failed; serveWeb handles
    // that by responding 503 on the /api/admin/services/* routes.
    ...(services ? { services: services.asAdminSurface() } : {}),
    // Phase 9 M4 — multimodal file upload backing. `undefined` is
    // handled by /api/admin/uploads with a clean 503.
    ...(uploads ? { uploads } : {}),
    growthReports,
    // R3 — A2A Agent Card discovery (public /.well-known/agent-card.json).
    agentCard,
    // Phase 18 C-M3 — inbound A2A message/send (undefined → /a2a 404s).
    ...(a2aServer ? { a2aServer } : {}),
    // Route B P1-M4e — public OIDC login (undefined → /api/auth/oidc/* degrades).
    ...(oidcLogin ? { oidcLogin } : {}),
    // C-M2-M3 — outbound OAuth connect (undefined → /api/*/oauth/* degrades).
    ...(oauthConnect ? { oauthConnect } : {}),
    ...(oauthConnectorAdmin ? { oauthConnectorAdmin } : {}),
    // Route B P1-M5e — public SAML login (undefined → /api/auth/saml/* degrades).
    ...(samlLogin ? { samlLogin } : {}),
    // Route B P1-M4f — admin OIDC provider registry CRUD (undefined → 503).
    ...(oidcAdmin ? { oidcAdmin } : {}),
    // Route B P1-M5f — admin SAML provider registry CRUD (undefined → 503).
    ...(samlAdmin ? { samlAdmin } : {}),
    // Route B P1-M11c — admin outbound A2A agent registry CRUD (undefined → 503).
    ...(a2aAgentAdmin ? { a2aAgents: a2aAgentAdmin } : {}),
    // ACP-OUT-M4 — admin outbound ACP agent registry CRUD (undefined → 503).
    ...(acpAgentAdmin ? { acpAgents: acpAgentAdmin } : {}),
    // Route B P0-M7 — bearer token for the internal `/metrics` scrape route.
    // Lets Prometheus pull the same body as /api/admin/metrics without a
    // machine-admin token. Unset/empty (env() already maps '' → undefined) →
    // the route 404s (fail-closed: no anonymous metrics endpoint).
    ...(env('GOTONG_METRICS_TOKEN') ? { metricsToken: env('GOTONG_METRICS_TOKEN') } : {}),
    ...(allowedHosts ? { allowedHosts } : {}),
    adminLoginRateLimit: { max: adminRateMax, windowSec: adminRateSec },
    readinessGate: { isReady: () => bootReady },
    // v4 identity surface. When absent (identity bootstrap failed
    // above), /api/admin/identity/* returns 503.
    ...(identity ? { identity } : {}),
    // D1 — pass the peer registry through so admin /peers handlers
    // can invalidate the polling tick on every mutation.
    ...(peerRegistry ? { peerRegistry } : {}),
    // Phase 6 #1 — expose reputation snapshot to the admin UI.
    // Joins `hub.reputation.all()` with the peers table for labels
    // so the dashboard shows "Supplier (hub_xxx) — 0.72" instead of
    // bare hub IDs. Identity may be absent (bootstrap failure), in
    // which case we still expose reputation with label=null.
    reputation: {
      snapshot: () => {
        const reputations = hub.reputation.all()
        const labelsByPeer = new Map<string, string | null>()
        if (identity && typeof identity.listPeers === 'function') {
          try {
            for (const p of identity.listPeers()) {
              labelsByPeer.set(p.peerId, p.label)
            }
          } catch {
            // best-effort label join — empty labels are harmless
          }
        }
        return reputations.map((r) => ({
          peerHubId: r.peerHubId,
          score: r.score,
          sampleCount: r.sampleCount,
          lastUpdatedAt: r.lastUpdatedAt,
          label: labelsByPeer.get(r.peerHubId) ?? null,
        }))
      },
    },
  })

  // P6: recover from crashes — any run still marked 'running' on disk
  // is the trace of a previous host that died mid-flight. Continue
  // from the first incomplete step. Runs whose workflow is no longer
  // loaded get closed out as 'failed' so admin history stops claiming
  // they're still running.
  //
  // **Order matters.** Pre-3.1 this ran BEFORE serveWebSocket, so any
  // step whose participant was a remote agent got dispatched into an
  // empty registry and failed with `no_participant` — the remote
  // sidecar hadn't had a chance to reconnect yet because the WS port
  // was still closed. Now we wait until WS is listening + give the
  // grace window below for sidecars to re-HELLO before kicking off
  // the resume. Local agents (LocalAgentPool) are already started.
  const resumeGraceMs = envInt('GOTONG_WORKFLOW_RESUME_GRACE_MS', 2_000)
  resumeKickoffTimer = setTimeout(() => {
    workflowController.resumeRunningRuns().then((r) => {
      if (r.resumed > 0 || r.abandoned > 0) {
        log.info('workflow resume', {
          resumed: r.resumed,
          abandoned: r.abandoned,
        })
      }
    }).catch((err) => {
      log.error('workflow resume scan failed', { err })
    }).finally(() => {
      // Flip readiness regardless of resume outcome — partial / failed
      // resume is still a "running host"; readiness is about boot
      // completion, not workflow health. The admin UI's "run history"
      // tab is the right place to surface resume failures.
      bootReady = true
    })
  }, resumeGraceMs)
  // Don't let the grace timer keep the event loop alive past a graceful stop.
  resumeKickoffTimer.unref?.()

  // Armed BEFORE the ready banner: "ready" promises graceful shutdown, and a
  // SIGTERM racing the banner (the admin-link await yields) must find these.
  let shuttingDown = false
  const shutdown = async (sig: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutdown signal received — draining', { signal: sig })
    // Stop the peer registry FIRST — it owns outbound HubLinks that
    // need a clean close handshake before we yank the underlying ws
    // server out from under them.
    if (peerRegistry) {
      try { await peerRegistry.stop() } catch (err) { log.error('peer registry stop error', { err }) }
    }
    // Stop the IM poll loop early so no new IM-driven dispatch lands mid-
    // teardown. Telegram's long-poll may take up to its server timeout to
    // return; the bridge awaits the in-flight poll so an update is never
    // half-handled.
    if (imBridges) {
      try { await imBridges.stop() } catch (err) { log.error('im bridges stop error', { err }) }
    }
    if (mcpProxy) {
      try { await mcpProxy.close() } catch (err) { log.error('mcp proxy close error', { err }) }
    }
    try { await ws.close() } catch (err) { log.error('ws close error', { err }) }
    try { await web.close() } catch (err) { log.error('web close error', { err }) }
    try { await localAgents.stopAll() } catch (err) { log.error('local agents stop error', { err }) }
    if (sweeper) {
      try { await sweeper.stop() } catch (err) { log.error('sweeper stop error', { err }) }
    }
    if (butlerMaintenanceSweeper) {
      try { butlerMaintenanceSweeper.stop() } catch (err) { log.error('butler maintenance stop error', { err }) }
    }
    try { butlerSweeps.stop() } catch (err) { log.error('butler sweeps stop error', { err }) }
    try { workflowScheduleSweeper.stop() } catch (err) { log.error('workflow schedule stop error', { err }) }
    if (retentionSweeper) { try { retentionSweeper.stop() } catch (err) { log.error('retention sweeper stop error', { err }) } }
    if (oauthRefresher) { try { oauthRefresher.stop() } catch (err) { log.error('oauth refresh stop error', { err }) } }
    if (services) {
      try { await services.shutdownAll() } catch (err) { log.error('services shutdown error', { err }) }
    }
    if (identityCleanupTimer) {
      clearInterval(identityCleanupTimer)
      identityCleanupTimer = undefined
    }
    if (usageSweepTimer) {
      clearInterval(usageSweepTimer)
      usageSweepTimer = undefined
    }
    if (orgQuotaSweepTimer) {
      clearInterval(orgQuotaSweepTimer)
      orgQuotaSweepTimer = undefined
    }
    if (resumeSweepTimer) {
      clearInterval(resumeSweepTimer)
      resumeSweepTimer = undefined
    }
    if (alertSweepTimer) {
      clearInterval(alertSweepTimer)
      alertSweepTimer = undefined
    }
    if (resumeKickoffTimer) {
      clearTimeout(resumeKickoffTimer)
      resumeKickoffTimer = undefined
    }
    if (orgApiPool) {
      // Unhook the vault-mutation listener before identity goes away
      // (audit P3 — the pool's cache-flush closure must not outlive it).
      try { orgApiPool.dispose() } catch (err) { log.error('org api pool dispose error', { err }) }
    }
    if (identity) {
      try { identity.close() } catch (err) { log.error('identity close error', { err }) }
    }
    try { await hub.stop() } catch (err) { log.error('hub stop error', { err }) }
    log.info('stopped cleanly')
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })

  // Boot banner — intentionally plain stdout, NOT a log line. The
  // "First-run admin URL" appears once in a host's lifetime and must
  // stand out visually; folding it into the structured log stream
  // would bury it. Operational events below go through the logger.
  //
  // v3.4 (H20): the admin URL itself is NOT printed — it goes to
  // `<space>/runtime/admin-link.txt` (0o600). The banner only tells
  // the operator where to read it. This keeps the plaintext token
  // out of journalctl / docker logs / pm2 logs — log shippers that
  // capture stdout no longer see secret material.
  console.log(`\n=== Gotong host ready ===`)
  console.log(`Space     : ${SPACE_DIR}`)
  console.log(`Web       : ${web.url}`)
  console.log(`WebSocket : ${ws.url}`)
  console.log(`Gating    : ${config.gating}`)
  console.log(`CookieSec : ${config.cookieSecure ? 'on (HTTPS expected)' : 'off (HTTP / dev)'}`)
  // VALID-M3 — definitions at a glance: how many workflow files / agent rows
  // loaded, and a flag if any were skipped (details are in the warning banner
  // printed earlier in this boot).
  console.log(
    `Defns     : ${defns.workflows.ok} workflow(s)${defns.workflows.bad ? `, ${defns.workflows.bad} BAD` : ''}` +
      ` · ${defns.agents.ok} agent(s)${defns.agents.bad ? `, ${defns.agents.bad} BAD` : ''}` +
      `${defns.errors > 0 ? '  ⚠ see definition warnings above' : ''}`,
  )
  console.log(
    `HostCheck : ${
      allowedHosts
        ? allowedHosts.join(', ')
        : isLoopbackHost(config.host)
          ? 'disabled (loopback only is safe)'
          : 'DISABLED while network-exposed — GOTONG_ALLOW_INSECURE set (see boot warnings)'
    }`,
  )
  // PRO-M2 — deployment profile lens (presentation only): reorders/annotates
  // the entry surface, enables NO code path. Unset → nothing printed (byte-
  // identical); a set-but-unknown value → warned as a likely typo, ignored.
  const profile = resolveProfileEnv(process.env.GOTONG_PROFILE)
  if (profile.unrecognized) {
    log.warn('GOTONG_PROFILE not recognized — ignoring (expected hub|federation)', {
      value: profile.unrecognized,
    })
    console.warn(
      `  ⚠ GOTONG_PROFILE="${profile.unrecognized}" 无法识别,已忽略 (可选 hub|federation) / unrecognized, ignored.`,
    )
  }
  for (const line of profileBannerLines(profile)) console.log(line)

  // Friendly first-run nicety (presentation only): point a fresh local user
  // at the loopback setup wizard and optionally open their browser. Never
  // auto-opens when network-exposed (see shouldOpenBrowser). GOTONG_OPEN_BROWSER
  // controls it: auto (default, first run only) / always / never.
  const openMode = parseOpenBrowserEnv(process.env.GOTONG_OPEN_BROWSER)
  const loopbackHost = isLoopbackHost(config.host)
  const maybeOpenBrowser = (targetUrl: string, firstRun: boolean): void => {
    if (!shouldOpenBrowser(openMode, { loopback: loopbackHost, firstRun })) return
    const opened = openUrl(targetUrl, {
      onError: (err) => log.debug('browser auto-open failed', { err }),
    })
    console.log(
      opened
        ? `  (已自动打开浏览器 / browser opened — GOTONG_OPEN_BROWSER=0 关闭)`
        : `  (自动打开浏览器失败,请手动打开上面的地址)`,
    )
  }

  if (adminToken) {
    const linkPath = join(SPACE_DIR, 'runtime', 'admin-link.txt')
    const adminUrl = `${web.url}/admin?token=${adminToken}`
    try {
      await writeAdminLinkFile(linkPath, adminUrl)
      // The friendly path in: the setup wizard at the web root needs no
      // token (loopback bootstrap). Show it prominently and open it.
      console.log(firstRunSetupBanner(web.url))
      maybeOpenBrowser(web.url, true)
      // The admin-token URL is the backup / network-exposed path; keep it
      // in the 0o600 file (never stdout), just tell the operator where.
      console.log(`\n备用 admin token URL 已写入 (读后即焚) / backup admin link saved:`)
      console.log(`  ${linkPath}`)
      console.log(`  mode 0o600 — only the user running this host can read it.\n`)
    } catch (err) {
      // Falling back to stdout here would re-leak the token. Better
      // to fail loud: the operator can re-run `mint-admin-token` once
      // the underlying fs problem is fixed.
      log.fatal('failed to write admin link file', {
        path: linkPath,
        err,
      })
      console.error(
        `\nFATAL: could not write ${linkPath}.\n` +
          `       The first-run admin token is no longer recoverable from\n` +
          `       this run; re-init by removing the workspace and starting\n` +
          `       over, or use \`gotong-host mint-admin-token\` to create\n` +
          `       a fresh admin against the existing workspace once the\n` +
          `       underlying error is fixed.\n`,
      )
      process.exit(2)
    }
  } else {
    console.log(`Admin     : ${web.url}/admin    (existing cookie or token)\n`)
    // Only opens when GOTONG_OPEN_BROWSER=always (firstRun=false → 'auto' is a
    // no-op), so restarts don't spam the browser.
    maybeOpenBrowser(`${web.url}/admin`, false)
  }

  // Never resolve — the listeners keep us alive.
  await new Promise<never>(() => { /* never */ })
}

main().catch((err) => {
  // ease-of-use ⑥-M2 — turn the common, recoverable EADDRINUSE into an
  // actionable hint (which port var to change + `gotong doctor`) instead of a
  // structured-fatal dump. Everything else keeps the default observability path.
  const hint = friendlyBootError(err)
  if (hint) {
    process.stderr.write(hint + '\n')
  } else {
    log.fatal('boot failed', { err })
  }
  process.exit(1)
})
