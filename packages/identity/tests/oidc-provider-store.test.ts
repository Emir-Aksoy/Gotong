/**
 * Route B P1-M4d — OIDC identity-provider config store.
 *
 * The hub registers the IdPs it accepts SSO from. The non-secret config
 * (issuer / client_id / redirect_uri / scope / enabled) round-trips through the
 * `oidc_providers` row; the confidential client_secret lives in the VAULT and
 * is never in the public projection — only `readOidcClientSecret` returns it. A
 * public (PKCE-only) client has no secret and thus no vault entry, so a hub
 * without a master key can still register one. Rotating or clearing the secret
 * revokes the superseded vault entry (no orphans), and a duplicate issuer is
 * rejected without stranding the secret it was given.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'

import { openIdentityStore, IdentityStore, IdentityError, MASTER_KEY_LEN_BYTES } from '../src/index.js'

const FIXED_KEY = randomBytes(MASTER_KEY_LEN_BYTES)

function activeSecretCount(store: IdentityStore): number {
  return store
    .listVaultEntries({ kind: 'oidc_client_secret' })
    .filter((e) => e.revokedAt == null).length
}

describe('OidcProviderStore (P1-M4d)', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:', masterKey: FIXED_KEY })
  })

  it('round-trips the non-secret config and keeps the secret out of the projection', () => {
    const p = store.addOidcProvider({
      issuer: 'https://accounts.google.com',
      clientId: 'client-123',
      redirectUri: 'https://hub.test/api/auth/oidc/callback',
      scope: 'openid email profile',
      clientSecret: 'super-secret',
      label: 'Google Workspace',
    })
    expect(p.issuer).toBe('https://accounts.google.com')
    expect(p.clientId).toBe('client-123')
    expect(p.redirectUri).toBe('https://hub.test/api/auth/oidc/callback')
    expect(p.scope).toBe('openid email profile')
    expect(p.enabled).toBe(true)
    expect(p.label).toBe('Google Workspace')
    expect(p.hasClientSecret).toBe(true)
    // The secret is NOT a field on the projection (compile-time), and the only
    // way to read it is the dedicated accessor.
    expect(JSON.stringify(p)).not.toContain('super-secret')
    expect(store.readOidcClientSecret(p.id)).toBe('super-secret')
  })

  it('stores the secret as a vault entry (kind oidc_client_secret, ownerKind org)', () => {
    const p = store.addOidcProvider({
      issuer: 'https://login.microsoftonline.com/tenant/v2.0',
      clientId: 'azure-app',
      redirectUri: 'https://hub.test/cb',
      clientSecret: 'azure-secret',
    })
    const entries = store.listVaultEntries({ kind: 'oidc_client_secret' })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.ownerKind).toBe('org')
    expect(entries[0]!.ownerId).toBeNull()
    expect(store.readOidcClientSecret(p.id)).toBe('azure-secret')
  })

  it('a public (PKCE-only) client has no secret and no vault entry', () => {
    const p = store.addOidcProvider({
      issuer: 'https://idp.public',
      clientId: 'public-client',
      redirectUri: 'https://hub.test/cb',
      // no clientSecret
    })
    expect(p.hasClientSecret).toBe(false)
    expect(store.readOidcClientSecret(p.id)).toBe('')
    expect(activeSecretCount(store)).toBe(0)
  })

  it('looks up by id and by issuer; lists all in insertion order', () => {
    const a = store.addOidcProvider({ issuer: 'https://a.test', clientId: 'a', redirectUri: 'https://h/cb' })
    const b = store.addOidcProvider({ issuer: 'https://b.test', clientId: 'b', redirectUri: 'https://h/cb' })
    expect(store.getOidcProvider(a.id)!.issuer).toBe('https://a.test')
    expect(store.getOidcProviderByIssuer('https://b.test')!.id).toBe(b.id)
    expect(store.getOidcProviderByIssuer('https://nope.test')).toBeNull()
    expect(store.listOidcProviders().map((p) => p.id)).toEqual([a.id, b.id])
  })

  it('rejects a duplicate issuer without stranding the secret', () => {
    store.addOidcProvider({ issuer: 'https://dup.test', clientId: 'a', redirectUri: 'https://h/cb', clientSecret: 's1' })
    expect(() =>
      store.addOidcProvider({
        issuer: 'https://dup.test',
        clientId: 'b',
        redirectUri: 'https://h/cb',
        clientSecret: 's2',
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'oidc_provider_exists' }),
    )
    // The rejected insert's secret must not leak — only the first one survives.
    expect(activeSecretCount(store)).toBe(1)
  })

  it('rotates the secret: new value readable, old vault entry revoked', () => {
    const p = store.addOidcProvider({
      issuer: 'https://rot.test',
      clientId: 'c',
      redirectUri: 'https://h/cb',
      clientSecret: 'old-secret',
    })
    const updated = store.updateOidcProvider(p.id, { clientSecret: 'new-secret' })
    expect(updated.hasClientSecret).toBe(true)
    expect(store.readOidcClientSecret(p.id)).toBe('new-secret')
    // Exactly one ACTIVE secret remains (old one was revoked, not left dangling).
    expect(activeSecretCount(store)).toBe(1)
  })

  it('clears the secret with an empty string (→ public client)', () => {
    const p = store.addOidcProvider({
      issuer: 'https://clr.test',
      clientId: 'c',
      redirectUri: 'https://h/cb',
      clientSecret: 'will-be-cleared',
    })
    const updated = store.updateOidcProvider(p.id, { clientSecret: '' })
    expect(updated.hasClientSecret).toBe(false)
    expect(store.readOidcClientSecret(p.id)).toBe('')
    expect(activeSecretCount(store)).toBe(0)
  })

  it('updates non-secret fields while keeping the secret intact', () => {
    const p = store.addOidcProvider({
      issuer: 'https://keep.test',
      clientId: 'old-client',
      redirectUri: 'https://h/cb',
      scope: 'openid',
      clientSecret: 'keep-me',
    })
    const updated = store.updateOidcProvider(p.id, { clientId: 'new-client', enabled: false, scope: 'openid email' })
    expect(updated.clientId).toBe('new-client')
    expect(updated.enabled).toBe(false)
    expect(updated.scope).toBe('openid email')
    expect(updated.hasClientSecret).toBe(true)
    expect(store.readOidcClientSecret(p.id)).toBe('keep-me')
  })

  it('removing deletes the row and revokes the secret', () => {
    const p = store.addOidcProvider({
      issuer: 'https://del.test',
      clientId: 'c',
      redirectUri: 'https://h/cb',
      clientSecret: 'gone',
    })
    expect(store.removeOidcProvider(p.id)).toBe(true)
    expect(store.getOidcProvider(p.id)).toBeNull()
    expect(activeSecretCount(store)).toBe(0)
    expect(store.removeOidcProvider(p.id)).toBe(false) // idempotent
  })

  it('throws oidc_provider_not_found for update / readSecret on an unknown id', () => {
    expect(() => store.updateOidcProvider('nope', { enabled: false })).toThrowError(
      expect.objectContaining({ code: 'oidc_provider_not_found' }),
    )
    // Critically: an unknown id must NOT silently return '' (that would mask a bug).
    expect(() => store.readOidcClientSecret('nope')).toThrowError(
      expect.objectContaining({ code: 'oidc_provider_not_found' }),
    )
  })

  it('rejects empty mandatory fields', () => {
    for (const bad of [
      { issuer: '', clientId: 'c', redirectUri: 'https://h/cb' },
      { issuer: 'https://x', clientId: '  ', redirectUri: 'https://h/cb' },
      { issuer: 'https://x', clientId: 'c', redirectUri: '' },
    ]) {
      expect(() => store.addOidcProvider(bad)).toThrowError(
        expect.objectContaining({ code: 'invalid_input' }),
      )
    }
    // The store stays empty after the rejected adds.
    expect(store.listOidcProviders()).toHaveLength(0)
    void IdentityError
  })
})
