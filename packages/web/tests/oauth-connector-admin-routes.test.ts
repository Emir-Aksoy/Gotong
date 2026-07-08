/**
 * C-M2-M5a — admin OAuth connector CRUD routes.
 *
 * A real serveWeb with a STUB OAuthConnectorAdminSurface (the store logic lives
 * in identity/tests/oauth-connector-store.test.ts — here we pin the HTTP
 * contract): admin-gated list / register / update / remove / disconnect, input
 * validation, and typed-store-error → status mapping. The client_secret is
 * write-only; the view never carries it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'
import {
  serveWeb,
  type OAuthConnectorAdminSurface,
  type OAuthConnectorView,
  type WebServerHandle,
} from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminToken: string
  connectors: OAuthConnectorView[]
  addCalls: unknown[]
  updateCalls: Array<{ id: string; patch: unknown }>
  removeCalls: string[]
  disconnectCalls: string[]
  addError: { code: string } | null
  removeResult: boolean
  disconnectResult: boolean
}

function viewOf(id: string, over: Partial<OAuthConnectorView> = {}): OAuthConnectorView {
  return {
    id,
    displayName: null,
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    clientId: 'client-123',
    redirectUri: 'https://hub.test/api/oauth/callback',
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    extraAuthParams: null,
    mcpServerName: null,
    hasClientSecret: false,
    connected: false,
    accessTokenExpiresAt: null,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

async function boot(opts: { wired?: boolean } = {}): Promise<Boot> {
  const wired = opts.wired ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-oauth-connectors-'))
  const init = await Space.init(tmp, { name: 'oauth-connector-admin-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const { token: adminToken } = await init.space.createAdmin('TestAdmin')

  const out: Boot = {
    tmp,
    hub,
    server: undefined as unknown as WebServerHandle,
    baseUrl: '',
    adminToken,
    connectors: [viewOf('google-calendar', { connected: true, hasClientSecret: true })],
    addCalls: [],
    updateCalls: [],
    removeCalls: [],
    disconnectCalls: [],
    addError: null,
    removeResult: true,
    disconnectResult: true,
  }

  const surface: OAuthConnectorAdminSurface = {
    list: () => out.connectors,
    add: (input) => {
      out.addCalls.push(input)
      if (out.addError) throw out.addError
      return viewOf(input.id, { hasClientSecret: !!input.clientSecret })
    },
    update: (id, patch) => {
      out.updateCalls.push({ id, patch })
      return viewOf(id)
    },
    remove: (id) => {
      out.removeCalls.push(id)
      return out.removeResult
    },
    disconnect: (id) => {
      out.disconnectCalls.push(id)
      return out.disconnectResult
    },
  }

  out.server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(wired ? { oauthConnectorAdmin: surface } : {}),
  })
  out.baseUrl = out.server.url
  return out
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

const BASE = '/api/admin/oauth/connectors'
const auth = (b: Boot) => ({ authorization: `Bearer ${b.adminToken}`, 'content-type': 'application/json' })
const GOOD_ADD = {
  id: 'notion',
  authorizationEndpoint: 'https://api.notion.com/v1/oauth/authorize',
  tokenEndpoint: 'https://api.notion.com/v1/oauth/token',
  clientId: 'nc-1',
  redirectUri: 'https://hub.test/api/oauth/callback',
  scope: 'read',
  clientSecret: 'ns-secret',
}

describe('/api/admin/oauth/connectors — admin CRUD (C-M2-M5a)', () => {
  let b: Boot
  afterEach(async () => {
    await teardown(b)
  })

  it('401 without the admin bearer', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${BASE}`)
    expect(r.status).toBe(401)
  })

  it('503 when authed but the surface is not wired', async () => {
    b = await boot({ wired: false })
    const r = await fetch(`${b.baseUrl}${BASE}`, { headers: auth(b) })
    expect(r.status).toBe(503)
  })

  it('GET lists connectors (no secret in the projection)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${BASE}`, { headers: auth(b) })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.connectors).toHaveLength(1)
    expect(j.connectors[0].id).toBe('google-calendar')
    expect(j.connectors[0].connected).toBe(true)
    expect(j.connectors[0]).not.toHaveProperty('clientSecret')
  })

  it('POST registers a connector (201) and passes the write-only clientSecret through', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${BASE}`, {
      method: 'POST',
      headers: auth(b),
      body: JSON.stringify(GOOD_ADD),
    })
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j.connector.id).toBe('notion')
    expect(j.connector.hasClientSecret).toBe(true)
    expect(j.connector).not.toHaveProperty('clientSecret')
    expect(b.addCalls).toHaveLength(1)
    expect((b.addCalls[0] as { clientSecret: string }).clientSecret).toBe('ns-secret')
  })

  it('POST 400 on a missing required field (surface NOT called)', async () => {
    b = await boot()
    const { scope: _omit, ...noScope } = GOOD_ADD
    const r = await fetch(`${b.baseUrl}${BASE}`, {
      method: 'POST',
      headers: auth(b),
      body: JSON.stringify(noScope),
    })
    expect(r.status).toBe(400)
    expect(b.addCalls).toHaveLength(0)
  })

  it('POST 400 on a non-string extraAuthParams value', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${BASE}`, {
      method: 'POST',
      headers: auth(b),
      body: JSON.stringify({ ...GOOD_ADD, extraAuthParams: { access_type: 42 } }),
    })
    expect(r.status).toBe(400)
    expect(b.addCalls).toHaveLength(0)
  })

  it('POST maps a duplicate-id store error to 409', async () => {
    b = await boot()
    b.addError = { code: 'oauth_connector_exists' }
    const r = await fetch(`${b.baseUrl}${BASE}`, {
      method: 'POST',
      headers: auth(b),
      body: JSON.stringify(GOOD_ADD),
    })
    expect(r.status).toBe(409)
    expect((await r.json()).error).toBe('oauth_connector_exists')
  })

  it('PATCH updates a connector', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${BASE}/google-calendar`, {
      method: 'PATCH',
      headers: auth(b),
      body: JSON.stringify({ enabled: false, clientSecret: '' }),
    })
    expect(r.status).toBe(200)
    expect(b.updateCalls).toEqual([{ id: 'google-calendar', patch: { enabled: false, clientSecret: '' } }])
  })

  it('PATCH 400 on a blank required-shaped field', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${BASE}/google-calendar`, {
      method: 'PATCH',
      headers: auth(b),
      body: JSON.stringify({ clientId: '   ' }),
    })
    expect(r.status).toBe(400)
    expect(b.updateCalls).toHaveLength(0)
  })

  it('DELETE removes a connector', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${BASE}/google-calendar`, { method: 'DELETE', headers: auth(b) })
    expect(r.status).toBe(200)
    expect((await r.json()).ok).toBe(true)
    expect(b.removeCalls).toEqual(['google-calendar'])
  })

  it('DELETE 404 when the connector does not exist', async () => {
    b = await boot()
    b.removeResult = false
    const r = await fetch(`${b.baseUrl}${BASE}/ghost`, { method: 'DELETE', headers: auth(b) })
    expect(r.status).toBe(404)
    expect((await r.json()).error).toBe('oauth_connector_not_found')
  })

  it('POST :id/disconnect clears the token set and reports wasConnected', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${BASE}/google-calendar/disconnect`, {
      method: 'POST',
      headers: auth(b),
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j).toEqual({ ok: true, wasConnected: true })
    expect(b.disconnectCalls).toEqual(['google-calendar'])
  })

  it('405 on an unsupported method against the collection', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${BASE}`, { method: 'PUT', headers: auth(b) })
    expect(r.status).toBe(405)
  })
})
