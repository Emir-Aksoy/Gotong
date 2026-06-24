/**
 * Production AipeHub host binary.
 *
 * Reads its configuration from environment variables (12-factor style) so
 * the same image / build can be promoted from staging to production via
 * environment alone. No demo agent is registered; no test traffic is
 * generated. All state lives in the directory pointed at by AIPE_SPACE.
 *
 * Environment:
 *
 *   AIPE_SPACE              directory to open / init. Default `.aipehub`.
 *   AIPE_HOST               bind address (default 127.0.0.1 — pair with a
 *                           reverse proxy that terminates TLS).
 *   AIPE_WEB_PORT           default 3000.
 *   AIPE_WS_PORT            default 4000.
 *   AIPE_GATING             'open' | 'admin-approval' (default 'admin-approval')
 *   AIPE_COOKIE_SECURE      '1' to add the Secure + SameSite=Strict cookie
 *                           flags. Required behind HTTPS. Default '0'.
 *   AIPE_ALLOWED_HOSTS      Comma-separated list of host[:port] values
 *                           accepted on Host: and Origin: for state-changing
 *                           requests. Example "hub.example.com". Empty
 *                           disables the check (only safe on loopback).
 *   AIPE_ALLOW_INSECURE     '1' to downgrade the boot security self-check
 *                           (Route B P0-M6) from fail-closed to a warning.
 *                           Only for a network-exposed host whose reverse
 *                           proxy already validates Host and terminates TLS.
 *   AIPE_ADMIN_RATE_MAX     admin login attempts allowed per IP per window
 *                           (default 10; 0 disables).
 *   AIPE_ADMIN_RATE_SEC     window for the rate limit in seconds (default 60).
 *   AIPE_DEFAULT_LANG       'zh' | 'en' (default 'zh')
 *   AIPE_HEARTBEAT_MS       transport heartbeat interval (default 30000)
 *   AIPE_SPACE_NAME         label written into space.json on first init
 *   AIPE_ADMIN_DISPLAY_NAME first admin's display name (default 'Operator')
 *   AIPE_WORKFLOWS_DIR      directory of workflow YAML/JSON files to
 *                           auto-load on boot. Default
 *                           `<AIPE_SPACE>/workflows/definitions`. Each
 *                           parseable file becomes a registered
 *                           `WorkflowRunner` participant; failed files
 *                           are logged and skipped.
 *
 *   --- transcript retention (Route B P0-M2; OFF by default) ---
 *
 *   AIPE_TRANSCRIPT_KEEP_SEGMENTS  keep this many newest sealed transcript
 *                           segments in the boot load path; archive older
 *                           ones into `<AIPE_SPACE>/archive/`. Bounds boot
 *                           load to O(tail). Unset ⇒ no archiving.
 *   AIPE_TRANSCRIPT_ARCHIVE_DAYS   archive sealed segments whose newest
 *                           entry is older than this many days. May be
 *                           combined with KEEP_SEGMENTS (both must hold).
 *                           Archived bytes stay on disk for audit/export;
 *                           a malformed value fails the boot loudly.
 *   AIPE_RUN_KEEP           keep this many newest TERMINAL workflow runs on
 *                           the active scan path; archive older ones into
 *                           `workflows/runs/archive/`. Bounds boot-resume /
 *                           run-history / metrics scans to O(tail). A
 *                           `running` run is never archived. Unset ⇒ off.
 *   AIPE_RUN_ARCHIVE_DAYS   archive terminal runs that ended more than this
 *                           many days ago. May be combined with AIPE_RUN_KEEP
 *                           (both must hold). Archived runs stay reachable for
 *                           audit; a malformed value fails the boot loudly.
 *   AIPE_LEDGER_KEEP_DAYS   prune usage-ledger (billing) rows older than this
 *                           many days at boot, bounding the append-only ledger.
 *                           The retained window stays exportable (Phase 17
 *                           CSV/JSONL). Unset ⇒ off; a malformed value fails
 *                           the boot loudly. Sibling knobs with the same
 *                           semantics for the other append-only tables:
 *   AIPE_AUDIT_KEEP_DAYS            audit_log
 *   AIPE_PEER_SUMMARY_KEEP_DAYS     peer_summary_snapshots (trend history)
 *   AIPE_ALERT_FIRINGS_KEEP_DAYS    peer_summary_alert_firings (resolved only;
 *                                   open firings are never pruned)
 *
 *   --- structured logging (default ON, see @aipehub/core/logger) ---
 *
 *   AIPE_LOG_LEVEL          'silent' | 'trace' | 'debug' | 'info' | 'warn'
 *                           | 'error' | 'fatal'  (default 'info')
 *   AIPE_LOG_FORMAT         'json' | 'pretty'  (default: 'pretty' when
 *                           stdout is a TTY, else 'json' for machine
 *                           consumption / log shippers)
 *   AIPE_LOG_DISABLED       '1' to suppress all log output. Takes
 *                           precedence over LEVEL and FORMAT.
 *
 * On first launch the space dir is created and a one-time admin URL is
 * written to `<AIPE_SPACE>/runtime/admin-link.txt` (mode 0o600). The
 * boot banner on stdout tells the operator where to read it. Writing
 * the URL to a file — instead of `console.log`-ing it — keeps the
 * plaintext token out of `journalctl`, `docker logs`, `pm2 logs`, and
 * any other log shipper that captures process stdout. Anyone who can
 * read the workspace directory can already mint a fresh admin via
 * `aipehub-host mint-admin-token`; this just removes the easy log-mining
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

import { Hub, Space, createLogger, type Logger, type McpServerSpec, type Participant, type RemoteHubViaLink, type SpaceConfig, type Task, type TranscriptEntry } from '@aipehub/core'
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
} from '@aipehub/identity'

import { OrgApiPool } from './org-api-pool.js'

import { BAKED_VERSION } from './version.js'
import { buildAgentCard } from './agent-card.js'
import { auditBootSecurity, formatBootSecurityReport, isLoopbackHost } from './boot-security.js'
import {
  firstRunSetupBanner,
  openUrl,
  parseOpenBrowserEnv,
  shouldOpenBrowser,
} from './first-run-banner.js'
import { rotateMasterKey } from './rotate-master-key.js'
import { applyRetentionPolicies, parseRetentionPolicies } from './retention.js'
import { recoverMasterKeyRotation } from './master-key-recovery.js'
import { applyRunRetention, parseRunRetention } from './run-retention.js'
import { applyTranscriptRetention, parseTranscriptRetention } from './transcript-retention.js'
import { writeAdminLinkFile } from './admin-link.js'
import { friendlyBootError } from './boot-error.js'

const log = createLogger('host')
import { serveWebSocket } from '@aipehub/transport-ws'
import { PeerRegistry, buildPeerTokenResolver } from './peer-registry.js'
import { A2aServer } from './a2a-server.js'
import { A2aOutboundManager } from './a2a-outbound.js'
import { AcpOutboundManager } from './acp-outbound.js'
import { acpApprovalItemFor } from './acp-escalation.js'
import { startImBridges, type ImBridgesHandle } from './im-bridge.js'
import { OidcClient } from './oidc-client.js'
import { OidcLoginService } from './oidc-login-service.js'
import { SamlLoginService } from './saml-login-service.js'
import { buildSpMetadata, SamlError } from '@aipehub/saml'
import {
  serveWeb,
  type WebServerOptions,
  type OidcLoginSurface,
  type OidcProviderAdminSurface,
  type SamlLoginSurface,
  type SamlProviderAdminSurface,
  type A2aAgentAdminSurface,
  type A2aAgentView,
  type AcpAgentAdminSurface,
  type AcpAgentView,
} from '@aipehub/web'

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

// Route B P1-M11b — outbound A2A agents moved from the `AIPE_A2A_AGENTS` env
// blob to identity-backed config (`a2a_outbound_agents`, M11a) materialised by
// `A2aOutboundManager`. Same source-of-truth model as peers / OIDC / SAML
// (store + admin API, no env), so they persist and are admin-editable. The
// registration block lives in main() where identity is in scope.

import { createAdminHealthService } from './admin-health.js'
import { LocalAgentPool } from './local-agent-pool.js'
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
import { HostInboxService } from './inbox-service.js'
import { FileCrossHubMarkerStore } from './cross-hub-marker.js'
import { MeWorkflowEditService } from './me-workflow-edit-service.js'
import { MeWorkflowCreateService } from './me-workflow-create-service.js'
import { HostMeAgentService } from './me-agent-service.js'
import { HostMeAgentGrantsService } from './me-agent-grants-service.js'
import { HostMeCredentialsService } from './me-credentials-service.js'
import { HostMeImService } from './me-im-service.js'
import { ApprovalGatedParticipant } from './outbound-approval.js'
import {
  DEFAULT_HEARTBEAT_MIN_MS,
  HEARTBEAT_BROKER_ID,
  HeartbeatParticipant,
  HeartbeatScheduler,
  buildHeartbeatPayload,
  classifyHeartbeatResult,
  type HeartbeatAgentConfig,
} from './heartbeat.js'
import { FileInboxStore, HumanInboxParticipant, HUMAN_CAPABILITY } from '@aipehub/inbox'
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
} from './hub-steward-service.js'
import { HostOperatorAgentService } from './operator-agent-service.js'
import { OperatorWorkflowEditService } from './operator-workflow-edit-service.js'
import { operatorStewardWorkflowDirectory } from './operator-workflow-directory.js'
import { HostStewardSensitiveExecutors } from './steward-sensitive.js'
import { buildOperatorStewardSystemPrompt } from '@aipehub/hub-steward'

// CLI flags handled before any work — keep these cheap and side-effect free
// so `npx @aipehub/host --help` exits in milliseconds without trying to
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

// Subcommand: `aipehub-host mint-admin-token [displayName]`
// Mints a fresh admin against the AIPE_SPACE workspace WITHOUT starting
// the Hub / listeners. Use when the first-run admin URL got lost
// (window closed, .command script went away, scrollback gone). Reads
// AIPE_SPACE / AIPE_HOST / AIPE_WEB_PORT / AIPE_COOKIE_SECURE from the
// environment so the printed URL matches your deployment.
if (ARGV[0] === 'mint-admin-token') {
  await mintAdminTokenCmd(ARGV[1])
  process.exit(0)
}

// Subcommand: `aipehub-host rotate-master-key` (Route B P0-M4d)
// Rotates the identity vault master key (KEK) without starting the Hub.
// Envelope encryption (M4b) makes this O(1): the single data key is
// re-wrapped under a freshly generated key, secret rows are untouched.
// local-file provider only — env/kms keys are rotated out of band.
if (ARGV[0] === 'rotate-master-key') {
  rotateMasterKeyCmd()
  process.exit(0)
}

function pkgVersion(): string {
  // Prefer reading from disk so an in-place upgrade (`npm install -g
  // @aipehub/host@new` without restarting tsc) reflects in --version.
  // Fall through to BAKED_VERSION when the disk read fails — in the
  // bun --compile single-file binary, package.json isn't on the
  // embedded /$bunfs/ virtual filesystem, so readFileSync throws
  // ENOENT and the baked constant kicks in.
  try {
    const url = new URL('../package.json', import.meta.url)
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string }
    return pkg.version ?? BAKED_VERSION
  } catch {
    return BAKED_VERSION
  }
}

/**
 * `aipehub-host mint-admin-token [displayName]` — emergency recovery
 * when the first-run admin URL was lost. Reads AIPE_SPACE from the env
 * exactly like the main path so the same `.aipehub` directory is
 * reached. Does NOT start the Hub or open any listeners; only creates
 * a new admin row in admins.json and prints the URL (token shown
 * exactly once, matching createAdmin's contract).
 *
 * The printed URL uses AIPE_HOST + AIPE_WEB_PORT + AIPE_COOKIE_SECURE
 * so what gets printed actually points at where the running host
 * would serve. Behind a reverse proxy you'll have to substitute the
 * external hostname yourself — same caveat as the first-run print.
 */
async function mintAdminTokenCmd(displayNameArg: string | undefined): Promise<void> {
  const dir = env('AIPE_SPACE', '.aipehub')!
  const displayName = displayNameArg && displayNameArg.length > 0
    ? displayNameArg
    : env('AIPE_ADMIN_DISPLAY_NAME', 'Recovered Operator')!

  let space: Space
  try {
    space = await Space.open(dir)
  } catch (err) {
    process.stderr.write(
      `error: could not open space '${dir}': ${
        err instanceof Error ? err.message : String(err)
      }\n` +
        `hint: AIPE_SPACE must point at an already-initialised workspace.\n` +
        `      Run \`aipehub-host\` (or your launcher) once to create it first.\n`,
    )
    process.exit(2)
  }

  const { admin, token } = await space.createAdmin(displayName)

  const host = env('AIPE_HOST', '127.0.0.1')!
  const port = envInt('AIPE_WEB_PORT', 3000)
  const proto = envBool('AIPE_COOKIE_SECURE', false) ? 'https' : 'http'
  const adminUrl = `${proto}://${host}:${port}/admin?token=${token}`

  // Write the URL to runtime/admin-link.txt (0o600) instead of stdout.
  // Same H20 rationale as the first-run path in main(): the token is
  // secret-grade, log shippers should never see it.
  const linkPath = join(dir, 'runtime', 'admin-link.txt')
  await writeAdminLinkFile(linkPath, adminUrl)

  process.stdout.write(
    `\n` +
      `  New admin '${admin.displayName}' (${admin.id}) added to ${dir}/admins.json.\n` +
      `\n` +
      `  Admin URL saved to (mode 0o600 — read once and delete):\n` +
      `    ${linkPath}\n` +
      `\n` +
      `  Open the URL inside that file once; the cookie that gets set is\n` +
      `  what subsequent logins use. The token itself is hashed in\n` +
      `  admins.json — there is no way to recover the plaintext from\n` +
      `  disk after the link file is removed. Behind a reverse proxy:\n` +
      `  substitute your public hostname for '${host}:${port}' when you\n` +
      `  open the URL.\n\n`,
  )
}

/**
 * `aipehub-host rotate-master-key` (Route B P0-M4d) — rotate the identity
 * vault master key (KEK) for a local-file workspace without starting the Hub.
 *
 * Reads AIPE_SPACE / AIPE_MASTER_KEY_PROVIDER / AIPE_MASTER_KEY exactly like the
 * boot path, so it loads the SAME current key, then generates a fresh random
 * key, re-wraps the data key in the DB under it (O(1) — secret rows untouched,
 * M4b/M4c), and persists the new key to `<space>/identity-master.key`. The new
 * key is NEVER printed (it's secret-grade; an attacker reading logs must not get
 * it). A running host keeps serving on its cached data key; the new KEK takes
 * effect on the next restart — that is the no-downtime property.
 *
 * Exits 2 on any failure (wrong provider, missing/wrong-length key, db open),
 * and because the orchestration fails before it mutates, a failed run never
 * half-rotates.
 */
function rotateMasterKeyCmd(): void {
  const dir = env('AIPE_SPACE', '.aipehub')!
  let result: { keyFilePath: string }
  try {
    result = rotateMasterKey({
      spaceDir: dir,
      providerKind: env('AIPE_MASTER_KEY_PROVIDER'),
      envKeyMaterial: env('AIPE_MASTER_KEY'),
      envKeyEncoding: 'hex',
    })
  } catch (err) {
    process.stderr.write(
      `error: master key rotation failed: ${
        err instanceof Error ? err.message : String(err)
      }\n` +
        `hint: AIPE_SPACE must point at an initialised workspace whose current\n` +
        `      key still loads; rotation only supports the local-file provider.\n`,
    )
    process.exit(2)
  }

  process.stdout.write(
    `\n` +
      `  Vault master key rotated for ${dir}.\n` +
      `  New key written to (mode 0o600): ${result.keyFilePath}\n` +
      `\n` +
      `  The data key was re-wrapped in place — existing secrets were NOT\n` +
      `  re-encrypted, and the OLD master key no longer opens this vault.\n` +
      `  A running host keeps serving on its cached key; restart it to adopt\n` +
      `  the new key. Back up the new key file with the same care as the db.\n\n`,
  )
}

function printUsage(): void {
  process.stdout.write(`Usage:
  aipehub-host                            run the host (env-driven)
  aipehub-host mint-admin-token [name]    add a fresh admin (recovery)
  aipehub-host rotate-master-key          rotate the vault master key (KEK)
  aipehub-host --version | -V             print version + exit
  aipehub-host --help    | -h             this message + exit

Production AipeHub host. Reads all configuration from environment
variables (12-factor style). No CLI flags drive runtime behavior — set
the env, run the command. The same binary works for local dev, LAN
deployments, and public VPS behind Caddy / nginx.

SUBCOMMANDS

  mint-admin-token [displayName]
      Recover when the first-run admin URL got lost (.command window
      closed, scrollback gone, etc). Opens AIPE_SPACE without starting
      any listeners, creates a fresh admin in admins.json, prints the
      one-time login URL, and exits. Existing admins are unaffected.
      Default displayName: AIPE_ADMIN_DISPLAY_NAME, else 'Recovered Operator'.
      Exits with status 2 if AIPE_SPACE does not point at an
      initialised workspace.

  rotate-master-key
      Rotate the identity vault master key (KEK) without starting the
      Hub. Loads the current key (AIPE_MASTER_KEY_PROVIDER / AIPE_MASTER_KEY),
      generates a fresh random key, re-wraps the data key under it in O(1)
      (secrets are NOT re-encrypted), and writes the new key to
      <AIPE_SPACE>/identity-master.key (mode 0600, never printed). The OLD
      key stops working; a running host adopts the new key on next restart.
      local-file provider only — env / kms keys are rotated out of band.
      Exits with status 2 on failure (never half-rotates).

ENVIRONMENT
  AIPE_SPACE              workspace directory (default: .aipehub)
  AIPE_HOST               bind address (default: 127.0.0.1)
  AIPE_WEB_PORT           HTTP port (default: 3000)
  AIPE_WS_PORT            WebSocket port for remote agents (default: 4000)
  AIPE_GATING             'open' | 'admin-approval' (default: admin-approval)
  AIPE_COOKIE_SECURE      '1' to set Secure + SameSite=Strict (default: 0)
  AIPE_ALLOWED_HOSTS      comma list — enforce Host: / Origin: on state-changing requests
  AIPE_ALLOW_INSECURE     '1' to downgrade the exposed-host boot self-check to a warning
  AIPE_ADMIN_RATE_MAX     admin login attempts per IP per window (default: 10)
  AIPE_ADMIN_RATE_SEC     rate-limit window in seconds (default: 60)
  AIPE_DEFAULT_LANG       'zh' | 'en' (default: zh)
  AIPE_HEARTBEAT_MS       transport heartbeat ms (default: 30000)
  AIPE_SPACE_NAME         label for space.json on first init (default: AipeHub)
  AIPE_ADMIN_DISPLAY_NAME first admin's display name (default: Operator)
  AIPE_WORKFLOWS_DIR      directory of *.yaml/*.json workflow files to
                          auto-load on boot
                          (default: <AIPE_SPACE>/workflows/definitions)

  AIPE_TRANSCRIPT_KEEP_SEGMENTS  keep N newest sealed transcript segments in
                          the boot load path; archive older into archive/
                          (bounds boot load to O(tail); unset = no archiving)
  AIPE_TRANSCRIPT_ARCHIVE_DAYS   archive sealed segments older than N days
                          (may combine with KEEP_SEGMENTS; archived bytes
                          stay on disk for audit; malformed value fails boot)
  AIPE_RUN_KEEP           keep N newest TERMINAL workflow runs on the active
                          scan path; archive older into runs/archive/ (bounds
                          boot-resume/history/metrics to O(tail); running runs
                          never archived; unset = off)
  AIPE_RUN_ARCHIVE_DAYS   archive terminal runs that ended more than N days ago
                          (may combine with AIPE_RUN_KEEP; archived runs stay
                          reachable for audit; malformed value fails boot)
  AIPE_LEDGER_KEEP_DAYS   prune usage-ledger (billing) rows older than N days at
                          boot (retained window stays exportable; unset = off;
                          malformed value fails boot). Sibling knobs, same
                          semantics: AIPE_AUDIT_KEEP_DAYS (audit_log),
                          AIPE_PEER_SUMMARY_KEEP_DAYS (peer_summary_snapshots),
                          AIPE_ALERT_FIRINGS_KEEP_DAYS (resolved alert firings;
                          open firings are never pruned)

  AIPE_ASSISTANT_PROVIDER 'anthropic' (default) | 'openai' | 'mock' —
                          provider for the host-built-in WorkflowAssistantAgent
                          (Phase 13 M3). Skip registration when no key
                          available; admin UI's AI button hides via 503.
  AIPE_ASSISTANT_MODEL    optional provider-specific model id for the assistant
  AIPE_ASSISTANT_MAX_TOKENS  integer cap on assist response tokens (default 4096)
  AIPE_ASSISTANT_DISABLED '1' | 'true' → don't register the assistant at all

  AIPE_SECRET_KEY         optional master key for the workspace secrets file
                          (64 hex chars; overrides on-disk runtime/secret.key)
  AIPE_MASTER_KEY_PROVIDER  identity vault master key source:
                          'local-file' (default, <AIPE_SPACE>/identity-master.key)
                          | 'env' (inject via AIPE_MASTER_KEY, no disk)
                          | 'kms-stub' (reserved seam, fails closed)
  AIPE_MASTER_KEY         identity vault master key as 64 hex chars; required
                          when AIPE_MASTER_KEY_PROVIDER=env
  ANTHROPIC_API_KEY       fallback Anthropic key for managed LLM agents
  OPENAI_API_KEY          fallback OpenAI key for managed LLM agents

EXAMPLES
  # Local one-liner (creates ./.aipehub on first run, prints admin URL)
  npx @aipehub/host

  # Custom workspace and ports
  AIPE_SPACE=/srv/aipehub AIPE_WEB_PORT=3030 npx @aipehub/host

  # Public deployment behind a TLS-terminating reverse proxy
  AIPE_HOST=127.0.0.1 \\
  AIPE_COOKIE_SECURE=1 \\
  AIPE_ALLOWED_HOSTS=hub.example.com,hub-ws.example.com \\
  npx @aipehub/host

DOCS
  https://github.com/Emir-Aksoy/AipeHub/blob/main/docs/OVERVIEW.md
  https://github.com/Emir-Aksoy/AipeHub/blob/main/docs/DEPLOY.md
`)
}

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

function envInt(name: string, fallback: number): number {
  const v = env(name)
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer; got '${v}'`)
  }
  return n
}

function envBool(name: string, fallback: boolean): boolean {
  const v = env(name)
  if (v === undefined) return fallback
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes'
}

function envList(name: string): string[] | undefined {
  const v = env(name)
  if (v === undefined) return undefined
  const list = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  return list.length > 0 ? list : undefined
}

async function main(): Promise<void> {
  const SPACE_DIR = env('AIPE_SPACE', '.aipehub')!

  // Build the SpaceConfig overrides from env. Anything unset falls back to
  // the values already on disk (or DEFAULT_CONFIG on first init).
  const configOverride: Partial<SpaceConfig> = {}
  if (env('AIPE_HOST') !== undefined) configOverride.host = env('AIPE_HOST')!
  if (env('AIPE_WEB_PORT') !== undefined) configOverride.webPort = envInt('AIPE_WEB_PORT', 3000)
  if (env('AIPE_WS_PORT') !== undefined) configOverride.wsPort = envInt('AIPE_WS_PORT', 4000)
  if (env('AIPE_GATING') !== undefined) {
    const g = env('AIPE_GATING')!
    if (g !== 'open' && g !== 'admin-approval') {
      throw new Error(`AIPE_GATING must be 'open' or 'admin-approval'; got '${g}'`)
    }
    configOverride.gating = g
  }
  if (env('AIPE_COOKIE_SECURE') !== undefined) configOverride.cookieSecure = envBool('AIPE_COOKIE_SECURE', false)
  if (env('AIPE_DEFAULT_LANG') !== undefined) {
    const l = env('AIPE_DEFAULT_LANG')!
    if (l !== 'zh' && l !== 'en') {
      throw new Error(`AIPE_DEFAULT_LANG must be 'zh' or 'en'; got '${l}'`)
    }
    configOverride.defaultLang = l
  }
  if (env('AIPE_HEARTBEAT_MS') !== undefined) {
    configOverride.heartbeatIntervalMs = envInt('AIPE_HEARTBEAT_MS', 30_000)
  }

  const { space, adminToken } = await Space.openOrInit(SPACE_DIR, {
    name: env('AIPE_SPACE_NAME', 'AipeHub')!,
    adminDisplayName: env('AIPE_ADMIN_DISPLAY_NAME', 'Operator')!,
    config: configOverride,
  })

  // On every boot, re-apply env config so AIPE_* always wins over what's on
  // disk (matches "12-factor: config flows from the environment").
  if (Object.keys(configOverride).length > 0) {
    await space.updateConfig(configOverride)
  }
  const config = await space.config()

  // Route B P0-M6 — boot-time security self-check, fail-closed. Runs as early
  // as possible (config resolved, before any socket is opened or identity is
  // touched) so an exposed-but-undefended host never reaches the listen call.
  // Loopback deployments (the default) produce zero violations → no-op.
  const allowedHosts = envList('AIPE_ALLOWED_HOSTS')
  {
    const secViolations = auditBootSecurity({
      host: config.host,
      cookieSecure: config.cookieSecure,
      allowedHosts,
      allowInsecure: envBool('AIPE_ALLOW_INSECURE', false),
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

  // v4 identity layer. Opens (or creates) `<space>/identity.sqlite` and
  // bootstraps an `owner` user with NO credentials.
  //
  // A2.2 — bootstrap no longer migrates the v3 admin token; the v4
  // surface is the documented login path. The first operator gets a
  // password via the (C1) setup wizard, OR via the `aipehub-host
  // mint-admin-token` subcommand as an emergency fallback.
  //
  // Bootstrap is idempotent: on every subsequent boot it returns
  // `bootstrapped: false` and never mutates. The legacy v3 admin URL
  // (`/admin?token=...`) is printed at the bottom of this boot and
  // remains valid for host-level admin routes (agents/secrets/
  // workflows), but `/api/admin/identity/*` no longer accepts it.
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
      const rec = recoverMasterKeyRotation(SPACE_DIR, env('AIPE_MASTER_KEY_PROVIDER'))
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
    // AIPE_MASTER_KEY_PROVIDER=env + AIPE_MASTER_KEY (64 hex) to inject the
    // key from a secret manager without touching disk; =kms-stub is a
    // reserved seam that fails closed.
    const masterKeyProvider = resolveMasterKeyProvider({
      kind: env('AIPE_MASTER_KEY_PROVIDER'),
      localFilePath: join(SPACE_DIR, 'identity-master.key'),
      envKeyMaterial: env('AIPE_MASTER_KEY'),
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
      ownerEmail: env('AIPE_OWNER_EMAIL', 'admin@local')!,
      ownerDisplayName: env('AIPE_ADMIN_DISPLAY_NAME', 'Operator')!,
    })
    if (ib.bootstrapped) {
      log.info('identity: bootstrapped owner', { userId: ib.ownerUserId })
    } else {
      log.info('identity: already populated', {
        users: identity.countUsers(),
      })
    }
    // Phase 7 M4 — env override for org mode. Without AIPE_MODE the
    // store auto-detects (personal when single-user, team otherwise)
    // and auto-promotes on 2nd user or first invitation. AIPE_MODE
    // pins a specific value, useful for:
    //   - team deployments that don't want the auto-detect ever firing
    //   - personal hubs that want to stay personal even after testing
    //     invitations
    const modeOverride = process.env.AIPE_MODE
    if (modeOverride === 'personal' || modeOverride === 'team') {
      identity.setOrgMode(modeOverride)
      log.info('identity: org_mode pinned from AIPE_MODE', { mode: modeOverride })
    } else if (modeOverride !== undefined && modeOverride !== '') {
      log.warn('identity: AIPE_MODE invalid, ignored', {
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
  // AIPE_PEER_SUMMARY_ALERT_SWEEP_MS (0 / unset = off) to edge-trigger breaches
  // into firings + POST webhooks. Off by default — point-in-time evaluation in
  // the admin UI is unchanged; proactive delivery is a deliberate enable.
  let alertSweepTimer: NodeJS.Timeout | undefined
  // Phase 11 M3 — resume sweep. Fires every AIPE_RESUME_SWEEP_MS
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
  // Phase 11 M2 — when an agent throws SuspendTaskError the scheduler
  // calls this notifier to persist the parked task. Wired only when
  // identity opened successfully (rare boot-time failures fall back
  // to non-durable suspend; agents still get the 'suspended' result
  // shape but won't survive a process restart). `hubId` is a fixed
  // sentinel for now — multi-hub-per-process is on the roadmap but
  // not a current shape; the row is keyed by task_id alone.
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
          },
        }
      : {}),
  })
  await hub.start()

  hub.onEvent((e) => {
    process.stdout.write(`[hub][seq=${String(e.seq).padStart(2, '0')}] ${describe(e)}\n`)
  })

  // Phase 11 M3 — resume sweep. Every AIPE_RESUME_SWEEP_MS (default
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
    const rawInterval = Number(process.env.AIPE_RESUME_SWEEP_MS ?? '30000')
    const sweepIntervalMs = Number.isFinite(rawInterval) && rawInterval >= 1_000
      ? Math.min(rawInterval, 600_000)
      : 30_000
    // R9 — how long a resume claim may be held before the reclaimer treats it
    // as crashed and returns the row to the unclaimed pool. Must comfortably
    // exceed the longest plausible single resume (an LLM tool loop can run for
    // minutes), since reclaiming a still-running resume risks an at-least-once
    // re-run. Default 10 min; floored at 2 sweep intervals so a claim is never
    // reclaimed before the next tick even runs; clamped to [1 min, 1 h].
    const rawClaimTtl = Number(process.env.AIPE_RESUME_CLAIM_TTL_MS ?? '600000')
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

  // v5 Stream D — proactive heartbeat engine. Reuses the Phase 11
  // suspend/resume machinery above (no new table, decision v5 #1a): a
  // singleton broker parks a self-renewing `suspended_tasks` row per
  // heartbeat-enabled agent; the resume sweep wakes it on cadence; it
  // dispatches the agent a heartbeat task, then re-parks for the next
  // interval. The engine is spun up lazily — a hub with zero heartbeat
  // agents stays completely untouched, but one enabled at runtime (D-M4)
  // brings the broker + scheduler online on the spot.
  let reconcileHeartbeats: (() => Promise<void>) | undefined
  if (identity) {
    const heartbeatStore = identity
    const minRaw = Number(process.env.AIPE_HEARTBEAT_MIN_MS ?? '')
    const heartbeatMinMs =
      Number.isFinite(minRaw) && minRaw >= 0 ? minRaw : DEFAULT_HEARTBEAT_MIN_MS
    const listEnabledHeartbeats = async (): Promise<HeartbeatAgentConfig[]> => {
      const recs = await space.agents()
      const out: HeartbeatAgentConfig[] = []
      for (const a of recs) {
        const hb = a.managed?.heartbeat
        if (!hb || hb.enabled !== true) continue
        const intervalMs =
          typeof hb.intervalMs === 'number' && Number.isFinite(hb.intervalMs) && hb.intervalMs > 0
            ? hb.intervalMs
            : DEFAULT_HEARTBEAT_MIN_MS
        const cfg: HeartbeatAgentConfig = { agentId: a.id, intervalMs }
        if (typeof hb.checklist === 'string') cfg.checklist = hb.checklist
        out.push(cfg)
      }
      return out
    }

    // Build (once) the broker + scheduler. The broker is a cheap idle
    // singleton — never capability-routed, only resumed by id via the sweep.
    let heartbeatScheduler: HeartbeatScheduler | undefined
    const ensureHeartbeatEngine = (): HeartbeatScheduler => {
      if (heartbeatScheduler) return heartbeatScheduler
      const broker = new HeartbeatParticipant({
        fire: async (st) => {
          // D-M2: the payload carries the agent's standing checklist as a
          // ready-to-read `prompt` (plus structured `heartbeat`/`checklist`
          // fields). A failing dispatch is swallowed by the broker so the
          // cadence never stalls.
          const result = await hub.dispatch({
            from: HEARTBEAT_BROKER_ID,
            strategy: { kind: 'explicit', to: st.targetAgentId },
            payload: buildHeartbeatPayload(st, Date.now()),
            title: 'heartbeat',
          })
          // D-M3 "don't bother me when idle": the hub already recorded this
          // heartbeat in the transcript (audit trail intact) — here we only
          // decide whether to make NOISE. An idle HEARTBEAT_OK stays quiet
          // (debug); a substantive turn or a failure is surfaced.
          const disp = classifyHeartbeatResult(result)
          if (disp.kind === 'active') {
            log.info('heartbeat: agent reported activity', {
              agent: st.targetAgentId,
              summary: disp.summary.slice(0, 280),
            })
          } else if (disp.kind === 'failed') {
            log.warn('heartbeat: agent turn failed', {
              agent: st.targetAgentId,
              error: disp.error,
            })
          } else {
            log.debug('heartbeat: idle (suppressed)', { agent: st.targetAgentId })
          }
        },
      })
      hub.register(broker)
      const sched = new HeartbeatScheduler({
        store: heartbeatStore,
        minIntervalMs: heartbeatMinMs,
        listEnabled: listEnabledHeartbeats,
      })
      heartbeatScheduler = sched
      log.info('heartbeat engine started', { minIntervalMs: heartbeatMinMs })
      return sched
    }

    // Reconcile parked rows against the enabled roster. Called at boot and by
    // agent CRUD (web layer). Stays fully dormant — no broker, no rows — until
    // at least one agent opts in (preserves the D-M1 zero-regression promise).
    reconcileHeartbeats = async (): Promise<void> => {
      const enabled = await listEnabledHeartbeats()
      const rows = heartbeatStore.listSuspendedTasksByAgent(HEARTBEAT_BROKER_ID)
      if (enabled.length === 0 && rows.length === 0) return
      const r = await ensureHeartbeatEngine().reconcile()
      if (r.seeded.length > 0 || r.pruned.length > 0 || r.updated.length > 0) {
        log.info('heartbeat reconciled', {
          enabled: enabled.length,
          seeded: r.seeded.length,
          pruned: r.pruned.length,
          updated: r.updated.length,
        })
      }
    }

    await reconcileHeartbeats()
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
    // `@aipehub/service-datastore-sqlite` from the auto-seeded
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
  // Defaults built-in; an operator drops `<AIPE_SPACE>/pricing.json` to
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

  const localAgents = new LocalAgentPool({
    hub,
    space,
    services,
    orgApiPool,
    pricingTable,
    // Audit P1 — close the Phase 9 upload → multimodal-input loop: managed
    // agents' providers resolve `artifact_ref` / `file_ref` blocks against
    // the same shared uploads handle the upload routes write to.
    ...(uploadsRef
      ? { artifactResolver: (artifactId: string) => uploadsRef.get(artifactId) }
      : {}),
    // Phase 6 #2 — when present, LocalAgentPool wires an onAuthFailure
    // hook for LLM agents whose key came from the vault. A 401 from
    // the provider revokes that vault entry + writes audit + flushes
    // the OrgApiPool cache so next call doesn't reuse the dead key.
    ...(identity ? { identity } : {}),
    // #2-M3 — cross-hub MCP refs (`useMcpServers: ['<peer>:<server>']`)
    // resolve the peer link lazily through the registry, which is wired
    // further down (peerRegistryRef is a forward-declared `let`). Reading
    // it at call time means a not-yet-connected / reconnected peer is
    // handled by RemoteMcpToolset's own offline path.
    peerLinkResolver: (peerId) => peerRegistryRef?.linkForHub(peerId) ?? null,
  })
  await localAgents.start()

  // Growth-reports admin surface — only meaningful if the
  // personal-growth team is loaded. The accessor closure
  // re-resolves on every web call so admin/restart of the
  // synthesist agent picks up cleanly.
  const growthReports = new GrowthReportsAdmin({
    artifactAccessor: () => {
      const ctx = localAgents.liveServicesFor('growth-synthesist')
      return ctx?.artifact
    },
  })

  // Workflow runners. Optional — the loader silently no-ops when the
  // directory doesn't exist, so users who aren't using workflows see no
  // extra log output. Errors are reported per-file; one bad workflow
  // never blocks host boot. The loader only parses; the controller adopts
  // each definition through the versioning service, which registers the
  // resolver-backed runner (Phase 15).
  const workflowsDir = env('AIPE_WORKFLOWS_DIR', join(SPACE_DIR, 'workflows', 'definitions'))!
  const workflowReport = await loadWorkflows({ dir: workflowsDir })
  const wfMsg = formatLoadReport(workflowReport)
  if (wfMsg) log.info('workflow loader', { report: wfMsg })
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
  // peer_summary_alert_firings — one AIPE_*_KEEP_DAYS knob each, all OFF by
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

  // Phase 13 M3 — host-built-in workflow assistant agent. Registers a
  // `WorkflowAssistantAgent` on the hub (cap=`workflow:assist`) and
  // exposes a duck-typed surface for the Web layer's
  // `POST /api/admin/workflows/assist` route. Returns null (and the
  // route stays 503) when AIPE_ASSISTANT_DISABLED=1 or no LLM API key
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
  const adminRateMax = envInt('AIPE_ADMIN_RATE_MAX', 10)
  const adminRateSec = envInt('AIPE_ADMIN_RATE_SEC', 60)

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

  // D1 — Peer Registry. Polls identity.peers every AIPE_PEER_POLL_MS
  // (default 5s) and reconciles outbound HubLinks; shares ws.server
  // for inbound peer HELLO acceptance. Disabled when identity is
  // unwired (federation requires v4 identity) OR when the operator
  // explicitly skipped it via AIPE_PEERS_DISABLED=1.
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
  }
  if (identity && process.env.AIPE_PEERS_DISABLED !== '1') {
    const spaceMeta = await space.meta()
    const selfHubId = spaceMeta.hubId ?? 'self'
    const pollMs = envInt('AIPE_PEER_POLL_MS', 5_000)
    const inboundToken = process.env.AIPE_PEER_INBOUND_TOKEN
    // Audit #142 — single source of truth for "is this host behind a
    // reverse proxy".
    const trustProxy = envBool('AIPE_TRUST_PROXY', false)
    // Audit #149 — env wiring for the inbound rate limit. Default
    // 60/60s mirrors PeerRegistry's own default (set to 0 either side
    // to disable; useful in closed networks / tests). Operators
    // raise these when running a peer farm where 60 hellos / 60s is
    // genuinely too tight, or drop them when under sustained attack
    // and a tighter floor is preferable to letting one IP saturate.
    const rateLimitMax = envInt('AIPE_PEER_INBOUND_RATE_MAX', 60)
    const rateLimitWindowMs = envInt('AIPE_PEER_INBOUND_RATE_WINDOW_MS', 60_000)
    const inboundRateLimit = { max: rateLimitMax, windowMs: rateLimitWindowMs }
    // Phase 19 P4-M4 — fixed window for the per-link inbound quota counter
    // (`perLinkQuotaBudget` tasks per window). Default 60s; in-memory, resets
    // on restart (a fail-closed safety cap, not a billing ledger).
    const linkQuotaWindowMs = envInt('AIPE_PEER_LINK_QUOTA_WINDOW_MS', 60_000)
    // Provider side of the cross-hub MCP proxy. Reads the same hub
    // registry the admin UI writes; only servers flagged `shared` are
    // ever served to a peer (ACL lives inside respond()).
    mcpProxy = new McpProxyHost({ space, logger: log })
    const proxyRespond = mcpProxy.respond
    // Phase 18 A-M1 — peer capability manifest provider, composed with the
    // MCP proxy onto the single rpcResponder: `mcp.*` → MCP proxy, anything
    // else → manifest host. `peerWrapperIds` is a thunk so it reflects the
    // registry's CURRENT peers (each wrapper is registered under the peer's
    // hub id) — we advertise our own agents, never a neighbour's.
    const peerWrapperIds = () =>
      new Set((peerRegistry?.status() ?? []).map((r) => r.peerId))
    const peerManifestHost = new PeerManifestHost({
      hub,
      hubId: selfHubId,
      peerWrapperIds,
    })
    // v5 E5 — privacy-safe footprint summary (the free-graph control plane).
    // Counts only, built on demand from the same hub + workflow + identity
    // surfaces. The deps are shared by the RPC provider (answers a peer's
    // `peer.summary`) AND the federation surface's `local()` (this hub's own
    // footprint in the admin control plane). Composed onto the rpcResponder
    // below; the per-link gate in peer-registry denies `peer.summary` unless the
    // row opted into sharing.
    const summaryDeps: BuildSummaryDeps = {
      hub,
      hubId: selfHubId,
      peerWrapperIds,
      workflows: workflowController,
      identity,
    }
    const peerSummaryHost = new PeerSummaryHost(summaryDeps)
    // v5 Stream G day-5 — cross-hub transcript chain provider. Answers a peer's
    // `peer.transcript { taskId }` with the slice of THIS hub's transcript for
    // that one task (its task / result / llm stream / resume markers — never our
    // internal sub-dispatches, which carry different ids). Composed onto the
    // rpcResponder below; the per-link gate in peer-registry denies it unless the
    // row opted into sharing (`share_transcript`, identity v27).
    const peerTranscriptHost = new PeerTranscriptHost({ hub, hubId: selfHubId })
    // Phase 18 B-M3 — outbound cross-org approval gate. A peer row flagged
    // `requireApprovalOutbound` has its outbound sender wrapped so a task parks
    // as an approval item in the owner's /me inbox and only crosses the org
    // boundary once approved. Approver = the org owner resolved at boot (MVP; a
    // later node can make it per-peer configurable). Wired only when both the
    // inbox store and an owner exist; otherwise the registry logs + stays
    // ungated (loud, not a silent fail-open).
    const approverUserId = findOwnerUserId(identity)
    let outboundApprovalGate:
      | ((inner: RemoteHubViaLink, row: PeerRegistration) => Participant)
      | undefined
    if (inboxStore && approverUserId) {
      const store = inboxStore
      const approver = approverUserId
      outboundApprovalGate = (inner, row) =>
        new ApprovalGatedParticipant({
          inner,
          store,
          approver,
          peerLabel: row.label ?? row.peerId,
        })
    } else if (inboxStore) {
      log.warn('outbound approval gate not wired: no org owner resolved')
    }
    peerRegistry = new PeerRegistry({
      hub,
      identity,
      selfHubId,
      wss: ws.wss,
      ...(inboundToken ? { sharedInboundPeerToken: inboundToken } : {}),
      pollIntervalMs: pollMs,
      inboundRateLimit,
      perLinkQuotaWindowMs: linkQuotaWindowMs,
      ...(trustProxy ? { trustProxy: true } : {}),
      rpcResponder: (call) => {
        if (call.method.startsWith('mcp.')) return proxyRespond(call)
        if (call.method === PEER_SUMMARY_METHODS.get) return peerSummaryHost.respond(call)
        if (call.method === PEER_TRANSCRIPT_METHODS.get) return peerTranscriptHost.respond(call)
        return peerManifestHost.respond(call)
      },
      ...(outboundApprovalGate ? { outboundApprovalGate } : {}),
      logger: log,
    })
    peerRegistry.start()
    // D2 — make this registry visible to the Hub's cross-hub resolver
    // closure declared above. From here on, any explicit dispatch whose
    // target isn't local + whose task.origin points at a connected peer
    // will be forwarded over the live HubLink.
    peerRegistryRef = peerRegistry
    // Bind the federation discovery surface to this registry. Each call
    // asks every connected peer what it shares; an offline peer or a
    // listShared that throws (e.g. an older peer without the method)
    // degrades to `online:false` / empty rather than failing the whole
    // list — the UI shows the peer with no servers.
    const fedRegistry = peerRegistry
    mcpFederation = {
      listPeerShared: async () => {
        const rows = fedRegistry.status()
        const out = await Promise.all(
          rows.map(async (row) => {
            const link = row.connected ? fedRegistry.linkForHub(row.peerId) : null
            if (!link) {
              return { peer: row.peerId, label: row.label, online: false, servers: [] }
            }
            try {
              const servers = await fetchPeerSharedMcp(link)
              return { peer: row.peerId, label: row.label, online: true, servers }
            } catch (err) {
              log.warn('mcp federation: listShared failed', {
                peer: row.peerId,
                err: err instanceof Error ? err.message : String(err),
              })
              return { peer: row.peerId, label: row.label, online: true, servers: [] }
            }
          }),
        )
        return out
      },
    }
    // Phase 18 A-M2 — on-demand peer capability manifest discovery for the
    // admin UI. In-process cache over the same registry; the admin refreshes.
    peerFederation = createPeerManifestFederation(fedRegistry, { logger: log })
    // v5 E5-M3 — the control plane: this hub's own footprint (`local`) joined
    // with each connected peer's voluntarily-shared summary. In-process cache
    // over the same registry; the admin refreshes on demand.
    //
    // v5 Stream F multi-channel (M3) — opt-in best-effort retry/backoff + a
    // dedup window for alert delivery. Retry defaults to a single attempt
    // (behavior unchanged); the dedup window defaults to 60s (the firing
    // lifecycle already notifies once — this is the secondary net).
    const clampInt = (raw: string | undefined, def: number, lo: number, hi: number): number => {
      const n = Number(raw ?? '')
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : def
    }
    const alertRetryAttempts = clampInt(process.env.AIPE_PEER_SUMMARY_ALERT_RETRY_ATTEMPTS, 1, 1, 6)
    const alertRetryBaseMs = clampInt(process.env.AIPE_PEER_SUMMARY_ALERT_RETRY_BASE_MS, 500, 50, 30_000)
    const alertDedupWindowMs = clampInt(process.env.AIPE_PEER_SUMMARY_ALERT_DEDUP_MS, 60_000, 0, 3_600_000)
    peerSummaryFederation = createPeerSummaryFederation(fedRegistry, {
      buildLocal: () => buildLocalSummary(summaryDeps),
      // v5 Stream F — persist a counts-only snapshot per refresh so the control
      // plane can draw trends. IdentityStore duck-types the snapshot sink; the
      // history query reads it back. Without this the plane is point-in-time only.
      snapshots: identity,
      // v5 Stream F-M5 — alert rules + live evaluation. IdentityStore duck-types
      // the rule sink; the federation exposes CRUD + evaluateAlerts on top.
      alertRules: identity,
      // v5 Stream F day-3 — firing history (edge-trigger open→resolve) + webhook
      // notification channels. IdentityStore duck-types both. The federation
      // exposes channel CRUD + `evaluateAndDeliver`; the opt-in alert sweep below
      // drives proactive delivery. Webhook transport defaults to global fetch +
      // process.env (the secret in `headerEnv` is read at delivery time).
      firings: identity,
      channels: identity,
      // v5 Stream F multi-channel (M3) — best-effort retry/backoff for the
      // dispatcher (defaults to a single attempt = unchanged) + the dedup
      // window for the in-memory deduper (0 disables). Delivery still routes
      // through global fetch + process.env; the deduper is created and held
      // by the federation surface.
      deliver: { retry: { maxAttempts: alertRetryAttempts, baseDelayMs: alertRetryBaseMs } },
      deliverDedupWindowMs: alertDedupWindowMs,
      logger: log,
    })
    // v5 Stream F day-3 — proactive alert-delivery sweep. OPT-IN: only runs when
    // AIPE_PEER_SUMMARY_ALERT_SWEEP_MS is set to a positive value (clamped to
    // [10s, 1h]). Each tick refreshes peer summaries then edge-triggers breaches
    // into firings + POSTs webhooks (notify ONCE per breach). A reentrancy guard
    // prevents a slow tick (many channels / slow webhooks) from overlapping the
    // next. Off by default: the admin UI's point-in-time evaluation is unchanged,
    // and a hub with no channels configured delivers nothing even when enabled.
    {
      const fed = peerSummaryFederation
      const rawAlertInterval = Number(process.env.AIPE_PEER_SUMMARY_ALERT_SWEEP_MS ?? '0')
      const alertIntervalMs =
        Number.isFinite(rawAlertInterval) && rawAlertInterval >= 10_000
          ? Math.min(rawAlertInterval, 3_600_000)
          : 0
      if (alertIntervalMs > 0) {
        let alertInflight = false
        const sweepAlerts = async (): Promise<void> => {
          if (alertInflight) return
          alertInflight = true
          try {
            // Refresh first so peer summaries are current before we evaluate —
            // a refresh failure on one peer leaves its last reading (the row's
            // `stale` flag stays the UI's honesty signal), it never aborts the pass.
            await fed.refresh()
            const report = await fed.evaluateAndDeliver()
            if (report.opened.length > 0 || report.resolved.length > 0) {
              const failed = report.deliveries.filter((d) => !d.ok).length
              log.info('peer summary alert sweep', {
                opened: report.opened.length,
                resolved: report.resolved.length,
                deliveries: report.deliveries.length,
                failedDeliveries: failed,
              })
            }
          } catch (err) {
            log.error('peer summary alert sweep failed', {
              err: err instanceof Error ? err.message : String(err),
            })
          } finally {
            alertInflight = false
          }
        }
        alertSweepTimer = setInterval(() => {
          void sweepAlerts()
        }, alertIntervalMs)
        alertSweepTimer.unref?.()
        log.info('peer summary alert sweep started', { intervalMs: alertIntervalMs })
      }
    }
    // Phase 6 #4 — per-peer resolver is auto-wired by PeerRegistry
    // when identity is present (it is here — we only enter this block
    // when identity is wired). The shared token remains as fallback
    // for peers not yet enrolled in the peers table; in practice the
    // resolver path wins for any peer that IS enrolled because
    // verifyPeerToken consults the resolver first.
    log.info('peer registry started', {
      selfHubId,
      pollIntervalMs: pollMs,
      inboundAuth: inboundToken ? 'per-peer+shared-fallback' : 'per-peer',
      trustProxy,
      inboundRateLimit: rateLimitMax > 0 && rateLimitWindowMs > 0
        ? `${rateLimitMax}/${rateLimitWindowMs}ms`
        : 'disabled',
    })
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
  // C-M1 — skill advertisement is OFF by default. When on, the card enumerates
  // this hub's local capabilities (peer wrappers excluded) as A2A skills, each
  // skill id == the capability an inbound message/send targets. Public endpoint,
  // so opting in is a deliberate operator act.
  const advertiseSkills = envBool('AIPE_A2A_ADVERTISE_SKILLS', false)
  const selfHubIdForCard = cardMeta.hubId ?? 'self'
  const agentCard = {
    json: (baseUrl: string): string => {
      const skills = advertiseSkills
        ? buildLocalManifest(
            hub,
            selfHubIdForCard,
            new Set((peerRegistry?.status() ?? []).map((r) => r.peerId)),
          ).capabilities.map((cap) => ({ id: cap.id, name: cap.id }))
        : []
      return JSON.stringify(
        buildAgentCard({
          name: cardMeta.name || cardMeta.hubId || 'AipeHub',
          version: BAKED_VERSION,
          url: baseUrl,
          description: cardMeta.description,
          authSchemes: peerRegistry ? ['bearer'] : [],
          ...(skills.length > 0 ? { skills } : {}),
        }),
        null,
        2,
      )
    },
  }

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
  // `aipehub.human/v1` capability; the broker parks it as an inbox item and
  // suspends (Phase 11). A member resolves it from /me, and HostInboxService
  // runs the two-step resume (child broker → parent workflow run). Gated on
  // identity: durable parking lives in suspended_tasks (identity SQLite), and
  // /me itself requires a v4 user — so without identity there is no inbox.
  // The store itself was built earlier (so the Phase 18 approval gate could
  // share it); here we register the human-step broker + the resume service.
  let inboxService: HostInboxService | undefined
  if (identity && inboxStore) {
    hub.register(new HumanInboxParticipant({ store: inboxStore }))
    inboxService = new HostInboxService({ hub, store: inboxStore, identity, logger: log })
    log.info('member task inbox enabled', { capability: HUMAN_CAPABILITY })
  }

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
      // Item 2 — per-agent outbound quota window (mirrors AIPE_PEER_LINK_QUOTA_WINDOW_MS).
      quotaWindowMs: envInt('AIPE_A2A_OUTBOUND_QUOTA_WINDOW_MS', 60_000),
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
    // the two-step recovery) instead of being denied inline. AIPE_ACP_DANGER=deny
    // forces the old hard-deny for unattended hubs (no one to approve → a park
    // would wait forever). The approver is the org owner, mirroring the Phase 18
    // outbound cross-org approval gate.
    const forceDeny = process.env.AIPE_ACP_DANGER === 'deny'
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
      // Item 2 — per-agent outbound quota window (mirrors AIPE_PEER_LINK_QUOTA_WINDOW_MS).
      quotaWindowMs: envInt('AIPE_ACP_OUTBOUND_QUOTA_WINDOW_MS', 60_000),
    })
    acpOutbound.registerAllFromStore()
  }

  // GO-LIVE GL-1 — outbound IM bridges (Telegram). OFF unless
  // AIPE_TELEGRAM_BOT_TOKEN is set, so an existing deployment is byte-for-
  // byte unaffected. Telegram long-polls (no public endpoint), which is
  // exactly what lets a home box behind NAT run a hub with zero tunnelling
  // — the IM cloud is the public relay. Members link their IM identity by
  // DMing the bot `/bind <code>` with a code issued in the admin UI / 我的;
  // every dispatch then carries the bound `origin.userId`. Needs identity
  // for the binding store — without it there's nothing to bind against.
  let imBridges: ImBridgesHandle | undefined
  if (identity) {
    imBridges = await startImBridges({ hub, identity, log })
  }

  // Phase 18 C-M3 — inbound A2A message/send endpoint. OFF by default (it
  // exposes the hub to external A2A callers); enable with
  // AIPE_A2A_INBOUND_ENABLED. Auth reuses the per-peer vault token via
  // buildPeerTokenResolver; AIPE_A2A_INBOUND_CAPABILITY is the fallback
  // dispatch capability for messages without an explicit metadata.skill.
  let a2aServer: A2aServer | undefined
  if (identity && envBool('AIPE_A2A_INBOUND_ENABLED', false)) {
    const a2aDefaultCap = env('AIPE_A2A_INBOUND_CAPABILITY')
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

  // v5 A-M3 — member API-credential ("bring your own key") management. Keys
  // live in the vault, so this is wired only when identity is present; the
  // /api/me/credentials routes 503 otherwise.
  const meCredentials = identity
    ? new HostMeCredentialsService({ identity })
    : undefined

  // GO-LIVE GL-1c — member IM-account linking. The binding code a member mints
  // here is what they DM to the bot as `/bind <code>`; bindings live in
  // identity, so this is wired only when identity is present (/api/me/im 503s
  // otherwise). `isEnabled` is a live read of the bridge handle declared above
  // — the panel hides "connect" when no bridge is running so a member isn't
  // handed a code nothing can consume.
  const meIm = identity
    ? new HostMeImService({ identity, isEnabled: () => Boolean(imBridges) })
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

  // Route B P1-M5e — browser SSO via configured SAML 2.0 IdPs. Wired only when
  // identity is present (the provider registry + (idpEntityId,NameID)→user links
  // + the session it mints all live there). Absent → /api/auth/saml/* degrades:
  // the provider list is empty and start/acs bounce to ?saml_error=not_enabled.
  //
  // The ACS URL must be a STABLE absolute URL the IdP can POST back to (it's
  // baked into the AuthnRequest and re-checked against the response Recipient),
  // so it can't be request-derived like the agent card. Source it from
  // AIPE_PUBLIC_URL (the externally-reachable base, e.g. behind a proxy);
  // fall back to host:port for local dev. Production behind TLS MUST set it.
  let samlLogin: SamlLoginSurface | undefined
  let samlAdmin: SamlProviderAdminSurface | undefined
  if (identity) {
    const idForSaml = identity
    const publicBase = (env('AIPE_PUBLIC_URL') ?? `http://${config.host}:${config.webPort}`).replace(/\/+$/, '')
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

  const web = await serveWeb(hub, {
    host: config.host,
    port: config.webPort,
    cookieSecure: config.cookieSecure,
    lifecycle: localAgents,
    // ease-of-use ③-M1 — LLM-key probe for the template-import post-install
    // checklist ("agent X still needs a key"). Reuses the pool's spawn-time
    // resolution chain so the checklist never disagrees with reality.
    llmKeyProbe: {
      resolvesKey: (id, provider) => localAgents.hasResolvableLlmKey(id, provider),
    },
    // ease-of-use ❷-M1 — read-only "hub 体检" snapshot for the admin overview
    // panel. Static signals only (agents missing a key / MCP servers nobody
    // wired / space still writable); reuses the SAME key-resolution chain as the
    // probe above so the panel never disagrees with whether an agent will start.
    adminHealth: createAdminHealthService({
      listAgents: () => space.agents(),
      liveIds: () => new Set(hub.participants().map((p) => p.id)),
      resolvesKey: (id, provider) => localAgents.hasResolvableLlmKey(id, provider),
      listMcpServers: () => space.mcpServers(),
      spacePath: space.root,
      // EH-M1 — 配置进度 (工作流总/可跑 + run 总数) 喂体检面板的「下一步建议」
      // 常驻引导。listAll 含全状态草稿, list 只含可跑 (published/live); countRuns
      // 取 active 集精确总数。全只读, 复用 workflowController 现成方法零新机制。
      countWorkflows: async () => {
        const [all, live] = await Promise.all([
          workflowController.listAll(),
          workflowController.list(),
        ])
        return { total: all.length, published: live.length }
      },
      countRuns: async () => (await workflowController.countRuns()).total,
    }),
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
    meAgents: {
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
    },
    // v5 A-M2 — member agent ownership + self-service CRUD (undefined → 503).
    ...(meAgentAdmin ? { meAgentAdmin } : {}),
    // v5 A-M4 — member agent access-grant sharing (undefined → 503).
    ...(meAgentGrants ? { meAgentGrants } : {}),
    // v5 A-M3 — member API-credential management (undefined → 503).
    ...(meCredentials ? { meCredentials } : {}),
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
    // SW-M9 A-M7 — the OPERATOR-console steward (site-wide twin); null on the same
    // conditions, in which case /api/admin/steward/{plan,apply} return 503.
    ...(operatorSteward ? { operatorSteward } : {}),
    // Phase 13 M3 — null when no API key / disabled. Web responds 503
    // on /api/admin/workflows/assist in that case so the UI can hide
    // the "AI assistant" button cleanly.
    ...(workflowAssist ? { workflowAssist } : {}),
    // ease-of-use ① — "test connection" probe. Always available: it uses
    // the key the caller types, no host config. Powers the 测试连接 button
    // in the setup wizard and the agent-create form.
    llmKeyTest: createLlmKeyTestSurface(),
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
    ...(env('AIPE_METRICS_TOKEN') ? { metricsToken: env('AIPE_METRICS_TOKEN') } : {}),
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
  const resumeGraceMs = envInt('AIPE_WORKFLOW_RESUME_GRACE_MS', 2_000)
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
  console.log(`\n=== AipeHub host ready ===`)
  console.log(`Space     : ${SPACE_DIR}`)
  console.log(`Web       : ${web.url}`)
  console.log(`WebSocket : ${ws.url}`)
  console.log(`Gating    : ${config.gating}`)
  console.log(`CookieSec : ${config.cookieSecure ? 'on (HTTPS expected)' : 'off (HTTP / dev)'}`)
  console.log(
    `HostCheck : ${
      allowedHosts
        ? allowedHosts.join(', ')
        : isLoopbackHost(config.host)
          ? 'disabled (loopback only is safe)'
          : 'DISABLED while network-exposed — AIPE_ALLOW_INSECURE set (see boot warnings)'
    }`,
  )
  // Friendly first-run nicety (presentation only): point a fresh local user
  // at the loopback setup wizard and optionally open their browser. Never
  // auto-opens when network-exposed (see shouldOpenBrowser). AIPE_OPEN_BROWSER
  // controls it: auto (default, first run only) / always / never.
  const openMode = parseOpenBrowserEnv(process.env.AIPE_OPEN_BROWSER)
  const loopbackHost = isLoopbackHost(config.host)
  const maybeOpenBrowser = (targetUrl: string, firstRun: boolean): void => {
    if (!shouldOpenBrowser(openMode, { loopback: loopbackHost, firstRun })) return
    const opened = openUrl(targetUrl, {
      onError: (err) => log.debug('browser auto-open failed', { err }),
    })
    console.log(
      opened
        ? `  (已自动打开浏览器 / browser opened — AIPE_OPEN_BROWSER=0 关闭)`
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
          `       over, or use \`aipehub-host mint-admin-token\` to create\n` +
          `       a fresh admin against the existing workspace once the\n` +
          `       underlying error is fixed.\n`,
      )
      process.exit(2)
    }
  } else {
    console.log(`Admin     : ${web.url}/admin    (existing cookie or token)\n`)
    // Only opens when AIPE_OPEN_BROWSER=always (firstRun=false → 'auto' is a
    // no-op), so restarts don't spam the browser.
    maybeOpenBrowser(`${web.url}/admin`, false)
  }

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

  // Never resolve — the listeners keep us alive.
  await new Promise<never>(() => { /* never */ })
}

function describe(e: TranscriptEntry): string {
  switch (e.kind) {
    case 'participant_joined':
      return `JOIN     ${e.data.id} (${e.data.participantKind}) caps=[${e.data.capabilities.join(',')}]`
    case 'participant_left':
      return `LEAVE    ${e.data.id}`
    case 'message':
      return `MSG      ${e.data.from} -> #${e.data.channel}`
    case 'task':
      return `TASK     ${e.data.from} "${e.data.title ?? '(untitled)'}" via ${e.data.strategy.kind}`
    case 'task_result':
      if (e.data.kind === 'ok') return `RESULT   ok by ${e.data.by}`
      if (e.data.kind === 'failed') return `RESULT   failed by ${e.data.by}: ${e.data.error}`
      if (e.data.kind === 'cancelled') return `RESULT   cancelled: ${e.data.reason}`
      // Phase 11 M2 — suspended kind in TaskResult union. Show the
      // wake-up time in the host log so operators tailing the
      // stdout can see "task X is parked until 12:34" without
      // opening the SQLite row directly.
      if (e.data.kind === 'suspended')
        return `RESULT   suspended by ${e.data.by} until ${new Date(e.data.resumeAt).toISOString()}`
      return `RESULT   no_participant: ${e.data.reason}`
    case 'agent_pending':
      return `PENDING  app=${e.data.id} agents=[${e.data.agents.map((a) => a.id).join(',')}]`
    case 'agent_approved':
      return `APPROVE  app=${e.data.applicationId} agents=[${e.data.agentIds.join(',')}] by ${e.data.by ?? '?'}`
    case 'agent_rejected':
      return `REJECT   app=${e.data.applicationId} by ${e.data.by ?? '?'}: ${e.data.reason}`
    case 'evaluation':
      return `EVAL     ${e.data.taskId} rating=${e.data.rating ?? '?'} by ${e.data.by}`
    case 'service_trashed':
      return `TRASH    ${e.data.type}:${e.data.impl} owner=${e.data.ownerKind}/${e.data.ownerId} ref=${e.data.ref.id}`
    case 'service_purged':
      return `PURGE    ${e.data.type}:${e.data.impl} trashId=${e.data.trashId}`
    case 'service_call':
      // v1.2: one line per resolved SERVICE_CALL. Audit lines for OK
      // calls are noisy at the host's stdout level but useful when
      // debugging; admins prefer the structured `/api/admin/transcript/
      // service-calls` view. Either way the data lives in the
      // transcript.
      return `SVCCALL  ${e.data.from} ${e.data.type}:${e.data.impl}#${e.data.method} → ${e.data.outcome} (${e.data.durationMs}ms)`
    case 'llm_stream_chunk':
      // Phase 8 M6 — agent stream chunks. Don't print every chunk to
      // stdout (would dominate the log); just summarize the chunk
      // type. Operators wanting the actual text use the admin UI's
      // SSE stream where chunks arrive in real time.
      return `LLMCHUNK ${e.data.agentId} task=${e.data.taskId} kind=${
        (e.data.chunk as { type?: string } | null)?.type ?? '?'
      }`
    case 'task_resumed':
      // Phase 11 M3 — resume sweep signal. Paired with a subsequent
      // task_result line; together they trace "task X woken on agent
      // Y, then produced result Z" in the host stdout.
      return `RESUME   task=${e.data.taskId} by ${e.data.by}`
  }
}

main().catch((err) => {
  // ease-of-use ⑥-M2 — turn the common, recoverable EADDRINUSE into an
  // actionable hint (which port var to change + `aipehub doctor`) instead of a
  // structured-fatal dump. Everything else keeps the default observability path.
  const hint = friendlyBootError(err)
  if (hint) {
    process.stderr.write(hint + '\n')
  } else {
    log.fatal('boot failed', { err })
  }
  process.exit(1)
})
