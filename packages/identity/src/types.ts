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
  /**
   * Existing v3 admin token (the hex string from the first-launch admin
   * URL). When the store is empty:
   *   - present → migrated into a real `admin_token` credential on the
   *     new owner user (so the existing URL keeps working in v4).
   *   - absent  → only the owner user is created, with no credentials;
   *     caller is responsible for issuing some way to log in.
   * When the store already has users, this field is ignored and no
   * mutation happens (the function is idempotent).
   */
  adminToken?: string
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
  /**
   * true when an `adminToken` was provided AND the bootstrap actually
   * ran AND the token was successfully stored. false in every other
   * case (already bootstrapped, no token provided, etc).
   */
  adminTokenMigrated: boolean
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
 */
export type AuditActorSource =
  | 'v3-admin'
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
  /** v4 user id of the inviter. Null when minted by v3-admin (no v4 binding). */
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
  /** v4 user id of the inviter; null for v3-admin callers. */
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
