/**
 * Route tests for the Track G template gallery catalog (G-M2).
 *
 *   GET /api/admin/templates/catalog      → install previews of every shipped
 *                                            template (derived via parseTemplate,
 *                                            NO raw yaml — keeps the list lean)
 *   GET /api/admin/templates/catalog/:id  → that template's raw yaml (the
 *                                            frontend POSTs it to .../import)
 *
 * Both are admin-gated. The list metadata is projected server-side through the
 * SAME parseTemplate the install route runs, so the preview can't drift from
 * what actually lands.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import { parseTemplate } from '../src/template-manifest.js'
import { BUILTIN_TEMPLATES } from '../src/builtin-templates.js'

interface CatalogEntry {
  id: string
  sourceExample: string
  name: string
  description?: string
  version: number
  agents: { id: string; displayName?: string; capabilities: string[] }[]
  workflows: { id: string }[]
  knowledgeBases: { name: string; description?: string }[]
  apiKeyPrompt?: { provider: string; baseURL?: string; label?: string }
}

let tmp: string
let hub: Hub
let server: WebServerHandle
let token: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'aipehub-catalog-'))
  const { space } = await Space.init(tmp, { name: 'catalog-test' })
  hub = new Hub({ space })
  await hub.start()
  token = (await space.createAdmin('TestAdmin')).token
  server = await serveWeb(hub, { host: '127.0.0.1', port: 0 })
})

afterEach(async () => {
  await server?.close()
  await hub?.stop?.()
  await rm(tmp, { recursive: true, force: true })
})

const authed = (path: string) =>
  fetch(`${server.url}${path}`, { headers: { authorization: `Bearer ${token}` } })

describe('template gallery catalog routes (G-M2)', () => {
  it('GET /catalog lists every embedded template, previews only (no yaml)', async () => {
    const res = await authed('/api/admin/templates/catalog')
    expect(res.status).toBe(200)
    const { templates } = (await res.json()) as { templates: CatalogEntry[] }

    // One entry per embedded template, same ids/order.
    expect(templates.map((t) => t.id)).toEqual(BUILTIN_TEMPLATES.map((t) => t.id))

    for (const t of templates) {
      expect(t.name.length).toBeGreaterThan(0)
      expect(typeof t.version).toBe('number')
      expect(t.sourceExample).toMatch(/^examples\//)
      expect(Array.isArray(t.agents)).toBe(true)
      expect(Array.isArray(t.workflows)).toBe(true)
      expect(Array.isArray(t.knowledgeBases)).toBe(true)
      // The list is the lean preview — raw yaml must NOT ride along.
      expect((t as Record<string, unknown>).yaml).toBeUndefined()
    }
  })

  it('projects install metadata server-side (cafe-ops: 2 agents, 3 workflows, 1 KB)', async () => {
    const { templates } = (await (await authed('/api/admin/templates/catalog')).json()) as {
      templates: CatalogEntry[]
    }
    const cafe = templates.find((t) => t.id === 'cafe-ops')!
    expect(cafe.agents.map((a) => a.id)).toEqual(['onboarding-trainer', 'ops-assistant'])
    expect(cafe.workflows.map((w) => w.id)).toEqual([
      'cafe-staff-onboarding',
      'cafe-shift-availability',
      'cafe-overtime-claim',
    ])
    expect(cafe.knowledgeBases.map((k) => k.name)).toEqual(['store_ops_manual'])
    expect(cafe.apiKeyPrompt).toMatchObject({ provider: 'openai-compatible', label: 'DeepSeek' })

    // child-desk ships ZERO agents (零订阅) but still teaches the hub workflows.
    const child = templates.find((t) => t.id === 'child-desk')!
    expect(child.agents).toEqual([])
    expect(child.workflows.length).toBeGreaterThan(0)
  })

  it('GET /catalog/:id returns the raw, installable yaml', async () => {
    const res = await authed('/api/admin/templates/catalog/cafe-ops')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; yaml: string }
    expect(body.id).toBe('cafe-ops')
    // The yaml is the real manifest — it parses through the install parser.
    const parsed = parseTemplate(body.yaml)
    expect(parsed.schema).toBe('aipehub.template/v1')
    expect(parsed.name).toBe('门店运营(奶茶 / 咖啡店)')
  })

  it('404s for an unknown template id', async () => {
    const res = await authed('/api/admin/templates/catalog/no-such-template')
    expect(res.status).toBe(404)
  })

  it('requires admin auth (401 without a token)', async () => {
    const list = await fetch(`${server.url}/api/admin/templates/catalog`)
    expect(list.status).toBe(401)
    const item = await fetch(`${server.url}/api/admin/templates/catalog/cafe-ops`)
    expect(item.status).toBe(401)
  })
})
