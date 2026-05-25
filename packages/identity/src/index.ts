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
  AuditAction,
  Invitation,
  InvitationStatus,
  CreateInvitationInput,
  IssuedInvitation,
  AcceptInvitationInput,
  ListInvitationsQuery,
  // Vault (A1 — Phase 5)
  VaultKind,
  OwnerKind,
  VaultEntry,
  CreateVaultEntryInput,
  ListVaultEntriesQuery,
  // Usage counters (B2.1 — Phase 5)
  UsagePeriod,
  UsageCounter,
  SetQuotaInput,
  GetUsageQuery,
  CheckAndIncrementInput,
  CheckAndIncrementResult,
  ResetUsageInput,
} from './types.js'
export {
  AUDIT_ACTIONS,
  ROLES,
  VAULT_KINDS,
  OWNER_KINDS,
  USAGE_PERIODS,
  USAGE_METRIC_MAX_LEN,
} from './types.js'
// A1 — exported so hosts can wire the workspace .key file into
// openIdentityStore. crypto primitives (encryptSecret / decryptSecret)
// are NOT re-exported: callers should only ever touch plaintext via
// IdentityStore.readVaultSecret, which enforces the masterKey config
// gate and last_used_at tracking.
export { loadOrCreateMasterKey, MASTER_KEY_LEN_BYTES } from './crypto.js'
