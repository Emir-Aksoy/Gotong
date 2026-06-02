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
// R13 — vault domain extracted to vault-store.ts; the type lives there now.
export type { VaultMutationReason } from './vault-store.js'
// Phase 7 M4 — org-mode + general org-meta surface for the SPA shell
// switch (personal vs team) and any future org-wide scalar config.
export type OrgMode = 'personal' | 'team'
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
  SweepUsageResult,
  // Peer registry (D1 — Phase 5)
  PeerRegistration,
  AddPeerInput,
  UpdatePeerInput,
  ListPeersQuery,
  // Per-org soft quotas (E1 — Phase 5)
  OrgQuota,
  OrgQuotaState,
  SetOrgQuotaInput,
  CheckOrgQuotaResult,
  // Usage / cost ledger (Phase 17 — Sprint 4)
  LedgerEntry,
  LedgerAppendInput,
  LedgerQuery,
  LedgerGroupBy,
  LedgerAggregateQuery,
  LedgerAggregateRow,
  // Phase 11 M2 — Suspended tasks (long-running agent park/resume)
  SuspendedTask,
  PersistSuspendedTaskInput,
  ListDueSuspendedTasksQuery,
  // Phase 12 M1 — IM bindings
  ImBinding,
  ImBindingCode,
  IssueImBindingCodeInput,
  ClaimImBindingCodeInput,
  ClaimImBindingResult,
  ListImBindingsQuery,
  WorkflowGrant,
  SetWorkflowGrantInput,
  WorkflowPerm,
} from './types.js'
export {
  AUDIT_ACTIONS,
  ROLES,
  VAULT_KINDS,
  OWNER_KINDS,
  USAGE_PERIODS,
  USAGE_METRIC_MAX_LEN,
  ORG_QUOTA_STATES,
  WORKFLOW_PERMS,
  WORKFLOW_PERM_RANK,
} from './types.js'
// v5 Stream 0 — unified Principal vocabulary (org→hub convergence).
export type { PrincipalKind, Principal } from './principal.js'
export {
  PRINCIPAL_KINDS,
  HUB_SELF_ID,
  HUB_PRINCIPAL,
  isPrincipalKind,
  userPrincipal,
  agentPrincipal,
  peerPrincipal,
  hubPrincipal,
  principalKey,
  parsePrincipalKey,
  principalFromVaultOwner,
  principalToVaultOwner,
} from './principal.js'
// v5 Stream 0-M2 — agent-as-owner authority boundary (requires_human gate).
export type { AgentHumanConfirmAction, AuthorityDecision } from './agent-authority.js'
export {
  AGENT_HUMAN_CONFIRM_ACTIONS,
  isHumanConfirmAction,
  describeHumanConfirmAction,
  authorizeAgentAction,
} from './agent-authority.js'
// A1 — exported so hosts can wire the workspace .key file into
// openIdentityStore. crypto primitives (encryptSecret / decryptSecret)
// are NOT re-exported: callers should only ever touch plaintext via
// IdentityStore.readVaultSecret, which enforces the masterKey config
// gate and last_used_at tracking.
export { loadOrCreateMasterKey, MASTER_KEY_LEN_BYTES } from './crypto.js'
