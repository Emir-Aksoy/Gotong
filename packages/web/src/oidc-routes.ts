/**
 * Public OIDC login routes (Route B P1-M4e-2).
 *
 * The browser-facing half of SSO. Three GET endpoints, all OUTSIDE the admin
 * cookie + CSRF gate (they run in the public pre-CSRF zone of server.ts):
 *
 *   GET /api/auth/oidc/providers       list the enabled IdPs the login screen
 *                                      should render "Sign in with …" buttons for
 *   GET /api/auth/oidc/start?provider= begin a login → 302 to the IdP's authorize
 *                                      endpoint (a top-level browser navigation)
 *   GET /api/auth/oidc/callback        the IdP redirects the browser back here
 *                                      with ?code=&state=; on success we mint the
 *                                      SAME identity cookie a password login does
 *                                      (decision D-3) and 302 to `/`
 *
 * `/start` and `/callback` are top-level browser navigations (no fetch, no
 * Origin header, no session yet), so a raw JSON error in the tab would be
 * hostile UX — they bounce failures to `/?oidc_error=<code>` for the SPA login
 * screen to surface. `/providers` is read by JS, so it speaks JSON.
 *
 * All OIDC detail lives behind the host-injected `OidcLoginSurface`; web has no
 * compile-time dep on @aipehub/identity or the host OIDC client. When the host
 * wired no providers the surface is absent → `/providers` returns an empty list
 * (no SSO configured is the honest truth, not an error).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { sendJson } from './http-helpers.js'
import { setIdentityCookie } from './identity-routes.js'

/**
 * Host-injected OIDC login surface (duck-typed — the host's OidcLoginService +
 * provider list satisfy it). `complete` returns a freshly minted session whose
 * `.token` we drop into the identity cookie; the host owns all crypto, state,
 * and account-resolution policy.
 */
export interface OidcLoginSurface {
  /** Enabled IdPs to render login buttons for (NEVER includes any secret). */
  listProviders(): Array<{ id: string; label: string | null; issuer: string }>
  /** Begin a login: returns the IdP authorize URL to redirect the browser to. */
  begin(providerId: string): Promise<{ authorizationUrl: string; state: string }>
  /** Complete the callback: validates state + id_token, resolves a local user. */
  complete(input: { state: string; code: string }): Promise<{ session: { token: string } }>
}

export interface OidcRoutesCtx {
  oidcLogin?: OidcLoginSurface
  cookieSecure: boolean
}

const PREFIX = '/api/auth/oidc/'

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location })
  res.end()
}

/** Bounce a browser navigation back to the login screen with a reason code. */
function bounce(res: ServerResponse, errorCode: string): true {
  redirect(res, `/?oidc_error=${encodeURIComponent(errorCode)}`)
  return true
}

/** Read a typed error `.code` (web has no compile-time access to OidcError). */
function codeOf(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code
  }
  return fallback
}

/**
 * Handle the public OIDC login routes. Returns `true` if the request matched
 * an `/api/auth/oidc/*` path (and was answered), `false` to fall through.
 */
export async function handleOidcRoute(
  ctx: OidcRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (!path.startsWith(PREFIX)) return false
  if (method !== 'GET') {
    sendJson(res, { error: `method ${method} not allowed` }, 405)
    return true
  }

  const url = new URL(req.url ?? path, 'http://localhost')

  // Public provider list — read by the login screen JS to render SSO buttons.
  // No host OIDC config → empty list (not an error: "no SSO" is a valid state).
  if (path === '/api/auth/oidc/providers') {
    sendJson(res, { providers: ctx.oidcLogin ? ctx.oidcLogin.listProviders() : [] })
    return true
  }

  // Begin a login (top-level browser navigation → 302 to the IdP).
  if (path === '/api/auth/oidc/start') {
    if (!ctx.oidcLogin) return bounce(res, 'not_enabled')
    const providerId = url.searchParams.get('provider') ?? ''
    if (!providerId) return bounce(res, 'missing_provider')
    try {
      const { authorizationUrl } = await ctx.oidcLogin.begin(providerId)
      redirect(res, authorizationUrl)
    } catch (err) {
      bounce(res, codeOf(err, 'oidc_start_failed'))
    }
    return true
  }

  // The IdP's redirect back to us (top-level GET, no Origin header).
  if (path === '/api/auth/oidc/callback') {
    if (!ctx.oidcLogin) return bounce(res, 'not_enabled')
    // The IdP can report its own failure (user denied, etc.) via ?error=.
    const idpError = url.searchParams.get('error')
    if (idpError) return bounce(res, idpError)
    const code = url.searchParams.get('code') ?? ''
    const state = url.searchParams.get('state') ?? ''
    if (!code || !state) return bounce(res, 'missing_params')
    try {
      const { session } = await ctx.oidcLogin.complete({ state, code })
      // Same identity cookie a password login mints (decision D-3).
      res.writeHead(302, {
        location: '/',
        'set-cookie': setIdentityCookie(session.token, ctx.cookieSecure),
      })
      res.end()
    } catch (err) {
      bounce(res, codeOf(err, 'oidc_login_failed'))
    }
    return true
  }

  sendJson(res, { error: 'not found' }, 404)
  return true
}
