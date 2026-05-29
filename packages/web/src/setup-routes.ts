/**
 * Route handlers for the first-time bootstrap wizard (`/api/setup/*`).
 *
 * Extracted from server.ts in the P3 audit cleanup (batch 3).
 *
 * Two routes that exist solely to handle the "host has booted, the
 * owner row exists, but nobody has set a password yet" window:
 *
 *   GET /api/setup/needs-bootstrap
 *     Anonymous. Returns `{bootstrap: boolean}` so the unified SPA
 *     can decide whether to render the wizard vs the login form. No
 *     PII leakage — the response is just a flag.
 *
 *   POST /api/setup/owner-password
 *     LOOPBACK ONLY. Body: `{password: string}`. Refuses if
 *     `listUsers().length !== 1` (multi-user host means setup is
 *     already done) or if the owner already has a password
 *     credential. On success: sets the password + writes
 *     `setup_owner_created` audit row + returns `{ok: true}`.
 *
 * Loopback-only matches the mint-admin-token CLI trust model —
 * anyone who can `ssh` to the host can already mint a token, so
 * letting them set the owner's first password from a browser on
 * localhost adds no new surface. Hosts behind a reverse proxy must
 * finish setup via `aipehub-host mint-admin-token` instead.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IdentitySurface } from './identity-routes.js'

// -- types ----------------------------------------------------------------

export interface SetupRoutesCtx {
  identity?: IdentitySurface
}

// -- HTTP helpers ---------------------------------------------------------

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > 1_000_000) { req.destroy(); reject(new Error('body too large')) }
    })
    req.on('end', () => {
      if (!buf) return resolve(undefined)
      try { resolve(JSON.parse(buf)) } catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

// -- route handler --------------------------------------------------------

/**
 * Handle `/api/setup/*` routes.
 * Returns `true` if the request was handled, `false` otherwise.
 */
export async function handleSetupRoute(
  ctx: SetupRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path === '/api/setup/needs-bootstrap' && method === 'GET') {
    if (!ctx.identity) { sendJson(res, { bootstrap: false }); return true }
    const users = ctx.identity.listUsers()
    if (users.length !== 1) { sendJson(res, { bootstrap: false }); return true }
    const owner = users[0]!
    const creds = ctx.identity.listCredentials(owner.id)
    const hasPwd = creds.some((c) => c.kind === 'password')
    sendJson(res, { bootstrap: !hasPwd })
    return true
  }

  if (path === '/api/setup/owner-password' && method === 'POST') {
    if (!ctx.identity) {
      sendJson(res, { error: 'v4 identity store not enabled on this host' }, 503)
      return true
    }
    // Loopback check uses socket.remoteAddress directly — we do NOT
    // honour x-forwarded-for here, even when trustProxy is on. A
    // reverse proxy sitting in front means setup MUST go through the
    // CLI; we'd rather refuse than let a misconfigured edge expose
    // the password-set route to the public.
    const sockAddr = req.socket?.remoteAddress ?? ''
    const isLoop =
      sockAddr === '127.0.0.1' ||
      sockAddr === '::1' ||
      sockAddr === '::ffff:127.0.0.1'
    if (!isLoop) {
      sendJson(
        res,
        { error: 'setup-owner-password is loopback-only; use `aipehub-host mint-admin-token` from a remote shell' },
        403,
      )
      return true
    }
    const users = ctx.identity.listUsers()
    if (users.length !== 1) {
      sendJson(res, { error: 'setup already complete (multi-user host)' }, 409)
      return true
    }
    const owner = users[0]!
    const creds = ctx.identity.listCredentials(owner.id)
    if (creds.some((c) => c.kind === 'password')) {
      sendJson(res, { error: 'owner already has a password' }, 409)
      return true
    }
    let body: unknown
    try { body = await readJsonBody(req) }
    catch { sendJson(res, { error: 'invalid JSON body' }, 400); return true }
    const b = (body ?? {}) as { password?: unknown }
    const password = typeof b.password === 'string' ? b.password : ''
    // setPassword inside the store enforces the real complexity gate
    // (and may throw weak_password). The 12-char floor here is a
    // friendly client-side hint to avoid round-trips for trivial mistakes.
    if (password.length < 12) {
      sendJson(res, { error: 'password must be at least 12 characters' }, 400)
      return true
    }
    try {
      ctx.identity.setPassword(owner.id, password)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      sendJson(res, { error: `setPassword failed: ${msg}` }, 400)
      return true
    }
    // Audit row uses actor_source='anonymous' because no session
    // existed when the call was made — only loopback proximity. The
    // target_user_id pins the row to the owner that just got their
    // password set.
    if (typeof ctx.identity.writeAuditLog === 'function') {
      try {
        ctx.identity.writeAuditLog({
          action: 'setup_owner_created',
          actorSource: 'anonymous',
          targetUserId: owner.id,
          ip: sockAddr,
          success: true,
        })
      } catch { /* audit failure is non-fatal */ }
    }
    sendJson(res, { ok: true })
    return true
  }

  return false
}
