/**
 * Route B P1-M5c — SAML identity-provider config store.
 *
 * The SAML twin of oidc-provider-store.test.ts, minus the vault: a SAML SP
 * verifies assertions against the IdP's `idp_cert`, a PUBLIC X.509 signing
 * certificate, so there is nothing confidential to hide. Every column —
 * including the cert — round-trips through the projection, the store needs no
 * master key (proven below by opening WITHOUT one), and there are no orphan
 * secrets to chase on rotate/remove. A duplicate IdP entityID is rejected.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { openIdentityStore, IdentityStore, IdentityError } from '../src/index.js'

const IDP = 'https://idp.example.com/saml/metadata'
const SSO = 'https://idp.example.com/saml/sso'
// A stand-in PEM body — the store treats it as opaque public config (the real
// cert parsing happens in @gotong/saml at verify time, not here).
const CERT = '-----BEGIN CERTIFICATE-----\nMIIBfakefakefake\n-----END CERTIFICATE-----'
const SP = 'https://hub.test/saml/metadata'

describe('SamlProviderStore (P1-M5c)', () => {
  let store: IdentityStore

  beforeEach(() => {
    // No masterKey on purpose: a SAML provider has no secret, so registering one
    // must NOT require a configured vault (unlike OIDC's confidential client).
    store = openIdentityStore({ dbPath: ':memory:' })
  })

  it('round-trips the full config, cert included (it is public)', () => {
    const p = store.addSamlProvider({
      idpEntityId: IDP,
      ssoUrl: SSO,
      idpCert: CERT,
      spEntityId: SP,
      label: 'Okta',
    })
    expect(p.idpEntityId).toBe(IDP)
    expect(p.ssoUrl).toBe(SSO)
    expect(p.idpCert).toBe(CERT) // the cert IS in the projection (public key)
    expect(p.spEntityId).toBe(SP)
    expect(p.enabled).toBe(true)
    expect(p.label).toBe('Okta')
    expect(typeof p.id).toBe('string')
  })

  it('looks up by id and by entityID; lists all in insertion order', () => {
    const a = store.addSamlProvider({ idpEntityId: 'https://a.idp', ssoUrl: SSO, idpCert: CERT, spEntityId: SP })
    const b = store.addSamlProvider({ idpEntityId: 'https://b.idp', ssoUrl: SSO, idpCert: CERT, spEntityId: SP })
    expect(store.getSamlProvider(a.id)!.idpEntityId).toBe('https://a.idp')
    expect(store.getSamlProviderByEntityId('https://b.idp')!.id).toBe(b.id)
    expect(store.getSamlProviderByEntityId('https://nope.idp')).toBeNull()
    expect(store.listSamlProviders().map((p) => p.id)).toEqual([a.id, b.id])
  })

  it('rejects a duplicate IdP entityID', () => {
    store.addSamlProvider({ idpEntityId: 'https://dup.idp', ssoUrl: SSO, idpCert: CERT, spEntityId: SP })
    expect(() =>
      store.addSamlProvider({ idpEntityId: 'https://dup.idp', ssoUrl: SSO, idpCert: CERT, spEntityId: SP }),
    ).toThrowError(expect.objectContaining({ code: 'saml_provider_exists' }))
    expect(store.listSamlProviders()).toHaveLength(1)
  })

  it('updates fields (cert/SSO/SP/enabled/label); entityID stays immutable', () => {
    const p = store.addSamlProvider({
      idpEntityId: IDP,
      ssoUrl: SSO,
      idpCert: CERT,
      spEntityId: SP,
      label: 'before',
    })
    const newCert = '-----BEGIN CERTIFICATE-----\nMIIBrotatedrotated\n-----END CERTIFICATE-----'
    const updated = store.updateSamlProvider(p.id, {
      idpCert: newCert,
      ssoUrl: 'https://idp.example.com/saml/sso2',
      spEntityId: 'https://hub.test/saml/metadata2',
      enabled: false,
      label: 'after',
    })
    expect(updated.idpCert).toBe(newCert)
    expect(updated.ssoUrl).toBe('https://idp.example.com/saml/sso2')
    expect(updated.spEntityId).toBe('https://hub.test/saml/metadata2')
    expect(updated.enabled).toBe(false)
    expect(updated.label).toBe('after')
    // entityID is the immutable pin — there is no field to change it.
    expect(updated.idpEntityId).toBe(IDP)
  })

  it('a partial update keeps untouched fields intact', () => {
    const p = store.addSamlProvider({ idpEntityId: IDP, ssoUrl: SSO, idpCert: CERT, spEntityId: SP, label: 'keep' })
    const updated = store.updateSamlProvider(p.id, { enabled: false })
    expect(updated.enabled).toBe(false)
    expect(updated.idpCert).toBe(CERT)
    expect(updated.ssoUrl).toBe(SSO)
    expect(updated.spEntityId).toBe(SP)
    expect(updated.label).toBe('keep')
  })

  it('removing deletes the row and is idempotent', () => {
    const p = store.addSamlProvider({ idpEntityId: IDP, ssoUrl: SSO, idpCert: CERT, spEntityId: SP })
    expect(store.removeSamlProvider(p.id)).toBe(true)
    expect(store.getSamlProvider(p.id)).toBeNull()
    expect(store.removeSamlProvider(p.id)).toBe(false)
  })

  it('throws saml_provider_not_found for update on an unknown id', () => {
    expect(() => store.updateSamlProvider('nope', { enabled: false })).toThrowError(
      expect.objectContaining({ code: 'saml_provider_not_found' }),
    )
  })

  it('rejects empty mandatory fields', () => {
    for (const bad of [
      { idpEntityId: '', ssoUrl: SSO, idpCert: CERT, spEntityId: SP },
      { idpEntityId: IDP, ssoUrl: '   ', idpCert: CERT, spEntityId: SP },
      { idpEntityId: IDP, ssoUrl: SSO, idpCert: '', spEntityId: SP },
      { idpEntityId: IDP, ssoUrl: SSO, idpCert: CERT, spEntityId: '' },
    ]) {
      expect(() => store.addSamlProvider(bad)).toThrowError(
        expect.objectContaining({ code: 'invalid_input' }),
      )
    }
    expect(store.listSamlProviders()).toHaveLength(0)
    void IdentityError
  })
})
