/**
 * Open Space launcher — spawns host (Hub + WebSocket + Web) and writer
 * agent (sdk-node) as two child processes, with everything routed to
 * this terminal. Ctrl-C kills both.
 *
 * To drive each side from a separate shell, skip this and run
 *   pnpm host
 *   pnpm agent
 * in two terminals.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
  console.log('=== Gotong Open Space demo ===\n')

  const host = spawn('tsx', [join(here, 'host.ts')], {
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  })

  // give the host a moment to start its WebSocket + Web servers
  await sleep(1200)

  const agent = spawn('tsx', [join(here, 'agent.ts')], {
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  })

  const onSignal = () => {
    safeKill(host)
    safeKill(agent)
    process.exit(0)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  const hostExit = onceExit(host)
  const agentExit = onceExit(agent)
  await Promise.race([hostExit, agentExit])
  safeKill(host)
  safeKill(agent)
  await Promise.all([hostExit, agentExit])
  process.exit(0)
}

function onceExit(p: ChildProcess): Promise<number> {
  return new Promise((resolve) => p.once('exit', (code) => resolve(code ?? 0)))
}

function safeKill(p: ChildProcess): void {
  if (!p.killed) {
    try { p.kill('SIGTERM') } catch { /* ignore */ }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err) => {
  console.error('[launcher] fatal:', err)
  process.exit(1)
})
