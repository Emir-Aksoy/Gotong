/**
 * Route B P1-M5b — SAML account linking + authenticateSaml.
 *
 * The SAML twin of oidc-link.test.ts. A SAML login maps a verified
 * (idpEntityId, NameID) — the federated identity — to a local user and mints
 * the SAME `ses_` session every other auth path produces (decision D-3, reused
 * from OIDC). These tests pin: round-trip link/lookup, the session is genuinely
 * usable, no-link → typed `saml_not_linked`, idempotent re-link for the same
 * user but `saml_already_linked` for a different one, distinct IdPs sharing a
 * NameID never collide, and the link surfaces in listCredentials with the IdP
 * entityID as its label.
 *
 * The (idpEntityId, NameID) is assumed already validated — the signature /
 * Issuer / Audience / time / Recipient / InResponseTo checks live in
 * @aipehub/saml. M5b is pure mapping + session mint.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { openIdentityStore, IdentityStore, IdentityError } from '../src/index.js'
import { samlLinkIdentifier } from '../src/credentials.js'

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(IdentityError)
    expect((err as IdentityError).code).toBe(code)
    return
  }
  throw new Error(`expected throw with code ${code}, but nothing was thrown`)
}

const IDP = 'https://idp.example.com/entity'
const NAME_ID = 'alice@example.com'

describe('SAML account linking (P1-M5b)', () => {
  let store: IdentityStore
  let userId: string

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:' })
    store.bootstrap()
    userId = store.createUser({ email: 'm@team.test', displayName: 'M', role: 'member' }).id
  })
  afterEach(() => store.close())

  it('findUserBySaml returns null before any link', () => {
    expect(store.findUserBySaml({ idpEntityId: IDP, nameId: NAME_ID })).toBeNull()
  })

  it('link → lookup round-trips to the user', () => {
    const credId = store.linkSaml({ userId, idpEntityId: IDP, nameId: NAME_ID })
    expect(typeof credId).toBe('string')
    expect(store.findUserBySaml({ idpEntityId: IDP, nameId: NAME_ID })).toBe(userId)
  })

  it('authenticateSaml mints a usable local session after linking', () => {
    store.linkSaml({ userId, idpEntityId: IDP, nameId: NAME_ID })
    const session = store.authenticateSaml({ idpEntityId: IDP, nameId: NAME_ID })
    expect(session.userId).toBe(userId)
    expect(session.token).toMatch(/^ses_/)
    const resolved = store.getSessionByToken(session.token)
    expect(resolved?.session.userId).toBe(userId)
    expect(resolved?.user.id).toBe(userId)
  })

  it('authenticateSaml with no link throws saml_not_linked', () => {
    expectCode(() => store.authenticateSaml({ idpEntityId: IDP, nameId: NAME_ID }), 'saml_not_linked')
  })

  it('re-linking the SAME identity to the SAME user is an idempotent no-op', () => {
    const first = store.linkSaml({ userId, idpEntityId: IDP, nameId: NAME_ID })
    const second = store.linkSaml({ userId, idpEntityId: IDP, nameId: NAME_ID })
    expect(second).toBe(first)
    const samlCreds = store.listCredentials(userId).filter((c) => c.kind === 'saml')
    expect(samlCreds).toHaveLength(1)
  })

  it('linking an identity already claimed by another user throws saml_already_linked', () => {
    const other = store.createUser({ email: 'other@team.test', displayName: 'O', role: 'member' }).id
    store.linkSaml({ userId, idpEntityId: IDP, nameId: NAME_ID })
    expectCode(() => store.linkSaml({ userId: other, idpEntityId: IDP, nameId: NAME_ID }), 'saml_already_linked')
    expect(store.findUserBySaml({ idpEntityId: IDP, nameId: NAME_ID })).toBe(userId)
  })

  it('linking to a non-existent user throws user_not_found', () => {
    expectCode(() => store.linkSaml({ userId: 'no-such-user', idpEntityId: IDP, nameId: NAME_ID }), 'user_not_found')
  })

  it('the same NameID from DIFFERENT IdPs are distinct identities (no collision)', () => {
    const other = store.createUser({ email: 'second@team.test', displayName: 'A', role: 'member' }).id
    const idpB = 'https://other-idp.example.com/entity'
    store.linkSaml({ userId, idpEntityId: IDP, nameId: NAME_ID })
    store.linkSaml({ userId: other, idpEntityId: idpB, nameId: NAME_ID })
    expect(store.authenticateSaml({ idpEntityId: IDP, nameId: NAME_ID }).userId).toBe(userId)
    expect(store.authenticateSaml({ idpEntityId: idpB, nameId: NAME_ID }).userId).toBe(other)
    expect(samlLinkIdentifier(IDP, NAME_ID)).not.toBe(samlLinkIdentifier(idpB, NAME_ID))
  })

  it('a SAML link never collides with an OIDC link sharing the same two strings', () => {
    // Different credential kinds keep the namespaces apart even if a hash matched.
    const other = store.createUser({ email: 'oidc@team.test', displayName: 'O', role: 'member' }).id
    store.linkSaml({ userId, idpEntityId: IDP, nameId: NAME_ID })
    store.linkOidc({ userId: other, issuer: IDP, sub: NAME_ID }) // identical (string, string)
    expect(store.authenticateSaml({ idpEntityId: IDP, nameId: NAME_ID }).userId).toBe(userId)
    expect(store.authenticateOidc({ issuer: IDP, sub: NAME_ID }).userId).toBe(other)
  })

  it('the link surfaces in listCredentials with the IdP entityID as its label', () => {
    store.linkSaml({ userId, idpEntityId: IDP, nameId: NAME_ID })
    const cred = store.listCredentials(userId).find((c) => c.kind === 'saml')
    expect(cred).toBeTruthy()
    expect(cred?.label).toBe(IDP)
  })

  it('malformed inputs are rejected without minting a session', () => {
    expect(store.findUserBySaml({ idpEntityId: '', nameId: '' })).toBeNull()
    expectCode(() => store.authenticateSaml({ idpEntityId: '', nameId: NAME_ID }), 'invalid_input')
    expectCode(() => store.linkSaml({ userId, idpEntityId: IDP, nameId: '' }), 'invalid_input')
  })
})
