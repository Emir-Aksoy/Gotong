/**
 * `/api/admin/services/...` HTTP integration (PR-11).
 *
 * Boots a real Hub + Space + HubServices + serveWeb and drives the
 * admin endpoints through fetch. The HubServices wired to web is
 * the `asAdminSurface()` adapter — same code path the production
 * host uses.
 *
 * What's covered:
 *
 *   - 503 when services not enabled.
 *   - 401/403 when not authed.
 *   - GET /plugins lists the registered memory-file plugin.
 *   - GET /owners/:t/:i/:k/:id returns null snapshot for an unwritten
 *     owner and a real snapshot once the owner has data.
 *   - DELETE /owners/... soft-deletes + returns the ref.
 *   - GET /trash unions plugin trash.
 *   - POST /trash/.../restore restores; second restore returns 409.
 *   - DELETE /trash/... hard-deletes; subsequent restore is 404.
 *   - POST /sweep triggers a manual sweep.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLogger, Hub, Space } from '@aipehub/core'
import { serveWeb, type WebServerHandle } from '@aipehub/web'
import { bootstrapServices, type HubServices } from '../src/services/index.js'

const logger = createLogger('services-admin-test', { disabled: true })

interface TestRig {
  root: string
  space: Space
  hub: Hub
  services: HubServices
  web: WebServerHandle
  adminToken: string
  url(path: string): string
  authedFetch(path: string, init?: RequestInit): Promise<Response>
}

async function bootRig(opts: { withServices: boolean } = { withServices: true }): Promise<TestRig> {
  const root = await mkdtemp(join(tmpdir(), 'aipe-host-admin-'))
  await rm(root, { recursive: true, force: true })
  const { space, adminToken } = await Space.init(root, {
    name: 'test',
    adminDisplayName: 'Operator',
  })
  if (!adminToken) throw new Error('expected admin token from init')
  const hub = new Hub({ space })
  await hub.start()

  let services: HubServices | undefined
  if (opts.withServices) {
    await writeFile(
      join(space.paths.services, 'plugins.json'),
      JSON.stringify({ plugins: ['@aipehub/service-memory-file'] }, null, 2) + '\n',
      'utf8',
    )
    const boot = await bootstrapServices({ space, hub, logger })
    services = boot.services
  }

  const web = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(services ? { services: services.asAdminSurface() } : {}),
  })

  const url = (p: string): string => `${web.url}${p}`
  const authedFetch = (p: string, init: RequestInit = {}): Promise<Response> =>
    fetch(url(p), {
      ...init,
      headers: {
        authorization: `Bearer ${adminToken}`,
        ...(init.headers ?? {}),
      },
    })

  return {
    root, space, hub, services: services!, web, adminToken, url, authedFetch,
  }
}

async function tearDown(rig: Partial<TestRig>): Promise<void> {
  if (rig.web) await rig.web.close()
  if (rig.services) await rig.services.shutdownAll()
  if (rig.hub) await rig.hub.stop()
  if (rig.root) await rm(rig.root, { recursive: true, force: true })
}

describe('services admin REST — auth + 503', () => {
  let rig: TestRig
  beforeEach(async () => {
    rig = await bootRig({ withServices: false })
  })
  afterEach(async () => { await tearDown(rig) })

  it('returns 503 when services are not wired', async () => {
    const r = await rig.authedFetch('/api/admin/services/plugins')
    expect(r.status).toBe(503)
  })
})

describe('services admin REST — happy paths', () => {
  let rig: TestRig
  beforeEach(async () => {
    rig = await bootRig({ withServices: true })
  })
  afterEach(async () => { await tearDown(rig) })

  it('rejects unauthenticated callers', async () => {
    // Bare fetch — no admin cookie
    const r = await fetch(rig.url('/api/admin/services/plugins'))
    expect([401, 403]).toContain(r.status)
  })

  it('GET /plugins lists the memory:file plugin', async () => {
    const r = await rig.authedFetch('/api/admin/services/plugins')
    expect(r.status).toBe(200)
    const j = (await r.json()) as { plugins: Array<{ type: string; impl: string }> }
    expect(j.plugins.some((p) => p.type === 'memory' && p.impl === 'file')).toBe(true)
  })

  it('GET owner returns null when there is no data', async () => {
    const r = await rig.authedFetch(
      '/api/admin/services/owners/memory/file/agent/never-existed',
    )
    expect(r.status).toBe(200)
    const j = (await r.json()) as { snapshot: unknown | null }
    expect(j.snapshot).toBeNull()
  })

  it('GET owner returns a snapshot once data is written', async () => {
    // Attach a handle directly through the services facade so we can write.
    const attached = await rig.services.attach({
      type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'a1' },
      config: {},
    })
    await (attached.handle as { remember: (e: { kind: 'episodic'; text: string }) => Promise<unknown> })
      .remember({ kind: 'episodic', text: 'hi' })
    const r = await rig.authedFetch(
      '/api/admin/services/owners/memory/file/agent/a1',
    )
    expect(r.status).toBe(200)
    const j = (await r.json()) as { snapshot: { sizeBytes: number } | null }
    expect(j.snapshot).not.toBeNull()
    expect(j.snapshot!.sizeBytes).toBeGreaterThan(0)
  })

  it('DELETE owner soft-deletes and returns the ref', async () => {
    const attached = await rig.services.attach({
      type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'b1' },
      config: {},
    })
    await (attached.handle as { remember: (e: { kind: 'episodic'; text: string }) => Promise<unknown> })
      .remember({ kind: 'episodic', text: 'bye' })
    const r = await rig.authedFetch(
      '/api/admin/services/owners/memory/file/agent/b1',
      { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'admin removed' }) },
    )
    expect(r.status).toBe(200)
    const j = (await r.json()) as { ok: boolean; ref: { id: string; reason?: string } }
    expect(j.ok).toBe(true)
    expect(j.ref.id).toMatch(/^[0-9a-f]{16}$/)
    expect(j.ref.reason).toBe('admin removed')
  })

  it('GET /trash unions plugin trash', async () => {
    const attached = await rig.services.attach({
      type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'c1' },
      config: {},
    })
    await (attached.handle as { remember: (e: { kind: 'episodic'; text: string }) => Promise<unknown> })
      .remember({ kind: 'episodic', text: 'x' })
    await rig.authedFetch(
      '/api/admin/services/owners/memory/file/agent/c1',
      { method: 'DELETE' },
    )
    const r = await rig.authedFetch('/api/admin/services/trash')
    expect(r.status).toBe(200)
    const j = (await r.json()) as { trash: Array<{ ownerId: string }> }
    expect(j.trash.some((t) => t.ownerId === 'c1')).toBe(true)
  })

  it('POST /trash/.../restore restores then a second restore returns 409', async () => {
    const attached = await rig.services.attach({
      type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'd1' },
      config: {},
    })
    await (attached.handle as { remember: (e: { kind: 'episodic'; text: string }) => Promise<unknown> })
      .remember({ kind: 'episodic', text: 'x' })
    const del = await rig.authedFetch(
      '/api/admin/services/owners/memory/file/agent/d1',
      { method: 'DELETE' },
    )
    const ref = (await del.json() as { ref: { id: string } }).ref

    const ok = await rig.authedFetch(
      `/api/admin/services/trash/memory/file/${ref.id}/restore`,
      { method: 'POST' },
    )
    expect(ok.status).toBe(200)

    // Re-attach + write so the owner slot is taken again
    const attached2 = await rig.services.attach({
      type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'd1' },
      config: {},
    })
    await (attached2.handle as { remember: (e: { kind: 'episodic'; text: string }) => Promise<unknown> })
      .remember({ kind: 'episodic', text: 'x2' })
    // softDelete again to put a new ref into trash
    const del2 = await rig.authedFetch(
      '/api/admin/services/owners/memory/file/agent/d1',
      { method: 'DELETE' },
    )
    const ref2 = (await del2.json() as { ref: { id: string } }).ref

    // Re-attach + write so the slot is occupied
    const attached3 = await rig.services.attach({
      type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'd1' },
      config: {},
    })
    await (attached3.handle as { remember: (e: { kind: 'episodic'; text: string }) => Promise<unknown> })
      .remember({ kind: 'episodic', text: 'occupier' })

    const conflict = await rig.authedFetch(
      `/api/admin/services/trash/memory/file/${ref2.id}/restore`,
      { method: 'POST' },
    )
    expect(conflict.status).toBe(409)
  })

  it('DELETE /trash/... hard-deletes; restore afterward is 404', async () => {
    const attached = await rig.services.attach({
      type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'e1' },
      config: {},
    })
    await (attached.handle as { remember: (e: { kind: 'episodic'; text: string }) => Promise<unknown> })
      .remember({ kind: 'episodic', text: 'x' })
    const del = await rig.authedFetch(
      '/api/admin/services/owners/memory/file/agent/e1',
      { method: 'DELETE' },
    )
    const ref = (await del.json() as { ref: { id: string } }).ref
    const hd = await rig.authedFetch(
      `/api/admin/services/trash/memory/file/${ref.id}`,
      { method: 'DELETE' },
    )
    expect(hd.status).toBe(200)
    const restoreAfter = await rig.authedFetch(
      `/api/admin/services/trash/memory/file/${ref.id}/restore`,
      { method: 'POST' },
    )
    expect(restoreAfter.status).toBe(404)
  })

  it('POST /sweep returns { scanned, purged }', async () => {
    const r = await rig.authedFetch('/api/admin/services/sweep', { method: 'POST' })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { ok: boolean; scanned: number; purged: number }
    expect(j.ok).toBe(true)
    expect(typeof j.scanned).toBe('number')
    expect(typeof j.purged).toBe('number')
  })

  it('GET unknown plugin returns 404', async () => {
    const r = await rig.authedFetch(
      '/api/admin/services/owners/datastore/sqlite/agent/x',
    )
    expect(r.status).toBe(404)
  })
})
