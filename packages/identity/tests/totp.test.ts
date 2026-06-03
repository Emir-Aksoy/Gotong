/**
 * Route B P1-M3a — TOTP primitive pinned against the official spec vectors.
 *
 * The RFC 6238 Appendix B table is the ground truth: a known 20-byte ASCII seed
 * ("12345678901234567890") produces exact 8-digit codes at listed times. If the
 * HMAC counter packing or dynamic truncation drifts, these go red. RFC 4648
 * gives the base32 ground truth. These golden vectors are the whole point of
 * keeping the algorithm a pure, storage-free layer.
 */

import { describe, it, expect } from 'vitest'

import {
  base32Encode,
  base32Decode,
  hotp,
  totpCodeAt,
  verifyTotp,
  generateTotpSecret,
  buildOtpauthUri,
} from '../src/totp.js'

// RFC 6238 Appendix B seed for HMAC-SHA1: ASCII "12345678901234567890".
const RFC_SEED = Buffer.from('12345678901234567890', 'ascii')

describe('TOTP — RFC 6238 Appendix B official vectors (SHA1, 8 digits)', () => {
  // [unix seconds, expected 8-digit TOTP]
  const VECTORS: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]

  for (const [t, expected] of VECTORS) {
    it(`t=${t} → ${expected}`, () => {
      expect(totpCodeAt(RFC_SEED, t, { digits: 8, stepSeconds: 30, epoch: 0 })).toBe(expected)
    })
  }
})

describe('HOTP — RFC 4226 Appendix D official vectors (SHA1, 6 digits)', () => {
  // The HOTP truncation table for the same 20-byte seed, counters 0..9.
  const HOTP_VECTORS = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ]
  HOTP_VECTORS.forEach((expected, counter) => {
    it(`counter=${counter} → ${expected}`, () => {
      expect(hotp(RFC_SEED, counter, 6)).toBe(expected)
    })
  })
})

describe('base32 — RFC 4648 §10 official vectors', () => {
  const VECTORS: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY======'],
    ['fo', 'MZXQ===='],
    ['foo', 'MZXW6==='],
    ['foob', 'MZXW6YQ='],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI======'],
  ]

  for (const [plain, encoded] of VECTORS) {
    it(`encode("${plain}") → "${encoded}"`, () => {
      expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded)
    })
    it(`decode("${encoded}") → "${plain}"`, () => {
      expect(base32Decode(encoded).toString('ascii')).toBe(plain)
    })
  }

  it('decode tolerates lowercase, spaces, and missing padding', () => {
    expect(base32Decode('mz xw 6ytb').toString('ascii')).toBe('fooba')
    expect(base32Decode('MZXW6YTBOI').toString('ascii')).toBe('foobar') // no '='
  })

  it('decode throws on a non-alphabet character (typo fails loud)', () => {
    expect(() => base32Decode('MZXW6YT1')).toThrow(/invalid base32/u)
  })

  it('round-trips arbitrary bytes', () => {
    const bytes = Buffer.from([0, 1, 2, 254, 255, 128, 64, 32, 7])
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true)
  })
})

describe('verifyTotp — window, skew, and rejection', () => {
  // Use a real generated secret; verify against the code we just derived.
  const { secret } = generateTotpSecret()
  const NOW = 1_700_000_000 // frozen reference time (passed in, never read)

  it('accepts the code for the current step', () => {
    const code = totpCodeAt(secret, NOW)
    expect(verifyTotp(secret, code, NOW)).toBe(true)
  })

  it('accepts the previous and next step within the default ±1 window', () => {
    const prev = totpCodeAt(secret, NOW - 30)
    const next = totpCodeAt(secret, NOW + 30)
    expect(verifyTotp(secret, prev, NOW)).toBe(true)
    expect(verifyTotp(secret, next, NOW)).toBe(true)
  })

  it('rejects a code two steps away (outside the ±1 window)', () => {
    const farPast = totpCodeAt(secret, NOW - 60)
    expect(verifyTotp(secret, farPast, NOW)).toBe(false)
    // ...but a wider window would accept it.
    expect(verifyTotp(secret, farPast, NOW, { window: 2 })).toBe(true)
  })

  it('rejects a wrong code, wrong length, and non-numeric input', () => {
    expect(verifyTotp(secret, '000000', NOW - 99999)).toBe(false)
    expect(verifyTotp(secret, '12345', NOW)).toBe(false) // 5 digits
    expect(verifyTotp(secret, 'abcdef', NOW)).toBe(false)
  })

  it('verifies against a secret restored from its base32 form (storage shape)', () => {
    const { base32 } = generateTotpSecret()
    const restored = base32Decode(base32)
    const code = totpCodeAt(restored, NOW)
    expect(verifyTotp(restored, code, NOW)).toBe(true)
  })
})

describe('generateTotpSecret + otpauth URI', () => {
  it('generates a 20-byte secret whose base32 decodes back', () => {
    const { secret, base32 } = generateTotpSecret()
    expect(secret.length).toBe(20)
    expect(base32Decode(base32).equals(secret)).toBe(true)
  })

  it('builds an otpauth URI with issuer, account, secret, and no algorithm (SHA1 default)', () => {
    const uri = buildOtpauthUri({
      secretBase32: 'MZXW6YTBOI======',
      account: 'member@team.test',
      issuer: 'AipeHub',
    })
    expect(uri.startsWith('otpauth://totp/')).toBe(true)
    expect(uri).toContain('secret=MZXW6YTBOI')
    expect(uri).toContain('issuer=AipeHub')
    expect(uri).toContain('digits=6')
    expect(uri).toContain('period=30')
    // We deliberately omit algorithm so apps use their SHA1 default.
    expect(uri).not.toContain('algorithm=')
  })
})
