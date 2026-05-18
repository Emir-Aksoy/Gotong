// C1 regression: every WS-upgrade hardening knob added in v3.4 needs
// an end-to-end test. Pre-3.4 `new WebSocketServer({ host, port })`
// accepted any Origin, any path, unlimited payloads, unlimited
// connections — see AUDIT-v3.3.md finding C1.
//
// Tests:
//   1. allowedOrigins as string[] — wrong origin gets 403; right origin
//      passes through.
//   2. allowedOrigins as predicate — predicate sees actual origin /
//      undefined; can accept native clients (no Origin) while rejecting
//      cross-site.
//   3. maxConnections — N+1th connection gets 503.
//   4. maxPayload — oversized frame triggers close code 1009 before
//      decodeFrame parses any JSON.
//   5. path — when set, mismatched path gets 404 during upgrade.
//   6. Defaults — sane out-of-the-box behaviour (no Origin check,
//      256 KiB payload, 1024 conn cap).
//
// Each test owns its own port via `port: 0` so they can run in
// parallel without interfering.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { Hub } from '@aipehub/core'

import {
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  serveWebSocket,
  type WebSocketTransportHandle,
} from '../src/index.js'

let handle: WebSocketTransportHandle | null = null
let hub: Hub

beforeEach(async () => {
  hub = Hub.inMemory()
  await hub.start()
})

afterEach(async () => {
  if (handle) await handle.close()
  handle = null
  await hub.stop()
})

/**
 * Try to open a WS connection with a custom request header (e.g. Origin)
 * and resolve to either `{ ok: true }` once `open` fires, or
 * `{ ok: false, status }` if the HTTP upgrade is rejected. Used for
 * verifyClient assertions where the server replies with 403 / 503 /
 * 404 instead of upgrading to WS.
 */
function attemptConnection(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ ok: true; ws: WebSocket } | { ok: false; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers })
    let settled = false
    ws.once('open', () => {
      if (settled) return
      settled = true
      resolve({ ok: true, ws })
    })
    ws.once('unexpected-response', (_req, res) => {
      if (settled) return
      settled = true
      const status = res.statusCode
      ws.terminate()
      resolve(status !== undefined ? { ok: false, status } : { ok: false })
    })
    ws.once('error', () => {
      if (settled) return
      settled = true
      resolve({ ok: false })
    })
  })
}

describe('WS upgrade hardening (C1)', () => {
  it('exports the documented defaults', () => {
    expect(DEFAULT_MAX_PAYLOAD_BYTES).toBe(262_144)
    expect(DEFAULT_MAX_CONNECTIONS).toBe(1024)
  })

  it('with no allowedOrigins option, any Origin is accepted (back-compat)', async () => {
    handle = await serveWebSocket(hub, { port: 0 })
    const r = await attemptConnection(handle.url, { Origin: 'http://evil.example' })
    expect(r.ok).toBe(true)
    if (r.ok) r.ws.close()
  })

  it('allowedOrigins as string[] — wrong Origin is rejected with 403, right Origin passes', async () => {
    handle = await serveWebSocket(hub, {
      port: 0,
      allowedOrigins: ['https://hub.example.com'],
    })

    const reject = await attemptConnection(handle.url, { Origin: 'http://evil.example' })
    expect(reject).toEqual({ ok: false, status: 403 })

    const accept = await attemptConnection(handle.url, {
      Origin: 'https://hub.example.com',
    })
    expect(accept.ok).toBe(true)
    if (accept.ok) accept.ws.close()

    // Native client without an Origin header — the default string[]
    // path treats absent Origin as "doesn't match anything in the
    // allow-list" and rejects. Operators who want to allow CLI/SDK
    // clients should use the predicate form (test below).
    const noOrigin = await attemptConnection(handle.url)
    expect(noOrigin).toEqual({ ok: false, status: 403 })
  })

  it('allowedOrigins as predicate — can accept undefined-Origin native clients', async () => {
    handle = await serveWebSocket(hub, {
      port: 0,
      // Native clients OK, browsers must come from hub.example.com.
      allowedOrigins: (o) => o === undefined || o === 'https://hub.example.com',
    })

    const nativeOk = await attemptConnection(handle.url)
    expect(nativeOk.ok).toBe(true)
    if (nativeOk.ok) nativeOk.ws.close()

    const browserOk = await attemptConnection(handle.url, {
      Origin: 'https://hub.example.com',
    })
    expect(browserOk.ok).toBe(true)
    if (browserOk.ok) browserOk.ws.close()

    const browserBad = await attemptConnection(handle.url, {
      Origin: 'http://evil.example',
    })
    expect(browserBad).toEqual({ ok: false, status: 403 })
  })

  it('maxConnections caps concurrent sessions; new connections get 503', async () => {
    handle = await serveWebSocket(hub, { port: 0, maxConnections: 2 })

    // Open two slots — both should succeed.
    const a = await attemptConnection(handle.url)
    const b = await attemptConnection(handle.url)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)

    // Connection 3 — over cap. The ws library upgrades after
    // verifyClient is called, and verifyClient sees `sessions.size`
    // which only increments inside `on('connection', ...)`. We need
    // to give the server a microtask to observe a + b in its set
    // before the verifyClient check runs for c.
    await new Promise((r) => setTimeout(r, 20))

    const c = await attemptConnection(handle.url)
    expect(c).toEqual({ ok: false, status: 503 })

    if (a.ok) a.ws.close()
    if (b.ok) b.ws.close()
  })

  it('maxPayload — oversized frame triggers close code 1009 before decodeFrame', async () => {
    handle = await serveWebSocket(hub, { port: 0, maxPayload: 1024 })

    const open = await attemptConnection(handle.url)
    expect(open.ok).toBe(true)
    if (!open.ok) return
    const ws = open.ws

    // Build a frame larger than 1024 bytes. Pad with whitespace so
    // it's still valid JSON if the server ever decoded it (we expect
    // it not to — the WS layer should reject first).
    const huge = JSON.stringify({ type: 'HELLO', padding: ' '.repeat(2000) })
    expect(huge.length).toBeGreaterThan(1024)

    const closeInfo = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
      ws.send(huge)
    })

    // ws library close code 1009 = "Message Too Big".
    expect(closeInfo.code).toBe(1009)
  })

  it('path option — mismatched upgrade path is rejected during HTTP upgrade', async () => {
    handle = await serveWebSocket(hub, { port: 0, path: '/ws' })

    // Default `handle.url` is `ws://host:port` (no path). The ws library
    // rejects the upgrade with HTTP 400 ("Bad Request") rather than 404
    // — its internal handling of `Sec-WebSocket-Key`-bearing requests
    // that don't match `path`. The key point for the security audit is
    // that the connection NEVER enters the WS state (no `open` event,
    // no Session created), regardless of the specific status code.
    const noPath = await attemptConnection(handle.url)
    expect(noPath.ok).toBe(false)
    if (!noPath.ok) {
      // Accept 400 / 404 / any 4xx — anchor on "rejected", not on the
      // exact code that the ws library happens to send today.
      expect(noPath.status).toBeGreaterThanOrEqual(400)
      expect(noPath.status).toBeLessThan(500)
    }

    // Correct path passes through.
    const matched = await attemptConnection(`${handle.url}/ws`)
    expect(matched.ok).toBe(true)
    if (matched.ok) matched.ws.close()
  })

  it('maxConnections = 0 disables the cap', async () => {
    handle = await serveWebSocket(hub, { port: 0, maxConnections: 0 })

    // Two connections succeed without hitting any cap.
    const a = await attemptConnection(handle.url)
    const b = await attemptConnection(handle.url)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)

    if (a.ok) a.ws.close()
    if (b.ok) b.ws.close()
  })
})
