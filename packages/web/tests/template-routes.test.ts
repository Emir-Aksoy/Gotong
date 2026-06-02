/**
 * HTTP tests for the v5 B-M2 template export route:
 *   POST /api/admin/templates/export → { ok, template }
 *
 * The route pulls agent config from the Space and workflow structure from the
 * host's authored-YAML reader, renders an aipehub.template/v1 manifest, and
 * runs it back through parseTemplate as an integrity gate. It must: require
 * admin; refuse to silently drop unexportable resources (404); never leak
 * personnel / secrets; and 400 on a structurally-bad export.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'

import { serveWeb, type WebServerHandle, type WorkflowSurface } from '../src/server.js'
import { decryptJson, type EncryptedBlob } from '../src/template-crypto.js'

const WF_YAML = `schema: aipehub.workflow/v1
workflow:
  id: ticket-flow
  trigger:
    capability: answer-ticket
  steps:
    - id: s
      dispatch:
        strategy: { kind: capability, capabilities: [answer-ticket] }
        payload: {}
`

interface AuditRow {
  action: string
  actorUserId?: string | null
  metadata?: Record<string, unknown> | null
}

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  adminToken: string
  auditRows: AuditRow[]
}

let b: Boot

beforeEach(async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-tmpl-export-'))
  const init = await Space.init(tmp, { name: 'tmpl-export-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()
  const { token: adminToken } = await space.createAdmin('TestAdmin')

  // Seed a managed agent (exportable) and an externally-connected one (not).
  await space.upsertAgent({
    id: 'support-agent',
    allowedCapabilities: ['answer-ticket'],
    managed: {
      kind: 'llm',
      provider: 'mock',
      system: '你是客服助手。',
      useMcpServers: ['company-kb'],
      mcpServers: [{ name: 'kb', command: 'npx', env: { KB_TOKEN: 'sk-LITERAL' } }],
    },
  })
  await space.upsertAgent({ id: 'remote-agent', allowedCapabilities: ['x'] }) // no managed spec

  // A stub workflow surface — only exportDefinitionText is exercised here.
  const workflows = {
    exportDefinitionText: async (id: string) => (id === 'ticket-flow' ? WF_YAML : null),
  } as unknown as WorkflowSurface

  // v5 B-M3 — stub personnel source (who-owns-what) + a capturing audit sink.
  const templatePersonnel = {
    ownersOfAgent: async (id: string) =>
      id === 'support-agent' ? [{ principal: 'user:alice', perm: 'owner' }] : [],
  }
  const auditRows: AuditRow[] = []
  const identity = {
    writeAuditLog: (input: AuditRow) => {
      auditRows.push(input)
      return {}
    },
  } as unknown as Parameters<typeof serveWeb>[1]['identity']

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    workflows,
    templatePersonnel,
    identity,
  })
  b = { tmp, hub, server, adminToken, auditRows }
})

afterEach(async () => {
  await b.server.close()
  await b.hub.stop?.()
  await rm(b.tmp, { recursive: true, force: true })
})

async function exportReq(
  body: unknown,
  auth = true,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${b.server.url}/api/admin/templates/export`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${b.adminToken}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

describe('POST /api/admin/templates/export (v5 B-M2)', () => {
  it('unauthenticated → 401', async () => {
    const r = await exportReq({ name: 't', agentIds: ['support-agent'] }, false)
    expect(r.status).toBe(401)
  })

  it('exports selected agent + workflow + KB into a parseable template', async () => {
    const r = await exportReq({
      name: '客服模板',
      description: '导出结构',
      agentIds: ['support-agent'],
      workflowIds: ['ticket-flow'],
      knowledgeBases: [{ name: 'company-kb', useMcpServer: 'company-kb' }],
    })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    const tpl = r.json.template
    expect(tpl.schema).toBe('aipehub.template/v1')
    expect(tpl.template.name).toBe('客服模板')
    expect(tpl.template.agents).toHaveLength(1)
    expect(tpl.template.agents[0].id).toBe('support-agent')
    expect(tpl.template.workflows[0].id).toBe('ticket-flow')
    expect(tpl.template.knowledgeBases[0].name).toBe('company-kb')
  })

  it('never leaks a literal MCP secret — it is placeholder-ized', async () => {
    const r = await exportReq({ name: 't', agentIds: ['support-agent'] })
    expect(r.status).toBe(200)
    const json = JSON.stringify(r.json.template)
    expect(json).not.toContain('sk-LITERAL')
    expect(json).toContain('${KB_TOKEN}')
  })

  it('missing name → 400', async () => {
    const r = await exportReq({ agentIds: ['support-agent'] })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/name is required/)
  })

  it('unknown agent id → 404 (no silent partial export)', async () => {
    const r = await exportReq({ name: 't', agentIds: ['ghost'] })
    expect(r.status).toBe(404)
    expect(r.json.error).toMatch(/agent:ghost/)
  })

  it('externally-connected agent → 404 (nothing to export)', async () => {
    const r = await exportReq({ name: 't', agentIds: ['remote-agent'] })
    expect(r.status).toBe(404)
    expect(r.json.error).toMatch(/externally-connected/)
  })

  it('unknown workflow id → 404', async () => {
    const r = await exportReq({ name: 't', workflowIds: ['nope'] })
    expect(r.status).toBe(404)
    expect(r.json.error).toMatch(/workflow:nope/)
  })

  it('a structurally-bad knowledgeBase fails the integrity gate → 400', async () => {
    const r = await exportReq({
      name: 't',
      agentIds: ['support-agent'],
      knowledgeBases: [{ name: 'no-wiring' }],
    })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/export would be invalid/)
  })

  it('an empty selection fails the gate (nothing to export) → 400', async () => {
    const r = await exportReq({ name: 't' })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/at least one of/)
  })

  it('GET on the export path → 405', async () => {
    const res = await fetch(`${b.server.url}/api/admin/templates/export`, {
      method: 'GET',
      headers: { authorization: `Bearer ${b.adminToken}` },
    })
    expect(res.status).toBe(405)
  })

  // ── B-M3: sensitive (opt-in) export ──────────────────────────────────────

  it('default export is structure-only: no encrypted sidecar, no key, no audit', async () => {
    const r = await exportReq({ name: 't', agentIds: ['support-agent'] })
    expect(r.status).toBe(200)
    expect(r.json.template.template.encrypted).toBeUndefined()
    expect(r.json.encryptionKey).toBeUndefined()
    expect(b.auditRows).toHaveLength(0)
  })

  it('includeSecrets encrypts the literal into a sidecar, key returned SEPARATELY', async () => {
    const r = await exportReq({ name: 't', agentIds: ['support-agent'], includeSecrets: true })
    expect(r.status).toBe(200)
    const tpl = r.json.template.template
    // Structure is unchanged — the secret is still a placeholder, not the literal.
    const json = JSON.stringify(tpl)
    expect(json).not.toContain('sk-LITERAL')
    expect(json).toContain('${KB_TOKEN}')
    // The sidecar is an opaque blob; the literal is NOT in it in plaintext.
    expect(tpl.encrypted).toBeTruthy()
    expect(JSON.stringify(tpl.encrypted)).not.toContain('sk-LITERAL')
    // The key comes back in the response body, never inside the template file.
    expect(typeof r.json.encryptionKey).toBe('string')
    expect(JSON.stringify(r.json.template)).not.toContain(r.json.encryptionKey)
    // With the separately-delivered key, the sidecar decrypts to the real secret.
    const sidecar = decryptJson(tpl.encrypted as EncryptedBlob, r.json.encryptionKey) as {
      secrets?: Record<string, string>
    }
    expect(sidecar.secrets?.['${KB_TOKEN}']).toBe('sk-LITERAL')
  })

  it('includePersonnel encrypts who-owns-what and writes an audit row', async () => {
    const r = await exportReq({ name: '客服', agentIds: ['support-agent'], includePersonnel: true })
    expect(r.status).toBe(200)
    const tpl = r.json.template.template
    // Personnel never appears in plaintext anywhere in the template.
    expect(JSON.stringify(tpl)).not.toContain('user:alice')
    const sidecar = decryptJson(tpl.encrypted as EncryptedBlob, r.json.encryptionKey) as {
      personnel?: Record<string, Array<{ principal: string; perm: string }>>
    }
    expect(sidecar.personnel?.['support-agent']?.[0]).toEqual({ principal: 'user:alice', perm: 'owner' })
    // The sensitive export is audited (the plain one above is not).
    expect(b.auditRows).toHaveLength(1)
    expect(b.auditRows[0]).toMatchObject({
      action: 'template_export',
      metadata: { includePersonnel: true, includeSecrets: false },
    })
  })

  it('includePersonnel fails closed (503) when no personnel source is wired', async () => {
    // A second web server on the same hub, intentionally WITHOUT templatePersonnel.
    const bare = await serveWeb(b.hub, {
      host: '127.0.0.1',
      port: 0,
      workflows: { exportDefinitionText: async () => null } as unknown as WorkflowSurface,
    })
    try {
      const res = await fetch(`${bare.url}/api/admin/templates/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${b.adminToken}` },
        body: JSON.stringify({ name: 't', agentIds: ['support-agent'], includePersonnel: true }),
      })
      expect(res.status).toBe(503)
    } finally {
      await bare.close()
    }
  })
})
