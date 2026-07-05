/**
 * FDE-M2 — HTTP tests for the golden-run acceptance routes:
 *   GET  /api/admin/templates/acceptance            → { packs }
 *   POST /api/admin/templates/acceptance/:pack/run  → { ok, report }
 *
 * The runner itself is unit-tested host-side; here we pin the web seam only:
 * admin auth, the 503-when-unwired contract (surface absent → panel hides),
 * verbatim pass-through of the injected surface's data, the run executing AS
 * THE SESSION ADMIN (no userId in the body — identity never comes from a
 * payload), and the duck-typed 404 mapping for unknown pack/case.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import type { TemplateAcceptanceSurface } from '../src/template-acceptance-routes.js'

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  token: string
  adminId: string
}

let b: Boot

async function boot(surface?: TemplateAcceptanceSurface): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-accept-routes-'))
  const init = await Space.init(tmp, { name: 'accept-routes-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const admin = await init.space.createAdmin('TestAdmin')
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(surface ? { templateAcceptance: surface } : {}),
  })
  b = { tmp, hub, server, token: admin.token, adminId: admin.admin.id }
}

afterEach(async () => {
  await b.server.close()
  await b.hub.stop?.()
  await rm(b.tmp, { recursive: true, force: true })
})

async function req(
  path: string,
  init?: { method?: string; body?: unknown; auth?: boolean },
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${b.server.url}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(init?.auth === false ? {} : { authorization: `Bearer ${b.token}` }),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

describe('template acceptance routes (FDE-M2)', () => {
  it('503s when the host wired no surface (panel hides)', async () => {
    await boot()
    const r = await req('/api/admin/templates/acceptance')
    expect(r.status).toBe(503)
  })

  it('requires admin auth', async () => {
    await boot()
    const r = await req('/api/admin/templates/acceptance', { auth: false })
    expect(r.status).toBe(401)
  })

  it('lists recorded packs verbatim from the surface', async () => {
    const packs = [
      {
        pack: 'morning-brief-hub',
        installedAt: '2026-07-04T00:00:00.000Z',
        cases: [
          {
            id: 'smoke-brief',
            workflowId: 'morning-brief',
            trigger: { focus: 'x' },
            assert: { contains: ['今日重点'] },
          },
        ],
      },
    ]
    await boot({
      record: async () => {},
      list: async () => packs,
      run: async () => ({ pack: '', ranBy: '', allGreen: true, results: [] }),
    })
    const r = await req('/api/admin/templates/acceptance')
    expect(r.status).toBe(200)
    expect(r.json.packs).toEqual(packs)
  })

  it('runs a pack as the SESSION admin (identity never from the body)', async () => {
    const seen: { pack: string; userId: string; caseId?: string }[] = []
    await boot({
      record: async () => {},
      list: async () => [],
      run: async (pack, opts) => {
        seen.push({ pack, ...opts })
        return {
          pack,
          ranBy: opts.userId,
          allGreen: false,
          results: [{ caseId: 'smoke', verdict: 'red', reason: 'unrunnable' }],
        }
      },
    })
    const r = await req('/api/admin/templates/acceptance/morning-brief-hub/run', {
      method: 'POST',
      // A hostile body trying to smuggle an identity — must be ignored.
      body: { caseId: 'smoke', userId: 'victim' },
    })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.report.results).toHaveLength(1)
    expect(seen).toEqual([{ pack: 'morning-brief-hub', userId: b.adminId, caseId: 'smoke' }])
  })

  it('maps the duck-typed not-found error to 404 and other faults to 500', async () => {
    await boot({
      record: async () => {},
      list: async () => [],
      run: async (pack) => {
        if (pack === 'missing') {
          throw Object.assign(new Error("no acceptance cases recorded for pack 'missing'"), {
            code: 'acceptance_not_found',
          })
        }
        throw new Error('registry exploded')
      },
    })
    const missing = await req('/api/admin/templates/acceptance/missing/run', { method: 'POST' })
    expect(missing.status).toBe(404)
    const boom = await req('/api/admin/templates/acceptance/boom/run', { method: 'POST' })
    expect(boom.status).toBe(500)
  })

  it('rejects a non-string caseId with 400 before touching the surface', async () => {
    let called = 0
    await boot({
      record: async () => {},
      list: async () => [],
      run: async () => {
        called++
        return { pack: '', ranBy: '', allGreen: true, results: [] }
      },
    })
    const r = await req('/api/admin/templates/acceptance/p/run', {
      method: 'POST',
      body: { caseId: 42 },
    })
    expect(r.status).toBe(400)
    expect(called).toBe(0)
  })
})
