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

import { Hub, Space, createLogger, type SpaceConfig, type TranscriptEntry } from '@aipehub/core'
import {
  AUDIT_ACTIONS,
  loadOrCreateMasterKey,
  openIdentityStore,
  type IdentityStore,
} from '@aipehub/identity'

import { OrgApiPool } from './org-api-pool.js'

import { BAKED_VERSION } from './version.js'

const log = createLogger('host')
import { serveWebSocket } from '@aipehub/transport-ws'
import { PeerRegistry } from './peer-registry.js'
import { serveWeb } from '@aipehub/web'

import { LocalAgentPool } from './local-agent-pool.js'
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
  AIPE_ADMIN_RATE_MAX     admin login attempts per IP per window (default: 10)
  AIPE_ADMIN_RATE_SEC     rate-limit window in seconds (default: 60)
  AIPE_DEFAULT_LANG       'zh' | 'en' (default: zh)
  AIPE_HEARTBEAT_MS       transport heartbeat ms (default: 30000)
  AIPE_SPACE_NAME         label for space.json on first init (default: AipeHub)
  AIPE_ADMIN_DISPLAY_NAME first admin's display name (default: Operator)
  AIPE_WORKFLOWS_DIR      directory of *.yaml/*.json workflow files to
                          auto-load on boot
                          (default: <AIPE_SPACE>/workflows/definitions)

  AIPE_SECRET_KEY         optional master key for secrets encryption
                          (64 hex chars; overrides on-disk runtime/secret.key)
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
    // B1.2 — also load the vault master key from the same workspace.
    // `loadOrCreateMasterKey` creates the file 0600 on first run; a
    // pre-existing file with the wrong length throws (a stale key
    // means existing vault rows can't decrypt — fail loudly).
    const masterKey = loadOrCreateMasterKey(
      join(SPACE_DIR, 'identity-master.key'),
    )
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
  const localAgents = new LocalAgentPool({
    hub,
    space,
    services,
    orgApiPool,
    // Phase 6 #2 — when present, LocalAgentPool wires an onAuthFailure
    // hook for LLM agents whose key came from the vault. A 401 from
    // the provider revokes that vault entry + writes audit + flushes
    // the OrgApiPool cache so next call doesn't reuse the dead key.
    ...(identity ? { identity } : {}),
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
  // never blocks host boot.
  const workflowsDir = env('AIPE_WORKFLOWS_DIR', join(SPACE_DIR, 'workflows', 'definitions'))!
  const workflowReport = await loadWorkflows({
    hub,
    dir: workflowsDir,
    spaceRoot: SPACE_DIR,
  })
  const wfMsg = formatLoadReport(workflowReport)
  if (wfMsg) log.info('workflow loader', { report: wfMsg })
  const workflowController = createWorkflowController(
    { hub, definitionsDir: workflowsDir, spaceRoot: SPACE_DIR },
    workflowReport,
  )

  const allowedHosts = envList('AIPE_ALLOWED_HOSTS')
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
    peerRegistry = new PeerRegistry({
      hub,
      identity,
      selfHubId,
      wss: ws.wss,
      ...(inboundToken ? { sharedInboundPeerToken: inboundToken } : {}),
      pollIntervalMs: pollMs,
      inboundRateLimit,
      ...(trustProxy ? { trustProxy: true } : {}),
      logger: log,
    })
    peerRegistry.start()
    // D2 — make this registry visible to the Hub's cross-hub resolver
    // closure declared above. From here on, any explicit dispatch whose
    // target isn't local + whose task.origin points at a connected peer
    // will be forwarded over the live HubLink.
    peerRegistryRef = peerRegistry
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
  const web = await serveWeb(hub, {
    host: config.host,
    port: config.webPort,
    cookieSecure: config.cookieSecure,
    lifecycle: localAgents,
    workflows: workflowController,
    // services may be undefined if bootstrap failed; serveWeb handles
    // that by responding 503 on the /api/admin/services/* routes.
    ...(services ? { services: services.asAdminSurface() } : {}),
    // Phase 9 M4 — multimodal file upload backing. `undefined` is
    // handled by /api/admin/uploads with a clean 503.
    ...(uploads ? { uploads } : {}),
    growthReports,
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
  console.log(`HostCheck : ${allowedHosts ? allowedHosts.join(', ') : 'disabled (loopback only is safe)'}`)
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
  }
}

main().catch((err) => {
  log.fatal('boot failed', { err })
  process.exit(1)
})
