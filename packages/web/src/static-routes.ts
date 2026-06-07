// Static-asset serving, extracted verbatim from server.ts (#19 megalith split).
// Zero behaviour change — this is the same dual-source (embedded base64 in
// prod, filesystem fallback in dev) static pipeline that lived inline in
// server.ts, lifted into its own module so server.ts shrinks toward a pure
// request router. Mirrors the earlier workflow-routes / agents-routes splits.

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCookie } from './http-helpers.js'
import { IDENTITY_COOKIE } from './identity-routes.js'
import { STATIC_ASSETS_BASE64 } from './static-assets.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// dist/static-routes.js compiles one level below the package root (alongside
// dist/server.js), so the static dir resolves to ../static identically to the
// original server.ts computation.
// Only used as a development fallback when STATIC_ASSETS_BASE64 is empty (i.e.
// someone is running source-tree files directly without first running
// `pnpm -C packages/web build:assets`). Production builds — npm install,
// docker, bun --compile single-file binary — all serve from the embedded
// in-memory map below.
const STATIC_DIR = join(__dirname, '..', 'static')

// Decode-once cache. The base64 map is constant; the first request per asset
// pays the decode cost, every subsequent request gets a cached Buffer. Using
// the global Buffer (Node + Bun both have it) keeps this runtime-agnostic.
const STATIC_ASSETS_CACHE = new Map<string, Buffer>()

function getEmbeddedAsset(name: string): Buffer | undefined {
  const cached = STATIC_ASSETS_CACHE.get(name)
  if (cached) return cached
  const b64 = STATIC_ASSETS_BASE64[name]
  if (b64 === undefined) return undefined
  const buf = Buffer.from(b64, 'base64')
  STATIC_ASSETS_CACHE.set(name, buf)
  return buf
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Built-in templates (templates/bundles/*.yaml) are copied under
  // static/builtin-bundles/ at build time and served directly. The
  // text/* MIME lets the admin UI's bundle-import "use built-in" button
  // fetch and read them as plain text without binary decoding.
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  // PWA assets (Phase 12 M9). The web app manifest spec mandates
  // application/manifest+json; the SVG icon needs image/svg+xml so the
  // browser (and the manifest icon loader) treats it as an image.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
}

// Cookie name re-declared locally rather than imported from server.ts to keep
// this module a leaf (server.ts imports here — importing back would cycle).
// 'aipehub_admin' is a stable wire constant shared with server.ts's
// ADMIN_COOKIE; both must stay in sync.
const ADMIN_COOKIE = 'aipehub_admin'

/**
 * Narrow duck-typed slice of server.ts's `HandlerCtx` that `serveAppHtml`
 * actually needs — only the v4 identity session lookup and the v3 admin
 * session lookup. Keeping this local (rather than exporting HandlerCtx)
 * preserves the module boundary: static-routes never sees the full ctx.
 */
export interface AppHtmlCtx {
  identity?: { getSessionByToken(token: string): { role: string } | null } | undefined
  space: { findAdminSession(sid: string): Promise<unknown> }
}

export async function serveStatic(res: ServerResponse, requested: string): Promise<void> {
  const safe = normalize(requested)
  if (safe.startsWith('..') || safe.includes(`..${sep}`)) {
    res.writeHead(400); res.end(); return
  }

  // Normalise to forward slashes so the lookup key matches what the
  // generator emitted (it always uses '/' regardless of the host OS).
  const key = safe.split(sep).join('/')
  const ext = extname(safe)
  const contentType = MIME[ext] ?? 'application/octet-stream'

  // AUDIT-P3-07: baseline security headers for every static response.
  // Applied uniformly (not just HTML) — the cost is bytes-per-response,
  // the benefit is defense-in-depth without per-page bookkeeping.
  //   X-Content-Type-Options: nosniff — MIME-sniffing prevention.
  //   X-Frame-Options: DENY — clickjacking prevention (admin / me /
  //     invite must never be embedded in a third-party page).
  //   Referrer-Policy: no-referrer — no token / state leaks via Referer
  //     to any subresource the page might fetch.
  // Note: full CSP is intentionally NOT added here — admin.js uses
  // inline event handlers in a few places; a strict CSP would break
  // them and demands a separate refactor.
  const securityHeaders: Record<string, string> = {
    'content-type': contentType,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  }

  // Production path: embedded asset map. Populated by
  // scripts/build-static-assets.mjs; works in node, bun, and bun --compile
  // single-file binaries (where filesystem reads relative to import.meta.url
  // are not available).
  const embedded = getEmbeddedAsset(key)
  if (embedded) {
    res.writeHead(200, securityHeaders)
    res.end(embedded)
    return
  }

  // Dev fallback: read from disk. Only reached when the build:assets
  // generator hasn't been run yet (fresh checkout, `pnpm dev`-style
  // workflow, or someone editing static/ files and serving without a
  // rebuild). Identical 404 semantics as before.
  const full = join(STATIC_DIR, safe)
  if (!full.startsWith(STATIC_DIR + sep) && full !== STATIC_DIR) {
    res.writeHead(400); res.end(); return
  }
  try {
    const data = await readFile(full)
    res.writeHead(200, securityHeaders)
    res.end(data)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    throw err
  }
}

/**
 * C1 — serve `app.html` (the unified SPA shell) with the viewer's v4
 * role injected into the `<meta name="x-aipehub-role">` tag.
 *
 * Role resolution order:
 *   1. v4 identity cookie → `identity.getSessionByToken().role` —
 *      authoritative for member / viewer / admin / owner.
 *   2. v3 admin cookie (legacy `/admin?token=` flow, or admins migrated
 *      forward from Phase 1) → treated as 'owner'-equivalent for SPA
 *      rendering. v3 admin is unconditional access; the role-aware tab
 *      filter would otherwise lock these accounts out of the new shell
 *      until they re-login via v4.
 *   3. Neither → empty string. app.js sees `''` and renders the
 *      anonymous login form; server-side enforcement is unchanged
 *      (every API route still runs its own auth gate).
 *
 * The injected meta is a RENDER HINT only — never a security boundary.
 * A user who forges a v4 cookie that fails server validation will see
 * the tab matching the forged role but every API call returns 401/403
 * because they don't have a real session.
 */
export async function serveAppHtml(
  ctx: AppHtmlCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let role = ''
  // v4 cookie first.
  if (ctx.identity) {
    const tok = readCookie(req, IDENTITY_COOKIE)
    if (tok) {
      try {
        const r = ctx.identity.getSessionByToken(tok)
        if (r) role = r.role
      } catch {
        // bad/expired cookie — treat as anonymous; the SPA will show
        // the login form. Don't leak the error to the client.
      }
    }
  }
  // v3 admin fallback.
  if (!role) {
    const sid = readCookie(req, ADMIN_COOKIE)
    if (sid) {
      const sess = await ctx.space.findAdminSession(sid)
      if (sess) role = 'owner'
    }
  }

  const securityHeaders = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  }

  // Same dual-source pattern as serveStatic — embedded base64 in prod,
  // filesystem fallback in dev. The cache keeps app.html as a Buffer;
  // we toString() per request because the role differs per call. The
  // template body is small (~37 KB) so the per-request encode is cheap
  // — well under a memory-cache cost for keying per role.
  let raw: string | null = null
  const embedded = getEmbeddedAsset('app.html')
  if (embedded) {
    raw = embedded.toString('utf8')
  } else {
    try {
      raw = (await readFile(join(STATIC_DIR, 'app.html'))).toString('utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('app.html missing — run packages/web build:assets')
        return
      }
      throw err
    }
  }

  // Single, idempotent substitution. The placeholder is `<!--AIPE_ROLE-->`
  // — anything else (legitimate user content, future translated strings)
  // is left intact. Role values are validated against a small enum so
  // an attacker who somehow stuffed garbage into the session can't break
  // out of the meta attribute.
  const ALLOWED_ROLES = new Set(['owner', 'admin', 'member', 'viewer'])
  const safeRole = ALLOWED_ROLES.has(role) ? role : ''
  const out = raw.replace('<!--AIPE_ROLE-->', safeRole)

  res.writeHead(200, securityHeaders)
  res.end(out)
}
