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
