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
