/**
 * C-M2-M2 — outbound OAuth 2.0 connector config + token store (接入现实生活 track).
 *
 * The hub is the CLIENT. The non-secret config (endpoints / client_id /
 * redirect_uri / scope / extras / mcp target / enabled) round-trips through the
 * `oauth_connectors` row; the confidential client_secret AND the obtained token
 * set live in the VAULT and are never in the public projection — only
 * `readOAuthClientSecret` / `getOAuthTokenSet` return plaintext. A public
 * (PKCE-only) client has no secret and thus no vault entry. Rotating the secret
 * or the token set revokes the superseded vault entry (no orphans); a duplicate
 * id is rejected without stranding the secret it was given; removal revokes
 * both. An empty registry is the opt-in default — byte-for-byte unchanged.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'

import { openIdentityStore, IdentityStore, MASTER_KEY_LEN_BYTES } from '../src/index.js'
import type { StoredOAuthTokenSet } from '../src/index.js'

const FIXED_KEY = randomBytes(MASTER_KEY_LEN_BYTES)

function activeCount(store: IdentityStore, kind: 'oauth_client_secret' | 'oauth_token'): number {
  return store.listVaultEntries({ kind }).filter((e) => e.revokedAt == null).length
}

const GOOGLE = {
  id: 'google-calendar',
  displayName: 'Google Calendar',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  clientId: 'client-123.apps.googleusercontent.com',
  redirectUri: 'https://hub.test/api/admin/oauth/callback',
  scope: 'https://www.googleapis.com/auth/calendar.readonly',
  extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  mcpServerName: 'google-calendar',
  clientSecret: 'goog-secret-xyz',
} as const

const TOKENS: StoredOAuthTokenSet = {
  accessToken: 'ya29.access',
  refreshToken: '1//refresh',
  tokenType: 'Bearer',
  scope: 'https://www.googleapis.com/auth/calendar.readonly',
  accessTokenExpiresAt: 1_800_000_000_000,
}

describe('OAuthConnectorStore (C-M2-M2)', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:', masterKey: FIXED_KEY })
  })

  it('opt-in default: a fresh registry is empty', () => {
    expect(store.listOAuthConnectors()).toHaveLength(0)
  })

  it('round-trips the non-secret config and keeps the secret out of the projection', () => {
    const c = store.registerOAuthConnector(GOOGLE)
    expect(c.id).toBe('google-calendar')
    expect(c.displayName).toBe('Google Calendar')
    expect(c.authorizationEndpoint).toBe(GOOGLE.authorizationEndpoint)
    expect(c.tokenEndpoint).toBe(GOOGLE.tokenEndpoint)
    expect(c.clientId).toBe(GOOGLE.clientId)
    expect(c.redirectUri).toBe(GOOGLE.redirectUri)
    expect(c.scope).toBe(GOOGLE.scope)
    expect(c.extraAuthParams).toEqual({ access_type: 'offline', prompt: 'consent' })
    expect(c.mcpServerName).toBe('google-calendar')
    expect(c.enabled).toBe(true)
    expect(c.hasClientSecret).toBe(true)
    expect(c.connected).toBe(false)
    expect(c.accessTokenExpiresAt).toBeNull()
    // The secret is NOT a field on the projection, and the only way to read it
    // is the dedicated accessor.
    expect(JSON.stringify(c)).not.toContain('goog-secret-xyz')
    expect(store.readOAuthClientSecret(c.id)).toBe('goog-secret-xyz')
  })

  it('stores the client secret as a vault entry (kind oauth_client_secret, ownerKind org)', () => {
    store.registerOAuthConnector(GOOGLE)
    const entries = store.listVaultEntries({ kind: 'oauth_client_secret' })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.ownerKind).toBe('org')
    expect(entries[0]!.ownerId).toBeNull()
  })

  it('a public (PKCE-only) client has no secret and no vault entry', () => {
    const c = store.registerOAuthConnector({
      id: 'public-conn',
      authorizationEndpoint: 'https://example.com/authorize',
      tokenEndpoint: 'https://example.com/token',
      clientId: 'pub-app',
      redirectUri: 'https://hub.test/cb',
      scope: 'read write',
      // no clientSecret
    })
    expect(c.hasClientSecret).toBe(false)
    expect(store.readOAuthClientSecret(c.id)).toBe('')
    expect(activeCount(store, 'oauth_client_secret')).toBe(0)
  })

  it('looks up by id; lists all in insertion order', () => {
    const a = store.registerOAuthConnector({ ...GOOGLE, id: 'a', mcpServerName: null })
    const b = store.registerOAuthConnector({ ...GOOGLE, id: 'b', clientSecret: undefined })
    expect(store.getOAuthConnector('a')!.id).toBe('a')
    expect(store.getOAuthConnector('nope')).toBeNull()
    expect(store.listOAuthConnectors().map((c) => c.id)).toEqual([a.id, b.id])
  })

  it('rejects a duplicate id without stranding the secret', () => {
    store.registerOAuthConnector(GOOGLE)
    expect(() => store.registerOAuthConnector({ ...GOOGLE, clientSecret: 'other-secret' })).toThrowError(
      expect.objectContaining({ code: 'oauth_connector_exists' }),
    )
    // The rejected insert's secret must not leak — only the first survives.
    expect(activeCount(store, 'oauth_client_secret')).toBe(1)
  })

  it('rejects empty mandatory fields; store stays empty', () => {
    const base = { ...GOOGLE }
    for (const field of ['id', 'authorizationEndpoint', 'tokenEndpoint', 'clientId', 'redirectUri', 'scope'] as const) {
      expect(() => store.registerOAuthConnector({ ...base, [field]: '' })).toThrowError(
        expect.objectContaining({ code: 'invalid_input' }),
      )
    }
    expect(store.listOAuthConnectors()).toHaveLength(0)
  })

  it('rotates the secret: new value readable, old vault entry revoked', () => {
    const c = store.registerOAuthConnector(GOOGLE)
    const updated = store.updateOAuthConnector(c.id, { clientSecret: 'new-secret' })
    expect(updated.hasClientSecret).toBe(true)
    expect(store.readOAuthClientSecret(c.id)).toBe('new-secret')
    expect(activeCount(store, 'oauth_client_secret')).toBe(1)
  })

  it('clears the secret with an empty string (→ public client)', () => {
    const c = store.registerOAuthConnector(GOOGLE)
    const updated = store.updateOAuthConnector(c.id, { clientSecret: '' })
    expect(updated.hasClientSecret).toBe(false)
    expect(store.readOAuthClientSecret(c.id)).toBe('')
    expect(activeCount(store, 'oauth_client_secret')).toBe(0)
  })

  it('updates non-secret fields (incl. extras + scope) while keeping the secret intact', () => {
    const c = store.registerOAuthConnector(GOOGLE)
    const updated = store.updateOAuthConnector(c.id, {
      scope: 'https://www.googleapis.com/auth/calendar',
      extraAuthParams: { access_type: 'offline' },
      mcpServerName: 'gcal',
      enabled: false,
    })
    expect(updated.scope).toBe('https://www.googleapis.com/auth/calendar')
    expect(updated.extraAuthParams).toEqual({ access_type: 'offline' })
    expect(updated.mcpServerName).toBe('gcal')
    expect(updated.enabled).toBe(false)
    expect(updated.hasClientSecret).toBe(true)
    expect(store.readOAuthClientSecret(c.id)).toBe('goog-secret-xyz')
  })

  it('clearing extraAuthParams with null drops them', () => {
    const c = store.registerOAuthConnector(GOOGLE)
    expect(store.updateOAuthConnector(c.id, { extraAuthParams: null }).extraAuthParams).toBeNull()
  })

  it('throws oauth_connector_not_found for update / readSecret on an unknown id', () => {
    expect(() => store.updateOAuthConnector('nope', { enabled: false })).toThrowError(
      expect.objectContaining({ code: 'oauth_connector_not_found' }),
    )
    // An unknown id must NOT silently return '' (that would mask a bug).
    expect(() => store.readOAuthClientSecret('nope')).toThrowError(
      expect.objectContaining({ code: 'oauth_connector_not_found' }),
    )
  })

  // ---- token set (the outbound-specific surface vs OidcProviderStore) ----

  it('setTokenSet stores the tokens in the vault (kind oauth_token) + expiry in the row', () => {
    const c = store.registerOAuthConnector(GOOGLE)
    const updated = store.setOAuthTokenSet(c.id, TOKENS)
    expect(updated.connected).toBe(true)
    expect(updated.accessTokenExpiresAt).toBe(TOKENS.accessTokenExpiresAt)
    const entries = store.listVaultEntries({ kind: 'oauth_token' })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.ownerKind).toBe('org')
    // The projection carries NEITHER the access nor the refresh token.
    expect(JSON.stringify(updated)).not.toContain('ya29.access')
    expect(JSON.stringify(updated)).not.toContain('1//refresh')
  })

  it('getTokenSet round-trips the full set; returns null before connect', () => {
    const c = store.registerOAuthConnector(GOOGLE)
    expect(store.getOAuthTokenSet(c.id)).toBeNull()
    store.setOAuthTokenSet(c.id, TOKENS)
    const got = store.getOAuthTokenSet(c.id)
    expect(got).toEqual(TOKENS)
  })

  it('a refresh with no new refresh_token persists null refresh (caller carries the old one)', () => {
    const c = store.registerOAuthConnector(GOOGLE)
    store.setOAuthTokenSet(c.id, TOKENS)
    const refreshed: StoredOAuthTokenSet = {
      accessToken: 'ya29.rotated',
      refreshToken: null,
      tokenType: 'Bearer',
      scope: null,
      accessTokenExpiresAt: 1_800_000_003_600,
    }
    store.setOAuthTokenSet(c.id, refreshed)
    const got = store.getOAuthTokenSet(c.id)!
    expect(got.accessToken).toBe('ya29.rotated')
    expect(got.refreshToken).toBeNull()
    expect(got.accessTokenExpiresAt).toBe(1_800_000_003_600)
    // Rotating the token set revokes the superseded vault entry (no orphans).
    expect(activeCount(store, 'oauth_token')).toBe(1)
  })

  it('setTokenSet rejects an empty access token', () => {
    const c = store.registerOAuthConnector(GOOGLE)
    expect(() => store.setOAuthTokenSet(c.id, { ...TOKENS, accessToken: '' })).toThrowError(
      expect.objectContaining({ code: 'invalid_input' }),
    )
  })

  it('setTokenSet / getTokenSet throw not_found for an unknown id', () => {
    expect(() => store.setOAuthTokenSet('nope', TOKENS)).toThrowError(
      expect.objectContaining({ code: 'oauth_connector_not_found' }),
    )
    expect(() => store.getOAuthTokenSet('nope')).toThrowError(
      expect.objectContaining({ code: 'oauth_connector_not_found' }),
    )
  })

  it('clearTokenSet revokes the token entry, keeps config + secret, is idempotent', () => {
    const c = store.registerOAuthConnector(GOOGLE)
    store.setOAuthTokenSet(c.id, TOKENS)
    expect(store.clearOAuthTokenSet(c.id)).toBe(true)
    const after = store.getOAuthConnector(c.id)!
    expect(after.connected).toBe(false)
    expect(after.accessTokenExpiresAt).toBeNull()
    expect(after.hasClientSecret).toBe(true) // secret survives a disconnect
    expect(store.readOAuthClientSecret(c.id)).toBe('goog-secret-xyz')
    expect(activeCount(store, 'oauth_token')).toBe(0)
    expect(store.getOAuthTokenSet(c.id)).toBeNull()
    expect(store.clearOAuthTokenSet(c.id)).toBe(false) // idempotent
  })

  it('removing deletes the row and revokes BOTH the secret and the token set', () => {
    const c = store.registerOAuthConnector(GOOGLE)
    store.setOAuthTokenSet(c.id, TOKENS)
    expect(activeCount(store, 'oauth_client_secret')).toBe(1)
    expect(activeCount(store, 'oauth_token')).toBe(1)
    expect(store.removeOAuthConnector(c.id)).toBe(true)
    expect(store.getOAuthConnector(c.id)).toBeNull()
    expect(activeCount(store, 'oauth_client_secret')).toBe(0)
    expect(activeCount(store, 'oauth_token')).toBe(0)
    expect(store.removeOAuthConnector(c.id)).toBe(false) // idempotent
  })
})
