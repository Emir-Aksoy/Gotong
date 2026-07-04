/**
 * Internal `/metrics` scrape route (Route B P0-M7 / M7-M1).
 *
 * A Prometheus scraper is a server-to-server client: no browser session, can't
 * satisfy the admin cookie or the CSRF Origin check. So `/metrics` lives in its
 * own bearer-token domain (`GOTONG_METRICS_TOKEN` → serveWeb `metricsToken`),
 * letting an operator pull the SAME body as `/api/admin/metrics` WITHOUT minting
 * a machine admin (which would widen the admin surface to a scraper credential).
 *
 * The load-bearing guards this pins:
 *   1. FAIL-CLOSED when unset — no token wired → 404 (indistinguishable from
 *      "no such route"); an unconfigured deployment exposes no anonymous
 *      metrics. Falsifiable: drop the `if (!ctx.metricsToken)` 404 and the
 *      unset-server case stops 404ing.
 *   2. BEARER REQUIRED when set — correct bearer → 200 metrics; wrong/absent
 *      bearer → 401. Falsifiable: neutralise the bearer check and a wrong
 *      token returns 200 (the body would leak to any unauthenticated caller).
 *
 * Both are exercised against a real `serveWeb` over loopback, so the route's
 * placement (before the CSRF gate, outside requireAdmin) is covered too — a
 * regression that moved it behind requireAdmin would 401/redirect even a
 * correct bearer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import { serveWeb, type WebServerHandle } from '../src/server.js'

const TOKEN = 'scrape-secret-0123456789abcdef'

interface Booted {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
}

async function boot(opts: { metricsToken?: string } = {}): Promise<Booted> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-metrics-'))
  const init = await Space.init(tmp, { name: 'metrics-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(opts.metricsToken ? { metricsToken: opts.metricsToken } : {}),
  })
  return { tmp, hub, server, baseUrl: server.url }
}

async function teardown(b: Booted): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

describe('internal /metrics scrape route (Route B P0-M7)', () => {
  describe('token wired', () => {
    let b: Booted
    beforeEach(async () => { b = await boot({ metricsToken: TOKEN }) })
    afterEach(async () => { await teardown(b) })

    it('correct bearer → 200 OpenMetrics body (same as /api/admin/metrics)', async () => {
      const r = await fetch(`${b.baseUrl}/metrics`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(r.status).toBe(200)
      // OpenMetrics content-type so Prometheus scrapes it correctly.
      expect(r.headers.get('content-type')).toContain('text/plain; version=0.0.4')
      const body = await r.text()
      // A metric that always renders — proves the real renderMetrics ran, not
      // an empty 200. (Same family the admin route serves.)
      expect(body).toContain('gotong_protocol_version')
    })

    it('wrong bearer → 401 (no metrics leak)', async () => {
      const r = await fetch(`${b.baseUrl}/metrics`, {
        headers: { authorization: 'Bearer wrong-token-totally' },
      })
      expect(r.status).toBe(401)
      expect(await r.text()).not.toContain('gotong_protocol_version')
    })

    it('absent Authorization header → 401', async () => {
      const r = await fetch(`${b.baseUrl}/metrics`)
      expect(r.status).toBe(401)
    })

    it('a wrong bearer of a DIFFERENT length is still rejected (no length oracle pass)', async () => {
      // Same-length and different-length wrong tokens both 401 — the
      // constant-time compare returns false on length mismatch up front.
      const r = await fetch(`${b.baseUrl}/metrics`, {
        headers: { authorization: 'Bearer x' },
      })
      expect(r.status).toBe(401)
    })
  })

  describe('token unset (fail-closed)', () => {
    let b: Booted
    beforeEach(async () => { b = await boot() })
    afterEach(async () => { await teardown(b) })

    it('no metricsToken wired → 404 even with a bearer (route is invisible)', async () => {
      // Fail-closed: an unconfigured deployment must not expose an anonymous
      // metrics endpoint. 404 — not 401 — so it reads as "no such route".
      const withBearer = await fetch(`${b.baseUrl}/metrics`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(withBearer.status).toBe(404)
      const without = await fetch(`${b.baseUrl}/metrics`)
      expect(without.status).toBe(404)
    })
  })
})
