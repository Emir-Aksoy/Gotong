/**
 * C-M2-M4b — outbound OAuth access-token auto-refresh.
 *
 * A REAL in-memory IdentityStore (connector config + vaulted secret + token set
 * all genuine) + a STUB `fetch` (canned token endpoint) + a fixed `now` (so
 * "due vs fresh" is deterministic). Pins the sweep: only enabled+connected
 * connectors within the skew of expiry are refreshed; the refresh_token grant
 * carries the prior refresh token forward when the response omits one; a missing
 * refresh token / disabled / fresh / no-lifetime connector is left alone; a
 * failed refresh leaves the stored token untouched and never throws.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomBytes } from 'node:crypto'

import { openIdentityStore, IdentityStore, MASTER_KEY_LEN_BYTES } from '@gotong/identity'
import type { StoredOAuthTokenSet } from '@gotong/identity'
import { OAuthTokenRefresher } from '../src/oauth-token-refresh.js'

const FIXED_KEY = randomBytes(MASTER_KEY_LEN_BYTES)
const NOW = 1_700_000_000_000

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
function stubFetch(script: { status?: number; json?: unknown; throwErr?: Error }): {
  fn: typeof fetch
  calls: Array<{ url: string; body: string }>
} {
  const calls: Array<{ url: string; body: string }> = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') })
    if (script.throwErr) throw script.throwErr
    return new Response(JSON.stringify(script.json ?? {}), {
      status: script.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const recordingLogger = () => {
  const warns: Array<Record<string, unknown> | undefined> = []
  const errors: Array<Record<string, unknown> | undefined> = []
  return {
    warns,
    errors,
    logger: {
      info: () => {},
      warn: (_m: string, meta?: Record<string, unknown>) => warns.push(meta),
      error: (_m: string, meta?: Record<string, unknown>) => errors.push(meta),
    },
  }
}

/** Register GOOGLE + store a token set with a given expiry (default: due). */
function connect(store: IdentityStore, tokens: Partial<StoredOAuthTokenSet> = {}): void {
  store.registerOAuthConnector(GOOGLE)
  store.setOAuthTokenSet('google-calendar', {
    accessToken: 'old-access',
    refreshToken: '1//old-refresh',
    tokenType: 'Bearer',
    scope: GOOGLE.scope,
    accessTokenExpiresAt: NOW + 60_000, // 1 min out → within default 5 min skew → due
    ...tokens,
  })
}

const REFRESHED = {
  access_token: 'ya29.new-access',
  refresh_token: '1//new-refresh',
  expires_in: 3600,
  token_type: 'Bearer',
  scope: GOOGLE.scope,
}

describe('OAuthTokenRefresher (C-M2-M4b)', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:', masterKey: FIXED_KEY })
  })

  it('refreshes a due connector: refresh_token grant → new access token + absolute expiry', async () => {
    connect(store)
    const { fn, calls } = stubFetch({ json: REFRESHED })
    await new OAuthTokenRefresher(store, { fetchImpl: fn, now: () => NOW }).tick()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(GOOGLE.tokenEndpoint)
    expect(calls[0].body).toContain('grant_type=refresh_token')
    expect(calls[0].body).toContain('refresh_token=1%2F%2Fold-refresh')
    expect(calls[0].body).toContain(`client_id=${encodeURIComponent(GOOGLE.clientId)}`)
    expect(calls[0].body).toContain('client_secret=goog-secret-xyz')

    const ts = store.getOAuthTokenSet('google-calendar')
    expect(ts?.accessToken).toBe('ya29.new-access')
    expect(ts?.refreshToken).toBe('1//new-refresh')
    expect(ts?.accessTokenExpiresAt).toBe(NOW + 3600 * 1000)
  })

  it('leaves a still-fresh connector alone (expiry beyond the skew)', async () => {
    connect(store, { accessTokenExpiresAt: NOW + 10 * 60_000 })
    const { fn, calls } = stubFetch({ json: REFRESHED })
    await new OAuthTokenRefresher(store, { fetchImpl: fn, now: () => NOW }).tick()
    expect(calls).toHaveLength(0)
    expect(store.getOAuthTokenSet('google-calendar')?.accessToken).toBe('old-access')
  })

  it('skips a disabled connector even when due', async () => {
    store.registerOAuthConnector({ ...GOOGLE, enabled: false })
    store.setOAuthTokenSet('google-calendar', {
      accessToken: 'old-access',
      refreshToken: '1//old-refresh',
      tokenType: 'Bearer',
      scope: GOOGLE.scope,
      accessTokenExpiresAt: NOW + 60_000,
    })
    const { fn, calls } = stubFetch({ json: REFRESHED })
    await new OAuthTokenRefresher(store, { fetchImpl: fn, now: () => NOW }).tick()
    expect(calls).toHaveLength(0)
  })

  it('skips a not-yet-connected connector (no token set)', async () => {
    store.registerOAuthConnector(GOOGLE)
    const { fn, calls } = stubFetch({ json: REFRESHED })
    await new OAuthTokenRefresher(store, { fetchImpl: fn, now: () => NOW }).tick()
    expect(calls).toHaveLength(0)
  })

  it('skips a connector whose token has no stated lifetime (expiresAt null)', async () => {
    connect(store, { accessTokenExpiresAt: null })
    const { fn, calls } = stubFetch({ json: REFRESHED })
    await new OAuthTokenRefresher(store, { fetchImpl: fn, now: () => NOW }).tick()
    expect(calls).toHaveLength(0)
  })

  it('warns ONCE (not every tick) for a due connector with no refresh token; token untouched', async () => {
    connect(store, { refreshToken: null })
    const { fn, calls } = stubFetch({ json: REFRESHED })
    const { warns, logger } = recordingLogger()
    const r = new OAuthTokenRefresher(store, { fetchImpl: fn, now: () => NOW, logger })
    await r.tick()
    await r.tick()
    expect(calls).toHaveLength(0)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ connector: 'google-calendar' })
    expect(store.getOAuthTokenSet('google-calendar')?.accessToken).toBe('old-access')
  })

  it('carries the prior refresh token forward when the response omits a new one', async () => {
    connect(store)
    const { fn } = stubFetch({ json: { access_token: 'ya29.new', expires_in: 3600 } })
    await new OAuthTokenRefresher(store, { fetchImpl: fn, now: () => NOW }).tick()
    const ts = store.getOAuthTokenSet('google-calendar')
    expect(ts?.accessToken).toBe('ya29.new')
    expect(ts?.refreshToken).toBe('1//old-refresh')
  })

  it('a failed refresh (non-2xx) leaves the stored token untouched and does not throw', async () => {
    connect(store)
    const { fn } = stubFetch({ status: 400, json: { error: 'invalid_grant' } })
    const { errors, logger } = recordingLogger()
    const r = new OAuthTokenRefresher(store, { fetchImpl: fn, now: () => NOW, logger })
    await expect(r.tick()).resolves.toBeUndefined()
    expect(store.getOAuthTokenSet('google-calendar')?.accessToken).toBe('old-access')
    expect(errors.length).toBeGreaterThan(0)
  })

  it('a transport error is caught, logged, and does not throw', async () => {
    connect(store)
    const { fn } = stubFetch({ throwErr: new Error('ECONNRESET') })
    const { errors, logger } = recordingLogger()
    const r = new OAuthTokenRefresher(store, { fetchImpl: fn, now: () => NOW, logger })
    await expect(r.tick()).resolves.toBeUndefined()
    expect(store.getOAuthTokenSet('google-calendar')?.accessToken).toBe('old-access')
    expect(errors.length).toBeGreaterThan(0)
  })

  it('start() fires a catch-up tick (recovers a boot-expired token); stop() clears the timer', async () => {
    connect(store, { accessTokenExpiresAt: NOW - 60_000 }) // already expired at boot
    const { fn, calls } = stubFetch({ json: REFRESHED })
    const r = new OAuthTokenRefresher(store, { fetchImpl: fn, now: () => NOW, intervalMs: 10_000 })
    r.start()
    // Wait for the END state (full tick: fetch → parse → persist), not just the
    // fetch call — otherwise we'd race the post-fetch setOAuthTokenSet.
    await vi.waitFor(() =>
      expect(store.getOAuthTokenSet('google-calendar')?.accessToken).toBe('ya29.new-access'),
    )
    r.stop()
    expect(calls).toHaveLength(1)
  })
})
