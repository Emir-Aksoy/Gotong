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
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { Hub, Space, createLogger, type Logger, type McpServerSpec, type Participant, type RemoteHubViaLink, type SpaceConfig, type Task, type TranscriptEntry } from '@aipehub/core'
import {
  AUDIT_ACTIONS,
  openIdentityStore,
  principalKey,
  resolveMasterKeyProvider,
  type IdentityStore,
  type PeerRegistration,
} from '@aipehub/identity'

import { OrgApiPool } from './org-api-pool.js'

import { BAKED_VERSION } from './version.js'
import { buildAgentCard } from './agent-card.js'
import { auditBootSecurity, formatBootSecurityReport, isLoopbackHost } from './boot-security.js'

const log = createLogger('host')
import { serveWebSocket } from '@aipehub/transport-ws'
import { PeerRegistry, buildPeerTokenResolver } from './peer-registry.js'
import { A2aServer } from './a2a-server.js'
import { A2aRemoteParticipant } from '@aipehub/a2a'
import { serveWeb, type WebServerOptions } from '@aipehub/web'

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

/**
 * Phase 18 C-M4 — register outbound A2A agents from AIPE_A2A_AGENTS.
 *
 * The env is a JSON array of `{ id, capabilities, url, tokenEnv, peerId?,
 * targetSkill? }`. Each becomes an `A2aRemoteParticipant` so a capability
 * dispatch on the local hub is forwarded over A2A `message/send`. The bearer
 * token is read from `process.env[tokenEnv]` — never inline in the blob — so
 * credentials stay in the normal env channel. Malformed top-level JSON degrades
 * to "register nothing" (logged); a per-entry problem (missing field / unset
 * token) skips just that entry. Returns the count registered.
 */
function registerOutboundA2aAgents(hub: Hub, log: Logger): number {
  const raw = env('AIPE_A2A_AGENTS')
  if (!raw) return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    log.error('AIPE_A2A_AGENTS is not valid JSON; no outbound A2A agents registered', {
      err: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
  if (!Array.isArray(parsed)) {
    log.error('AIPE_A2A_AGENTS must be a JSON array; no outbound A2A agents registered')
    return 0
  }
  let registered = 0
  for (const item of parsed) {
    const e = (item ?? {}) as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id : undefined
    const url = typeof e.url === 'string' ? e.url : undefined
    const tokenEnv = typeof e.tokenEnv === 'string' ? e.tokenEnv : undefined
    const capabilities = Array.isArray(e.capabilities)
      ? e.capabilities.filter((c): c is string => typeof c === 'string')
      : []
    if (!id || !url || !tokenEnv || capabilities.length === 0) {
      log.warn('skipping malformed AIPE_A2A_AGENTS entry (need id, url, tokenEnv, capabilities[])', {
        entry: e,
      })
      continue
    }
    const token = process.env[tokenEnv]
    if (!token) {
      log.warn('skipping outbound A2A agent: token env is unset', { id, tokenEnv })
      continue
    }
    const peerId = typeof e.peerId === 'string' ? e.peerId : undefined
    const targetSkill = typeof e.targetSkill === 'string' ? e.targetSkill : undefined
    hub.register(
      new A2aRemoteParticipant({
        id,
        capabilities,
        url,
        token,
        ...(peerId ? { peerId } : {}),
        ...(targetSkill ? { targetSkill } : {}),
      }),
    )
    registered++
  }
  if (registered > 0) log.info('outbound A2A agents registered', { count: registered })
  return registered
}

import { LocalAgentPool } from './local-agent-pool.js'
import { loadPricingTable } from './pricing.js'
import { McpProxyHost, fetchPeerSharedMcp } from './mcp-proxy.js'
import {
  PeerManifestHost,
  buildLocalManifest,
  createPeerManifestFederation,
  type PeerManifestFederation,
} from './peer-manifest.js'
import { GrowthReportsAdmin } from './services/growth-reports-admin.js'
import {
  BINARY_SAFE_PLUGINS,
  bootstrapServices,
  isCompiledBinary,
  LifecycleSweeper,
  type HubServices,
} from './services/index.js'
import { createUploadSurface } from './uploads.js'
import { createWorkflowController } from './workflow-controller.js'
import { formatLoadReport, loadWorkflows } from './workflow-loader.js'
import { HostInboxService } from './inbox-service.js'
import { HostMeAgentService } from './me-agent-service.js'
import { HostMeAgentGrantsService } from './me-agent-grants-service.js'
import { HostMeCredentialsService } from './me-credentials-service.js'
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
 * Persist the one-time admin URL to `runtime/admin-link.txt` with file
 * mode 0o600. Idempotent — overwrites any prior link from a previous
 * run / mint-admin-token invocation. See H20 in AUDIT-v3.3.md.
 *
 * Why a file instead of `console.log`:
 *   - stdout from a daemon process is captured by `journalctl`,
 *     `docker logs`, `pm2 logs`, container log shippers, etc. Any
 *     reader of those logs picks up the token.
 *   - Pre-3.4 also dumped the token into the host's first boot banner,
 *     which is the easiest "search the logs for the admin URL" target
 *     for an attacker who lands a low-priv shell on the box.
 *   - The workspace directory is already protected by `SECURE_DIR_MODE`
 *     (0o700, see core/space.ts). Writing the link inside it with
 *     mode 0o600 puts it under exactly the same trust boundary the
 *     master key already enjoys — no new attack surface.
 */
export async function writeAdminLinkFile(path: string, url: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // The runtime/ dir was already chmod'd to 0o700 by Space.init; the
  // file's own 0o600 is the second layer.
  await writeFile(path, url + '\n', { encoding: 'utf8', mode: 0o600 })
}

function printUsage(): void {
  process.stdout.write(`Usage:
  aipehub-host                            run the host (env-driven)
  aipehub-host mint-admin-token [name]    add a fresh admin (recovery)
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
  // Phase 11 M3 — resume sweep. Fires every AIPE_RESUME_SWEEP_MS
  // (default 30 s); each tick reads due rows from suspended_tasks
  // and re-dispatches them via Hub.resumeTask.
  let resumeSweepTimer: NodeJS.Timeout | undefined
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
  // Phase 11 M2 — when an agent throws SuspendTaskError the scheduler
  // calls this notifier to persist the parked task. Wired only when
  // identity opened successfully (rare boot-time failures fall back
  // to non-durable suspend; agents still get the 'suspended' result
  // shape but won't survive a process restart). `hubId` is a fixed
  // sentinel for now — multi-hub-per-process is on the roadmap but
  // not a current shape; the row is keyed by task_id alone.
  const identityForSuspend = identity
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
          suspendNotifier: (task, by, suspend) => {
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
    let sweepInflight = false
    const sweepResume = async (): Promise<void> => {
      if (sweepInflight) return
      sweepInflight = true
      try {
        const due = swept.listDueSuspendedTasks({ now: Date.now(), limit: 100 })
        for (const row of due) {
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

  const localAgents = new LocalAgentPool({
    hub,
    space,
    services,
    orgApiPool,
    pricingTable,
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

  // Phase 9 M4 — admin file uploads. Wires the artifact plugin's
  // 'file' impl to a system-shared 'uploads' namespace so /api/admin/uploads
  // can persist a multimodal payload before it lands on a workflow.
  // The plugin must be loaded (it's in the default seed); attach
  // failure is non-fatal — `uploads` stays undefined and Web responds
  // 503 cleanly. Same posture as `services` / `identity` / `peerRegistry`.
  let uploads: Awaited<ReturnType<typeof createUploadSurface>> | undefined
  if (services) {
    try {
      uploads = await createUploadSurface({ services, logger: log })
      log.info('uploads: shared/uploads handle attached')
    } catch (err) {
      log.warn('uploads: attach failed — /api/admin/uploads will be 503', { err })
    }
  }

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
  const workflowController = await createWorkflowController(
    { hub, definitionsDir: workflowsDir, spaceRoot: SPACE_DIR },
    workflowReport,
  )

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
    const peerManifestHost = new PeerManifestHost({
      hub,
      hubId: selfHubId,
      peerWrapperIds: () => new Set((peerRegistry?.status() ?? []).map((r) => r.peerId)),
    })
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
      rpcResponder: (call) =>
        call.method.startsWith('mcp.') ? proxyRespond(call) : peerManifestHost.respond(call),
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

  // Phase 18 C-M4 — outbound A2A agents. Each configured external A2A endpoint
  // becomes a local Participant, so a normal capability dispatch reaches out
  // over A2A message/send (the mirror of the inbound A2aServer below). Config
  // is a JSON array in AIPE_A2A_AGENTS:
  //   [{ id, capabilities: string[], url, tokenEnv, peerId?, targetSkill? }]
  // The bearer token is read from process.env[tokenEnv] (never inline in the
  // blob) so secrets stay in the usual env channel. Malformed config degrades
  // (logged) instead of crashing boot; a bad/missing-token entry skips itself.
  registerOutboundA2aAgents(hub, log)

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

  // v5 A-M4 — member agent access-grant sharing (an owner shares their agent
  // with other principals). Grants live in identity's resource_grants table, so
  // this is wired only when identity is present; /api/me/agents/:id/grants 503s
  // otherwise.
  const meAgentGrants = identity
    ? new HostMeAgentGrantsService({ identity })
    : undefined

  const web = await serveWeb(hub, {
    host: config.host,
    port: config.webPort,
    cookieSecure: config.cookieSecure,
    lifecycle: localAgents,
    reconcileHeartbeats,
    mcpRegistry,
    mcpFederation,
    peerManifests: peerFederation,
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
    // Phase 16 — member task inbox; undefined when identity is unwired, in
    // which case /me/inbox degrades (empty list / 503).
    ...(inboxService ? { inbox: inboxService } : {}),
    // Phase 13 M3 — null when no API key / disabled. Web responds 503
    // on /api/admin/workflows/assist in that case so the UI can hide
    // the "AI assistant" button cleanly.
    ...(workflowAssist ? { workflowAssist } : {}),
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
  setTimeout(() => {
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
  if (adminToken) {
    const linkPath = join(SPACE_DIR, 'runtime', 'admin-link.txt')
    const adminUrl = `${web.url}/admin?token=${adminToken}`
    try {
      await writeAdminLinkFile(linkPath, adminUrl)
      console.log(`\nFirst-run admin URL saved to (read once and delete):`)
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
  log.fatal('boot failed', { err })
  process.exit(1)
})
