/**
 * One-click install round-trip for the Track G template gallery (G-M3).
 *
 * This is the server-side proof of exactly what the frontend "Install" button
 * does — no UI, just the two HTTP calls in sequence:
 *
 *   1. GET  /api/admin/templates/catalog/:id   → the catalog entry's raw yaml
 *   2. POST /api/admin/templates/import         → land its agents + workflows
 *
 * The bytes move untouched: the yaml the catalog hands out is the yaml the
 * import route parses. If a shipped template ever stops installing cleanly,
 * this test goes red. cafe-ops is the fixture (2 agents, 3 workflows, 1 KB).
 *
 * The host here has NO agent lifecycle wired, so the import route skips the
 * spawn step — cafe-ops' real-DeepSeek agents land as records without needing
 * a key, which is precisely the install-then-configure-key flow the gallery
 * hint describes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import { serveWeb, type WebServerHandle, type WorkflowSurface } from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  space: Space
  server: WebServerHandle
  token: string
  wfCalls: string[]
}

let b: Boot

beforeEach(async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-gallery-install-'))
  const init = await Space.init(tmp, { name: 'gallery-install-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()
  const { token } = await space.createAdmin('TestAdmin')

  // Record every workflow yaml the import route forwards. cafe-ops carries 3.
  const wfCalls: string[] = []
  const workflows = {
    importFromText: async (yaml: string) => {
      wfCalls.push(yaml)
      return { id: 'x' }
    },
  } as unknown as WorkflowSurface

  const server = await serveWeb(hub, { host: '127.0.0.1', port: 0, workflows })
  b = { tmp, hub, space, server, token, wfCalls }
})

afterEach(async () => {
  await b.server.close()
  await b.hub.stop?.()
  await rm(b.tmp, { recursive: true, force: true })
})

const authed = (path: string, init?: RequestInit) =>
  fetch(`${b.server.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${b.token}`, ...(init?.headers ?? {}) },
  })

/** The exact two-step the gallery "Install" button runs. */
async function installFromCatalog(id: string): Promise<{ status: number; json: any }> {
  const cat = await authed(`/api/admin/templates/catalog/${encodeURIComponent(id)}`)
  expect(cat.status).toBe(200)
  const { yaml } = (await cat.json()) as { yaml: string }
  const res = await authed('/api/admin/templates/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ template: yaml }),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

describe('template gallery one-click install round-trip (G-M3)', () => {
  it('installs cafe-ops: lands 2 agents, forwards 3 workflows, reports 1 KB slot', async () => {
    const r = await installFromCatalog('cafe-ops')
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.template).toMatchObject({ name: '门店运营(奶茶 / 咖啡店)' })

    // Both agents actually landed in the Space (not just echoed in the response).
    expect(r.json.team.created.map((a: any) => a.id).sort()).toEqual([
      'onboarding-trainer',
      'ops-assistant',
    ])
    const ids = (await b.space.agents()).map((a) => a.id)
    expect(ids).toContain('onboarding-trainer')
    expect(ids).toContain('ops-assistant')

    // All three declared workflows were forwarded to the surface.
    expect(b.wfCalls).toHaveLength(3)
    expect(r.json.workflows.map((w: any) => w.ok)).toEqual([true, true, true])

    // KB slot reported, never auto-wired (decision #4).
    expect(r.json.knowledgeBases.map((k: any) => k.name)).toEqual(['store_ops_manual'])
  })

  it('a second install is idempotent — both agents skipped, not duplicated', async () => {
    await installFromCatalog('cafe-ops')
    const again = await installFromCatalog('cafe-ops')
    expect(again.status).toBe(200)
    expect(again.json.team.created).toHaveLength(0)
    expect(again.json.team.skipped.sort()).toEqual(['onboarding-trainer', 'ops-assistant'])
    // Still exactly two agents in the Space — no clones.
    const ids = (await b.space.agents()).map((a) => a.id)
    expect(ids.filter((x) => x === 'onboarding-trainer' || x === 'ops-assistant')).toHaveLength(2)
  })

  it('installs child-desk: zero agents, but its workflows still land', async () => {
    const r = await installFromCatalog('child-desk')
    expect(r.status).toBe(200)
    expect(r.json.team.created).toEqual([])
    // child-desk ships 零订阅 (no agents) yet teaches the hub workflows.
    expect(b.wfCalls.length).toBeGreaterThan(0)
    expect(r.json.workflows.every((w: any) => w.ok)).toBe(true)
  })
})
