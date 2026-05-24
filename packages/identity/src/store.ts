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
  newSessionToken,
} from './tokens.js'
import { IdentityError } from './errors.js'
import {
  ROLES,
  type AuditActorSource,
  type AuditLogEntry,
  type BootstrapInput,
  type BootstrapResult,
  type CreateUserInput,
  type Credential,
  type CredentialKind,
  type IssuedAdminToken,
  type IssuedApiKey,
  type ListAuditLogQuery,
  type Membership,
  type Role,
  type Session,
  type User,
  type WriteAuditLogInput,
} from './types.js'

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

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

const AUDIT_ACTOR_SOURCES: readonly AuditActorSource[] = [
  'v3-admin',
  'v4-session',
  'v4-bearer',
  'anonymous',
  'system',
] as const

function isAuditActorSource(s: string): s is AuditActorSource {
  return (AUDIT_ACTOR_SOURCES as readonly string[]).includes(s)
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

  constructor(db: SqliteDb, defaultSessionTtlMs: number) {
    this.db = db
    this.defaultSessionTtlMs = defaultSessionTtlMs

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
  }

  // =====================================================================
  // Bootstrap
  // =====================================================================

  bootstrap(input: BootstrapInput = {}): BootstrapResult {
    const count = (this.stmtCountUsers.get() as { c: number }).c
    if (count > 0) {
      return {
        bootstrapped: false,
        ownerUserId: null,
        adminTokenMigrated: false,
      }
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

    return transaction(this.db, () => {
      const userId = newId()
      const now = Date.now()
      this.stmtInsertUser.run(userId, email, displayName, now)
      this.stmtInsertMembership.run(newId(), userId, 'owner', now)

      let migrated = false
      const adminToken = input.adminToken
      if (typeof adminToken === 'string' && adminToken.length > 0) {
        const identifier = hashToken(adminToken)
        this.stmtInsertCredential.run(
          newId(),
          userId,
          'admin_token',
          identifier,
          identifier,
          'v3 admin token (migrated)',
          now,
        )
        migrated = true
      }

      return {
        bootstrapped: true,
        ownerUserId: userId,
        adminTokenMigrated: migrated,
      }
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
    const sql = `SELECT * FROM audit_log ${whereSql} ORDER BY ts DESC LIMIT ? OFFSET ?`
    params.push(limit, offset)
    const rows = this.db.prepare(sql).all(...params) as AuditLogRow[]
    return rows.map(rowToAuditLog)
  }

  // =====================================================================
  // Lifecycle
  // =====================================================================

  close(): void {
    if (this.db.open) this.db.close()
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
  const db = openDb(input.dbPath)
  applyMigrations(db)
  return new IdentityStore(db, ttl)
}
