/**
 * /api/admin/identity/* — v4 user-management routes.
 *
 * Layered on `IdentitySurface` (a structural projection of
 * @gotong/identity's IdentityStore, defined in server.ts). The host
 * wires the real `IdentityStore` instance into `serveWeb({ identity })`
 * and structural typing lets it slot in without the web package
 * taking a runtime dep on @gotong/identity.
 *
 * # Auth gates
 *
 * Every route requires **owner** role on the host's organisation.
 * Owner is established by a v4 IdentityStore session cookie
 * (`gotong_identity`) OR a v4 Bearer api_key / admin_token whose
 * resolved role is `owner`. The legacy v3 admin path (Space.admins
 * cookie / `/admin?token=...` URL) was removed in A2.2 — host-level
 * admin routes (agents, secrets, workflows) still accept v3 admin
 * because they predate IdentityStore, but the v4 identity surface
 * does not.
 *
 * Non-owner roles can authenticate (POST /login) but cannot manage
 * other users. The intent is that Phase 3+ will add lower-privilege
 * surfaces (member dashboards, viewer-only reports) on different
 * route prefixes.
 *
 * # Route inventory
 *
 *   POST   /api/admin/identity/login                { email, password }
 *   POST   /api/admin/identity/logout
 *   GET    /api/admin/identity/me
 *   GET    /api/admin/identity/users
 *   POST   /api/admin/identity/users                { email, displayName?, password?, role? }
 *   PATCH  /api/admin/identity/users/:id            { role?, password? }
 *   GET    /api/admin/identity/users/:id/credentials
 *   POST   /api/admin/identity/users/:id/api-key    { label? }  → { key }  (shown ONCE)
 *   DELETE /api/admin/identity/credentials/:id
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBearer, readCookie, readJsonBody, sendJson } from './http-helpers.js'
import {
  parseExportFormat,
  sendExport,
  toCsv,
  toJsonl,
  type CsvColumn,
} from './export-format.js'
import {
  handleUsageLedgerExport,
  handleUsageLedgerList,
  handleUsageSummary,
  type UsageLedgerAggregateRowDTO,
  type UsageLedgerEntryDTO,
  type UsageLedgerGroupBy,
} from './usage-routes.js'

// Audit #155 — the reputation snapshot row shape is owned by
// @gotong/core (where the EWMA store lives). Web extends rather than
// re-declares so a new field in core flows through automatically.
import type { PeerReputation } from '@gotong/core'

// ---------------------------------------------------------------------------
// Structural projection of @gotong/identity. Web depends on these
// types, NOT on the package. The host passes its real IdentityStore;
// structural typing lets it slot in.
// ---------------------------------------------------------------------------

export type IdentityRole = 'owner' | 'admin' | 'member' | 'viewer'

const ROLE_RANK: Record<IdentityRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
}

function roleAtLeast(actual: IdentityRole, required: IdentityRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required]
}

export interface IdentityUserDTO {
  id: string
  email: string
  displayName: string | null
  createdAt: number
  lastLoginAt: number | null
}
export interface IdentitySessionDTO {
  token: string
  userId: string
  expiresAt: number
  createdAt: number
  lastSeenAt: number
}
export interface IdentityCredentialDTO {
  id: string
  userId: string
  // Mirrors @gotong/identity CredentialKind. 'oidc' (Route B P1-M4a) and
  // 'saml' (P1-M5b) are external-IdP links with no replayable secret — listed
  // like any other credential so a member/admin can see & revoke their SSO
  // connections.
  kind: 'password' | 'admin_token' | 'api_key' | 'oidc' | 'saml'
  identifier: string
  label: string | null
  createdAt: number
  lastUsedAt: number | null
}

// V4-AUDIT-06: structural projection of @gotong/identity's
// AuditLogEntry / AuditActorSource. Kept here so web stays decoupled.
// FED-M4: `'federated'` added for actions triggered by federated tasks
// (Task.origin set); writer is expected to stash origin in metadata.
// A2.2: 'v3-admin' removed from writable vocabulary — v4 IdentityStore
// is the only auth surface this route consumes. Old rows persisted
// with 'v3-admin' are clamped to 'system' by the store on read.
export type IdentityAuditActorSource =
  | 'v4-session'
  | 'v4-bearer'
  | 'anonymous'
  | 'system'
  | 'federated'

export interface IdentityAuditLogEntryDTO {
  id: string
  ts: number
  actorUserId: string | null
  actorSource: IdentityAuditActorSource
  action: string
  targetUserId: string | null
  targetCredentialId: string | null
  ip: string | null
  userAgent: string | null
  metadata: Record<string, unknown> | null
  success: boolean
}

// Phase 3 — invitation flow. Structural projection of @gotong/identity's
// Invitation + InvitationStatus, kept here so web stays decoupled.
export type IdentityInvitationStatus =
  | 'pending'
  | 'accepted'
  | 'revoked'
  | 'expired'

/**
 * D1 — peer registry DTO. Mirrors `PeerRegistration` from
 * `@gotong/identity` structurally; web never imports the package
 * directly, so we declare the shape here.
 */
// Phase 18 B-M1/B-M2 — per-peer cross-org policy (duck-typed mirrors of
// the identity types; web keeps zero identity runtime dep).
export type PeerKind = 'personal' | 'organization' | 'project' | 'service'
const PEER_KINDS: readonly PeerKind[] = ['personal', 'organization', 'project', 'service']
// Phase 19 P4-M4 — per-link revocation. A revoked peer is refused at every
// connection gate (no dial, inbound HELLO rejected, live link torn down).
export type PeerRevocationState = 'active' | 'revoked'
const PEER_REVOCATION_STATES: readonly PeerRevocationState[] = ['active', 'revoked']
export interface PeerInboundAcl {
  capabilities?: string[]
  requireOrigin?: boolean
  requireOriginRole?: string[]
}

export interface IdentityPeerDTO {
  id: string
  peerId: string
  endpointUrl: string
  label: string | null
  enabled: boolean
  vaultEntryId: string
  createdAt: number
  updatedAt: number
  // Phase 18 B-M1 policy fields (always present from a v12 store).
  kind: PeerKind
  acl: PeerInboundAcl | null
  outboundCaps: string[] | null
  requireApprovalOutbound: boolean
  // Phase 19 P4-M4 per-link trust contract (always present from a v15 store).
  revocationState: PeerRevocationState
  perLinkQuotaBudget: number | null
  allowedDataClasses: string[] | null
  // v5 C-M1 callable-knowledge-base allowlist (always present from a v17 store).
  allowedKnowledgeBases: string[] | null
  // v5 E5 — opt-in to expose a privacy-safe footprint summary over peer.summary
  // (always present from a v23 store; default false = fail-closed).
  shareSummary: boolean
  // v5 Stream G day-5 — opt-in to answer this peer's `peer.transcript` rpc with
  // the slice of one cross-hub task's trace (always present from a v27 store;
  // default false = fail-closed). Reveals more than the summary's counts.
  shareTranscript: boolean
  // STD-M2b — owner-pinned signing-key thumbprint, the out-of-band trust anchor
  // for this peer's signed A2A card (always present from a v35 store; null = no
  // anchor). Advisory only: a mismatch on the live card flags but never blocks.
  pinnedKid: string | null
}

export interface IdentityOrgQuotaDTO {
  metric: string
  period: 'hourly' | 'daily' | 'monthly' | 'total'
  quota: number
  warnPct: number
  lastState: 'ok' | 'warn' | 'over'
  lastChecked: number | null
  createdAt: number
  updatedAt: number
}

// Phase 6 #1 — peer reputation read-only dashboard projection. The
// reputation store lives in `@gotong/core` (hub.reputation) and is NOT
// part of IdentitySurface — it's injected via `HandleIdentityRouteCtx`
// from the host, same pattern as `peerRegistry`. The DTO is enriched
// with an optional `label` joined from the identity peers table when
// available; pure feedback-driven peers (no peers-row) just show the
// peerHubId.
/**
 * Audit #155 — the snapshot shape comes from `@gotong/core`'s
 * `PeerReputation`; we only ADD `label` (joined from identity.peers
 * for display). Extending instead of re-declaring means future core
 * additions (eg. trend, variance) appear here automatically with
 * no code change.
 */
export interface IdentityPeerReputationDTO extends PeerReputation {
  /** Display label from `peers` table; null if the peer is unknown. */
  label: string | null
}

export interface IdentityInvitationDTO {
  id: string
  email: string
  role: IdentityRole
  invitedBy: string | null
  displayName: string | null
  expiresAt: number
  status: IdentityInvitationStatus
  createdAt: number
  acceptedAt: number | null
  acceptedUserId: string | null
}

export interface IdentityResolved {
  user: IdentityUserDTO
  role: IdentityRole
  session: IdentitySessionDTO
}

export interface IdentitySurface {
  authenticatePassword(opts: {
    email: string
    password: string
    // Route B P1-M3d — optional second factor. When the user has an ACTIVE
    // TOTP enrollment, omitting this makes identity throw `totp_required`;
    // the caller re-prompts and retries with the code.
    totpCode?: string
    ttlMs?: number
  }): IdentitySessionDTO
  authenticateToken(opts: { token: string; ttlMs?: number }): IdentitySessionDTO
  getSessionByToken(token: string): IdentityResolved | null
  revokeSession(token: string): void
  listUsers(): IdentityUserDTO[]
  getUserById(id: string): IdentityUserDTO | null
  createUser(input: {
    email: string
    displayName?: string | null
    password?: string
    role?: IdentityRole
  }): IdentityUserDTO
  getMembership(userId: string): { role: IdentityRole } | null
  setRole(userId: string, role: IdentityRole): { role: IdentityRole }
  setPassword(userId: string, password: string): void
  issueApiKey(opts: { userId: string; label?: string }): {
    key: string
    credentialId: string
  }
  listCredentials(userId: string): IdentityCredentialDTO[]
  revokeCredential(credentialId: string): void
  // Route B P1-M3e — MFA (TOTP) self-service. All optional so surfaces / test
  // stubs that predate MFA still typecheck; the /me TOTP routes check
  // `typeof identity.enrollTotp === 'function'` and 503 when absent.
  totpState?(userId: string): 'none' | 'pending' | 'active'
  enrollTotp?(input: { userId: string; account: string; issuer: string }): {
    secretBase32: string
    otpauthUri: string
  }
  confirmTotp?(input: { userId: string; code: string }): boolean
  verifyTotpForLogin?(input: { userId: string; code: string }): boolean
  disableTotp?(userId: string): boolean
  // D1 — Peer registry. All four optional so older identity surfaces
  // (and tests that stub the interface) continue to typecheck; the
  // route handlers do `typeof identity.addPeer === 'function'` checks
  // before invoking and return 503 when the surface predates D1.
  addPeer?(input: {
    peerId: string
    endpointUrl: string
    label?: string | null
    peerToken: string
    kind?: PeerKind
    acl?: PeerInboundAcl | null
    outboundCaps?: string[] | null
    requireApprovalOutbound?: boolean
    revocationState?: PeerRevocationState
    perLinkQuotaBudget?: number | null
    allowedDataClasses?: string[] | null
    allowedKnowledgeBases?: string[] | null
    shareSummary?: boolean
    shareTranscript?: boolean
    pinnedKid?: string | null
  }): IdentityPeerDTO
  listPeers?(): IdentityPeerDTO[]
  updatePeer?(
    id: string,
    input: {
      label?: string | null
      enabled?: boolean
      peerToken?: string
      endpointUrl?: string
      kind?: PeerKind
      acl?: PeerInboundAcl | null
      outboundCaps?: string[] | null
      requireApprovalOutbound?: boolean
      revocationState?: PeerRevocationState
      perLinkQuotaBudget?: number | null
      allowedDataClasses?: string[] | null
      allowedKnowledgeBases?: string[] | null
      shareSummary?: boolean
      shareTranscript?: boolean
      pinnedKid?: string | null
    },
  ): IdentityPeerDTO
  removePeer?(id: string): boolean
  // E1 — Org soft quotas. All optional for the same reason as the D1
  // methods above; route handlers check `typeof identity.listOrgQuotas
  // === 'function'` and 503 when missing.
  listOrgQuotas?(): IdentityOrgQuotaDTO[]
  setOrgQuota?(input: {
    metric: string
    period: 'hourly' | 'daily' | 'monthly' | 'total'
    quota: number
    warnPct?: number
  }): IdentityOrgQuotaDTO
  getOrgQuota?(
    metric: string,
    period: 'hourly' | 'daily' | 'monthly' | 'total',
  ): IdentityOrgQuotaDTO | null
  deleteOrgQuota?(
    metric: string,
    period: 'hourly' | 'daily' | 'monthly' | 'total',
  ): boolean
  sumUsage?(
    metric: string,
    period: 'hourly' | 'daily' | 'monthly' | 'total',
    now?: number,
  ): number
  // V4-AUDIT-06 — audit log surface. Both methods are optional on the
  // structural type so older host wirings (an IdentityStore that
  // predates the migration) still typecheck. In practice the host
  // either has a current `@gotong/identity` (both methods present)
  // or doesn't wire `identity` at all (the route stays 503).
  writeAuditLog?(input: {
    action: string
    actorSource: IdentityAuditActorSource
    actorUserId?: string | null
    targetUserId?: string | null
    targetCredentialId?: string | null
    ip?: string | null
    userAgent?: string | null
    metadata?: Record<string, unknown> | null
    success?: boolean
  }): IdentityAuditLogEntryDTO
  listAuditLog?(query?: {
    limit?: number
    offset?: number
    action?: string
    // P2-M3 — generic audit filters (mirror @gotong/identity's
    // ListAuditLogQuery). Used by the workflow-audit view to pull all five
    // workflow actions in a bounded time window, scoped to one workflowId.
    actions?: string[]
    targetUserId?: string
    success?: boolean
    since?: number
    until?: number
    metadataEquals?: { path: string; value: string }
  }): IdentityAuditLogEntryDTO[]
  // Phase 17 — usage / cost ledger. Optional like the audit methods: a
  // pre-migration IdentityStore lacks them, so the routes degrade to an
  // empty result instead of 500.
  queryLedger?(query: {
    orgId?: string
    userId?: string
    agentId?: string
    workflowId?: string
    model?: string
    since?: number
    until?: number
    limit?: number
    offset?: number
  }): UsageLedgerEntryDTO[]
  aggregateLedger?(query: {
    groupBy: UsageLedgerGroupBy
    since?: number
    until?: number
    orgId?: string
    userId?: string
  }): UsageLedgerAggregateRowDTO[]
  // Phase 3 — invitation flow. Optional on the structural type for the
  // same reason as the audit-log methods above: a pre-migration host's
  // IdentityStore still typechecks; the routes refuse with 503 at runtime
  // when the method is missing.
  createInvitation?(input: {
    email: string
    role?: IdentityRole
    displayName?: string
    invitedBy?: string | null
    ttlMs?: number
  }): { token: string; invitation: IdentityInvitationDTO }
  getInvitationByToken?(token: string): IdentityInvitationDTO | null
  acceptInvitation?(input: {
    token: string
    password: string
    displayName?: string
    sessionTtlMs?: number
  }): {
    user: IdentityUserDTO
    session: IdentitySessionDTO
    invitation: IdentityInvitationDTO
  }
  listInvitations?(query?: {
    status?: IdentityInvitationStatus
    email?: string
    limit?: number
    offset?: number
  }): IdentityInvitationDTO[]
  revokeInvitation?(id: string): IdentityInvitationDTO
  // Audit #156 — count of active+pending invites. Powers the admin UI
  // "X / 1000 invites used" sidebar so operators see the cap pressure
  // before hitting `invitations_limit_exceeded`. Optional for the same
  // reason as the methods above: a pre-Phase-6 host's IdentityStore
  // would lack it, route 503s in that case.
  countActivePendingInvitations?(now?: number): number
  // Phase 7 M4 — org mode (personal | team). Drives the SPA shell
  // (body class) + UI hints (role badge visibility, upgrade button).
  // Optional for pre-Phase-7 hosts; SPA defaults to 'team' when
  // missing so legacy behaviour is preserved.
  getOrgMode?(): 'personal' | 'team'
  setOrgMode?(mode: 'personal' | 'team'): void
  // Ease-of-use ②-M1 — org-scope vault writes for the first-run wizard's
  // optional steps (setup-routes `/api/setup/owner-llm-key` LLM key;
  // DEPLOY-B2 `/api/setup/owner-im` IM bot credential — same gates, second
  // kind). Optional like the audit/peer methods above: a pre-vault
  // IdentityStore lacks them and the route 503s. The real IdentityStore
  // satisfies these structurally — same narrow shapes host's
  // steward-sensitive executor duck-types. The return is the structural
  // subset the wizard reads (the real store returns a wider VaultEntry,
  // which is assignable).
  createVaultEntry?(input: {
    kind: 'llm_provider' | 'im_bridge'
    ownerKind: 'org'
    ownerId: null
    secret: string
    label?: string | null
    metadata?: Record<string, unknown> | null
  }): VaultEntryLike
  listVaultEntries?(query: {
    kind?: 'llm_provider' | 'im_bridge'
    ownerKind?: 'org'
    ownerId?: string | null
    activeOnly?: boolean
  }): VaultEntryLike[]
  revokeVaultEntry?(id: string): boolean
}

/** The vault-row fields the setup wizard reads — a structural subset of the
 *  identity store's `VaultEntry`, so web needn't import @gotong/identity. */
export interface VaultEntryLike {
  id: string
  metadata: Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// Identity cookie builders. The generic IO helpers (readCookie / readBearer
// / readJsonBody / sendJson) moved to ./http-helpers.js in the C3 cleanup;
// what stays here is the identity-specific cookie construction.
// ---------------------------------------------------------------------------

export const IDENTITY_COOKIE = 'gotong_identity'
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 7 // 7 days; mirrors IdentityStore default TTL

// Exported so the OIDC login routes (oidc-routes.ts) mint the SAME identity
// cookie a password login does — one cookie format, one place to change it.
export function setIdentityCookie(value: string, secure: boolean): string {
  const sameSite = secure ? 'Strict' : 'Lax'
  const sec = secure ? '; Secure' : ''
  return `${IDENTITY_COOKIE}=${value}; HttpOnly; SameSite=${sameSite}${sec}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`
}
function expireIdentityCookie(secure: boolean): string {
  const sameSite = secure ? 'Strict' : 'Lax'
  const sec = secure ? '; Secure' : ''
  return `${IDENTITY_COOKIE}=; HttpOnly; SameSite=${sameSite}${sec}; Path=/; Max-Age=0`
}

// ---------------------------------------------------------------------------
// IdentityError mapping. Web has no compile-time access to the class
// (no import of @gotong/identity) so we check structurally on the
// `code` field which is stable contract.
// ---------------------------------------------------------------------------

interface ErrorWithCode {
  code: string
  message: string
}
function asErrorWithCode(err: unknown): ErrorWithCode | null {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return err as ErrorWithCode
  }
  return null
}

function sendIdentityError(res: ServerResponse, err: unknown, fallbackStatus = 500): void {
  const ec = asErrorWithCode(err)
  if (!ec) {
    sendJson(res, { error: 'internal error' }, fallbackStatus)
    return
  }
  switch (ec.code) {
    case 'duplicate_email':
    case 'duplicate_credential':
    case 'last_owner': // V4-AUDIT-03: refusing to demote the last owner is a 409 conflict
    case 'invitation_pending_exists': // same family — "you already have one of these"
    case 'invitations_limit_exceeded': // Phase 6 #9 — hard cap; revoke or wait
      sendJson(res, { error: ec.message, code: ec.code }, 409)
      return
    case 'invalid_email':
    case 'invalid_role':
    case 'invalid_input':
    case 'weak_password':
      sendJson(res, { error: ec.message, code: ec.code }, 400)
      return
    case 'authentication_failed':
    case 'session_expired':
    case 'session_not_found':
      sendJson(res, { error: ec.message, code: ec.code }, 401)
      return
    case 'user_not_found':
    case 'credential_not_found':
    case 'invitation_not_found':
    // Audit #144 — these were falling through to 500. 404 is the
    // semantic status for "row doesn't exist by that id".
    case 'peer_not_found':
    case 'org_quota_not_found':
    case 'vault_entry_not_found':
      sendJson(res, { error: ec.message, code: ec.code }, 404)
      return
    // 410 Gone: the invitation existed but is no longer valid. Distinct
    // from 404 (never existed) so the UI can render "this link has been
    // used / expired / revoked" instead of "not found".
    case 'invitation_expired':
    case 'invitation_already_used':
    case 'invitation_revoked':
      sendJson(res, { error: ec.message, code: ec.code }, 410)
      return
    // Audit #144 — `peer_id_taken` is a UNIQUE-constraint conflict on
    // peers.peer_id during addPeer; it's a 409 just like duplicate_email.
    case 'peer_id_taken':
      sendJson(res, { error: ec.message, code: ec.code }, 409)
      return
    // Audit #144 — vault not configured = the IdentityStore was opened
    // without a masterKey, so vault APIs refuse. 503 (service unavailable)
    // signals "this functionality is dependent on a configured component
    // that isn't there", which an operator's monitoring will surface
    // distinctly from "server error".
    case 'vault_not_configured':
      sendJson(res, { error: ec.message, code: ec.code }, 503)
      return
    // Audit #144 — vault_decrypt_failed is a true server-side error
    // (master key wrong, or row tampered). Map to 500 explicitly so the
    // intent is visible at the route layer instead of "happens to be 500
    // because the switch fell through". Code is intentionally opaque to
    // the client (see errors.ts) — body just carries the static message.
    case 'vault_decrypt_failed':
      sendJson(res, { error: ec.message, code: ec.code }, 500)
      return
    default:
      sendJson(res, { error: ec.message, code: ec.code }, fallbackStatus)
  }
}

// ---------------------------------------------------------------------------
// Auth resolution. `resolveAuth` returns the active principal (if any)
// from a request. Owner inference for v3 admins happens in the caller
// (handleIdentityRoute), where we know the v3 admin record.
// ---------------------------------------------------------------------------

export interface ResolvedAuth {
  /** Always present. */
  source: 'v4-session' | 'v4-bearer' | 'none'
  user: IdentityUserDTO | null
  role: IdentityRole | null
  /**
   * Only set for v4-session — used so logout knows what to revoke.
   * For v4-bearer (api_key / admin_token via Authorization) we mint a
   * transient session for the request; that token is NOT returned.
   */
  v4SessionToken?: string
}

/**
 * Resolve the v4 identity attached to a request. A2.2 — v4 IdentityStore
 * is the sole source of identity; the legacy v3-admin layer no longer
 * participates in `/api/admin/identity/*` auth.
 */
export function resolveV4Auth(
  identity: IdentitySurface,
  req: IncomingMessage,
): ResolvedAuth {
  // 1. v4 session cookie — cheapest path, hot for browser admin UI.
  const sessTok = readCookie(req, IDENTITY_COOKIE)
  if (sessTok) {
    const r = identity.getSessionByToken(sessTok)
    if (r) {
      return {
        source: 'v4-session',
        user: r.user,
        role: r.role,
        v4SessionToken: sessTok,
      }
    }
  }
  // 2. Bearer api_key / admin_token via Authorization header.
  const bearer = readBearer(req)
  if (bearer && (bearer.startsWith('aipk_') || bearer.startsWith('adm_'))) {
    try {
      // V4-AUDIT-04: Bearer auth amplifies session rows — every API
      // call mints a fresh row. Cap the TTL at 60s so the rows churn
      // out quickly, then pair with cleanupExpiredSessions on the
      // host (V4-AUDIT-05) for steady-state bounded DB size.
      const sess = identity.authenticateToken({ token: bearer, ttlMs: 60_000 })
      const r = identity.getSessionByToken(sess.token)
      if (r) return { source: 'v4-bearer', user: r.user, role: r.role }
    } catch {
      // fall through to 'none'
    }
  }
  return { source: 'none', user: null, role: null }
}

// ---------------------------------------------------------------------------
// Route dispatcher. Called from server.ts when path starts with
// `/api/admin/identity/`. Owner gate lives here, not in each route, so
// adding a new route never accidentally forgets the gate.
// ---------------------------------------------------------------------------

/**
 * Minimal projection of the per-IP rate limiter shared with v3 admin
 * paths (server.ts exposes `RateLimiter`). V4-AUDIT-01 fix — login is
 * the one identity route any anonymous caller can hit, and its body
 * triggers a scrypt verify (~50-100ms each), so spray attacks need a
 * brake. We reuse the v3 limiter instance under a different key
 * namespace (`identity-login:`) so an attacker cannot side-step the
 * v3 budget by switching endpoints.
 */
export interface LoginRateLimiterLike {
  peek(key: string): boolean
  recordFailure(key: string): void
  /**
   * Single-call peek + record-on-allow. Use for endpoints where every
   * SUCCESSFUL action should count (e.g. /me/dispatch — every dispatch
   * spawns a workflow, so the cap is on action volume, not on attacks).
   * Returns true if allowed (and the hit was recorded), false if over
   * budget (no hit recorded).
   */
  check(key: string): boolean
}

export interface HandleIdentityRouteCtx {
  identity: IdentitySurface
  cookieSecure: boolean
  /** Per-IP rate limiter; required for V4-AUDIT-01 protection. */
  loginLimiter: LoginRateLimiterLike
  /**
   * Resolved client IP from the request, used as the limiter key. The
   * caller (server.ts) computes this with its existing `clientIp()`
   * helper which respects `trustProxy` for the X-Forwarded-For header.
   */
  clientIp: string
  /**
   * Raw `User-Agent` header, stored on audit-log rows (V4-AUDIT-06).
   * Optional — empty / missing → audit row records null. Caller (server.ts)
   * passes `req.headers['user-agent']` directly; we clamp the length
   * before persisting to keep the row size bounded.
   */
  userAgent?: string
  /**
   * D1 — host's live peer registry. When set, peer write handlers
   * call `invalidate()` after each mutation to force an immediate
   * reconciliation tick (skipping the 5s poll). `status()` augments
   * the GET response with per-row connection state. Optional — web
   * works without it; admin UI just sees `connected: undefined`.
   */
  peerRegistry?: {
    invalidate(): void
    /**
     * Phase 18 B-M2 — re-apply a peer's policy by tearing down + redialing
     * its live link. A plain `invalidate()` won't re-gate an already-
     * connected peer (tick keeps the existing link), so the patch handler
     * calls this when a policy/endpoint field changed. Optional so an
     * older host registry (invalidate-only) still satisfies the surface;
     * the handler falls back to invalidate when it's absent.
     */
    refreshPolicy?(peerRowId: string): void
    status(): Array<{
      peerRowId: string
      peerId: string
      label: string | null
      endpointUrl: string
      connected: boolean
      backoffAttempts: number
      /**
       * REL-3 — epoch-ms of the most recent frame from this peer, or
       * null when not connected. Optional so an older host registry
       * without keepalive still satisfies the surface.
       */
      lastSeenAt?: number | null
    }>
  }
  /**
   * Phase 6 #1 — reputation snapshot read-only hook. Host wires
   * `hub.reputation.all()` + `identity.listPeers()` label join here.
   * When omitted, GET /api/admin/identity/reputation returns 503
   * (admin UI hides the tab in that case).
   */
  reputation?: {
    snapshot(): IdentityPeerReputationDTO[]
  }
}

// V4-AUDIT-06: User-Agent is attacker-controlled; cap it before persisting
// so a 50KB header can't blow up audit rows. The clamp is sized to fit a
// realistic worst-case browser UA (~250 chars on Edge / Chrome variants)
// plus margin.
const MAX_AUDIT_UA_LEN = 512

function clampUserAgent(ua: string | undefined): string | null {
  if (typeof ua !== 'string' || ua.length === 0) return null
  return ua.length > MAX_AUDIT_UA_LEN ? ua.slice(0, MAX_AUDIT_UA_LEN) : ua
}

/**
 * Mirror `resolveV4Auth.source` into the audit-log vocabulary. Defaults
 * to `anonymous` (login is the only route reachable without auth, and
 * login_failure must record something there). A2.2 simplified this from
 * a `(isV3Admin, v4)` pair to a single source argument once v3-admin
 * left the vocabulary.
 */
function actorSourceFor(
  v4Source: ResolvedAuth['source'],
): IdentityAuditActorSource {
  if (v4Source === 'v4-session') return 'v4-session'
  if (v4Source === 'v4-bearer') return 'v4-bearer'
  return 'anonymous'
}

/**
 * Best-effort audit write. Wrapped in try/catch because an audit failure
 * MUST NOT cascade into the caller's 200 response — a missing audit row
 * is a regrettable observability gap, but breaking the user's actual
 * mutation because audit's DB call threw would be worse.
 *
 * Returns nothing; caller never checks success. Errors are swallowed
 * (the store layer logs to stderr on real DB faults). When the host's
 * identity surface predates V4-AUDIT-06 (`writeAuditLog` missing on
 * the structural type) we silently skip — older surface still works.
 */
function tryAudit(
  ctx: HandleIdentityRouteCtx,
  v4: ResolvedAuth | null,
  input: {
    action: string
    actorUserId?: string | null
    targetUserId?: string | null
    targetCredentialId?: string | null
    metadata?: Record<string, unknown>
    success?: boolean
  },
): void {
  if (typeof ctx.identity.writeAuditLog !== 'function') return
  const actorSource = actorSourceFor(v4?.source ?? 'none')
  const actorUserId =
    input.actorUserId !== undefined
      ? input.actorUserId
      : (v4?.user?.id ?? null)
  try {
    ctx.identity.writeAuditLog({
      action: input.action,
      actorSource,
      actorUserId,
      targetUserId: input.targetUserId ?? null,
      targetCredentialId: input.targetCredentialId ?? null,
      ip: ctx.clientIp || null,
      userAgent: clampUserAgent(ctx.userAgent),
      metadata: input.metadata ?? null,
      success: input.success !== false,
    })
  } catch {
    // best-effort; see jsdoc
  }
}

export async function handleIdentityRoute(
  ctx: HandleIdentityRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<void> {
  // Anonymous routes: login is the only one. Everything else needs
  // owner. The owner check is below.
  if (method === 'POST' && path === '/api/admin/identity/login') {
    await handleLogin(ctx, req, res)
    return
  }
  if (method === 'POST' && path === '/api/admin/identity/logout') {
    // Logout is safe to call anonymously — it's a no-op against an
    // already-invalid cookie. Doing this before the owner gate means
    // a stale browser tab can always clear its cookie.
    await handleLogout(ctx, req, res)
    return
  }

  // GET /me sits BEFORE the owner gate — "tell me who I am" must be
  // reachable by every authenticated user (any role). The member-facing
  // /me page needs this to bootstrap. handleMe reports the v4 truth
  // (or 401 when truly anonymous).
  if (method === 'GET' && path === '/api/admin/identity/me') {
    const v4Whoami = resolveV4Auth(ctx.identity, req)
    handleMe(v4Whoami, res)
    return
  }

  // -- owner gate for everything below ----------------------------------
  const v4 = resolveV4Auth(ctx.identity, req)
  const isOwner = v4.role !== null && roleAtLeast(v4.role, 'owner')
  if (!isOwner) {
    sendJson(res, { error: 'owner role required' }, 403)
    return
  }

  if (method === 'GET' && path === '/api/admin/identity/users') {
    handleListUsers(ctx, res)
    return
  }
  if (method === 'GET' && path === '/api/admin/identity/audit') {
    // V4-AUDIT-06: parse `?limit=…&offset=…&action=…&targetUserId=…&success=true|false`.
    const url = new URL(
      req.url ?? path,
      `http://${req.headers.host ?? 'localhost'}`,
    )
    handleListAuditLog(ctx, url, res)
    return
  }
  // Phase 17 — audit export (CSV / JSONL attachment). Same owner gate.
  if (method === 'GET' && path === '/api/admin/identity/audit/export') {
    const url = new URL(
      req.url ?? path,
      `http://${req.headers.host ?? 'localhost'}`,
    )
    handleAuditExport(ctx, url, res)
    return
  }
  // Phase 19 P2-M3 — workflow-governance audit, a filtered view of the same
  // audit_log scoped to the five workflow_* actions. Co-located with the
  // identity audit endpoints (same owner gate, same store, same exporter)
  // rather than a separate /api/admin/audit/* namespace, so it needs zero new
  // auth wiring. Exact-match paths; `/workflows/export` is unambiguous against
  // `/workflows`. The more-specific export path is listed first for clarity.
  if (method === 'GET' && path === '/api/admin/identity/audit/workflows/export') {
    handleWorkflowAuditExport(ctx, identityUrl(req, path), res)
    return
  }
  if (method === 'GET' && path === '/api/admin/identity/audit/workflows') {
    handleListWorkflowAudit(ctx, identityUrl(req, path), res)
    return
  }
  // Phase 17 — usage / cost ledger (owner-only billing data). Exact
  // matches, so the more-specific `/ledger/export` is unambiguous against
  // `/ledger`. Delegated to usage-routes; ctx.identity satisfies the
  // duck-typed UsageLedgerSurface structurally.
  if (method === 'GET' && path === '/api/admin/identity/usage/ledger/export') {
    handleUsageLedgerExport(ctx.identity, identityUrl(req, path), res)
    return
  }
  if (method === 'GET' && path === '/api/admin/identity/usage/ledger') {
    handleUsageLedgerList(ctx.identity, identityUrl(req, path), res)
    return
  }
  if (method === 'GET' && path === '/api/admin/identity/usage/summary') {
    handleUsageSummary(ctx.identity, identityUrl(req, path), res)
    return
  }
  if (method === 'POST' && path === '/api/admin/identity/users') {
    await handleCreateUser(ctx, req, res)
    return
  }
  // PATCH /api/admin/identity/users/:id
  let m = /^\/api\/admin\/identity\/users\/([^/]+)$/.exec(path)
  if (m && method === 'PATCH') {
    await handlePatchUser(ctx, req, res, m[1]!)
    return
  }
  // GET /api/admin/identity/users/:id/credentials
  m = /^\/api\/admin\/identity\/users\/([^/]+)\/credentials$/.exec(path)
  if (m && method === 'GET') {
    handleListCredentials(ctx, res, m[1]!)
    return
  }
  // POST /api/admin/identity/users/:id/api-key
  m = /^\/api\/admin\/identity\/users\/([^/]+)\/api-key$/.exec(path)
  if (m && method === 'POST') {
    await handleIssueApiKey(ctx, req, res, m[1]!)
    return
  }
  // DELETE /api/admin/identity/credentials/:id
  m = /^\/api\/admin\/identity\/credentials\/([^/]+)$/.exec(path)
  if (m && method === 'DELETE') {
    handleRevokeCredential(ctx, req, res, m[1]!)
    return
  }
  // Phase 3 — invitations (owner-gated; anonymous accept lives at
  // /api/invites/* via handlePublicInvitationRoute below).
  if (method === 'POST' && path === '/api/admin/identity/invites') {
    await handleCreateInvite(ctx, req, res)
    return
  }
  if (method === 'GET' && path === '/api/admin/identity/invites') {
    const url = new URL(
      req.url ?? path,
      `http://${req.headers.host ?? 'localhost'}`,
    )
    handleListInvites(ctx, url, res)
    return
  }
  // Audit #156 — separate count endpoint. We keep it distinct from
  // the list endpoint so the sidebar widget can poll cheaply (one
  // integer in / out) without re-paginating the whole table.
  if (method === 'GET' && path === '/api/admin/identity/invites/count') {
    handleCountInvites(ctx, res)
    return
  }
  m = /^\/api\/admin\/identity\/invites\/([^/]+)$/.exec(path)
  if (m && method === 'DELETE') {
    handleRevokeInvite(ctx, req, res, m[1]!)
    return
  }

  // Phase 7 M5 — owner-only mode flip. The auto-promote path
  // (createInvitation / 2nd user) covers most cases; this endpoint is
  // for the explicit "升级到团队" button in the settings tab.
  if (method === 'POST' && path === '/api/admin/identity/org-mode') {
    await handleSetOrgMode(ctx, req, res)
    return
  }

  // D1 — Peer registry CRUD (owner-only). The host's PeerRegistry
  // polls the underlying peers table every 5s; ctx.peerRegistry?.invalidate()
  // here forces an immediate reconciliation so the operator's edit is
  // reflected in the live link set within milliseconds rather than
  // seconds.
  if (method === 'GET' && path === '/api/admin/identity/peers') {
    handleListPeers(ctx, res)
    return
  }
  if (method === 'POST' && path === '/api/admin/identity/peers') {
    await handleAddPeer(ctx, req, res)
    return
  }
  m = /^\/api\/admin\/identity\/peers\/([^/]+)$/.exec(path)
  if (m && method === 'PATCH') {
    await handlePatchPeer(ctx, req, res, m[1]!)
    return
  }
  if (m && method === 'DELETE') {
    handleRemovePeer(ctx, req, res, m[1]!)
    return
  }

  // E1 / C2 — Org soft-quota CRUD (owner-only).
  //
  // List + summary always available; sumUsage is exposed via the same
  // list endpoint as a {usage, pct, state} sidecar so the UI doesn't
  // make N additional round-trips. Set / delete are upsert + cap-remove.
  if (method === 'GET' && path === '/api/admin/identity/org-quotas') {
    handleListOrgQuotas(ctx, res)
    return
  }
  if (method === 'POST' && path === '/api/admin/identity/org-quotas') {
    await handleSetOrgQuota(ctx, req, res)
    return
  }
  m = /^\/api\/admin\/identity\/org-quotas\/([^/]+)\/([^/]+)$/.exec(path)
  if (m && method === 'DELETE') {
    handleDeleteOrgQuota(ctx, req, res, m[1]!, m[2]!)
    return
  }

  // Phase 6 #1 — peer reputation read-only dashboard. Owner-gated
  // (gate above). No POST/DELETE — reputation is derived from feedback
  // ledger, not directly mutable from this surface. Returns 503 when
  // the host did not wire `ctx.reputation` (older host or env opt-out).
  if (method === 'GET' && path === '/api/admin/identity/reputation') {
    handleListReputation(ctx, res)
    return
  }

  sendJson(res, { error: `unknown identity route: ${method} ${path}` }, 404)
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleLogin(
  ctx: HandleIdentityRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // V4-AUDIT-01: rate-limit BEFORE parsing the body so an attacker
  // cannot trigger the scrypt path with malformed bodies either. The
  // `peek` check follows the H21 pattern: success path never burns
  // quota, only auth failures do (recorded after the catch below).
  const rlKey = `identity-login:${ctx.clientIp}`
  if (!ctx.loginLimiter.peek(rlKey)) {
    res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' })
    res.end('too many login attempts; try again in a minute')
    return
  }

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, { error: (err as Error).message ?? 'bad body' }, 400)
    return
  }
  if (!body || typeof body !== 'object') {
    sendJson(res, { error: 'login body required: {email, password}' }, 400)
    return
  }
  const b = body as { email?: unknown; password?: unknown; totpCode?: unknown }
  if (typeof b.email !== 'string' || typeof b.password !== 'string') {
    sendJson(res, { error: 'email and password required' }, 400)
    return
  }
  // P1-M3d — second factor is optional in the body; only forwarded when a
  // non-empty string so an absent/blank field reliably triggers the challenge
  // rather than a silent miss.
  const totpCode = typeof b.totpCode === 'string' && b.totpCode.length > 0 ? b.totpCode : undefined
  try {
    const sess = ctx.identity.authenticatePassword({
      email: b.email,
      password: b.password,
      ...(totpCode !== undefined ? { totpCode } : {}),
    })
    // V4-AUDIT-06: record the successful login. We pass the real
    // actorUserId from the freshly-minted session (don't rely on the
    // resolved auth — at login time we haven't called resolveV4Auth
    // yet for this request).
    tryAudit(ctx, null, {
      action: 'login_success',
      actorUserId: sess.userId,
      targetUserId: sess.userId,
      metadata: { email: b.email },
    })
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': setIdentityCookie(sess.token, ctx.cookieSecure),
    })
    res.end(JSON.stringify({ ok: true, expiresAt: sess.expiresAt }))
  } catch (err) {
    // Only auth failures burn rate-limit budget — malformed input
    // (caught above as 400) already burned a peek but no record.
    const ec = asErrorWithCode(err)
    // P1-M3d — the password was CORRECT but a second factor is required. This
    // is NOT a failure: don't burn rate-limit budget and don't audit a
    // failure (a wrong code comes back as authentication_failed below, which
    // does). Reply with a typed challenge so the SPA reveals the code field
    // and resubmits with `totpCode`. No session cookie is set — the request
    // stays unauthenticated until the code verifies.
    if (ec && ec.code === 'totp_required') {
      sendJson(res, { ok: false, challenge: 'totp', code: 'totp_required' }, 401)
      return
    }
    if (ec && ec.code === 'authentication_failed') {
      ctx.loginLimiter.recordFailure(rlKey)
      // V4-AUDIT-06: failed login → actor is anonymous, target unknown.
      // The attempted email goes into metadata so an operator hunting
      // brute-force activity can group by it.
      tryAudit(ctx, null, {
        action: 'login_failure',
        actorUserId: null,
        success: false,
        metadata: { email: b.email },
      })
    }
    sendIdentityError(res, err, 401)
  }
}

async function handleLogout(
  ctx: HandleIdentityRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const tok = readCookie(req, IDENTITY_COOKIE)
  // Resolve the v4 identity (if any) BEFORE revoking the session so
  // the audit row carries the right actor. After revoke,
  // getSessionByToken returns null and we'd lose the trail.
  let actorUserId: string | null = null
  if (tok) {
    try {
      const r = ctx.identity.getSessionByToken(tok)
      if (r) actorUserId = r.user.id
    } catch {
      /* swallow — audit is best-effort */
    }
    try {
      ctx.identity.revokeSession(tok)
    } catch {
      // best-effort; even if revoke throws, clearing the cookie is right
    }
  }
  // V4-AUDIT-06: record the logout. An anonymous logout (no cookie)
  // still gets a row so an operator can see a pattern of probes.
  tryAudit(ctx, null, {
    action: 'logout',
    actorUserId,
    targetUserId: actorUserId,
  })
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'set-cookie': expireIdentityCookie(ctx.cookieSecure),
  })
  res.end(JSON.stringify({ ok: true }))
}

function handleMe(v4: ResolvedAuth, res: ServerResponse): void {
  if (v4.user !== null && v4.role !== null) {
    sendJson(res, {
      authSource: v4.source,
      user: v4.user,
      role: v4.role,
    })
    return
  }
  // Truly anonymous (no v4 session, no v4 bearer). /me sits BEFORE the
  // owner gate so members can call it — but we must explicitly refuse
  // anonymous here, otherwise the route would respond 200 to anyone
  // who hit it, a textbook privilege check escape.
  sendJson(res, { error: 'authentication required' }, 401)
}

function handleListUsers(ctx: HandleIdentityRouteCtx, res: ServerResponse): void {
  try {
    const users = ctx.identity.listUsers()
    // Join membership so the UI doesn't N+1 — admin user counts are
    // bounded enough that a per-user lookup loop is fine.
    const withRoles = users.map((u) => ({
      user: u,
      role: ctx.identity.getMembership(u.id)?.role ?? null,
    }))
    sendJson(res, { users: withRoles })
  } catch (err) {
    sendIdentityError(res, err)
  }
}

async function handleCreateUser(
  ctx: HandleIdentityRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, { error: (err as Error).message ?? 'bad body' }, 400)
    return
  }
  if (!body || typeof body !== 'object') {
    sendJson(res, { error: 'createUser body required' }, 400)
    return
  }
  const b = body as {
    email?: unknown
    displayName?: unknown
    password?: unknown
    role?: unknown
  }
  if (typeof b.email !== 'string') {
    sendJson(res, { error: 'email required' }, 400)
    return
  }
  const input: Parameters<IdentitySurface['createUser']>[0] = { email: b.email }
  if (b.displayName !== undefined) {
    if (b.displayName !== null && typeof b.displayName !== 'string') {
      sendJson(res, { error: 'displayName must be string or null' }, 400)
      return
    }
    input.displayName = b.displayName
  }
  if (b.password !== undefined) {
    if (typeof b.password !== 'string') {
      sendJson(res, { error: 'password must be a string' }, 400)
      return
    }
    input.password = b.password
  }
  if (b.role !== undefined) {
    if (typeof b.role !== 'string') {
      sendJson(res, { error: 'role must be a string' }, 400)
      return
    }
    input.role = b.role as IdentityRole
  }
  try {
    const u = ctx.identity.createUser(input)
    // V4-AUDIT-06: record who created the user with what role. The
    // resolved auth here is the v4 view (cookie/Bearer); anonymous is
    // not possible at this point (owner gate already filtered it out).
    tryAudit(ctx, resolveV4Auth(ctx.identity, req), {
      action: 'create_user',
      targetUserId: u.id,
      metadata: {
        email: u.email,
        role: input.role ?? 'member',
        hasPassword: input.password !== undefined,
      },
    })
    sendJson(res, { user: u }, 201)
  } catch (err) {
    sendIdentityError(res, err, 400)
  }
}

async function handlePatchUser(
  ctx: HandleIdentityRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, { error: (err as Error).message ?? 'bad body' }, 400)
    return
  }
  if (!body || typeof body !== 'object') {
    sendJson(res, { error: 'patch body required' }, 400)
    return
  }
  const b = body as { role?: unknown; password?: unknown }
  // Capture prior role for the audit metadata (only if we'll change it).
  const priorRole = typeof b.role === 'string'
    ? (ctx.identity.getMembership(userId)?.role ?? null)
    : null
  try {
    if (typeof b.role === 'string') {
      ctx.identity.setRole(userId, b.role as IdentityRole)
      // V4-AUDIT-06: role change is the most security-relevant audit
      // event (privilege escalation surface).
      tryAudit(ctx, resolveV4Auth(ctx.identity, req), {
        action: 'set_role',
        targetUserId: userId,
        metadata: { fromRole: priorRole, toRole: b.role },
      })
    }
    if (typeof b.password === 'string') {
      ctx.identity.setPassword(userId, b.password)
      // V4-AUDIT-06: password set is also security-relevant — owner
      // can rotate any user's password, including their own.
      tryAudit(ctx, resolveV4Auth(ctx.identity, req), {
        action: 'set_password',
        targetUserId: userId,
      })
    }
    // Re-fetch the user and membership to return the post-mutation state.
    const u = ctx.identity.getUserById(userId)
    if (!u) {
      sendJson(res, { error: 'user not found' }, 404)
      return
    }
    const membership = ctx.identity.getMembership(userId)
    sendJson(res, { user: u, role: membership?.role ?? null })
  } catch (err) {
    sendIdentityError(res, err, 400)
  }
}

function handleListCredentials(
  ctx: HandleIdentityRouteCtx,
  res: ServerResponse,
  userId: string,
): void {
  try {
    const creds = ctx.identity.listCredentials(userId)
    // Strip identifier for tokens — it's the sha256, not user-meaningful
    // and there's no reason to expose it to the UI.
    const safe = creds.map((c) => ({
      id: c.id,
      userId: c.userId,
      kind: c.kind,
      // For password creds, identifier is the email — fine to expose.
      // For token creds, hide the hash.
      identifier: c.kind === 'password' ? c.identifier : null,
      label: c.label,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
    }))
    sendJson(res, { credentials: safe })
  } catch (err) {
    sendIdentityError(res, err)
  }
}

async function handleIssueApiKey(
  ctx: HandleIdentityRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    body = undefined
  }
  const label =
    body && typeof body === 'object' && 'label' in body && typeof (body as { label?: unknown }).label === 'string'
      ? (body as { label: string }).label
      : undefined
  try {
    const opts: Parameters<IdentitySurface['issueApiKey']>[0] = { userId }
    if (label !== undefined) opts.label = label
    const issued = ctx.identity.issueApiKey(opts)
    // V4-AUDIT-06: a new api key is a long-lived authority grant —
    // audit it. The raw key NEVER goes in audit metadata (it's only
    // shown once on the wire); we record the label + credentialId so
    // an operator can correlate later actions to this grant.
    tryAudit(ctx, resolveV4Auth(ctx.identity, req), {
      action: 'issue_api_key',
      targetUserId: userId,
      targetCredentialId: issued.credentialId,
      ...(label !== undefined ? { metadata: { label } } : {}),
    })
    // Returned ONCE — caller must persist immediately.
    sendJson(
      res,
      {
        key: issued.key,
        credentialId: issued.credentialId,
        warning: 'This key is only shown once. Persist it now.',
      },
      201,
    )
  } catch (err) {
    sendIdentityError(res, err, 400)
  }
}

function handleRevokeCredential(
  ctx: HandleIdentityRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  credentialId: string,
): void {
  try {
    ctx.identity.revokeCredential(credentialId)
    // V4-AUDIT-06: credential revoke is the symmetric counterpart to
    // issue. Audit the action; we don't know the target user from the
    // path alone (the route is /credentials/:id, not /users/:u/...),
    // so leave targetUserId null.
    tryAudit(ctx, resolveV4Auth(ctx.identity, req), {
      action: 'revoke_credential',
      targetCredentialId: credentialId,
    })
    sendJson(res, { ok: true })
  } catch (err) {
    sendIdentityError(res, err)
  }
}

// V4-AUDIT-06: list endpoint for the admin UI's audit-log panel. Owner-only
// (already enforced by the dispatcher above this handler). Filters mirror
// the store's `listAuditLog` query. The route is documented at the top of
// this file under the route inventory.
// ---------------------------------------------------------------------------
// Phase 3 — invitation handlers.
//
// Owner-gated trio (handleCreateInvite / handleListInvites / handleRevokeInvite)
// is invoked from `handleIdentityRoute`. The anonymous duo
// (handleLookupInvite / handleAcceptInvite) sits behind a SEPARATE
// dispatcher (`handlePublicInvitationRoute`) because the route prefix
// is /api/invites/* — outside the /api/admin/identity/* owner gate.
// ---------------------------------------------------------------------------

function isInvitationStatus(s: unknown): s is IdentityInvitationStatus {
  return s === 'pending' || s === 'accepted' || s === 'revoked' || s === 'expired'
}

async function handleCreateInvite(
  ctx: HandleIdentityRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (typeof ctx.identity.createInvitation !== 'function') {
    sendJson(res, { error: 'invitation API unavailable on this host' }, 503)
    return
  }
  // AUDIT-P3-03: owner-mutation rate limit. Defense-in-depth against
  // a leaked owner credential being used to spam-fill the invitations
  // table + audit log (every create writes both). The actor key is
  // the v4 userId (always present here — the owner gate above already
  // filtered out anonymous callers). Default 60/min is plenty for
  // human bulk-onboarding (a 50-person org is 50 calls in 1 min).
  // `check()` because every create counts — this is action-volume cap.
  const v4ForRl = resolveV4Auth(ctx.identity, req)
  const actorKey = v4ForRl.user?.id ?? `anon:${ctx.clientIp}`
  if (!ctx.loginLimiter.check(`owner-mutation:${actorKey}`)) {
    res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' })
    res.end('too many owner mutations; try again in a minute')
    return
  }
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, { error: (err as Error).message ?? 'bad body' }, 400)
    return
  }
  if (!body || typeof body !== 'object') {
    sendJson(res, { error: 'createInvite body required: {email, role?, displayName?, ttlMs?}' }, 400)
    return
  }
  const b = body as {
    email?: unknown
    role?: unknown
    displayName?: unknown
    ttlMs?: unknown
  }
  if (typeof b.email !== 'string') {
    sendJson(res, { error: 'email required' }, 400)
    return
  }
  // We already resolved v4 above for the rate-limit key — reuse it.
  // The owner gate above guarantees v4.user is non-null here.
  const v4 = v4ForRl
  const invitedBy = v4.user?.id ?? null

  const input: Parameters<NonNullable<IdentitySurface['createInvitation']>>[0] = {
    email: b.email,
    invitedBy,
  }
  if (b.role !== undefined) {
    if (typeof b.role !== 'string') {
      sendJson(res, { error: 'role must be a string' }, 400)
      return
    }
    input.role = b.role as IdentityRole
  }
  if (b.displayName !== undefined) {
    if (typeof b.displayName !== 'string') {
      sendJson(res, { error: 'displayName must be a string' }, 400)
      return
    }
    input.displayName = b.displayName
  }
  if (b.ttlMs !== undefined) {
    if (typeof b.ttlMs !== 'number' || !Number.isFinite(b.ttlMs)) {
      sendJson(res, { error: 'ttlMs must be a finite number' }, 400)
      return
    }
    input.ttlMs = b.ttlMs
  }
  try {
    const issued = ctx.identity.createInvitation(input)
    // V4-AUDIT-06: invitation creation grants a future seat. Audit it.
    // The raw token NEVER appears in audit metadata — only the
    // invitation id (which is opaque + not a credential).
    tryAudit(ctx, v4, {
      action: 'create_invitation',
      targetUserId: null,
      metadata: {
        invitationId: issued.invitation.id,
        email: issued.invitation.email,
        role: issued.invitation.role,
        expiresAt: issued.invitation.expiresAt,
      },
    })
    // Returned ONCE — caller must deliver out-of-band.
    sendJson(
      res,
      {
        token: issued.token,
        invitation: issued.invitation,
        warning: 'This invite token is only shown once. Deliver it out-of-band.',
      },
      201,
    )
  } catch (err) {
    // Phase 6 #9: audit cap-triggered blocks so operators can see "we
    // hit the wall" before users complain. Other createInvitation
    // errors (validation, duplicate_email, invitation_pending_exists)
    // are not a DoS signal and stay unaudited to keep the log
    // signal-to-noise high.
    const ec = asErrorWithCode(err)
    if (ec?.code === 'invitations_limit_exceeded') {
      tryAudit(ctx, v4, {
        // Audit #148: use the named constant (mirrored from
        // `@gotong/identity` AUDIT_ACTIONS.INVITE_CREATE_BLOCKED)
        // instead of a magic string. Web doesn't import the identity
        // package at runtime (structural projection only — see top of
        // file), so the constant lives here and drift is caught by
        // tests/identity-routes-audit-vocab.test.ts.
        action: AUDIT_ACTION_INVITE_CREATE_BLOCKED,
        targetUserId: null,
        metadata: {
          email: input.email,
          role: input.role ?? 'member',
          reason: ec.message,
        },
        success: false,
      })
    }
    sendIdentityError(res, err, 400)
  }
}

/**
 * Audit #148 — mirrored from `@gotong/identity` AUDIT_ACTIONS.
 *
 * Web is structurally decoupled from `@gotong/identity` (it's a
 * devDependency only, used in tests). Constants we need at runtime get
 * mirrored here as `as const` literals. Drift between this file and
 * the source-of-truth in `packages/identity/src/types.ts` is caught
 * by `tests/identity-routes-audit-vocab.test.ts` which DOES import
 * `AUDIT_ACTIONS` (devDep is allowed in test code) and asserts
 * exact equality.
 *
 * If you add more audit-action mirrors here, add them to the test
 * too — the test is small on purpose so missed entries are obvious.
 */
const AUDIT_ACTION_INVITE_CREATE_BLOCKED = 'invite_create_blocked' as const

function handleListInvites(
  ctx: HandleIdentityRouteCtx,
  url: URL,
  res: ServerResponse,
): void {
  if (typeof ctx.identity.listInvitations !== 'function') {
    sendJson(res, { invitations: [], note: 'invitation API unavailable on this host' })
    return
  }
  const q: {
    status?: IdentityInvitationStatus
    email?: string
    limit?: number
    offset?: number
  } = {}
  const status = url.searchParams.get('status')
  if (status) {
    if (!isInvitationStatus(status)) {
      sendJson(res, { error: `invalid status filter: ${status}`, code: 'invalid_input' }, 400)
      return
    }
    q.status = status
  }
  const email = url.searchParams.get('email')
  if (email) q.email = email
  const lim = url.searchParams.get('limit')
  if (lim !== null) {
    const n = Number(lim)
    if (Number.isFinite(n) && n > 0) q.limit = Math.floor(n)
  }
  const off = url.searchParams.get('offset')
  if (off !== null) {
    const n = Number(off)
    if (Number.isFinite(n) && n >= 0) q.offset = Math.floor(n)
  }
  try {
    const invitations = ctx.identity.listInvitations(q)
    sendJson(res, { invitations })
  } catch (err) {
    sendIdentityError(res, err)
  }
}

/**
 * Audit #156 — quick count for the admin UI's "X / 1000 invites used"
 * sidebar. Returns the same number IdentityStore uses internally to
 * enforce the cap, so the badge in the UI matches the cap-trip
 * threshold byte-for-byte.
 */
function handleCountInvites(
  ctx: HandleIdentityRouteCtx,
  res: ServerResponse,
): void {
  if (typeof ctx.identity.countActivePendingInvitations !== 'function') {
    sendJson(
      res,
      { count: null, note: 'invitation count API unavailable on this host' },
      200,
    )
    return
  }
  try {
    const count = ctx.identity.countActivePendingInvitations()
    sendJson(res, { count })
  } catch (err) {
    sendIdentityError(res, err)
  }
}

/**
 * Phase 7 M5 — explicit "升级到团队" button handler. The auto-promote
 * paths in IdentityStore.createInvitation / createUser cover the
 * typical "operator created an invite" → flip-to-team flow; this
 * endpoint exists for the explicit toggle in the settings tab.
 *
 * Owner-gated (same as other admin/identity routes). Writes an audit
 * row so the timeline of "we became a team / went back to personal"
 * is queryable.
 */
async function handleSetOrgMode(
  ctx: HandleIdentityRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (typeof ctx.identity.setOrgMode !== 'function') {
    sendJson(res, { error: 'org mode API unavailable on this host' }, 503)
    return
  }
  const body = await readJsonBody(req)
  const mode = (body as { mode?: unknown })?.mode
  if (mode !== 'personal' && mode !== 'team') {
    sendJson(
      res,
      { error: "mode must be 'personal' or 'team'", code: 'invalid_input' },
      400,
    )
    return
  }
  try {
    const before = typeof ctx.identity.getOrgMode === 'function'
      ? ctx.identity.getOrgMode()
      : null
    ctx.identity.setOrgMode(mode)
    tryAudit(ctx, resolveV4Auth(ctx.identity, req), {
      action: 'org_set_mode',
      targetUserId: null,
      metadata: { from: before, to: mode },
    })
    sendJson(res, { mode })
  } catch (err) {
    sendIdentityError(res, err)
  }
}

function handleRevokeInvite(
  ctx: HandleIdentityRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  invitationId: string,
): void {
  if (typeof ctx.identity.revokeInvitation !== 'function') {
    sendJson(res, { error: 'invitation API unavailable on this host' }, 503)
    return
  }
  try {
    const after = ctx.identity.revokeInvitation(invitationId)
    tryAudit(ctx, resolveV4Auth(ctx.identity, req), {
      action: 'revoke_invitation',
      targetUserId: null,
      metadata: {
        invitationId: after.id,
        email: after.email,
        priorStatus: after.status,
      },
    })
    sendJson(res, { invitation: after })
  } catch (err) {
    sendIdentityError(res, err, 400)
  }
}

// ---------------------------------------------------------------------------
// Anonymous invitation routes — /api/invites/*
//
// These are reachable WITHOUT auth (the whole point of an invite link is
// the recipient hasn't signed up yet). The accept route hashes a fresh
// password (~100ms scrypt) and writes a row, so it MUST be rate-limited
// the same way login is. We reuse the same RateLimiter instance under a
// distinct key namespace.
//
// Lookup (GET) is intentionally NOT rate-limited beyond what the host
// already does globally: it's a single hashed-token sqlite lookup; if an
// attacker wants to brute-force `inv_` tokens they need ~10^54 attempts
// for one hit. The scrypt path is the only thing worth protecting here.
// ---------------------------------------------------------------------------

export interface HandlePublicInvitationRouteCtx {
  identity: IdentitySurface
  cookieSecure: boolean
  loginLimiter: LoginRateLimiterLike
  clientIp: string
  userAgent?: string
}

export async function handlePublicInvitationRoute(
  ctx: HandlePublicInvitationRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<void> {
  let m = /^\/api\/invites\/([^/]+)$/.exec(path)
  if (m && method === 'GET') {
    handleLookupInvite(ctx, res, m[1]!)
    return
  }
  m = /^\/api\/invites\/([^/]+)\/accept$/.exec(path)
  if (m && method === 'POST') {
    await handleAcceptInvite(ctx, req, res, m[1]!)
    return
  }
  sendJson(res, { error: `unknown invite route: ${method} ${path}` }, 404)
}

function handleLookupInvite(
  ctx: HandlePublicInvitationRouteCtx,
  res: ServerResponse,
  token: string,
): void {
  if (typeof ctx.identity.getInvitationByToken !== 'function') {
    sendJson(res, { error: 'invitation API unavailable on this host' }, 503)
    return
  }
  try {
    const inv = ctx.identity.getInvitationByToken(token)
    if (!inv) {
      sendJson(res, { error: 'invitation not found', code: 'invitation_not_found' }, 404)
      return
    }
    // Return the row so the /invite page can render the right copy
    // ("Welcome, set a password for foo@example.com"). We deliberately
    // include status so a 410-after-expiry can be rendered as
    // "this link has expired" rather than a generic error.
    //
    // We strip `invitedBy` — exposing the inviter's user id to an
    // unauthenticated stranger leaks org structure. The accept POST
    // doesn't need it either.
    sendJson(res, {
      invitation: {
        id: inv.id,
        email: inv.email,
        role: inv.role,
        displayName: inv.displayName,
        expiresAt: inv.expiresAt,
        status: inv.status,
        createdAt: inv.createdAt,
      },
    })
  } catch (err) {
    sendIdentityError(res, err)
  }
}

async function handleAcceptInvite(
  ctx: HandlePublicInvitationRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): Promise<void> {
  if (typeof ctx.identity.acceptInvitation !== 'function') {
    sendJson(res, { error: 'invitation API unavailable on this host' }, 503)
    return
  }
  // Rate-limit BEFORE parsing the body so a malformed-body flood still
  // burns budget — same defense pattern as handleLogin.
  const rlKey = `invite-accept:${ctx.clientIp}`
  if (!ctx.loginLimiter.peek(rlKey)) {
    res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' })
    res.end('too many accept attempts; try again in a minute')
    return
  }
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, { error: (err as Error).message ?? 'bad body' }, 400)
    return
  }
  if (!body || typeof body !== 'object') {
    sendJson(res, { error: 'acceptInvite body required: {password, displayName?}' }, 400)
    return
  }
  const b = body as { password?: unknown; displayName?: unknown }
  if (typeof b.password !== 'string') {
    sendJson(res, { error: 'password required' }, 400)
    return
  }
  const input: Parameters<NonNullable<IdentitySurface['acceptInvitation']>>[0] = {
    token,
    password: b.password,
  }
  if (b.displayName !== undefined) {
    if (typeof b.displayName !== 'string') {
      sendJson(res, { error: 'displayName must be a string' }, 400)
      return
    }
    input.displayName = b.displayName
  }
  try {
    const result = ctx.identity.acceptInvitation(input)
    // V4-AUDIT-06: a freshly-created user accepting their invite is its
    // OWN actor (they just minted themselves). actorSource is technically
    // 'anonymous' at request time — but the actor IS the new user — so
    // we override actorUserId to the new user id for traceability.
    // tryAudit lives on the owner-gated module; we can't use it here
    // (different ctx shape), so inline the best-effort write.
    if (typeof ctx.identity.writeAuditLog === 'function') {
      try {
        ctx.identity.writeAuditLog({
          action: 'accept_invitation',
          actorSource: 'anonymous',
          actorUserId: result.user.id,
          targetUserId: result.user.id,
          ip: ctx.clientIp || null,
          userAgent: clampUserAgent(ctx.userAgent),
          metadata: {
            invitationId: result.invitation.id,
            email: result.user.email,
            role: result.invitation.role,
          },
        })
      } catch {
        /* best-effort */
      }
    }
    // Mint the session cookie so the /invite landing page can redirect
    // straight to /me without a second login round-trip.
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': setIdentityCookie(result.session.token, ctx.cookieSecure),
    })
    res.end(
      JSON.stringify({
        ok: true,
        user: result.user,
        role: result.invitation.role,
        session: {
          expiresAt: result.session.expiresAt,
        },
      }),
    )
  } catch (err) {
    // Only the not-actually-expired / not-actually-already-used / wrong-
    // token failures burn limit — weak_password is a user typo, no need
    // to punish it.
    const ec = asErrorWithCode(err)
    if (
      ec &&
      (ec.code === 'invitation_not_found' ||
        ec.code === 'invitation_expired' ||
        ec.code === 'invitation_already_used' ||
        ec.code === 'invitation_revoked')
    ) {
      ctx.loginLimiter.recordFailure(rlKey)
    }
    sendIdentityError(res, err, 400)
  }
}

function handleListAuditLog(
  ctx: HandleIdentityRouteCtx,
  url: URL,
  res: ServerResponse,
): void {
  if (typeof ctx.identity.listAuditLog !== 'function') {
    // Host has an identity surface that predates V4-AUDIT-06. We treat
    // this as "audit not available" rather than 500 so an upgrade path
    // exists where the route can come online by swapping the binary.
    sendJson(res, { entries: [], note: 'audit log unavailable on this host' })
    return
  }
  const q: {
    limit?: number
    offset?: number
    action?: string
    targetUserId?: string
    success?: boolean
  } = {}
  const lim = url.searchParams.get('limit')
  if (lim !== null) {
    const n = Number(lim)
    if (Number.isFinite(n) && n > 0) q.limit = Math.floor(n)
  }
  const off = url.searchParams.get('offset')
  if (off !== null) {
    const n = Number(off)
    if (Number.isFinite(n) && n >= 0) q.offset = Math.floor(n)
  }
  const action = url.searchParams.get('action')
  if (action) q.action = action
  const targetUserId = url.searchParams.get('targetUserId')
  if (targetUserId) q.targetUserId = targetUserId
  const success = url.searchParams.get('success')
  if (success === 'true') q.success = true
  else if (success === 'false') q.success = false
  try {
    const entries = ctx.identity.listAuditLog(q)
    sendJson(res, { entries })
  } catch (err) {
    sendIdentityError(res, err)
  }
}

/** Build a URL object from the request for query-string parsing. */
function identityUrl(req: IncomingMessage, path: string): URL {
  return new URL(req.url ?? path, `http://${req.headers.host ?? 'localhost'}`)
}

/** Phase 17 — CSV columns for an audit-log export row. */
const AUDIT_EXPORT_COLUMNS: ReadonlyArray<CsvColumn<IdentityAuditLogEntryDTO>> = [
  { header: 'id', value: (r) => r.id },
  { header: 'ts', value: (r) => r.ts },
  { header: 'iso_ts', value: (r) => new Date(r.ts).toISOString() },
  { header: 'action', value: (r) => r.action },
  { header: 'actor_user_id', value: (r) => r.actorUserId },
  { header: 'actor_source', value: (r) => r.actorSource },
  { header: 'target_user_id', value: (r) => r.targetUserId },
  { header: 'target_credential_id', value: (r) => r.targetCredentialId },
  { header: 'ip', value: (r) => r.ip },
  { header: 'user_agent', value: (r) => r.userAgent },
  { header: 'success', value: (r) => (r.success ? 1 : 0) },
  { header: 'metadata_json', value: (r) => r.metadata },
]

/** Max audit rows an export pulls in one shot. */
const AUDIT_EXPORT_LIMIT = 10_000

/**
 * Phase 17 — audit-log export as a CSV / JSONL attachment. Reuses the
 * same `listAuditLog` filters as the JSON list route but pulls up to
 * {@link AUDIT_EXPORT_LIMIT} rows for the download.
 */
function handleAuditExport(
  ctx: HandleIdentityRouteCtx,
  url: URL,
  res: ServerResponse,
): void {
  if (typeof ctx.identity.listAuditLog !== 'function') {
    sendJson(res, { error: 'audit log unavailable on this host' }, 503)
    return
  }
  const q: {
    limit?: number
    offset?: number
    action?: string
    targetUserId?: string
    success?: boolean
  } = { limit: AUDIT_EXPORT_LIMIT, offset: 0 }
  const action = url.searchParams.get('action')
  if (action) q.action = action
  const targetUserId = url.searchParams.get('targetUserId')
  if (targetUserId) q.targetUserId = targetUserId
  const success = url.searchParams.get('success')
  if (success === 'true') q.success = true
  else if (success === 'false') q.success = false
  const format = parseExportFormat(url.searchParams.get('format'))
  try {
    const entries = ctx.identity.listAuditLog(q)
    const body =
      format === 'jsonl' ? toJsonl(entries) : toCsv(AUDIT_EXPORT_COLUMNS, entries)
    sendExport(res, format, 'audit-log', body)
  } catch (err) {
    sendIdentityError(res, err)
  }
}

// ---------------------------------------------------------------------------
// Phase 19 P2-M3 — workflow-governance audit (a filtered view of audit_log)
// ---------------------------------------------------------------------------

/**
 * The five workflow lifecycle actions. Mirrors `AUDIT_ACTIONS.WORKFLOW_*`
 * from `@gotong/identity` as string literals (web has no identity runtime
 * dep — same pattern as the audit-vocab mirrors elsewhere in this file).
 */
const WORKFLOW_AUDIT_ACTIONS: readonly string[] = [
  'workflow_import',
  'workflow_publish',
  'workflow_deprecate',
  'workflow_archive',
  'workflow_rollback',
]

type WorkflowAuditQuery = {
  limit?: number
  offset?: number
  actions?: string[]
  since?: number
  until?: number
  metadataEquals?: { path: string; value: string }
}

/**
 * Build the `listAuditLog` query from the shared workflow-audit params
 * (`?workflowId=&action=&since=&until=&limit=&offset=`). `actions` is ALWAYS
 * constrained to the workflow set — a single recognised `action` narrows it,
 * anything else falls back to all five — so this view can never surface a
 * non-workflow row. `since`/`until` are epoch-ms; `workflowId` becomes a
 * `json_extract(metadata,'$.workflowId')` equality at the SQL layer (correct
 * pagination, unlike a post-fetch filter).
 */
function buildWorkflowAuditQuery(
  url: URL,
  defaults: { limit: number; maxLimit: number },
): WorkflowAuditQuery {
  const q: WorkflowAuditQuery = {}
  const action = url.searchParams.get('action')
  q.actions =
    action && WORKFLOW_AUDIT_ACTIONS.includes(action)
      ? [action]
      : [...WORKFLOW_AUDIT_ACTIONS]
  const workflowId = url.searchParams.get('workflowId')
  if (workflowId) q.metadataEquals = { path: '$.workflowId', value: workflowId }
  const since = Number(url.searchParams.get('since'))
  if (Number.isFinite(since) && since > 0) q.since = Math.floor(since)
  const until = Number(url.searchParams.get('until'))
  if (Number.isFinite(until) && until > 0) q.until = Math.floor(until)
  const limRaw = url.searchParams.get('limit')
  const lim = Number(limRaw)
  q.limit =
    limRaw !== null && Number.isFinite(lim) && lim > 0
      ? Math.min(defaults.maxLimit, Math.floor(lim))
      : defaults.limit
  const offRaw = url.searchParams.get('offset')
  const off = Number(offRaw)
  if (offRaw !== null && Number.isFinite(off) && off >= 0) q.offset = Math.floor(off)
  return q
}

/** GET /api/admin/identity/audit/workflows — JSON list, owner-gated. */
function handleListWorkflowAudit(
  ctx: HandleIdentityRouteCtx,
  url: URL,
  res: ServerResponse,
): void {
  if (typeof ctx.identity.listAuditLog !== 'function') {
    sendJson(res, { entries: [], note: 'audit log unavailable on this host' })
    return
  }
  const q = buildWorkflowAuditQuery(url, { limit: 100, maxLimit: 1000 })
  try {
    const entries = ctx.identity.listAuditLog(q)
    sendJson(res, { entries })
  } catch (err) {
    sendIdentityError(res, err)
  }
}

/** GET /api/admin/identity/audit/workflows/export — CSV/JSONL attachment. */
function handleWorkflowAuditExport(
  ctx: HandleIdentityRouteCtx,
  url: URL,
  res: ServerResponse,
): void {
  if (typeof ctx.identity.listAuditLog !== 'function') {
    sendJson(res, { error: 'audit log unavailable on this host' }, 503)
    return
  }
  // The store clamps limit to ≤1000, so the export caps there too (same as
  // the sibling /audit/export). Plenty for governance volume; documented.
  const q = buildWorkflowAuditQuery(url, {
    limit: AUDIT_EXPORT_LIMIT,
    maxLimit: AUDIT_EXPORT_LIMIT,
  })
  const format = parseExportFormat(url.searchParams.get('format'))
  try {
    const entries = ctx.identity.listAuditLog(q)
    const body =
      format === 'jsonl' ? toJsonl(entries) : toCsv(AUDIT_EXPORT_COLUMNS, entries)
    sendExport(res, format, 'workflow-audit', body)
  } catch (err) {
    sendIdentityError(res, err)
  }
}

// ---------------------------------------------------------------------------
// D1 — Peer registry handlers
// ---------------------------------------------------------------------------

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

// Phase 18 B-M2 — normalized policy fields shared by add + patch.
// Phase 19 P4-M4 added the per-link trust-contract trio.
interface PeerPolicyFields {
  kind?: PeerKind
  acl?: PeerInboundAcl | null
  outboundCaps?: string[] | null
  requireApprovalOutbound?: boolean
  revocationState?: PeerRevocationState
  perLinkQuotaBudget?: number | null
  allowedDataClasses?: string[] | null
  // v5 C-M1 — the callable-knowledge-base allowlist (null = all callable).
  allowedKnowledgeBases?: string[] | null
  // v5 E5 — opt-in to share a privacy-safe footprint summary (fail-closed default).
  shareSummary?: boolean
  // v5 Stream G day-5 — opt-in to answer peer.transcript (fail-closed default).
  shareTranscript?: boolean
  // STD-M2b — owner-pinned signing-key thumbprint (null = clear the anchor).
  pinnedKid?: string | null
}

/**
 * Validate an optional inbound ACL from a request body. `undefined` →
 * absent (leave unchanged); `null` → explicit clear (PATCH); an object is
 * shape-checked field by field. Returns the first error otherwise — a bad
 * `capabilities: "x"` would otherwise be JSON-stored and silently misgate.
 */
function parseAclField(
  raw: unknown,
): { ok: true; value: PeerInboundAcl | null | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined }
  if (raw === null) return { ok: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'acl must be an object or null' }
  }
  const a = raw as Record<string, unknown>
  const out: PeerInboundAcl = {}
  if (a.capabilities !== undefined) {
    if (!isStringArray(a.capabilities)) return { ok: false, error: 'acl.capabilities must be a string array' }
    out.capabilities = a.capabilities
  }
  if (a.requireOrigin !== undefined) {
    if (typeof a.requireOrigin !== 'boolean') return { ok: false, error: 'acl.requireOrigin must be a boolean' }
    out.requireOrigin = a.requireOrigin
  }
  if (a.requireOriginRole !== undefined) {
    if (!isStringArray(a.requireOriginRole)) return { ok: false, error: 'acl.requireOriginRole must be a string array' }
    out.requireOriginRole = a.requireOriginRole
  }
  return { ok: true, value: out }
}

/**
 * Validate the four optional policy fields. Only present fields appear in
 * the result, so a PATCH preserves what the caller didn't send.
 * `outboundCaps` accepts null (explicit clear).
 */
function parsePeerPolicyFields(b: {
  kind?: unknown
  acl?: unknown
  outboundCaps?: unknown
  requireApprovalOutbound?: unknown
  revocationState?: unknown
  perLinkQuotaBudget?: unknown
  allowedDataClasses?: unknown
  allowedKnowledgeBases?: unknown
  shareSummary?: unknown
  shareTranscript?: unknown
  pinnedKid?: unknown
}): { ok: true; value: PeerPolicyFields } | { ok: false; error: string } {
  const value: PeerPolicyFields = {}
  if (b.kind !== undefined) {
    if (typeof b.kind !== 'string' || !PEER_KINDS.includes(b.kind as PeerKind)) {
      return { ok: false, error: `kind must be one of: ${PEER_KINDS.join(', ')}` }
    }
    value.kind = b.kind as PeerKind
  }
  const acl = parseAclField(b.acl)
  if (!acl.ok) return acl
  if (acl.value !== undefined) value.acl = acl.value
  if (b.outboundCaps !== undefined) {
    if (b.outboundCaps === null) value.outboundCaps = null
    else if (isStringArray(b.outboundCaps)) value.outboundCaps = b.outboundCaps
    else return { ok: false, error: 'outboundCaps must be a string array or null' }
  }
  if (b.requireApprovalOutbound !== undefined) {
    if (typeof b.requireApprovalOutbound !== 'boolean') {
      return { ok: false, error: 'requireApprovalOutbound must be a boolean' }
    }
    value.requireApprovalOutbound = b.requireApprovalOutbound
  }
  // Phase 19 P4-M4 — the per-link trust contract. revocationState is never
  // cleared to null (it's always active|revoked); the budget + data-class
  // allowlist accept null as an explicit "back to unlimited / all-allowed".
  if (b.revocationState !== undefined) {
    if (
      typeof b.revocationState !== 'string' ||
      !PEER_REVOCATION_STATES.includes(b.revocationState as PeerRevocationState)
    ) {
      return { ok: false, error: `revocationState must be one of: ${PEER_REVOCATION_STATES.join(', ')}` }
    }
    value.revocationState = b.revocationState as PeerRevocationState
  }
  if (b.perLinkQuotaBudget !== undefined) {
    if (b.perLinkQuotaBudget === null) value.perLinkQuotaBudget = null
    else if (
      typeof b.perLinkQuotaBudget === 'number' &&
      Number.isInteger(b.perLinkQuotaBudget) &&
      b.perLinkQuotaBudget >= 0
    ) {
      value.perLinkQuotaBudget = b.perLinkQuotaBudget
    } else {
      return { ok: false, error: 'perLinkQuotaBudget must be a non-negative integer or null' }
    }
  }
  if (b.allowedDataClasses !== undefined) {
    if (b.allowedDataClasses === null) value.allowedDataClasses = null
    else if (isStringArray(b.allowedDataClasses)) value.allowedDataClasses = b.allowedDataClasses
    else return { ok: false, error: 'allowedDataClasses must be a string array or null' }
  }
  // v5 C-M1 — callable-knowledge-base allowlist: null = all shared servers
  // callable (legacy); [] = lockdown; [names] = only those servers.
  if (b.allowedKnowledgeBases !== undefined) {
    if (b.allowedKnowledgeBases === null) value.allowedKnowledgeBases = null
    else if (isStringArray(b.allowedKnowledgeBases)) value.allowedKnowledgeBases = b.allowedKnowledgeBases
    else return { ok: false, error: 'allowedKnowledgeBases must be a string array or null' }
  }
  // v5 E5 — opt into exposing a privacy-safe footprint summary over peer.summary
  // (counts only, fail-closed default). A plain boolean: there's no "null" state.
  if (b.shareSummary !== undefined) {
    if (typeof b.shareSummary !== 'boolean') {
      return { ok: false, error: 'shareSummary must be a boolean' }
    }
    value.shareSummary = b.shareSummary
  }
  // v5 Stream G day-5 — opt into answering peer.transcript (one cross-hub task's
  // trace, fail-closed default). A plain boolean like shareSummary; no "null".
  if (b.shareTranscript !== undefined) {
    if (typeof b.shareTranscript !== 'boolean') {
      return { ok: false, error: 'shareTranscript must be a boolean' }
    }
    value.shareTranscript = b.shareTranscript
  }
  // STD-M2b — owner-pinned signing-key thumbprint (the out-of-band trust anchor
  // for this peer's signed A2A card). null CLEARS the anchor; a string MUST be
  // the RFC 7638 shape (43-char base64url SHA-256) so a paste typo can't quietly
  // become a pin that then always mismatches. Owner sets it explicitly — this is
  // never auto-derived (发现≠信任).
  if (b.pinnedKid !== undefined) {
    if (b.pinnedKid === null) value.pinnedKid = null
    else if (typeof b.pinnedKid === 'string' && /^[A-Za-z0-9_-]{43}$/.test(b.pinnedKid)) {
      value.pinnedKid = b.pinnedKid
    } else {
      return {
        ok: false,
        error: 'pinnedKid must be a 43-char base64url RFC 7638 thumbprint, or null to clear',
      }
    }
  }
  return { ok: true, value }
}

function ensurePeersSupported(
  ctx: HandleIdentityRouteCtx,
  res: ServerResponse,
): boolean {
  if (typeof ctx.identity.addPeer !== 'function') {
    sendJson(res, { error: 'peers surface not supported by this host' }, 503)
    return false
  }
  return true
}

function handleListPeers(ctx: HandleIdentityRouteCtx, res: ServerResponse): void {
  if (!ensurePeersSupported(ctx, res)) return
  try {
    const peers = ctx.identity.listPeers!()
    const statusByRow = new Map(
      (ctx.peerRegistry?.status() ?? []).map((s) => [s.peerRowId, s]),
    )
    const out = peers.map((p) => ({
      ...p,
      connected: statusByRow.get(p.id)?.connected ?? false,
      backoffAttempts: statusByRow.get(p.id)?.backoffAttempts ?? 0,
      lastSeenAt: statusByRow.get(p.id)?.lastSeenAt ?? null,
    }))
    sendJson(res, { peers: out })
  } catch (err) {
    sendIdentityError(res, err)
  }
}

async function handleAddPeer(
  ctx: HandleIdentityRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ensurePeersSupported(ctx, res)) return
  const v4 = resolveV4Auth(ctx.identity, req)
  let body: unknown
  try { body = await readJsonBody(req) }
  catch { sendJson(res, { error: 'invalid JSON body' }, 400); return }
  const b = (body ?? {}) as {
    peerId?: unknown
    endpointUrl?: unknown
    label?: unknown
    peerToken?: unknown
    kind?: unknown
    acl?: unknown
    outboundCaps?: unknown
    requireApprovalOutbound?: unknown
    revocationState?: unknown
    perLinkQuotaBudget?: unknown
    allowedDataClasses?: unknown
  }
  if (typeof b.peerId !== 'string' || b.peerId.length === 0) {
    sendJson(res, { error: 'peerId required (non-empty string)' }, 400)
    return
  }
  if (typeof b.endpointUrl !== 'string' || b.endpointUrl.length === 0) {
    sendJson(res, { error: 'endpointUrl required (non-empty string)' }, 400)
    return
  }
  if (typeof b.peerToken !== 'string' || b.peerToken.length === 0) {
    sendJson(res, { error: 'peerToken required (non-empty string)' }, 400)
    return
  }
  const policy = parsePeerPolicyFields(b)
  if (!policy.ok) {
    sendJson(res, { error: policy.error }, 400)
    return
  }
  try {
    const added = ctx.identity.addPeer!({
      peerId: b.peerId,
      endpointUrl: b.endpointUrl,
      ...(typeof b.label === 'string' ? { label: b.label } : {}),
      peerToken: b.peerToken,
      ...policy.value,
    })
    ctx.peerRegistry?.invalidate()
    tryAudit(ctx, v4, {
      action: 'peer_add',
      targetUserId: null,
      metadata: { peerId: added.peerId, endpointUrl: added.endpointUrl },
      success: true,
    })
    sendJson(res, { peer: added })
  } catch (err) {
    tryAudit(ctx, v4, {
      action: 'peer_add',
      targetUserId: null,
      metadata: { peerId: b.peerId, error: err instanceof Error ? err.message : String(err) },
      success: false,
    })
    sendIdentityError(res, err)
  }
}

async function handlePatchPeer(
  ctx: HandleIdentityRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  if (!ensurePeersSupported(ctx, res)) return
  let body: unknown
  try { body = await readJsonBody(req) }
  catch { sendJson(res, { error: 'invalid JSON body' }, 400); return }
  const b = (body ?? {}) as {
    label?: unknown
    enabled?: unknown
    peerToken?: unknown
    endpointUrl?: unknown
    kind?: unknown
    acl?: unknown
    outboundCaps?: unknown
    requireApprovalOutbound?: unknown
    revocationState?: unknown
    perLinkQuotaBudget?: unknown
    allowedDataClasses?: unknown
  }
  const input: {
    label?: string | null
    enabled?: boolean
    peerToken?: string
    endpointUrl?: string
  } & PeerPolicyFields = {}
  if (b.label === null) input.label = null
  else if (typeof b.label === 'string') input.label = b.label
  if (typeof b.enabled === 'boolean') input.enabled = b.enabled
  if (typeof b.peerToken === 'string' && b.peerToken.length > 0) {
    input.peerToken = b.peerToken
  }
  if (typeof b.endpointUrl === 'string' && b.endpointUrl.length > 0) {
    input.endpointUrl = b.endpointUrl
  }
  const policy = parsePeerPolicyFields(b)
  if (!policy.ok) {
    sendJson(res, { error: policy.error }, 400)
    return
  }
  Object.assign(input, policy.value)
  // A policy or endpoint change must re-gate / re-dial a CONNECTED peer;
  // invalidate() alone won't (tick keeps the existing link). Label / enabled
  // / token-only edits are fine with a plain reconcile. STD-M2b `pinnedKid` is
  // an advisory trust anchor that never touches mesh gating, so a pin-only edit
  // must NOT force a re-dial — exclude it from the relink trigger.
  const gatingChanged = Object.keys(policy.value).some((k) => k !== 'pinnedKid')
  const needsRelink = gatingChanged || input.endpointUrl !== undefined
  try {
    const updated = ctx.identity.updatePeer!(id, input)
    if (needsRelink && ctx.peerRegistry?.refreshPolicy) ctx.peerRegistry.refreshPolicy(id)
    else ctx.peerRegistry?.invalidate()
    sendJson(res, { peer: updated })
  } catch (err) {
    sendIdentityError(res, err)
  }
}

function handleRemovePeer(
  ctx: HandleIdentityRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): void {
  if (!ensurePeersSupported(ctx, res)) return
  const v4 = resolveV4Auth(ctx.identity, req)
  try {
    const removed = ctx.identity.removePeer!(id)
    if (!removed) {
      sendJson(res, { error: 'peer not found' }, 404)
      return
    }
    ctx.peerRegistry?.invalidate()
    tryAudit(ctx, v4, {
      action: 'peer_remove',
      targetUserId: null,
      metadata: { peerRowId: id },
      success: true,
    })
    sendJson(res, { ok: true })
  } catch (err) {
    sendIdentityError(res, err)
  }
}

// ---------------------------------------------------------------------------
// E1 / C2 — Org soft-quota handlers
// ---------------------------------------------------------------------------

function ensureOrgQuotasSupported(
  ctx: HandleIdentityRouteCtx,
  res: ServerResponse,
): boolean {
  if (typeof ctx.identity.listOrgQuotas !== 'function') {
    sendJson(res, { error: 'org-quotas surface not supported by this host' }, 503)
    return false
  }
  return true
}

const VALID_PERIODS = new Set(['hourly', 'daily', 'monthly', 'total'] as const)
type PeriodValue = 'hourly' | 'daily' | 'monthly' | 'total'

/**
 * List + decorate with live usage / pct / state so the UI's quota cards
 * can render the progress bar without a second round-trip per row. We
 * compute pct ourselves rather than calling checkOrgQuotaThreshold
 * (which would also mutate lastState) — admin UI views are READS, the
 * state machine should only advance from the host sweep timer.
 */
function handleListOrgQuotas(
  ctx: HandleIdentityRouteCtx,
  res: ServerResponse,
): void {
  if (!ensureOrgQuotasSupported(ctx, res)) return
  try {
    const quotas = ctx.identity.listOrgQuotas!()
    const out = quotas.map((q) => {
      let usage = 0
      try {
        usage = ctx.identity.sumUsage?.(q.metric, q.period) ?? 0
      } catch { /* stay at 0 — usage is informational here */ }
      let pct: number
      let derivedState: 'ok' | 'warn' | 'over'
      if (q.quota === 0) {
        pct = usage === 0 ? 0 : 999
        derivedState = usage === 0 ? 'ok' : 'over'
      } else {
        pct = Math.min(999, Math.floor((usage / q.quota) * 100))
        if (pct >= 100) derivedState = 'over'
        else if (pct >= q.warnPct) derivedState = 'warn'
        else derivedState = 'ok'
      }
      return {
        ...q,
        usage,
        pct,
        // `state` is the live derived state (read-only); `lastState` is
        // the snapshot from the most recent host sweep. UI shows both
        // when they disagree, so operator knows a tick is overdue.
        state: derivedState,
      }
    })
    sendJson(res, { quotas: out })
  } catch (err) {
    sendIdentityError(res, err)
  }
}

async function handleSetOrgQuota(
  ctx: HandleIdentityRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ensureOrgQuotasSupported(ctx, res)) return
  const v4 = resolveV4Auth(ctx.identity, req)
  let body: { metric?: string; period?: string; quota?: number; warnPct?: number }
  try {
    body = (await readJsonBody(req)) as typeof body
  } catch (err) {
    sendJson(res, { error: 'invalid json body' }, 400)
    return
  }
  if (!body || typeof body.metric !== 'string' || !body.metric.trim()) {
    sendJson(res, { error: 'metric required' }, 400)
    return
  }
  if (typeof body.period !== 'string' || !VALID_PERIODS.has(body.period as PeriodValue)) {
    sendJson(res, { error: `period must be one of ${[...VALID_PERIODS].join(', ')}` }, 400)
    return
  }
  if (
    typeof body.quota !== 'number' ||
    !Number.isFinite(body.quota) ||
    !Number.isInteger(body.quota) ||
    body.quota < 0
  ) {
    sendJson(res, { error: 'quota must be a non-negative integer' }, 400)
    return
  }
  try {
    const saved = ctx.identity.setOrgQuota!({
      metric: body.metric.trim(),
      period: body.period as PeriodValue,
      quota: body.quota,
      ...(body.warnPct !== undefined ? { warnPct: body.warnPct } : {}),
    })
    tryAudit(ctx, v4, {
      action: 'org_set_quota',
      targetUserId: null,
      metadata: {
        metric: saved.metric,
        period: saved.period,
        quota: saved.quota,
        warnPct: saved.warnPct,
      },
      success: true,
    })
    sendJson(res, { quota: saved })
  } catch (err) {
    sendIdentityError(res, err)
  }
}

function handleDeleteOrgQuota(
  ctx: HandleIdentityRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  metric: string,
  period: string,
): void {
  if (!ensureOrgQuotasSupported(ctx, res)) return
  if (!VALID_PERIODS.has(period as PeriodValue)) {
    sendJson(res, { error: 'invalid period segment' }, 400)
    return
  }
  const v4 = resolveV4Auth(ctx.identity, req)
  try {
    const removed = ctx.identity.deleteOrgQuota!(
      decodeURIComponent(metric),
      period as PeriodValue,
    )
    if (!removed) {
      sendJson(res, { error: 'quota not found' }, 404)
      return
    }
    tryAudit(ctx, v4, {
      action: 'org_set_quota',
      targetUserId: null,
      metadata: { metric: decodeURIComponent(metric), period, deleted: true },
      success: true,
    })
    sendJson(res, { ok: true })
  } catch (err) {
    sendIdentityError(res, err)
  }
}

// ---------------------------------------------------------------------------
// Phase 6 #1 — Peer reputation read-only dashboard
// ---------------------------------------------------------------------------

function handleListReputation(
  ctx: HandleIdentityRouteCtx,
  res: ServerResponse,
): void {
  if (!ctx.reputation) {
    sendJson(
      res,
      { error: 'reputation snapshot not supported by this host' },
      503,
    )
    return
  }
  try {
    const snapshot = ctx.reputation.snapshot()
    // Sort by score desc then by sampleCount desc — admins read the
    // table top-to-bottom and care about "who's most trusted" first.
    // Tie-break on peerHubId for stable rendering across refreshes.
    //
    // Audit #152 — non-finite scores (NaN / undefined; happens when
    // sampleCount=0 and the EWMA hasn't seen any data) sort *last* in
    // a stable position so they don't shuffle around between refreshes.
    // Without this guard, V8/JSC sort behaviour on NaN comparators is
    // implementation-defined ("the table jumps").
    const sorted = [...snapshot].sort((a, b) => {
      const aFinite = Number.isFinite(a.score)
      const bFinite = Number.isFinite(b.score)
      if (aFinite && !bFinite) return -1
      if (!aFinite && bFinite) return 1
      if (aFinite && bFinite && Math.abs(a.score - b.score) > 1e-9) {
        return b.score - a.score
      }
      if (a.sampleCount !== b.sampleCount) return b.sampleCount - a.sampleCount
      return a.peerHubId.localeCompare(b.peerHubId)
    })
    sendJson(res, { reputation: sorted })
  } catch (err) {
    sendIdentityError(res, err)
  }
}
