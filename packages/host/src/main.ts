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

import { BAKED_VERSION } from './version.js'

const log = createLogger('host')
import { serveWebSocket } from '@aipehub/transport-ws'
import { serveWeb } from '@aipehub/web'

import { LocalAgentPool } from './local-agent-pool.js'
import {
  BINARY_SAFE_PLUGINS,
  bootstrapServices,
  isCompiledBinary,
  LifecycleSweeper,
  type HubServices,
} from './services/index.js'
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

  const hub = new Hub({ space })
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
  const localAgents = new LocalAgentPool({ hub, space, services })
  await localAgents.start()

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
    ...(allowedHosts ? { allowedHosts } : {}),
    adminLoginRateLimit: { max: adminRateMax, windowSec: adminRateSec },
    readinessGate: { isReady: () => bootReady },
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
    try { await ws.close() } catch (err) { log.error('ws close error', { err }) }
    try { await web.close() } catch (err) { log.error('web close error', { err }) }
    try { await localAgents.stopAll() } catch (err) { log.error('local agents stop error', { err }) }
    if (sweeper) {
      try { await sweeper.stop() } catch (err) { log.error('sweeper stop error', { err }) }
    }
    if (services) {
      try { await services.shutdownAll() } catch (err) { log.error('services shutdown error', { err }) }
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
  }
}

main().catch((err) => {
  log.fatal('boot failed', { err })
  process.exit(1)
})
