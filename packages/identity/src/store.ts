/**
 * IdentityStore — the single public surface of @gotong/identity.
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
  oidcLinkIdentifier,
  samlLinkIdentifier,
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
import { SuspendedTaskStore } from './suspended-task-store.js'
import { LedgerStore } from './ledger-store.js'
import { PeerSummarySnapshotStore } from './peer-summary-snapshot-store.js'
import { PeerSummaryAlertRuleStore } from './peer-summary-alert-rule-store.js'
import { PeerSummaryAlertFiringStore } from './peer-summary-alert-firing-store.js'
import { PeerSummaryAlertChannelStore } from './peer-summary-alert-channel-store.js'
import { ResourceGrantStore } from './resource-grant-store.js'
import { userPrincipal, type Principal } from './principal.js'
import { PeerStore } from './peer-store.js'
import { QuotaStore } from './quota-store.js'
import { TotpStore, type EnrollTotpInput, type VerifyTotpInput } from './totp-store.js'
import { OidcProviderStore } from './oidc-provider-store.js'
import { OAuthConnectorStore } from './oauth-connector-store.js'
import { SamlProviderStore } from './saml-provider-store.js'
import { A2aAgentStore } from './a2a-agent-store.js'
import { AcpAgentStore } from './acp-agent-store.js'
import {
  AUDIT_ACTIONS,
  ROLES,
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
  type LinkOidcInput,
  type LinkSamlInput,
  type ListVaultEntriesQuery,
  type Membership,
  type AddOidcProviderInput,
  type OidcLogin,
  type OidcProvider,
  type SamlLogin,
  type AddSamlProviderInput,
  type SamlProvider,
  type UpdateSamlProviderInput,
  type A2aOutboundAgent,
  type AddA2aOutboundAgentInput,
  type UpdateA2aOutboundAgentInput,
  type AcpOutboundAgent,
  type AddAcpOutboundAgentInput,
  type UpdateAcpOutboundAgentInput,
  type OAuthConnector,
  type RegisterOAuthConnectorInput,
  type UpdateOAuthConnectorInput,
  type StoredOAuthTokenSet,
  type UpdateOidcProviderInput,
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
  // Phase 17 (Sprint 4) — usage / cost ledger.
  type LedgerAppendInput,
  type LedgerEntry,
  type LedgerQuery,
  type LedgerAggregateQuery,
  type LedgerAggregateRow,
  // v5 Stream F — control-plane history (peer.summary snapshots).
  type AppendPeerSummarySnapshotInput,
  type PeerSummarySnapshot,
  type PeerSummarySnapshotQuery,
  type AddPeerSummaryAlertRuleInput,
  type PeerSummaryAlertRule,
  type UpdatePeerSummaryAlertRuleInput,
  // v5 Stream F day-3 — control-plane alert FIRINGS (breach history).
  type OpenPeerSummaryAlertFiringInput,
  type PeerSummaryAlertFiring,
  type PeerSummaryAlertFiringQuery,
  // v5 Stream F day-3 — control-plane alert notification CHANNELS.
  type AddPeerSummaryAlertChannelInput,
  type PeerSummaryAlertChannel,
  type UpdatePeerSummaryAlertChannelInput,
  type TotpEnrollment,
  type TotpState,
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
  // Phase 19 P2-M5 — workflow grants (resource RBAC).
  type SetWorkflowGrantInput,
  type WorkflowGrant,
  type WorkflowPerm,
  // v5 E4-M1 — agent grants (resource RBAC, mirror of the workflow facade).
  type SetAgentGrantInput,
  type AgentGrant,
  // v5 A-M1 — unified resource grants.
  type ResourceGrant,
  type SetResourceGrantInput,
  type ResourceKind,
  type GrantPerm,
} from './types.js'
import { randomInt } from 'node:crypto'

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

// Route B P0-M1 — tenant/namespace of this identity store. An identity DB is
// already one tenant's (the `dbPath` is tenant-resolved by the host); this is
// the self-describing label so higher layers can read back *which* tenant.
// Kept as a local literal — `@gotong/identity` has zero deps on purpose, so
// we deliberately do NOT import `DEFAULT_TENANT` from `@gotong/core`. The
// value MUST stay in sync with core's `DEFAULT_TENANT`.
const DEFAULT_NAMESPACE = 'default'

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
const DUMMY_SCRYPT_HASH = hashPassword('gotong-identity-timing-equaliser-not-a-real-credential')

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
  /**
   * Route B P0-M1 — tenant/namespace this store serves. Defaults to
   * `'default'`. Metadata only: physical isolation is the host's
   * tenant-resolved `dbPath` (see core's `tenantRoot`). Provided so a future
   * multi-tenant host can tag each store and read the tenant back off it.
   */
  namespace?: string
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
  /**
   * Tenant/namespace this identity store serves (Route B P0-M1). Metadata
   * only — physical isolation is the host's tenant-resolved `dbPath`.
   * Defaults to `'default'` (see {@link DEFAULT_NAMESPACE}).
   */
  readonly namespace: string
  // R13 — the vault domain (AES-256-GCM secret storage) lives in its own
  // VaultStore. IdentityStore composes one and forwards the public vault
  // methods, so callers see no API change. masterKey + vault prepared
  // statements + mutation listeners all moved with it.
  private readonly vault: VaultStore

  // R13 — peer registry (D1 federation) extracted to PeerStore, which owns
  // the table's 7 lazy statements and composes the VaultStore for token
  // storage (injected below, after this.vault is constructed).
  private readonly peers: PeerStore

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

  // R13 — usage counters (B2.1) + per-org soft quotas (E1) extracted to
  // QuotaStore, which owns the two tables' 15 eager statements. org_meta
  // below is NOT part of it: that kv is cross-cutting (bootstrap +
  // mode-switch + upgrade), so it stays in the facade.
  private readonly quota: QuotaStore
  // Phase 17 (Sprint 4) — usage / cost ledger (raw per-call line items
  // under the quota counters). Append on the post-LLM-call path; scan on
  // dashboard aggregate + CSV/JSONL export. Owns its own statements.
  private readonly ledger: LedgerStore
  // v5 Stream F — control-plane history. One counts-only snapshot per
  // peer.summary refresh; append-only, scan on trend read. Opaque store —
  // identity never parses the blob (the host owns PeerSummary semantics).
  private readonly peerSummarySnapshots: PeerSummarySnapshotStore
  private readonly peerSummaryAlertRules: PeerSummaryAlertRuleStore
  private readonly peerSummaryAlertFirings: PeerSummaryAlertFiringStore
  private readonly peerSummaryAlertChannels: PeerSummaryAlertChannelStore
  // Phase 19 P2-M5 → v5 A-M1 — resource grants (unified resource-level RBAC,
  // principal → any resource). Owner-as-grant. Generalizes the old
  // workflow-only grant store; the workflow facade methods below delegate here.
  private readonly resourceGrants: ResourceGrantStore
  // Route B P1-M3b — MFA (TOTP) enrollment store. Composes the vault for the
  // encrypted shared secret; the facade methods below delegate here.
  private readonly totp: TotpStore
  // Route B P1-M4d — OIDC identity-provider registry. Composes the vault for
  // each IdP's confidential client_secret; the facade methods below delegate.
  private readonly oidcProviders: OidcProviderStore
  // Route B P1-M5c — SAML identity-provider registry. No vault: idp_cert is a
  // PUBLIC X.509 signing cert, so the whole row is plain config.
  private readonly samlProviders: SamlProviderStore
  // Route B P1-M11a — outbound A2A agent registry. No vault: the bearer stays
  // in env (token_env names the var), so every column is non-secret config.
  private readonly a2aAgents: A2aAgentStore
  // ACP-OUT-M1 — outbound ACP agent registry. No vault, not even an env-var
  // pointer: ACP bridges ride the underlying agent's own login (hub injects no
  // key), so every column is non-secret config (command/args/cwd).
  private readonly acpAgents: AcpAgentStore
  // C-M2-M2 — outbound OAuth connector registry. Composes the vault for the
  // confidential client_secret AND the obtained token set (both ownerKind
  // 'org'). Empty table = byte-for-byte unchanged (opt-in).
  private readonly oauthConnectors: OAuthConnectorStore
  // Phase 7 M4 — org_meta kv (org_mode lives here).
  private readonly stmtOrgMetaGet: SqliteStmt
  private readonly stmtOrgMetaUpsert: SqliteStmt
  // R13 — suspended_tasks (long-running agent park/resume) extracted to
  // SuspendedTaskStore, which owns the table's 5 eager statements.
  private readonly suspendedTasks: SuspendedTaskStore

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

  constructor(
    db: SqliteDb,
    defaultSessionTtlMs: number,
    masterKey?: Buffer,
    namespace: string = DEFAULT_NAMESPACE,
  ) {
    this.db = db
    this.defaultSessionTtlMs = defaultSessionTtlMs
    this.namespace = namespace
    // R13 — vault domain extracted. VaultStore owns the masterKey (and
    // detects "host didn't configure encryption" vs "wrong key supplied")
    // plus its own lazy prepared statements + mutation listeners.
    this.vault = new VaultStore(db, masterKey)
    // R13 — peer registry extracted; composes the vault for peer-token
    // storage. Constructed after this.vault since PeerStore holds the ref.
    this.peers = new PeerStore(db, this.vault)
    // R13 — usage counters + per-org quotas extracted. QuotaStore prepares
    // its 15 statements eagerly (checkAndIncrement is the agent-spawn hot
    // path; orgQuotaSweep ticks on a host timer).
    this.quota = new QuotaStore(db)
    // Phase 17 — usage / cost ledger. Constructed after quota (same
    // billing domain, but its own table). Eager INSERT + get-by-id.
    this.ledger = new LedgerStore(db)
    this.peerSummarySnapshots = new PeerSummarySnapshotStore(db)
    this.peerSummaryAlertRules = new PeerSummaryAlertRuleStore(db)
    this.peerSummaryAlertFirings = new PeerSummaryAlertFiringStore(db)
    this.peerSummaryAlertChannels = new PeerSummaryAlertChannelStore(db)
    // Phase 19 P2-M5 → v5 A-M1 — unified resource grants. Eager statements.
    this.resourceGrants = new ResourceGrantStore(db)
    // Route B P1-M3b — MFA TOTP store. Composes `this` for vault ops (the
    // facade exposes createVaultEntry / readVaultSecret / revokeVaultEntry);
    // the methods are only called later, so the partially-built `this` is fine.
    this.totp = new TotpStore(db, this)
    // Route B P1-M4d — OIDC IdP registry. Same composition as TotpStore: `this`
    // supplies the vault facade for each IdP's client_secret (ownerKind 'org').
    this.oidcProviders = new OidcProviderStore(db, this)
    // Route B P1-M5c — SAML IdP registry. No vault dependency (idp_cert public).
    this.samlProviders = new SamlProviderStore(db)
    // Route B P1-M11a — outbound A2A agent registry. No vault (bearer in env).
    this.a2aAgents = new A2aAgentStore(db)
    // ACP-OUT-M1 — outbound ACP agent registry. No vault (rides agent's login).
    this.acpAgents = new AcpAgentStore(db)
    // C-M2-M2 — outbound OAuth connector registry. Same composition as
    // OidcProviderStore: `this` supplies the vault facade for the client_secret
    // AND the token set (both ownerKind 'org').
    this.oauthConnectors = new OAuthConnectorStore(db, this)

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
    // R13 — suspended_tasks domain extracted; SuspendedTaskStore prepares
    // its own 5 statements eagerly (same hot-path rationale as before).
    this.suspendedTasks = new SuspendedTaskStore(db)

    // Phase 12 M1 — IM bindings.
    //
    // INSERT OR REPLACE on im_bindings handles the "user moves their
    // (platform, platformUserId) to a different Gotong account" case
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
   * setOrgMode() (eg. GOTONG_MODE env at host startup).
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
    /**
     * Route B P1-M3c — second factor. Only consulted when the user has an
     * ACTIVE TOTP enrollment; omit it on the first attempt to receive a
     * `totp_required` challenge, then retry with the code.
     */
    totpCode?: string
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
    // Route B P1-M3c — second factor. Gates interactive PASSWORD login only;
    // token / api-key auth (authenticateToken) is non-interactive and stays
    // MFA-exempt by design (a high-entropy key is itself a strong factor). The
    // challenge fires only AFTER the password verifies, so MFA state can't be
    // probed without the password. A wrong code is reported as a generic
    // authentication_failed (no "password was right, code was wrong" oracle);
    // the client knows from its own step which field to re-prompt.
    if (this.totp.isEnabled(cred.user_id)) {
      if (typeof opts.totpCode !== 'string' || opts.totpCode.length === 0) {
        throw new IdentityError({
          code: 'totp_required',
          message: 'second factor required',
        })
      }
      if (!this.totp.verifyForLogin({ userId: cred.user_id, code: opts.totpCode })) {
        throw new IdentityError({
          code: 'authentication_failed',
          message: 'invalid credentials',
        })
      }
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
   * Route B P1-M4a — bind a verified OIDC identity to a local user.
   *
   * Idempotent: re-linking the SAME (issuer, sub) to the SAME user returns the
   * existing credential id without inserting a duplicate. Binding an (issuer,
   * sub) already claimed by a DIFFERENT user throws `oidc_already_linked` (one
   * IdP identity must not fan out to two local accounts). The (issuer, sub)
   * MUST already be validated upstream (M4b verifies the id_token signature,
   * iss, aud, exp, nonce) — this method makes no trust decision, it only maps.
   */
  linkOidc(input: LinkOidcInput): string {
    if (
      typeof input?.userId !== 'string' ||
      typeof input?.issuer !== 'string' ||
      typeof input?.sub !== 'string' ||
      input.issuer.length === 0 ||
      input.sub.length === 0
    ) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'linkOidc requires userId, issuer, sub',
      })
    }
    const user = this.getUserById(input.userId)
    if (!user) {
      throw new IdentityError({
        code: 'user_not_found',
        message: `user not found: ${input.userId}`,
      })
    }
    const identifier = oidcLinkIdentifier(input.issuer, input.sub)
    const existing = this.stmtFindCredByKindIdent.get('oidc', identifier) as
      | CredentialRow
      | undefined
    if (existing) {
      if (existing.user_id === input.userId) return existing.id
      throw new IdentityError({
        code: 'oidc_already_linked',
        message: 'this identity is already linked to another user',
      })
    }
    const credentialId = newId()
    // No replayable secret of its own — the IdP-signed token is the proof,
    // re-validated every login. secret_hash is '' (the NOT NULL column still
    // needs a value); `label` carries the issuer so an admin sees WHICH IdP at
    // a glance in the existing credential listing.
    this.stmtInsertCredential.run(
      credentialId,
      input.userId,
      'oidc',
      identifier,
      '',
      input.issuer,
      Date.now(),
    )
    return credentialId
  }

  /**
   * Route B P1-M4a — look up the local user linked to an OIDC identity.
   * Returns the user id, or null when no link exists. Pure read; no session.
   */
  findUserByOidc(opts: { issuer: string; sub: string }): string | null {
    if (
      typeof opts?.issuer !== 'string' ||
      typeof opts?.sub !== 'string' ||
      opts.issuer.length === 0 ||
      opts.sub.length === 0
    ) {
      return null
    }
    const identifier = oidcLinkIdentifier(opts.issuer, opts.sub)
    const cred = this.stmtFindCredByKindIdent.get('oidc', identifier) as
      | CredentialRow
      | undefined
    return cred ? cred.user_id : null
  }

  /**
   * Route B P1-M4a — authenticate a previously-linked OIDC identity, minting
   * the SAME local `Session` every other auth path produces (decision D-3:
   * self-built session, not pure SP passthrough). Throws `oidc_not_linked`
   * when no local user is bound — the callback route (M4e) owns the
   * provisioning policy (auto-create vs refuse), so this stays mechanism-only.
   *
   * MFA boundary: OIDC login is NOT gated by local TOTP. The IdP is the
   * authentication authority and runs its own MFA; layering a second local
   * factor on a federated login is a deliberate non-goal for this MVP (mirrors
   * `authenticateToken` staying MFA-exempt — a delegated assertion is itself
   * the strong factor). Revisit if per-account "force local 2FA" is ever asked.
   */
  authenticateOidc(opts: OidcLogin): Session {
    if (
      typeof opts?.issuer !== 'string' ||
      typeof opts?.sub !== 'string' ||
      opts.issuer.length === 0 ||
      opts.sub.length === 0
    ) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'authenticateOidc requires issuer, sub',
      })
    }
    const identifier = oidcLinkIdentifier(opts.issuer, opts.sub)
    const cred = this.stmtFindCredByKindIdent.get('oidc', identifier) as
      | CredentialRow
      | undefined
    if (!cred) {
      throw new IdentityError({
        code: 'oidc_not_linked',
        message: 'no local user linked to this oidc identity',
      })
    }
    return this.beginSession(
      cred.user_id,
      opts.ttlMs ?? this.defaultSessionTtlMs,
      cred.id,
    )
  }

  /**
   * Route B P1-M5b — bind a verified SAML identity to a local user. The SAML
   * twin of linkOidc: idempotent on the SAME (idpEntityId, NameID) → user, and
   * throws `saml_already_linked` when that pair already maps to a DIFFERENT
   * user. The assertion MUST be validated upstream (@gotong/saml verifies the
   * signature, Issuer, Audience, time window, Recipient, InResponseTo) — this
   * method makes no trust decision, it only maps.
   */
  linkSaml(input: LinkSamlInput): string {
    if (
      typeof input?.userId !== 'string' ||
      typeof input?.idpEntityId !== 'string' ||
      typeof input?.nameId !== 'string' ||
      input.idpEntityId.length === 0 ||
      input.nameId.length === 0
    ) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'linkSaml requires userId, idpEntityId, nameId',
      })
    }
    const user = this.getUserById(input.userId)
    if (!user) {
      throw new IdentityError({
        code: 'user_not_found',
        message: `user not found: ${input.userId}`,
      })
    }
    const identifier = samlLinkIdentifier(input.idpEntityId, input.nameId)
    const existing = this.stmtFindCredByKindIdent.get('saml', identifier) as
      | CredentialRow
      | undefined
    if (existing) {
      if (existing.user_id === input.userId) return existing.id
      throw new IdentityError({
        code: 'saml_already_linked',
        message: 'this identity is already linked to another user',
      })
    }
    const credentialId = newId()
    // No replayable secret of its own — the IdP-signed assertion is the proof,
    // re-validated every login. secret_hash is '' (NOT NULL needs a value);
    // `label` carries the IdP entityID so an admin sees WHICH IdP at a glance.
    this.stmtInsertCredential.run(
      credentialId,
      input.userId,
      'saml',
      identifier,
      '',
      input.idpEntityId,
      Date.now(),
    )
    return credentialId
  }

  /**
   * Route B P1-M5b — look up the local user linked to a SAML identity.
   * Returns the user id, or null when no link exists. Pure read; no session.
   */
  findUserBySaml(opts: { idpEntityId: string; nameId: string }): string | null {
    if (
      typeof opts?.idpEntityId !== 'string' ||
      typeof opts?.nameId !== 'string' ||
      opts.idpEntityId.length === 0 ||
      opts.nameId.length === 0
    ) {
      return null
    }
    const identifier = samlLinkIdentifier(opts.idpEntityId, opts.nameId)
    const cred = this.stmtFindCredByKindIdent.get('saml', identifier) as
      | CredentialRow
      | undefined
    return cred ? cred.user_id : null
  }

  /**
   * Route B P1-M5b — authenticate a previously-linked SAML identity, minting
   * the SAME local `Session` every other auth path produces (decision D-3 from
   * OIDC, reused here). Throws `saml_not_linked` when no local user is bound —
   * the ACS route owns the provisioning policy (JIT-link-by-verified-email vs
   * refuse), so this stays mechanism-only. MFA-exempt for the same reason as
   * OIDC: the IdP is the authentication authority and runs its own MFA.
   */
  authenticateSaml(opts: SamlLogin): Session {
    if (
      typeof opts?.idpEntityId !== 'string' ||
      typeof opts?.nameId !== 'string' ||
      opts.idpEntityId.length === 0 ||
      opts.nameId.length === 0
    ) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'authenticateSaml requires idpEntityId, nameId',
      })
    }
    const identifier = samlLinkIdentifier(opts.idpEntityId, opts.nameId)
    const cred = this.stmtFindCredByKindIdent.get('saml', identifier) as
      | CredentialRow
      | undefined
    if (!cred) {
      throw new IdentityError({
        code: 'saml_not_linked',
        message: 'no local user linked to this saml identity',
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
    if (query.actions !== undefined && query.actions.length > 0) {
      // action IN (?,?,...) — placeholders count is fixed by the array
      // length; every value is bound, not interpolated.
      where.push(`action IN (${query.actions.map(() => '?').join(',')})`)
      params.push(...query.actions)
    }
    if (query.targetUserId !== undefined) {
      where.push('target_user_id = ?')
      params.push(query.targetUserId)
    }
    if (query.success !== undefined) {
      where.push('success = ?')
      params.push(query.success ? 1 : 0)
    }
    if (query.since !== undefined) {
      where.push('ts >= ?')
      params.push(query.since)
    }
    if (query.until !== undefined) {
      where.push('ts <= ?')
      params.push(query.until)
    }
    if (query.metadataEquals !== undefined) {
      // json_extract(metadata, '$.field') = value — BOTH the path and the
      // value are bound parameters, so no user input ever reaches the SQL
      // text. Rows whose metadata is NULL / lacks the field json_extract to
      // NULL and are excluded (the desired behaviour for an equality scope).
      where.push('json_extract(metadata, ?) = ?')
      params.push(query.metadataEquals.path, query.metadataEquals.value)
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

  /**
   * Prune audit rows older than `before` (half-open: a row exactly at the
   * cutoff is kept), returning the count removed — the retention knob for a
   * table that otherwise grows one row per audited action forever. The
   * retained window stays exportable via the Phase 17 CSV/JSONL routes.
   * Host-gated OFF by default: with no retention env set this is never
   * called, and security forensics keep their full uncapped history.
   */
  pruneAuditLog(opts: { before: number }): number {
    if (!opts || typeof opts !== 'object') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'pruneAuditLog: opts object with a `before` cutoff required',
      })
    }
    if (!Number.isInteger(opts.before) || opts.before < 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `pruneAuditLog: \`before\` must be a non-negative integer; got ${String(opts.before)}`,
      })
    }
    const res = this.db.prepare('DELETE FROM audit_log WHERE ts < ?').run(opts.before)
    return Number(res.changes)
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
      // Default 1000; GOTONG_MAX_PENDING_INVITES overrides. The cap
      // guards against owner / script error blowing up the invites
      // table (audit log gets one row per attempt; admin UI 'pending'
      // tab becomes unusable; identity.sqlite grows). 1000 active
      // pending is way more than any real org needs.
      const maxPendingRaw = process.env.GOTONG_MAX_PENDING_INVITES
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

  // =====================================================================
  // Route B P1-M3b — MFA (TOTP) second factor. Delegates to TotpStore;
  // the shared secret is held as a vault entry (encrypted, rotation-safe).
  // =====================================================================

  /** Enrollment state for a user: 'none' | 'pending' | 'active'. */
  totpState(userId: string): TotpState {
    return this.totp.getState(userId)
  }

  /** True iff the user has a CONFIRMED TOTP factor (login must require it). */
  isTotpEnabled(userId: string): boolean {
    return this.totp.isEnabled(userId)
  }

  /** Begin/restart enrollment; returns the one-time QR payload. */
  enrollTotp(input: EnrollTotpInput): TotpEnrollment {
    return this.totp.enroll(input)
  }

  /** Confirm a pending enrollment with a current code (only 'pending'). */
  confirmTotp(input: VerifyTotpInput): boolean {
    return this.totp.confirm(input)
  }

  /** Verify a code at login (fail-closed: false unless active + matching). */
  verifyTotpForLogin(input: VerifyTotpInput): boolean {
    return this.totp.verifyForLogin(input)
  }

  /** Remove the second factor entirely (state row + vault secret). */
  disableTotp(userId: string): boolean {
    return this.totp.disable(userId)
  }

  // =====================================================================
  // Route B P1-M4d — OIDC identity-provider (IdP) registry. Delegates to
  // OidcProviderStore; each IdP's client_secret is a vault entry (encrypted,
  // rotation-safe). Public projections never carry the secret — only
  // readOidcClientSecret (called by the host's OIDC callback) touches it.
  // =====================================================================

  /** Register an IdP. Duplicate issuer → `oidc_provider_exists`. */
  addOidcProvider(input: AddOidcProviderInput): OidcProvider {
    return this.oidcProviders.add(input)
  }

  getOidcProvider(id: string): OidcProvider | null {
    return this.oidcProviders.get(id)
  }

  /** Lookup by issuer — the OIDC callback resolves the provider from `iss`. */
  getOidcProviderByIssuer(issuer: string): OidcProvider | null {
    return this.oidcProviders.getByIssuer(issuer)
  }

  listOidcProviders(): OidcProvider[] {
    return this.oidcProviders.list()
  }

  /** Read the client secret for the token exchange ('' = public/PKCE-only client). */
  readOidcClientSecret(id: string): string {
    return this.oidcProviders.readClientSecret(id)
  }

  /** Targeted update (issuer immutable; `clientSecret: ''` clears it). */
  updateOidcProvider(id: string, patch: UpdateOidcProviderInput): OidcProvider {
    return this.oidcProviders.update(id, patch)
  }

  /** Delete the registration and revoke its client secret. */
  removeOidcProvider(id: string): boolean {
    return this.oidcProviders.remove(id)
  }

  // =====================================================================
  // C-M2-M2 — outbound OAuth 2.0 connector registry (接入现实生活 track).
  // Delegates to OAuthConnectorStore. The hub is the CLIENT: config +
  // client_secret (vault) + an obtained token SET (vault) that the M4
  // SecretSource injects as a remote MCP connector's bearer. Public
  // projections never carry the secret or the tokens — only
  // readOAuthClientSecret / getOAuthTokenSet touch plaintext. Empty registry =
  // byte-for-byte unchanged (opt-in 用户法则).
  // =====================================================================

  /** Register a connector. Duplicate id → `oauth_connector_exists`. */
  registerOAuthConnector(input: RegisterOAuthConnectorInput): OAuthConnector {
    return this.oauthConnectors.register(input)
  }

  getOAuthConnector(id: string): OAuthConnector | null {
    return this.oauthConnectors.get(id)
  }

  listOAuthConnectors(): OAuthConnector[] {
    return this.oauthConnectors.list()
  }

  /** Read the client secret for the token exchange/refresh ('' = public/PKCE-only). */
  readOAuthClientSecret(id: string): string {
    return this.oauthConnectors.readClientSecret(id)
  }

  /** Targeted config update (id immutable; `clientSecret: ''` clears it). Tokens untouched. */
  updateOAuthConnector(id: string, patch: UpdateOAuthConnectorInput): OAuthConnector {
    return this.oauthConnectors.update(id, patch)
  }

  /** Persist a token set after the connect flow / a refresh (tokens → vault). */
  setOAuthTokenSet(id: string, tokenSet: StoredOAuthTokenSet): OAuthConnector {
    return this.oauthConnectors.setTokenSet(id, tokenSet)
  }

  /** Read the stored token set (null = not connected). Only plaintext accessor for tokens. */
  getOAuthTokenSet(id: string): StoredOAuthTokenSet | null {
    return this.oauthConnectors.getTokenSet(id)
  }

  /** Disconnect: revoke the token set, keep the config. Idempotent. */
  clearOAuthTokenSet(id: string): boolean {
    return this.oauthConnectors.clearTokenSet(id)
  }

  /** Delete the registration and revoke its client secret + token set. */
  removeOAuthConnector(id: string): boolean {
    return this.oauthConnectors.remove(id)
  }

  // =====================================================================
  // Route B P1-M5c — SAML identity-provider (IdP) registry. Delegates to
  // SamlProviderStore. Unlike OIDC there is no secret: `idpCert` is a public
  // X.509 verification cert, so projections carry it and there is no vault.
  // =====================================================================

  /** Register an IdP. Duplicate entityID → `saml_provider_exists`. */
  addSamlProvider(input: AddSamlProviderInput): SamlProvider {
    return this.samlProviders.add(input)
  }

  getSamlProvider(id: string): SamlProvider | null {
    return this.samlProviders.get(id)
  }

  /** Lookup by IdP entityID — the ACS resolves the provider from the assertion Issuer. */
  getSamlProviderByEntityId(idpEntityId: string): SamlProvider | null {
    return this.samlProviders.getByEntityId(idpEntityId)
  }

  listSamlProviders(): SamlProvider[] {
    return this.samlProviders.list()
  }

  /** Targeted update (idpEntityId immutable). */
  updateSamlProvider(id: string, patch: UpdateSamlProviderInput): SamlProvider {
    return this.samlProviders.update(id, patch)
  }

  /** Delete the registration. No secret to revoke. */
  removeSamlProvider(id: string): boolean {
    return this.samlProviders.remove(id)
  }

  // =====================================================================
  // Route B P1-M11a — outbound A2A agent registry. Delegates to A2aAgentStore.
  // No vault: the bearer the remote demands stays in env (`tokenEnv` names the
  // var), so projections are pure non-secret config.
  // =====================================================================

  /** Register an outbound A2A agent. Duplicate id → `a2a_agent_exists`. */
  addA2aAgent(input: AddA2aOutboundAgentInput): A2aOutboundAgent {
    return this.a2aAgents.add(input)
  }

  getA2aAgent(id: string): A2aOutboundAgent | null {
    return this.a2aAgents.get(id)
  }

  listA2aAgents(): A2aOutboundAgent[] {
    return this.a2aAgents.list()
  }

  /** Targeted update (id immutable — it's the participant identity). */
  updateA2aAgent(id: string, patch: UpdateA2aOutboundAgentInput): A2aOutboundAgent {
    return this.a2aAgents.update(id, patch)
  }

  /** Delete the registration. No secret to revoke (bearer lives in env). */
  removeA2aAgent(id: string): boolean {
    return this.a2aAgents.remove(id)
  }

  // =====================================================================
  // ACP-OUT-M1 — outbound ACP agent registry. Delegates to AcpAgentStore.
  // No vault and not even an env-var pointer: ACP bridges ride the underlying
  // agent's own login, so projections are pure non-secret config.
  // =====================================================================

  /** Register an outbound ACP agent. Duplicate id → `acp_agent_exists`. */
  addAcpAgent(input: AddAcpOutboundAgentInput): AcpOutboundAgent {
    return this.acpAgents.add(input)
  }

  getAcpAgent(id: string): AcpOutboundAgent | null {
    return this.acpAgents.get(id)
  }

  listAcpAgents(): AcpOutboundAgent[] {
    return this.acpAgents.list()
  }

  /** Targeted update (id immutable — it's the participant identity). */
  updateAcpAgent(id: string, patch: UpdateAcpOutboundAgentInput): AcpOutboundAgent {
    return this.acpAgents.update(id, patch)
  }

  /** Delete the registration. No secret to revoke (ACP rides the agent's login). */
  removeAcpAgent(id: string): boolean {
    return this.acpAgents.remove(id)
  }

  /**
   * Route B P0-M4c — rotate the vault master key (KEK) online. Re-wraps the
   * data key under `newMasterKey` in O(1); secret rows are untouched. The
   * caller is responsible for persisting `newMasterKey` so the next boot
   * loads it (see the host `rotate-master-key` subcommand).
   */
  rotateVaultMasterKey(newMasterKey: Buffer): void {
    this.vault.rotateMasterKey(newMasterKey)
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

  addPeer(input: AddPeerInput): PeerRegistration {
    return this.peers.addPeer(input)
  }

  getPeer(id: string): PeerRegistration | null {
    return this.peers.getPeer(id)
  }

  getPeerByPeerId(peerId: string): PeerRegistration | null {
    return this.peers.getPeerByPeerId(peerId)
  }

  listPeers(query: ListPeersQuery = {}): PeerRegistration[] {
    return this.peers.listPeers(query)
  }

  updatePeer(id: string, input: UpdatePeerInput): PeerRegistration {
    return this.peers.updatePeer(id, input)
  }

  removePeer(id: string): boolean {
    return this.peers.removePeer(id)
  }

  getPeerToken(id: string): string {
    return this.peers.getPeerToken(id)
  }

  // =====================================================================
  // B2.1 — Usage counters (per-user quota tracking). Delegated to
  // QuotaStore; signatures unchanged so callers see no difference.
  // =====================================================================

  setQuota(input: SetQuotaInput, now: number = Date.now()): UsageCounter {
    return this.quota.setQuota(input, now)
  }

  listUsage(query: GetUsageQuery): UsageCounter[] {
    return this.quota.listUsage(query)
  }

  checkAndIncrement(input: CheckAndIncrementInput): CheckAndIncrementResult {
    return this.quota.checkAndIncrement(input)
  }

  /**
   * Phase 17 — ungated monotonic usage recording (post-call token / cost
   * consumption). See {@link QuotaStore.recordUsage}: unlike
   * checkAndIncrement it always commits the increment so the budget peek
   * can fail-closed once the cap is crossed.
   */
  recordUsage(input: CheckAndIncrementInput): UsageCounter {
    return this.quota.recordUsage(input)
  }

  resetUsage(input: ResetUsageInput): UsageCounter | null {
    return this.quota.resetUsage(input)
  }

  sweepUsageCounters(now: number = Date.now()): SweepUsageResult {
    return this.quota.sweepUsageCounters(now)
  }

  // =====================================================================
  // E1 — Per-org aggregation + soft quotas. Delegated to QuotaStore.
  // =====================================================================

  sumUsage(metric: string, period: UsagePeriod, now: number = Date.now()): number {
    return this.quota.sumUsage(metric, period, now)
  }

  setOrgQuota(input: SetOrgQuotaInput, now: number = Date.now()): OrgQuota {
    return this.quota.setOrgQuota(input, now)
  }

  getOrgQuota(metric: string, period: UsagePeriod): OrgQuota | null {
    return this.quota.getOrgQuota(metric, period)
  }

  listOrgQuotas(): OrgQuota[] {
    return this.quota.listOrgQuotas()
  }

  deleteOrgQuota(metric: string, period: UsagePeriod): boolean {
    return this.quota.deleteOrgQuota(metric, period)
  }

  checkOrgQuotaThreshold(
    metric: string,
    period: UsagePeriod,
    now: number = Date.now(),
  ): CheckOrgQuotaResult {
    return this.quota.checkOrgQuotaThreshold(metric, period, now)
  }

  // =====================================================================
  // Phase 17 (Sprint 4) — Usage / cost ledger. Delegated to LedgerStore.
  // append on the post-LLM-call path; query / aggregate back the admin
  // usage dashboard + CSV/JSONL export.
  // =====================================================================

  appendLedger(input: LedgerAppendInput): LedgerEntry {
    return this.ledger.append(input)
  }

  queryLedger(query: LedgerQuery = {}): LedgerEntry[] {
    return this.ledger.query(query)
  }

  aggregateLedger(query: LedgerAggregateQuery): LedgerAggregateRow[] {
    return this.ledger.aggregate(query)
  }

  /**
   * Prune ledger rows older than `before` (Route B P0-M3-M4 retention). Returns
   * the count removed. The retained window stays exportable; `audit_log` is a
   * separate table and untouched. Host-gated OFF by default.
   */
  pruneLedger(opts: { before: number }): number {
    return this.ledger.prune(opts)
  }

  // =====================================================================
  // v5 Stream F — control-plane history (peer.summary snapshots). Delegated
  // to PeerSummarySnapshotStore. One counts-only snapshot per refresh; the
  // host projects scalar metrics out of `summaryJson` for trends + alerts.
  // identity stores the blob opaque (never parses it).
  // =====================================================================

  appendPeerSummarySnapshot(
    input: AppendPeerSummarySnapshotInput,
  ): PeerSummarySnapshot {
    return this.peerSummarySnapshots.append(input)
  }

  listPeerSummarySnapshots(
    query: PeerSummarySnapshotQuery = {},
  ): PeerSummarySnapshot[] {
    return this.peerSummarySnapshots.list(query)
  }

  /**
   * Prune snapshots older than `before` (v5 Stream F retention). Returns the
   * count removed. Host-gated OFF by default — a default deployment keeps full
   * history.
   */
  prunePeerSummarySnapshots(opts: { before: number }): number {
    return this.peerSummarySnapshots.prune(opts)
  }

  // ---- v5 Stream F — control-plane alert rules. Delegated to
  // PeerSummaryAlertRuleStore. The host evaluates these LIVE against current
  // summaries; identity only persists the rules (not firings).

  addPeerSummaryAlertRule(input: AddPeerSummaryAlertRuleInput): PeerSummaryAlertRule {
    return this.peerSummaryAlertRules.add(input)
  }

  getPeerSummaryAlertRule(id: string): PeerSummaryAlertRule | null {
    return this.peerSummaryAlertRules.get(id)
  }

  listPeerSummaryAlertRules(): PeerSummaryAlertRule[] {
    return this.peerSummaryAlertRules.list()
  }

  updatePeerSummaryAlertRule(
    id: string,
    patch: UpdatePeerSummaryAlertRuleInput,
  ): PeerSummaryAlertRule {
    return this.peerSummaryAlertRules.update(id, patch)
  }

  removePeerSummaryAlertRule(id: string): boolean {
    return this.peerSummaryAlertRules.remove(id)
  }

  // ---- v5 Stream F day-3 — control-plane alert FIRINGS (breach history).
  // Delegated to PeerSummaryAlertFiringStore. The host edge-triggers: opens a
  // firing the moment a rule breaches, resolves it when the metric falls back.
  // identity just persists the open→resolve lifecycle (counts-only, no FK).

  openPeerSummaryAlertFiring(
    input: OpenPeerSummaryAlertFiringInput,
  ): PeerSummaryAlertFiring {
    return this.peerSummaryAlertFirings.open(input)
  }

  /** Currently-firing rows (resolved_at IS NULL) — the edge-trigger differ's input. */
  listOpenPeerSummaryAlertFirings(): PeerSummaryAlertFiring[] {
    return this.peerSummaryAlertFirings.listOpen()
  }

  /** Firing history, newest first, with optional source / ruleId / state / window filters. */
  listPeerSummaryAlertFirings(
    query: PeerSummaryAlertFiringQuery = {},
  ): PeerSummaryAlertFiring[] {
    return this.peerSummaryAlertFirings.list(query)
  }

  /** Mark a firing resolved (metric fell back). Idempotent; missing id → throws. */
  resolvePeerSummaryAlertFiring(
    id: number,
    opts: { resolvedAt?: number } = {},
  ): PeerSummaryAlertFiring {
    return this.peerSummaryAlertFirings.resolve(id, opts)
  }

  /**
   * Prune RESOLVED firings older than `before` (v5 Stream F day-3 retention).
   * Open firings are never pruned. Host-gated OFF by default.
   */
  prunePeerSummaryAlertFirings(opts: { before: number }): number {
    return this.peerSummaryAlertFirings.prune(opts)
  }

  // ---- v5 Stream F day-3 — control-plane alert notification CHANNELS.
  // Delegated to PeerSummaryAlertChannelStore. A channel is a destination + a
  // toggle (webhook MVP, kind-extensible); NO secret in the row — `headerEnv`
  // is an env-var NAME the host reads at delivery time.

  addPeerSummaryAlertChannel(input: AddPeerSummaryAlertChannelInput): PeerSummaryAlertChannel {
    return this.peerSummaryAlertChannels.add(input)
  }

  getPeerSummaryAlertChannel(id: string): PeerSummaryAlertChannel | null {
    return this.peerSummaryAlertChannels.get(id)
  }

  listPeerSummaryAlertChannels(): PeerSummaryAlertChannel[] {
    return this.peerSummaryAlertChannels.list()
  }

  updatePeerSummaryAlertChannel(
    id: string,
    patch: UpdatePeerSummaryAlertChannelInput,
  ): PeerSummaryAlertChannel {
    return this.peerSummaryAlertChannels.update(id, patch)
  }

  removePeerSummaryAlertChannel(id: string): boolean {
    return this.peerSummaryAlertChannels.remove(id)
  }

  // =====================================================================
  // v5 A-M1 — unified resource grants (resource-level RBAC, ownership MVP).
  // One row per (resourceKind, resourceId, principal); the owner is the
  // perm='owner' row (owner-as-grant). `hasResourceGrant` is the hot-path
  // enforcement check. Delegated to ResourceGrantStore.
  // =====================================================================

  setResourceGrant(input: SetResourceGrantInput): ResourceGrant {
    return this.resourceGrants.set(input)
  }

  getResourceGrant(
    resourceKind: ResourceKind,
    resourceId: string,
    principal: Principal,
  ): ResourceGrant | null {
    return this.resourceGrants.get(resourceKind, resourceId, principal)
  }

  hasResourceGrant(
    resourceKind: ResourceKind,
    resourceId: string,
    principal: Principal,
    min: GrantPerm,
  ): boolean {
    return this.resourceGrants.has(resourceKind, resourceId, principal, min)
  }

  listResourceGrants(resourceKind: ResourceKind, resourceId: string): ResourceGrant[] {
    return this.resourceGrants.listForResource(resourceKind, resourceId)
  }

  listPrincipalGrants(principal: Principal): ResourceGrant[] {
    return this.resourceGrants.listForPrincipal(principal)
  }

  removeResourceGrant(
    resourceKind: ResourceKind,
    resourceId: string,
    principal: Principal,
  ): boolean {
    return this.resourceGrants.remove(resourceKind, resourceId, principal)
  }

  removeAllResourceGrants(resourceKind: ResourceKind, resourceId: string): number {
    return this.resourceGrants.removeAllForResource(resourceKind, resourceId)
  }

  // ---------------------------------------------------------------------
  // Phase 19 P2-M5 workflow-grant compatibility facade. The web RBAC routes
  // still speak "workflow grant for a user"; here that is just a resource
  // grant with resourceKind='workflow' and a user principal. Kept as a thin
  // mapping so callers need not learn the principal codec for the common case.
  // ---------------------------------------------------------------------

  setWorkflowGrant(input: SetWorkflowGrantInput): WorkflowGrant {
    const g = this.resourceGrants.set({
      resourceKind: 'workflow',
      resourceId: input.workflowId,
      principal: userPrincipal(input.userId),
      perm: input.perm,
      grantedBy: input.grantedBy,
      grantedAt: input.grantedAt,
    })
    return resourceGrantToWorkflowGrant(g)
  }

  hasWorkflowGrant(
    workflowId: string,
    userId: string,
    min: WorkflowPerm,
  ): boolean {
    return this.resourceGrants.has('workflow', workflowId, userPrincipal(userId), min)
  }

  listWorkflowGrants(workflowId: string): WorkflowGrant[] {
    // Only user principals carry a userId; a workflow granted to an agent/peer
    // is invisible to this legacy view (it has no userId to report).
    return this.resourceGrants
      .listForResource('workflow', workflowId)
      .filter((g) => g.principal.kind === 'user')
      .map(resourceGrantToWorkflowGrant)
  }

  removeWorkflowGrant(workflowId: string, userId: string): boolean {
    return this.resourceGrants.remove('workflow', workflowId, userPrincipal(userId))
  }

  removeAllWorkflowGrants(workflowId: string): number {
    return this.resourceGrants.removeAllForResource('workflow', workflowId)
  }

  // ---------------------------------------------------------------------
  // v5 E4-M1 — agent-grant facade. Exact mirror of the workflow facade above:
  // the agent admin RBAC routes speak "agent grant for a user" = a resource
  // grant with resourceKind='agent' + a user principal. Kept thin so the web
  // layer (no identity dep) need not construct a Principal.
  // ---------------------------------------------------------------------

  setAgentGrant(input: SetAgentGrantInput): AgentGrant {
    const g = this.resourceGrants.set({
      resourceKind: 'agent',
      resourceId: input.agentId,
      principal: userPrincipal(input.userId),
      perm: input.perm,
      grantedBy: input.grantedBy,
      grantedAt: input.grantedAt,
    })
    return resourceGrantToAgentGrant(g)
  }

  hasAgentGrant(agentId: string, userId: string, min: WorkflowPerm): boolean {
    return this.resourceGrants.has('agent', agentId, userPrincipal(userId), min)
  }

  listAgentGrants(agentId: string): AgentGrant[] {
    // Only user principals carry a userId; an agent granted to an agent/peer
    // principal is invisible to this legacy view (it has no userId to report).
    return this.resourceGrants
      .listForResource('agent', agentId)
      .filter((g) => g.principal.kind === 'user')
      .map(resourceGrantToAgentGrant)
  }

  removeAgentGrant(agentId: string, userId: string): boolean {
    return this.resourceGrants.remove('agent', agentId, userPrincipal(userId))
  }

  removeAllAgentGrants(agentId: string): number {
    return this.resourceGrants.removeAllForResource('agent', agentId)
  }

  // =====================================================================
  // Phase 11 M2 — Suspended tasks (long-running agent park/resume).
  // =====================================================================

  persistSuspendedTask(input: PersistSuspendedTaskInput): void {
    this.suspendedTasks.persistSuspendedTask(input)
  }

  removeSuspendedTask(taskId: string): number {
    return this.suspendedTasks.removeSuspendedTask(taskId)
  }

  getSuspendedTask(taskId: string): SuspendedTask | null {
    return this.suspendedTasks.getSuspendedTask(taskId)
  }

  listDueSuspendedTasks(query: ListDueSuspendedTasksQuery = {}): SuspendedTask[] {
    return this.suspendedTasks.listDueSuspendedTasks(query)
  }

  listSuspendedTasksByAgent(agentId: string): SuspendedTask[] {
    return this.suspendedTasks.listSuspendedTasksByAgent(agentId)
  }

  /** Phase 19 P3-M1 — total parked-task count for the `/metrics` gauge. */
  countSuspendedTasks(): number {
    return this.suspendedTasks.countSuspendedTasks()
  }

  /** R9 — atomically claim a due suspended row before resuming it. */
  claimSuspendedTask(taskId: string, claimedAt: number): boolean {
    return this.suspendedTasks.claimSuspendedTask(taskId, claimedAt)
  }

  /** R9 — reset claims older than `olderThan` (crashed claimants). */
  reclaimStaleSuspendedClaims(olderThan: number): number {
    return this.suspendedTasks.reclaimStaleSuspendedClaims(olderThan)
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
   * same transaction; returns the resolved Gotong user id + binding.
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
   * the IM identity back to an Gotong user id. Returns `null` for
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

// v5 A-M1 — project a unified ResourceGrant back to the legacy WorkflowGrant
// shape. Caller has already constrained to resourceKind='workflow' + a user
// principal, so principal.id is the userId.
function resourceGrantToWorkflowGrant(g: ResourceGrant): WorkflowGrant {
  return {
    workflowId: g.resourceId,
    userId: g.principal.id,
    perm: g.perm,
    grantedBy: g.grantedBy,
    grantedAt: g.grantedAt,
  }
}

// v5 E4-M1 — project a unified ResourceGrant back to the AgentGrant shape.
// Caller has already constrained to resourceKind='agent' + a user principal.
function resourceGrantToAgentGrant(g: ResourceGrant): AgentGrant {
  return {
    agentId: g.resourceId,
    userId: g.principal.id,
    perm: g.perm,
    grantedBy: g.grantedBy,
    grantedAt: g.grantedAt,
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
  // Route B P0-M1 — namespace is metadata; a light non-empty-string guard is
  // enough here (identity never builds paths from it, so full charset
  // validation lives in core's `assertTenantId` at the path-resolving seam).
  if (
    input.namespace !== undefined &&
    (typeof input.namespace !== 'string' || input.namespace.length === 0)
  ) {
    throw new TypeError(
      `namespace must be a non-empty string when provided; got ${JSON.stringify(input.namespace)}`,
    )
  }
  const db = openDb(input.dbPath)
  applyMigrations(db)
  return new IdentityStore(db, ttl, input.masterKey, input.namespace ?? DEFAULT_NAMESPACE)
}
