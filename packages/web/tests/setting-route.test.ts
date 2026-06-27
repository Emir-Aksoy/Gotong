/**
 * setting-ops M4 — /api/admin/setting/* routes (the WEB surface of the unified
 * deterministic ops console).
 *
 * The ops engine + tier chokepoint live host-side (host/src/ops-core.ts, unit-
 * tested in host/tests/ops-core.test.ts; the real-stack physical boundary is the
 * M6 e2e). Here we pin only the web seam, exactly like admin-health-route.test.ts:
 *
 *   • requireAdmin gate            → 401 unauthenticated
 *   • 503 when no surface wired     (the tab hides instead of erroring)
 *   • GET /commands echoes the annotated catalog (every tier LISTED, with
 *     runnableHere flags — the whole lifecycle is visible)
 *   • POST /run executes one command and echoes the result
 *   • the BOUNDARY, made visible by what is ABSENT: a destructive id reaching
 *     /run is refused by the host chokepoint (OpsTierError → 403), and there is
 *     NO dedicated destructive route — a fabricated POST /api/admin/setting/restore
 *     lands at 404 because no such route exists.
 *
 * The stub surface emulates the host's OpsTierError by throwing an error whose
 * `.code` is `destructive_offline_cli_only`; the route maps that code → 403. We do
 * NOT re-prove the chokepoint here (that's the host's job) — we prove the web layer
 * surfaces it as a refusal and exposes no destructive entry point.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'

import {
  serveWeb,
  type SettingCommandInfo,
  type SettingOpsActor,
  type SettingOpsResult,
  type SettingOpsSurface,
  type WebServerHandle,
} from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminToken: string
}

/** The canned catalog the stub surface lists — one row per tier, with the
 *  runnableHere flag the web surface annotates (destructive is display-only). */
function catalog(): SettingCommandInfo[] {
  return [
    { id: 'status', tier: 'read', title: 'status', summary: 'hub status snapshot', runnableHere: true },
    { id: 'fix-dirs', tier: 'safe-mutate', title: 'fix-dirs', summary: 'create missing dirs', runnableHere: true },
    {
      id: 'config-set',
      tier: 'config-write',
      title: 'config-set',
      summary: 'write a managed env knob',
      whereToRun: 'owner',
      runnableHere: true,
    },
    {
      id: 'restore',
      tier: 'destructive-offline',
      title: 'restore',
      summary: 'restore from backup',
      whereToRun: 'cli',
      // display-only on the web surface — the hub is down during a restore, so
      // only the server CLI can run it.
      runnableHere: false,
    },
  ]
}

/** An OpsTierError-shaped throwable — the host chokepoint refusing a
 *  destructive id. The route maps `.code` → HTTP. */
function tierError(code: string, message: string): Error {
  const e = new Error(message) as Error & { code: string }
  e.code = code
  return e
}

async function boot(opts: { wired?: boolean } = {}): Promise<Boot> {
  const wired = opts.wired ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-setting-'))
  const init = await Space.init(tmp, { name: 'setting-route-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const { token: adminToken } = await init.space.createAdmin('TestAdmin')

  const surface: SettingOpsSurface = {
    async list(_actor: SettingOpsActor) {
      return catalog()
    },
    async run(id: string, args: readonly string[], _actor: SettingOpsActor): Promise<SettingOpsResult> {
      // The chokepoint: destructive ids are refused even if hand-crafted into
      // /run — the host throws OpsTierError, the route maps it to 403.
      if (id === 'restore' || id === 'cold-start' || id === 'rotate-master-key') {
        throw tierError('destructive_offline_cli_only', `${id} is CLI-only — run it from the server CLI`)
      }
      if (id === 'status') {
        return { command: 'status', tier: 'read', lines: ['hub: up', 'agents: 2'], data: { up: true } }
      }
      if (id === 'fix-dirs') {
        return { command: 'fix-dirs', tier: 'safe-mutate', lines: [`created 0 dir(s) (args: ${args.join(' ')})`] }
      }
      throw tierError('unknown_command', `unknown command: ${id}`)
    },
  }

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(wired ? { settingOps: surface } : {}),
  })

  return { tmp, hub, server, baseUrl: server.url, adminToken }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

const auth = (b: Boot) => ({ authorization: `Bearer ${b.adminToken}` })
const BASE = '/api/admin/setting'

describe('/api/admin/setting/* (setting-ops M4)', () => {
  let b: Boot
  afterEach(async () => {
    await teardown(b)
  })

  it('401 when unauthenticated', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${BASE}/commands`)
    expect(r.status).toBe(401)
  })

  it('503 when the surface is not wired (tab hides, not errors)', async () => {
    b = await boot({ wired: false })
    const r = await fetch(`${b.baseUrl}${BASE}/commands`, { headers: auth(b) })
    expect(r.status).toBe(503)
  })

  it('GET /commands lists the whole lifecycle, with runnableHere flags', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${BASE}/commands`, { headers: auth(b) })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { commands: SettingCommandInfo[] }
    const ids = j.commands.map((c) => c.id)
    // every tier is listed so the operator sees the complete lifecycle...
    expect(ids).toContain('status')
    expect(ids).toContain('fix-dirs')
    expect(ids).toContain('config-set')
    expect(ids).toContain('restore')
    // ...but the destructive one is display-only on the web surface.
    const restore = j.commands.find((c) => c.id === 'restore')!
    expect(restore.tier).toBe('destructive-offline')
    expect(restore.runnableHere).toBe(false)
    const status = j.commands.find((c) => c.id === 'status')!
    expect(status.runnableHere).toBe(true)
  })

  it('POST /run executes a read command and echoes the result', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${BASE}/run`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'status' }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { result: SettingOpsResult }
    expect(j.result.command).toBe('status')
    expect(j.result.tier).toBe('read')
    expect(j.result.lines).toContain('hub: up')
  })

  it('POST /run with no id → 400', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${BASE}/run`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(400)
  })

  // ── the boundary, proven by the web half ────────────────────────────────────

  it('POST /run {id:"restore"} → 403 (host OpsTierError chokepoint surfaces as refusal)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${BASE}/run`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'restore' }),
    })
    expect(r.status).toBe(403)
    const j = (await r.json()) as { error: string; message?: string }
    expect(j.error).toBe('destructive_offline_cli_only')
    // the refusal tells the operator where to run it instead
    expect(j.message ?? '').toMatch(/CLI/i)
  })

  it('there is NO dedicated destructive route — POST /api/admin/setting/restore → 404', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${BASE}/restore`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'x', target: 'y' }),
    })
    // we OWN the /api/admin/setting prefix, so this is answered (not fall-through)
    // as an unknown sub-route: 404. No restore endpoint exists by construction.
    expect(r.status).toBe(404)
  })
})
