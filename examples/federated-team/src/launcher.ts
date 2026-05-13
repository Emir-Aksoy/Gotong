/**
 * Federation launcher — spawns upstream-host, team-host, and driver in
 * one terminal. Ctrl-C kills all three. To split them across windows /
 * machines, run `pnpm upstream`, `pnpm team`, and `pnpm driver` instead.
 *
 * Note: the launcher does NOT pass the admin token to driver
 * automatically — it greps it from upstream's stdout, so on second run
 * (token already minted, won't print again) it tells you to delete
 * `.aipehub-upstream/` to mint a new one. Same caveat as open-space.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function child(script: string, env: NodeJS.ProcessEnv = {}): ChildProcess {
  return spawn('tsx', [join(here, script)], {
    stdio: ['inherit', 'pipe', 'inherit'],
    env: { ...process.env, FORCE_COLOR: '1', ...env },
  })
}

function teeWithCapture(p: ChildProcess, tag: string, re: RegExp): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let captured: string | null = null
    p.stdout?.on('data', (buf: Buffer) => {
      const text = buf.toString()
      process.stdout.write(text)
      if (!captured) {
        const m = text.match(re)
        if (m) {
          captured = m[1] ?? null
          resolve(captured)
        }
      }
    })
    p.once('exit', () => {
      if (!captured) resolve(null)
    })
  })
}

async function main(): Promise<void> {
  console.log('=== AipeHub federation demo ===\n')

  const upstream = child('upstream-host.ts')
  const tokenP = teeWithCapture(upstream, 'upstream', /\/admin\?token=([a-f0-9]+)/)

  await sleep(1500)
  const team = child('team-host.ts')
  team.stdout?.pipe(process.stdout)

  // Wait a couple seconds for the bridge to start HELLO'ing
  await sleep(2500)
  const token = await Promise.race([tokenP, sleepAndNull(500)])

  let driver: ChildProcess | undefined
  if (token) {
    console.log(`\n[launcher] captured admin token, starting driver…\n`)
    driver = child('driver.ts', { AIPE_ADMIN_TOKEN: token })
    driver.stdout?.pipe(process.stdout)
  } else {
    console.log(`\n[launcher] couldn't capture admin token (already minted on a previous run).`)
    console.log(`[launcher] Either:`)
    console.log(`[launcher]   - rm -rf .aipehub-upstream  &&  re-run`)
    console.log(`[launcher]   - or paste old token: AIPE_ADMIN_TOKEN=<x> pnpm driver`)
  }

  const onSignal = () => {
    safeKill(upstream)
    safeKill(team)
    if (driver) safeKill(driver)
    process.exit(0)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  await Promise.race([
    onceExit(upstream),
    onceExit(team),
    ...(driver ? [onceExit(driver)] : []),
  ])
  safeKill(upstream)
  safeKill(team)
  if (driver) safeKill(driver)
  process.exit(0)
}

function onceExit(p: ChildProcess): Promise<number> {
  return new Promise((r) => p.once('exit', (code) => r(code ?? 0)))
}
function safeKill(p: ChildProcess): void {
  if (!p.killed) {
    try { p.kill('SIGTERM') } catch { /* ignore */ }
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
function sleepAndNull(ms: number): Promise<null> {
  return sleep(ms).then(() => null)
}

main().catch((err) => {
  console.error('[launcher] fatal:', err)
  process.exit(1)
})
