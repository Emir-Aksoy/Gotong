/**
 * Route B P1-M4e-2 — public /api/auth/oidc/* login routes.
 *
 * The browser-facing half of SSO, driven through a real serveWeb with a STUB
 * OidcLoginSurface (the host's OidcLoginService crypto/state is covered in
 * host/tests/oidc-login-service.test.ts — here we pin the HTTP contract:
 * provider listing, the 302 to the IdP on start, and the callback minting the
 * identity cookie on success / bouncing to /?oidc_error=<code> on failure).
 *
 * These routes live in the public pre-CSRF zone, so they're reached WITHOUT an
 * admin cookie or Origin header (a top-level IdP redirect has neither). We use
 * `redirect: 'manual'` so fetch hands us the 302 + Location/Set-Cookie instead
 * of following it.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import { serveWeb, type OidcLoginSurface, type WebServerHandle } from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  providers: Array<{ id: string; label: string | null; issuer: string }>
  beginCalls: string[]
  completeCalls: Array<{ state: string; code: string }>
  beginError: { code: string } | null
  completeError: { code: string } | null
}

async function boot(opts: { wired?: boolean } = {}): Promise<Boot> {
  const wired = opts.wired ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-oidc-'))
  const init = await Space.init(tmp, { name: 'oidc-route-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()

  const out: Boot = {
    tmp,
    hub,
    server: undefined as unknown as WebServerHandle,
    baseUrl: '',
    providers: [],
    beginCalls: [],
    completeCalls: [],
    beginError: null,
    completeError: null,
  }

  const surface: OidcLoginSurface = {
    listProviders() {
      return out.providers
    },
    async begin(providerId) {
      out.beginCalls.push(providerId)
      if (out.beginError) throw out.beginError
      return { authorizationUrl: `https://idp.test/authorize?provider=${providerId}`, state: 'st-1' }
    },
    async complete(input) {
      out.completeCalls.push(input)
      if (out.completeError) throw out.completeError
      return { session: { token: 'ses_stub_token' } }
    },
  }

  out.server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(wired ? { oidcLogin: surface } : {}),
  })
  out.baseUrl = out.server.url
  return out
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

/** GET without following redirects, so we can assert the 302 + headers. */
function get(b: Boot, path: string): Promise<Response> {
  return fetch(`${b.baseUrl}${path}`, { redirect: 'manual' })
}

describe('/api/auth/oidc/* (Route B P1-M4e-2)', () => {
  let b: Boot
  afterEach(async () => {
    await teardown(b)
  })

  it('lists enabled providers (no secret) when wired', async () => {
    b = await boot()
    b.providers = [
      { id: 'p1', label: 'Google', issuer: 'https://accounts.google.com' },
      { id: 'p2', label: null, issuer: 'https://login.test' },
    ]
    const r = await get(b, '/api/auth/oidc/providers')
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.providers).toHaveLength(2)
    expect(j.providers[0]).toEqual({ id: 'p1', label: 'Google', issuer: 'https://accounts.google.com' })
    // No secret/clientId leaks into the public list.
    expect(JSON.stringify(j)).not.toContain('secret')
  })

  it('returns an empty provider list when OIDC is not wired (no SSO configured)', async () => {
    b = await boot({ wired: false })
    const r = await get(b, '/api/auth/oidc/providers')
    expect(r.status).toBe(200)
    expect((await r.json()).providers).toEqual([])
  })

  it('start redirects (302) to the IdP authorize URL', async () => {
    b = await boot()
    const r = await get(b, '/api/auth/oidc/start?provider=p1')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('https://idp.test/authorize?provider=p1')
    expect(b.beginCalls).toEqual(['p1'])
  })

  it('start bounces to the login screen when no provider is given', async () => {
    b = await boot()
    const r = await get(b, '/api/auth/oidc/start')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/?oidc_error=missing_provider')
    expect(b.beginCalls).toHaveLength(0)
  })

  it('start bounces with the error code when begin() throws', async () => {
    b = await boot()
    b.beginError = { code: 'oidc_provider_disabled' }
    const r = await get(b, '/api/auth/oidc/start?provider=p1')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/?oidc_error=oidc_provider_disabled')
  })

  it('callback mints the identity cookie and redirects home on success', async () => {
    b = await boot()
    const r = await get(b, '/api/auth/oidc/callback?code=auth-code&state=st-1')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/')
    const cookie = r.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('gotong_identity=ses_stub_token')
    expect(cookie).toContain('HttpOnly')
    expect(b.completeCalls).toEqual([{ state: 'st-1', code: 'auth-code' }])
  })

  it('callback bounces (no cookie) when complete() throws', async () => {
    b = await boot()
    b.completeError = { code: 'oidc_no_account' }
    const r = await get(b, '/api/auth/oidc/callback?code=c&state=st-1')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/?oidc_error=oidc_no_account')
    expect(r.headers.get('set-cookie')).toBeNull()
  })

  it('callback forwards an IdP-reported error', async () => {
    b = await boot()
    const r = await get(b, '/api/auth/oidc/callback?error=access_denied')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/?oidc_error=access_denied')
    expect(b.completeCalls).toHaveLength(0)
  })

  it('callback bounces when code or state is missing', async () => {
    b = await boot()
    const r = await get(b, '/api/auth/oidc/callback?code=c')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/?oidc_error=missing_params')
    expect(b.completeCalls).toHaveLength(0)
  })

  it('rejects a non-GET method', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/auth/oidc/providers`, { method: 'POST', redirect: 'manual' })
    expect(r.status).toBe(405)
  })

  it('start bounces with not_enabled when OIDC is unwired', async () => {
    b = await boot({ wired: false })
    const r = await get(b, '/api/auth/oidc/start?provider=p1')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/?oidc_error=not_enabled')
  })
})
