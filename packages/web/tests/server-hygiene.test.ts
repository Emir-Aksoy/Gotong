/**
 * Regression tests for the v3.4 Batch 1.6 audit fixes — web server hygiene
 * (H18 + H19 + H21). All three findings live in `packages/web/src/server.ts`
 * and are tied together by the rate-limiter + handler-error-fallback paths,
 * so they ride in a single test file.
 *
 *   H18 — `res.end(\`server error: ${err.message}\`)` leaked internal err
 *         details (paths, SQL fragments, stack residue) to the client.
 *         Fix: respond with a redacted `internal server error (requestId=…)`
 *         and stash the full err in the logger keyed by that requestId.
 *
 *   H19 — `RateLimiter.hits` Map only GC'd the specific key being checked,
 *         so an attacker rotating source IPs grew the Map without bound.
 *         Fix: periodic sweep + size cap.
 *
 *   H21 — Bearer auth was rate-limited but the cookie-sid lookup path was
 *         not, letting an attacker spray random cookie sids to grind
 *         `findAdminSession` (and its disk IO). Fix: peek-then-record
 *         on the cookie path with a `cookie:` namespaced key so legitimate
 *         signed-in admins don't burn budget on success.
 *
 * See AUDIT-v3.3.md for the full audit findings.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Hub,
  Space,
  type AdminRecord,
} from '@aipehub/core'

import {
  serveWeb,
  RateLimiter,
  DEFAULT_RATE_LIMITER_MAX_KEYS,
  type WebServerHandle,
} from '../src/server.js'

// -------------------------------------------------------------------------
// Common boot helper. Heavier than the unit tests need (it constructs a
// real Space + Hub + serveWeb), but the H18 / H21 tests have to drive
// real HTTP traffic, so we may as well share the setup.
// -------------------------------------------------------------------------

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

interface BootOpts {
  adminLoginRateLimit?: { max: number; windowSec: number }
}

async function boot(opts: BootOpts = {}): Promise<BootResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-hygiene-'))
  const init = await Space.init(tmp, { name: 'hygiene-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()

  const { admin, token: adminToken } = await space.createAdmin('TestAdmin')
  const adminSid = 'a-test-sid-' + Math.random().toString(36).slice(2)
  await space.addAdminSession(adminSid, admin.id)
  const adminCookie = `aipehub_admin=${adminSid}`

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(opts.adminLoginRateLimit
      ? { adminLoginRateLimit: opts.adminLoginRateLimit }
      : {}),
  })

  return { tmp, hub, space, server, baseUrl: server.url, admin, adminToken, adminCookie }
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

// =========================================================================
// H18 — 500 responses redact `err.message` and surface a requestId
// =========================================================================

describe('H18: redact err.message in 500 responses', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('strips err.message from the body and emits a requestId', async () => {
    // Inject a sensitive-looking error into the admin-auth path. The
    // `findAdminFromRequest` cookie path calls `space.admins()` once
    // the sid resolves to a session, so any GET that uses
    // `requireAdmin` will hit our injected throw.
    const SENSITIVE_PATH = '/var/lib/aipehub/SECRET_PATH_THAT_MUST_NOT_LEAK'
    const SENSITIVE_SQL = 'SELECT * FROM admin_tokens WHERE hash='
    const original = b.space.admins.bind(b.space)
    let calls = 0
    b.space.admins = (async () => {
      calls++
      throw new Error(`open ${SENSITIVE_PATH}: ENOENT — ${SENSITIVE_SQL}`)
    }) as typeof b.space.admins

    try {
      const res = await fetch(`${b.baseUrl}/api/admin/metrics`, {
        headers: { cookie: b.adminCookie },
      })
      expect(res.status).toBe(500)
      const body = await res.text()

      // Nothing about the underlying error should reach the wire.
      expect(body).not.toContain(SENSITIVE_PATH)
      expect(body).not.toContain('ENOENT')
      expect(body).not.toContain(SENSITIVE_SQL)
      // Pre-3.4 the body was `server error: ${err.message}`; that prefix
      // must be gone.
      expect(body.startsWith('server error:')).toBe(false)

      // The new shape is `internal server error (requestId=<12 hex>)`.
      expect(body).toMatch(/^internal server error \(requestId=[0-9a-f]{12}\)$/)
      expect(calls).toBeGreaterThan(0)
    } finally {
      b.space.admins = original as typeof b.space.admins
    }
  })

  it('emits a fresh requestId per failure (not a static placeholder)', async () => {
    const original = b.space.admins.bind(b.space)
    b.space.admins = (async () => {
      throw new Error('classified')
    }) as typeof b.space.admins

    try {
      const r1 = await (await fetch(`${b.baseUrl}/api/admin/metrics`, {
        headers: { cookie: b.adminCookie },
      })).text()
      const r2 = await (await fetch(`${b.baseUrl}/api/admin/metrics`, {
        headers: { cookie: b.adminCookie },
      })).text()
      const id1 = /requestId=([0-9a-f]+)/.exec(r1)?.[1]
      const id2 = /requestId=([0-9a-f]+)/.exec(r2)?.[1]
      expect(id1).toBeTruthy()
      expect(id2).toBeTruthy()
      expect(id1).not.toBe(id2)
    } finally {
      b.space.admins = original as typeof b.space.admins
    }
  })
})

// =========================================================================
// H19 — RateLimiter sweeps stale entries so an IP-rotating attacker
// cannot grow the underlying Map without bound.
// =========================================================================

describe('H19: RateLimiter sweep + size cap', () => {
  it('drops entries that have aged out beyond the window', async () => {
    // Tight window + tight sweep cadence: every key expires fast and
    // the very next `check()` should trigger maybeSweep().
    const rl = new RateLimiter(3, 50, {
      sweepIntervalMs: 10,
      maxKeys: DEFAULT_RATE_LIMITER_MAX_KEYS,
    })
    rl.check('1.1.1.1')
    rl.check('2.2.2.2')
    rl.check('3.3.3.3')
    expect(rl.size()).toBe(3)

    // Wait long enough for the 50 ms window to elapse AND the 10 ms
    // sweep timer.
    await new Promise((r) => setTimeout(r, 80))

    // The next check fires maybeSweep() which sees 80 ms > 10 ms and
    // walks the Map. 1/2/3's timestamps are all >50 ms old → dropped.
    rl.check('4.4.4.4')
    expect(rl.size()).toBe(1)
  })

  it('caps memory under heavy unique-key churn', async () => {
    // 5 ms window + 5 ms sweep cadence with maxKeys=200. After 5000
    // unique writes the Map MUST be far smaller than the write count —
    // pre-3.4 it would simply hold all 5000 entries forever.
    //
    // The exact ceiling depends on host scheduling (setImmediate slot
    // jitter, GC pauses, Date.now() granularity on macOS vs Linux), so
    // we don't pin an exact size — the regression we're guarding
    // against is "Map grows linearly with unique key count".
    const rl = new RateLimiter(1, 5, { sweepIntervalMs: 5, maxKeys: 200 })
    for (let i = 0; i < 5000; i++) {
      rl.check(`unique-${i}`)
      if (i % 50 === 0) await new Promise((r) => setImmediate(r))
    }
    // Cap is generous but still ORDERS OF MAGNITUDE below the
    // unmitigated 5000. If sweep stops working, size() runs away to
    // 5000+.
    expect(rl.size()).toBeLessThan(1000)
  })

  it('still rejects when over budget within the window', () => {
    // The H19 sweep must not relax the existing limit semantics.
    const rl = new RateLimiter(2, 60_000)
    expect(rl.check('x')).toBe(true)
    expect(rl.check('x')).toBe(true)
    expect(rl.check('x')).toBe(false)
  })

  it('peek + recordFailure share budget with check', () => {
    const rl = new RateLimiter(2, 60_000)
    expect(rl.peek('y')).toBe(true)
    rl.recordFailure('y')
    expect(rl.peek('y')).toBe(true)
    rl.recordFailure('y')
    // Two failures recorded; peek now reports exhausted.
    expect(rl.peek('y')).toBe(false)
    // check() also sees the budget gone — both paths share state.
    expect(rl.check('y')).toBe(false)
  })

  it('peek does NOT consume budget on success', () => {
    const rl = new RateLimiter(2, 60_000)
    // 100 peeks should not burn budget if peek doesn't record.
    for (let i = 0; i < 100; i++) expect(rl.peek('z')).toBe(true)
    // Budget is still untouched; check() must still succeed twice.
    expect(rl.check('z')).toBe(true)
    expect(rl.check('z')).toBe(true)
    expect(rl.check('z')).toBe(false)
  })

  it('max:0 disables the limiter (back-compat with existing opt-out)', () => {
    const rl = new RateLimiter(0, 60_000)
    for (let i = 0; i < 1000; i++) {
      expect(rl.check('whatever')).toBe(true)
    }
  })
})

// =========================================================================
// H21 — cookie-sid lookups go through the limiter; legitimate cookies
// never burn budget, attackers spraying random sids do.
// =========================================================================

describe('H21: cookie path is rate-limited (failed lookups only)', () => {
  let b: BootResult
  beforeEach(async () => {
    // Tight budget so the test doesn't have to spray 10 reqs.
    b = await boot({ adminLoginRateLimit: { max: 2, windowSec: 60 } })
  })
  afterEach(async () => { await teardown(b) })

  it('returns 429 after enough invalid cookie sids from the same IP', async () => {
    const get = (sid: string) =>
      fetch(`${b.baseUrl}/api/admin/metrics`, {
        headers: { cookie: `aipehub_admin=${sid}` },
      })
    // First two bogus sids: lookup fails, limiter records each failure;
    // the response is 401 ("admin auth required") because the sid
    // doesn't resolve.
    const r1 = await get('bogus-1')
    const r2 = await get('bogus-2')
    expect(r1.status).toBe(401)
    expect(r2.status).toBe(401)

    // Third attempt: peek() sees budget exhausted → 429 BEFORE the
    // lookup runs. Pre-3.4 this would have been another 401.
    const r3 = await get('bogus-3')
    expect(r3.status).toBe(429)
    expect(r3.headers.get('retry-after')).toBe('60')
  })

  it('does NOT consume budget on a successful cookie lookup', async () => {
    // Budget = 2. If the implementation called check() on every
    // cookie request, the legitimate admin would 429 on the 3rd hit.
    // peek+recordFailure means valid cookies are free.
    for (let i = 0; i < 5; i++) {
      const ok = await fetch(`${b.baseUrl}/api/admin/metrics`, {
        headers: { cookie: b.adminCookie },
      })
      expect(ok.status).toBe(200)
    }
  })

  it('Bearer and cookie namespaces are independent budgets', async () => {
    // Exhaust the cookie slot with two failures...
    const bogus = (sid: string) =>
      fetch(`${b.baseUrl}/api/admin/metrics`, {
        headers: { cookie: `aipehub_admin=${sid}` },
      })
    await bogus('aa')
    await bogus('bb')
    expect((await bogus('cc')).status).toBe(429)

    // ...but the Bearer slot is its own budget. A valid token still
    // works — proving the two key namespaces don't share state.
    const bearerRes = await fetch(`${b.baseUrl}/api/admin/metrics`, {
      headers: { authorization: `Bearer ${b.adminToken}` },
    })
    expect(bearerRes.status).toBe(200)
  })
})
