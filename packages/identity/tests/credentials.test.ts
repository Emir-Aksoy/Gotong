/**
 * Unit tests for the hashing primitives in src/credentials.ts.
 *
 * These are pure functions over strings — no SQLite, no IdentityStore.
 * Goal: pin down the security-relevant invariants (random salts, format
 * tolerance, timing-safe compare) so a future refactor of credentials.ts
 * can't silently regress them.
 */

import { describe, it, expect } from 'vitest'

import {
  hashPassword,
  verifyPassword,
  hashToken,
  tokenHashEquals,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from '../src/credentials.js'

// Pin the constant publicly — production should never silently weaken it.
const _ = MAX_PASSWORD_LENGTH

describe('hashPassword / verifyPassword', () => {
  it('round-trips a correct password', () => {
    const stored = hashPassword('correcthorse-battery-staple')
    expect(verifyPassword('correcthorse-battery-staple', stored)).toBe(true)
  })

  it('rejects a wrong password', () => {
    const stored = hashPassword('correcthorse-battery-staple')
    expect(verifyPassword('wrong-password-here', stored)).toBe(false)
  })

  it('two hashes of the same password differ (random salt)', () => {
    const a = hashPassword('same-password-twice')
    const b = hashPassword('same-password-twice')
    expect(a).not.toBe(b)
    // Both still verify.
    expect(verifyPassword('same-password-twice', a)).toBe(true)
    expect(verifyPassword('same-password-twice', b)).toBe(true)
  })

  it('rejects passwords shorter than MIN_PASSWORD_LENGTH', () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(8)
    expect(() => hashPassword('short')).toThrow(/at least/)
  })

  // V4-AUDIT-08
  it('rejects passwords longer than MAX_PASSWORD_LENGTH (defensive cap)', () => {
    const tooLong = 'x'.repeat(4097)
    expect(() => hashPassword(tooLong)).toThrow(/at most/)
  })

  it('accepts passwords at the MAX_PASSWORD_LENGTH boundary', () => {
    const justRight = 'x'.repeat(4096)
    expect(() => hashPassword(justRight)).not.toThrow()
  })

  it('verifyPassword returns false on malformed stored strings (no throw)', () => {
    expect(verifyPassword('whatever', 'not-a-valid-stored-hash')).toBe(false)
    expect(verifyPassword('whatever', 'wrong$scheme$value')).toBe(false)
    expect(verifyPassword('whatever', 'scrypt$nothex$nothex')).toBe(false)
    expect(verifyPassword('whatever', 'scrypt$ab$')).toBe(false)
    expect(verifyPassword('whatever', '')).toBe(false)
  })

  it('verifyPassword returns false on non-string inputs', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(verifyPassword(123 as any, 'whatever')).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(verifyPassword('whatever', null as any)).toBe(false)
  })
})

describe('hashToken / tokenHashEquals', () => {
  it('hashToken is deterministic for the same input', () => {
    const a = hashToken('aipk_abc-123')
    const b = hashToken('aipk_abc-123')
    expect(a).toBe(b)
  })

  it('hashToken differs for different inputs', () => {
    const a = hashToken('token-one')
    const b = hashToken('token-two')
    expect(a).not.toBe(b)
  })

  it('hashToken output is 64 hex chars (sha256)', () => {
    const h = hashToken('any-input')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashToken rejects empty / non-string', () => {
    expect(() => hashToken('')).toThrow(/non-empty/)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => hashToken(null as any)).toThrow()
  })

  it('tokenHashEquals: same hash returns true', () => {
    const h = hashToken('x')
    expect(tokenHashEquals(h, h)).toBe(true)
  })

  it('tokenHashEquals: different length returns false', () => {
    expect(tokenHashEquals('a'.repeat(64), 'a'.repeat(63))).toBe(false)
  })

  it('tokenHashEquals: same length different content returns false', () => {
    expect(tokenHashEquals('0'.repeat(64), '1'.repeat(64))).toBe(false)
  })

  it('tokenHashEquals: empty / non-hex / non-string is false', () => {
    expect(tokenHashEquals('', '')).toBe(false)
    expect(tokenHashEquals('not-hex-chars-here'.padEnd(64, 'z'), 'a'.repeat(64))).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(tokenHashEquals(null as any, 'a'.repeat(64))).toBe(false)
  })
})
