/**
 * /api/admin/identity/* — v4 user-management routes.
 *
 * Layered on `IdentitySurface` (a structural projection of
 * @aipehub/identity's IdentityStore, defined in server.ts). The host
 * wires the real `IdentityStore` instance into `serveWeb({ identity })`
 * and structural typing lets it slot in without the web package
 * taking a runtime dep on @aipehub/identity.
 *
 * # Auth gates
 *
 * Every route requires **owner** role on the host's organisation.
 * Owner is established by either:
 *   (a) a valid v3 admin (Bearer hex token / `aipehub_admin` cookie) —
 *       v3 admin == v4 owner because Phase 2 bootstrap migrated the
 *       v3 admin token into the IdentityStore as an `admin_token`
 *       credential bound to the owner user; OR
 *   (b) a v4 IdentityStore session cookie (`aipehub_identity`) whose
 *       resolved role is `owner`.
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

// ---------------------------------------------------------------------------
// Structural projection of @aipehub/identity. Web depends on these
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

export function roleAtLeast(actual: IdentityRole, required: IdentityRole): boolean {
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
  kind: 'password' | 'admin_token' | 'api_key'
  identifier: string
  label: string | null
  createdAt: number
  lastUsedAt: number | null
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
}

// ---------------------------------------------------------------------------
// Cookie / IO helpers — kept private to this module so it stays
// independent of server.ts's helpers. Each is ≤20 lines; the
// duplication is preferable to widening server.ts's export surface.
// ---------------------------------------------------------------------------

export const IDENTITY_COOKIE = 'aipehub_identity'
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 7 // 7 days; mirrors IdentityStore default TTL
const MAX_BODY_BYTES = 1_000_000 // 1MB — matches server.ts readJsonBody

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const h = req.headers.cookie
  if (!h) return undefined
  for (const part of h.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

function setIdentityCookie(value: string, secure: boolean): string {
  const sameSite = secure ? 'Strict' : 'Lax'
  const sec = secure ? '; Secure' : ''
  return `${IDENTITY_COOKIE}=${value}; HttpOnly; SameSite=${sameSite}${sec}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`
}
function expireIdentityCookie(secure: boolean): string {
  const sameSite = secure ? 'Strict' : 'Lax'
  const sec = secure ? '; Secure' : ''
  return `${IDENTITY_COOKIE}=; HttpOnly; SameSite=${sameSite}${sec}; Path=/; Max-Age=0`
}

function readBearer(req: IncomingMessage): string | undefined {
  const h = req.headers['authorization']
  if (typeof h !== 'string') return undefined
  const m = /^Bearer\s+(.+)$/.exec(h)
  return m ? m[1]!.trim() : undefined
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (chunk) => {
      buf += chunk
      if (buf.length > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => {
      if (!buf) return resolve(undefined)
      try {
        resolve(JSON.parse(buf))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

// ---------------------------------------------------------------------------
// IdentityError mapping. Web has no compile-time access to the class
// (no import of @aipehub/identity) so we check structurally on the
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
      sendJson(res, { error: ec.message, code: ec.code }, 404)
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
  source: 'v3-admin' | 'v4-session' | 'v4-bearer' | 'none'
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
 * Resolve the v4 identity attached to a request. The caller layers
 * v3 admin auth on top (an admin without v4 identity still owns the
 * host because the v3 admin token is what bootstrap migrated).
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
}

export interface HandleIdentityRouteCtx {
  identity: IdentitySurface
  cookieSecure: boolean
  /**
   * true when the caller already proved v3-admin auth (Bearer hex or
   * ADMIN_COOKIE). v3 admin == v4 owner for this host's organisation.
   */
  isV3Admin: boolean
  /** Per-IP rate limiter; required for V4-AUDIT-01 protection. */
  loginLimiter: LoginRateLimiterLike
  /**
   * Resolved client IP from the request, used as the limiter key. The
   * caller (server.ts) computes this with its existing `clientIp()`
   * helper which respects `trustProxy` for the X-Forwarded-For header.
   */
  clientIp: string
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

  // -- owner gate for everything below ----------------------------------
  const v4 = resolveV4Auth(ctx.identity, req)
  const isOwner =
    ctx.isV3Admin || (v4.role !== null && roleAtLeast(v4.role, 'owner'))
  if (!isOwner) {
    sendJson(res, { error: 'owner role required' }, 403)
    return
  }

  if (method === 'GET' && path === '/api/admin/identity/me') {
    handleMe(ctx, v4, res)
    return
  }
  if (method === 'GET' && path === '/api/admin/identity/users') {
    handleListUsers(ctx, res)
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
    handleRevokeCredential(ctx, res, m[1]!)
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
  const b = body as { email?: unknown; password?: unknown }
  if (typeof b.email !== 'string' || typeof b.password !== 'string') {
    sendJson(res, { error: 'email and password required' }, 400)
    return
  }
  try {
    const sess = ctx.identity.authenticatePassword({
      email: b.email,
      password: b.password,
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
    if (ec && ec.code === 'authentication_failed') {
      ctx.loginLimiter.recordFailure(rlKey)
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
  if (tok) {
    try {
      ctx.identity.revokeSession(tok)
    } catch {
      // best-effort; even if revoke throws, clearing the cookie is right
    }
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'set-cookie': expireIdentityCookie(ctx.cookieSecure),
  })
  res.end(JSON.stringify({ ok: true }))
}

function handleMe(
  ctx: HandleIdentityRouteCtx,
  v4: ResolvedAuth,
  res: ServerResponse,
): void {
  if (v4.user !== null && v4.role !== null) {
    sendJson(res, {
      authSource: v4.source,
      user: v4.user,
      role: v4.role,
    })
    return
  }
  // Caller is a v3 admin without a v4 session — report that fact.
  // The v3 admin is the owner of the host's IdentityStore organisation,
  // but isn't bound to a specific User row (the bootstrap-created
  // `admin@local` user is the conceptual owner, but the v3 admin
  // cookie principal isn't joined to it here). Phase 3.1+ can fold
  // them together — for now we report the v3 view honestly.
  sendJson(res, {
    authSource: 'v3-admin',
    user: null,
    role: 'owner' as IdentityRole,
  })
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
  try {
    if (typeof b.role === 'string') {
      ctx.identity.setRole(userId, b.role as IdentityRole)
    }
    if (typeof b.password === 'string') {
      ctx.identity.setPassword(userId, b.password)
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
  res: ServerResponse,
  credentialId: string,
): void {
  try {
    ctx.identity.revokeCredential(credentialId)
    sendJson(res, { ok: true })
  } catch (err) {
    sendIdentityError(res, err)
  }
}
