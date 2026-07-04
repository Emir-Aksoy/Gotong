/**
 * Admin-console ops routes extracted to admin-routes.ts (C1 god-object
 * split): admins / secrets / applications / growth-reports.
 *
 * These had NO direct HTTP coverage before the extraction (only
 * feedback/inbound did) — this file closes that gap and verifies the
 * extracted dispatch (auth gate + happy path + the error branches) still
 * behaves exactly as it did inline in server.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space, type AdminRecord } from '@gotong/core'

import { serveWeb, type WebServerHandle } from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  space: Space
  server: WebServerHandle
  baseUrl: string
  admin: AdminRecord
  token: string
}

async function boot(): Promise<Boot> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-admin-routes-'))
  const init = await Space.init(tmp, { name: 'admin-routes-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()
  const { admin, token } = await space.createAdmin('TestAdmin')
  // No growthReports surface wired — so /api/admin/growth-reports* should 503.
  const server = await serveWeb(hub, { host: '127.0.0.1', port: 0 })
  return { tmp, hub, space, server, baseUrl: server.url, admin, token }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

describe('admin-routes: /api/admin/admins', () => {
  let b: Boot
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('POST without auth → 401', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/admins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Nope' }),
    })
    expect(res.status).toBe(401)
  })

  it('POST with displayName → 200, returns admin + one-time token', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/admins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(b.token) },
      body: JSON.stringify({ displayName: 'Sister' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.admin.displayName).toBe('Sister')
    expect(typeof body.token).toBe('string')
    expect(body.token.length).toBeGreaterThan(0)
    // The new admin row really landed.
    expect((await b.space.admins()).some((a) => a.id === body.admin.id)).toBe(true)
  })

  it('POST with empty displayName → 400', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/admins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(b.token) },
      body: JSON.stringify({ displayName: '   ' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST with over-long displayName → 400', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/admins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(b.token) },
      body: JSON.stringify({ displayName: 'x'.repeat(81) }),
    })
    expect(res.status).toBe(400)
  })

  it('DELETE a different admin → 200 and the row is gone', async () => {
    const { admin: other } = await b.space.createAdmin('Other')
    const res = await fetch(`${b.baseUrl}/api/admin/admins/${other.id}`, {
      method: 'DELETE',
      headers: auth(b.token),
    })
    expect(res.status).toBe(200)
    expect((await b.space.admins()).some((a) => a.id === other.id)).toBe(false)
  })

  it('DELETE yourself → 400 (use logout)', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/admins/${b.admin.id}`, {
      method: 'DELETE',
      headers: auth(b.token),
    })
    expect(res.status).toBe(400)
  })

  it('DELETE unknown id → 404', async () => {
    // Need a second admin so the "last admin" guard doesn't fire first.
    await b.space.createAdmin('Other')
    const res = await fetch(`${b.baseUrl}/api/admin/admins/does-not-exist`, {
      method: 'DELETE',
      headers: auth(b.token),
    })
    expect(res.status).toBe(404)
  })
})

describe('admin-routes: /api/admin/secrets', () => {
  let b: Boot
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('GET without auth → 401', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/secrets`)
    expect(res.status).toBe(401)
  })

  it('GET with auth → 200 with providers/agents/env shape', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/secrets`, { headers: auth(b.token) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('providers')
    expect(body).toHaveProperty('agents')
    expect(body).toHaveProperty('env')
    expect(body.env).toHaveProperty('anthropic')
    expect(body.env).toHaveProperty('openai')
  })

  it('PUT a known provider key → 200, then it reads back as configured', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/secrets/anthropic`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth(b.token) },
      body: JSON.stringify({ apiKey: 'sk-test-123' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    // listProviderApiKeys() is a { provider → updatedAt } map (never the
    // plaintext) — the key's presence is the "configured" signal.
    const providers = await b.space.listProviderApiKeys()
    expect(Object.keys(providers)).toContain('anthropic')
  })

  it('PUT an unknown provider → 400', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/secrets/madeup`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth(b.token) },
      body: JSON.stringify({ apiKey: 'sk-x' }),
    })
    expect(res.status).toBe(400)
  })

  it('PUT without apiKey → 400', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/secrets/openai`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth(b.token) },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('DELETE a set key → 200; DELETE an unset key → 404', async () => {
    await b.space.setProviderApiKey('openai', 'sk-set')
    const del = await fetch(`${b.baseUrl}/api/admin/secrets/openai`, {
      method: 'DELETE',
      headers: auth(b.token),
    })
    expect(del.status).toBe(200)
    const again = await fetch(`${b.baseUrl}/api/admin/secrets/openai`, {
      method: 'DELETE',
      headers: auth(b.token),
    })
    expect(again.status).toBe(404)
  })
})

describe('admin-routes: /api/admin/applications', () => {
  let b: Boot
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('GET without auth → 401', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/applications`)
    expect(res.status).toBe(401)
  })

  it('GET with auth lists pending applications', async () => {
    b.hub.requestAdmission({ agents: [{ id: 'pending-1', capabilities: ['noop'] }] })
    const res = await fetch(`${b.baseUrl}/api/admin/applications`, { headers: auth(b.token) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.applications)).toBe(true)
    expect(body.applications.length).toBe(1)
  })

  it('POST approve a real application → 200; unknown → 404', async () => {
    const { applicationId } = b.hub.requestAdmission({
      agents: [{ id: 'pending-approve', capabilities: ['noop'] }],
    })
    const ok = await fetch(
      `${b.baseUrl}/api/admin/applications/${applicationId}/approve`,
      { method: 'POST', headers: auth(b.token) },
    )
    expect(ok.status).toBe(200)
    const miss = await fetch(
      `${b.baseUrl}/api/admin/applications/nope/approve`,
      { method: 'POST', headers: auth(b.token) },
    )
    expect(miss.status).toBe(404)
  })

  it('POST reject a real application → 200; unknown → 404', async () => {
    const { applicationId } = b.hub.requestAdmission({
      agents: [{ id: 'pending-reject', capabilities: ['noop'] }],
    })
    const ok = await fetch(
      `${b.baseUrl}/api/admin/applications/${applicationId}/reject`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(b.token) },
        body: JSON.stringify({ reason: 'no thanks' }),
      },
    )
    expect(ok.status).toBe(200)
    const miss = await fetch(
      `${b.baseUrl}/api/admin/applications/nope/reject`,
      { method: 'POST', headers: auth(b.token) },
    )
    expect(miss.status).toBe(404)
  })
})

describe('admin-routes: /api/admin/growth-reports (no surface wired)', () => {
  let b: Boot
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('GET without auth → 401', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/growth-reports`)
    expect(res.status).toBe(401)
  })

  it('GET list with auth but no surface → 503', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/growth-reports`, { headers: auth(b.token) })
    expect(res.status).toBe(503)
  })

  it('GET download with auth but no surface → 503', async () => {
    const res = await fetch(
      `${b.baseUrl}/api/admin/growth-reports/download?path=reports/x/y.md`,
      { headers: auth(b.token) },
    )
    expect(res.status).toBe(503)
  })
})
