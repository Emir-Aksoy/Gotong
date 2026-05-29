/**
 * PWA asset tests (Phase 12 M9).
 *
 * Covers the installability surface added in M9:
 *   1. /manifest.webmanifest — served as application/manifest+json, valid
 *      JSON, carries the fields a browser needs to offer "install"
 *      (name / start_url / display / at least one icon).
 *   2. /sw.js — served as JavaScript and, crucially, still carries the
 *      `/api/` bypass guard. That guard is the security-relevant invariant:
 *      the service worker must never intercept authenticated endpoints or
 *      the SSE stream. A regression that drops it would let the SW cache
 *      token-gated data, so we assert the source marker explicitly.
 *   3. /icon.svg — served as image/svg+xml (the manifest references it as
 *      an icon; a wrong MIME makes the install icon silently fail).
 *   4. /offline.html — served as HTML (the SW navigation fallback target).
 *   5. app.html head wiring — the served SPA shell links the manifest and
 *      sets theme-color, so the browser actually discovers the PWA.
 *
 * Assets are public static files (no auth) — only the app.html assertion
 * needs a cookie, minted as a v3 admin session like the C1 shell test.
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
  adminCookie: string
}

async function boot(): Promise<Booted> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-pwa-'))
  const init = await Space.init(tmp, { name: 'pwa-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()

  const { admin } = await space.createAdmin('PwaAdmin')
  const sid = 'pwa-sid-' + Math.random().toString(36).slice(2)
  await space.addAdminSession(sid, admin.id)
  const adminCookie = `aipehub_admin=${sid}`

  const server = await serveWeb(hub, { host: '127.0.0.1', port: 0 })
  return { tmp, hub, server, baseUrl: server.url, adminCookie }
}

describe('PWA assets (Phase 12 M9)', () => {
  let b: Booted
  beforeEach(async () => { b = await boot() })
  afterEach(async () => {
    await b.server.close()
    await b.hub.stop()
    await rm(b.tmp, { recursive: true, force: true })
  })

  it('GET /manifest.webmanifest → application/manifest+json with install fields', async () => {
    const r = await fetch(`${b.baseUrl}/manifest.webmanifest`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('application/manifest+json')
    const m = (await r.json()) as {
      name?: string
      start_url?: string
      display?: string
      icons?: Array<{ src: string; type?: string }>
    }
    expect(m.name).toBe('AipeHub')
    expect(m.start_url).toBe('/')
    expect(m.display).toBe('standalone')
    expect(Array.isArray(m.icons)).toBe(true)
    expect(m.icons!.length).toBeGreaterThan(0)
    expect(m.icons![0]!.src).toBe('/icon.svg')
  })

  it('GET /sw.js → JavaScript that keeps the /api bypass guard', async () => {
    const r = await fetch(`${b.baseUrl}/sw.js`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('javascript')
    const src = await r.text()
    // Security-relevant invariant: the SW must never intercept /api/*
    // (authenticated endpoints + the /api/stream SSE feed).
    expect(src).toContain("url.pathname.startsWith('/api/')")
    // And it must actually be a service worker (has a fetch handler).
    expect(src).toContain("addEventListener('fetch'")
  })

  it('GET /icon.svg → image/svg+xml', async () => {
    const r = await fetch(`${b.baseUrl}/icon.svg`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('image/svg+xml')
    expect(await r.text()).toContain('<svg')
  })

  it('GET /offline.html → HTML (SW navigation fallback)', async () => {
    const r = await fetch(`${b.baseUrl}/offline.html`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
  })

  it('served app.html links the manifest + sets theme-color', async () => {
    const r = await fetch(`${b.baseUrl}/`, { headers: { cookie: b.adminCookie } })
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toContain('rel="manifest"')
    expect(html).toContain('/manifest.webmanifest')
    expect(html).toContain('name="theme-color"')
  })
})
