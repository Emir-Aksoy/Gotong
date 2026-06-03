/**
 * Public SAML 2.0 SP login routes (Route B P1-M5e).
 *
 * The browser-facing half of SAML SSO. All OUTSIDE the admin cookie + CSRF gate
 * (they run in the public pre-CSRF zone of server.ts):
 *
 *   GET  /api/auth/saml/providers        list the enabled IdPs the login screen
 *                                        renders "Sign in with …" buttons for
 *   GET  /api/auth/saml/metadata?provider= the SP metadata XML to hand the IdP
 *                                        admin (entityID + ACS); defaults to the
 *                                        sole provider when only one is configured
 *   GET  /api/auth/saml/start?provider=  begin a login → 302 to the IdP SSO URL
 *                                        (a top-level browser navigation)
 *   POST /api/auth/saml/acs              the Assertion Consumer Service: the IdP
 *                                        auto-submits a cross-site form here with
 *                                        SAMLResponse + RelayState; on success we
 *                                        mint the SAME identity cookie a password
 *                                        login does (decision D-3) and 302 to `/`
 *
 * Why the ACS lives in the pre-CSRF zone: it is a CROSS-SITE form POST from the
 * IdP's auto-submit page — it carries no admin session and no CSRF token, so the
 * Origin check would reject it. Its authenticity comes from the SIGNED SAML
 * assertion (validated against the pinned IdP cert in @aipehub/saml), not from a
 * same-origin guarantee. RelayState is single-use server-side, which is the
 * CSRF/replay defense for this endpoint.
 *
 * `/start` and `/acs` are top-level browser navigations, so failures bounce to
 * `/?saml_error=<code>` for the SPA login screen rather than dumping JSON in the
 * tab. `/providers` is read by JS and speaks JSON. All SAML detail lives behind
 * the host-injected `SamlLoginSurface`; web has no compile-time dep on
 * @aipehub/saml or @aipehub/identity.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { sendJson, readTextBody } from './http-helpers.js'
import { setIdentityCookie } from './identity-routes.js'

/**
 * Host-injected SAML login surface (duck-typed — the host composes its
 * SamlLoginService + provider list + SP metadata into this). `complete` returns
 * a freshly minted session whose `.token` we drop into the identity cookie; the
 * host owns all crypto, RelayState, and account-resolution policy.
 */
export interface SamlLoginSurface {
  /** Enabled IdPs to render login buttons for (NEVER includes the cert). */
  listProviders(): Array<{ id: string; label: string | null }>
  /** Begin a login: returns the IdP redirect URL to send the browser to. */
  begin(providerId: string): { redirectUrl: string; relayState: string }
  /** Complete the ACS POST: validates the signed response, resolves a local user. */
  complete(input: { relayState: string; samlResponse: string }): { session: { token: string } }
  /** SP metadata XML for the given provider (throws a typed error if unknown). */
  metadata(providerId: string): string
}

export interface SamlRoutesCtx {
  samlLogin?: SamlLoginSurface
  cookieSecure: boolean
}

const PREFIX = '/api/auth/saml/'

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location })
  res.end()
}

/** Bounce a browser navigation back to the login screen with a reason code. */
function bounce(res: ServerResponse, errorCode: string): true {
  redirect(res, `/?saml_error=${encodeURIComponent(errorCode)}`)
  return true
}

/** Read a typed error `.code` (web has no compile-time access to SamlError). */
function codeOf(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code
  }
  return fallback
}

/**
 * Handle the public SAML login routes. Returns `true` if the request matched an
 * `/api/auth/saml/*` path (and was answered), `false` to fall through.
 */
export async function handleSamlRoute(
  ctx: SamlRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (!path.startsWith(PREFIX)) return false

  const url = new URL(req.url ?? path, 'http://localhost')

  // Public provider list — read by the login screen JS to render SSO buttons.
  // No host SAML config → empty list (not an error: "no SSO" is a valid state).
  if (method === 'GET' && path === '/api/auth/saml/providers') {
    sendJson(res, { providers: ctx.samlLogin ? ctx.samlLogin.listProviders() : [] })
    return true
  }

  // SP metadata XML for the IdP admin to import. Defaults to the lone provider
  // when exactly one is configured; otherwise ?provider= is required.
  if (method === 'GET' && path === '/api/auth/saml/metadata') {
    if (!ctx.samlLogin) {
      sendJson(res, { error: 'saml not enabled' }, 404)
      return true
    }
    let providerId = url.searchParams.get('provider') ?? ''
    if (!providerId) {
      const enabled = ctx.samlLogin.listProviders()
      if (enabled.length === 1) providerId = enabled[0]!.id
      else {
        sendJson(res, { error: 'specify ?provider=<id>' }, 400)
        return true
      }
    }
    try {
      const xml = ctx.samlLogin.metadata(providerId)
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' })
      res.end(xml)
    } catch (err) {
      sendJson(res, { error: codeOf(err, 'saml_metadata_failed') }, 404)
    }
    return true
  }

  // Begin a login (top-level browser navigation → 302 to the IdP SSO URL).
  if (method === 'GET' && path === '/api/auth/saml/start') {
    if (!ctx.samlLogin) return bounce(res, 'not_enabled')
    const providerId = url.searchParams.get('provider') ?? ''
    if (!providerId) return bounce(res, 'missing_provider')
    try {
      const { redirectUrl } = ctx.samlLogin.begin(providerId)
      redirect(res, redirectUrl)
    } catch (err) {
      bounce(res, codeOf(err, 'saml_start_failed'))
    }
    return true
  }

  // The Assertion Consumer Service — a cross-site form POST from the IdP.
  if (method === 'POST' && path === '/api/auth/saml/acs') {
    if (!ctx.samlLogin) return bounce(res, 'not_enabled')
    let body: string
    try {
      body = await readTextBody(req)
    } catch {
      return bounce(res, 'bad_request')
    }
    const form = new URLSearchParams(body)
    const samlResponse = form.get('SAMLResponse') ?? ''
    const relayState = form.get('RelayState') ?? ''
    if (!samlResponse || !relayState) return bounce(res, 'missing_params')
    try {
      const { session } = ctx.samlLogin.complete({ relayState, samlResponse })
      // Same identity cookie a password login mints (decision D-3).
      res.writeHead(302, {
        location: '/',
        'set-cookie': setIdentityCookie(session.token, ctx.cookieSecure),
      })
      res.end()
    } catch (err) {
      bounce(res, codeOf(err, 'saml_login_failed'))
    }
    return true
  }

  sendJson(res, { error: 'not found' }, 404)
  return true
}
