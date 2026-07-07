/**
 * C-M2-M3 — outbound OAuth connect routes (接入现实生活 track).
 *
 * The browser-facing half of connecting a real-life MCP connector, driven
 * through a real serveWeb with a STUB OAuthConnectSurface (the host's
 * OAuthConnectService crypto/state/exchange is covered in
 * host/tests/oauth-connect-service.test.ts — here we pin the HTTP contract):
 *
 *   POST /api/admin/oauth/start   ADMIN-GATED — 401 without the admin bearer,
 *                                 503 when not wired, 400 on a bad/blank id,
 *                                 else 200 { authorizationUrl }.
 *   GET  /api/oauth/callback      PUBLIC + pre-CSRF — 302 to ?oauth_connected=<id>
 *                                 on success, ?oauth_error=<code> on failure /
 *                                 provider error / missing params / not wired.
 *
 * The begin route is the OPPOSITE posture of the OIDC login /start: connecting
 * MY account is an owner action, so it demands the admin credential; only the
 * provider-redirect callback is public (state-protected in the host layer).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import { serveWeb, type OAuthConnectSurface, type WebServerHandle } from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminToken: string
  beginCalls: string[]
  completeCalls: Array<{ state: string; code: string }>
  beginError: { code: string } | null
  completeError: { code: string } | null
}

async function boot(opts: { wired?: boolean } = {}): Promise<Boot> {
  const wired = opts.wired ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-oauth-connect-'))
  const init = await Space.init(tmp, { name: 'oauth-connect-route-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const { token: adminToken } = await init.space.createAdmin('TestAdmin')

  const out: Boot = {
    tmp,
    hub,
    server: undefined as unknown as WebServerHandle,
    baseUrl: '',
    adminToken,
    beginCalls: [],
    completeCalls: [],
    beginError: null,
    completeError: null,
  }

  const surface: OAuthConnectSurface = {
    async begin(connectorId) {
      out.beginCalls.push(connectorId)
      if (out.beginError) throw out.beginError
      return { authorizationUrl: `https://provider.test/authorize?c=${connectorId}` }
    },
    async complete(input) {
      out.completeCalls.push(input)
      if (out.completeError) throw out.completeError
      return { connectorId: 'google-calendar' }
    },
  }

  out.server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(wired ? { oauthConnect: surface } : {}),
  })
  out.baseUrl = out.server.url
  return out
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

const auth = (b: Boot) => ({ authorization: `Bearer ${b.adminToken}`, 'content-type': 'application/json' })
/** GET without following redirects, so we can assert the 302 + Location. */
const getManual = (b: Boot, path: string) => fetch(`${b.baseUrl}${path}`, { redirect: 'manual' })

describe('/api/admin/oauth/start — admin-gated begin (C-M2-M3)', () => {
  let b: Boot
  afterEach(async () => {
    await teardown(b)
  })

  it('401 without the admin bearer, and begin is NOT called', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/oauth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectorId: 'google-calendar' }),
    })
    expect(r.status).toBe(401)
    expect(b.beginCalls).toHaveLength(0)
  })

  it('503 when authed but the surface is not wired', async () => {
    b = await boot({ wired: false })
    const r = await fetch(`${b.baseUrl}/api/admin/oauth/start`, {
      method: 'POST',
      headers: auth(b),
      body: JSON.stringify({ connectorId: 'google-calendar' }),
    })
    expect(r.status).toBe(503)
  })

  it('400 on a blank connectorId', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/oauth/start`, {
      method: 'POST',
      headers: auth(b),
      body: JSON.stringify({ connectorId: '  ' }),
    })
    expect(r.status).toBe(400)
    expect(b.beginCalls).toHaveLength(0)
  })

  it('200 with the authorization URL for an authed request', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/oauth/start`, {
      method: 'POST',
      headers: auth(b),
      body: JSON.stringify({ connectorId: 'google-calendar' }),
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.authorizationUrl).toBe('https://provider.test/authorize?c=google-calendar')
    expect(b.beginCalls).toEqual(['google-calendar'])
  })

  it('maps a surface error to a 400 with the error code (bad/disabled connector)', async () => {
    b = await boot()
    b.beginError = { code: 'oauth_connector_disabled' }
    const r = await fetch(`${b.baseUrl}/api/admin/oauth/start`, {
      method: 'POST',
      headers: auth(b),
      body: JSON.stringify({ connectorId: 'x' }),
    })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toBe('oauth_connector_disabled')
  })

  it('405 on a non-POST method', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/oauth/start`, { redirect: 'manual' })
    expect(r.status).toBe(405)
  })
})

describe('/api/oauth/callback — public state-protected callback (C-M2-M3)', () => {
  let b: Boot
  afterEach(async () => {
    await teardown(b)
  })

  it('302s to /?oauth_connected=<id> on success', async () => {
    b = await boot()
    const r = await getManual(b, '/api/oauth/callback?code=abc&state=st-1')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/?oauth_connected=google-calendar')
    expect(b.completeCalls).toEqual([{ state: 'st-1', code: 'abc' }])
  })

  it('bounces to /?oauth_error=<code> when complete throws', async () => {
    b = await boot()
    b.completeError = { code: 'oauth_state_invalid' }
    const r = await getManual(b, '/api/oauth/callback?code=abc&state=stale')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/?oauth_error=oauth_state_invalid')
  })

  it('bounces to /?oauth_error=missing_params when code/state absent', async () => {
    b = await boot()
    const r = await getManual(b, '/api/oauth/callback?code=abc')
    expect(r.headers.get('location')).toBe('/?oauth_error=missing_params')
    expect(b.completeCalls).toHaveLength(0)
  })

  it('bounces the provider-reported ?error= without calling complete', async () => {
    b = await boot()
    const r = await getManual(b, '/api/oauth/callback?error=access_denied&state=st-1')
    expect(r.headers.get('location')).toBe('/?oauth_error=access_denied')
    expect(b.completeCalls).toHaveLength(0)
  })

  it('bounces to not_enabled when the surface is not wired', async () => {
    b = await boot({ wired: false })
    const r = await getManual(b, '/api/oauth/callback?code=abc&state=st-1')
    expect(r.headers.get('location')).toBe('/?oauth_error=not_enabled')
  })
})
