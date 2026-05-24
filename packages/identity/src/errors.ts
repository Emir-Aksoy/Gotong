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
