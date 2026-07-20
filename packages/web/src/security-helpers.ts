// HTTP security helpers, extracted verbatim from server.ts (#19 megalith
// split). Zero behaviour change — the baseline response headers, proxy-aware
// client-IP derivation, cross-origin guard, and constant-time bearer compare
// that lived inline in server.ts, lifted into a leaf module. Pure functions
// (plus one const table); they take a narrow duck-typed ctx slice rather than
// the full unexported HandlerCtx, keeping the boundary tight.

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Narrow slice of server.ts's `HandlerCtx` that the request-level security
 * helpers actually read. Keeping it local (rather than exporting HandlerCtx)
 * preserves the module boundary — security-helpers never sees the full ctx.
 */
export interface SecurityCtx {
  trustProxy: boolean
  allowedHosts: Set<string> | undefined
  cookieSecure: boolean
}

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  // Allow inline styles + scripts for the SPA. The static admin/worker
  // pages are first-party; no third-party loads. CSP could be tightened
  // further if the SPA is rewritten to drop inline event handlers.
  'content-security-policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'",
}

/**
 * Per-request client IP, used for rate-limit keying.
 *
 * Honours `X-Forwarded-For` ONLY when the host was started with
 * `trustProxy: true` (see `WebServerOptions`). Otherwise XFF is
 * ignored — a remote attacker can set the header on every request
 * to defeat a naïve rate limiter, so we don't trust it by default.
 *
 * We read the FIRST entry, so with `trustProxy` on the whole limiter
 * rests on the proxy not letting a client forge that entry. Note the
 * mechanism that actually protects you, because it is not "the proxy
 * overwrites XFF": both Caddy and nginx *append* the peer address to
 * whatever arrived. What keeps it honest is that they ignore an
 * incoming XFF unless it came from an address the operator explicitly
 * trusted — Caddy's docs: "by default, the proxy will ignore their
 * values from incoming requests, to prevent spoofing".
 *
 * The footgun is therefore an over-broad trust list, not a missing
 * one. Our own `caddy/Caddyfile` sets `trusted_proxies static
 * private_ranges` (needed so Caddy trusts the compose network), which
 * would also trust a client dialling in from a private range — hence
 * the belt-and-braces `header_up -X-Forwarded-For` there, stripping
 * the client value before Caddy sets its own. If you widen
 * `trusted_proxies` on a lane that lacks that strip, the limiter
 * becomes forgeable — a proxy-config bug, not a server bug.
 */
export function clientIp(ctx: SecurityCtx, req: IncomingMessage): string {
  if (ctx.trustProxy) {
    const fwd = req.headers['x-forwarded-for']
    if (typeof fwd === 'string' && fwd.length > 0) {
      const first = fwd.split(',')[0]?.trim()
      if (first) return first
    }
  }
  return req.socket.remoteAddress ?? 'unknown'
}

/**
 * Reject cross-origin state-changing requests. Defence in depth on top of
 * SameSite cookies: a misconfigured browser or a same-site subdomain
 * attacker can sometimes get around SameSite=Lax for top-level POST. The
 * Origin (or Referer) and Host headers must agree.
 *
 * Returns true if request should be allowed, false if rejected (and 403
 * already written to res).
 */
export function checkOrigin(
  ctx: SecurityCtx,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (!ctx.allowedHosts) return true                   // strict-check disabled
  const host = req.headers.host
  if (!host || !ctx.allowedHosts.has(host)) {
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('forbidden: untrusted host')
    return false
  }
  const origin = req.headers.origin
  if (origin) {
    let parsed: URL
    try { parsed = new URL(origin) } catch {
      res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden: bad origin'); return false
    }
    // protocol must match HTTPS posture, host must be on the allow-list
    const wantProto = ctx.cookieSecure ? 'https:' : null
    if (wantProto && parsed.protocol !== wantProto) {
      res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden: insecure origin'); return false
    }
    if (!ctx.allowedHosts.has(parsed.host)) {
      res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden: cross-origin'); return false
    }
  }
  // No Origin header on same-origin GET-form POSTs is fine; SameSite=Strict
  // already protects those once we're cookieSecure.
  return true
}

/**
 * Extract a `Bearer <token>` value from the Authorization header, or undefined.
 * Used by the internal `/metrics` scrape route (Route B P0-M7) — a
 * server-to-server domain with no browser session, so it carries its token
 * in the standard Authorization header, not a cookie.
 */
export function readBearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization
  if (!auth) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  return m?.[1]?.trim() || undefined
}

/**
 * Constant-time string compare for bearer secrets — never short-circuit on the
 * first differing byte (that leaks length/prefix via timing). Length mismatch
 * returns false up front (lengths aren't secret), otherwise `timingSafeEqual`.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
