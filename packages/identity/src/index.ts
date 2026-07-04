/**
 * @gotong/identity — public re-exports.
 *
 * Consumers import from the package root:
 *   import { openIdentityStore, type User } from '@gotong/identity'
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
  LinkOidcInput,
  OidcLogin,
  LinkSamlInput,
  SamlLogin,
  OidcProvider,
  AddOidcProviderInput,
  UpdateOidcProviderInput,
  SamlProvider,
  AddSamlProviderInput,
  UpdateSamlProviderInput,
  A2aOutboundAgent,
  AddA2aOutboundAgentInput,
  UpdateA2aOutboundAgentInput,
  AcpOutboundAgent,
  AddAcpOutboundAgentInput,
  UpdateAcpOutboundAgentInput,
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
  // v5 Stream F — control-plane history (peer.summary snapshots)
  PeerSummarySnapshot,
  AppendPeerSummarySnapshotInput,
  PeerSummarySnapshotQuery,
  // v5 Stream F — control-plane alert rules
  PeerSummaryAlertRule,
  PeerSummaryAlertComparator,
  AddPeerSummaryAlertRuleInput,
  UpdatePeerSummaryAlertRuleInput,
  // v5 Stream F day-3 — control-plane alert FIRINGS (breach history)
  PeerSummaryAlertFiring,
  OpenPeerSummaryAlertFiringInput,
  PeerSummaryAlertFiringQuery,
  // v5 Stream F day-3 — control-plane alert notification CHANNELS
  // (multi-channel pass added 'im'/'email' kinds + the im platform union)
  PeerSummaryAlertChannel,
  PeerSummaryAlertChannelKind,
  PeerSummaryAlertImPlatform,
  AddPeerSummaryAlertChannelInput,
  UpdatePeerSummaryAlertChannelInput,
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
  // v5 E4-M1 — agent grants (resource RBAC).
  AgentGrant,
  SetAgentGrantInput,
  // v5 A-M1 — unified resource grants.
  ResourceGrant,
  SetResourceGrantInput,
  ResourceKind,
  GrantPerm,
  // Route B P1-M3b — MFA (TOTP) enrollment.
  TotpState,
  TotpEnrollment,
} from './types.js'
// Route B P1-M3b — MFA (TOTP) store input types.
export type { EnrollTotpInput, VerifyTotpInput } from './totp-store.js'
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
  // v5 A-M1 — unified resource grants.
  RESOURCE_KINDS,
  GRANT_PERMS,
  GRANT_PERM_RANK,
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
// Route B P0-M4a — pluggable master key provider. local-file (default,
// unchanged) / env (injected material, no disk) / kms-stub (reserved seam,
// load() throws). Hosts pass the resolved provider's key to openIdentityStore.
export {
  EnvMasterKeyProvider,
  KmsStubMasterKeyProvider,
  LocalFileMasterKeyProvider,
  resolveMasterKeyProvider,
  type MasterKeyProvider,
  type MasterKeyProviderKind,
  type ResolveMasterKeyProviderInput,
} from './crypto.js'
// Route B P0-M5 — interrupted-rotation recovery probe. Answers "does this key
// unwrap the stored DEK?" so the host can decide between a live key and a
// staged `<keyfile>.next` left behind by a crashed KEK rotation.
export { probeVaultMasterKey, type MasterKeyProbeResult } from './master-key-probe.js'
// Route B P1-M3a — MFA TOTP primitive (RFC 6238 / RFC 4226 / RFC 4648 base32).
// Pure deterministic algorithm layer; storage + login wiring land in later M3x.
export {
  base32Encode,
  base32Decode,
  hotp,
  totpCodeAt,
  verifyTotp,
  generateTotpSecret,
  buildOtpauthUri,
  TOTP_DEFAULT_DIGITS,
  TOTP_DEFAULT_PERIOD_S,
  TOTP_SECRET_BYTES,
  type TotpParams,
  type VerifyTotpParams,
  type GeneratedTotpSecret,
  type OtpauthUriInput,
} from './totp.js'
// Route B P1-M4b — OIDC protocol pure core (PKCE + RS256 id_token validation).
// Pure, deterministic (now/jwks injected); network + config land in M4c/M4d.
export {
  OidcError,
  randomUrlToken,
  randomState,
  randomNonce,
  generatePkce,
  buildAuthorizationUrl,
  validateIdToken,
  type PkcePair,
  type BuildAuthUrlInput,
  type Jwk,
  type Jwks,
  type ValidateIdTokenInput,
  type IdTokenClaims,
} from './oidc.js'
