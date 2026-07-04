/**
 * Launcher for the remote-python demo. Spawns the TypeScript host.ts and
 * the Python worker.py as two child processes, streams both stdio streams
 * into this terminal, and shuts both down when either exits.
 *
 * Uses the project's python-sdk venv at `python-sdk/.venv/bin/python`.
 * If you'd rather drive each side from a separate shell, run
 *   pnpm host
 * here and
 *   ./python-sdk/.venv/bin/python examples/remote-python/src/worker.py
 * from another terminal.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const venvPython = join(repoRoot, 'python-sdk', '.venv', 'bin', 'python')

async function main(): Promise<void> {
  console.log('=== Gotong remote-python demo ===\n')

  if (!existsSync(venvPython)) {
    console.error(
      `[launcher] python venv not found at ${venvPython}\n` +
        `            set it up with:\n` +
        `              cd python-sdk\n` +
        `              python3.12 -m venv .venv\n` +
        `              .venv/bin/pip install -e ".[test]"`,
    )
    process.exit(2)
  }

  const host = spawn('tsx', [join(here, 'host.ts')], {
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  })

  await sleep(800)

  const worker = spawn(venvPython, [join(here, 'worker.py')], {
    stdio: 'inherit',
    env: { ...process.env, PYTHONUNBUFFERED: '1', FORCE_COLOR: '1' },
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
  safeKill(host)
  safeKill(worker)
  await Promise.all([hostExit, workerExit])
  process.exit(0)
}

function onceExit(p: ChildProcess): Promise<number> {
  return new Promise((res) => p.once('exit', (code) => res(code ?? 0)))
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
