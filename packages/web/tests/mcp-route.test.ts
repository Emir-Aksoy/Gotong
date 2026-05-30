/**
 * #2-M2 — /api/admin/mcp-servers routes (hub MCP registry).
 *
 * Coverage:
 *   - 503 when the host didn't wire ctx.mcpRegistry
 *   - 401 when unauthenticated
 *   - GET lists the surface's servers
 *   - POST installs a valid spec (surface called with spec + description)
 *   - POST 400 on a malformed spec / non-string description
 *   - DELETE uninstalls by name; 404 when the name wasn't installed
 *   - 405 on an unsupported method
 *
 * The registry surface is a stub so web tests don't drag in the host's
 * Space + LocalAgentPool (the host-side e2e covers propagation). The
 * route's job here is auth gating + body validation + surface dispatch.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space, type HubMcpServerRecord, type McpServerSpec } from '@aipehub/core'

import {
  serveWeb,
  type McpRegistrySurface,
  type WebServerHandle,
} from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminToken: string
  installCalls: Array<{ spec: McpServerSpec; description?: string; shared?: boolean }>
  uninstallCalls: string[]
  servers: HubMcpServerRecord[]
  uninstallResult: boolean
}

async function boot(opts: { withRegistry?: boolean } = {}): Promise<Boot> {
  const withRegistry = opts.withRegistry ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-mcp-'))
  const init = await Space.init(tmp, { name: 'mcp-route-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const { token: adminToken } = await init.space.createAdmin('TestAdmin')

  const out: Boot = {
    tmp, hub,
    server: undefined as unknown as WebServerHandle,
    baseUrl: '',
    adminToken,
    installCalls: [],
    uninstallCalls: [],
    servers: [],
    uninstallResult: true,
  }

  const stub: McpRegistrySurface = {
    async list() {
      return out.servers
    },
    async install(spec, description, shared) {
      out.installCalls.push({
        spec,
        ...(description !== undefined ? { description } : {}),
        ...(shared !== undefined ? { shared } : {}),
      })
      const rec: HubMcpServerRecord = {
        spec,
        createdAt: '2026-05-30T00:00:00.000Z',
        ...(description !== undefined ? { description } : {}),
        ...(shared !== undefined ? { shared } : {}),
      }
      return rec
    },
    async uninstall(name) {
      out.uninstallCalls.push(name)
      return out.uninstallResult
    },
  }

  out.server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(withRegistry ? { mcpRegistry: stub } : {}),
  })
  out.baseUrl = out.server.url
  return out
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

const auth = (b: Boot) => ({ authorization: `Bearer ${b.adminToken}` })

describe('/api/admin/mcp-servers (#2-M2)', () => {
  let b: Boot
  afterEach(async () => { await teardown(b) })

  it('503 when the registry surface is not wired', async () => {
    b = await boot({ withRegistry: false })
    const r = await fetch(`${b.baseUrl}/api/admin/mcp-servers`, { headers: auth(b) })
    expect(r.status).toBe(503)
  })

  it('401 when unauthenticated', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/mcp-servers`)
    expect(r.status).toBe(401)
  })

  it('GET lists the registry servers', async () => {
    b = await boot()
    b.servers = [
      { spec: { name: 'fs', command: 'npx' }, createdAt: '2026-05-30T00:00:00.000Z' },
    ]
    const r = await fetch(`${b.baseUrl}/api/admin/mcp-servers`, { headers: auth(b) })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.servers).toHaveLength(1)
    expect(j.servers[0].spec.name).toBe('fs')
  })

  it('POST installs a valid spec (surface gets spec + description)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/mcp-servers`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({
        spec: { name: 'hosted', transport: 'http', url: 'https://mcp.example.com' },
        description: 'a hosted server',
      }),
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.ok).toBe(true)
    expect(j.server.spec.name).toBe('hosted')
    expect(b.installCalls).toHaveLength(1)
    expect(b.installCalls[0]!.spec).toMatchObject({ transport: 'http', url: 'https://mcp.example.com' })
    expect(b.installCalls[0]!.description).toBe('a hosted server')
  })

  it('POST 400 on a malformed spec (http without url)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/mcp-servers`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { name: 'bad', transport: 'http' } }),
    })
    expect(r.status).toBe(400)
    expect(b.installCalls).toHaveLength(0)
  })

  it('POST 400 on a non-string description', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/mcp-servers`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { name: 'fs', command: 'npx' }, description: 42 }),
    })
    expect(r.status).toBe(400)
  })

  it('POST threads the shared flag through to the surface (#2-M3.4a)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/mcp-servers`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { name: 'fs', command: 'npx' }, shared: true }),
    })
    expect(r.status).toBe(200)
    expect((await r.json()).server.shared).toBe(true)
    expect(b.installCalls[0]!.shared).toBe(true)
  })

  it('POST shared:false is forwarded (revoke), not dropped', async () => {
    b = await boot()
    await fetch(`${b.baseUrl}/api/admin/mcp-servers`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { name: 'fs', command: 'npx' }, shared: false }),
    })
    expect(b.installCalls[0]!.shared).toBe(false)
  })

  it('POST omitting shared leaves it untouched (undefined to surface)', async () => {
    b = await boot()
    await fetch(`${b.baseUrl}/api/admin/mcp-servers`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { name: 'fs', command: 'npx' } }),
    })
    expect(b.installCalls[0]!.shared).toBeUndefined()
  })

  it('POST 400 on a non-boolean shared', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/mcp-servers`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { name: 'fs', command: 'npx' }, shared: 'yes' }),
    })
    expect(r.status).toBe(400)
    expect(b.installCalls).toHaveLength(0)
  })

  it('DELETE uninstalls by name', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/mcp-servers/fs`, {
      method: 'DELETE',
      headers: auth(b),
    })
    expect(r.status).toBe(200)
    expect((await r.json()).ok).toBe(true)
    expect(b.uninstallCalls).toEqual(['fs'])
  })

  it('DELETE 404 when the name was not installed', async () => {
    b = await boot()
    b.uninstallResult = false
    const r = await fetch(`${b.baseUrl}/api/admin/mcp-servers/ghost`, {
      method: 'DELETE',
      headers: auth(b),
    })
    expect(r.status).toBe(404)
  })

  it('405 on an unsupported method', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/mcp-servers`, {
      method: 'PUT',
      headers: auth(b),
    })
    expect(r.status).toBe(405)
  })
})
