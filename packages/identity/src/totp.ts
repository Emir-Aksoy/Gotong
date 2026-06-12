/**
 * RFC 6238 TOTP + RFC 4226 HOTP + RFC 4648 base32 — the pure algorithm layer
 * for MFA (Route B P1-M3a). NO storage, NO wiring: this module is a set of
 * deterministic functions so the spec can be pinned against its official test
 * vectors (RFC 6238 Appendix B), independent of how a secret is stored or when
 * the clock is read.
 *
 * Determinism is deliberate: every code-deriving function takes the unix time
 * (seconds) as an ARGUMENT rather than calling the clock itself. The caller
 * (the login flow) passes `Date.now() / 1000`. That keeps the crypto core
 * testable with frozen time and keeps "what time is it" a single concern at the
 * edge.
 *
 * We implement HMAC-SHA1 only. Every mainstream authenticator app (Google
 * Authenticator, Authy, 1Password, …) defaults to SHA1 / 6 digits / 30s, and
 * the otpauth:// URI we emit omits the algorithm so apps use that default. The
 * SHA256/SHA512 RFC vectors use *different* seeds per mode and are a common
 * source of wrong implementations; we don't need them, so we don't pretend to.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Authenticator-app defaults. Apps assume these when the URI omits them. */
export const TOTP_DEFAULT_DIGITS = 6
export const TOTP_DEFAULT_PERIOD_S = 30
/** 20 random bytes = 160 bits, the RFC 4226 recommended HOTP key length. */
export const TOTP_SECRET_BYTES = 20

// --- RFC 4648 base32 (no '0/1/8/9', uppercase) --------------------------------
// Authenticator apps expect the shared secret as base32 in the otpauth:// URI.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Encode bytes to RFC 4648 base32 with '=' padding (the form apps accept). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f]
  }
  // Pad to a multiple of 8 chars so strict decoders round-trip it.
  while (out.length % 8 !== 0) out += '='
  return out
}

/**
 * Decode RFC 4648 base32. Tolerant of lowercase, spaces, and missing padding
 * (users paste secrets in all of those forms). Throws on a non-alphabet char so
 * a typo'd secret fails loud rather than silently verifying nothing.
 */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/u, '').replace(/\s+/gu, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) {
      throw new Error(`invalid base32 character: ${ch}`)
    }
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

// --- RFC 4226 HOTP / RFC 6238 TOTP -------------------------------------------

/** Pack a 64-bit unsigned counter big-endian, per RFC 4226 §5.1. */
function counterToBuffer(counter: number): Buffer {
  const buf = Buffer.alloc(8)
  // JS bitwise is 32-bit; split into hi/lo 32-bit halves to fill all 8 bytes.
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  return buf
}

/**
 * RFC 4226 HOTP: HMAC-SHA1(secret, counter) → dynamic-truncate → N digits,
 * zero-padded. This is the kernel both TOTP code-gen and verify run through.
 */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DEFAULT_DIGITS): string {
  const mac = createHmac('sha1', secret).update(counterToBuffer(counter)).digest()
  // Dynamic truncation (RFC 4226 §5.3): low nibble of the last byte is an
  // offset into the MAC; take 31 bits from there (mask the sign bit).
  const offset = mac[mac.length - 1]! & 0x0f
  const binCode =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff)
  const mod = binCode % 10 ** digits
  return mod.toString().padStart(digits, '0')
}

export interface TotpParams {
  /** Seconds per step (RFC 6238 X). Default 30. */
  stepSeconds?: number
  /** Epoch start (RFC 6238 T0). Default 0. */
  epoch?: number
  /** Output digit count. Default 6. */
  digits?: number
}

/** The RFC 6238 time-step counter for a given unix time. */
function timeCounter(unixSeconds: number, params: TotpParams): number {
  const step = params.stepSeconds ?? TOTP_DEFAULT_PERIOD_S
  const t0 = params.epoch ?? 0
  return Math.floor((unixSeconds - t0) / step)
}

/** RFC 6238 TOTP code for a secret at a given unix time (seconds). */
export function totpCodeAt(secret: Buffer, unixSeconds: number, params: TotpParams = {}): string {
  return hotp(secret, timeCounter(unixSeconds, params), params.digits ?? TOTP_DEFAULT_DIGITS)
}

export interface VerifyTotpParams extends TotpParams {
  /**
   * How many steps before/after `now` to also accept, absorbing clock skew and
   * a user typing as a code rolls over. Default 1 (±30s) — the conventional
   * authenticator tolerance. Larger windows trade security for forgiveness.
   */
  window?: number
}

/**
 * Constant-time verify of a candidate code against every step in the accepted
 * window. Returns true on a match. The compare is `timingSafeEqual` per
 * candidate so a near-miss can't be teased out by response timing; the loop
 * itself is not constant-time across the window, but the window is a small
 * fixed constant and reveals nothing about the secret.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  unixSeconds: number,
  params: VerifyTotpParams = {},
): boolean {
  return matchTotpStep(secret, code, unixSeconds, params) != null
}

/**
 * Like `verifyTotp`, but returns the matched absolute TIME STEP (counter)
 * instead of a boolean — `null` on no match. The step is what a replay guard
 * persists: RFC 6238 §5.2 says a verifier must not accept a second code for
 * the same or an earlier step once one has been accepted (audit F1).
 */
export function matchTotpStep(
  secret: Buffer,
  code: string,
  unixSeconds: number,
  params: VerifyTotpParams = {},
): number | null {
  const digits = params.digits ?? TOTP_DEFAULT_DIGITS
  const candidate = code.replace(/\s+/gu, '')
  if (!/^\d+$/u.test(candidate) || candidate.length !== digits) return null
  const window = params.window ?? 1
  const center = timeCounter(unixSeconds, params)
  const candBuf = Buffer.from(candidate, 'utf8')
  let matched: number | null = null
  for (let offset = -window; offset <= window; offset++) {
    const step = center + offset
    const expected = hotp(secret, step, digits)
    const expBuf = Buffer.from(expected, 'utf8')
    // Length is always `digits` for both, so timingSafeEqual is safe to call.
    if (expBuf.length === candBuf.length && timingSafeEqual(expBuf, candBuf)) {
      matched = step
    }
  }
  return matched
}

export interface GeneratedTotpSecret {
  /** Raw secret bytes (store these, encrypted at rest). */
  secret: Buffer
  /** base32 form for the otpauth:// URI / manual entry. */
  base32: string
}

/** Generate a fresh random TOTP secret (default 160 bits). */
export function generateTotpSecret(bytes = TOTP_SECRET_BYTES): GeneratedTotpSecret {
  const secret = randomBytes(bytes)
  return { secret, base32: base32Encode(secret) }
}

export interface OtpauthUriInput {
  /** base32 secret. */
  secretBase32: string
  /** The human label for the account (usually the user's email). */
  account: string
  /** The service name shown in the authenticator app. */
  issuer: string
  digits?: number
  periodSeconds?: number
}

/**
 * Build an `otpauth://totp/...` URI (the QR-code payload). We omit `algorithm`
 * so apps use their SHA1 default — matching our HMAC-SHA1 implementation.
 */
export function buildOtpauthUri(input: OtpauthUriInput): string {
  const label = `${input.issuer}:${input.account}`
  const q = new URLSearchParams({
    secret: input.secretBase32,
    issuer: input.issuer,
    digits: String(input.digits ?? TOTP_DEFAULT_DIGITS),
    period: String(input.periodSeconds ?? TOTP_DEFAULT_PERIOD_S),
  })
  return `otpauth://totp/${encodeURIComponent(label)}?${q.toString()}`
}
