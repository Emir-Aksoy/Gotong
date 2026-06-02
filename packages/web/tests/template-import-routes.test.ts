/**
 * HTTP tests for the v5 B-M4 template import route:
 *   POST /api/admin/templates/import → { ok, template, team, workflows, knowledgeBases, … }
 *
 * The inverse of B-M2/B-M3 export. It must: require admin; land each agent
 * (skip-existing, idempotent); attempt each workflow (soft-report per id); report
 * KB slots WITHOUT auto-wiring; and, given the separately-delivered key, decrypt
 * the B-M3 sidecar and re-inject scrubbed MCP secrets — while NEVER restoring
 * personnel (hub-local principal ids don't transfer).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'

import { serveWeb, type WebServerHandle, type WorkflowSurface } from '../src/server.js'
import { encryptJson } from '../src/template-crypto.js'

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
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-tmpl-import-'))
  const init = await Space.init(tmp, { name: 'tmpl-import-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()
  const { token } = await space.createAdmin('TestAdmin')

  // Stub workflow surface: record imported yaml; a yaml mentioning 'dup-flow'
  // simulates a duplicate-id rejection (the soft-report path).
  const wfCalls: string[] = []
  const workflows = {
    importFromText: async (yaml: string) => {
      wfCalls.push(yaml)
      if (yaml.includes('dup-flow')) throw new Error("workflow 'dup-flow' already loaded")
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

async function importReq(
  body: unknown,
  auth = true,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${b.server.url}/api/admin/templates/import`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${b.token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

/** A minimal agent block for a template. */
function agentBlock(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'support-agent',
    capabilities: ['answer-ticket'],
    kind: 'llm',
    provider: 'mock',
    system: '你是客服助手。',
    ...over,
  }
}

function templateText(t: Record<string, unknown>): string {
  return JSON.stringify({ schema: 'aipehub.template/v1', template: t })
}

describe('POST /api/admin/templates/import (v5 B-M4)', () => {
  it('unauthenticated → 401', async () => {
    const r = await importReq({ template: templateText({ name: 't', agents: [agentBlock()] }) }, false)
    expect(r.status).toBe(401)
  })

  it('lands agents, attempts workflows, reports KB slots (no auto-wire)', async () => {
    const r = await importReq({
      template: templateText({
        name: '客服模板',
        version: 2,
        agents: [agentBlock()],
        workflows: [{ id: 'ticket-flow', trigger: { capability: 'answer-ticket' }, steps: [] }],
        knowledgeBases: [{ name: 'company-kb', useMcpServer: 'company-kb', description: '公司 KB' }],
      }),
    })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.template).toMatchObject({ name: '客服模板', version: 2 })
    // Agent actually landed in the Space.
    const ids = (await b.space.agents()).map((a) => a.id)
    expect(ids).toContain('support-agent')
    expect(r.json.team.created.map((a: any) => a.id)).toEqual(['support-agent'])
    // Workflow attempted via the surface.
    expect(r.json.workflows).toEqual([{ id: 'ticket-flow', ok: true }])
    expect(b.wfCalls).toHaveLength(1)
    // KB slot reported but NOT auto-wired (decision #4).
    expect(r.json.knowledgeBases).toEqual([
      { name: 'company-kb', description: '公司 KB', wiring: 'ref', useMcpServer: 'company-kb' },
    ])
  })

  it('skips an agent whose id already exists (idempotent)', async () => {
    await b.space.upsertAgent({ id: 'support-agent', allowedCapabilities: ['x'], managed: { kind: 'llm', provider: 'mock', system: 'pre-existing' } })
    const r = await importReq({ template: templateText({ name: 't', agents: [agentBlock()] }) })
    expect(r.status).toBe(200)
    expect(r.json.team.created).toHaveLength(0)
    expect(r.json.team.skipped).toEqual(['support-agent'])
    // The pre-existing agent's system prompt is untouched (not overwritten).
    const rec = (await b.space.agents()).find((a) => a.id === 'support-agent')!
    expect(rec.managed?.system).toBe('pre-existing')
  })

  it('soft-reports a duplicate workflow id; agents still land', async () => {
    const r = await importReq({
      template: templateText({
        name: 't',
        agents: [agentBlock()],
        workflows: [{ id: 'dup-flow', trigger: { capability: 'c' }, steps: [] }],
      }),
    })
    expect(r.status).toBe(200)
    expect(r.json.team.created.map((a: any) => a.id)).toEqual(['support-agent'])
    expect(r.json.workflows[0].ok).toBe(false)
    expect(r.json.workflows[0].error).toMatch(/already loaded/)
  })

  it('a structurally-bad template → 400', async () => {
    const r = await importReq({ template: templateText({ name: '', agents: [agentBlock()] }) })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/name is required/)
  })

  it('missing template body → 400', async () => {
    const r = await importReq({})
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/body.template is required/)
  })

  // ── B-M3 sidecar interop ─────────────────────────────────────────────────

  /** Build a template with a `${KB_TOKEN}`-referencing agent + an encrypted sidecar. */
  function encryptedTemplate(sidecar: unknown): { text: string; key: string } {
    const { blob, keyB64 } = encryptJson(sidecar)
    const text = JSON.stringify({
      schema: 'aipehub.template/v1',
      template: {
        name: 'with-secrets',
        version: 1,
        agents: [
          agentBlock({ mcpServers: [{ name: 'kb', command: 'npx', env: { KB_TOKEN: '${KB_TOKEN}' } }] }),
        ],
        encrypted: blob,
      },
    })
    return { text, key: keyB64 }
  }

  it('with the key, decrypts the sidecar and re-injects the real MCP secret', async () => {
    const { text, key } = encryptedTemplate({ secrets: { '${KB_TOKEN}': 'sk-REAL' } })
    const r = await importReq({ template: text, encryptionKey: key })
    expect(r.status).toBe(200)
    expect(r.json.secretsApplied).toBe(1)
    expect(r.json.encryptedSkipped).toBe(false)
    const rec = (await b.space.agents()).find((a) => a.id === 'support-agent')!
    expect(rec.managed?.mcpServers?.[0]?.env?.KB_TOKEN).toBe('sk-REAL')
  })

  it('without the key, lands the placeholder and flags encryptedSkipped', async () => {
    const { text } = encryptedTemplate({ secrets: { '${KB_TOKEN}': 'sk-REAL' } })
    const r = await importReq({ template: text }) // no encryptionKey
    expect(r.status).toBe(200)
    expect(r.json.encryptedSkipped).toBe(true)
    expect(r.json.secretsApplied).toBe(0)
    const rec = (await b.space.agents()).find((a) => a.id === 'support-agent')!
    expect(rec.managed?.mcpServers?.[0]?.env?.KB_TOKEN).toBe('${KB_TOKEN}')
  })

  it('a wrong key → 400 (fail closed, nothing landed)', async () => {
    const { text } = encryptedTemplate({ secrets: { '${KB_TOKEN}': 'sk-REAL' } })
    const wrongKey = encryptJson({}).keyB64
    const r = await importReq({ template: text, encryptionKey: wrongKey })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/could not decrypt/)
    expect((await b.space.agents()).find((a) => a.id === 'support-agent')).toBeUndefined()
  })

  it('decrypts personnel but NEVER restores it (hub-local ids)', async () => {
    const { text, key } = encryptedTemplate({
      personnel: { 'support-agent': [{ principal: 'user:alice', perm: 'owner' }] },
    })
    const r = await importReq({ template: text, encryptionKey: key })
    expect(r.status).toBe(200)
    expect(r.json.personnelOmitted).toBe(true)
    // The landed agent exists, but no foreign grant was written for it.
    expect((await b.space.agents()).map((a) => a.id)).toContain('support-agent')
  })
})
