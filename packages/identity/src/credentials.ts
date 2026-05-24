/**
 * Credential hashing primitives.
 *
 * # Password (`scrypt`)
 *
 * scrypt with random 16-byte salt, 64-byte derived key, node defaults
 * for CPU/memory cost (N=16384, r=8, p=1). That's ~50-100ms per hash
 * on an M5 — appropriate for an interactive login (slow enough to
 * defeat brute force, fast enough not to DoS the host).
 *
 * # Tokens (admin_token, api_key)
 *
 * sha256 only. These tokens are *already* high-entropy 192-bit randoms
 * we generated ourselves — password-style stretching adds nothing. The
 * sha256 just ensures that a db dump doesn't hand the attacker a usable
 * bearer token directly (they'd need to brute-force 192 bits of random,
 * which is infeasible).
 *
 * # Timing safety
 *
 * Every compare uses `timingSafeEqual` after early-returning on length
 * mismatch (timingSafeEqual throws on differing-length buffers — the
 * length leak itself is harmless since salt length and hash length are
 * both constants).
 */

import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createHash,
} from 'node:crypto'

const SCRYPT_KEYLEN = 64
const PASSWORD_SCHEME = 'scrypt'

/** Minimum password length we'll accept. Loose — UX gate, not real entropy. */
export const MIN_PASSWORD_LENGTH = 8

export function hashPassword(password: string): string {
  if (typeof password !== 'string') {
    throw new TypeError('password must be a string')
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN)
  return `${PASSWORD_SCHEME}$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  if (typeof password !== 'string' || typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 3) return false
  const [scheme, saltHex, hashHex] = parts
  if (scheme !== PASSWORD_SCHEME) return false
  if (!saltHex || !hashHex) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(saltHex, 'hex')
    expected = Buffer.from(hashHex, 'hex')
  } catch {
    return false
  }
  if (expected.length === 0) return false
  let candidate: Buffer
  try {
    candidate = scryptSync(password, salt, expected.length)
  } catch {
    return false
  }
  // Both buffers are exactly `expected.length` by construction — safe.
  return timingSafeEqual(expected, candidate)
}

/**
 * Hash a high-entropy bearer token (api key or admin token) for at-rest
 * storage. sha256 hex (64 chars). See module doc for why not scrypt.
 */
export function hashToken(token: string): string {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('token must be a non-empty string')
  }
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Constant-time compare two sha256 hex digests. Returns false on any
 * malformed input rather than throwing — callers want a boolean.
 */
export function tokenHashEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  if (a.length === 0) return false
  let ab: Buffer
  let bb: Buffer
  try {
    ab = Buffer.from(a, 'hex')
    bb = Buffer.from(b, 'hex')
  } catch {
    return false
  }
  if (ab.length !== bb.length || ab.length === 0) return false
  return timingSafeEqual(ab, bb)
}
