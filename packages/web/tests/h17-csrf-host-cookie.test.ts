/**
 * H17 regression — Web server CSRF defence (Host/Origin checks) and
 * cookie attribute hardening were under-tested. The audit asked for
 * per-branch coverage of three things:
 *
 *   1. `checkOrigin` (server.ts ~585) — six distinct decisions:
 *      - allowedHosts unset                         → no check (pass)
 *      - allowedHosts set, Host missing / unmatched → 403 untrusted host
 *      - allowedHosts set, Origin unparseable       → 403 bad origin
 *      - allowedHosts set + cookieSecure + http://  → 403 insecure origin
 *      - allowedHosts set, Origin host off list     → 403 cross-origin
 *      - allowedHosts set, Origin omitted           → pass (same-origin)
 *
 *   2. Method gating — POST/PUT/PATCH/DELETE pass through checkOrigin;
 *      GET/HEAD/OPTIONS skip it. A regression that gated GETs would
 *      bork the admin UI; a regression that ungated POSTs would re-
 *      open the CSRF hole.
 *
 *   3. `cookieValue` / `expireCookie` attributes:
 *      - HttpOnly always (regardless of cookieSecure)
 *      - SameSite=Lax when cookieSecure=false, Strict when true
 *      - Secure present only when cookieSecure=true
 *      - Path=/  Max-Age=604800 on set, =0 on expire
 *
 * Pre-3.4 these branches existed but only the happy paths were
 * exercised via manifest.test.ts; a future regression silently
 * dropping (say) the Secure flag would have shipped.
 *
 * We drive the server with raw `http.request` rather than `fetch()`
 * because we need full control of the `Host` header to simulate the
 * CSRF attacker — undici's fetch synthesises Host from the URL and
 * (depending on Node version) silently overrides user-supplied
 * values. Raw http puts whatever you give it on the wire.
 *
 * See AUDIT-v3.3.md finding H17.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space, type AdminRecord } from '@gotong/core'

import { serveWeb, type WebServerHandle } from '../src/server.js'

// -----------------------------------------------------------------------------
// Boot / teardown — shared with server-hygiene.test.ts in spirit, kept
// local so the two files stay independent.
// -----------------------------------------------------------------------------

interface BootOpts {
  cookieSecure?: boolean
  allowedHosts?: readonly string[]
}

interface BootResult {
  tmp: string
  hub: Hub
  space: Space
  server: WebServerHandle
  baseUrl: string
  admin: AdminRecord
  adminToken: string
  adminCookie: string
}

async function boot(opts: BootOpts = {}): Promise<BootResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-h17-'))
  const init = await Space.init(tmp, { name: 'h17-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()

  const { admin, token: adminToken } = await space.createAdmin('TestAdmin')
  const adminSid = 'h17-admin-sid-' + Math.random().toString(36).slice(2)
  await space.addAdminSession(adminSid, admin.id)
  const adminCookie = `gotong_admin=${adminSid}`

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(opts.cookieSecure !== undefined ? { cookieSecure: opts.cookieSecure } : {}),
    ...(opts.allowedHosts ? { allowedHosts: opts.allowedHosts } : {}),
    // Disable rate-limit noise. H17 is about Host/Origin/cookie surface,
    // not pacing (which lives in server-hygiene.test.ts under H19/H21).
    adminLoginRateLimit: { max: 0, windowSec: 60 },
    workerCreateRateLimit: { max: 0, windowSec: 60 },
  })

  return { tmp, hub, space, server, baseUrl: server.url, admin, adminToken, adminCookie }
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

// -----------------------------------------------------------------------------
// Raw HTTP helper — full control of the `Host` header.
// -----------------------------------------------------------------------------

interface RawResponse {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function rawRequest(opts: {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}): Promise<RawResponse> {
  const u = new URL(opts.url)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

// -----------------------------------------------------------------------------
// Set-Cookie attribute parser.
//
// Wire format: "name=value; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=604800"
// Names case-insensitive on the attribute side; values are case-sensitive
// (e.g. Strict vs strict matters per RFC 6265bis).
// -----------------------------------------------------------------------------

interface ParsedCookie {
  name: string
  value: string
  attrs: Map<string, string | true>
}

function parseSetCookie(header: string): ParsedCookie {
  const parts = header.split(';').map((s) => s.trim()).filter(Boolean)
  const head = parts[0] ?? ''
  const eq = head.indexOf('=')
  if (eq < 0) throw new Error('Set-Cookie missing name=value: ' + header)
  const name = head.slice(0, eq)
  const value = head.slice(eq + 1)
  const attrs = new Map<string, string | true>()
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!
    const e = p.indexOf('=')
    if (e < 0) attrs.set(p.toLowerCase(), true)
    else attrs.set(p.slice(0, e).toLowerCase(), p.slice(e + 1))
  }
  return { name, value, attrs }
}

function firstSetCookie(headers: IncomingHttpHeaders): string {
  const sc = headers['set-cookie']
  if (!sc || sc.length === 0) throw new Error('no Set-Cookie in response')
  return sc[0]!
}

// =============================================================================
// 1. checkOrigin — defence is opt-in
// =============================================================================

const GOOD_HOST = 'hub.example.com'
const BAD_HOST = 'attacker.example.com'

describe('H17 — checkOrigin: defence is opt-in', () => {
  // With allowedHosts unset (default), checkOrigin returns true
  // immediately even when the Host/Origin headers are hostile. This
  // documents the "no check unless explicitly opted in" posture for
  // local-only dev / single-machine use. Operators who want CSRF
  // defence MUST pass `allowedHosts: [...]`.

  let b: BootResult
  beforeEach(async () => {
    b = await boot()                              // allowedHosts unset
  })
  afterEach(async () => {
    await teardown(b)
  })

  it('passes POST with a bogus Host when allowedHosts is unset', async () => {
    const r = await rawRequest({
      url: `${b.baseUrl}/api/workers`,
      method: 'POST',
      headers: {
        host: BAD_HOST,
        'content-type': 'application/json',
        origin: `http://${BAD_HOST}`,
      },
      body: JSON.stringify({ id: 'opt-in-1', capabilities: [] }),
    })
    expect(r.status).toBe(200)
  })
})

// =============================================================================
// 1b. checkOrigin — Host header gating
// =============================================================================

describe('H17 — checkOrigin: Host header gating', () => {
  let b: BootResult
  beforeEach(async () => {
    b = await boot({ allowedHosts: [GOOD_HOST] })
  })
  afterEach(async () => {
    await teardown(b)
  })

  it('rejects POST with a Host off the allow-list (403 untrusted host)', async () => {
    const r = await rawRequest({
      url: `${b.baseUrl}/api/workers`,
      method: 'POST',
      headers: { host: BAD_HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'rej-host-1', capabilities: [] }),
    })
    expect(r.status).toBe(403)
    expect(r.body).toBe('forbidden: untrusted host')
  })

  it('rejects POST when Host is empty (403 untrusted host)', async () => {
    // Empty Host: arrives at the server as `req.headers.host === ''`,
    // which the falsy check `!host` catches before the Set membership
    // check.
    const r = await rawRequest({
      url: `${b.baseUrl}/api/workers`,
      method: 'POST',
      headers: { host: '', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'rej-host-empty', capabilities: [] }),
    })
    expect(r.status).toBe(403)
    expect(r.body).toBe('forbidden: untrusted host')
  })

  it('passes POST when Host matches and no Origin is sent', async () => {
    const r = await rawRequest({
      url: `${b.baseUrl}/api/workers`,
      method: 'POST',
      headers: { host: GOOD_HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'pass-1', capabilities: [] }),
    })
    expect(r.status).toBe(200)
  })

  it('Host membership is exact-string (port suffix is a different key)', async () => {
    // Documented contract: `allowedHosts: ['hub.example.com']` does NOT
    // implicitly allow `hub.example.com:8080`. Operators who terminate
    // TLS at a non-default port must list the full host:port.
    const r = await rawRequest({
      url: `${b.baseUrl}/api/workers`,
      method: 'POST',
      headers: {
        host: `${GOOD_HOST}:8080`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'port-suffix', capabilities: [] }),
    })
    expect(r.status).toBe(403)
    expect(r.body).toBe('forbidden: untrusted host')
  })
})

// =============================================================================
// 1c. checkOrigin — Origin header gating
// =============================================================================

describe('H17 — checkOrigin: Origin header gating', () => {
  let b: BootResult
  beforeEach(async () => {
    b = await boot({ allowedHosts: [GOOD_HOST] })
  })
  afterEach(async () => {
    await teardown(b)
  })

  it('rejects unparseable Origin (403 bad origin)', async () => {
    const r = await rawRequest({
      url: `${b.baseUrl}/api/workers`,
      method: 'POST',
      headers: {
        host: GOOD_HOST,
        origin: 'not a real url',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'bad-origin', capabilities: [] }),
    })
    expect(r.status).toBe(403)
    expect(r.body).toBe('forbidden: bad origin')
  })

  it('rejects when Origin host is off the allow-list (403 cross-origin)', async () => {
    const r = await rawRequest({
      url: `${b.baseUrl}/api/workers`,
      method: 'POST',
      headers: {
        host: GOOD_HOST,
        origin: `http://${BAD_HOST}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'cross-origin', capabilities: [] }),
    })
    expect(r.status).toBe(403)
    expect(r.body).toBe('forbidden: cross-origin')
  })

  it('passes when both Host and Origin match the allow-list', async () => {
    const r = await rawRequest({
      url: `${b.baseUrl}/api/workers`,
      method: 'POST',
      headers: {
        host: GOOD_HOST,
        origin: `http://${GOOD_HOST}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'pass-both', capabilities: [] }),
    })
    expect(r.status).toBe(200)
  })

  it('passes when Host matches and Origin is omitted (same-origin form POST)', async () => {
    // Browsers omit Origin for same-origin GET-form POSTs. SameSite=Lax
    // (or =Strict, see cookie tests below) already protects the cookie;
    // checkOrigin doesn't need to add a second hurdle here.
    const r = await rawRequest({
      url: `${b.baseUrl}/api/workers`,
      method: 'POST',
      headers: {
        host: GOOD_HOST,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'no-origin', capabilities: [] }),
    })
    expect(r.status).toBe(200)
  })
})

// =============================================================================
// 1d. checkOrigin — cookieSecure forces https:// on Origin
// =============================================================================

describe('H17 — checkOrigin: cookieSecure tightens Origin protocol', () => {
  let b: BootResult
  beforeEach(async () => {
    b = await boot({
      cookieSecure: true,
      allowedHosts: [GOOD_HOST],
    })
  })
  afterEach(async () => {
    await teardown(b)
  })

  it('rejects http:// Origin when cookieSecure=true (403 insecure origin)', async () => {
    const r = await rawRequest({
      url: `${b.baseUrl}/api/workers`,
      method: 'POST',
      headers: {
        host: GOOD_HOST,
        origin: `http://${GOOD_HOST}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'insecure', capabilities: [] }),
    })
    expect(r.status).toBe(403)
    expect(r.body).toBe('forbidden: insecure origin')
  })

  it('passes https:// Origin when cookieSecure=true', async () => {
    const r = await rawRequest({
      url: `${b.baseUrl}/api/workers`,
      method: 'POST',
      headers: {
        host: GOOD_HOST,
        origin: `https://${GOOD_HOST}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'secure-origin', capabilities: [] }),
    })
    expect(r.status).toBe(200)
  })
})

// =============================================================================
// 2. Method gating — checkOrigin only fires on write methods
// =============================================================================

describe('H17 — method gating: safe methods bypass checkOrigin', () => {
  let b: BootResult
  beforeEach(async () => {
    b = await boot({ allowedHosts: [GOOD_HOST] })
  })
  afterEach(async () => {
    await teardown(b)
  })

  it('GET with a hostile Host still reaches the route handler', async () => {
    // /healthz unconditionally 200s — proves the request reached the
    // handler instead of the 403 short-circuit.
    const r = await rawRequest({
      url: `${b.baseUrl}/healthz`,
      method: 'GET',
      headers: { host: BAD_HOST },
    })
    expect(r.status).toBe(200)
    expect(r.body).toBe('ok')
  })

  it('HEAD with a hostile Host still reaches the route handler', async () => {
    // HEAD has no body but the status code path is identical to GET.
    const r = await rawRequest({
      url: `${b.baseUrl}/healthz`,
      method: 'HEAD',
      headers: { host: BAD_HOST },
    })
    expect(r.status).toBe(200)
  })

  it('OPTIONS with a hostile Host bypasses the host gate', async () => {
    // OPTIONS isn't explicitly routed; the response will be whatever
    // the fallthrough emits — the contract here is just "not a 403
    // from checkOrigin". A regression that gated OPTIONS would 403 it.
    const r = await rawRequest({
      url: `${b.baseUrl}/healthz`,
      method: 'OPTIONS',
      headers: { host: BAD_HOST },
    })
    expect(r.body).not.toBe('forbidden: untrusted host')
  })

  it('POST with a hostile Host IS rejected at the host gate', async () => {
    // The control case — proves the test fixture actually engages the
    // gate (i.e. allowedHosts is correctly configured + the harness is
    // forging Host as we expect).
    const r = await rawRequest({
      url: `${b.baseUrl}/api/workers`,
      method: 'POST',
      headers: { host: BAD_HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'method-post', capabilities: [] }),
    })
    expect(r.status).toBe(403)
    expect(r.body).toBe('forbidden: untrusted host')
  })

  it('DELETE with a hostile Host IS rejected at the host gate', async () => {
    const r = await rawRequest({
      url: `${b.baseUrl}/api/workers/whatever`,
      method: 'DELETE',
      headers: { host: BAD_HOST },
    })
    expect(r.status).toBe(403)
    expect(r.body).toBe('forbidden: untrusted host')
  })
})

// =============================================================================
// 3. Cookie attribute hardening — set + expire shapes in both modes
// =============================================================================

const COOKIE_MAX_AGE_S = String(7 * 24 * 3600)

describe('H17 — cookie attributes: cookieSecure=false (dev / HTTP)', () => {
  let b: BootResult
  beforeEach(async () => {
    b = await boot()                              // cookieSecure defaults to false
  })
  afterEach(async () => {
    await teardown(b)
  })

  it('admin login sets HttpOnly + SameSite=Lax + Path=/ + Max-Age, no Secure', async () => {
    const r = await rawRequest({
      url: `${b.baseUrl}/admin?token=${encodeURIComponent(b.adminToken)}`,
      method: 'GET',
    })
    expect(r.status).toBe(302)
    const c = parseSetCookie(firstSetCookie(r.headers))
    expect(c.name).toBe('gotong_admin')
    expect(c.value.length).toBeGreaterThan(0)
    expect(c.attrs.get('httponly')).toBe(true)
    expect(c.attrs.get('samesite')).toBe('Lax')
    expect(c.attrs.has('secure')).toBe(false)
    expect(c.attrs.get('path')).toBe('/')
    expect(c.attrs.get('max-age')).toBe(COOKIE_MAX_AGE_S)
  })

  it('admin logout sends an empty cookie with Max-Age=0 (same flag set)', async () => {
    const r = await rawRequest({
      url: `${b.baseUrl}/api/admin/logout`,
      method: 'POST',
      headers: { cookie: b.adminCookie },
    })
    expect(r.status).toBe(200)
    const c = parseSetCookie(firstSetCookie(r.headers))
    expect(c.name).toBe('gotong_admin')
    expect(c.value).toBe('')                     // cookie value cleared
    expect(c.attrs.get('httponly')).toBe(true)
    expect(c.attrs.get('samesite')).toBe('Lax')
    expect(c.attrs.has('secure')).toBe(false)
    expect(c.attrs.get('max-age')).toBe('0')
  })

  it('worker create sets HttpOnly + SameSite=Lax + Path=/ + Max-Age, no Secure', async () => {
    const r = await rawRequest({
      url: `${b.baseUrl}/api/workers`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'cookie-worker-1', capabilities: [] }),
    })
    expect(r.status).toBe(200)
    const c = parseSetCookie(firstSetCookie(r.headers))
    expect(c.name).toBe('gotong_worker')
    expect(c.value.length).toBeGreaterThan(0)
    expect(c.attrs.get('httponly')).toBe(true)
    expect(c.attrs.get('samesite')).toBe('Lax')
    expect(c.attrs.has('secure')).toBe(false)
    expect(c.attrs.get('path')).toBe('/')
    expect(c.attrs.get('max-age')).toBe(COOKIE_MAX_AGE_S)
  })

  it('worker leave (DELETE) clears the cookie with Max-Age=0', async () => {
    // Create first so we have a real session sid to leave with.
    const create = await rawRequest({
      url: `${b.baseUrl}/api/workers`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'cookie-worker-2', capabilities: [] }),
    })
    const cset = parseSetCookie(firstSetCookie(create.headers))
    const workerCookie = `${cset.name}=${cset.value}`

    const r = await rawRequest({
      url: `${b.baseUrl}/api/workers/cookie-worker-2`,
      method: 'DELETE',
      headers: { cookie: workerCookie },
    })
    expect(r.status).toBe(200)
    const c = parseSetCookie(firstSetCookie(r.headers))
    expect(c.name).toBe('gotong_worker')
    expect(c.value).toBe('')
    expect(c.attrs.get('max-age')).toBe('0')
    expect(c.attrs.get('samesite')).toBe('Lax')
    expect(c.attrs.has('secure')).toBe(false)
  })
})

describe('H17 — cookie attributes: cookieSecure=true (production HTTPS)', () => {
  let b: BootResult
  beforeEach(async () => {
    b = await boot({ cookieSecure: true })
  })
  afterEach(async () => {
    await teardown(b)
  })

  it('admin login sets Secure + SameSite=Strict (plus HttpOnly/Path/Max-Age)', async () => {
    const r = await rawRequest({
      url: `${b.baseUrl}/admin?token=${encodeURIComponent(b.adminToken)}`,
      method: 'GET',
    })
    expect(r.status).toBe(302)
    const c = parseSetCookie(firstSetCookie(r.headers))
    expect(c.attrs.get('httponly')).toBe(true)
    expect(c.attrs.get('samesite')).toBe('Strict')
    expect(c.attrs.has('secure')).toBe(true)
    expect(c.attrs.get('path')).toBe('/')
    expect(c.attrs.get('max-age')).toBe(COOKIE_MAX_AGE_S)
  })

  it('admin logout keeps Secure + Strict on the clear', async () => {
    const r = await rawRequest({
      url: `${b.baseUrl}/api/admin/logout`,
      method: 'POST',
      headers: { cookie: b.adminCookie },
    })
    expect(r.status).toBe(200)
    const c = parseSetCookie(firstSetCookie(r.headers))
    expect(c.value).toBe('')
    expect(c.attrs.get('max-age')).toBe('0')
    expect(c.attrs.get('samesite')).toBe('Strict')
    expect(c.attrs.has('secure')).toBe(true)
  })

  it('worker create sets Secure + Strict in cookieSecure mode', async () => {
    const r = await rawRequest({
      url: `${b.baseUrl}/api/workers`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'secure-worker-1', capabilities: [] }),
    })
    expect(r.status).toBe(200)
    const c = parseSetCookie(firstSetCookie(r.headers))
    expect(c.attrs.get('samesite')).toBe('Strict')
    expect(c.attrs.has('secure')).toBe(true)
  })
})

// =============================================================================
// 4. HttpOnly invariant — never lapses, regardless of cookieSecure
// =============================================================================

describe('H17 — HttpOnly invariant (regression rail)', () => {
  // The Secure flag is conditional but HttpOnly NEVER is. A future
  // refactor that swaps cookieValue() for something that flags based
  // on a runtime guess (e.g. only when document.cookie access seems
  // needed) would silently disable defence-in-depth against XSS-driven
  // cookie theft. Fail loud here.

  it('admin login cookie is HttpOnly regardless of cookieSecure', async () => {
    for (const secure of [false, true]) {
      const b = await boot({ cookieSecure: secure })
      try {
        const r = await rawRequest({
          url: `${b.baseUrl}/admin?token=${encodeURIComponent(b.adminToken)}`,
          method: 'GET',
        })
        const c = parseSetCookie(firstSetCookie(r.headers))
        expect(c.attrs.get('httponly')).toBe(true)
      } finally {
        await teardown(b)
      }
    }
  })

  it('worker create cookie is HttpOnly regardless of cookieSecure', async () => {
    for (const secure of [false, true]) {
      const b = await boot({ cookieSecure: secure })
      try {
        const r = await rawRequest({
          url: `${b.baseUrl}/api/workers`,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: `httponly-${secure}`, capabilities: [] }),
        })
        const c = parseSetCookie(firstSetCookie(r.headers))
        expect(c.attrs.get('httponly')).toBe(true)
      } finally {
        await teardown(b)
      }
    }
  })
})
