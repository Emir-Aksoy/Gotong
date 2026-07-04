/**
 * Route B P1-M4f-1 — /api/admin/oidc/providers CRUD.
 *
 * An admin registers the IdPs the hub accepts SSO from. Driven through a real
 * serveWeb with a STUB OidcProviderAdminSurface (the vault-backed store is
 * covered in identity/tests/oidc-provider-store.test.ts — here we pin auth
 * gating, body validation, the create/update/delete dispatch, and that the
 * client_secret is write-only: accepted on input, never echoed back).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import {
  serveWeb,
  type OidcProviderAdminSurface,
  type OidcProviderView,
  type WebServerHandle,
} from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminToken: string
  rows: OidcProviderView[]
  addCalls: unknown[]
  updateCalls: Array<{ id: string; patch: unknown }>
  removeCalls: string[]
  addThrows: { code: string } | null
}

function view(over: Partial<OidcProviderView> = {}): OidcProviderView {
  return {
    id: 'p1',
    issuer: 'https://idp.test',
    clientId: 'client-1',
    redirectUri: 'https://hub.test/cb',
    scope: 'openid email',
    enabled: true,
    label: null,
    hasClientSecret: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

async function boot(opts: { wired?: boolean } = {}): Promise<Boot> {
  const wired = opts.wired ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-oidc-admin-'))
  const init = await Space.init(tmp, { name: 'oidc-admin-route-test' })
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
  }

  const surface: OidcProviderAdminSurface = {
    list() {
      return out.rows
    },
    add(input) {
      out.addCalls.push(input)
      if (out.addThrows) throw out.addThrows
      return view({ id: 'new', issuer: (input as { issuer: string }).issuer })
    },
    update(id, patch) {
      out.updateCalls.push({ id, patch })
      return view({ id })
    },
    remove(id) {
      out.removeCalls.push(id)
      return id === 'p1'
    },
  }

  out.server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(wired ? { oidcAdmin: surface } : {}),
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
const PROVIDERS = '/api/admin/oidc/providers'

describe('/api/admin/oidc/providers (Route B P1-M4f-1)', () => {
  let b: Boot
  afterEach(async () => {
    await teardown(b)
  })

  it('503 when the surface is not wired (no identity store)', async () => {
    b = await boot({ wired: false })
    const r = await fetch(`${b.baseUrl}${PROVIDERS}`, { headers: auth(b) })
    expect(r.status).toBe(503)
  })

  it('401 when unauthenticated', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${PROVIDERS}`)
    expect(r.status).toBe(401)
  })

  it('GET lists registered providers without any secret', async () => {
    b = await boot()
    b.rows = [view({ id: 'a', hasClientSecret: true }), view({ id: 'b', hasClientSecret: false })]
    const r = await fetch(`${b.baseUrl}${PROVIDERS}`, { headers: auth(b) })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.providers).toHaveLength(2)
    // The view carries hasClientSecret, never the secret value itself.
    expect(JSON.stringify(j)).not.toContain('clientSecret')
    expect(j.providers[0].hasClientSecret).toBe(true)
  })

  it('POST registers a provider (201) and forwards the clientSecret to the store', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${PROVIDERS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({
        issuer: 'https://new.test',
        clientId: 'c',
        redirectUri: 'https://hub.test/cb',
        clientSecret: 'shh',
      }),
    })
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j.provider.issuer).toBe('https://new.test')
    // Secret reached the store (write path) but isn't echoed in the response.
    expect((b.addCalls[0] as { clientSecret?: string }).clientSecret).toBe('shh')
    expect(JSON.stringify(j)).not.toContain('shh')
  })

  it('POST 400 on a missing mandatory field', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${PROVIDERS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({ clientId: 'c', redirectUri: 'https://hub.test/cb' }), // no issuer
    })
    expect(r.status).toBe(400)
    expect(b.addCalls).toHaveLength(0)
  })

  it('POST maps a duplicate issuer to 409', async () => {
    b = await boot()
    b.addThrows = { code: 'oidc_provider_exists' }
    const r = await fetch(`${b.baseUrl}${PROVIDERS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({ issuer: 'https://dup.test', clientId: 'c', redirectUri: 'https://hub.test/cb' }),
    })
    expect(r.status).toBe(409)
    expect((await r.json()).error).toBe('oidc_provider_exists')
  })

  it('PATCH updates a provider by id', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${PROVIDERS}/p1`, {
      method: 'PATCH',
      headers: jsonAuth(b),
      body: JSON.stringify({ enabled: false, clientSecret: '' }),
    })
    expect(r.status).toBe(200)
    expect(b.updateCalls).toEqual([{ id: 'p1', patch: { enabled: false, clientSecret: '' } }])
  })

  it('PATCH 400 on an empty clientId', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${PROVIDERS}/p1`, {
      method: 'PATCH',
      headers: jsonAuth(b),
      body: JSON.stringify({ clientId: '   ' }),
    })
    expect(r.status).toBe(400)
    expect(b.updateCalls).toHaveLength(0)
  })

  it('DELETE removes a provider', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${PROVIDERS}/p1`, { method: 'DELETE', headers: auth(b) })
    expect(r.status).toBe(200)
    expect((await r.json()).ok).toBe(true)
    expect(b.removeCalls).toEqual(['p1'])
  })

  it('DELETE 404 on an unknown id', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${PROVIDERS}/ghost`, { method: 'DELETE', headers: auth(b) })
    expect(r.status).toBe(404)
    expect(b.removeCalls).toEqual(['ghost'])
  })

  it('405 on an unsupported method to the collection', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${PROVIDERS}`, { method: 'PUT', headers: auth(b) })
    expect(r.status).toBe(405)
  })
})
