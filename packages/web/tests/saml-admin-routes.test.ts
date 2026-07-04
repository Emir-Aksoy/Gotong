/**
 * Route B P1-M5f-1 — /api/admin/saml/providers CRUD.
 *
 * An admin registers the IdPs the hub accepts SAML assertions from. Driven
 * through a real serveWeb with a STUB SamlProviderAdminSurface (the store is
 * covered in identity/tests/saml-provider-store.test.ts — here we pin auth
 * gating, body validation, and the create/update/delete dispatch).
 *
 * Unlike the OIDC admin routes there is NO secret to hide: `idpCert` is a
 * public X.509 verification key, so the view carries it in full and an admin
 * can audit which cert is pinned.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import {
  serveWeb,
  type SamlProviderAdminSurface,
  type SamlProviderView,
  type WebServerHandle,
} from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminToken: string
  rows: SamlProviderView[]
  addCalls: unknown[]
  updateCalls: Array<{ id: string; patch: unknown }>
  removeCalls: string[]
  addThrows: { code: string } | null
}

function view(over: Partial<SamlProviderView> = {}): SamlProviderView {
  return {
    id: 'p1',
    idpEntityId: 'https://idp.test/saml',
    ssoUrl: 'https://idp.test/sso',
    idpCert: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    spEntityId: 'https://hub.test/sp',
    enabled: true,
    label: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

async function boot(opts: { wired?: boolean } = {}): Promise<Boot> {
  const wired = opts.wired ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-saml-admin-'))
  const init = await Space.init(tmp, { name: 'saml-admin-route-test' })
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

  const surface: SamlProviderAdminSurface = {
    list() {
      return out.rows
    },
    add(input) {
      out.addCalls.push(input)
      if (out.addThrows) throw out.addThrows
      return view({ id: 'new', idpEntityId: (input as { idpEntityId: string }).idpEntityId })
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
    ...(wired ? { samlAdmin: surface } : {}),
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
const PROVIDERS = '/api/admin/saml/providers'

describe('/api/admin/saml/providers (Route B P1-M5f-1)', () => {
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

  it('GET lists registered providers, cert included (it is public)', async () => {
    b = await boot()
    b.rows = [view({ id: 'a' }), view({ id: 'b', enabled: false })]
    const r = await fetch(`${b.baseUrl}${PROVIDERS}`, { headers: auth(b) })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.providers).toHaveLength(2)
    // The cert IS carried — it's a public verification key admins must audit.
    expect(j.providers[0].idpCert).toContain('CERTIFICATE')
  })

  it('POST registers a provider (201) and forwards all fields to the store', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${PROVIDERS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({
        idpEntityId: 'https://new.test/saml',
        ssoUrl: 'https://new.test/sso',
        idpCert: '-----BEGIN CERTIFICATE-----\nXX\n-----END CERTIFICATE-----',
        spEntityId: 'https://hub.test/sp',
        label: 'Okta',
      }),
    })
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j.provider.idpEntityId).toBe('https://new.test/saml')
    const sent = b.addCalls[0] as { ssoUrl: string; idpCert: string; spEntityId: string; label: string }
    expect(sent.ssoUrl).toBe('https://new.test/sso')
    expect(sent.idpCert).toContain('CERTIFICATE')
    expect(sent.spEntityId).toBe('https://hub.test/sp')
    expect(sent.label).toBe('Okta')
  })

  it('POST 400 on a missing mandatory field', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${PROVIDERS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      // no idpCert
      body: JSON.stringify({
        idpEntityId: 'https://x.test',
        ssoUrl: 'https://x.test/sso',
        spEntityId: 'https://hub.test/sp',
      }),
    })
    expect(r.status).toBe(400)
    expect(b.addCalls).toHaveLength(0)
  })

  it('POST maps a duplicate entityID to 409', async () => {
    b = await boot()
    b.addThrows = { code: 'saml_provider_exists' }
    const r = await fetch(`${b.baseUrl}${PROVIDERS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({
        idpEntityId: 'https://dup.test',
        ssoUrl: 'https://dup.test/sso',
        idpCert: 'PEM',
        spEntityId: 'https://hub.test/sp',
      }),
    })
    expect(r.status).toBe(409)
    expect((await r.json()).error).toBe('saml_provider_exists')
  })

  it('PATCH updates a provider by id (idpEntityId not in the patch)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${PROVIDERS}/p1`, {
      method: 'PATCH',
      headers: jsonAuth(b),
      body: JSON.stringify({ enabled: false, ssoUrl: 'https://idp.test/sso2' }),
    })
    expect(r.status).toBe(200)
    expect(b.updateCalls).toEqual([{ id: 'p1', patch: { ssoUrl: 'https://idp.test/sso2', enabled: false } }])
  })

  it('PATCH 400 on an empty ssoUrl', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${PROVIDERS}/p1`, {
      method: 'PATCH',
      headers: jsonAuth(b),
      body: JSON.stringify({ ssoUrl: '   ' }),
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
