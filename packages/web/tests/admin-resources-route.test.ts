/**
 * RES-M1 — /api/admin/resources route.
 *
 * The read-only resource inventory for the admin "resource adaptation" panel.
 * The probe itself lives host-side (host/src/resource-inventory.ts, unit-tested
 * in host/tests/resource-inventory.test.ts); here we pin only the web seam: the
 * requireAdmin gate, the 503 when no surface is wired (panel hides instead of
 * erroring), and the verbatim echo of whatever the surface returns.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import {
  serveWeb,
  type ResourceInventorySurface,
  type ResInventorySnapshot,
  type WebServerHandle,
} from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminToken: string
}

/** A canned snapshot the stub surface echoes — one env key, a live Ollama, claude on PATH. */
function snap(over: Partial<ResInventorySnapshot> = {}): ResInventorySnapshot {
  return {
    llmKeys: [
      { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY', envSet: true, vaultConfigured: false },
      { provider: 'deepseek', envVar: 'DEEPSEEK_API_KEY', envSet: false, vaultConfigured: true },
    ],
    localEndpoints: [{ label: 'Ollama', url: 'http://127.0.0.1:11434/api/tags', reachable: true }],
    cliAgents: [
      { command: 'claude', label: 'Claude Code', found: true, apiKeyEnv: 'ANTHROPIC_API_KEY', apiKeyEnvSet: true },
      { command: 'codex', label: 'OpenAI Codex', found: false, apiKeyEnv: 'OPENAI_API_KEY', apiKeyEnvSet: false },
    ],
    mcpServers: [{ name: 'chroma' }],
    checkedAt: '2026-07-02T00:00:00.000Z',
    ...over,
  }
}

async function boot(opts: { wired?: boolean } = {}): Promise<Boot> {
  const wired = opts.wired ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-admin-resources-'))
  const init = await Space.init(tmp, { name: 'admin-resources-route-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const { token: adminToken } = await init.space.createAdmin('TestAdmin')

  const surface: ResourceInventorySurface = {
    async inventory() {
      return snap()
    },
  }

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(wired ? { resourceInventory: surface } : {}),
  })

  return { tmp, hub, server, baseUrl: server.url, adminToken }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

const auth = (b: Boot) => ({ authorization: `Bearer ${b.adminToken}` })
const RESOURCES = '/api/admin/resources'

describe('/api/admin/resources (RES-M1)', () => {
  let b: Boot
  afterEach(async () => {
    await teardown(b)
  })

  it('401 when unauthenticated', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${RESOURCES}`)
    expect(r.status).toBe(401)
  })

  it('503 when the surface is not wired (panel hides, not errors)', async () => {
    b = await boot({ wired: false })
    const r = await fetch(`${b.baseUrl}${RESOURCES}`, { headers: auth(b) })
    expect(r.status).toBe(503)
  })

  it('GET echoes the inventory verbatim for an admin', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${RESOURCES}`, { headers: auth(b) })
    expect(r.status).toBe(200)
    const j = (await r.json()) as ResInventorySnapshot
    expect(j).toEqual(snap())
    // the panel's headline signals survive the round-trip
    expect(j.llmKeys.find((k) => k.provider === 'anthropic')).toMatchObject({ envSet: true })
    expect(j.localEndpoints[0]).toMatchObject({ label: 'Ollama', reachable: true })
    expect(j.cliAgents.find((c) => c.command === 'claude')).toMatchObject({ found: true })
    expect(j.mcpServers).toEqual([{ name: 'chroma' }])
  })
})
