/**
 * @aipehub/identity — public re-exports.
 *
 * Consumers import from the package root:
 *   import { openIdentityStore, type User } from '@aipehub/identity'
 *
 * Internal modules (db / schema / credentials / tokens) are not exported;
 * they're implementation details of `IdentityStore` and may change
 * without a major bump as long as the public surface here is stable.
 */

export { openIdentityStore, IdentityStore } from './store.js'
export { IdentityError } from './errors.js'
export type { IdentityErrorCode, IdentityErrorOptions } from './errors.js'
export type {
  User,
  Role,
  Membership,
  Session,
  Credential,
  CredentialKind,
  IssuedApiKey,
  IssuedAdminToken,
  CreateUserInput,
  BootstrapInput,
  BootstrapResult,
  AuditLogEntry,
  AuditActorSource,
  WriteAuditLogInput,
  ListAuditLogQuery,
  Invitation,
  InvitationStatus,
  CreateInvitationInput,
  IssuedInvitation,
  AcceptInvitationInput,
  ListInvitationsQuery,
} from './types.js'
