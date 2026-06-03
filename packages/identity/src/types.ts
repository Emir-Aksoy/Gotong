/**
 * Public domain types for @aipehub/identity.
 *
 * Conventions:
 *   - All timestamps are `Date.now()` epoch-ms integers (number).
 *   - All ids are opaque strings produced by `newId()` (timestamp-
 *     prefixed, sortable, 37 chars). Do not parse them.
 *   - `null` means "absent fact"; `undefined` means "not provided
 *     by caller (use default)".
 */

// Type-only — the unified Principal vocabulary (v5 Stream 0). Type-only import
// keeps this a compile-time edge (no runtime cycle with principal.ts, which
// imports OwnerKind from here, also type-only).
import type { Principal } from './principal.js'

export type Role = 'owner' | 'admin' | 'member' | 'viewer'

/**
 * The full role list in priority order (owner > admin > member > viewer).
 * Re-exported as a runtime constant so the host's permission layer can
 * iterate without hardcoding the strings again.
 */
export const ROLES: readonly Role[] = [
  'owner',
  'admin',
  'member',
  'viewer',
] as const

export type CredentialKind = 'password' | 'admin_token' | 'api_key'

export interface User {
  id: string
  email: string
  displayName: string | null
  createdAt: number
  lastLoginAt: number | null
}

export interface Membership {
  id: string
  userId: string
  role: Role
  createdAt: number
}

export interface Session {
  token: string
  userId: string
  expiresAt: number
  createdAt: number
  lastSeenAt: number
}

export interface Credential {
  id: string
  userId: string
  kind: CredentialKind
  /**
   * Lookup identifier. For passwords this is the user's email
   * (normalised lowercase). For tokens this is the sha256 hex digest
   * of the token itself — UNIQUE(kind, identifier) on the table then
   * lets us look up a token credential in O(1) by hashing the
   * incoming bearer token.
   */
  identifier: string
  /** Human label for token credentials (eg "CI runner"). null for password. */
  label: string | null
  createdAt: number
  lastUsedAt: number | null
}

export interface CreateUserInput {
  email: string
  displayName?: string | null
  /** If provided, also creates a password credential. */
  password?: string
  /** Defaults to 'member'. Use 'owner' only via bootstrap. */
  role?: Role
}

export interface BootstrapInput {
  /** Defaults to 'admin@local'. */
  ownerEmail?: string
  /** Defaults to 'Admin'. */
  ownerDisplayName?: string
}

export interface BootstrapResult {
  /** true on the first bootstrap call (empty db); false otherwise. */
  bootstrapped: boolean
  /** Set only when `bootstrapped` is true. */
  ownerUserId: string | null
}

export interface IssuedApiKey {
  /** Raw key — shown ONCE. Re-derive `identifier` via `hashToken(key)`. */
  key: string
  credentialId: string
}

export interface IssuedAdminToken {
  /** Raw token — shown ONCE. */
  token: string
  credentialId: string
}

// ---------------------------------------------------------------------------
// Audit log (V4-AUDIT-06)
// ---------------------------------------------------------------------------

/**
 * Where the actor came from. `anonymous` is the pre-login attempt
 * (e.g. a `login_failure` row); `system` is used by host-internal
 * jobs (cleanupExpiredSessions, bootstrap) that have no human actor.
 *
 * FED-M4 — `'federated'` covers actions triggered by a task that
 * crossed a peer-hub boundary (i.e. `Task.origin` is set; see
 * `@aipehub/core`'s `TaskOrigin`). The writer is expected to also
 * stash `task.origin` in `metadata.origin` so downstream readers can
 * trace back to the original org+user.
 *
 * A2.2 (v4 Phase 5) — `'v3-admin'` was removed. v4 IdentityStore is the
 * single source of identity truth; the legacy v3 admin path (Space.admins
 * cookie / `/admin?token=...` URL) is still served by the host for
 * host-level admin routes (agents, secrets, workflows) but those paths
 * never touch IdentityStore audit rows. Pre-A2.2 audit rows with
 * `actor_source = 'v3-admin'` fall back to `'system'` via the corruption
 * guard in `rowToAuditLog`.
 */
export type AuditActorSource =
  | 'v4-session'
  | 'v4-bearer'
  | 'anonymous'
  | 'system'
  | 'federated'

export interface AuditLogEntry {
  id: string
  ts: number
  /** null on `login_failure` and `system` actions. */
  actorUserId: string | null
  actorSource: AuditActorSource
  /**
   * Action verb. Free-form string by design — adding a new action
   * type should not require a schema change. Convention:
   * lowercase_snake_case. Known values today:
   *   login_success / login_failure / logout
   *   create_user / set_role / set_password
   *   issue_api_key / issue_admin_token / revoke_credential
   *   revoke_session / cleanup_sessions
   */
  action: string
  targetUserId: string | null
  targetCredentialId: string | null
  ip: string | null
  userAgent: string | null
  /** Parsed back from the on-disk JSON column. Null when nothing was stored. */
  metadata: Record<string, unknown> | null
  success: boolean
}

export interface WriteAuditLogInput {
  action: string
  actorSource: AuditActorSource
  actorUserId?: string | null
  targetUserId?: string | null
  targetCredentialId?: string | null
  ip?: string | null
  userAgent?: string | null
  /**
   * Per-action extras. The store JSON.stringify's it. Keep it small —
   * the column is meant for "the email that was attempted" or "the
   * role transition pair", not for arbitrary blobs.
   */
  metadata?: Record<string, unknown> | null
  /** Defaults to `true`. Pass `false` for explicit failures (login bad-password). */
  success?: boolean
}

export interface ListAuditLogQuery {
  /** Newest-first; defaults to 100. Clamped to [1, 1000]. */
  limit?: number
  /** Pagination offset; defaults to 0. */
  offset?: number
  /** Filter by exact action verb. */
  action?: string
  /**
   * Filter by action-set membership (`action IN (...)`). Phase 19 P2-M3 —
   * lets a caller pull "all workflow lifecycle rows" in one query without
   * five round-trips. Combines with `action` via AND if both are set
   * (callers use one or the other). Empty array is ignored.
   */
  actions?: string[]
  /** Filter by target user id. */
  targetUserId?: string
  /** Filter by success / failure. Unset returns both. */
  success?: boolean
  /** P2-M3 — inclusive lower bound on `ts` (epoch ms). */
  since?: number
  /** P2-M3 — inclusive upper bound on `ts` (epoch ms). */
  until?: number
  /**
   * P2-M3 — equality filter on a single JSON field inside `metadata`,
   * via SQLite `json_extract(metadata, path) = value`. The path is bound
   * as a parameter (never interpolated), so it is injection-safe. Used to
   * scope workflow-audit queries to one `workflowId` without teaching the
   * generic audit store anything workflow-specific.
   */
  metadataEquals?: { path: string; value: string }
}

/**
 * A2 (Phase 5) — recommended action vocabulary. Hosts MAY pass any
 * string to `writeAuditLog.action` (the column is free-form text), but
 * the values below cover every action emitted by aipehub itself. Using
 * the typed constants instead of literals catches typos at compile time
 * and keeps downstream analytics (rollup queries, admin UI filters)
 * stable.
 *
 * Convention: `<surface>_<verb>` snake_case. `<surface>` is the
 * subsystem (auth/api/knowledge/vault/org/peer); `<verb>` is what
 * happened. New subsystems extend this enum; new verbs within an
 * existing subsystem may be added without touching consumers.
 */
export const AUDIT_ACTIONS = {
  // Phase 1-3 — auth / identity / credentials (already used by web layer).
  LOGIN_SUCCESS: 'login_success',
  LOGIN_FAILURE: 'login_failure',
  LOGOUT: 'logout',
  CREATE_USER: 'create_user',
  SET_ROLE: 'set_role',
  SET_PASSWORD: 'set_password',
  ISSUE_API_KEY: 'issue_api_key',
  ISSUE_ADMIN_TOKEN: 'issue_admin_token',
  REVOKE_CREDENTIAL: 'revoke_credential',
  REVOKE_SESSION: 'revoke_session',
  CLEANUP_SESSIONS: 'cleanup_sessions',
  INVITE_CREATE: 'invite_create',
  INVITE_ACCEPT: 'invite_accept',
  INVITE_REVOKE: 'invite_revoke',
  /**
   * Phase 6 #9: createInvitation was blocked by the org-wide hard cap
   * on active-pending invites (`AIPE_MAX_PENDING_INVITES`, default
   * 1000). Logged so operators can see "the cap is firing in production"
   * before they hit it themselves.
   */
  INVITE_CREATE_BLOCKED: 'invite_create_blocked',
  // Phase 5 — setup wizard.
  SETUP_OWNER_CREATED: 'setup_owner_created',
  // Phase 5 — vault (A1).
  VAULT_CREATE: 'vault_create',
  VAULT_READ: 'vault_read',
  VAULT_REVOKE: 'vault_revoke',
  // Phase 5 — API pool (B1+).
  API_CALL: 'api_call',
  API_QUOTA_DENIED: 'api_quota_denied',
  // Phase 5 — knowledge (B3+).
  KNOWLEDGE_INGEST: 'knowledge_ingest',
  KNOWLEDGE_SEARCH: 'knowledge_search',
  KNOWLEDGE_GRANT: 'knowledge_grant',
  KNOWLEDGE_REVOKE: 'knowledge_revoke',
  // Phase 5 — peer registry (D1+).
  PEER_ADD: 'peer_add',
  PEER_REMOVE: 'peer_remove',
  PEER_CONNECT: 'peer_connect',
  PEER_DISCONNECT: 'peer_disconnect',
  // Phase 5 — org-wide settings (C1+).
  ORG_SET_QUOTA: 'org_set_quota',
  // Phase 5 — org soft quotas (E1).
  /** Aggregate org usage crossed the warn_pct threshold (default 80%). */
  ORG_QUOTA_WARN: 'org_quota_warn',
  /** Aggregate org usage crossed 100% — over the soft cap. */
  ORG_QUOTA_OVER: 'org_quota_over',
  /** Aggregate org usage fell back below warn_pct (period roll or manual reset). */
  ORG_QUOTA_RECOVER: 'org_quota_recover',
  // Phase 19 P2-M2 — workflow lifecycle governance. One row per
  // interactive (admin-triggered) governance-significant transition, so
  // operators can answer "who promoted / retired this workflow, and to
  // which revision". Boot adoption (`adoptAtBoot`) bypasses HTTP and is
  // intentionally NOT audited; draft/review authoring churn is omitted too.
  WORKFLOW_IMPORT: 'workflow_import',
  WORKFLOW_PUBLISH: 'workflow_publish',
  WORKFLOW_DEPRECATE: 'workflow_deprecate',
  WORKFLOW_ARCHIVE: 'workflow_archive',
  WORKFLOW_ROLLBACK: 'workflow_rollback',
  // Inbox governance (HITL) — member actions on human-task inbox items, so
  // operators can answer "who decided / handed off this human step, and how".
  // The host's HostInboxService writes one row per member action; the generic
  // audit query/export surfaces them by `?action=inbox_*`. Delegate / claim
  // verbs join here as later inbox-gov milestones land.
  INBOX_RESOLVE: 'inbox_resolve',
  /** inbox-gov M2 — a member handed a pending item off to another user. */
  INBOX_DELEGATE: 'inbox_delegate',
  // v5 A-M4 — resource access grants (generic resource_grants mutations via the
  // member/admin authorization surface). One row per grant set / revoke so
  // operators can answer "who shared resource X with which principal, at what
  // level". metadata carries { resourceKind, resourceId, principal, perm }.
  RESOURCE_GRANT_SET: 'resource_grant_set',
  RESOURCE_GRANT_REVOKE: 'resource_grant_revoke',
  // v6 Route B P1-M1 — a principal was DENIED an action on a resource because
  // they hold a LOWER grant than the action requires (e.g. a viewer tried to
  // edit an agent). Recorded so operators can see over-privilege attempts. A
  // bare "no grant at all" is NOT audited — that path returns 404 and is
  // indistinguishable from "resource doesn't exist", so logging it would just
  // record every blind probe. metadata carries { resourceKind, resourceId,
  // required }.
  RESOURCE_ACCESS_DENIED: 'resource_access_denied',
  // v5 B-M3 — a template was exported WITH sensitive material (literal MCP
  // secrets and/or personnel/ownership info), the gated opt-in path. A plain
  // structure export is the safe default and is intentionally NOT audited.
  // metadata carries { name, agentIds, workflowIds, includeSecrets, includePersonnel }.
  TEMPLATE_EXPORT: 'template_export',
} as const

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]

// ---------------------------------------------------------------------------
// Invitations (Phase 3 — user invitation flow)
// ---------------------------------------------------------------------------

/**
 * Lifecycle of an invitation row.
 *
 *   pending  → freshly minted, token still valid.
 *   accepted → consumer redeemed it (one-shot, terminal).
 *   revoked  → owner cancelled before redemption (terminal).
 *   expired  → COMPUTED at read time when `expiresAt < now`. Never
 *              persisted as a column value — keeps the store free of
 *              sweeper jobs that mutate rows just to flip a flag.
 */
export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired'

export interface Invitation {
  id: string
  email: string
  role: Role
  /** v4 user id of the inviter. Null when minted by the system (no human actor). */
  invitedBy: string | null
  /** Pre-filled display name suggestion shown on the /invite landing page. */
  displayName: string | null
  expiresAt: number
  /**
   * Effective status. The store overlays `'expired'` on top of the
   * persisted column when `expiresAt < now` AND the row is still
   * `'pending'`. `accepted` / `revoked` rows keep their terminal status
   * regardless of expiry.
   */
  status: InvitationStatus
  createdAt: number
  acceptedAt: number | null
  /** Set only when `status === 'accepted'`. */
  acceptedUserId: string | null
}

export interface CreateInvitationInput {
  email: string
  /** Defaults to 'member'. Cannot mint 'owner' invites — promote post-accept. */
  role?: Role
  /** Pre-filled name on the landing page; user can override at accept time. */
  displayName?: string
  /** v4 user id of the inviter; null for system-initiated invites. */
  invitedBy?: string | null
  /** Time-to-live in ms. Defaults to 24h, clamped to [60_000, 30 days]. */
  ttlMs?: number
}

export interface IssuedInvitation {
  /** Raw token — shown ONCE to the inviter. Delivered out-of-band. */
  token: string
  invitation: Invitation
}

export interface AcceptInvitationInput {
  /** Raw `inv_*` token from the landing URL. */
  token: string
  /** New user's password. Subject to MAX_PASSWORD_LENGTH + scrypt rules. */
  password: string
  /** Override the suggested displayName from the invite row. */
  displayName?: string
  /** Defaults to 7d (mirrors normal login). */
  sessionTtlMs?: number
}

export interface ListInvitationsQuery {
  /** Filter by effective status. `'expired'` matches pending rows past TTL. */
  status?: InvitationStatus
  /** Exact-match (case-insensitive via COLLATE NOCASE). */
  email?: string
  /** Newest-first; defaults to 100. Clamped to [1, 500]. */
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// Vault (Phase 5 A1 — encrypted application-layer secret storage)
//
// Different from `Credential` (which holds auth material hashed for
// VERIFY-only): vault rows are AES-256-GCM encrypted with the host
// master key and can be decrypted to original plaintext via
// `readVaultSecret(id)`. Use cases: LLM provider keys, MCP server
// tokens, peer-hub mutual-auth tokens, third-party API keys —
// anything the host needs to RELAY rather than just verify.
// ---------------------------------------------------------------------------

/**
 * Categories of secret stored in the vault. New kinds are added as
 * higher-level subsystems land (`peer_token` lands with D1 Peer
 * Registry; `mcp_server` lands when host wires per-org MCP tool keys).
 */
export type VaultKind =
  | 'llm_provider'
  | 'mcp_server'
  | 'peer_token'
  | 'third_party_api'

export const VAULT_KINDS: readonly VaultKind[] = [
  'llm_provider',
  'mcp_server',
  'peer_token',
  'third_party_api',
] as const

/**
 * Unified ownership taxonomy. Used by vault here (A1) and aligned in A3
 * with `@aipehub/services-sdk`'s `OwnerKind` — the string values
 * ('user' | 'org' | 'peer') are an EXACT subset of the SDK's wider enum
 * (also including 'agent' | 'workflow-run' | 'shared'). This lets a
 * `(kind, id)` tuple round-trip between a vault row and a service
 * attach call without translation.
 *
 *   user  — bound to a specific v4 user id (personal scope)
 *   org   — owned by the host itself (organisation-wide scope; ownerId
 *           is null in the vault row because the host IS the implicit
 *           org. The SDK uses the sentinel id `ORG_SELF_ID` ('self')
 *           when it needs a path-safe string)
 *   peer  — owned by a remote peer hub (federation scope; ownerId is
 *           the peer's hub id)
 *
 * The SDK's 'agent' / 'workflow-run' / 'shared' kinds are intentionally
 * NOT mirrored here — vault rows are managed at the principal level
 * (who controls / pays for the secret), not the runtime level (which
 * agent happens to read it for a given task).
 */
export type OwnerKind = 'user' | 'org' | 'peer'

export const OWNER_KINDS: readonly OwnerKind[] = ['user', 'org', 'peer'] as const

/**
 * Vault row metadata. Deliberately omits the encrypted blob — listing
 * vault entries should never expose secret material. Callers obtain the
 * plaintext via `readVaultSecret(id)` (which checks revocation +
 * touches `last_used_at`).
 */
export interface VaultEntry {
  id: string
  kind: VaultKind
  ownerKind: OwnerKind
  /** null when ownerKind === 'org' (the host's own org is implicit). */
  ownerId: string | null
  label: string | null
  /** Free-form context (provider, model, region…). null when absent. */
  metadata: Record<string, unknown> | null
  createdAt: number
  lastUsedAt: number | null
  /** Soft-delete timestamp. null === active. */
  revokedAt: number | null
}

export interface CreateVaultEntryInput {
  kind: VaultKind
  ownerKind: OwnerKind
  /**
   * Required for ownerKind 'user' | 'peer'. MUST be null/omitted for
   * ownerKind 'org' (the host is the implicit org owner — passing an
   * id here is rejected to avoid silent misclassification).
   */
  ownerId?: string | null
  /**
   * Plaintext secret. Encrypted before persisting; never logged. The
   * caller is responsible for shape-validating provider-specific
   * formats (e.g. that an Anthropic key starts with `sk-ant-`).
   */
  secret: string
  label?: string | null
  /**
   * Per-kind context (provider/model/region). Plain object,
   * JSON-stringified to ≤8KB. Useful for the admin UI to render
   * "Anthropic · opus-4" without re-parsing the secret.
   */
  metadata?: Record<string, unknown> | null
}

export interface ListVaultEntriesQuery {
  kind?: VaultKind
  ownerKind?: OwnerKind
  /** Match a specific owner id. Use `null` to query org-owned rows. */
  ownerId?: string | null
  /** Defaults true. Set false to include revoked rows (admin/audit views). */
  activeOnly?: boolean
  /** Newest-first; defaults to 100. Clamped to [1, 500]. */
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// B2.1 — usage counters (per-user quota tracking).
//
// Lightweight mutable counters keyed by (userId, metric, period). Each
// row holds the cumulative `used` value for the CURRENT period only;
// when the period boundary passes, the next `checkAndIncrement` rolls
// `used` back to 0 and advances `periodStart`. Older period values are
// not retained here — usage history that needs audit trail goes
// through `writeAuditLog` instead.
//
// Why a separate table instead of derived-from-audit-log:
//   - O(1) hot path: a single primary-key lookup + UPDATE per LLM call
//     beats SUM-ing a growing audit table forever.
//   - Quota is policy data (admin-controllable), separate from event
//     data (immutable audit). Mixing them muddies both surfaces.
//
// Why mutable rows instead of an append-only counter log:
//   - The audit log already records per-call events with full actor /
//     timestamp / metadata context. Duplicating that here would just
//     bloat the file.
//
// Period semantics (UTC-aligned):
//   - 'hourly'  — boundary = floor(now / 3_600_000) * 3_600_000
//   - 'daily'   — boundary = floor(now / 86_400_000) * 86_400_000
//                  (UTC midnight; consumer in GMT+8 sees reset at 08:00
//                  local — predictable trumps locally-intuitive here)
//   - 'monthly' — boundary = first day 00:00 UTC of `now`'s month
//   - 'total'   — periodStart=0, never rolls (lifetime counter)
//
// All times are ms since epoch. Test code should pass `now` explicitly
// to `checkAndIncrement` / `resetUsage` to avoid wall-clock flakiness.
// ---------------------------------------------------------------------------

export type UsagePeriod = 'hourly' | 'daily' | 'monthly' | 'total'

export const USAGE_PERIODS: readonly UsagePeriod[] = [
  'hourly',
  'daily',
  'monthly',
  'total',
] as const

/** Max length of the free-form `metric` string. Anything longer is rejected. */
export const USAGE_METRIC_MAX_LEN = 64

/**
 * One counter row. `metric` is free-form so subsystems can name their
 * own counters without a schema migration. Recommended values:
 *   - 'llm_requests', 'llm_tokens_in', 'llm_tokens_out'    (B1 / B2)
 *   - 'mcp_calls'                                          (B3 / B4 —
 *     covers RAG too, since the v4 Phase 5 decision was to do RAG via
 *     MCP rather than build a knowledge subsystem; see
 *     docs/zh/RAG-VIA-MCP.md)
 *   - 'knowledge_ingest_bytes', 'knowledge_query'          (reserved —
 *     future per-RAG-server self-reported telemetry. MCP spec has no
 *     telemetry channel today, so nothing debits these yet.)
 */
export interface UsageCounter {
  userId: string
  metric: string
  period: UsagePeriod
  /** UTC-aligned ms timestamp; 0 for `period='total'`. */
  periodStart: number
  used: number
  /** `null` = unlimited (counter still ticks for visibility). */
  quota: number | null
  updatedAt: number
}

export interface SetQuotaInput {
  userId: string
  metric: string
  period: UsagePeriod
  /** `null` removes the cap; ≥0 integer otherwise. */
  quota: number | null
}

export interface GetUsageQuery {
  userId: string
  /** Omit to fetch every metric for the user. */
  metric?: string
  /** Omit to fetch every period for the (user, metric). */
  period?: UsagePeriod
}

export interface CheckAndIncrementInput {
  userId: string
  metric: string
  period: UsagePeriod
  /**
   * How much to add. Defaults to 1. Must be a non-negative integer.
   * `amount=0` is a "peek with roll" — useful for fetching the
   * post-roll counter without committing usage.
   */
  amount?: number
  /** Override `Date.now()` — required for deterministic testing. */
  now?: number
}

export interface CheckAndIncrementResult {
  /** True when the increment was committed. False when quota would be exceeded. */
  allowed: boolean
  /** Counter state AFTER the (possibly skipped) increment. */
  counter: UsageCounter
  /** When `allowed=false`: by how many units the call exceeded the cap. */
  exceededBy?: number
}

export interface ResetUsageInput {
  userId: string
  metric: string
  period: UsagePeriod
  /** Override `Date.now()` for deterministic period-start computation. */
  now?: number
}

/**
 * Result of {@link IdentityStore.sweepUsageCounters}. The sweep is a
 * background hygiene pass — `checkAndIncrement` already auto-rolls
 * on call, so the sweep only matters for `listUsage` freshness on
 * counters nobody touched this period (e.g. an admin opens the usage
 * dashboard at 09:00 for a user who last consumed their quota
 * yesterday — without the sweep, `used` would still show yesterday's
 * value with the prior `periodStart`).
 *
 * `'total'` rows never roll (lifetime counters); they're not counted
 * here.
 */
export interface SweepUsageResult {
  /** Total rows whose period boundary was rolled forward. */
  rolled: number
  /** Per-period breakdown — useful for admin diagnostics and tests. */
  byPeriod: {
    hourly: number
    daily: number
    monthly: number
  }
}

// ---------------------------------------------------------------------------
// Phase 17 (Sprint 4) — Usage / cost ledger
//
// The ledger is the raw line-item layer UNDER usage_counters: one row per
// LLM provider call, recording the full token breakdown + an attributed,
// pre-computed cost. `usage_counters` answers the hot-path quota question
// ("is this user over their cap"); the ledger answers the forensic /
// billing question ("show me exactly what was spent, by whom, on what").
// Cost is computed by the host (which owns the model price table) and
// handed in already-resolved — identity stays model-agnostic.
// ---------------------------------------------------------------------------

/**
 * One persisted ledger row. Nullable attribution fields (`orgId`,
 * `userId`, `workflowId`, `taskId`, `provider`) are `null` for
 * unattributed local dispatches — tokens are still recorded for cost
 * visibility, they're just not billed to anyone. `agentId` + `model`
 * are always present on a real LLM call.
 */
export interface LedgerEntry {
  /** Monotonic rowid (autoincrement). Stable export/pagination cursor. */
  id: number
  /** ms since epoch of the provider call. */
  ts: number
  orgId: string | null
  userId: string | null
  /**
   * Phase 19 P4-M2 — the LOCAL peer-registry row id this LLM call came in
   * through when the task federated from another hub; `null` for local usage.
   * Distinct from `orgId` (the wire-CLAIMED origin org): `peerId` is the
   * trustworthy local handle, so `WHERE peer_id IS NOT NULL` isolates
   * cross-org usage and by-peer roll-ups bill the right link.
   */
  peerId: string | null
  agentId: string
  workflowId: string | null
  taskId: string | null
  model: string
  provider: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  /** Integer micro-USD (1e-6 USD). Never a float. */
  costMicros: number
  /** True when the model had no price entry — tokens real, cost is 0. */
  unpriced: boolean
  /** Small escape hatch (stopReason / toolRounds / …). `null` if absent. */
  meta: Record<string, unknown> | null
}

/**
 * Append shape. `ts` defaults to `Date.now()`. Cost is supplied
 * pre-computed by the caller (the host pricing layer). Optional
 * attribution / cache / meta fields default to null / 0 / false.
 */
export interface LedgerAppendInput {
  ts?: number
  orgId?: string | null
  userId?: string | null
  /** Phase 19 P4-M2 — local peer-registry row id for federated usage; null for local. */
  peerId?: string | null
  agentId: string
  workflowId?: string | null
  taskId?: string | null
  model: string
  provider?: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
  costMicros: number
  unpriced?: boolean
  meta?: Record<string, unknown> | null
}

/**
 * Row-level query. Every filter is optional and ANDed. `since` is
 * inclusive, `until` exclusive (half-open `[since, until)` window, the
 * standard for time-bucket reporting). Results are newest-first
 * (`id DESC`). `limit` defaults to 100, clamped to {@link LEDGER_QUERY_MAX_LIMIT};
 * `offset` for pagination.
 */
export interface LedgerQuery {
  orgId?: string
  userId?: string
  /** Phase 19 P4-M2 — filter to one federated peer's usage. */
  peerId?: string
  agentId?: string
  workflowId?: string
  model?: string
  since?: number
  until?: number
  limit?: number
  offset?: number
}

/** The axis a ledger aggregate rolls up by. */
export type LedgerGroupBy = 'user' | 'agent' | 'workflow' | 'model' | 'day' | 'peer'

export const LEDGER_GROUP_BY: readonly LedgerGroupBy[] = [
  'user',
  'agent',
  'workflow',
  'model',
  'day',
  'peer',
] as const

/** Default / max row count for {@link LedgerQuery}. */
export const LEDGER_QUERY_DEFAULT_LIMIT = 100
export const LEDGER_QUERY_MAX_LIMIT = 10_000

/**
 * Aggregate query — GROUP BY one axis, SUM tokens + cost, COUNT calls.
 * Same half-open `[since, until)` window + optional org / user scoping
 * as {@link LedgerQuery}.
 */
export interface LedgerAggregateQuery {
  groupBy: LedgerGroupBy
  since?: number
  until?: number
  orgId?: string
  userId?: string
  /** Phase 19 P4-M2 — scope the roll-up to one federated peer. */
  peerId?: string
}

/**
 * One aggregate bucket. `key` is the grouped value: a userId / agentId /
 * workflowId / model string, or a `'YYYY-MM-DD'` UTC day for
 * `groupBy='day'`. NULL group values (e.g. unattributed userId) collapse
 * to the literal `'(none)'` so the bucket is still visible.
 */
export interface LedgerAggregateRow {
  key: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costMicros: number
}

// ---------------------------------------------------------------------------
// D1 (v4 Phase 5) — Peer Registry
// ---------------------------------------------------------------------------

/**
 * What's on the far end of a federation link (Phase 18 B-M1). An admin
 * label, persisted verbatim; the admin UI uses it to frame trust and it
 * leaves room for kind-specific defaults later. `'service'` is the
 * conservative default a pre-policy (un-migrated) peer row carries.
 */
export type PeerKind = 'personal' | 'organization' | 'project' | 'service'

/**
 * Inbound trust contract — what this host ACCEPTS from a peer (Phase 18
 * B-M1). A structural mirror of core's `PeerLinkAcl` so identity stays
 * core-free; the host maps it straight onto `installPeerLink({acl})`.
 * All fields undefined (or a NULL `acl_json` row) = accept-all, the
 * legacy behaviour. Empty `capabilities` = deny all.
 */
export interface PeerInboundAcl {
  /** Capability allowlist; undefined = no check, [] = deny all. */
  capabilities?: string[]
  /** Refuse tasks without an `origin` claim. */
  requireOrigin?: boolean
  /** Restrict to these `origin.userRole` values; undefined/[] = no check. */
  requireOriginRole?: string[]
}

/**
 * One row in the `peers` table. The shared HELLO secret is NOT in this
 * shape — it lives in vault.id = `vaultEntryId`, decrypted on demand
 * via `getPeerToken()`. `enabled=false` keeps the row + token around
 * (one-click re-enable) but tells the host's PeerRegistry to drop the
 * HubLink on the next tick.
 */
export interface PeerRegistration {
  /** Internal row id (newId()). */
  id: string
  /** The remote hub's wire selfId; UNIQUE in the table. */
  peerId: string
  /** ws:// or wss:// URL the host will dial. */
  endpointUrl: string
  /** Human-readable label for admin UI; nullable. */
  label: string | null
  /** Active in the PeerRegistry reconciliation loop. */
  enabled: boolean
  /** Soft FK into `vault.id` (kind='peer_token', ownerKind='peer'). */
  vaultEntryId: string
  createdAt: number
  updatedAt: number
  // ---- Phase 18 B-M1 — cross-org policy (always present; defaults for
  //      a pre-policy row come from the v12 column DEFAULTs / NULL). ----
  /** What's on the far end. Default 'service'. */
  kind: PeerKind
  /** Inbound ACL — what we ACCEPT from this peer. null = accept all. */
  acl: PeerInboundAcl | null
  /** Outbound capability allowlist — what we may SEND. null = send all. */
  outboundCaps: string[] | null
  /** Gate outbound cross-org tasks through the member inbox for approval. */
  requireApprovalOutbound: boolean
  // ---- Phase 19 P4-M4 — per-link trust contract (always present; a
  //      pre-P4 row reads the v15 column DEFAULTs / NULL). ----
  /** One-way auditable kill switch. 'revoked' fully disconnects the peer. */
  revocationState: PeerRevocationState
  /** Max inbound tasks per budget period; null = unlimited. */
  perLinkQuotaBudget: number | null
  /** Outbound data-class allowlist; null = all classes allowed. */
  allowedDataClasses: string[] | null
  // ---- v5 C-M1 — callable-knowledge-base allowlist (always present; a
  //      pre-C row reads the v17 column NULL). ----
  /**
   * Which shared MCP servers (knowledge bases) this peer may discover + call,
   * by server name (for a B-M5 KB template, the KB slot name). null = every
   * shared server is callable (legacy); [] = locked out of all of them.
   */
  allowedKnowledgeBases: string[] | null
  /**
   * Audit L13 — corruption trail. Present (and non-empty) ONLY when one or
   * more stored policy JSON columns were unparseable or the wrong shape and
   * had to be normalised on read (e.g. `outbound_caps_json` held `"chat"`
   * instead of `["chat"]`). Lists the projected field names that were
   * salvaged (e.g. `['outboundCaps', 'acl.capabilities']`). Omitted entirely
   * on a healthy row, so the record shape is unchanged for the common case —
   * the same observable-flag pattern `SuspendedTask.corrupt` uses, giving a
   * read-side trail without a logger (identity has none). A NULL column is
   * NOT corruption (it's the legacy/accept-all default) and never flags.
   */
  policyCorrupt?: string[]
}

/** Phase 19 P4-M4 — a peer link's revocation status. */
export type PeerRevocationState = 'active' | 'revoked'

export interface AddPeerInput {
  /** Remote hub's wire selfId. Must be unique. */
  peerId: string
  /** ws:// or wss:// dial URL. */
  endpointUrl: string
  /** Optional human label. */
  label?: string | null
  /**
   * The shared HELLO secret. Stored encrypted via createVaultEntry;
   * never returned in any subsequent read. To rotate, call updatePeer
   * with a fresh `peerToken`.
   */
  peerToken: string
  // ---- Phase 18 B-M1 — optional cross-org policy (omitted → column
  //      DEFAULTs: kind='service', no ACL, no allowlist, approval off). ----
  kind?: PeerKind
  acl?: PeerInboundAcl | null
  outboundCaps?: string[] | null
  requireApprovalOutbound?: boolean
  // ---- Phase 19 P4-M4 — per-link trust contract (omitted → defaults:
  //      active, no quota, all data classes). ----
  revocationState?: PeerRevocationState
  perLinkQuotaBudget?: number | null
  allowedDataClasses?: string[] | null
  // ---- v5 C-M1 — callable-KB allowlist (omitted → NULL = every shared KB). ----
  allowedKnowledgeBases?: string[] | null
}

export interface UpdatePeerInput {
  label?: string | null
  enabled?: boolean
  /** Rotates: old vault entry revoked, fresh one created in same txn. */
  peerToken?: string
  /**
   * Allow moving a peer to a new endpoint (load-balancer change, DNS
   * cutover) without losing the token. peerId is intentionally NOT
   * mutable — that's a different peer, use addPeer/removePeer.
   */
  endpointUrl?: string
  // ---- Phase 18 B-M1 — cross-org policy. undefined = preserve existing.
  //      For acl / outboundCaps, an explicit `null` CLEARS the policy
  //      (back to accept-all / send-all), distinct from undefined. ----
  kind?: PeerKind
  acl?: PeerInboundAcl | null
  outboundCaps?: string[] | null
  requireApprovalOutbound?: boolean
  // ---- Phase 19 P4-M4 — per-link trust contract. undefined = preserve;
  //      an explicit null on perLinkQuotaBudget / allowedDataClasses CLEARS
  //      it (back to unlimited / all-allowed). revocationState has no null. ----
  revocationState?: PeerRevocationState
  perLinkQuotaBudget?: number | null
  allowedDataClasses?: string[] | null
  // ---- v5 C-M1 — callable-KB allowlist. undefined = preserve; explicit null
  //      CLEARS it (back to every-shared-KB-callable). ----
  allowedKnowledgeBases?: string[] | null
}

export interface ListPeersQuery {
  /** When true, omit rows with enabled=0. */
  enabledOnly?: boolean
}

// ---------------------------------------------------------------------------
// E1 (v4 Phase 5) — per-org soft quotas
//
// Aggregate caps across ALL users of the host, evaluated on a 1h sweep
// tick by the host process. Soft because we never refuse a call here —
// the per-user `checkAndIncrement` is the only hard gate. This layer
// only emits audit warnings when aggregate usage crosses configurable
// thresholds (default warn at 80%, over at 100%).
//
// Why "soft":
//   - Refusing a single user's call because the ORG as a whole is over
//     budget would be opaque and surprising ("why did MY request fail?
//     I'm at 10/100"). Operators want a warning to act on (raise the
//     cap, throttle the noisy user, etc), not an outage.
//   - For hard org-level enforcement, an operator can sum per-user
//     quotas to match — `sum(users) <= org_quota` makes the org cap
//     mathematically unreachable via per-user `checkAndIncrement`
//     denials alone.
// ---------------------------------------------------------------------------

/**
 * State of an org quota relative to current aggregate usage.
 *
 *   ok    — usage < warn_pct% of quota
 *   warn  — warn_pct% ≤ usage < 100%
 *   over  — usage ≥ 100% of quota (soft cap exceeded)
 */
export type OrgQuotaState = 'ok' | 'warn' | 'over'

export const ORG_QUOTA_STATES: readonly OrgQuotaState[] = ['ok', 'warn', 'over'] as const

/**
 * One configured org-level cap. `warnPct` is the threshold (0-100) at
 * which the state transitions ok→warn; 100% transitions warn→over.
 * `lastState` is the snapshot from the most recent
 * {@link IdentityStore.checkOrgQuotaThreshold} call — used to make the
 * audit-emit logic idempotent (only audit on state CHANGE).
 */
export interface OrgQuota {
  metric: string
  period: UsagePeriod
  /** Soft cap (non-negative integer; no NULL — delete the row to remove). */
  quota: number
  /** 1-99. Default 80. */
  warnPct: number
  lastState: OrgQuotaState
  /** ms timestamp of most recent checkOrgQuotaThreshold; null if never. */
  lastChecked: number | null
  createdAt: number
  updatedAt: number
}

export interface SetOrgQuotaInput {
  metric: string
  period: UsagePeriod
  /** Non-negative integer. To remove, call {@link IdentityStore.deleteOrgQuota}. */
  quota: number
  /** 1-99. Defaults to 80 on create; existing rows keep their current value when omitted. */
  warnPct?: number
}

/**
 * Result of {@link IdentityStore.checkOrgQuotaThreshold}. `transitioned`
 * is the bit the host's orgQuotaSweep keys on — write audit_log only on
 * true. `pct` is the integer percent for human-readable audit metadata.
 */
export interface CheckOrgQuotaResult {
  metric: string
  period: UsagePeriod
  quota: number
  warnPct: number
  /** Aggregate sum of `usage_counters.used` for (metric, period) in current period. */
  usage: number
  /** Math.floor((usage / quota) * 100); clamped to [0, 999] for readability. */
  pct: number
  state: OrgQuotaState
  /** Previous lastState value before this check overwrote it. */
  previousState: OrgQuotaState
  /** state !== previousState — host sweep gates audit emission on this. */
  transitioned: boolean
}

// ===========================================================================
// Phase 11 M2 — Suspended tasks (long-running agent resume).
// ===========================================================================

/**
 * One persisted record of "this task was parked at this time; resume
 * the same task with the same agent after `resumeAt`."
 *
 * `state` is opaque to the framework — JSON.stringify-able and given
 * back to the participant verbatim on resume. `taskJson` carries the
 * full task envelope (payload, strategy, ancestry, etc.) so the resume
 * sweep can hand a faithful `Task` object back to the scheduler
 * without re-fetching from a transcript.
 *
 * `hubId` is reserved for future multi-hub-per-process deployments
 * (currently one hub per host); rows have a single nullable string.
 */
export interface SuspendedTask {
  taskId: string
  agentId: string
  /** Optional hub label; useful when several hubs share an identity store. */
  hubId: string | null
  /** Forwarded `task.origin?.userId` so admin UIs can show "who started it." */
  originUserId: string | null
  /** Unix epoch ms. The sweep selects rows where `resumeAt <= now`. */
  resumeAt: number
  /**
   * Agent-supplied state, opaque to the framework. Stored as JSON; the
   * `null` sentinel means "no state — agent will rebuild from working
   * memory / other side channels."
   */
  state: unknown
  /**
   * Set to `true` only when the persisted `state` blob failed to
   * JSON.parse (e.g. a truncated/corrupt write). `state` is then forced
   * to `null`. The resume sweep treats a corrupt row as unrecoverable
   * and drops it rather than re-entering the agent into a broken
   * half-state. Absent on healthy rows so the record shape is unchanged.
   */
  corrupt?: boolean
  /** Stringified `Task` (JSON.stringify). Resume sweep re-hydrates this. */
  taskJson: string
  createdAt: number
}

export interface PersistSuspendedTaskInput {
  taskId: string
  agentId: string
  hubId?: string | null
  originUserId?: string | null
  resumeAt: number
  state: unknown
  taskJson: string
}

export interface ListDueSuspendedTasksQuery {
  /** Defaults to `Date.now()`. */
  now?: number
  /** Cap on returned rows; defaults to 100. Useful for sweep batching. */
  limit?: number
}

// ===========================================================================
// Phase 12 M1 — IM bindings (Telegram / Matrix / Lark / Discord / Slack / QQ).
//
// IM bridges (separate `@aipehub/im-*` packages) need to map "this
// Telegram user" to "that AipeHub user" so dispatches carry a proper
// `Task.origin.userId`. The binding flow is:
//
//   1. User logs into admin UI → clicks "Bind IM" → calls
//      `issueImBindingCode(userId)`. The store mints a 6-digit numeric
//      code with a 10-min TTL and returns it. UI shows it.
//   2. User opens the IM client and DMs the bot `/bind 123456`. The
//      bridge calls `claimImBindingCode({ code, platform, platformUserId })`.
//      Store verifies + deletes the code row + INSERT OR REPLACE into
//      `im_bindings`. Returns the resolved AipeHub user id.
//   3. Subsequent IM messages from that user: bridge calls
//      `getUserIdByImBinding(platform, platformUserId)` to populate
//      `task.origin.userId`.
//
// Re-bind semantics:
//   - Same (platform, platformUserId) re-claiming a fresh code = move
//     the binding to a (possibly different) AipeHub user. Allowed; no
//     unbind required. `INSERT OR REPLACE` does the right thing.
//   - One AipeHub user can have many bindings across platforms (and
//     even multiple bindings on the SAME platform if a user happens to
//     have multiple IM accounts). The unique index is on (platform,
//     platformUserId), not on user_id.
// ===========================================================================

/**
 * One confirmed IM-to-AipeHub binding. PK is `(platform,
 * platformUserId)`.
 */
export interface ImBinding {
  platform: string
  platformUserId: string
  userId: string
  /** Best-effort cached display name from the IM client. May be stale. */
  displayName: string | null
  createdAt: number
}

/**
 * A short-lived numeric code that's been issued to a logged-in user
 * in the admin UI. The user types it into the IM client (`/bind
 * 123456`); the IM bridge calls {@link IdentityStore.claimImBindingCode}
 * to verify + consume.
 *
 * Codes are single-shot: claim deletes the row. One user can have at
 * most one outstanding code at a time — re-issue rotates (deletes the
 * prior row first) so a leaked old code is dead the moment a new one
 * is minted.
 */
export interface ImBindingCode {
  /**
   * Opaque. Default mint format is 6-digit zero-padded numeric (easy
   * to type into mobile IM clients; ~1M space + 5x collision retry
   * makes per-user dupes effectively zero). Tests / deep-link flows
   * may inject explicit codes via `IssueImBindingCodeInput.code`.
   */
  code: string
  userId: string
  /** Unix ms; codes are rejected on `claim` if `expiresAt < now`. */
  expiresAt: number
  createdAt: number
}

export interface IssueImBindingCodeInput {
  userId: string
  /**
   * TTL in ms. Defaults to 10 minutes; clamped to [60_000, 3_600_000]
   * (1 min .. 1 h). Lower bound prevents zero-TTL footguns; upper
   * bound forces re-issuing rather than letting a code sit forever
   * in some unread DM.
   */
  ttlMs?: number
  /**
   * Optional explicit code (must be 4-32 chars of [A-Za-z0-9]). When
   * omitted, the store mints a 6-digit zero-padded numeric. Provided
   * for test determinism and future deep-link flows.
   */
  code?: string
}

export interface ClaimImBindingCodeInput {
  code: string
  platform: string
  platformUserId: string
  /** Best-effort display name from the IM client; nullable. */
  displayName?: string | null
}

export interface ClaimImBindingResult {
  userId: string
  binding: ImBinding
}

export interface ListImBindingsQuery {
  /** Filter by platform; omit for "all platforms". */
  platform?: string
}

// ---------------------------------------------------------------------------
// Workflow grants (Phase 19 P2-M5 — resource-level RBAC, ownership MVP)
//
// One grant row per (workflowId, userId). The OWNER is just the grant with
// perm='owner' — ownership and sharing use the one model. Perms form a ladder
// owner > editor > viewer compared by {@link WORKFLOW_PERM_RANK}.
// ---------------------------------------------------------------------------

/** Workflow permission levels, lowest → highest. */
export const WORKFLOW_PERMS = ['viewer', 'editor', 'owner'] as const
export type WorkflowPerm = (typeof WORKFLOW_PERMS)[number]

/**
 * Rank for hierarchy checks — a grant satisfies a required perm iff its rank
 * is ≥ the requirement's. owner(3) ⊇ editor(2) ⊇ viewer(1).
 */
export const WORKFLOW_PERM_RANK: Record<WorkflowPerm, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
}

export interface WorkflowGrant {
  workflowId: string
  userId: string
  perm: WorkflowPerm
  /** user_id that wrote the grant; null = system (e.g. the import owner seed). */
  grantedBy: string | null
  grantedAt: number
}

export interface SetWorkflowGrantInput {
  workflowId: string
  userId: string
  perm: WorkflowPerm
  grantedBy?: string | null
  /** Defaults to Date.now(). */
  grantedAt?: number
}

// ---------------------------------------------------------------------------
// Resource grants (v5 Stream A-M1 — the unified RBAC table, decision #3)
//
// Generalizes workflow_grants from "user → workflow" to "principal → any
// resource". One row per (resourceKind, resourceId, principal); the OWNER is
// the perm='owner' row, same owner-as-grant model. The principal is the
// unified {@link Principal} (hub / user / agent / peer), stored as its
// {@link principalKey}. workflow_grants folded into this in migration v16; the
// workflow-specific IdentityStore methods are now a thin facade over it.
// ---------------------------------------------------------------------------

/** Kinds of resource a grant can target. Grows as resources gain ownership. */
export const RESOURCE_KINDS = ['workflow', 'agent', 'credential'] as const
export type ResourceKind = (typeof RESOURCE_KINDS)[number]

/**
 * Generic resource-grant permission ladder — the SAME three levels as
 * {@link WORKFLOW_PERMS}, named generically now that grants span resources.
 * `WorkflowPerm` remains an alias; this is its second consumer (A-M1).
 */
export const GRANT_PERMS = WORKFLOW_PERMS
export type GrantPerm = WorkflowPerm
export const GRANT_PERM_RANK = WORKFLOW_PERM_RANK

export interface ResourceGrant {
  resourceKind: ResourceKind
  resourceId: string
  principal: Principal
  perm: GrantPerm
  /** Who wrote the grant — a principalKey or legacy userId; null = system. */
  grantedBy: string | null
  grantedAt: number
}

export interface SetResourceGrantInput {
  resourceKind: ResourceKind
  resourceId: string
  principal: Principal
  perm: GrantPerm
  grantedBy?: string | null
  /** Defaults to Date.now(). */
  grantedAt?: number
}
