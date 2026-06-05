/**
 * ACP-OUT-M3 — /api/admin/acp-agents CRUD.
 *
 * An admin registers the coding agents (Claude Code / Codex) this hub drives
 * over long-lived ACP sessions. Driven through a real serveWeb with a STUB
 * AcpAgentAdminSurface — the store is covered in
 * identity/tests/acp-agent-store.test.ts and the hub-sync in
 * host/tests/acp-outbound.test.ts; here we pin auth gating, body validation
 * (mandatory id/command + non-empty capabilities + array args), and the
 * create/update/delete dispatch.
 *
 * Unlike A2A there is NOTHING secret in the view — not even an env-var pointer.
 * An ACP bridge rides the underlying agent's own login, so the whole record
 * (command/args/cwd) is carried in full. It also carries host-joined runtime
 * liveness (`active` / `inactiveReason`), so the UI can tell "saved but inactive:
 * disabled" from "running".
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'

import {
  serveWeb,
  type AcpAgentAdminSurface,
  type AcpAgentView,
  type WebServerHandle,
} from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminToken: string
  rows: AcpAgentView[]
  addCalls: unknown[]
  updateCalls: Array<{ id: string; patch: unknown }>
  removeCalls: string[]
  addThrows: { code: string } | null
  removeReturns: boolean
}

function view(over: Partial<AcpAgentView> = {}): AcpAgentView {
  return {
    id: 'claude-code',
    capabilities: ['code', 'review'],
    command: 'npx',
    args: ['@zed-industries/claude-code-acp'],
    cwd: null,
    enabled: true,
    label: null,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    ...over,
  }
}

async function boot(opts: { wired?: boolean } = {}): Promise<Boot> {
  const wired = opts.wired ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-acp-admin-'))
  const init = await Space.init(tmp, { name: 'acp-admin-route-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const { token: adminToken } = await init.space.createAdmin('TestAdmin')

  const out: Boot = {
    tmp,
    hub,
    server: undefined as unknown as WebServerHandle,
    baseUrl: '',
    adminToken,
    rows: [],
    addCalls: [],
    updateCalls: [],
    removeCalls: [],
    addThrows: null,
    removeReturns: true,
  }

  const surface: AcpAgentAdminSurface = {
    list() {
      return out.rows
    },
    add(input) {
      out.addCalls.push(input)
      if (out.addThrows) throw out.addThrows
      return view({ id: (input as { id: string }).id })
    },
    update(id, patch) {
      out.updateCalls.push({ id, patch })
      return view({ id })
    },
    remove(id) {
      out.removeCalls.push(id)
      return out.removeReturns
    },
  }

  out.server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(wired ? { acpAgents: surface } : {}),
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
const jsonAuth = (b: Boot) => ({ ...auth(b), 'content-type': 'application/json' })
const AGENTS = '/api/admin/acp-agents'

describe('/api/admin/acp-agents (ACP-OUT-M3)', () => {
  let b: Boot
  afterEach(async () => {
    await teardown(b)
  })

  it('503 when the surface is not wired (no identity store)', async () => {
    b = await boot({ wired: false })
    const r = await fetch(`${b.baseUrl}${AGENTS}`, { headers: auth(b) })
    expect(r.status).toBe(503)
  })

  it('401 when unauthenticated', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`)
    expect(r.status).toBe(401)
  })

  it('GET lists agents; command/args + runtime liveness are carried, no secret', async () => {
    b = await boot()
    b.rows = [
      view({ id: 'live', active: true }),
      view({ id: 'off', active: false, inactiveReason: 'disabled', enabled: false }),
    ]
    const r = await fetch(`${b.baseUrl}${AGENTS}`, { headers: auth(b) })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.agents).toHaveLength(2)
    expect(j.agents[0].command).toBe('npx')
    expect(j.agents[0].args).toEqual(['@zed-industries/claude-code-acp'])
    // honest liveness: a disabled row reads inactive with a reason, not "running".
    expect(j.agents[1].active).toBe(false)
    expect(j.agents[1].inactiveReason).toBe('disabled')
    // no credential of any kind in the wire shape
    expect(JSON.stringify(j)).not.toContain('token')
    expect(JSON.stringify(j)).not.toContain('secret')
  })

  it('POST registers an agent (201) and forwards all fields to the store', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({
        id: 'my-codex',
        capabilities: ['code'],
        command: 'codex-acp',
        args: ['--foo'],
        cwd: '/repos/app',
        label: 'My Codex',
      }),
    })
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j.agent.id).toBe('my-codex')
    const sent = b.addCalls[0] as {
      id: string
      capabilities: string[]
      command: string
      args: string[]
      cwd: string
      label: string
    }
    expect(sent.id).toBe('my-codex')
    expect(sent.capabilities).toEqual(['code'])
    expect(sent.command).toBe('codex-acp')
    expect(sent.args).toEqual(['--foo'])
    expect(sent.cwd).toBe('/repos/app')
    expect(sent.label).toBe('My Codex')
  })

  it('POST accepts an omitted args (a bare binary needs no argv)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({ id: 'bare', capabilities: ['code'], command: 'codex-acp' }),
    })
    expect(r.status).toBe(201)
    expect((b.addCalls[0] as { args?: unknown }).args).toBeUndefined()
  })

  it('POST 400 on a missing mandatory field (command)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({ id: 'x', capabilities: ['a'] }),
    })
    expect(r.status).toBe(400)
    expect(b.addCalls).toHaveLength(0)
  })

  it('POST 400 on empty capabilities (a no-capability agent can never be dispatched)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({ id: 'x', capabilities: [], command: 'npx' }),
    })
    expect(r.status).toBe(400)
    expect(b.addCalls).toHaveLength(0)
  })

  it('POST 400 when args is not an array (a stringified command line is a footgun)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({ id: 'x', capabilities: ['a'], command: 'npx', args: '--foo' }),
    })
    expect(r.status).toBe(400)
    expect(b.addCalls).toHaveLength(0)
  })

  it('POST maps a duplicate id to 409', async () => {
    b = await boot()
    b.addThrows = { code: 'acp_agent_exists' }
    const r = await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({ id: 'dup', capabilities: ['a'], command: 'npx' }),
    })
    expect(r.status).toBe(409)
    expect((await r.json()).error).toBe('acp_agent_exists')
  })

  it('PATCH updates an agent by id (id not in the patch)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}/claude-code`, {
      method: 'PATCH',
      headers: jsonAuth(b),
      body: JSON.stringify({ enabled: false, command: 'codex-acp' }),
    })
    expect(r.status).toBe(200)
    expect(b.updateCalls).toEqual([
      { id: 'claude-code', patch: { command: 'codex-acp', enabled: false } },
    ])
  })

  it('PATCH 400 on an empty command', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}/claude-code`, {
      method: 'PATCH',
      headers: jsonAuth(b),
      body: JSON.stringify({ command: '   ' }),
    })
    expect(r.status).toBe(400)
    expect(b.updateCalls).toHaveLength(0)
  })

  it('DELETE removes an agent', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}/claude-code`, { method: 'DELETE', headers: auth(b) })
    expect(r.status).toBe(200)
    expect((await r.json()).ok).toBe(true)
    expect(b.removeCalls).toEqual(['claude-code'])
  })

  it('DELETE 404 on an unknown id', async () => {
    b = await boot()
    b.removeReturns = false
    const r = await fetch(`${b.baseUrl}${AGENTS}/ghost`, { method: 'DELETE', headers: auth(b) })
    expect(r.status).toBe(404)
    expect(b.removeCalls).toEqual(['ghost'])
  })

  it('405 on an unsupported method to the collection', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`, { method: 'PUT', headers: auth(b) })
    expect(r.status).toBe(405)
  })
})
