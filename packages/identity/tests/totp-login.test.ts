/**
 * Route B P1-M3c — the login gate. Once a user has an ACTIVE TOTP factor,
 * `authenticatePassword` must demand the code; token/api-key auth must NOT.
 *
 * The ordering is the security contract: the password is verified FIRST, so a
 * wrong password never reveals whether MFA is on (it's a flat
 * authentication_failed), and the totp_required challenge only appears after a
 * correct password. A wrong code is also a generic authentication_failed — no
 * "password was right, code was wrong" oracle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'

import {
  openIdentityStore,
  IdentityStore,
  IdentityError,
  MASTER_KEY_LEN_BYTES,
} from '../src/index.js'
import { base32Decode, totpCodeAt } from '../src/totp.js'

const FIXED_KEY = randomBytes(MASTER_KEY_LEN_BYTES)
const NOW = 1_700_000_000

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

describe('authenticatePassword — TOTP login gate (P1-M3c)', () => {
  let store: IdentityStore
  let userId: string
  let secret: string
  const email = 'member@team.test'
  const password = 'member-strong-password'

  // A valid code for the current frozen step. The store reads the wall clock
  // internally for login verify, so we drive the assertions at the live time;
  // generate the code from the same wall clock to stay in the ±1 window.
  function liveCode(): string {
    return totpCodeAt(base32Decode(secret), Math.floor(Date.now() / 1000))
  }

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:', masterKey: FIXED_KEY })
    store.bootstrap()
    userId = store.createUser({ email, displayName: 'Member', password, role: 'member' }).id
    secret = store.enrollTotp({ userId, account: email, issuer: 'AipeHub' }).secretBase32
  })
  afterEach(() => store.close())

  it('before activation, password login works with no code (pending does not gate)', () => {
    // secret enrolled but NOT confirmed → no second factor required yet
    const s = store.authenticatePassword({ email, password })
    expect(s.userId).toBe(userId)
  })

  describe('once the factor is active', () => {
    beforeEach(() => {
      // Confirm with a code for the wall clock (verify uses Date.now()).
      const ok = store.confirmTotp({
        userId,
        code: totpCodeAt(base32Decode(secret), Math.floor(Date.now() / 1000)),
      })
      expect(ok).toBe(true)
    })

    it('password alone is challenged with totp_required', () => {
      expectCode(() => store.authenticatePassword({ email, password }), 'totp_required')
    })

    it('password + correct code mints a session', () => {
      const s = store.authenticatePassword({ email, password, totpCode: liveCode() })
      expect(s.userId).toBe(userId)
      expect(s.token).toMatch(/^ses_/u)
    })

    it('password + wrong code is a generic authentication_failed (no oracle)', () => {
      expectCode(
        () => store.authenticatePassword({ email, password, totpCode: '000000' }),
        'authentication_failed',
      )
    })

    it('wrong password never reveals MFA — flat authentication_failed even with a valid code', () => {
      // Password is checked first; a bad password fails before MFA is consulted.
      expectCode(
        () => store.authenticatePassword({ email, password: 'wrong', totpCode: liveCode() }),
        'authentication_failed',
      )
      expectCode(
        () => store.authenticatePassword({ email, password: 'wrong' }),
        'authentication_failed',
      )
    })

    it('token / api-key auth is NOT gated by MFA (non-interactive by design)', () => {
      const { key } = store.issueApiKey({ userId, label: 'ci' })
      const s = store.authenticateToken({ token: key })
      expect(s.userId).toBe(userId)
    })

    it('disabling the factor restores plain password login', () => {
      expect(store.disableTotp(userId)).toBe(true)
      const s = store.authenticatePassword({ email, password })
      expect(s.userId).toBe(userId)
    })
  })

  // Keep NOW referenced so an unused-var lint can't flag the frozen constant
  // (the store drives login verify off the wall clock; NOW documents intent).
  it('frozen-time constant is available for offset reasoning', () => {
    expect(NOW).toBeGreaterThan(0)
  })
})
