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
  /** Filter by target user id. */
  targetUserId?: string
  /** Filter by success / failure. Unset returns both. */
  success?: boolean
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
 *   - 'mcp_calls'                                          (future)
 *   - 'knowledge_ingest_bytes', 'knowledge_query'          (B3 / B4)
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
