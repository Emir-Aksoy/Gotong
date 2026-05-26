/**
 * Error taxonomy for @aipehub/identity.
 *
 * Every failure throws an `IdentityError` whose `code` discriminates
 * the failure mode for callers that want to map to HTTP status / UI
 * messages without parsing strings. Codes are stable; messages are not.
 */

export type IdentityErrorCode =
  | 'duplicate_email'
  | 'duplicate_credential'
  | 'invalid_role'
  | 'invalid_email'
  | 'invalid_input'
  | 'user_not_found'
  | 'credential_not_found'
  | 'authentication_failed'
  | 'session_expired'
  | 'session_not_found'
  | 'weak_password'
  /**
   * V4-AUDIT-03: setRole was called on the last remaining owner with a
   * non-owner target. Refused to prevent permanent lockout. Operator
   * must promote another user to owner first, then retry the demotion.
   */
  | 'last_owner'
  // Invitation flow (Phase 3 — user invitations).
  | 'invitation_not_found'
  | 'invitation_expired'
  | 'invitation_already_used'
  | 'invitation_revoked'
  /**
   * createInvitation refused because a pending (non-expired, non-revoked,
   * non-accepted) invite for this email already exists. The owner can
   * revoke the older invite first, then create a fresh one.
   */
  | 'invitation_pending_exists'
  /**
   * Phase 6 #9: createInvitation refused because the org-wide active-
   * pending invites count has reached `AIPE_MAX_PENDING_INVITES` (default
   * 1000). The hard cap guards against table-blowup from an owner /
   * script bug. Operator must revoke some pending invites (or wait for
   * expiry) before creating new ones.
   */
  | 'invitations_limit_exceeded'
  // Vault (Phase 5 A1 — encrypted application-layer secret storage).
  /**
   * Vault row not found (or already hard-deleted — soft-delete rows
   * stay queryable until you pass `activeOnly:false`, so this code
   * means "no row by that id at all").
   */
  | 'vault_entry_not_found'
  /**
   * Attempted to call a vault method but the IdentityStore was opened
   * without a `masterKey`. Vault APIs require the key to encrypt /
   * decrypt; without it they refuse rather than no-op or silently fail.
   */
  | 'vault_not_configured'
  /**
   * Decryption failed: format mismatch, unknown version prefix, AES-GCM
   * auth tag rejection, or wrong master key. Surface code is opaque on
   * purpose — distinguishing "tampered" from "wrong key" leaks
   * information to an attacker who can repeatedly poke the API.
   */
  | 'vault_decrypt_failed'
  // D1 (Phase 5) — Peer Registry.
  /** UNIQUE constraint violated on peers.peer_id during addPeer. */
  | 'peer_id_taken'
  /** No peers row by that internal id. */
  | 'peer_not_found'
  // E1 (Phase 5) — org soft quotas.
  /** No org_quotas row for the requested (metric, period) tuple. */
  | 'org_quota_not_found'

export interface IdentityErrorOptions {
  code: IdentityErrorCode
  message: string
  cause?: unknown
}

export class IdentityError extends Error {
  readonly code: IdentityErrorCode

  constructor(opts: IdentityErrorOptions) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'IdentityError'
    this.code = opts.code
  }
}
