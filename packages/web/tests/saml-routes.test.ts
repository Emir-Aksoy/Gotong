/**
 * Route B P1-M5e — public /api/auth/saml/* SP login routes.
 *
 * The browser-facing half of SAML SSO, driven through a real serveWeb with a
 * STUB SamlLoginSurface (the host's SamlLoginService crypto/state is covered in
 * host/tests/saml-login-service.test.ts — here we pin the HTTP contract:
 * provider listing, SP metadata, the 302 to the IdP on start, and the ACS POST
 * minting the identity cookie on success / bouncing to /?saml_error=<code> on
 * failure).
 *
 * The ACS is a CROSS-SITE form POST (no admin cookie, no Origin header), so it
 * MUST be reachable in the public pre-CSRF zone. We use `redirect: 'manual'` so
 * fetch hands us the 302 + Location/Set-Cookie instead of following it.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import { serveWeb, type SamlLoginSurface, type WebServerHandle } from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  providers: Array<{ id: string; label: string | null }>
  beginCalls: string[]
  completeCalls: Array<{ relayState: string; samlResponse: string }>
  metadataCalls: string[]
  beginError: { code: string } | null
  completeError: { code: string } | null
  metadataError: { code: string } | null
}

async function boot(opts: { wired?: boolean } = {}): Promise<Boot> {
  const wired = opts.wired ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-saml-'))
  const init = await Space.init(tmp, { name: 'saml-route-test' })
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
    metadataCalls: [],
    beginError: null,
    completeError: null,
    metadataError: null,
  }

  const surface: SamlLoginSurface = {
    listProviders() {
      return out.providers
    },
    begin(providerId) {
      out.beginCalls.push(providerId)
      if (out.beginError) throw out.beginError
      return { redirectUrl: `https://idp.test/sso?provider=${providerId}`, relayState: 'rs-1' }
    },
    complete(input) {
      out.completeCalls.push(input)
      if (out.completeError) throw out.completeError
      return { session: { token: 'ses_stub_token' } }
    },
    metadata(providerId) {
      out.metadataCalls.push(providerId)
      if (out.metadataError) throw out.metadataError
      return `<EntityDescriptor entityID="sp-${providerId}"/>`
    },
  }

  out.server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(wired ? { samlLogin: surface } : {}),
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

/** POST a form body (the ACS binding) without following redirects. */
function postForm(b: Boot, path: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${b.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  })
}

describe('/api/auth/saml/* (Route B P1-M5e)', () => {
  let b: Boot
  afterEach(async () => {
    await teardown(b)
  })

  it('lists enabled providers (id + label only, no cert) when wired', async () => {
    b = await boot()
    b.providers = [
      { id: 'p1', label: 'Okta' },
      { id: 'p2', label: null },
    ]
    const r = await get(b, '/api/auth/saml/providers')
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.providers).toEqual([
      { id: 'p1', label: 'Okta' },
      { id: 'p2', label: null },
    ])
    // The cert / entityID never leak into the public list.
    expect(JSON.stringify(j)).not.toContain('CERTIFICATE')
  })

  it('returns an empty provider list when SAML is not wired', async () => {
    b = await boot({ wired: false })
    const r = await get(b, '/api/auth/saml/providers')
    expect(r.status).toBe(200)
    expect((await r.json()).providers).toEqual([])
  })

  it('serves SP metadata XML for an explicit provider', async () => {
    b = await boot()
    b.providers = [{ id: 'p1', label: 'Okta' }]
    const r = await get(b, '/api/auth/saml/metadata?provider=p1')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('application/xml')
    expect(await r.text()).toBe('<EntityDescriptor entityID="sp-p1"/>')
    expect(b.metadataCalls).toEqual(['p1'])
  })

  it('defaults metadata to the sole provider when only one is configured', async () => {
    b = await boot()
    b.providers = [{ id: 'only', label: 'Sole' }]
    const r = await get(b, '/api/auth/saml/metadata')
    expect(r.status).toBe(200)
    expect(b.metadataCalls).toEqual(['only'])
  })

  it('requires ?provider= for metadata when several providers exist', async () => {
    b = await boot()
    b.providers = [
      { id: 'p1', label: 'A' },
      { id: 'p2', label: 'B' },
    ]
    const r = await get(b, '/api/auth/saml/metadata')
    expect(r.status).toBe(400)
    expect(b.metadataCalls).toHaveLength(0)
  })

  it('start redirects (302) to the IdP SSO URL', async () => {
    b = await boot()
    const r = await get(b, '/api/auth/saml/start?provider=p1')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('https://idp.test/sso?provider=p1')
    expect(b.beginCalls).toEqual(['p1'])
  })

  it('start bounces when no provider is given', async () => {
    b = await boot()
    const r = await get(b, '/api/auth/saml/start')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/?saml_error=missing_provider')
    expect(b.beginCalls).toHaveLength(0)
  })

  it('start bounces with the error code when begin() throws', async () => {
    b = await boot()
    b.beginError = { code: 'saml_provider_disabled' }
    const r = await get(b, '/api/auth/saml/start?provider=p1')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/?saml_error=saml_provider_disabled')
  })

  it('ACS POST mints the identity cookie and redirects home on success', async () => {
    b = await boot()
    const r = await postForm(b, '/api/auth/saml/acs', { SAMLResponse: 'B64RESP', RelayState: 'rs-1' })
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/')
    const cookie = r.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('gotong_identity=ses_stub_token')
    expect(cookie).toContain('HttpOnly')
    expect(b.completeCalls).toEqual([{ relayState: 'rs-1', samlResponse: 'B64RESP' }])
  })

  it('ACS bounces (no cookie) when complete() throws', async () => {
    b = await boot()
    b.completeError = { code: 'saml_no_account' }
    const r = await postForm(b, '/api/auth/saml/acs', { SAMLResponse: 'B64RESP', RelayState: 'rs-1' })
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/?saml_error=saml_no_account')
    expect(r.headers.get('set-cookie')).toBeNull()
  })

  it('ACS bounces when SAMLResponse or RelayState is missing', async () => {
    b = await boot()
    const r = await postForm(b, '/api/auth/saml/acs', { RelayState: 'rs-1' })
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/?saml_error=missing_params')
    expect(b.completeCalls).toHaveLength(0)
  })

  it('ACS bounces with not_enabled when SAML is unwired', async () => {
    b = await boot({ wired: false })
    const r = await postForm(b, '/api/auth/saml/acs', { SAMLResponse: 'x', RelayState: 'y' })
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/?saml_error=not_enabled')
  })
})
