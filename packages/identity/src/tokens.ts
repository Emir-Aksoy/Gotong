/**
 * Opaque token + id generation.
 *
 * All tokens are 192-bit (24 random bytes) encoded as base64url. The
 * prefix is purely cosmetic — lets a human glance at a string and know
 * what kind of secret they're looking at:
 *
 *   ses_<32 chars base64url>    session token   (short-lived, 7d default)
 *   adm_<32 chars base64url>    admin token     (long-lived, owner grant)
 *   aipk_<32 chars base64url>   api key         (long-lived, programmatic)
 *
 * 192 bits comfortably exceeds OWASP's 128-bit floor for opaque
 * bearer secrets. Birthday-collision risk is irrelevant at every scale
 * a v4 host will see.
 *
 * `newId()` is a simpler "sortable id": 13-digit ms timestamp + a
 * hyphen + 24 hex chars of randomness (96 bits). 38 chars total.
 * Lexicographically sortable, never-collide at our scale, no external
 * dep. Used for table PKs (users.id, credentials.id, memberships.id).
 */

import { randomBytes } from 'node:crypto'

const PREFIX = {
  session: 'ses_',
  adminToken: 'adm_',
  apiKey: 'aipk_',
  // Invitation tokens — single-use, short-lived (default 24h). The
  // `inv_` prefix lets the /invite landing page distinguish them at
  // a glance from other secret shapes.
  invitation: 'inv_',
} as const

export function newSessionToken(): string {
  return PREFIX.session + randomBytes(24).toString('base64url')
}

export function newAdminToken(): string {
  return PREFIX.adminToken + randomBytes(24).toString('base64url')
}

export function newApiKey(): string {
  return PREFIX.apiKey + randomBytes(24).toString('base64url')
}

export function newInvitationToken(): string {
  return PREFIX.invitation + randomBytes(24).toString('base64url')
}

/**
 * Sortable opaque id for table PKs. 13-digit ms timestamp + '-' + 24
 * hex (96 bits random). Total 38 chars. Not a true ULID — we don't
 * need crockford-base32 or monotonic-within-ms guarantees, and a
 * zero-dep impl was the point.
 */
export function newId(): string {
  const time = Date.now().toString().padStart(13, '0')
  const rand = randomBytes(12).toString('hex')
  return `${time}-${rand}`
}

// =====================================================================
// SHELL-M1 — device pairing codes
//
// Deliberately NOT the shape of the IM binding code (6 decimal digits,
// `store.ts` issueImBindingCode). That one is safe because its only
// redemption path is an IM bridge calling in-process, behind whatever
// rate limiting the chat platform already imposes. A device pairing
// code is redeemed over a PUBLIC HTTP endpoint — the client has no
// credential yet, that's the whole point — so 10^6 is not a defensible
// search space: a patient attacker gets more than a million attempts in
// a month even under modest rate limiting.
//
// 16 chars of Crockford base32 = 80 bits. The alphabet drops I, L, O
// and U so nothing reads ambiguously on a phone screen, and
// `normalizeDevicePairingCode` folds the mistakes a human actually
// makes when re-typing (case, I/L -> 1, O -> 0, grouping separators).
// Codes are stored normalized; only the UI groups them for display.
const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const DEVICE_PAIRING_CODE_LENGTH = 16

export function newDevicePairingCode(): string {
  // Rejection-free: 32 divides 256, so byte % 32 is uniform.
  const bytes = randomBytes(DEVICE_PAIRING_CODE_LENGTH)
  let out = ''
  for (const b of bytes) out += PAIRING_ALPHABET[b % 32]
  return out
}

/**
 * Fold a human-typed pairing code back to its canonical form, or null
 * when it cannot be one. Accepts any grouping (`ABCD-EFGH`, spaces),
 * any case, and the classic transcription confusions. Returning null
 * rather than throwing keeps callers' shape checks in one place.
 */
export function normalizeDevicePairingCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let out = ''
  for (const ch of raw.toUpperCase()) {
    if (ch === '-' || ch === ' ') continue
    // Crockford's documented confusions, applied before alphabet check.
    const folded = ch === 'I' || ch === 'L' ? '1' : ch === 'O' ? '0' : ch
    if (!PAIRING_ALPHABET.includes(folded)) return null
    out += folded
  }
  return out.length === DEVICE_PAIRING_CODE_LENGTH ? out : null
}

/** `ABCD-EFGH-JKMN-PQRS` — display only; never what we store or compare. */
export function formatDevicePairingCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-')
}
