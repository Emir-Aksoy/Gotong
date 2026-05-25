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

import { openDb, transaction, type SqliteDb, type SqliteStmt } from './db.js'
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
import { decryptSecret, encryptSecret } from './crypto.js'
import {
  AUDIT_ACTIONS,
  OWNER_KINDS,
  ROLES,
  VAULT_KINDS,
  type AcceptInvitationInput,
  type AuditAction,
  type AuditActorSource,
  type AuditLogEntry,
  type BootstrapInput,
  type BootstrapResult,
  type CreateInvitationInput,
  type CreateUserInput,
  type CreateVaultEntryInput,
  type Credential,
  type CredentialKind,
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
  type Role,
  type Session,
  type User,
  type VaultEntry,
  type VaultKind,
  type WriteAuditLogInput,
} from './types.js'

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
interface VaultRow {
  id: string
  kind: string
  owner_kind: string
  owner_id: string | null
  label: string | null
  secret_enc: string
  metadata: string | null
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
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
  /**
   * A1 — present iff the caller passed `masterKey` to openIdentityStore.
   * Vault APIs throw `vault_not_configured` when this is undefined.
   * Kept as a field (not a closure capture) so methods can check it
   * uniformly via a single `requireMasterKey()` helper.
   */
  private readonly masterKey?: Buffer
  // Vault prepared statements — lazy because they're only allocated for
  // hosts that actually use vault APIs. better-sqlite3's per-db statement
  // cache makes the first prepare ~zero-cost; we just don't want to
  // allocate them on every IdentityStore even when vault is unused.
  private _stmtVaultInsert?: SqliteStmt
  private _stmtVaultById?: SqliteStmt
  private _stmtVaultTouch?: SqliteStmt
  private _stmtVaultRevoke?: SqliteStmt

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

  constructor(db: SqliteDb, defaultSessionTtlMs: number, masterKey?: Buffer) {
    this.db = db
    this.defaultSessionTtlMs = defaultSessionTtlMs
    // Stored only when explicitly provided so vault APIs can detect
    // "host didn't configure encryption" vs "wrong key supplied".
    if (masterKey !== undefined) this.masterKey = masterKey

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
      return { bootstrapped: true, ownerUserId: userId }
    })
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
    return transaction(this.db, () => {
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
  // Vault (A1 — Phase 5 encrypted application-layer secret storage)
  //
  // Design notes:
  //   - Distinct from `credentials` (one-way hashed login material).
  //     Vault rows are AES-256-GCM encrypted and CAN be decrypted —
  //     the host re-presents these secrets to upstream services.
  //   - `createVaultEntry` / `readVaultSecret` / `revokeVaultEntry` all
  //     require `masterKey` was supplied at openIdentityStore time;
  //     otherwise they throw `vault_not_configured`. Listing is allowed
  //     without a key because list results omit secret material.
  //   - `revokeVaultEntry` is a soft delete (sets `revoked_at`) — rows
  //     stay queryable for audit. The active hot path filters by
  //     `revoked_at IS NULL`.
  //   - Audit writes belong to the CALLING layer (web / OrgApiPool), not
  //     the store. The store doesn't know who's calling, what surface
  //     authenticated them, or whether the operation is admin-initiated
  //     vs internal — the caller has that context.
  // =====================================================================

  /**
   * Insert a new vault entry. Returns the row metadata WITHOUT the
   * encrypted blob (list / get use the same shape). The plaintext
   * `secret` is encrypted with the configured master key before
   * touching disk.
   *
   * Validation:
   *   - `kind` and `ownerKind` must be enum members; otherwise
   *     `invalid_input`.
   *   - `ownerKind === 'org'` requires `ownerId` to be null/undefined
   *     (the host is the implicit org owner; explicit ids are rejected
   *     to prevent silent misclassification).
   *   - `ownerKind === 'user' | 'peer'` requires a non-empty `ownerId`.
   *   - `secret` must be a non-empty string. Provider-format validation
   *     is the caller's job (we don't know what `sk-ant-` should look
   *     like for every kind).
   *   - `metadata`, when present, is JSON-stringified and clamped to
   *     8KB (same as audit_log).
   */
  createVaultEntry(input: CreateVaultEntryInput): VaultEntry {
    const key = this.requireMasterKey()
    if (!input || typeof input !== 'object') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'createVaultEntry input required',
      })
    }
    if (!isVaultKind(input.kind)) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `vault kind must be one of ${VAULT_KINDS.join(', ')}; got ${JSON.stringify(input.kind)}`,
      })
    }
    if (!isOwnerKind(input.ownerKind)) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `vault ownerKind must be one of ${OWNER_KINDS.join(', ')}; got ${JSON.stringify(input.ownerKind)}`,
      })
    }
    // Owner-id shape gate, per the documented contract.
    const ownerId = input.ownerId ?? null
    if (input.ownerKind === 'org') {
      if (ownerId !== null) {
        throw new IdentityError({
          code: 'invalid_input',
          message:
            'vault ownerKind=org must have null ownerId (the host is the implicit org owner)',
        })
      }
    } else {
      if (typeof ownerId !== 'string' || ownerId.length === 0) {
        throw new IdentityError({
          code: 'invalid_input',
          message: `vault ownerKind=${input.ownerKind} requires non-empty ownerId`,
        })
      }
    }
    if (typeof input.secret !== 'string' || input.secret.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'vault secret must be a non-empty string',
      })
    }
    const label = input.label === undefined ? null : input.label
    if (label !== null && typeof label !== 'string') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'vault label must be a string or null',
      })
    }
    let metadataJson: string | null = null
    let metadataObj: Record<string, unknown> | null = null
    if (input.metadata !== undefined && input.metadata !== null) {
      if (typeof input.metadata !== 'object' || Array.isArray(input.metadata)) {
        throw new IdentityError({
          code: 'invalid_input',
          message: 'vault metadata must be a plain object or null',
        })
      }
      try {
        metadataJson = JSON.stringify(input.metadata)
      } catch (err) {
        throw new IdentityError({
          code: 'invalid_input',
          message: `vault metadata not JSON-serialisable: ${(err as Error).message}`,
          cause: err,
        })
      }
      if (metadataJson.length > 8192) {
        throw new IdentityError({
          code: 'invalid_input',
          message: `vault metadata too large (max 8KB serialised); got ${metadataJson.length}`,
        })
      }
      metadataObj = input.metadata
    }

    const id = newId()
    const now = Date.now()
    const secretEnc = encryptSecret(key, input.secret)
    this.stmtVaultInsert.run(
      id,
      input.kind,
      input.ownerKind,
      ownerId,
      label,
      secretEnc,
      metadataJson,
      now,
    )
    return {
      id,
      kind: input.kind,
      ownerKind: input.ownerKind,
      ownerId,
      label,
      metadata: metadataObj,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    }
  }

  /** Lookup by id. Returns null on missing id. Includes revoked rows. */
  getVaultEntry(id: string): VaultEntry | null {
    if (typeof id !== 'string' || id.length === 0) return null
    const row = this.stmtVaultById.get(id) as VaultRow | undefined
    return row ? rowToVaultEntry(row) : null
  }

  /**
   * Read + decrypt the plaintext secret. Side-effect: touches
   * `last_used_at`. Throws:
   *   - `vault_not_configured` if no master key was supplied at open
   *   - `vault_entry_not_found` if no row matches
   *   - `vault_entry_not_found` if the row is soft-revoked (we refuse to
   *     hand out revoked secrets — callers needing forensics should use
   *     `getVaultEntry` + admin-level intent)
   *   - `vault_decrypt_failed` if the master key doesn't match the
   *     row's ciphertext
   */
  readVaultSecret(id: string): string {
    const key = this.requireMasterKey()
    if (typeof id !== 'string' || id.length === 0) {
      throw new IdentityError({
        code: 'vault_entry_not_found',
        message: 'vault entry id required',
      })
    }
    const row = this.stmtVaultById.get(id) as VaultRow | undefined
    if (!row) {
      throw new IdentityError({
        code: 'vault_entry_not_found',
        message: `vault entry not found: ${id}`,
      })
    }
    if (row.revoked_at !== null) {
      throw new IdentityError({
        code: 'vault_entry_not_found',
        message: `vault entry revoked: ${id}`,
      })
    }
    const plaintext = decryptSecret(key, row.secret_enc)
    this.stmtVaultTouch.run(Date.now(), id)
    return plaintext
  }

  /**
   * Soft-delete a vault entry by stamping `revoked_at`. Idempotent: a
   * second revoke is a no-op (we only update rows where `revoked_at IS
   * NULL`). Missing ids throw `vault_entry_not_found` so a confused
   * caller doesn't believe a non-existent row was revoked.
   */
  revokeVaultEntry(id: string): void {
    if (typeof id !== 'string' || id.length === 0) {
      throw new IdentityError({
        code: 'vault_entry_not_found',
        message: 'vault entry id required',
      })
    }
    const existing = this.stmtVaultById.get(id) as VaultRow | undefined
    if (!existing) {
      throw new IdentityError({
        code: 'vault_entry_not_found',
        message: `vault entry not found: ${id}`,
      })
    }
    if (existing.revoked_at !== null) return // already revoked, no-op
    this.stmtVaultRevoke.run(Date.now(), id)
  }

  /**
   * Filterable listing. Does NOT decrypt — secret material never leaves
   * the store via list paths. The result rows let the caller decide
   * which id to feed into `readVaultSecret`.
   */
  listVaultEntries(query: ListVaultEntriesQuery = {}): VaultEntry[] {
    const limit = Math.max(1, Math.min(500, query.limit ?? 100))
    const offset = Math.max(0, query.offset ?? 0)
    const activeOnly = query.activeOnly !== false
    const where: string[] = []
    const params: (string | number | null)[] = []
    if (query.kind !== undefined) {
      if (!isVaultKind(query.kind)) {
        throw new IdentityError({
          code: 'invalid_input',
          message: `listVaultEntries: invalid kind filter: ${JSON.stringify(query.kind)}`,
        })
      }
      where.push('kind = ?')
      params.push(query.kind)
    }
    if (query.ownerKind !== undefined) {
      if (!isOwnerKind(query.ownerKind)) {
        throw new IdentityError({
          code: 'invalid_input',
          message: `listVaultEntries: invalid ownerKind filter: ${JSON.stringify(query.ownerKind)}`,
        })
      }
      where.push('owner_kind = ?')
      params.push(query.ownerKind)
    }
    // ownerId filter — `null` is a legitimate match value (it queries
    // org-owned rows), so we check for explicit presence in the input.
    if ('ownerId' in query) {
      if (query.ownerId === null) {
        where.push('owner_id IS NULL')
      } else if (typeof query.ownerId === 'string' && query.ownerId.length > 0) {
        where.push('owner_id = ?')
        params.push(query.ownerId)
      } else if (query.ownerId !== undefined) {
        throw new IdentityError({
          code: 'invalid_input',
          message: 'listVaultEntries: ownerId must be a non-empty string or null',
        })
      }
    }
    if (activeOnly) {
      where.push('revoked_at IS NULL')
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    // rowid tie-breaker — see listAuditLog for the rationale.
    const sql = `SELECT * FROM vault ${whereSql} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`
    params.push(limit, offset)
    const rows = this.db.prepare(sql).all(...params) as VaultRow[]
    return rows.map(rowToVaultEntry)
  }

  // ---- Vault internal helpers ----

  private requireMasterKey(): Buffer {
    if (!this.masterKey) {
      throw new IdentityError({
        code: 'vault_not_configured',
        message:
          'vault requires `masterKey` at openIdentityStore time; vault APIs are disabled until configured',
      })
    }
    return this.masterKey
  }

  private get stmtVaultInsert(): SqliteStmt {
    return (this._stmtVaultInsert ??= this.db.prepare(
      `INSERT INTO vault(
         id, kind, owner_kind, owner_id, label, secret_enc, metadata,
         created_at, last_used_at, revoked_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ))
  }
  private get stmtVaultById(): SqliteStmt {
    return (this._stmtVaultById ??= this.db.prepare(
      'SELECT * FROM vault WHERE id = ?',
    ))
  }
  private get stmtVaultTouch(): SqliteStmt {
    return (this._stmtVaultTouch ??= this.db.prepare(
      'UPDATE vault SET last_used_at = ? WHERE id = ?',
    ))
  }
  private get stmtVaultRevoke(): SqliteStmt {
    return (this._stmtVaultRevoke ??= this.db.prepare(
      'UPDATE vault SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    ))
  }

  // =====================================================================
  // Lifecycle
  // =====================================================================

  close(): void {
    if (this.db.open) this.db.close()
  }
}

// ---- Module-private vault helpers (pure functions, kept out of class) ----

function isVaultKind(s: unknown): s is VaultKind {
  return typeof s === 'string' && (VAULT_KINDS as readonly string[]).includes(s)
}
function isOwnerKind(s: unknown): s is OwnerKind {
  return typeof s === 'string' && (OWNER_KINDS as readonly string[]).includes(s)
}
function rowToVaultEntry(r: VaultRow): VaultEntry {
  let metadata: Record<string, unknown> | null = null
  if (r.metadata) {
    try {
      const parsed: unknown = JSON.parse(r.metadata)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>
      }
    } catch {
      metadata = { _corrupt: r.metadata }
    }
  }
  // Graceful fallback on db corruption (manual edit): clamp unknown
  // strings to the closest valid enum so the row stays visible in the
  // admin UI rather than crashing the list endpoint.
  const kind = isVaultKind(r.kind) ? r.kind : ('third_party_api' as VaultKind)
  const ownerKind = isOwnerKind(r.owner_kind)
    ? r.owner_kind
    : ('org' as OwnerKind)
  return {
    id: r.id,
    kind,
    ownerKind,
    ownerId: r.owner_id,
    label: r.label,
    metadata,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
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
