/**
 * High-fidelity boot smoke: spawn the real `gotong-host` Node process
 * against a fresh temp space and verify all three first-party service
 * plugins reach `ready` state.
 *
 * Why a child_process test (vs. another in-process bootstrapServices
 * call): vitest runs under vite-node, which doesn't enforce the
 * pnpm-isolated `node_modules` walk that real Node ESM does. The
 * production resolver path (`import.meta.resolve(pkg)`) is only
 * exercised when the host actually runs under native Node. This test
 * catches regressions like "someone moved a plugin from host deps to
 * devDeps" that would silently pass in-process tests but break a real
 * deployment.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
// Tests live in `packages/host/tests`, dist is one up: `packages/host/dist/main.js`.
const hostMain = join(here, '..', 'dist', 'main.js')

describe('host process smoke — plugins resolve under native Node', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-host-smoke-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('spawns gotong-host, all three first-party plugins reach "ready", graceful shutdown', async () => {
    if (!existsSync(hostMain)) {
      // CI / local dev may forget to build. Skip rather than false-fail —
      // the rest of the suite covers in-process boot exhaustively.
      console.warn(`[skip] ${hostMain} not built — run 'pnpm --filter @gotong/host build' first`)
      return
    }
    if (process.platform === 'win32') {
      // The test asserts a clean SIGTERM → exit 0 round-trip. On Windows
      // Node maps `child.kill('SIGTERM')` to `TerminateProcess`, which
      // forcibly terminates the child with a non-zero exit code (no
      // chance to run signal handlers). There's no equivalent of a
      // POSIX graceful-shutdown signal on Windows — the right harness
      // is wm_close on a console, which Node doesn't expose. The boot
      // path itself IS exercised by every other in-process test in
      // this package; this one is specifically about POSIX shutdown
      // semantics, so skipping on Windows loses no real coverage.
      console.warn('[skip] services-host-smoke: POSIX SIGTERM not supported on Windows')
      return
    }
    const logFile = join(root, 'host.log')
    const child = spawn(process.execPath, [hostMain], {
      env: {
        ...process.env,
        GOTONG_SPACE: join(root, 'space'),
        GOTONG_WEB_PORT: '0',
        GOTONG_WS_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // Capture combined stdout+stderr to a buffer so we can assert on
    // log content after shutdown. The host writes structured JSON +
    // banner text; we only need the JSON 'comp:services' lines.
    const chunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stderr.on('data', (c: Buffer) => chunks.push(c))

    // Wait for the banner ("=== Gotong host ready ===") which is the
    // last thing main prints before going idle, OR a 6s timeout. Using
    // a banner watch avoids unconditional 4s sleeps in fast CI machines
    // and gives generous margin on slow ones.
    const exitCode: number = await new Promise((resolve, reject) => {
      let booted = false
      const onData = (c: Buffer): void => {
        if (booted) return
        if (Buffer.concat(chunks).toString().includes('Gotong host ready')) {
          booted = true
          // Give the process one more tick to settle (services log line
          // is async after the banner), then SIGTERM. The 50ms is enough
          // for the ready/ deferred log writes.
          setTimeout(() => child.kill('SIGTERM'), 50)
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => resolve(code ?? -1))
      child.on('error', reject)
      // Absolute cap: 10s. If we never see the banner, kill harder.
      setTimeout(() => {
        if (child.exitCode == null) child.kill('SIGKILL')
        reject(new Error(`host did not boot within 10s. Output so far:\n${Buffer.concat(chunks).toString()}`))
      }, 10_000).unref()
    })

    const combined = Buffer.concat(chunks).toString()
    await readFile(logFile, 'utf8').catch(() => {})

    // Process should have shut down cleanly via SIGTERM (exit 0).
    expect(exitCode).toBe(0)

    // All three first-party plugins must show up as 'plugin ready' lines.
    // Format: {"...","msg":"services: plugin ready","type":"memory","impl":"file",...}
    expect(combined).toMatch(/"msg":"services: plugin ready","type":"memory","impl":"file"/)
    expect(combined).toMatch(/"msg":"services: plugin ready","type":"artifact","impl":"file"/)
    expect(combined).toMatch(/"msg":"services: plugin ready","type":"datastore","impl":"sqlite"/)

    // And no plugin should report 'failed to load' — that's the
    // regression we are guarding against.
    expect(combined).not.toMatch(/services: plugin failed to load/)

    // Confirm services data dirs got mkdir'd, proving Phase 2 ran.
    expect(existsSync(join(root, 'space', 'services', 'memory', 'file'))).toBe(true)
    expect(existsSync(join(root, 'space', 'services', 'artifact', 'file'))).toBe(true)
    expect(existsSync(join(root, 'space', 'services', 'datastore', 'sqlite'))).toBe(true)
  }, 20_000)
})
