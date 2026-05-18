/**
 * `/healthz` (liveness) and `/readyz` (readiness) endpoint tests.
 *
 * `/healthz` is unconditional — must always 200 once the HTTP server
 * is listening. Used by load balancers / systemd / k8s liveness probes
 * to decide whether to restart the process.
 *
 * `/readyz` consults the optional `readinessGate` option. Without a
 * gate the endpoint aliases `/healthz` (200 always). With a gate it
 * returns 503 while the gate's `isReady()` returns false, 200 once it
 * flips true. Used by k8s-style readiness probes to keep the pod
 * `NotReady` during boot without triggering a liveness restart.
 *
 * The split matters at host startup (P6 in the v3.1 audit): the host
 * defers `workflowController.resumeRunningRuns()` to give remote
 * sidecars a grace window to reconnect. During that grace window the
 * process is alive (`/healthz` 200) but not ready (`/readyz` 503) —
 * an LB pointed at `/readyz` won't send traffic until resume completes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'

import { serveWeb, type WebServerHandle } from '../src/server.js'

interface Booted {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
}

async function boot(opts: { readinessGate?: { isReady: () => boolean } } = {}): Promise<Booted> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-health-'))
  const init = await Space.init(tmp, { name: 'health-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const serveOpts: Parameters<typeof serveWeb>[1] = { host: '127.0.0.1', port: 0 }
  if (opts.readinessGate) serveOpts.readinessGate = opts.readinessGate
  const server = await serveWeb(hub, serveOpts)
  return { tmp, hub, server, baseUrl: server.url }
}

describe('/healthz — liveness probe', () => {
  let b: Booted

  beforeEach(async () => {
    b = await boot()
  })
  afterEach(async () => {
    await b.server.close()
    await b.hub.stop()
    await rm(b.tmp, { recursive: true, force: true })
  })

  it('returns 200 plain text "ok"', async () => {
    const r = await fetch(`${b.baseUrl}/healthz`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('ok')
  })

  it('does not require auth', async () => {
    // Default cookies / no Bearer — must still pass. Liveness probes
    // typically run as unauthenticated infra.
    const r = await fetch(`${b.baseUrl}/healthz`)
    expect(r.status).toBe(200)
  })
})

describe('/readyz — readiness probe (no gate)', () => {
  let b: Booted

  beforeEach(async () => {
    // Backward-compat: when no readinessGate is passed, /readyz mirrors
    // /healthz so existing deployments don't break.
    b = await boot()
  })
  afterEach(async () => {
    await b.server.close()
    await b.hub.stop()
    await rm(b.tmp, { recursive: true, force: true })
  })

  it('returns 200 plain text "ready" (no gate → always ready)', async () => {
    const r = await fetch(`${b.baseUrl}/readyz`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('ready')
  })
})

describe('/readyz — readiness probe (with gate)', () => {
  let b: Booted
  let ready = false

  beforeEach(async () => {
    ready = false
    b = await boot({ readinessGate: { isReady: () => ready } })
  })
  afterEach(async () => {
    await b.server.close()
    await b.hub.stop()
    await rm(b.tmp, { recursive: true, force: true })
  })

  it('returns 503 with JSON { error: "starting" } before ready', async () => {
    const r = await fetch(`${b.baseUrl}/readyz`)
    expect(r.status).toBe(503)
    const body = (await r.json()) as { error?: string }
    expect(body.error).toBe('starting')
  })

  it('returns 200 once the gate flips', async () => {
    expect((await fetch(`${b.baseUrl}/readyz`)).status).toBe(503)
    ready = true
    const r = await fetch(`${b.baseUrl}/readyz`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('ready')
  })

  it('reads the gate fresh on every request (no caching)', async () => {
    // Boot bookkeeping ergonomics: an operator should be able to
    // toggle bootReady back and forth from a console hook in case
    // they want to drain traffic. Verify the gate is re-evaluated
    // per request.
    ready = true
    expect((await fetch(`${b.baseUrl}/readyz`)).status).toBe(200)
    ready = false
    expect((await fetch(`${b.baseUrl}/readyz`)).status).toBe(503)
    ready = true
    expect((await fetch(`${b.baseUrl}/readyz`)).status).toBe(200)
  })

  it('/healthz stays 200 even when /readyz is 503', async () => {
    // The whole point of splitting the two endpoints: a slow-booting
    // pod must NOT be restarted by liveness during the readiness window.
    const live = await fetch(`${b.baseUrl}/healthz`)
    const rdy = await fetch(`${b.baseUrl}/readyz`)
    expect(live.status).toBe(200)
    expect(rdy.status).toBe(503)
  })
})
