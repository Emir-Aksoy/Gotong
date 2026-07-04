/**
 * Route B P1-M4c — host OIDC client glue.
 *
 * A stubbed IdP (injected fetch + a real RSA-signed id_token) drives the client
 * end to end: completeLogin discovers → exchanges the code → fetches JWKS →
 * returns VERIFIED claims. Pins the load-bearing behaviours: discovery is
 * cached (no refetch within TTL), the token exchange actually carries the PKCE
 * code_verifier + client_secret, a non-2xx token endpoint and a missing
 * id_token fail with typed codes, a discovery doc whose own issuer disagrees is
 * rejected, and completeLogin genuinely runs the pure validator (a wrong nonce
 * surfaces as bad_signature's sibling, bad_nonce).
 */

import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto'

import { OidcError } from '@gotong/identity'
import { OidcClient, type OidcProviderConfig } from '../src/oidc-client.js'

const ISSUER = 'https://idp.test'
const CLIENT_ID = 'client-1'
const NOW = 1_700_000_000

const CONFIG: OidcProviderConfig = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: 'secret-1',
  redirectUri: 'https://hub.test/api/auth/oidc/callback',
}

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')
}
function signJwt(privateKey: KeyObject, payload: Record<string, unknown>): string {
  const header = { alg: 'RS256', kid: 'k1', typ: 'JWT' }
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`
  const sig = createSign('RSA-SHA256').update(signingInput).sign(privateKey).toString('base64url')
  return `${signingInput}.${sig}`
}

interface Idp {
  discovery: Record<string, unknown>
  jwks: { keys: unknown[] }
  idToken: string
}
function makeIdp(nonce = 'nonce-1'): Idp {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
  return {
    discovery: {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
    },
    jwks: { keys: [{ ...jwk, kid: 'k1', alg: 'RS256' }] },
    idToken: signJwt(privateKey, {
      iss: ISSUER,
      sub: 'sub-1',
      aud: CLIENT_ID,
      exp: NOW + 300,
      iat: NOW - 5,
      nonce,
      email: 'a@idp.test',
    }),
  }
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface StubOpts {
  discovery?: Record<string, unknown>
  tokenStatus?: number
  tokenBody?: Record<string, unknown>
}
function stubFetch(idp: Idp, opts: StubOpts = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u.endsWith('/.well-known/openid-configuration')) {
      return jsonResponse(opts.discovery ?? idp.discovery)
    }
    if (u.endsWith('/jwks')) return jsonResponse(idp.jwks)
    if (u.endsWith('/token')) {
      if (opts.tokenStatus && opts.tokenStatus !== 200) {
        return new Response('error', { status: opts.tokenStatus })
      }
      return jsonResponse(opts.tokenBody ?? { id_token: idp.idToken, access_token: 'at' })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn()
  } catch (err) {
    expect(err).toBeInstanceOf(OidcError)
    expect((err as OidcError).code).toBe(code)
    return
  }
  throw new Error(`expected OidcError ${code}, but nothing was thrown`)
}

describe('OidcClient (P1-M4c)', () => {
  it('completeLogin discovers → exchanges → validates → returns claims', async () => {
    const idp = makeIdp()
    const { fetchImpl, calls } = stubFetch(idp)
    const client = new OidcClient({ fetchImpl })
    const claims = await client.completeLogin({
      config: CONFIG,
      code: 'auth-code',
      codeVerifier: 'verifier-1',
      expectedNonce: 'nonce-1',
      now: NOW,
    })
    expect(claims.sub).toBe('sub-1')
    expect(claims.email).toBe('a@idp.test')
    const urls = calls.map((c) => c.url)
    expect(urls.some((u) => u.endsWith('/.well-known/openid-configuration'))).toBe(true)
    expect(urls.some((u) => u.endsWith('/token'))).toBe(true)
    expect(urls.some((u) => u.endsWith('/jwks'))).toBe(true)
  })

  it('caches the discovery document (no refetch within TTL)', async () => {
    const idp = makeIdp()
    const { fetchImpl, calls } = stubFetch(idp)
    const client = new OidcClient({ fetchImpl })
    await client.discover(ISSUER)
    await client.discover(ISSUER)
    const discoveryCalls = calls.filter((c) => c.url.endsWith('/.well-known/openid-configuration'))
    expect(discoveryCalls).toHaveLength(1)
  })

  it('the token exchange carries grant_type, the PKCE code_verifier, and the secret', async () => {
    const idp = makeIdp()
    const { fetchImpl, calls } = stubFetch(idp)
    const client = new OidcClient({ fetchImpl })
    await client.completeLogin({
      config: CONFIG,
      code: 'auth-code',
      codeVerifier: 'verifier-XYZ',
      expectedNonce: 'nonce-1',
      now: NOW,
    })
    const tokenCall = calls.find((c) => c.url.endsWith('/token'))!
    const body = String(tokenCall.init?.body)
    const params = new URLSearchParams(body)
    expect(params.get('grant_type')).toBe('authorization_code')
    expect(params.get('code')).toBe('auth-code')
    expect(params.get('code_verifier')).toBe('verifier-XYZ')
    expect(params.get('client_secret')).toBe('secret-1')
    expect(params.get('redirect_uri')).toBe(CONFIG.redirectUri)
  })

  it('a non-2xx token endpoint → token_exchange_failed', async () => {
    const idp = makeIdp()
    const { fetchImpl } = stubFetch(idp, { tokenStatus: 400 })
    const client = new OidcClient({ fetchImpl })
    await expectCode(
      () =>
        client.completeLogin({
          config: CONFIG,
          code: 'c',
          codeVerifier: 'v',
          expectedNonce: 'nonce-1',
          now: NOW,
        }),
      'token_exchange_failed',
    )
  })

  it('a token response with no id_token → no_id_token', async () => {
    const idp = makeIdp()
    const { fetchImpl } = stubFetch(idp, { tokenBody: { access_token: 'at' } })
    const client = new OidcClient({ fetchImpl })
    await expectCode(
      () =>
        client.completeLogin({
          config: CONFIG,
          code: 'c',
          codeVerifier: 'v',
          expectedNonce: 'nonce-1',
          now: NOW,
        }),
      'no_id_token',
    )
  })

  it('a discovery doc whose own issuer disagrees → discovery_issuer_mismatch', async () => {
    const idp = makeIdp()
    const { fetchImpl } = stubFetch(idp, {
      discovery: { ...idp.discovery, issuer: 'https://evil.test' },
    })
    const client = new OidcClient({ fetchImpl })
    await expectCode(() => client.discover(ISSUER), 'discovery_issuer_mismatch')
  })

  it('completeLogin runs the pure validator — a wrong nonce → bad_nonce', async () => {
    const idp = makeIdp('nonce-1')
    const { fetchImpl } = stubFetch(idp)
    const client = new OidcClient({ fetchImpl })
    await expectCode(
      () =>
        client.completeLogin({
          config: CONFIG,
          code: 'c',
          codeVerifier: 'v',
          expectedNonce: 'a-different-nonce',
          now: NOW,
        }),
      'bad_nonce',
    )
  })
})
