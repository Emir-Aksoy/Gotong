/**
 * Launcher that spawns host.ts and worker.ts as two processes and streams
 * both stdio streams into this terminal. Ctrl-C kills both.
 *
 * If you'd rather drive each side from a separate shell, skip this file
 * and run `pnpm host` + `pnpm worker` in two terminals instead.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
  console.log('=== Gotong remote-agent demo ===\n')

  const host = spawn('tsx', [join(here, 'host.ts')], {
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  })

  // give the host a moment to start its WebSocket server
  await sleep(800)

  const worker = spawn('tsx', [join(here, 'worker.ts')], {
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  })

  const onSignal = () => {
    safeKill(host)
    safeKill(worker)
    process.exit(0)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  const hostExit = onceExit(host)
  const workerExit = onceExit(worker)
  await Promise.race([hostExit, workerExit])
  // whoever exits first, ensure the other follows
  safeKill(host)
  safeKill(worker)
  await Promise.all([hostExit, workerExit])
  process.exit(0)
}

function onceExit(p: ChildProcess): Promise<number> {
  return new Promise((resolve) => p.once('exit', (code) => resolve(code ?? 0)))
}

function safeKill(p: ChildProcess): void {
  if (!p.killed) {
    try {
      p.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err) => {
  console.error('[launcher] fatal:', err)
  process.exit(1)
})
