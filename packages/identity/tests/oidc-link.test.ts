/**
 * Route B P1-M4a — OIDC account linking + authenticateOidc.
 *
 * Decision D-3 made concrete: an OIDC login does NOT replumb the request path
 * to carry IdP tokens; it merely maps a verified (issuer, sub) to a local user
 * and mints the SAME `ses_` session every other auth path produces. These
 * tests pin: round-trip link/lookup, the session is genuinely usable
 * (getSessionByToken resolves it), no-link → typed `oidc_not_linked`, linking
 * is idempotent for the same user but conflicts (`oidc_already_linked`) for a
 * different one, distinct issuers sharing a `sub` never collide, and the link
 * surfaces in listCredentials with the issuer as its label.
 *
 * The (issuer, sub) is assumed already validated — id_token signature/iss/aud/
 * exp/nonce checks live in M4b. M4a is pure mapping + session mint.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { openIdentityStore, IdentityStore, IdentityError } from '../src/index.js'
import { oidcLinkIdentifier } from '../src/credentials.js'

/** Assert a thunk throws an IdentityError carrying a specific code. */
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

const ISS = 'https://accounts.google.com'
const SUB = '110169484474386276334'

describe('OIDC account linking (P1-M4a)', () => {
  let store: IdentityStore
  let userId: string

  beforeEach(() => {
    // No master key needed — OIDC links live in the credentials table, not the
    // vault (there is no replayable secret to encrypt).
    store = openIdentityStore({ dbPath: ':memory:' })
    store.bootstrap()
    userId = store.createUser({ email: 'm@team.test', displayName: 'M', role: 'member' }).id
  })
  afterEach(() => store.close())

  it('findUserByOidc returns null before any link', () => {
    expect(store.findUserByOidc({ issuer: ISS, sub: SUB })).toBeNull()
  })

  it('link → lookup round-trips to the user', () => {
    const credId = store.linkOidc({ userId, issuer: ISS, sub: SUB })
    expect(typeof credId).toBe('string')
    expect(store.findUserByOidc({ issuer: ISS, sub: SUB })).toBe(userId)
  })

  it('authenticateOidc mints a usable local session after linking', () => {
    store.linkOidc({ userId, issuer: ISS, sub: SUB })
    const session = store.authenticateOidc({ issuer: ISS, sub: SUB })
    expect(session.userId).toBe(userId)
    expect(session.token).toMatch(/^ses_/)
    // The session is real, not a bare object — the store resolves it.
    const resolved = store.getSessionByToken(session.token)
    expect(resolved?.session.userId).toBe(userId)
    expect(resolved?.user.id).toBe(userId)
  })

  it('authenticateOidc with no link throws oidc_not_linked', () => {
    expectCode(() => store.authenticateOidc({ issuer: ISS, sub: SUB }), 'oidc_not_linked')
  })

  it('re-linking the SAME identity to the SAME user is an idempotent no-op', () => {
    const first = store.linkOidc({ userId, issuer: ISS, sub: SUB })
    const second = store.linkOidc({ userId, issuer: ISS, sub: SUB })
    expect(second).toBe(first) // same credential id, no duplicate row
    // Exactly one oidc credential exists for the user.
    const oidcCreds = store.listCredentials(userId).filter((c) => c.kind === 'oidc')
    expect(oidcCreds).toHaveLength(1)
  })

  it('linking an identity already claimed by another user throws oidc_already_linked', () => {
    const other = store.createUser({ email: 'other@team.test', displayName: 'O', role: 'member' }).id
    store.linkOidc({ userId, issuer: ISS, sub: SUB })
    expectCode(() => store.linkOidc({ userId: other, issuer: ISS, sub: SUB }), 'oidc_already_linked')
    // The original link is untouched — the conflict did not steal it.
    expect(store.findUserByOidc({ issuer: ISS, sub: SUB })).toBe(userId)
  })

  it('linking to a non-existent user throws user_not_found', () => {
    expectCode(() => store.linkOidc({ userId: 'no-such-user', issuer: ISS, sub: SUB }), 'user_not_found')
  })

  it('the same sub from DIFFERENT issuers are distinct identities (no collision)', () => {
    const other = store.createUser({ email: 'azure@team.test', displayName: 'A', role: 'member' }).id
    const issB = 'https://login.microsoftonline.com/common/v2.0'
    store.linkOidc({ userId, issuer: ISS, sub: SUB })
    store.linkOidc({ userId: other, issuer: issB, sub: SUB }) // same sub, different issuer
    expect(store.authenticateOidc({ issuer: ISS, sub: SUB }).userId).toBe(userId)
    expect(store.authenticateOidc({ issuer: issB, sub: SUB }).userId).toBe(other)
    // The composite identifiers are genuinely different.
    expect(oidcLinkIdentifier(ISS, SUB)).not.toBe(oidcLinkIdentifier(issB, SUB))
  })

  it('the link surfaces in listCredentials with the issuer as its label', () => {
    store.linkOidc({ userId, issuer: ISS, sub: SUB })
    const cred = store.listCredentials(userId).find((c) => c.kind === 'oidc')
    expect(cred).toBeTruthy()
    expect(cred?.label).toBe(ISS) // admins can see WHICH IdP at a glance
  })

  it('malformed inputs are rejected without minting a session', () => {
    expect(store.findUserByOidc({ issuer: '', sub: '' })).toBeNull()
    expectCode(() => store.authenticateOidc({ issuer: '', sub: SUB }), 'invalid_input')
    expectCode(() => store.linkOidc({ userId, issuer: ISS, sub: '' }), 'invalid_input')
  })
})
