/**
 * C-M2-M3 — host outbound OAuth "connect" orchestration.
 *
 * A REAL in-memory IdentityStore (so the connector config, its vaulted client
 * secret, and the persisted token set are all genuine) plus a STUB `fetch` (so
 * no network / no real provider — the token endpoint returns canned JSON). Pins
 * the orchestration: begin() builds a proper outbound authorization URL and
 * stashes single-use state; complete() validates state (unknown / used / expired
 * all → oauth_state_invalid), POSTs the exchange, and persists a normalized,
 * expiry-stamped token set. The pure URL/body/parse layer is C-M2-M1's job, not
 * retested here beyond what the round-trip observes.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'

import { openIdentityStore, IdentityStore, MASTER_KEY_LEN_BYTES } from '@gotong/identity'
import { OAuthConnectService } from '../src/oauth-connect-service.js'

const FIXED_KEY = randomBytes(MASTER_KEY_LEN_BYTES)

const GOOGLE = {
  id: 'google-calendar',
  displayName: 'Google Calendar',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  clientId: 'client-123.apps.googleusercontent.com',
  redirectUri: 'https://hub.test/api/oauth/callback',
  scope: 'https://www.googleapis.com/auth/calendar.readonly',
  extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  clientSecret: 'goog-secret-xyz',
} as const

/** A capturing stub `fetch`: records each call and returns a scripted Response. */
function stubFetch(script: {
  status?: number
  json?: unknown
  throwErr?: Error
  notJson?: boolean
}): { fn: typeof fetch; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') })
    if (script.throwErr) throw script.throwErr
    const payload = script.notJson ? 'not-json{' : JSON.stringify(script.json ?? {})
    return new Response(payload, {
      status: script.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const TOKEN_JSON = {
  access_token: 'ya29.access',
  refresh_token: '1//refresh',
  expires_in: 3600,
  token_type: 'Bearer',
  scope: 'https://www.googleapis.com/auth/calendar.readonly',
}

describe('OAuthConnectService (C-M2-M3)', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:', masterKey: FIXED_KEY })
  })

  it('begin throws for an unknown connector', async () => {
    const svc = new OAuthConnectService(store)
    await expect(svc.begin('nope')).rejects.toMatchObject({ code: 'oauth_connector_not_found' })
  })

  it('begin refuses a disabled connector', async () => {
    store.registerOAuthConnector({ ...GOOGLE, enabled: false })
    const svc = new OAuthConnectService(store)
    await expect(svc.begin('google-calendar')).rejects.toMatchObject({ code: 'oauth_connector_disabled' })
  })

  it('begin builds the outbound authorization URL and stashes single-use state', async () => {
    store.registerOAuthConnector(GOOGLE)
    const svc = new OAuthConnectService(store)
    const { authorizationUrl, state } = await svc.begin('google-calendar')
    const u = new URL(authorizationUrl)
    expect(u.origin + u.pathname).toBe(GOOGLE.authorizationEndpoint)
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('client_id')).toBe(GOOGLE.clientId)
    expect(u.searchParams.get('redirect_uri')).toBe(GOOGLE.redirectUri)
    expect(u.searchParams.get('scope')).toBe(GOOGLE.scope) // native, not openid
    expect(u.searchParams.get('scope')).not.toContain('openid')
    expect(u.searchParams.get('access_type')).toBe('offline') // extras layered in
    expect(u.searchParams.get('state')).toBe(state)
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(svc.pendingCount()).toBe(1)
  })

  it('complete rejects an unknown / already-used state', async () => {
    store.registerOAuthConnector(GOOGLE)
    const svc = new OAuthConnectService(store)
    await expect(svc.complete({ state: 'never-issued', code: 'c' })).rejects.toMatchObject({
      code: 'oauth_state_invalid',
    })
  })

  it('complete rejects an expired state', async () => {
    store.registerOAuthConnector(GOOGLE)
    let clock = 1_000_000
    const { fn } = stubFetch({ json: TOKEN_JSON })
    const svc = new OAuthConnectService(store, { fetchImpl: fn, now: () => clock, stateTtlMs: 60_000 })
    const { state } = await svc.begin('google-calendar')
    clock += 60_001 // just past the TTL
    await expect(svc.complete({ state, code: 'c' })).rejects.toMatchObject({ code: 'oauth_state_invalid' })
  })

  it('round-trips begin → complete: exchanges the code and persists the token set', async () => {
    store.registerOAuthConnector(GOOGLE)
    const clock = 2_000_000
    const { fn, calls } = stubFetch({ json: TOKEN_JSON })
    const svc = new OAuthConnectService(store, { fetchImpl: fn, now: () => clock })
    const { state } = await svc.begin('google-calendar')
    const { connectorId, connector } = await svc.complete({ state, code: 'auth-code-abc' })

    // The exchange POSTed to the token endpoint with the code + PKCE verifier + secret.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(GOOGLE.tokenEndpoint)
    const sent = new URLSearchParams(calls[0]!.body)
    expect(sent.get('grant_type')).toBe('authorization_code')
    expect(sent.get('code')).toBe('auth-code-abc')
    expect(sent.get('code_verifier')).toBeTruthy()
    expect(sent.get('client_secret')).toBe('goog-secret-xyz')

    // The token set was persisted (genuinely, in the vault) with a computed expiry.
    expect(connectorId).toBe('google-calendar')
    expect(connector.connected).toBe(true)
    const stored = store.getOAuthTokenSet('google-calendar')!
    expect(stored.accessToken).toBe('ya29.access')
    expect(stored.refreshToken).toBe('1//refresh')
    expect(stored.tokenType).toBe('Bearer')
    expect(stored.accessTokenExpiresAt).toBe(clock + 3600 * 1000)

    // State is single-use + pruned.
    expect(svc.pendingCount()).toBe(0)
    await expect(svc.complete({ state, code: 'auth-code-abc' })).rejects.toMatchObject({
      code: 'oauth_state_invalid',
    })
  })

  it('a public (PKCE-only) connector sends no client_secret in the exchange', async () => {
    store.registerOAuthConnector({
      id: 'public-conn',
      authorizationEndpoint: 'https://example.com/authorize',
      tokenEndpoint: 'https://example.com/token',
      clientId: 'pub-app',
      redirectUri: 'https://hub.test/api/oauth/callback',
      scope: 'read write',
      // no clientSecret
    })
    const { fn, calls } = stubFetch({ json: { access_token: 'a', expires_in: 100 } })
    const svc = new OAuthConnectService(store, { fetchImpl: fn })
    const { state } = await svc.begin('public-conn')
    await svc.complete({ state, code: 'c' })
    expect(new URLSearchParams(calls[0]!.body).get('client_secret')).toBeNull()
  })

  it('propagates a token-endpoint HTTP error as token_exchange_failed', async () => {
    store.registerOAuthConnector(GOOGLE)
    const { fn } = stubFetch({ status: 400, json: { error: 'invalid_grant' } })
    const svc = new OAuthConnectService(store, { fetchImpl: fn })
    const { state } = await svc.begin('google-calendar')
    await expect(svc.complete({ state, code: 'c' })).rejects.toMatchObject({ code: 'token_exchange_failed' })
    // A failed exchange must NOT have connected the connector.
    expect(store.getOAuthConnector('google-calendar')!.connected).toBe(false)
  })

  it('propagates a transport error as token_exchange_failed', async () => {
    store.registerOAuthConnector(GOOGLE)
    const { fn } = stubFetch({ throwErr: new Error('ECONNREFUSED') })
    const svc = new OAuthConnectService(store, { fetchImpl: fn })
    const { state } = await svc.begin('google-calendar')
    await expect(svc.complete({ state, code: 'c' })).rejects.toMatchObject({ code: 'token_exchange_failed' })
  })

  it('rejects a response with no usable access_token', async () => {
    store.registerOAuthConnector(GOOGLE)
    const { fn } = stubFetch({ json: { token_type: 'Bearer' } }) // no access_token
    const svc = new OAuthConnectService(store, { fetchImpl: fn })
    const { state } = await svc.begin('google-calendar')
    await expect(svc.complete({ state, code: 'c' })).rejects.toMatchObject({ code: 'no_access_token' })
  })
})
