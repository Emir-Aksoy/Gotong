/**
 * IdentityStore — the single public surface of @aipehub/identity.
 *
 * One process opens one store, pointing at one `.sqlite` file. Methods
 * are synchronous (better-sqlite3 is sync); we expose them sync so the
 * host's request middleware can call into them without an await hop
 * on every web request.
 *
 * # Security notes (the things that *would* be bugs if you removed them)
 *
 * 1. `authenticatePassword` always runs a scrypt verify, even when the
 *    email isn't found. Without this, the response time leaks "user
 *    exists" vs "user doesn't exist" by ~50-100ms. The dummy hash is
 *    computed at module load (one-time cost).
 *
 * 2. Token authentication looks up by `sha256(token)` — we never store
 *    raw tokens. A db dump hands the attacker `sha256` digests of
 *    192-bit randoms, which is computationally infeasible to invert.
 *
 * 3. `getSessionByToken` checks `expires_at` server-side; we never
 *    trust the client to send valid expiry. Expired sessions return
 *    `null` (caller maps to 401).
 *
 * 4. Bootstrap is idempotent: if any user already exists, the call
 *    short-circuits and returns `bootstrapped: false`. Re-running on a
 *    populated store never duplicates the owner or re-mints anything.
 */

import {
  openDb,
  transaction,
  transactionImmediate,
  type SqliteDb,
  type SqliteStmt,
} from './db.js'
import { applyMigrations } from './schema.js'
import {
  hashPassword,
  hashToken,
  verifyPassword,
} from './credentials.js'
import {
  newAdminToken,
  newApiKey,
  newId,
  newInvitationToken,
  newSessionToken,
} from './tokens.js'
import { IdentityError } from './errors.js'
import { VaultStore, type VaultMutationReason } from './vault-store.js'
import {
  AUDIT_ACTIONS,
  ROLES,
  USAGE_METRIC_MAX_LEN,
  USAGE_PERIODS,
  type AcceptInvitationInput,
  type AuditAction,
  type AuditActorSource,
  type AuditLogEntry,
  type BootstrapInput,
  type BootstrapResult,
  type CheckAndIncrementInput,
  type CheckAndIncrementResult,
  type CreateInvitationInput,
  type CreateUserInput,
  type CreateVaultEntryInput,
  type Credential,
  type CredentialKind,
  type GetUsageQuery,
  type Invitation,
  type InvitationStatus,
  type IssuedAdminToken,
  type IssuedApiKey,
  type IssuedInvitation,
  type ListAuditLogQuery,
  type ListInvitationsQuery,
  type ListVaultEntriesQuery,
  type Membership,
  type OwnerKind,
  type ResetUsageInput,
  type Role,
  type Session,
  type AddPeerInput,
  type ListPeersQuery,
  type PeerRegistration,
  type SetQuotaInput,
  type SweepUsageResult,
  type UpdatePeerInput,
  type UsageCounter,
  type UsagePeriod,
  type CheckOrgQuotaResult,
  type OrgQuota,
  type OrgQuotaState,
  type SetOrgQuotaInput,
  type User,
  type VaultEntry,
  type VaultKind,
  type WriteAuditLogInput,
  // Phase 11 M2 — Suspended tasks (long-running agent park/resume)
  type SuspendedTask,
  type PersistSuspendedTaskInput,
  type ListDueSuspendedTasksQuery,
  // Phase 12 M1 — IM bindings.
  type ImBinding,
  type ImBindingCode,
  type IssueImBindingCodeInput,
  type ClaimImBindingCodeInput,
  type ClaimImBindingResult,
  type ListImBindingsQuery,
} from './types.js'
import { randomInt } from 'node:crypto'

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

// Invitation TTL bounds. Default 24h matches the operator's mental model
// ("link is good for a day"). Lower bound is 1 minute (smoke-test floor;
// anything shorter is almost certainly a typo). Upper bound is 30 days —
// past that you should be issuing accounts directly, not a "join soon"
// invite.
const DEFAULT_INVITATION_TTL_MS = 24 * 60 * 60 * 1000
const MIN_INVITATION_TTL_MS = 60_000
const MAX_INVITATION_TTL_MS = 30 * 24 * 60 * 60 * 1000

// Deliberately loose: requires only `local-part@domain` shape. We do NOT
// enforce a dot in the domain so the default bootstrap sentinel
// `admin@local` is accepted (single-machine setup, never seen by SMTP).
// Real production validation (DNS resolution, SMTP verification, OAuth
// claim binding) lives at the surface that minted the email, not here.
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/

// Pre-computed at module load — see security note (1).
const DUMMY_SCRYPT_HASH = hashPassword('aipehub-identity-timing-equaliser-not-a-real-credential')

export interface OpenIdentityStoreInput {
  dbPath: string
  /** Default session TTL in ms. Defaults to 7 days. */
  defaultSessionTtlMs?: number
  /**
   * A1 (v4 Phase 5) — 32-byte master key for vault encryption. Required
   * only if the caller plans to use vault APIs (createVaultEntry /
   * readVaultSecret / ...). When omitted, vault methods throw
   * `vault_not_configured` so misconfiguration fails loud instead of
   * silently returning empty results.
   *
   * Hosts should obtain this from `loadOrCreateMasterKey(<workspace>/master.key)`.
   * Tests can inject a fixed buffer for determinism.
   */
  masterKey?: Buffer
}

interface UserRow {
  id: string
  email: string
  display_name: string | null
  created_at: number
  last_login_at: number | null
}
interface CredentialRow {
  id: string
  user_id: string
  kind: string
  identifier: string
  secret_hash: string
  label: string | null
  created_at: number
  last_used_at: number | null
}
interface MembershipRow {
  id: string
  user_id: string
  role: string
  created_at: number
}
interface SessionRow {
  token: string
  user_id: string
  expires_at: number
  created_at: number
  last_seen_at: number
}
interface AuditLogRow {
  id: string
  ts: number
  actor_user_id: string | null
  actor_source: string
  action: string
  target_user_id: string | null
  target_credential_id: string | null
  ip: string | null
  user_agent: string | null
  metadata: string | null
  success: number
}
interface InvitationRow {
  id: string
  token_hash: string
  email: string
  role: string
  invited_by: string | null
  display_name: string | null
  expires_at: number
  status: string
  created_at: number
  accepted_at: number | null
  accepted_user_id: string | null
}
const AUDIT_ACTOR_SOURCES: readonly AuditActorSource[] = [
  'v4-session',
  'v4-bearer',
  'anonymous',
  'system',
  'federated', // FED-M4
  // A2.2 (v4 Phase 5) — 'v3-admin' removed from the writable enum.
  // rowToAuditLog still tolerates pre-A2.2 rows that carry the old
  // string in `actor_source` (clamped to 'system' via the fallback).
] as const

function isAuditActorSource(s: string): s is AuditActorSource {
  return (AUDIT_ACTOR_SOURCES as readonly string[]).includes(s)
}

const INVITATION_STATUSES: readonly InvitationStatus[] = [
  'pending',
  'accepted',
  'revoked',
  'expired',
] as const

function isInvitationStatus(s: string): s is InvitationStatus {
  return (INVITATION_STATUSES as readonly string[]).includes(s)
}

/**
 * Overlay 'expired' on top of a still-'pending' row when its TTL has
 * elapsed. Terminal statuses (accepted/revoked) are NOT overridden — an
 * accepted invite past its expiry is still 'accepted', not 'expired'.
 * Corrupt status falls back to 'pending' (visible in admin UI, surface
 * for manual cleanup).
 */
function computeInvitationStatus(
  rowStatus: string,
  expiresAt: number,
  now: number,
): InvitationStatus {
  if (rowStatus === 'pending') {
    return expiresAt < now ? 'expired' : 'pending'
  }
  return isInvitationStatus(rowStatus) ? rowStatus : 'pending'
}

function rowToInvitation(r: InvitationRow, now: number): Invitation {
  return {
    id: r.id,
    email: r.email,
    role: r.role as Role,
    invitedBy: r.invited_by,
    displayName: r.display_name,
    expiresAt: r.expires_at,
    status: computeInvitationStatus(r.status, r.expires_at, now),
    createdAt: r.created_at,
    acceptedAt: r.accepted_at,
    acceptedUserId: r.accepted_user_id,
  }
}

function rowToAuditLog(r: AuditLogRow): AuditLogEntry {
  let metadata: Record<string, unknown> | null = null
  if (r.metadata) {
    try {
      const parsed: unknown = JSON.parse(r.metadata)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>
      }
    } catch {
      // Corrupt JSON (manual edit / partial write recovery). Surface
      // it as a stringified blob so the operator still sees it in the
      // UI — but under a single key so the consumer needn't probe.
      metadata = { _corrupt: r.metadata }
    }
  }
  return {
    id: r.id,
    ts: r.ts,
    actorUserId: r.actor_user_id,
    actorSource: isAuditActorSource(r.actor_source)
      ? r.actor_source
      : ('system' as AuditActorSource), // graceful fallback on db-edit corruption
    action: r.action,
    targetUserId: r.target_user_id,
    targetCredentialId: r.target_credential_id,
    ip: r.ip,
    userAgent: r.user_agent,
    metadata,
    success: r.success === 1,
  }
}

function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  }
}
function rowToCredential(r: CredentialRow): Credential {
  return {
    id: r.id,
    userId: r.user_id,
    kind: r.kind as CredentialKind,
    identifier: r.identifier,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }
}
function rowToMembership(r: MembershipRow): Membership {
  return {
    id: r.id,
    userId: r.user_id,
    role: r.role as Role,
    createdAt: r.created_at,
  }
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

function assertRole(role: string): asserts role is Role {
  if (!ROLES.includes(role as Role)) {
    throw new IdentityError({
      code: 'invalid_role',
      message: `role must be one of ${ROLES.join(', ')}; got ${JSON.stringify(role)}`,
    })
  }
}

function assertEmailShape(email: string): void {
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    throw new IdentityError({
      code: 'invalid_email',
      message: `invalid email: ${JSON.stringify(email)}`,
    })
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as Error & { code?: string }).code
  if (code === 'SQLITE_CONSTRAINT_UNIQUE') return true
  return /UNIQUE constraint failed/.test(err.message)
}

export class IdentityStore {
  private readonly db: SqliteDb
  private readonly defaultSessionTtlMs: number
  // R13 — the vault domain (AES-256-GCM secret storage) lives in its own
  // VaultStore. IdentityStore composes one and forwards the public vault
  // methods, so callers see no API change. masterKey + vault prepared
  // statements + mutation listeners all moved with it.
  private readonly vault: VaultStore

  // D1 — peer registry prepared statements. Lazy for the same reason
  // as vault (hosts without federation don't allocate).
  private _stmtPeerInsert?: SqliteStmt
  private _stmtPeerById?: SqliteStmt
  private _stmtPeerByPeerId?: SqliteStmt
  private _stmtPeerListAll?: SqliteStmt
  private _stmtPeerListEnabled?: SqliteStmt
  private _stmtPeerUpdate?: SqliteStmt
  private _stmtPeerDelete?: SqliteStmt

  // ---- prepared statements (hot path) ----
  private readonly stmtUserById: SqliteStmt
  private readonly stmtUserByEmail: SqliteStmt
  private readonly stmtInsertUser: SqliteStmt
  private readonly stmtListUsers: SqliteStmt
  private readonly stmtUpdateLastLogin: SqliteStmt
  private readonly stmtCountUsers: SqliteStmt

  private readonly stmtInsertCredential: SqliteStmt
  private readonly stmtFindCredByKindIdent: SqliteStmt
  private readonly stmtFindTokenCredByIdent: SqliteStmt
  private readonly stmtCredsByUser: SqliteStmt
  private readonly stmtDeleteCredential: SqliteStmt
  private readonly stmtDeletePasswordsForUser: SqliteStmt
  private readonly stmtTouchCredential: SqliteStmt

  private readonly stmtInsertMembership: SqliteStmt
  private readonly stmtMembershipByUser: SqliteStmt
  private readonly stmtUpdateMembershipRole: SqliteStmt

  private readonly stmtInsertSession: SqliteStmt
  private readonly stmtSessionByToken: SqliteStmt
  private readonly stmtTouchSession: SqliteStmt
  private readonly stmtDeleteSession: SqliteStmt
  private readonly stmtDeleteExpiredSessions: SqliteStmt
  private readonly stmtDeleteSessionsForUser: SqliteStmt

  private readonly stmtInsertAuditLog: SqliteStmt

  private readonly stmtInsertInvitation: SqliteStmt
  private readonly stmtInvitationByTokenHash: SqliteStmt
  private readonly stmtInvitationById: SqliteStmt
  private readonly stmtInvitationPendingByEmail: SqliteStmt
  private readonly stmtMarkInvitationAccepted: SqliteStmt
  private readonly stmtMarkInvitationRevoked: SqliteStmt
  // Phase 6 #9 — count active-pending invites for the createInvitation
  // hard cap. Uses the same predicate as the read-side computed status
  // ("status='pending' AND not expired") so the cap matches what
  // listInvitations reports as pending.
  private readonly stmtInvitationCountActivePending: SqliteStmt

  // B2.1 — usage counters. Eagerly prepared (not lazy like vault) since
  // checkAndIncrement is the agent-spawn hot path once B2.2 lands.
  private readonly stmtUsageGet: SqliteStmt
  private readonly stmtUsageUpsert: SqliteStmt
  private readonly stmtUsageUpdate: SqliteStmt
  private readonly stmtUsageListByUser: SqliteStmt
  private readonly stmtUsageListByUserMetric: SqliteStmt
  private readonly stmtUsageListByUserPeriod: SqliteStmt
  private readonly stmtUsageListByTriple: SqliteStmt
  // B2.3 — background sweep prepared statement. One UPDATE covers
  // every stale row of a given period (hourly / daily / monthly);
  // 'total' rows are excluded entirely because their period_start is
  // the sentinel 0 and they're lifetime counters.
  private readonly stmtUsageSweep: SqliteStmt
  // E1 — aggregate sum across all users for (metric, period). Only
  // counts rows whose period_start matches the current boundary —
  // stale rows that haven't been swept yet (and the sentinel 0 for
  // 'total') are filtered to keep the aggregate honest.
  private readonly stmtSumUsageCurrent: SqliteStmt
  private readonly stmtSumUsageTotal: SqliteStmt
  // E1 — org_quotas CRUD + transition tracking.
  private readonly stmtOrgQuotaUpsert: SqliteStmt
  private readonly stmtOrgQuotaGet: SqliteStmt
  private readonly stmtOrgQuotaList: SqliteStmt
  private readonly stmtOrgQuotaDelete: SqliteStmt
  private readonly stmtOrgQuotaTouchState: SqliteStmt
  // Phase 7 M4 — org_meta kv (org_mode lives here).
  private readonly stmtOrgMetaGet: SqliteStmt
  private readonly stmtOrgMetaUpsert: SqliteStmt
  // Phase 11 M2 — suspended_tasks CRUD. Eagerly prepared since the
  // resume sweep (M3) and the scheduler's notifySuspend hook are both
  // potentially hot paths. INSERT is `OR REPLACE` so a participant
  // that throws SuspendTaskError from `onResume` (suspend again) just
  // overwrites the existing row instead of erroring on PK collision.
  private readonly stmtSuspendInsert: SqliteStmt
  private readonly stmtSuspendDelete: SqliteStmt
  private readonly stmtSuspendGetById: SqliteStmt
  private readonly stmtSuspendListDue: SqliteStmt
  private readonly stmtSuspendListByAgent: SqliteStmt

  // Phase 12 M1 — IM bindings. Two adjacent tables (im_bindings +
  // im_binding_codes) with a small set of hot statements. The bot DM
  // path (claim) and per-message resolve path (getUserIdByImBinding)
  // both want O(1) PK lookups.
  private readonly stmtImBindingInsert: SqliteStmt
  private readonly stmtImBindingGetByPlatformUser: SqliteStmt
  private readonly stmtImBindingListByUser: SqliteStmt
  private readonly stmtImBindingListByUserPlatform: SqliteStmt
  private readonly stmtImBindingDelete: SqliteStmt
  private readonly stmtImBindingCodeInsert: SqliteStmt
  private readonly stmtImBindingCodeGetByCode: SqliteStmt
  private readonly stmtImBindingCodeDeleteByCode: SqliteStmt
  private readonly stmtImBindingCodeDeleteByUser: SqliteStmt
  private readonly stmtImBindingCodeDeleteExpired: SqliteStmt

  constructor(db: SqliteDb, defaultSessionTtlMs: number, masterKey?: Buffer) {
    this.db = db
    this.defaultSessionTtlMs = defaultSessionTtlMs
    // R13 — vault domain extracted. VaultStore owns the masterKey (and
    // detects "host didn't configure encryption" vs "wrong key supplied")
    // plus its own lazy prepared statements + mutation listeners.
    this.vault = new VaultStore(db, masterKey)

    this.stmtUserById = db.prepare('SELECT * FROM users WHERE id = ?')
    this.stmtUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?')
    this.stmtInsertUser = db.prepare(
      'INSERT INTO users(id, email, display_name, created_at, last_login_at) VALUES(?, ?, ?, ?, NULL)',
    )
    this.stmtListUsers = db.prepare('SELECT * FROM users ORDER BY created_at')
    this.stmtUpdateLastLogin = db.prepare(
      'UPDATE users SET last_login_at = ? WHERE id = ?',
    )
    this.stmtCountUsers = db.prepare('SELECT COUNT(*) AS c FROM users')

    this.stmtInsertCredential = db.prepare(
      `INSERT INTO credentials(id, user_id, kind, identifier, secret_hash, label, created_at, last_used_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    this.stmtFindCredByKindIdent = db.prepare(
      'SELECT * FROM credentials WHERE kind = ? AND identifier = ?',
    )
    this.stmtFindTokenCredByIdent = db.prepare(
      `SELECT * FROM credentials
        WHERE identifier = ? AND (kind = 'admin_token' OR kind = 'api_key')
        LIMIT 1`,
    )
    this.stmtCredsByUser = db.prepare(
      'SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at',
    )
    this.stmtDeleteCredential = db.prepare(
      'DELETE FROM credentials WHERE id = ?',
    )
    this.stmtDeletePasswordsForUser = db.prepare(
      `DELETE FROM credentials WHERE user_id = ? AND kind = 'password'`,
    )
    this.stmtTouchCredential = db.prepare(
      'UPDATE credentials SET last_used_at = ? WHERE id = ?',
    )

    this.stmtInsertMembership = db.prepare(
      'INSERT INTO memberships(id, user_id, role, created_at) VALUES(?, ?, ?, ?)',
    )
    this.stmtMembershipByUser = db.prepare(
      'SELECT * FROM memberships WHERE user_id = ?',
    )
    this.stmtUpdateMembershipRole = db.prepare(
      'UPDATE memberships SET role = ? WHERE user_id = ?',
    )

    this.stmtInsertSession = db.prepare(
      `INSERT INTO auth_sessions(token, user_id, expires_at, created_at, last_seen_at)
       VALUES(?, ?, ?, ?, ?)`,
    )
    this.stmtSessionByToken = db.prepare(
      'SELECT * FROM auth_sessions WHERE token = ?',
    )
    this.stmtTouchSession = db.prepare(
      'UPDATE auth_sessions SET last_seen_at = ? WHERE token = ?',
    )
    this.stmtDeleteSession = db.prepare(
      'DELETE FROM auth_sessions WHERE token = ?',
    )
    this.stmtDeleteExpiredSessions = db.prepare(
      'DELETE FROM auth_sessions WHERE expires_at < ?',
    )
    this.stmtDeleteSessionsForUser = db.prepare(
      'DELETE FROM auth_sessions WHERE user_id = ?',
    )

    this.stmtInsertAuditLog = db.prepare(
      `INSERT INTO audit_log(
         id, ts, actor_user_id, actor_source, action,
         target_user_id, target_credential_id,
         ip, user_agent, metadata, success
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    // listAuditLog uses a dynamically-built statement (filters vary
    // per call) — preparing here would not help. We rely on
    // better-sqlite3's per-call statement cache instead.

    this.stmtInsertInvitation = db.prepare(
      `INSERT INTO invitations(
         id, token_hash, email, role, invited_by, display_name,
         expires_at, status, created_at, accepted_at, accepted_user_id
       ) VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`,
    )
    this.stmtInvitationByTokenHash = db.prepare(
      'SELECT * FROM invitations WHERE token_hash = ?',
    )
    this.stmtInvitationById = db.prepare(
      'SELECT * FROM invitations WHERE id = ?',
    )
    // "Pending" for the createInvitation gate excludes expired rows too —
    // an expired invite shouldn't block a fresh one.
    this.stmtInvitationPendingByEmail = db.prepare(
      `SELECT * FROM invitations
        WHERE email = ? AND status = 'pending' AND expires_at >= ?
        LIMIT 1`,
    )
    // Phase 6 #9 — counter for the org-wide hard cap. Same predicate as
    // listInvitations's computed pending status.
    this.stmtInvitationCountActivePending = db.prepare(
      `SELECT COUNT(*) AS c FROM invitations
        WHERE status = 'pending' AND expires_at >= ?`,
    )
    // Guarded UPDATE — `status = 'pending'` in the WHERE clause means a
    // race between two accepts can never both succeed; the second one's
    // `changes === 0` and the caller surfaces invitation_already_used.
    this.stmtMarkInvitationAccepted = db.prepare(
      `UPDATE invitations
          SET status = 'accepted', accepted_at = ?, accepted_user_id = ?
        WHERE id = ? AND status = 'pending'`,
    )
    this.stmtMarkInvitationRevoked = db.prepare(
      `UPDATE invitations SET status = 'revoked' WHERE id = ? AND status = 'pending'`,
    )

    // B2.1 — usage counters.
    this.stmtUsageGet = db.prepare(
      `SELECT * FROM usage_counters
        WHERE user_id = ? AND metric = ? AND period = ?`,
    )
    // ON CONFLICT DO UPDATE lets setQuota be a single statement whether
    // the row exists or not. We update `quota` + `updated_at`; `used`
    // and `period_start` stay at their current values (don't reset
    // usage when only the cap changes).
    this.stmtUsageUpsert = db.prepare(
      `INSERT INTO usage_counters
         (user_id, metric, period, period_start, used, quota, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, metric, period) DO UPDATE SET
         quota = excluded.quota,
         updated_at = excluded.updated_at`,
    )
    // checkAndIncrement uses this for "row exists, advance it": writes
    // used + period_start + updated_at (quota stays put — set via
    // setQuota only).
    this.stmtUsageUpdate = db.prepare(
      `UPDATE usage_counters
         SET used = ?, period_start = ?, updated_at = ?
       WHERE user_id = ? AND metric = ? AND period = ?`,
    )
    this.stmtUsageListByUser = db.prepare(
      `SELECT * FROM usage_counters WHERE user_id = ?
        ORDER BY metric, period`,
    )
    this.stmtUsageListByUserMetric = db.prepare(
      `SELECT * FROM usage_counters WHERE user_id = ? AND metric = ?
        ORDER BY period`,
    )
    this.stmtUsageListByUserPeriod = db.prepare(
      `SELECT * FROM usage_counters WHERE user_id = ? AND period = ?
        ORDER BY metric`,
    )
    this.stmtUsageListByTriple = db.prepare(
      `SELECT * FROM usage_counters
        WHERE user_id = ? AND metric = ? AND period = ?`,
    )
    // B2.3 — sweep stale rows of a single `period` forward to a fresh
    // boundary. `period_start < ?` (strict <) is deliberate: an admin
    // who manually edits a row to a *future* periodStart, or a host
    // whose wall-clock briefly jumps backwards (NTP correction), must
    // not see its counter erased. The sweep only ever moves time
    // forward.
    this.stmtUsageSweep = db.prepare(
      `UPDATE usage_counters
         SET used = 0, period_start = ?, updated_at = ?
       WHERE period = ? AND period_start < ?`,
    )

    // E1 — aggregate per-org sum. For non-'total' periods we filter on
    // `period_start = ?` so stale-but-unswept rows contribute 0 to the
    // aggregate (sweep will roll them on the next 1h tick; until then
    // we don't want yesterday's usage padding today's bill).
    // COALESCE because SUM of zero rows returns NULL.
    this.stmtSumUsageCurrent = db.prepare(
      `SELECT COALESCE(SUM(used), 0) AS s
         FROM usage_counters
        WHERE metric = ? AND period = ? AND period_start = ?`,
    )
    this.stmtSumUsageTotal = db.prepare(
      `SELECT COALESCE(SUM(used), 0) AS s
         FROM usage_counters
        WHERE metric = ? AND period = 'total'`,
    )

    // E1 — org_quotas.
    //
    // Upsert pattern mirrors setQuota: ON CONFLICT updates quota +
    // warn_pct + updated_at, but PRESERVES last_state / last_checked /
    // created_at. Re-issuing a quota for an at-warn (metric, period)
    // shouldn't reset the transition tracking — the next check decides.
    this.stmtOrgQuotaUpsert = db.prepare(
      `INSERT INTO org_quotas
         (metric, period, quota, warn_pct, last_state, last_checked, created_at, updated_at)
         VALUES(?, ?, ?, ?, 'ok', NULL, ?, ?)
       ON CONFLICT(metric, period) DO UPDATE SET
         quota = excluded.quota,
         warn_pct = excluded.warn_pct,
         updated_at = excluded.updated_at`,
    )
    this.stmtOrgQuotaGet = db.prepare(
      `SELECT * FROM org_quotas WHERE metric = ? AND period = ?`,
    )
    this.stmtOrgQuotaList = db.prepare(
      `SELECT * FROM org_quotas ORDER BY metric, period`,
    )
    this.stmtOrgQuotaDelete = db.prepare(
      `DELETE FROM org_quotas WHERE metric = ? AND period = ?`,
    )
    this.stmtOrgQuotaTouchState = db.prepare(
      `UPDATE org_quotas
         SET last_state = ?, last_checked = ?, updated_at = ?
       WHERE metric = ? AND period = ?`,
    )
    // Phase 7 M4 — org_meta key/value bag.
    this.stmtOrgMetaGet = db.prepare(
      `SELECT value FROM org_meta WHERE key = ?`,
    )
    this.stmtOrgMetaUpsert = db.prepare(
      `INSERT INTO org_meta(key, value, updated_at) VALUES(?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    // Phase 11 M2 — suspended_tasks. `INSERT OR REPLACE` covers the
    // suspend-again case (a participant throws SuspendTaskError from
    // its `onResume` hook) without us having to branch in the public
    // API. Listing-by-due is the sweep query (M3); listing-by-agent
    // is exposed for future admin-UI inspection of parked tasks.
    this.stmtSuspendInsert = db.prepare(
      `INSERT OR REPLACE INTO suspended_tasks(
         task_id, agent_id, hub_id, origin_user_id,
         resume_at, state, task_json, created_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.stmtSuspendDelete = db.prepare(
      `DELETE FROM suspended_tasks WHERE task_id = ?`,
    )
    this.stmtSuspendGetById = db.prepare(
      `SELECT * FROM suspended_tasks WHERE task_id = ?`,
    )
    this.stmtSuspendListDue = db.prepare(
      `SELECT * FROM suspended_tasks
         WHERE resume_at <= ?
       ORDER BY resume_at ASC
       LIMIT ?`,
    )
    this.stmtSuspendListByAgent = db.prepare(
      `SELECT * FROM suspended_tasks
         WHERE agent_id = ?
       ORDER BY resume_at ASC`,
    )

    // Phase 12 M1 — IM bindings.
    //
    // INSERT OR REPLACE on im_bindings handles the "user moves their
    // (platform, platformUserId) to a different AipeHub account" case
    // (or just re-binds after the prior owner of the IM identity
    // explicitly unbound — same effect).
    //
    // INSERT (not OR REPLACE) on im_binding_codes; per-user code
    // rotation runs DELETE-by-user first inside the same transaction.
    // We want collision on the PK if two different mints picked the
    // same random code so the issue path can retry, NOT silently
    // overwrite some other user's pending code.
    this.stmtImBindingInsert = db.prepare(
      `INSERT OR REPLACE INTO im_bindings(
         platform, platform_user_id, user_id, display_name, created_at
       ) VALUES(?, ?, ?, ?, ?)`,
    )
    this.stmtImBindingGetByPlatformUser = db.prepare(
      `SELECT * FROM im_bindings WHERE platform = ? AND platform_user_id = ?`,
    )
    this.stmtImBindingListByUser = db.prepare(
      `SELECT * FROM im_bindings WHERE user_id = ? ORDER BY created_at ASC, platform ASC`,
    )
    this.stmtImBindingListByUserPlatform = db.prepare(
      `SELECT * FROM im_bindings
         WHERE user_id = ? AND platform = ?
       ORDER BY created_at ASC`,
    )
    this.stmtImBindingDelete = db.prepare(
      `DELETE FROM im_bindings WHERE platform = ? AND platform_user_id = ?`,
    )
    this.stmtImBindingCodeInsert = db.prepare(
      `INSERT INTO im_binding_codes(code, user_id, expires_at, created_at)
       VALUES(?, ?, ?, ?)`,
    )
    this.stmtImBindingCodeGetByCode = db.prepare(
      `SELECT * FROM im_binding_codes WHERE code = ?`,
    )
    this.stmtImBindingCodeDeleteByCode = db.prepare(
      `DELETE FROM im_binding_codes WHERE code = ?`,
    )
    this.stmtImBindingCodeDeleteByUser = db.prepare(
      `DELETE FROM im_binding_codes WHERE user_id = ?`,
    )
    this.stmtImBindingCodeDeleteExpired = db.prepare(
      `DELETE FROM im_binding_codes WHERE expires_at < ?`,
    )
  }

  // =====================================================================
  // Bootstrap
  // =====================================================================

  bootstrap(input: BootstrapInput = {}): BootstrapResult {
    const count = (this.stmtCountUsers.get() as { c: number }).c
    if (count > 0) {
      return { bootstrapped: false, ownerUserId: null }
    }

    const email = normaliseEmail(input.ownerEmail ?? 'admin@local')
    // We allow 'admin@local' even though `.local` is non-routable —
    // bootstrap is a single-machine ceremony, not a real email.
    if (!EMAIL_RE.test(email)) {
      throw new IdentityError({
        code: 'invalid_email',
        message: `bootstrap ownerEmail invalid: ${JSON.stringify(input.ownerEmail)}`,
      })
    }
    const displayName = input.ownerDisplayName ?? 'Admin'

    // A2.2 — owner is created WITHOUT any credentials. The setup wizard
    // (delivered with C1) is the documented path for the first operator
    // to set a password. Until then, the `mint-admin-token` host
    // subcommand mints a one-shot admin_token they can use to log in.
    return transaction(this.db, () => {
      const userId = newId()
      const now = Date.now()
      this.stmtInsertUser.run(userId, email, displayName, now)
      this.stmtInsertMembership.run(newId(), userId, 'owner', now)
      // Phase 7 M4 — first-time bootstrap defaults to personal mode
      // (single user, no peers, no invitations yet). The SPA shell
      // reads `org_mode` on every page load; the inferred mode flips
      // to 'team' the moment a second user / first invitation lands.
      this.stmtOrgMetaUpsert.run('org_mode', 'personal', now)
      return { bootstrapped: true, ownerUserId: userId }
    })
  }

  // =====================================================================
  // Phase 7 M4 — org_meta kv (mode + future org-wide scalars)
  // =====================================================================

  /**
   * Read a single org_meta value. Returns null when the key has never
   * been written. Callers wanting a typed value (eg. mode) should use
   * the higher-level helpers below.
   */
  getOrgMeta(key: string): string | null {
    if (typeof key !== 'string' || key.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'org_meta key must be a non-empty string',
      })
    }
    const row = this.stmtOrgMetaGet.get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  /**
   * Write or replace an org_meta value. Returns void; the operation is
   * idempotent (same key + same value is a no-op write of updated_at).
   */
  setOrgMeta(key: string, value: string): void {
    if (typeof key !== 'string' || key.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'org_meta key must be a non-empty string',
      })
    }
    if (typeof value !== 'string') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'org_meta value must be a string (stringify json yourself)',
      })
    }
    this.stmtOrgMetaUpsert.run(key, value, Date.now())
  }

  /**
   * Phase 7 M4 — high-level org mode read.
   *
   * Returns 'personal' when:
   *   - org_meta.org_mode is explicitly 'personal', OR
   *   - org_meta.org_mode is absent AND the org has a single user
   *     (the auto-detect path; covers the very first bootstrap and any
   *     pre-Phase-7 db that never wrote the row).
   *
   * Returns 'team' otherwise. Operators can pin either value via
   * setOrgMode() (eg. AIPE_MODE env at host startup).
   */
  getOrgMode(): 'personal' | 'team' {
    const stored = this.getOrgMeta('org_mode')
    if (stored === 'personal' || stored === 'team') return stored
    // Auto-detect: single-user → personal.
    return this.countUsers() <= 1 ? 'personal' : 'team'
  }

  setOrgMode(mode: 'personal' | 'team'): void {
    if (mode !== 'personal' && mode !== 'team') {
      throw new IdentityError({
        code: 'invalid_input',
        message: `org_mode must be 'personal' or 'team'; got ${JSON.stringify(mode)}`,
      })
    }
    this.setOrgMeta('org_mode', mode)
  }

  // =====================================================================
  // Users
  // =====================================================================

  createUser(input: CreateUserInput): User {
    if (!input || typeof input !== 'object') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'createUser input required',
      })
    }
    if (typeof input.email !== 'string') {
      throw new IdentityError({
        code: 'invalid_email',
        message: 'email required',
      })
    }
    const email = normaliseEmail(input.email)
    assertEmailShape(email)

    const role: Role = input.role ?? 'member'
    assertRole(role)

    const displayName =
      input.displayName === undefined ? null : input.displayName
    if (displayName !== null && typeof displayName !== 'string') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'displayName must be string or null',
      })
    }

    const userId = newId()
    const now = Date.now()

    return transaction(this.db, () => {
      try {
        this.stmtInsertUser.run(userId, email, displayName, now)
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new IdentityError({
            code: 'duplicate_email',
            message: `email already in use: ${email}`,
            cause: err,
          })
        }
        throw err
      }
      this.stmtInsertMembership.run(newId(), userId, role, now)

      // Phase 7 M4 — adding a 2nd+ user (any path: invite-accept,
      // admin createUser, peer-bootstrap) is the canonical "we became
      // a team" moment. Flip mode now so the SPA shell switches on
      // next page load. Idempotent: already-team stays team.
      const userCount = (this.stmtCountUsers.get() as { c: number }).c
      if (userCount > 1 && this.getOrgMeta('org_mode') !== 'team') {
        this.stmtOrgMetaUpsert.run('org_mode', 'team', now)
      }

      if (input.password !== undefined) {
        // hashPassword throws on too-short — let it propagate (caller
        // sees a plain Error, not IdentityError; we keep the password
        // module independent for reuse).
        const hash = hashPassword(input.password)
        this.stmtInsertCredential.run(
          newId(),
          userId,
          'password',
          email,
          hash,
          null,
          now,
        )
      }

      return {
        id: userId,
        email,
        displayName,
        createdAt: now,
        lastLoginAt: null,
      }
    })
  }

  getUserById(id: string): User | null {
    if (typeof id !== 'string' || id.length === 0) return null
    const row = this.stmtUserById.get(id) as UserRow | undefined
    return row ? rowToUser(row) : null
  }

  getUserByEmail(email: string): User | null {
    if (typeof email !== 'string') return null
    const row = this.stmtUserByEmail.get(normaliseEmail(email)) as
      | UserRow
      | undefined
    return row ? rowToUser(row) : null
  }

  listUsers(): User[] {
    return (this.stmtListUsers.all() as UserRow[]).map(rowToUser)
  }

  countUsers(): number {
    return (this.stmtCountUsers.get() as { c: number }).c
  }

  // =====================================================================
  // Membership / role
  // =====================================================================

  getMembership(userId: string): Membership | null {
    const row = this.stmtMembershipByUser.get(userId) as
      | MembershipRow
      | undefined
    return row ? rowToMembership(row) : null
  }

  setRole(userId: string, role: Role): Membership {
    assertRole(role)
    const user = this.getUserById(userId)
    if (!user) {
      throw new IdentityError({
        code: 'user_not_found',
        message: `user not found: ${userId}`,
      })
    }
    const existing = this.getMembership(userId)
    if (!existing) {
      // Defensive — every user should have a membership row from
      // createUser/bootstrap. If somehow missing, create one.
      const now = Date.now()
      const id = newId()
      this.stmtInsertMembership.run(id, userId, role, now)
      return { id, userId, role, createdAt: now }
    }
    if (existing.role === role) return existing
    // V4-AUDIT-03: refuse to demote the last owner. Without this, an
    // admin can lock themselves out of every owner-gated route — the
    // only recovery is editing the sqlite file directly, which is an
    // operations break-glass we don't want as the documented path.
    if (existing.role === 'owner' && role !== 'owner') {
      const ownerCount = (
        this.db
          .prepare(`SELECT COUNT(*) AS c FROM memberships WHERE role = 'owner'`)
          .get() as { c: number }
      ).c
      if (ownerCount <= 1) {
        throw new IdentityError({
          code: 'last_owner',
          message:
            'refusing to demote the last owner; promote another user to owner first, then retry',
        })
      }
    }
    this.stmtUpdateMembershipRole.run(role, userId)
    return { ...existing, role }
  }

  // =====================================================================
  // Credentials
  // =====================================================================

  setPassword(userId: string, password: string): void {
    const user = this.getUserById(userId)
    if (!user) {
      throw new IdentityError({
        code: 'user_not_found',
        message: `user not found: ${userId}`,
      })
    }
    const hash = hashPassword(password) // may throw weak_password
    transaction(this.db, () => {
      this.stmtDeletePasswordsForUser.run(userId)
      this.stmtInsertCredential.run(
        newId(),
        userId,
        'password',
        user.email,
        hash,
        null,
        Date.now(),
      )
    })
  }

  issueAdminToken(opts: {
    userId: string
    label?: string
  }): IssuedAdminToken {
    const user = this.getUserById(opts.userId)
    if (!user) {
      throw new IdentityError({
        code: 'user_not_found',
        message: `user not found: ${opts.userId}`,
      })
    }
    const token = newAdminToken()
    const identifier = hashToken(token)
    const credentialId = newId()
    this.stmtInsertCredential.run(
      credentialId,
      opts.userId,
      'admin_token',
      identifier,
      identifier,
      opts.label ?? null,
      Date.now(),
    )
    return { token, credentialId }
  }

  issueApiKey(opts: { userId: string; label?: string }): IssuedApiKey {
    const user = this.getUserById(opts.userId)
    if (!user) {
      throw new IdentityError({
        code: 'user_not_found',
        message: `user not found: ${opts.userId}`,
      })
    }
    const key = newApiKey()
    const identifier = hashToken(key)
    const credentialId = newId()
    this.stmtInsertCredential.run(
      credentialId,
      opts.userId,
      'api_key',
      identifier,
      identifier,
      opts.label ?? null,
      Date.now(),
    )
    return { key, credentialId }
  }

  listCredentials(userId: string): Credential[] {
    return (this.stmtCredsByUser.all(userId) as CredentialRow[]).map(
      rowToCredential,
    )
  }

  revokeCredential(credentialId: string): void {
    this.stmtDeleteCredential.run(credentialId)
  }

  // =====================================================================
  // Authentication
  // =====================================================================

  authenticatePassword(opts: {
    email: string
    password: string
    ttlMs?: number
  }): Session {
    if (
      typeof opts?.email !== 'string' ||
      typeof opts?.password !== 'string'
    ) {
      // Still run a dummy verify to equalise timing with the "user-found
      // but wrong password" path.
      verifyPassword('', DUMMY_SCRYPT_HASH)
      throw new IdentityError({
        code: 'authentication_failed',
        message: 'invalid credentials',
      })
    }
    const email = normaliseEmail(opts.email)
    const cred = this.stmtFindCredByKindIdent.get('password', email) as
      | CredentialRow
      | undefined

    let ok: boolean
    if (cred) {
      ok = verifyPassword(opts.password, cred.secret_hash)
    } else {
      // Equalise timing — see class doc.
      verifyPassword(opts.password, DUMMY_SCRYPT_HASH)
      ok = false
    }

    if (!ok || !cred) {
      throw new IdentityError({
        code: 'authentication_failed',
        message: 'invalid credentials',
      })
    }
    return this.beginSession(
      cred.user_id,
      opts.ttlMs ?? this.defaultSessionTtlMs,
      cred.id,
    )
  }

  authenticateToken(opts: { token: string; ttlMs?: number }): Session {
    const token = opts?.token
    if (typeof token !== 'string' || token.length === 0) {
      throw new IdentityError({
        code: 'authentication_failed',
        message: 'token required',
      })
    }
    const identifier = hashToken(token)
    const cred = this.stmtFindTokenCredByIdent.get(identifier) as
      | CredentialRow
      | undefined
    if (!cred) {
      throw new IdentityError({
        code: 'authentication_failed',
        message: 'invalid token',
      })
    }
    return this.beginSession(
      cred.user_id,
      opts.ttlMs ?? this.defaultSessionTtlMs,
      cred.id,
    )
  }

  /**
   * Common session-mint path used by both authenticate* methods.
   * Updates user.last_login_at and credential.last_used_at as side
   * effects (best-effort — failures here would have already failed
   * the auth path).
   */
  private beginSession(
    userId: string,
    ttlMs: number,
    credentialId: string,
  ): Session {
    if (typeof ttlMs !== 'number' || !isFinite(ttlMs) || ttlMs <= 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `ttlMs must be a positive finite number; got ${ttlMs}`,
      })
    }
    const now = Date.now()
    const expiresAt = now + ttlMs
    const token = newSessionToken()
    transaction(this.db, () => {
      this.stmtInsertSession.run(token, userId, expiresAt, now, now)
      this.stmtUpdateLastLogin.run(now, userId)
      this.stmtTouchCredential.run(now, credentialId)
    })
    return {
      token,
      userId,
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
    }
  }

  // =====================================================================
  // Session lookup (hot path — every web request)
  // =====================================================================

  /**
   * Resolve a bearer session token to (user, role, session). Returns
   * null on:
   *   - unknown token
   *   - expired token (session row left in db; cleanupExpiredSessions
   *     reaps it later)
   *   - dangling session whose user / membership was deleted (FK
   *     CASCADE should have killed the session row too; we double-
   *     check)
   *
   * Side effect: updates `last_seen_at` to now. Cheap (one indexed
   * UPDATE by PK) but it IS a write per request. If that ever becomes
   * a bottleneck, batch it in memory and flush periodically.
   */
  getSessionByToken(token: string):
    | { user: User; role: Role; session: Session }
    | null {
    if (typeof token !== 'string' || token.length === 0) return null
    const sRow = this.stmtSessionByToken.get(token) as SessionRow | undefined
    if (!sRow) return null

    const now = Date.now()
    if (sRow.expires_at < now) return null

    const user = this.getUserById(sRow.user_id)
    if (!user) return null
    const membership = this.getMembership(sRow.user_id)
    if (!membership) return null

    this.stmtTouchSession.run(now, token)

    return {
      user,
      role: membership.role,
      session: {
        token: sRow.token,
        userId: sRow.user_id,
        expiresAt: sRow.expires_at,
        createdAt: sRow.created_at,
        lastSeenAt: now,
      },
    }
  }

  revokeSession(token: string): void {
    this.stmtDeleteSession.run(token)
  }

  revokeAllSessionsForUser(userId: string): { removed: number } {
    const r = this.stmtDeleteSessionsForUser.run(userId)
    return { removed: Number(r.changes) }
  }

  cleanupExpiredSessions(): { removed: number } {
    const r = this.stmtDeleteExpiredSessions.run(Date.now())
    return { removed: Number(r.changes) }
  }

  // =====================================================================
  // Audit log (V4-AUDIT-06)
  //
  // The store exposes a pair of low-level methods (write + list); the web
  // layer is the canonical call-site because that's where IP / UA /
  // actor-source are observable. The store never writes audit rows on
  // its own behalf — that decision is made one layer up so a caller can
  // suppress audit (eg. internal test helpers) by simply not calling
  // writeAuditLog.
  //
  // No retention / pruning is implemented yet. Rows accumulate forever.
  // A future migration v3 could add an `expires_at` index + cleanup;
  // for now, audit volume on a single-org deployment is small enough
  // (one write per mutation, dozens / day) that bounded growth is fine.
  // =====================================================================

  writeAuditLog(input: WriteAuditLogInput): AuditLogEntry {
    if (!input || typeof input !== 'object') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'writeAuditLog input required',
      })
    }
    if (typeof input.action !== 'string' || input.action.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'audit action must be a non-empty string',
      })
    }
    if (!isAuditActorSource(input.actorSource)) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `audit actorSource must be one of ${AUDIT_ACTOR_SOURCES.join(', ')}; got ${JSON.stringify(input.actorSource)}`,
      })
    }
    // Action verbs are caller-supplied; clamp the length so a confused
    // caller can't insert a 1MB string and bloat the table. 200 chars is
    // ~3x our longest known verb and leaves room for future verbs.
    if (input.action.length > 200) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `audit action too long (max 200 chars); got ${input.action.length}`,
      })
    }
    let metadataJson: string | null = null
    if (input.metadata !== undefined && input.metadata !== null) {
      if (typeof input.metadata !== 'object' || Array.isArray(input.metadata)) {
        throw new IdentityError({
          code: 'invalid_input',
          message: 'audit metadata must be a plain object or null',
        })
      }
      try {
        metadataJson = JSON.stringify(input.metadata)
      } catch (err) {
        throw new IdentityError({
          code: 'invalid_input',
          message: `audit metadata not JSON-serialisable: ${(err as Error).message}`,
          cause: err,
        })
      }
      // Cap the serialised blob at 8KB to keep the row size bounded.
      // Real audit metadata is a few keys × short values — anything
      // beyond this is almost certainly a caller mistake (eg. dumping a
      // full request body in).
      if (metadataJson.length > 8192) {
        throw new IdentityError({
          code: 'invalid_input',
          message: `audit metadata too large (max 8KB serialised); got ${metadataJson.length}`,
        })
      }
    }
    const id = newId()
    const ts = Date.now()
    const success = input.success === false ? 0 : 1
    this.stmtInsertAuditLog.run(
      id,
      ts,
      input.actorUserId ?? null,
      input.actorSource,
      input.action,
      input.targetUserId ?? null,
      input.targetCredentialId ?? null,
      input.ip ?? null,
      input.userAgent ?? null,
      metadataJson,
      success,
    )
    return {
      id,
      ts,
      actorUserId: input.actorUserId ?? null,
      actorSource: input.actorSource,
      action: input.action,
      targetUserId: input.targetUserId ?? null,
      targetCredentialId: input.targetCredentialId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      metadata:
        input.metadata !== undefined && input.metadata !== null
          ? input.metadata
          : null,
      success: success === 1,
    }
  }

  // ---- A2 (Phase 5) — typed audit helpers ----
  //
  // Convenience wrappers around writeAuditLog that fix the `action`
  // verb to a value from `AUDIT_ACTIONS` and shape the `metadata` blob
  // into a stable schema the admin UI / rollup queries can rely on.
  // The caller still passes actor / target context (the store can't
  // infer those). All helpers delegate to writeAuditLog so the audit
  // contract (capping metadata at 8KB, validating actorSource, etc) is
  // enforced uniformly.

  /**
   * Audit an LLM / external API call. Convention: `metadata.provider`
   * is the canonical key the admin "API usage" view reads to group by
   * upstream service.
   */
  writeApiCall(input: {
    actorSource: AuditActorSource
    actorUserId?: string | null
    /** Upstream service id: 'anthropic' / 'openai' / 'deepseek' / 'brave-search' / ... */
    provider: string
    /** Optional model identifier when relevant (LLM calls). */
    model?: string
    tokensIn?: number
    tokensOut?: number
    costUsd?: number
    durationMs?: number
    ip?: string | null
    userAgent?: string | null
    success?: boolean
  }): AuditLogEntry {
    const md: Record<string, unknown> = { provider: input.provider }
    if (input.model !== undefined) md.model = input.model
    if (input.tokensIn !== undefined) md.tokensIn = input.tokensIn
    if (input.tokensOut !== undefined) md.tokensOut = input.tokensOut
    if (input.costUsd !== undefined) md.costUsd = input.costUsd
    if (input.durationMs !== undefined) md.durationMs = input.durationMs
    return this.writeAuditLog({
      action: AUDIT_ACTIONS.API_CALL,
      actorSource: input.actorSource,
      actorUserId: input.actorUserId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      metadata: md,
      success: input.success,
    })
  }

  /**
   * Audit a vault entry mutation or secret read. The vault entry id
   * goes in `targetCredentialId` so the existing per-credential audit
   * index lights it up; `metadata.vaultKind` + owner go into the JSON
   * blob.
   */
  writeVaultAccess(input: {
    actorSource: AuditActorSource
    actorUserId?: string | null
    /** What happened to the entry. */
    action: 'create' | 'read' | 'revoke'
    vaultEntryId: string
    vaultKind: VaultKind
    ownerKind: OwnerKind
    ownerId?: string | null
    ip?: string | null
    userAgent?: string | null
    success?: boolean
  }): AuditLogEntry {
    const actionMap: Record<'create' | 'read' | 'revoke', AuditAction> = {
      create: AUDIT_ACTIONS.VAULT_CREATE,
      read: AUDIT_ACTIONS.VAULT_READ,
      revoke: AUDIT_ACTIONS.VAULT_REVOKE,
    }
    return this.writeAuditLog({
      action: actionMap[input.action],
      actorSource: input.actorSource,
      actorUserId: input.actorUserId ?? null,
      targetCredentialId: input.vaultEntryId,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      metadata: {
        vaultKind: input.vaultKind,
        ownerKind: input.ownerKind,
        ownerId: input.ownerId ?? null,
      },
      success: input.success,
    })
  }

  /**
   * Audit a knowledge-set access. `setName` + `(ownerKind, ownerId)`
   * tuple uniquely identifies the set in the global namespace; extra
   * detail (chunks returned, query text excerpt) goes in `extra`.
   */
  writeKnowledgeAccess(input: {
    actorSource: AuditActorSource
    actorUserId?: string | null
    action: 'ingest' | 'search' | 'grant' | 'revoke'
    setName: string
    ownerKind: OwnerKind
    ownerId?: string | null
    extra?: Record<string, unknown>
    ip?: string | null
    userAgent?: string | null
    success?: boolean
  }): AuditLogEntry {
    const actionMap: Record<'ingest' | 'search' | 'grant' | 'revoke', AuditAction> = {
      ingest: AUDIT_ACTIONS.KNOWLEDGE_INGEST,
      search: AUDIT_ACTIONS.KNOWLEDGE_SEARCH,
      grant: AUDIT_ACTIONS.KNOWLEDGE_GRANT,
      revoke: AUDIT_ACTIONS.KNOWLEDGE_REVOKE,
    }
    return this.writeAuditLog({
      action: actionMap[input.action],
      actorSource: input.actorSource,
      actorUserId: input.actorUserId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      metadata: {
        setName: input.setName,
        ownerKind: input.ownerKind,
        ownerId: input.ownerId ?? null,
        ...(input.extra ?? {}),
      },
      success: input.success,
    })
  }

  listAuditLog(query: ListAuditLogQuery = {}): AuditLogEntry[] {
    // Bound limit so a buggy admin UI can't drain the table in one call.
    const limit = Math.max(1, Math.min(1000, query.limit ?? 100))
    const offset = Math.max(0, query.offset ?? 0)
    const where: string[] = []
    const params: (string | number)[] = []
    if (query.action !== undefined) {
      where.push('action = ?')
      params.push(query.action)
    }
    if (query.targetUserId !== undefined) {
      where.push('target_user_id = ?')
      params.push(query.targetUserId)
    }
    if (query.success !== undefined) {
      where.push('success = ?')
      params.push(query.success ? 1 : 0)
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    // Note on injection: every fragment of `whereSql` is a static string
    // literal above; user input is bound via `params`. The only dynamic
    // SQL is the comma-separated AND of static fragments. Safe.
    //
    // Tie-breaker on rowid: ts is Date.now() ms precision, so two rows
    // written in the same millisecond have identical ts. Without a
    // secondary sort, SQLite's order is unspecified and tests that
    // depend on insertion order go flaky. rowid is the implicit auto-
    // increment PK, monotonic per writer.
    const sql = `SELECT * FROM audit_log ${whereSql} ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?`
    params.push(limit, offset)
    const rows = this.db.prepare(sql).all(...params) as AuditLogRow[]
    return rows.map(rowToAuditLog)
  }

  // =====================================================================
  // Invitations (Phase 3 — user invitation flow)
  //
  // Design summary:
  //   - One row per invite. Raw token shown ONCE at create time; only
  //     sha256 is persisted (mirrors api_key / admin_token pattern).
  //   - Status lifecycle: pending → accepted | revoked. `expired` is a
  //     COMPUTED status (pending + TTL elapsed) — never persisted, so we
  //     never need a sweeper to flip rows just to keep state accurate.
  //   - `createInvitation` refuses if there's already a NON-EXPIRED
  //     pending invite for the same email. The operator can revoke the
  //     older one and retry. Goal: one live link per email at a time, so
  //     "the link I got is the one to use" is unambiguous.
  //   - `acceptInvitation` runs in a single transaction: status guard
  //     UPDATE + user create + membership + password credential +
  //     session mint. If any sub-step fails the whole thing rolls back
  //     — no half-accepted state.
  //   - `role` cannot be 'owner' on invite. Owner promotion requires an
  //     existing owner intentionally calling setRole post-accept; this
  //     prevents a leaked invite link from silently minting an admin.
  // =====================================================================

  createInvitation(input: CreateInvitationInput): IssuedInvitation {
    if (!input || typeof input !== 'object') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'createInvitation input required',
      })
    }
    if (typeof input.email !== 'string') {
      throw new IdentityError({
        code: 'invalid_email',
        message: 'email required',
      })
    }
    const email = normaliseEmail(input.email)
    assertEmailShape(email)

    const role: Role = input.role ?? 'member'
    assertRole(role)
    if (role === 'owner') {
      // Owner via invite is an escalation footgun — anyone with the link
      // becomes owner without an existing owner reviewing the post-create
      // state. Block at the store; setRole is the documented path.
      throw new IdentityError({
        code: 'invalid_role',
        message: 'cannot invite as owner; promote post-accept via setRole',
      })
    }

    let displayName: string | null = null
    if (input.displayName !== undefined) {
      if (typeof input.displayName !== 'string') {
        throw new IdentityError({
          code: 'invalid_input',
          message: 'displayName must be a string',
        })
      }
      displayName = input.displayName
    }

    let invitedBy: string | null = null
    if (input.invitedBy !== undefined && input.invitedBy !== null) {
      if (typeof input.invitedBy !== 'string') {
        throw new IdentityError({
          code: 'invalid_input',
          message: 'invitedBy must be a user id string or null',
        })
      }
      invitedBy = input.invitedBy
    }

    const ttlRaw = input.ttlMs ?? DEFAULT_INVITATION_TTL_MS
    if (typeof ttlRaw !== 'number' || !isFinite(ttlRaw)) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `ttlMs must be a finite number; got ${ttlRaw}`,
      })
    }
    const ttl = Math.max(MIN_INVITATION_TTL_MS, Math.min(MAX_INVITATION_TTL_MS, ttlRaw))

    const now = Date.now()
    // Audit #153 — IMMEDIATE, not DEFERRED (the default). The count
    // check below is a SELECT that needs to see a consistent snapshot
    // with the INSERT three blocks down. In WAL + DEFERRED, two
    // concurrent createInvitation transactions can both START at the
    // same wal-frame, both SELECT count=999, both INSERT, both COMMIT
    // — the cap of 1000 ends up at 1001. IMMEDIATE acquires a
    // RESERVED lock right at BEGIN, serialising the count+insert pair.
    // Throughput penalty is negligible: invites are admin actions,
    // not user traffic, and the txn body is ~3ms.
    return transactionImmediate(this.db, () => {
      // Phase 6 #9 — global hard cap on active-pending invites. Run
      // INSIDE the transaction so we can't TOCTOU past the limit.
      // Default 1000; AIPE_MAX_PENDING_INVITES overrides. The cap
      // guards against owner / script error blowing up the invites
      // table (audit log gets one row per attempt; admin UI 'pending'
      // tab becomes unusable; identity.sqlite grows). 1000 active
      // pending is way more than any real org needs.
      const maxPendingRaw = process.env.AIPE_MAX_PENDING_INVITES
      const maxPending = (() => {
        if (!maxPendingRaw) return 1000
        const n = Number.parseInt(maxPendingRaw, 10)
        return Number.isFinite(n) && n > 0 ? n : 1000
      })()
      const countRow = this.stmtInvitationCountActivePending.get(now) as
        | { c: number }
        | undefined
      const pendingCount = countRow?.c ?? 0
      if (pendingCount >= maxPending) {
        throw new IdentityError({
          code: 'invitations_limit_exceeded',
          message:
            `too many active-pending invitations (${pendingCount}/${maxPending}); ` +
            `revoke or wait for expiry before inviting more`,
        })
      }

      // Pending-by-email check INSIDE the transaction so a concurrent
      // create can't slip past. SQLite's default serializable isolation
      // for write transactions means the second one re-reads after the
      // first commits — they can't both see "no pending" and both insert.
      const existing = this.stmtInvitationPendingByEmail.get(email, now) as
        | InvitationRow
        | undefined
      if (existing) {
        throw new IdentityError({
          code: 'invitation_pending_exists',
          message: `a pending invitation already exists for ${email}; revoke it first`,
        })
      }

      // Defensive: also refuse if the email already belongs to a real
      // user. (Owner can setPassword on the existing account instead of
      // re-inviting.) This isn't strictly enforced by schema — the
      // invites table has no FK to users — but creating an invite for an
      // existing email is almost certainly a mistake.
      const existingUser = this.stmtUserByEmail.get(email) as
        | UserRow
        | undefined
      if (existingUser) {
        throw new IdentityError({
          code: 'duplicate_email',
          message: `email already belongs to an existing user: ${email}`,
        })
      }

      const token = newInvitationToken()
      const tokenHash = hashToken(token)
      const id = newId()
      const expiresAt = now + ttl
      this.stmtInsertInvitation.run(
        id,
        tokenHash,
        email,
        role,
        invitedBy,
        displayName,
        expiresAt,
        now,
      )
      // Phase 7 M4 — creating an invitation is the operator's intent
      // signal "I'm growing this from solo to team". Flip the mode
      // now so the next SPA load shows the team shell. Idempotent:
      // already-team stays team.
      if (this.getOrgMeta('org_mode') !== 'team') {
        this.stmtOrgMetaUpsert.run('org_mode', 'team', now)
      }
      const invitation: Invitation = {
        id,
        email,
        role,
        invitedBy,
        displayName,
        expiresAt,
        status: 'pending',
        createdAt: now,
        acceptedAt: null,
        acceptedUserId: null,
      }
      return { token, invitation }
    })
  }

  /**
   * Lookup by raw token. Returns the invite row (with computed status)
   * or null if the token doesn't match any row. The /invite landing
   * page uses this to render "Welcome <displayName>, set your password
   * for <email>" — so we surface the row even on expired / revoked /
   * accepted statuses; the caller decides whether to refuse.
   */
  getInvitationByToken(token: string): Invitation | null {
    if (typeof token !== 'string' || token.length === 0) return null
    const row = this.stmtInvitationByTokenHash.get(hashToken(token)) as
      | InvitationRow
      | undefined
    return row ? rowToInvitation(row, Date.now()) : null
  }

  getInvitationById(id: string): Invitation | null {
    if (typeof id !== 'string' || id.length === 0) return null
    const row = this.stmtInvitationById.get(id) as InvitationRow | undefined
    return row ? rowToInvitation(row, Date.now()) : null
  }

  /**
   * One-shot redemption: validate token → mint user + password + session,
   * mark invite as accepted, all in one transaction. Returns the new
   * session so the caller can set the cookie + redirect to /me without
   * a second login round-trip.
   */
  acceptInvitation(input: AcceptInvitationInput): {
    user: User
    session: Session
    invitation: Invitation
  } {
    if (!input || typeof input !== 'object') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'acceptInvitation input required',
      })
    }
    if (typeof input.token !== 'string' || input.token.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'token required',
      })
    }
    if (typeof input.password !== 'string') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'password required',
      })
    }
    if (input.displayName !== undefined && typeof input.displayName !== 'string') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'displayName must be a string when provided',
      })
    }
    const ttl = input.sessionTtlMs ?? this.defaultSessionTtlMs
    if (typeof ttl !== 'number' || !isFinite(ttl) || ttl <= 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `sessionTtlMs must be a positive finite number; got ${ttl}`,
      })
    }

    // Hash password OUTSIDE the transaction — scrypt is intentionally
    // slow (~100ms) and we don't want it holding a write lock the whole
    // time. May throw weak_password; propagate before opening tx.
    const passwordHash = hashPassword(input.password)
    const tokenHash = hashToken(input.token)

    return transaction(this.db, () => {
      const now = Date.now()
      const row = this.stmtInvitationByTokenHash.get(tokenHash) as
        | InvitationRow
        | undefined
      if (!row) {
        throw new IdentityError({
          code: 'invitation_not_found',
          message: 'invitation not found',
        })
      }
      const effective = computeInvitationStatus(row.status, row.expires_at, now)
      if (effective === 'accepted') {
        throw new IdentityError({
          code: 'invitation_already_used',
          message: 'invitation already accepted',
        })
      }
      if (effective === 'revoked') {
        throw new IdentityError({
          code: 'invitation_revoked',
          message: 'invitation has been revoked',
        })
      }
      if (effective === 'expired') {
        throw new IdentityError({
          code: 'invitation_expired',
          message: 'invitation has expired',
        })
      }
      // effective === 'pending' from here.

      const role = row.role as Role
      // Defensive: db-corruption check. The status enum is enforced at
      // create time, but a manual edit could plant a bad value.
      if (!ROLES.includes(role)) {
        throw new IdentityError({
          code: 'invalid_role',
          message: `invitation row has corrupt role: ${row.role}`,
        })
      }

      const displayName: string | null =
        input.displayName !== undefined ? input.displayName : row.display_name

      // Insert user. Email collision means someone else registered (or
      // an admin createUser'd) the same email between create + accept;
      // surface as duplicate_email rather than silently overwriting.
      const userId = newId()
      try {
        this.stmtInsertUser.run(userId, row.email, displayName, now)
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new IdentityError({
            code: 'duplicate_email',
            message: `email already in use: ${row.email}`,
            cause: err,
          })
        }
        throw err
      }
      this.stmtInsertMembership.run(newId(), userId, role, now)
      this.stmtInsertCredential.run(
        newId(),
        userId,
        'password',
        row.email,
        passwordHash,
        null,
        now,
      )

      // Phase 7 M4 — accepting an invite is the terminal "we're a
      // team now" event. createInvitation already flipped this when
      // the invite was minted, but cover the case where an operator
      // hand-pinned mode back to personal in between.
      const userCount = (this.stmtCountUsers.get() as { c: number }).c
      if (userCount > 1 && this.getOrgMeta('org_mode') !== 'team') {
        this.stmtOrgMetaUpsert.run('org_mode', 'team', now)
      }

      // Mark invite accepted. The WHERE clause includes status='pending'
      // so a concurrent accept (rare; we're already in a tx) gets
      // changes=0 and we abort.
      const upd = this.stmtMarkInvitationAccepted.run(now, userId, row.id)
      if (upd.changes === 0) {
        throw new IdentityError({
          code: 'invitation_already_used',
          message: 'invitation already accepted (concurrent)',
        })
      }

      // Mint session inline (avoid calling beginSession — we already
      // know everything and we're inside a transaction; nesting
      // transaction() calls is fine but the inline form is clearer).
      const sessionToken = newSessionToken()
      const sessionExpiresAt = now + ttl
      this.stmtInsertSession.run(
        sessionToken,
        userId,
        sessionExpiresAt,
        now,
        now,
      )
      this.stmtUpdateLastLogin.run(now, userId)

      const invitation: Invitation = {
        id: row.id,
        email: row.email,
        role,
        invitedBy: row.invited_by,
        displayName: row.display_name,
        expiresAt: row.expires_at,
        status: 'accepted',
        createdAt: row.created_at,
        acceptedAt: now,
        acceptedUserId: userId,
      }
      const user: User = {
        id: userId,
        email: row.email,
        displayName,
        createdAt: now,
        lastLoginAt: now,
      }
      const session: Session = {
        token: sessionToken,
        userId,
        expiresAt: sessionExpiresAt,
        createdAt: now,
        lastSeenAt: now,
      }
      return { user, session, invitation }
    })
  }

  listInvitations(query: ListInvitationsQuery = {}): Invitation[] {
    const limit = Math.max(1, Math.min(500, query.limit ?? 100))
    const offset = Math.max(0, query.offset ?? 0)
    const now = Date.now()

    const where: string[] = []
    const params: (string | number)[] = []

    if (query.email !== undefined) {
      where.push('email = ?')
      params.push(normaliseEmail(query.email))
    }
    // Status filter has to handle 'pending' / 'expired' specially since
    // 'expired' is computed, not stored:
    //   - filter pending → stored='pending' AND expires_at >= now
    //   - filter expired → stored='pending' AND expires_at <  now
    //   - filter accepted/revoked → straight equality on the column
    if (query.status !== undefined) {
      if (!isInvitationStatus(query.status)) {
        throw new IdentityError({
          code: 'invalid_input',
          message: `invalid status filter: ${JSON.stringify(query.status)}`,
        })
      }
      switch (query.status) {
        case 'pending':
          where.push(`status = 'pending' AND expires_at >= ?`)
          params.push(now)
          break
        case 'expired':
          where.push(`status = 'pending' AND expires_at < ?`)
          params.push(now)
          break
        case 'accepted':
          where.push(`status = 'accepted'`)
          break
        case 'revoked':
          where.push(`status = 'revoked'`)
          break
      }
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    // rowid tie-breaker — see listAuditLog for the rationale.
    const sql = `SELECT * FROM invitations ${whereSql} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`
    params.push(limit, offset)
    const rows = this.db.prepare(sql).all(...params) as InvitationRow[]
    return rows.map((r) => rowToInvitation(r, now))
  }

  /**
   * Phase 6 #9 — count active-pending invites (status='pending' AND
   * expires_at >= now). Same predicate as the createInvitation cap
   * check; exposed publicly for admin UI / dashboards / tests so
   * operators can see "we're at 950/1000" before the cap fires.
   */
  countActivePendingInvitations(now: number = Date.now()): number {
    const row = this.stmtInvitationCountActivePending.get(now) as
      | { c: number }
      | undefined
    return row?.c ?? 0
  }

  /**
   * Cancel a pending invite. Idempotent on terminal states — if the
   * invite is already accepted or revoked, returns the row unchanged
   * (no error). Throws invitation_not_found only if no such id exists.
   */
  revokeInvitation(invitationId: string): Invitation {
    if (typeof invitationId !== 'string' || invitationId.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'invitationId required',
      })
    }
    return transaction(this.db, () => {
      const row = this.stmtInvitationById.get(invitationId) as
        | InvitationRow
        | undefined
      if (!row) {
        throw new IdentityError({
          code: 'invitation_not_found',
          message: `invitation not found: ${invitationId}`,
        })
      }
      const now = Date.now()
      const effective = computeInvitationStatus(row.status, row.expires_at, now)
      if (effective === 'accepted') {
        // Accepted invites can't be revoked — that would mean
        // revoking a real user account. Refuse loudly so the caller
        // doesn't think their click did something.
        throw new IdentityError({
          code: 'invitation_already_used',
          message: 'cannot revoke an already-accepted invitation',
        })
      }
      // Pending OR expired OR revoked: in all cases we mark the column
      // 'revoked' so it stops showing in the pending list. Guarded
      // UPDATE with status='pending' means we only mutate when the
      // column is actually 'pending'; revoking an already-revoked or
      // already-expired-but-stored-as-pending row is a no-op or a
      // flip-to-revoked respectively.
      this.stmtMarkInvitationRevoked.run(invitationId)
      // Re-read to return the post-state.
      const after = this.stmtInvitationById.get(invitationId) as InvitationRow
      return rowToInvitation(after, now)
    })
  }

  // =====================================================================
  // Vault (A1 — Phase 5 encrypted secret storage) — extracted to VaultStore
  //
  // R13 — the implementation (encryption, prepared statements, mutation
  // listeners, masterKey gating) moved to vault-store.ts. These thin
  // forwarders keep IdentityStore's public surface unchanged; see
  // VaultStore for the full design notes.
  // =====================================================================

  createVaultEntry(input: CreateVaultEntryInput): VaultEntry {
    return this.vault.createVaultEntry(input)
  }

  getVaultEntry(id: string): VaultEntry | null {
    return this.vault.getVaultEntry(id)
  }

  readVaultSecret(id: string): string {
    return this.vault.readVaultSecret(id)
  }

  revokeVaultEntry(id: string): boolean {
    return this.vault.revokeVaultEntry(id)
  }

  listVaultEntries(query: ListVaultEntriesQuery = {}): VaultEntry[] {
    return this.vault.listVaultEntries(query)
  }

  onVaultMutation(fn: (reason: VaultMutationReason) => void): () => void {
    return this.vault.onVaultMutation(fn)
  }

  // =====================================================================
  // D1 (v4 Phase 5) — Peer Registry
  //
  // CRUD for the `peers` table + token decryption helper. The shared
  // HELLO secret lives in `vault` (kind='peer_token', ownerKind='peer');
  // peers.vault_entry_id holds the soft FK. Token rotation is atomic:
  // updatePeer({peerToken}) revokes the old vault row and creates a
  // fresh one inside one transaction, so a partial failure can't leave
  // the peer row pointing at a revoked entry.
  //
  // PeerRegistration is the projection the host's PeerRegistry reads
  // on every 5s tick; getPeerToken() is the slow-path decrypt call
  // it makes lazily when connecting a fresh outbound HubLink.
  // =====================================================================

  /**
   * Add a peer registration. Stores `peerToken` encrypted in vault and
   * inserts the peers row in one transaction. Throws `peer_id_taken`
   * when another row already uses the same `peerId` (the SQLite UNIQUE
   * constraint on `peer_id`).
   *
   * Caller is the only one with the plaintext token after this call —
   * subsequent reads via getPeer / listPeers do NOT return it. To
   * recover the token on demand (PeerRegistry connecting an outbound
   * link), call `getPeerToken(peerRowId)`.
   */
  addPeer(input: AddPeerInput): PeerRegistration {
    assertNonEmptyId(input?.peerId, 'peerId')
    if (typeof input?.endpointUrl !== 'string' || input.endpointUrl.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'addPeer: endpointUrl must be a non-empty string',
      })
    }
    if (typeof input?.peerToken !== 'string' || input.peerToken.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'addPeer: peerToken must be a non-empty string',
      })
    }
    return transaction(this.db, () => {
      const vaultRow = this.createVaultEntry({
        kind: 'peer_token',
        ownerKind: 'peer',
        ownerId: input.peerId,
        secret: input.peerToken,
        ...(input.label ? { label: input.label } : {}),
      })
      const id = newId()
      const now = Date.now()
      try {
        this.stmtPeerInsert.run(
          id,
          input.peerId,
          input.endpointUrl,
          input.label ?? null,
          1,
          vaultRow.id,
          now,
          now,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/UNIQUE.*peer_id/i.test(msg)) {
          throw new IdentityError({
            code: 'peer_id_taken',
            message: `addPeer: peerId '${input.peerId}' already registered`,
          })
        }
        throw err
      }
      const row = this.stmtPeerById.get(id) as PeerRow
      return rowToPeerRegistration(row)
    })
  }

  getPeer(id: string): PeerRegistration | null {
    const row = this.stmtPeerById.get(id) as PeerRow | undefined
    return row ? rowToPeerRegistration(row) : null
  }

  getPeerByPeerId(peerId: string): PeerRegistration | null {
    const row = this.stmtPeerByPeerId.get(peerId) as PeerRow | undefined
    return row ? rowToPeerRegistration(row) : null
  }

  listPeers(query: ListPeersQuery = {}): PeerRegistration[] {
    const rows = (query.enabledOnly
      ? this.stmtPeerListEnabled.all()
      : this.stmtPeerListAll.all()) as PeerRow[]
    return rows.map(rowToPeerRegistration)
  }

  /**
   * Update mutable fields on a peer row. If `peerToken` is provided,
   * revokes the old vault entry and creates a fresh one — the row's
   * `vaultEntryId` is updated to the new entry inside the same
   * transaction. Returns the updated row. Throws `peer_not_found` if
   * the row vanished mid-call.
   */
  updatePeer(id: string, input: UpdatePeerInput): PeerRegistration {
    const existing = this.stmtPeerById.get(id) as PeerRow | undefined
    if (!existing) {
      throw new IdentityError({
        code: 'peer_not_found',
        message: `updatePeer: no peer row with id '${id}'`,
      })
    }
    return transaction(this.db, () => {
      let vaultEntryId = existing.vault_entry_id
      if (typeof input.peerToken === 'string' && input.peerToken.length > 0) {
        // Rotate: revoke old, create fresh. The old row stays in vault
        // (soft-delete) so an audit trail of "this token was active
        // from X to Y" survives.
        this.revokeVaultEntry(existing.vault_entry_id)
        const fresh = this.createVaultEntry({
          kind: 'peer_token',
          ownerKind: 'peer',
          ownerId: existing.peer_id,
          secret: input.peerToken,
          ...(existing.label ? { label: existing.label } : {}),
        })
        vaultEntryId = fresh.id
      }
      const label =
        input.label !== undefined ? input.label : existing.label
      const enabled =
        input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled
      const endpointUrl =
        typeof input.endpointUrl === 'string' && input.endpointUrl.length > 0
          ? input.endpointUrl
          : existing.endpoint_url
      this.stmtPeerUpdate.run(
        endpointUrl,
        label,
        enabled,
        vaultEntryId,
        Date.now(),
        id,
      )
      const row = this.stmtPeerById.get(id) as PeerRow
      return rowToPeerRegistration(row)
    })
  }

  /**
   * Hard-delete the peer row AND revoke its vault entry. After this,
   * the (peerId, endpoint) pair is free for re-registration.
   * Returns true if a row was actually removed, false if id was unknown.
   */
  removePeer(id: string): boolean {
    const existing = this.stmtPeerById.get(id) as PeerRow | undefined
    if (!existing) return false
    transaction(this.db, () => {
      this.revokeVaultEntry(existing.vault_entry_id)
      this.stmtPeerDelete.run(id)
    })
    return true
  }

  /**
   * Decrypt and return the peer's shared HELLO secret. Throws
   * `peer_not_found` if the row vanished. Returns the plaintext —
   * caller must not log it.
   */
  getPeerToken(id: string): string {
    const existing = this.stmtPeerById.get(id) as PeerRow | undefined
    if (!existing) {
      throw new IdentityError({
        code: 'peer_not_found',
        message: `getPeerToken: no peer row with id '${id}'`,
      })
    }
    return this.readVaultSecret(existing.vault_entry_id)
  }

  // ---- Peer prepared statement getters (lazy, mirrors vault) ----

  private get stmtPeerInsert(): SqliteStmt {
    return (this._stmtPeerInsert ??= this.db.prepare(
      `INSERT INTO peers(
         id, peer_id, endpoint_url, label, enabled, vault_entry_id,
         created_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    ))
  }
  private get stmtPeerById(): SqliteStmt {
    return (this._stmtPeerById ??= this.db.prepare(
      'SELECT * FROM peers WHERE id = ?',
    ))
  }
  private get stmtPeerByPeerId(): SqliteStmt {
    return (this._stmtPeerByPeerId ??= this.db.prepare(
      'SELECT * FROM peers WHERE peer_id = ?',
    ))
  }
  private get stmtPeerListAll(): SqliteStmt {
    return (this._stmtPeerListAll ??= this.db.prepare(
      'SELECT * FROM peers ORDER BY created_at',
    ))
  }
  private get stmtPeerListEnabled(): SqliteStmt {
    return (this._stmtPeerListEnabled ??= this.db.prepare(
      'SELECT * FROM peers WHERE enabled = 1 ORDER BY created_at',
    ))
  }
  private get stmtPeerUpdate(): SqliteStmt {
    return (this._stmtPeerUpdate ??= this.db.prepare(
      `UPDATE peers
         SET endpoint_url = ?, label = ?, enabled = ?, vault_entry_id = ?,
             updated_at = ?
       WHERE id = ?`,
    ))
  }
  private get stmtPeerDelete(): SqliteStmt {
    return (this._stmtPeerDelete ??= this.db.prepare(
      'DELETE FROM peers WHERE id = ?',
    ))
  }

  // =====================================================================
  // B2.1 — Usage counters (per-user quota tracking)
  // =====================================================================

  /**
   * Set, update, or clear the quota cap for a (user, metric, period)
   * tuple. The row is created if absent (with `used=0`,
   * `periodStart=periodStartFor(period, now)`). Existing rows keep
   * their current `used` / `periodStart` — changing the cap MUST NOT
   * silently reset accumulated usage (an admin who raises someone's
   * daily limit doesn't want to give them a fresh day).
   *
   * Pass `quota=null` to remove the cap (counter still ticks for
   * visibility / future re-enablement).
   */
  setQuota(input: SetQuotaInput, now: number = Date.now()): UsageCounter {
    assertUsageMetric(input?.metric)
    assertUsagePeriod(input?.period)
    assertNonEmptyId(input?.userId, 'userId')
    if (input.quota !== null) {
      if (
        typeof input.quota !== 'number' ||
        !Number.isFinite(input.quota) ||
        !Number.isInteger(input.quota) ||
        input.quota < 0
      ) {
        throw new IdentityError({
          code: 'invalid_input',
          message: `setQuota: quota must be null or a non-negative integer; got ${input.quota}`,
        })
      }
    }
    const periodStart = periodStartFor(input.period, now)
    this.stmtUsageUpsert.run(
      input.userId,
      input.metric,
      input.period,
      periodStart,
      0,           // used — only honoured when INSERT (UPSERT updates only quota+updated_at)
      input.quota,
      now,
    )
    const row = this.stmtUsageGet.get(
      input.userId,
      input.metric,
      input.period,
    ) as UsageCounterRow | undefined
    if (!row) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `setQuota: upsert succeeded but read-back returned nothing for ${input.userId}/${input.metric}/${input.period}`,
      })
    }
    return rowToUsageCounter(row)
  }

  /**
   * Read counters. Filter by `metric` and / or `period`; omit either
   * to broaden the result. Does NOT auto-roll stale period rows —
   * read-only. Callers wanting the post-roll value for a single
   * counter should use {@link checkAndIncrement} with `amount=0` (an
   * idempotent peek that does trigger the roll).
   */
  listUsage(query: GetUsageQuery): UsageCounter[] {
    assertNonEmptyId(query?.userId, 'userId')
    let rows: UsageCounterRow[]
    if (query.metric !== undefined && query.period !== undefined) {
      assertUsageMetric(query.metric)
      assertUsagePeriod(query.period)
      rows = this.stmtUsageListByTriple.all(
        query.userId,
        query.metric,
        query.period,
      ) as UsageCounterRow[]
    } else if (query.metric !== undefined) {
      assertUsageMetric(query.metric)
      rows = this.stmtUsageListByUserMetric.all(
        query.userId,
        query.metric,
      ) as UsageCounterRow[]
    } else if (query.period !== undefined) {
      assertUsagePeriod(query.period)
      rows = this.stmtUsageListByUserPeriod.all(
        query.userId,
        query.period,
      ) as UsageCounterRow[]
    } else {
      rows = this.stmtUsageListByUser.all(query.userId) as UsageCounterRow[]
    }
    return rows.map(rowToUsageCounter)
  }

  /**
   * Atomic peek-roll-check-increment, inside a single transaction.
   *
   *   1. Read the (user, metric, period) row. Missing → treat as
   *      `used=0, quota=null, periodStart=periodStartFor(period, now)`.
   *   2. If the row's `periodStart` doesn't match the current
   *      period's boundary, ROLL: `used=0`, `periodStart=current`.
   *   3. If `quota !== null` and `used + amount > quota`, return
   *      `{allowed: false, counter, exceededBy}`. The row is still
   *      written (the roll, if any) but `used` is NOT incremented.
   *   4. Otherwise increment `used += amount`, write, return
   *      `{allowed: true, counter}`.
   *
   * `amount=0` is a "peek-and-roll" — won't trip a quota check, but
   * will still roll an expired period so the returned counter is
   * current.
   */
  checkAndIncrement(input: CheckAndIncrementInput): CheckAndIncrementResult {
    assertNonEmptyId(input?.userId, 'userId')
    assertUsageMetric(input?.metric)
    assertUsagePeriod(input?.period)
    const amount = input.amount ?? 1
    if (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      !Number.isInteger(amount) ||
      amount < 0
    ) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `checkAndIncrement: amount must be a non-negative integer; got ${amount}`,
      })
    }
    const now = input.now ?? Date.now()
    const expectedStart = periodStartFor(input.period, now)

    return transaction(this.db, () => {
      const existing = this.stmtUsageGet.get(
        input.userId,
        input.metric,
        input.period,
      ) as UsageCounterRow | undefined

      // Row state going into the check. We compute what the row WILL
      // look like before deciding allow/deny.
      const currentUsed =
        existing && existing.period_start === expectedStart
          ? existing.used
          : 0 // missing row OR period rolled → effective used=0
      const quota = existing ? existing.quota : null

      // Quota check first — we still write the roll if the period
      // expired, but we DON'T commit the increment.
      const wouldBe = currentUsed + amount
      const allowed = quota === null || wouldBe <= quota
      const finalUsed = allowed ? wouldBe : currentUsed

      if (!existing) {
        // Fresh row. Quota stays null (set via setQuota). period_start
        // is the current boundary.
        this.stmtUsageUpsert.run(
          input.userId,
          input.metric,
          input.period,
          expectedStart,
          finalUsed,
          null,
          now,
        )
      } else {
        // Existing row — UPDATE used + period_start + updated_at.
        // Quota is preserved (we never touch it from this method).
        this.stmtUsageUpdate.run(
          finalUsed,
          expectedStart,
          now,
          input.userId,
          input.metric,
          input.period,
        )
      }

      const row = this.stmtUsageGet.get(
        input.userId,
        input.metric,
        input.period,
      ) as UsageCounterRow
      const counter = rowToUsageCounter(row)
      if (!allowed) {
        return {
          allowed: false,
          counter,
          exceededBy: wouldBe - (quota as number),
        }
      }
      return { allowed: true, counter }
    })
  }

  /**
   * Manually zero the counter and start a fresh period. Useful for
   * admin "give this user their day back" / "they got hit by a runaway
   * loop, refund the usage" actions. Returns `null` when no row
   * existed (admins shouldn't get a false "reset" confirmation for a
   * counter that was never touched).
   */
  resetUsage(input: ResetUsageInput): UsageCounter | null {
    assertNonEmptyId(input?.userId, 'userId')
    assertUsageMetric(input?.metric)
    assertUsagePeriod(input?.period)
    const now = input.now ?? Date.now()
    const existing = this.stmtUsageGet.get(
      input.userId,
      input.metric,
      input.period,
    ) as UsageCounterRow | undefined
    if (!existing) return null
    this.stmtUsageUpdate.run(
      0,
      periodStartFor(input.period, now),
      now,
      input.userId,
      input.metric,
      input.period,
    )
    const row = this.stmtUsageGet.get(
      input.userId,
      input.metric,
      input.period,
    ) as UsageCounterRow
    return rowToUsageCounter(row)
  }

  /**
   * B2.3 — background hygiene sweep. For every `hourly` / `daily` /
   * `monthly` row whose stored `period_start` lies in a *prior* period
   * relative to `now`, advance `period_start` to the current boundary
   * and reset `used = 0`. `'total'` rows are never swept (lifetime
   * counters; sentinel `period_start = 0`).
   *
   * Why we still need this when `checkAndIncrement` already auto-rolls
   * on every call:
   *
   *   - `listUsage` does NOT roll (it's read-only by contract). Without
   *     the sweep, an admin opening the usage dashboard at 09:00 for a
   *     user who burned 100/100 yesterday and hasn't dispatched since
   *     would see `used=100, periodStart=<yesterday>` — confusing.
   *     Post-sweep they see `used=0, periodStart=<today>`.
   *   - Metrics that go inactive (a user stopped using a feature) would
   *     otherwise drift indefinitely with stale `period_start`. This
   *     also matters for E1 (per-org aggregation) — sum across
   *     `used` makes sense only if every row's period_start is current.
   *
   * Runs the three period UPDATEs in a single transaction. Each
   * statement is constrained by `period_start < ?` (strict) so a
   * clock skew that briefly pulls `now` backwards never rewrites a
   * row to an earlier boundary. Returns counts for diagnostics.
   */
  sweepUsageCounters(now: number = Date.now()): SweepUsageResult {
    return transaction(this.db, () => {
      const byPeriod = { hourly: 0, daily: 0, monthly: 0 }
      for (const period of ['hourly', 'daily', 'monthly'] as const) {
        const boundary = periodStartFor(period, now)
        const r = this.stmtUsageSweep.run(boundary, now, period, boundary)
        byPeriod[period] = Number(r.changes)
      }
      return {
        rolled: byPeriod.hourly + byPeriod.daily + byPeriod.monthly,
        byPeriod,
      }
    })
  }

  // =====================================================================
  // E1 — Per-org aggregation + soft quotas
  // =====================================================================

  /**
   * Aggregate `used` across ALL users for one (metric, period). For
   * non-`'total'` periods, only rows whose `period_start` matches the
   * current period boundary contribute — stale-but-unswept rows count
   * as zero (the `sweepUsageCounters` 1h tick keeps them current; we
   * don't want yesterday's usage padding today's number in case the
   * sweep is a few seconds late or skipped).
   *
   * Test code should pass `now` explicitly to align with whatever the
   * checkAndIncrement test calls used.
   */
  sumUsage(metric: string, period: UsagePeriod, now: number = Date.now()): number {
    assertUsageMetric(metric)
    assertUsagePeriod(period)
    if (period === 'total') {
      const r = this.stmtSumUsageTotal.get(metric) as { s: number }
      return Number(r.s)
    }
    const boundary = periodStartFor(period, now)
    const r = this.stmtSumUsageCurrent.get(metric, period, boundary) as { s: number }
    return Number(r.s)
  }

  /**
   * Create or update an org-level soft cap for a (metric, period) tuple.
   * `quota` is a required non-negative integer ("unlimited" is the
   * absence of a row — use {@link deleteOrgQuota}). `warnPct` defaults
   * to 80 on first create; omitting on update preserves the existing
   * value.
   *
   * The transition tracker (`lastState`, `lastChecked`) is NOT reset on
   * update — re-issuing a cap for an already-warning quota shouldn't
   * cause the next `checkOrgQuotaThreshold` to spuriously emit a
   * "warning resolved" then "warning re-opened" pair.
   */
  setOrgQuota(input: SetOrgQuotaInput, now: number = Date.now()): OrgQuota {
    assertUsageMetric(input?.metric)
    assertUsagePeriod(input?.period)
    if (
      typeof input.quota !== 'number' ||
      !Number.isFinite(input.quota) ||
      !Number.isInteger(input.quota) ||
      input.quota < 0
    ) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `setOrgQuota: quota must be a non-negative integer; got ${input.quota}`,
      })
    }
    // warn_pct constraint: integer in [1, 99]. 0 / 100 would degenerate
    // the state machine — at 0 every check is 'warn'; at 100 'warn' is
    // unreachable (you'd jump straight to 'over').
    let warnPct = 80
    if (input.warnPct !== undefined) {
      if (
        typeof input.warnPct !== 'number' ||
        !Number.isInteger(input.warnPct) ||
        input.warnPct < 1 ||
        input.warnPct > 99
      ) {
        throw new IdentityError({
          code: 'invalid_input',
          message: `setOrgQuota: warnPct must be an integer in [1, 99]; got ${input.warnPct}`,
        })
      }
      warnPct = input.warnPct
    } else {
      // Preserve existing warnPct on update if caller omitted it.
      const existing = this.stmtOrgQuotaGet.get(input.metric, input.period) as
        | OrgQuotaRow
        | undefined
      if (existing) warnPct = existing.warn_pct
    }
    this.stmtOrgQuotaUpsert.run(
      input.metric,
      input.period,
      input.quota,
      warnPct,
      now, // created_at — UPSERT keeps the existing value on conflict
      now, // updated_at
    )
    const row = this.stmtOrgQuotaGet.get(input.metric, input.period) as OrgQuotaRow
    return rowToOrgQuota(row)
  }

  /** Returns `null` when no row exists for the tuple. */
  getOrgQuota(metric: string, period: UsagePeriod): OrgQuota | null {
    assertUsageMetric(metric)
    assertUsagePeriod(period)
    const row = this.stmtOrgQuotaGet.get(metric, period) as OrgQuotaRow | undefined
    return row ? rowToOrgQuota(row) : null
  }

  /** All configured org quotas (admin UI list view). Ordered by (metric, period). */
  listOrgQuotas(): OrgQuota[] {
    const rows = this.stmtOrgQuotaList.all() as OrgQuotaRow[]
    return rows.map(rowToOrgQuota)
  }

  /**
   * Remove the soft cap for (metric, period). Returns `true` when a row
   * was deleted, `false` when nothing was there to delete (idempotent
   * for admin tooling — no need to check first).
   */
  deleteOrgQuota(metric: string, period: UsagePeriod): boolean {
    assertUsageMetric(metric)
    assertUsagePeriod(period)
    const r = this.stmtOrgQuotaDelete.run(metric, period)
    return Number(r.changes) > 0
  }

  /**
   * The host-side decision point. Reads the org quota + the current
   * aggregate usage, computes the state, compares against `lastState`,
   * and ATOMICALLY updates `lastState` / `lastChecked` to the new value
   * inside one transaction.
   *
   * Returns `transitioned=true` exactly when the state changed — the
   * host's orgQuotaSweep keys on this to decide whether to emit an
   * audit_log entry. Repeated checks at the same state are silent.
   *
   * Throws `org_quota_not_found` when no quota is configured for the
   * tuple — callers are expected to iterate `listOrgQuotas()` and only
   * check tuples that are configured.
   */
  checkOrgQuotaThreshold(
    metric: string,
    period: UsagePeriod,
    now: number = Date.now(),
  ): CheckOrgQuotaResult {
    assertUsageMetric(metric)
    assertUsagePeriod(period)
    return transaction(this.db, () => {
      const row = this.stmtOrgQuotaGet.get(metric, period) as OrgQuotaRow | undefined
      if (!row) {
        throw new IdentityError({
          code: 'org_quota_not_found',
          message: `checkOrgQuotaThreshold: no quota configured for ${metric}/${period}`,
        })
      }
      const usage = period === 'total'
        ? Number((this.stmtSumUsageTotal.get(metric) as { s: number }).s)
        : Number(
            (this.stmtSumUsageCurrent.get(
              metric,
              period,
              periodStartFor(period, now),
            ) as { s: number }).s,
          )

      // quota=0 is a degenerate but legal config ("nobody should call this
      // metric") — guard against /0. Any usage ≥ 0 with quota=0 is 'over'
      // unless usage is also 0 in which case it's 'ok' (vacuous truth).
      let pct: number
      let state: OrgQuotaState
      if (row.quota === 0) {
        pct = usage === 0 ? 0 : 999
        state = usage === 0 ? 'ok' : 'over'
      } else {
        pct = Math.min(999, Math.floor((usage / row.quota) * 100))
        if (pct >= 100) state = 'over'
        else if (pct >= row.warn_pct) state = 'warn'
        else state = 'ok'
      }

      const previousState = row.last_state as OrgQuotaState
      const transitioned = state !== previousState
      // Always touch last_checked (operator diagnostic). Only the state
      // column flips on transition, but `last_checked` updates every call.
      this.stmtOrgQuotaTouchState.run(state, now, now, metric, period)

      return {
        metric,
        period,
        quota: row.quota,
        warnPct: row.warn_pct,
        usage,
        pct,
        state,
        previousState,
        transitioned,
      }
    })
  }

  // =====================================================================
  // Phase 11 M2 — Suspended tasks (long-running agent park/resume).
  // =====================================================================

  /**
   * Persist a suspended-task row. Called by the scheduler's
   * `notifySuspend` callback when a participant throws
   * `SuspendTaskError`. `INSERT OR REPLACE` semantics: if the same
   * `taskId` is already parked (e.g. a `handleResume` re-suspended),
   * the row is overwritten with the new state and resumeAt.
   *
   * `state` is `JSON.stringify`d. `taskJson` is stored verbatim — the
   * caller (host wiring) is responsible for producing it.
   */
  persistSuspendedTask(input: PersistSuspendedTaskInput): void {
    if (!input || typeof input.taskId !== 'string' || input.taskId.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'persistSuspendedTask: taskId is required',
      })
    }
    if (typeof input.agentId !== 'string' || input.agentId.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'persistSuspendedTask: agentId is required',
      })
    }
    if (typeof input.resumeAt !== 'number' || !Number.isFinite(input.resumeAt)) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `persistSuspendedTask: resumeAt must be a finite number; got ${input.resumeAt}`,
      })
    }
    if (typeof input.taskJson !== 'string') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'persistSuspendedTask: taskJson must be a JSON string',
      })
    }
    // state can be undefined / null / any JSON-serialisable value.
    // We persist `null` for "absent" so the read side has a single
    // sentinel, and JSON-stringify everything else. A circular ref
    // here is a programmer error; let JSON.stringify throw and the
    // scheduler's catch will turn it into a `failed` result.
    const stateJson =
      input.state === undefined ? null : JSON.stringify(input.state)
    this.stmtSuspendInsert.run(
      input.taskId,
      input.agentId,
      input.hubId ?? null,
      input.originUserId ?? null,
      input.resumeAt,
      stateJson,
      input.taskJson,
      Date.now(),
    )
  }

  /**
   * Remove a parked row. Called by the resume sweep (M3) once the
   * task has been successfully re-dispatched and either resolved or
   * re-suspended (which itself wrote a fresh row via INSERT OR
   * REPLACE — so the delete is harmless in that case too, just races
   * the upsert).
   *
   * Returns the number of rows removed (0 or 1) so callers can
   * detect "already gone" races.
   */
  removeSuspendedTask(taskId: string): number {
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'removeSuspendedTask: taskId is required',
      })
    }
    const info = this.stmtSuspendDelete.run(taskId)
    return Number(info.changes)
  }

  /** Read a single suspended-task row by taskId. Returns null when absent. */
  getSuspendedTask(taskId: string): SuspendedTask | null {
    if (typeof taskId !== 'string' || taskId.length === 0) return null
    const row = this.stmtSuspendGetById.get(taskId) as
      | SuspendedTaskRow
      | undefined
    return row ? rowToSuspendedTask(row) : null
  }

  /**
   * List rows whose `resume_at <= now`, ordered by `resume_at ASC`
   * (oldest-due first). The resume sweep iterates this list and
   * re-dispatches each task. `limit` (default 100) bounds the batch
   * so a long sleep period doesn't return thousands of rows at once.
   */
  listDueSuspendedTasks(query: ListDueSuspendedTasksQuery = {}): SuspendedTask[] {
    const now = query.now ?? Date.now()
    const limit = query.limit ?? 100
    if (!Number.isFinite(now) || !Number.isFinite(limit) || limit < 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `listDueSuspendedTasks: invalid now=${now} or limit=${limit}`,
      })
    }
    const rows = this.stmtSuspendListDue.all(now, limit) as SuspendedTaskRow[]
    return rows.map(rowToSuspendedTask)
  }

  /**
   * Diagnostic: list all parked tasks for a single agent, oldest-due
   * first. Not used by the runtime path; exposed for admin UI
   * surfaces ("what's this agent waiting on?") and tests.
   */
  listSuspendedTasksByAgent(agentId: string): SuspendedTask[] {
    if (typeof agentId !== 'string' || agentId.length === 0) return []
    const rows = this.stmtSuspendListByAgent.all(agentId) as SuspendedTaskRow[]
    return rows.map(rowToSuspendedTask)
  }

  // =====================================================================
  // Phase 12 M1 — IM bindings.
  // =====================================================================

  /**
   * Mint a fresh binding code for a logged-in user. The admin UI calls
   * this when the user clicks "Bind IM" / "Connect Telegram"; the
   * resulting `code` is displayed to the user, who types it into the IM
   * client.
   *
   * Atomic semantics: any prior outstanding code for the same userId
   * is deleted in the same transaction before the new code is
   * inserted. This means a leaked stale code stops working the moment
   * the user re-issues, even if the user never typed it into an IM
   * client (e.g. they walked away from the screen).
   *
   * Collision handling: when minting auto-codes (caller didn't pass
   * `input.code`), we retry up to 5 times on PK conflict. With ~1M
   * code space and the rotate-on-issue policy, the realistic outstanding
   * population is ≤ user-count; collision probability per insert is
   * tiny. After 5 tries we throw `invalid_input` — operator should
   * widen the code space (future) rather than silently degrade.
   *
   * Explicit-code path (caller passed `input.code`): no retry; an
   * explicit code that collides with another user's pending code is a
   * caller bug. UNIQUE constraint throws and we surface it.
   */
  issueImBindingCode(input: IssueImBindingCodeInput): ImBindingCode {
    if (!input || typeof input.userId !== 'string' || input.userId.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'issueImBindingCode: userId is required',
      })
    }
    // verify user exists — otherwise FK on REFERENCES users(id) would
    // throw at INSERT time with a less helpful error.
    const user = this.stmtUserById.get(input.userId) as { id: string } | undefined
    if (!user) {
      throw new IdentityError({
        code: 'user_not_found',
        message: `issueImBindingCode: user ${input.userId} not found`,
      })
    }
    // TTL clamp — see IssueImBindingCodeInput doc for bounds rationale.
    const rawTtl = input.ttlMs ?? 10 * 60_000
    if (typeof rawTtl !== 'number' || !Number.isFinite(rawTtl)) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `issueImBindingCode: ttlMs must be a finite number; got ${rawTtl}`,
      })
    }
    const ttlMs = Math.max(60_000, Math.min(3_600_000, Math.floor(rawTtl)))
    const now = Date.now()
    const expiresAt = now + ttlMs

    // Validate explicit code shape if supplied.
    if (input.code !== undefined) {
      if (
        typeof input.code !== 'string' ||
        !/^[A-Za-z0-9]{4,32}$/.test(input.code)
      ) {
        throw new IdentityError({
          code: 'invalid_input',
          message:
            'issueImBindingCode: code must be 4-32 chars of [A-Za-z0-9] when supplied',
        })
      }
    }

    return transaction(this.db, () => {
      this.stmtImBindingCodeDeleteByUser.run(input.userId)
      if (input.code !== undefined) {
        // Explicit-code path: single try, surface PK collisions as
        // invalid_input so the caller can pick a different code.
        try {
          this.stmtImBindingCodeInsert.run(input.code, input.userId, expiresAt, now)
        } catch (err) {
          throw new IdentityError({
            code: 'invalid_input',
            message: `issueImBindingCode: explicit code conflict (${(err as Error).message})`,
            cause: err,
          })
        }
        return {
          code: input.code,
          userId: input.userId,
          expiresAt,
          createdAt: now,
        }
      }
      // Auto-mint path: retry on PK collision up to 5 times.
      for (let i = 0; i < 5; i++) {
        const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
        try {
          this.stmtImBindingCodeInsert.run(code, input.userId, expiresAt, now)
          return { code, userId: input.userId, expiresAt, createdAt: now }
        } catch (err) {
          // Re-throw anything that isn't a unique-constraint conflict;
          // PK collision is the only retryable condition. SQLite raises
          // a SQLITE_CONSTRAINT_PRIMARYKEY error here (code 1555).
          const msg = (err as Error).message ?? ''
          if (!msg.includes('UNIQUE')) throw err
        }
      }
      throw new IdentityError({
        code: 'invalid_input',
        message:
          'issueImBindingCode: 5 random codes all collided — widen code space or sweep',
      })
    })
  }

  /**
   * Verify + consume a binding code. Called by an IM bridge when its
   * user DMs the bot `/bind <code>`. On success: deletes the code row
   * (single-shot) and creates/updates the `im_bindings` row in the
   * same transaction; returns the resolved AipeHub user id + binding.
   *
   * Failure modes (each throws an IdentityError with a distinct code):
   *   - `invalid_input` — empty / wrong-shape platform/platformUserId/code
   *   - `im_binding_code_invalid` — no row matches the supplied code
   *   - `im_binding_code_expired` — row found but `expires_at < now`.
   *     The row is NOT auto-deleted here (it would fight the rollback
   *     on the rethrown error). The next `issueImBindingCode` for the
   *     same user OR the periodic `sweepExpiredImBindingCodes` cleans
   *     it up — bounded latency, no race.
   */
  claimImBindingCode(input: ClaimImBindingCodeInput): ClaimImBindingResult {
    if (!input || typeof input.code !== 'string' || input.code.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'claimImBindingCode: code is required',
      })
    }
    if (typeof input.platform !== 'string' || input.platform.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'claimImBindingCode: platform is required',
      })
    }
    if (
      typeof input.platformUserId !== 'string' ||
      input.platformUserId.length === 0
    ) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'claimImBindingCode: platformUserId is required',
      })
    }
    if (input.displayName !== undefined && input.displayName !== null) {
      if (typeof input.displayName !== 'string') {
        throw new IdentityError({
          code: 'invalid_input',
          message: 'claimImBindingCode: displayName must be string or null',
        })
      }
    }
    return transaction(this.db, () => {
      const row = this.stmtImBindingCodeGetByCode.get(input.code) as
        | { code: string; user_id: string; expires_at: number; created_at: number }
        | undefined
      if (!row) {
        throw new IdentityError({
          code: 'im_binding_code_invalid',
          message: 'claimImBindingCode: code does not exist',
        })
      }
      const now = Date.now()
      if (row.expires_at < now) {
        // Don't DELETE here — the surrounding transaction would roll
        // it back when we re-throw. The expired row lingers until the
        // next reissue (which does DELETE-by-user before INSERT) or
        // sweepExpiredImBindingCodes. Bounded; no race.
        throw new IdentityError({
          code: 'im_binding_code_expired',
          message: `claimImBindingCode: code expired at ${new Date(row.expires_at).toISOString()}`,
        })
      }
      // Consume + bind.
      this.stmtImBindingCodeDeleteByCode.run(input.code)
      const displayName = input.displayName ?? null
      this.stmtImBindingInsert.run(
        input.platform,
        input.platformUserId,
        row.user_id,
        displayName,
        now,
      )
      return {
        userId: row.user_id,
        binding: {
          platform: input.platform,
          platformUserId: input.platformUserId,
          userId: row.user_id,
          displayName,
          createdAt: now,
        },
      }
    })
  }

  /**
   * Hot-path resolver — every incoming IM message calls this to map
   * the IM identity back to an AipeHub user id. Returns `null` for
   * unbound IM users (the bridge typically replies with a "bind first
   * via `/bind <code>`" prompt in that case).
   */
  getUserIdByImBinding(platform: string, platformUserId: string): string | null {
    if (typeof platform !== 'string' || platform.length === 0) return null
    if (typeof platformUserId !== 'string' || platformUserId.length === 0) return null
    const row = this.stmtImBindingGetByPlatformUser.get(platform, platformUserId) as
      | { user_id: string }
      | undefined
    return row?.user_id ?? null
  }

  /** Full binding row (or null) — admin UI "connected accounts" detail. */
  getImBinding(platform: string, platformUserId: string): ImBinding | null {
    if (typeof platform !== 'string' || platform.length === 0) return null
    if (typeof platformUserId !== 'string' || platformUserId.length === 0) return null
    const row = this.stmtImBindingGetByPlatformUser.get(platform, platformUserId) as
      | ImBindingRow
      | undefined
    return row ? rowToImBinding(row) : null
  }

  /**
   * List all IM bindings for a user (admin UI "connected accounts").
   * Optional `platform` filter for "show me my Telegram bindings"
   * style queries.
   */
  listImBindings(userId: string, query: ListImBindingsQuery = {}): ImBinding[] {
    if (typeof userId !== 'string' || userId.length === 0) return []
    const rows = (
      query.platform
        ? this.stmtImBindingListByUserPlatform.all(userId, query.platform)
        : this.stmtImBindingListByUser.all(userId)
    ) as ImBindingRow[]
    return rows.map(rowToImBinding)
  }

  /** Remove a binding (user clicked "Disconnect"). Returns rows removed (0 or 1). */
  removeImBinding(platform: string, platformUserId: string): number {
    if (typeof platform !== 'string' || platform.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'removeImBinding: platform is required',
      })
    }
    if (typeof platformUserId !== 'string' || platformUserId.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'removeImBinding: platformUserId is required',
      })
    }
    const info = this.stmtImBindingDelete.run(platform, platformUserId)
    return Number(info.changes)
  }

  /**
   * Housekeeping: delete `im_binding_codes` rows where `expires_at < now`.
   * Host scheduler may call this periodically (cheap, indexed sweep).
   * Returns the count removed for diagnostics.
   */
  sweepExpiredImBindingCodes(now: number = Date.now()): number {
    if (!Number.isFinite(now)) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `sweepExpiredImBindingCodes: invalid now=${now}`,
      })
    }
    const info = this.stmtImBindingCodeDeleteExpired.run(now)
    return Number(info.changes)
  }

  // =====================================================================
  // Lifecycle
  // =====================================================================

  close(): void {
    if (this.db.open) this.db.close()
  }
}

// ---- B2.1 — usage-counter helpers ----

/** Sqlite row shape — snake_case columns mirror the schema verbatim. */
interface UsageCounterRow {
  user_id: string
  metric: string
  period: string
  period_start: number
  used: number
  quota: number | null
  updated_at: number
}

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/**
 * UTC-aligned period boundary for `now`. Returns the *start* of the
 * current period — checkAndIncrement compares this to the row's stored
 * `period_start` to decide whether to roll.
 *
 * `'total'` returns 0 as a sentinel (any `now` produces the same value,
 * so a row created with periodStart=0 never appears stale).
 */
function periodStartFor(period: UsagePeriod, now: number): number {
  if (period === 'total') return 0
  if (period === 'hourly') return Math.floor(now / HOUR_MS) * HOUR_MS
  if (period === 'daily') return Math.floor(now / DAY_MS) * DAY_MS
  // monthly — Date.UTC handles month rollover (Feb / leap years etc.)
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

function isUsagePeriod(s: unknown): s is UsagePeriod {
  return typeof s === 'string' && (USAGE_PERIODS as readonly string[]).includes(s)
}

function assertUsagePeriod(p: unknown): asserts p is UsagePeriod {
  if (!isUsagePeriod(p)) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `usage period must be one of ${USAGE_PERIODS.join(', ')}; got ${JSON.stringify(p)}`,
    })
  }
}

function assertUsageMetric(m: unknown): asserts m is string {
  if (typeof m !== 'string' || m.length === 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: 'usage metric must be a non-empty string',
    })
  }
  if (m.length > USAGE_METRIC_MAX_LEN) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `usage metric too long (max ${USAGE_METRIC_MAX_LEN} chars); got ${m.length}`,
    })
  }
}

function assertNonEmptyId(id: unknown, label: string): asserts id is string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `${label} must be a non-empty string`,
    })
  }
}

function rowToUsageCounter(r: UsageCounterRow): UsageCounter {
  // Defensive: tolerate an unrecognised period string (manual db edit /
  // pre-migration row). Fall back to 'total' — the row stays visible
  // in admin UI rather than crashing the list endpoint.
  const period: UsagePeriod = isUsagePeriod(r.period) ? r.period : 'total'
  return {
    userId: r.user_id,
    metric: r.metric,
    period,
    periodStart: r.period_start,
    used: r.used,
    quota: r.quota,
    updatedAt: r.updated_at,
  }
}

// ---- E1 — org-quotas helpers ----

interface OrgQuotaRow {
  metric: string
  period: string
  quota: number
  warn_pct: number
  last_state: string
  last_checked: number | null
  created_at: number
  updated_at: number
}

function rowToOrgQuota(r: OrgQuotaRow): OrgQuota {
  // Same defensive tolerance as rowToUsageCounter for period.
  const period: UsagePeriod = isUsagePeriod(r.period) ? r.period : 'total'
  // Clamp unknown lastState to 'ok' so the state-machine bootstraps
  // sanely (next check will set it correctly).
  const lastState: OrgQuotaState =
    r.last_state === 'warn' || r.last_state === 'over' ? r.last_state : 'ok'
  return {
    metric: r.metric,
    period,
    quota: r.quota,
    warnPct: r.warn_pct,
    lastState,
    lastChecked: r.last_checked,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}
// ---- D1 — peer registry helpers ----

interface PeerRow {
  id: string
  peer_id: string
  endpoint_url: string
  label: string | null
  enabled: number
  vault_entry_id: string
  created_at: number
  updated_at: number
}

function rowToPeerRegistration(r: PeerRow): PeerRegistration {
  return {
    id: r.id,
    peerId: r.peer_id,
    endpointUrl: r.endpoint_url,
    label: r.label,
    enabled: r.enabled !== 0,
    vaultEntryId: r.vault_entry_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// ---- Phase 11 M2 — suspended_tasks helpers ----

interface SuspendedTaskRow {
  task_id: string
  agent_id: string
  hub_id: string | null
  origin_user_id: string | null
  resume_at: number
  state: string | null
  task_json: string
  created_at: number
}

function rowToSuspendedTask(r: SuspendedTaskRow): SuspendedTask {
  // Parse `state` from JSON. The persist side stores `null` for
  // "absent"; everything else round-trips through JSON.stringify /
  // JSON.parse. A corrupt blob (e.g. a truncated write) must NOT throw
  // here: `rowToSuspendedTask` feeds `listDueSuspendedTasks` via
  // `.map()`, and a throw mid-map would abort the entire due batch.
  // Worse, the bad row sorts to the head (ORDER BY resume_at ASC), so
  // every subsequent sweep tick would re-throw on it and starve all
  // other parked tasks forever. Instead we flag the row `corrupt` and
  // null its state; the resume sweep detects the flag and drops the row
  // (it can't be resumed — a half-parsed state would re-enter the agent
  // into a broken state anyway).
  let state: unknown = null
  let corrupt = false
  if (r.state !== null) {
    try {
      state = JSON.parse(r.state)
    } catch {
      corrupt = true
    }
  }
  return {
    taskId: r.task_id,
    agentId: r.agent_id,
    hubId: r.hub_id,
    originUserId: r.origin_user_id,
    resumeAt: r.resume_at,
    state,
    // Omit on healthy rows so the record shape is unchanged.
    ...(corrupt ? { corrupt: true } : {}),
    taskJson: r.task_json,
    createdAt: r.created_at,
  }
}

// ---- Phase 12 M1 — IM bindings helpers ----

interface ImBindingRow {
  platform: string
  platform_user_id: string
  user_id: string
  display_name: string | null
  created_at: number
}

function rowToImBinding(r: ImBindingRow): ImBinding {
  return {
    platform: r.platform,
    platformUserId: r.platform_user_id,
    userId: r.user_id,
    displayName: r.display_name,
    createdAt: r.created_at,
  }
}

export function openIdentityStore(input: OpenIdentityStoreInput): IdentityStore {
  if (!input || typeof input.dbPath !== 'string') {
    throw new TypeError('openIdentityStore requires { dbPath: string }')
  }
  const ttl = input.defaultSessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  if (typeof ttl !== 'number' || !isFinite(ttl) || ttl <= 0) {
    throw new TypeError(
      `defaultSessionTtlMs must be a positive finite number; got ${ttl}`,
    )
  }
  // Shape-check masterKey at the boundary so a misconfigured host fails
  // here (clear stack) instead of inside the first vault call (stack
  // deep in user code). Length validation lives in crypto.ts because
  // the buffer can also reach the store via test harness paths.
  if (input.masterKey !== undefined && !Buffer.isBuffer(input.masterKey)) {
    throw new TypeError(
      `masterKey must be a Buffer when provided; got ${typeof input.masterKey}`,
    )
  }
  const db = openDb(input.dbPath)
  applyMigrations(db)
  return new IdentityStore(db, ttl, input.masterKey)
}
