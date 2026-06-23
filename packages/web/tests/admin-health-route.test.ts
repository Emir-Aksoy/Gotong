/**
 * ❷-M1 — /api/admin/health route.
 *
 * The read-only "hub 体检" snapshot for the admin overview panel. The aggregation
 * itself lives host-side (host/src/admin-health.ts, unit-tested in
 * host/tests/admin-health.test.ts); here we pin only the web seam: the
 * requireAdmin gate, the 503 when no surface is wired (so the panel hides instead
 * of erroring), and the verbatim echo of whatever the surface returns.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'

import {
  serveWeb,
  type AdminHealthSurface,
  type HealthSnapshot,
  type WebServerHandle,
} from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminToken: string
}

/** A canned snapshot the stub surface echoes — one red agent, one unwired MCP. */
function snap(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    agents: [
      { id: 'mentor', provider: 'deepseek', missingKey: true, online: false },
      { id: 'writer', provider: 'anthropic', missingKey: false, online: true },
    ],
    agentsMissingKey: 1,
    managedCount: 2,
    onlineCount: 1,
    mcpServers: [
      { name: 'chroma', wired: true },
      { name: 'obsidian', wired: false },
    ],
    mcpUnwired: 1,
    spaceWritable: true,
    spacePath: '/data/.aipehub',
    checkedAt: '2026-06-23T00:00:00.000Z',
    ...over,
  }
}

async function boot(opts: { wired?: boolean } = {}): Promise<Boot> {
  const wired = opts.wired ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-admin-health-'))
  const init = await Space.init(tmp, { name: 'admin-health-route-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const { token: adminToken } = await init.space.createAdmin('TestAdmin')

  const surface: AdminHealthSurface = {
    async snapshot() {
      return snap()
    },
  }

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(wired ? { adminHealth: surface } : {}),
  })

  return { tmp, hub, server, baseUrl: server.url, adminToken }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

const auth = (b: Boot) => ({ authorization: `Bearer ${b.adminToken}` })
const HEALTH = '/api/admin/health'

describe('/api/admin/health (ease-of-use ❷-M1)', () => {
  let b: Boot
  afterEach(async () => {
    await teardown(b)
  })

  it('401 when unauthenticated', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${HEALTH}`)
    expect(r.status).toBe(401)
  })

  it('503 when the surface is not wired (panel hides, not errors)', async () => {
    b = await boot({ wired: false })
    const r = await fetch(`${b.baseUrl}${HEALTH}`, { headers: auth(b) })
    expect(r.status).toBe(503)
  })

  it('GET echoes the snapshot verbatim for an admin', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${HEALTH}`, { headers: auth(b) })
    expect(r.status).toBe(200)
    const j = (await r.json()) as HealthSnapshot
    expect(j).toEqual(snap())
    // the panel's headline counts survive the round-trip
    expect(j.agentsMissingKey).toBe(1)
    expect(j.managedCount).toBe(2)
    expect(j.onlineCount).toBe(1)
    expect(j.mcpUnwired).toBe(1)
    // a flagged agent carries enough for the frontend to render a fix link
    expect(j.agents.find((a) => a.id === 'mentor')).toMatchObject({
      provider: 'deepseek',
      missingKey: true,
    })
  })
})
