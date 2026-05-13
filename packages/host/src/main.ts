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
 *
 * On first launch the space dir is created and a one-time admin URL is
 * printed to stdout. On subsequent launches the printout shows just the
 * /admin entry — admins keep their existing cookies / tokens.
 *
 * The process responds to SIGTERM and SIGINT by closing the listeners,
 * draining the SSE clients, stopping the hub, and exiting cleanly.
 */

import { readFileSync } from 'node:fs'

import { Hub, Space, type SpaceConfig, type TranscriptEntry } from '@aipehub/core'
import { serveWebSocket } from '@aipehub/transport-ws'
import { serveWeb } from '@aipehub/web'

import { LocalAgentPool } from './local-agent-pool.js'

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

function pkgVersion(): string {
  try {
    const url = new URL('../package.json', import.meta.url)
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function printUsage(): void {
  process.stdout.write(`Usage: aipehub-host [--help] [--version]

Production AipeHub host. Reads all configuration from environment
variables (12-factor style). No CLI flags drive runtime behavior — set
the env, run the command. The same binary works for local dev, LAN
deployments, and public VPS behind Caddy / nginx.

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
  https://github.com/AipeHub/AipeHub/blob/main/docs/OVERVIEW.md
  https://github.com/AipeHub/AipeHub/blob/main/docs/DEPLOY.md
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

  // The LocalAgentPool materialises every `agents.json` row that carries
  // a `managed` spec into a live LlmAgent on the Hub. Not a separate
  // service — just a piece of host startup. Run before the Web server
  // boots so API responses include managed agents from the first call.
  const localAgents = new LocalAgentPool({ hub, space })
  await localAgents.start()

  const allowedHosts = envList('AIPE_ALLOWED_HOSTS')
  const adminRateMax = envInt('AIPE_ADMIN_RATE_MAX', 10)
  const adminRateSec = envInt('AIPE_ADMIN_RATE_SEC', 60)

  const ws = await serveWebSocket(hub, {
    host: config.host,
    port: config.wsPort,
    gating: config.gating,
  })
  const web = await serveWeb(hub, {
    host: config.host,
    port: config.webPort,
    cookieSecure: config.cookieSecure,
    lifecycle: localAgents,
    ...(allowedHosts ? { allowedHosts } : {}),
    adminLoginRateLimit: { max: adminRateMax, windowSec: adminRateSec },
  })

  console.log(`\n=== AipeHub host ready ===`)
  console.log(`Space     : ${SPACE_DIR}`)
  console.log(`Web       : ${web.url}`)
  console.log(`WebSocket : ${ws.url}`)
  console.log(`Gating    : ${config.gating}`)
  console.log(`CookieSec : ${config.cookieSecure ? 'on (HTTPS expected)' : 'off (HTTP / dev)'}`)
  console.log(`HostCheck : ${allowedHosts ? allowedHosts.join(', ') : 'disabled (loopback only is safe)'}`)
  if (adminToken) {
    console.log(`\nFirst-run admin URL (shown ONCE — save it):`)
    console.log(`  ${web.url}/admin?token=${adminToken}\n`)
  } else {
    console.log(`Admin     : ${web.url}/admin    (existing cookie or token)\n`)
  }

  let shuttingDown = false
  const shutdown = async (sig: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[host] ${sig} received — draining…`)
    try { await ws.close() } catch (err) { console.error('[host] ws close error:', err) }
    try { await web.close() } catch (err) { console.error('[host] web close error:', err) }
    try { await localAgents.stopAll() } catch (err) { console.error('[host] local agents stop error:', err) }
    try { await hub.stop() } catch (err) { console.error('[host] hub stop error:', err) }
    console.log('[host] stopped cleanly.')
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
  }
}

main().catch((err) => {
  console.error('[host] fatal:', err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
})
