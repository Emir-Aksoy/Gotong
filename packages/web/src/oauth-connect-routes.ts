/**
 * Outbound OAuth "connect" routes (C-M2-M3, 接入现实生活 track).
 *
 * The browser-facing half of connecting a real-life MCP connector to the user's
 * own account (Google Calendar, Gmail, Notion-hosted…). Two endpoints in DIFFERENT
 * auth zones, on purpose — the OPPOSITE posture of the OIDC LOGIN routes:
 *
 *   POST /api/admin/oauth/start   ADMIN-GATED. "connect MY Google" is an owner
 *                                 action, not a public login, so unlike the OIDC
 *                                 `/start` this sits behind requireAdmin + CSRF.
 *                                 Returns the provider authorize URL as JSON; the
 *                                 panel JS navigates the top-level browser there.
 *                                 (Gating begin is the control point against a
 *                                 token-fixation attack — an ungated begin would
 *                                 let anyone bind THEIR provider account to the
 *                                 hub's connector.)
 *   GET  /api/oauth/callback      PUBLIC + pre-CSRF. The provider redirects the
 *                                 browser back here (top-level nav, no Origin, no
 *                                 CSRF token possible), so the single-use
 *                                 server-minted `state` is the only CSRF binding.
 *                                 On success it persists the token set and 302s
 *                                 back to the panel with ?oauth_connected=<id>.
 *
 * All OAuth detail lives behind the host-injected `OAuthConnectSurface`; web has
 * no compile-time dep on @gotong/identity or the host connect service. When the
 * host wired no surface (no identity / opt-in off) both routes degrade honestly:
 * `/start` → 503, `/callback` → bounce to ?oauth_error=not_enabled.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { readJsonBody, sendJson } from './http-helpers.js'

/**
 * Host-injected outbound-OAuth connect surface (duck-typed — the host's
 * OAuthConnectService satisfies it). `begin` returns the authorize URL to
 * redirect to; `complete` validates state, exchanges the code, and persists the
 * token set, returning which connector was connected. The host owns all crypto,
 * state, and token storage.
 */
export interface OAuthConnectSurface {
  begin(connectorId: string): Promise<{ authorizationUrl: string }>
  complete(input: { state: string; code: string }): Promise<{ connectorId: string }>
}

export interface OAuthConnectCallbackCtx {
  oauthConnect?: OAuthConnectSurface
}

export interface OAuthConnectAdminCtx {
  oauthConnect?: OAuthConnectSurface
  // Returns a truthy admin record when authed, null otherwise (having written the
  // 401). Typed loosely (Promise<unknown>) so web needn't import the host's
  // AdminRecord; we only ever check truthiness.
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location })
  res.end()
}

/** Bounce a browser navigation back to the panel with a reason code. */
function bounce(res: ServerResponse, errorCode: string): true {
  redirect(res, `/?oauth_error=${encodeURIComponent(errorCode)}`)
  return true
}

/** Read a typed error `.code` (web has no compile-time access to OAuthError). */
function codeOf(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code
  }
  return fallback
}

/**
 * The PUBLIC callback (provider top-level redirect). Returns `true` if it
 * matched `/api/oauth/callback`, `false` to fall through. State-protected only —
 * no cookie/CSRF (the provider redirect carries neither).
 */
export async function handleOAuthConnectCallbackRoute(
  ctx: OAuthConnectCallbackCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path !== '/api/oauth/callback') return false
  if (method !== 'GET') {
    sendJson(res, { error: `method ${method} not allowed` }, 405)
    return true
  }
  if (!ctx.oauthConnect) return bounce(res, 'not_enabled')
  const url = new URL(req.url ?? path, 'http://localhost')
  // The provider can report its own failure (user denied, etc.) via ?error=.
  const provErr = url.searchParams.get('error')
  if (provErr) return bounce(res, provErr)
  const code = url.searchParams.get('code') ?? ''
  const state = url.searchParams.get('state') ?? ''
  if (!code || !state) return bounce(res, 'missing_params')
  try {
    const { connectorId } = await ctx.oauthConnect.complete({ state, code })
    redirect(res, `/?oauth_connected=${encodeURIComponent(connectorId)}`)
  } catch (err) {
    bounce(res, codeOf(err, 'oauth_connect_failed'))
  }
  return true
}

/**
 * The ADMIN-GATED begin (owner starts a connect). Returns `true` if it matched
 * `/api/admin/oauth/start`, `false` to fall through. requireAdmin runs first;
 * returns the authorize URL as JSON for the panel to navigate to.
 */
export async function handleOAuthConnectAdminRoute(
  ctx: OAuthConnectAdminCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path !== '/api/admin/oauth/start') return false
  if (method !== 'POST') {
    sendJson(res, { error: `method ${method} not allowed` }, 405)
    return true
  }
  if (!(await ctx.requireAdmin(req, res))) return true
  if (!ctx.oauthConnect) {
    sendJson(res, { error: 'oauth connect not enabled on this host' }, 503)
    return true
  }
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, { error: 'invalid JSON body' }, 400)
    return true
  }
  const raw = (body ?? {}) as { connectorId?: unknown }
  const connectorId = typeof raw.connectorId === 'string' ? raw.connectorId.trim() : ''
  if (!connectorId) {
    sendJson(res, { error: 'connectorId is required' }, 400)
    return true
  }
  try {
    const { authorizationUrl } = await ctx.oauthConnect.begin(connectorId)
    sendJson(res, { authorizationUrl })
  } catch (err) {
    // A bad connector id / disabled connector is a client error, not a 500.
    sendJson(res, { error: codeOf(err, 'oauth_begin_failed') }, 400)
  }
  return true
}
