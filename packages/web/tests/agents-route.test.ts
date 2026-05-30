/**
 * #2-M4a — the agent CRUD route accepts `useMcpServers`.
 *
 * The manifest path (parseManifest) already round-tripped useMcpServers,
 * but the direct POST/PUT /api/admin/agents body validator (validateAgentBody)
 * dropped it silently. That gap meant the M4 admin-UI opt-in checkboxes
 * would never persist. This pins the now-wired behavior:
 *
 *   - POST with useMcpServers → persisted into managed.useMcpServers
 *   - GET list echoes it back (publicAgent returns the whole managed spec)
 *   - PUT can rewrite it (incl. an empty array to clear a prior opt-in)
 *   - a malformed name (regex reject) → 400, nothing persisted
 *
 * No lifecycle is wired, so the provider-key gate is skipped and a `mock`
 * agent persists without a key (see agents-routes.ts: `if (ctx.lifecycle)`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'

import { serveWeb, type WebServerHandle } from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  space: Space
  server: WebServerHandle
  baseUrl: string
  token: string
}

async function boot(): Promise<Boot> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-agents-route-'))
  const init = await Space.init(tmp, { name: 'agents-route-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()
  const { token } = await space.createAdmin('TestAdmin')
  const server = await serveWeb(hub, { host: '127.0.0.1', port: 0 })
  return { tmp, hub, space, server, baseUrl: server.url, token }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}`, 'content-type': 'application/json' })

const base = { provider: 'mock', system: 'you are a test agent', capabilities: ['chat'] }

describe('agents-route: useMcpServers (#2-M4a)', () => {
  let b: Boot
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('POST persists useMcpServers into managed', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'with-mcp', useMcpServers: ['fs', 'search'] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.agent.managed.useMcpServers).toEqual(['fs', 'search'])
    // Really landed on disk.
    const rec = (await b.space.agents()).find((a) => a.id === 'with-mcp')
    expect(rec?.managed.useMcpServers).toEqual(['fs', 'search'])
  })

  it('GET list echoes useMcpServers back', async () => {
    await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'listed', useMcpServers: ['fs'] }),
    })
    const res = await fetch(`${b.baseUrl}/api/admin/agents`, { headers: auth(b.token) })
    expect(res.status).toBe(200)
    const { agents } = await res.json()
    const found = agents.find((a: { id: string }) => a.id === 'listed')
    expect(found.managed.useMcpServers).toEqual(['fs'])
  })

  it('PUT can clear a prior opt-in with an empty array', async () => {
    await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'clearable', useMcpServers: ['fs', 'search'] }),
    })
    const res = await fetch(`${b.baseUrl}/api/admin/agents/clearable`, {
      method: 'PUT',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'clearable', useMcpServers: [] }),
    })
    expect(res.status).toBe(200)
    const rec = (await b.space.agents()).find((a) => a.id === 'clearable')
    expect(rec?.managed.useMcpServers).toEqual([])
  })

  it('omitting useMcpServers leaves it undefined (not coerced to [])', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'no-mcp' }),
    })
    expect(res.status).toBe(200)
    const rec = (await b.space.agents()).find((a) => a.id === 'no-mcp')
    expect(rec?.managed.useMcpServers).toBeUndefined()
  })

  it('a malformed server name → 400, nothing persisted', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'bad-mcp', useMcpServers: ['has space'] }),
    })
    expect(res.status).toBe(400)
    expect((await b.space.agents()).some((a) => a.id === 'bad-mcp')).toBe(false)
  })
})
