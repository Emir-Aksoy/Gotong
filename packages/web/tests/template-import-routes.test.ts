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

import { Hub, Space } from '@gotong/core'

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
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-tmpl-import-'))
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
  return JSON.stringify({ schema: 'gotong.template/v1', template: t })
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
      schema: 'gotong.template/v1',
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

// ── ease-of-use ③-M1: post-install "last mile" checklist ───────────────────
// The import response carries a checklist of what is still left to do after a
// one-click template install: KB slots that need wiring (we never auto-wire —
// decision #4) and freshly-created LLM agents whose provider key does not
// resolve yet. The latter is derived from a host-supplied key probe (best
// effort / advisory).
describe('POST /api/admin/templates/import — postInstallChecklist (ease-of-use ③-M1)', () => {
  it('reports KB slots to wire + agents whose provider key does not resolve', async () => {
    // Re-boot the web server with a fake LLM-key probe: it resolves keys for
    // 'has-key-agent' but not 'no-key-agent' — mirroring the host org-pool probe.
    await b.server.close()
    const probed: { id: string; provider: string }[] = []
    const llmKeyProbe = {
      resolvesKey: async (agentId: string, provider: string) => {
        probed.push({ id: agentId, provider })
        return agentId === 'has-key-agent'
      },
    }
    const workflows = {
      importFromText: async () => ({ id: 'x' }),
    } as unknown as WorkflowSurface
    b.server = await serveWeb(b.hub, { host: '127.0.0.1', port: 0, workflows, llmKeyProbe })

    const r = await importReq({
      template: templateText({
        name: 'checklist-template',
        version: 1,
        agents: [
          agentBlock({ id: 'has-key-agent', capabilities: ['cap-a'], provider: 'anthropic' }),
          agentBlock({ id: 'no-key-agent', capabilities: ['cap-b'], provider: 'anthropic' }),
          // A mock-provider agent is always "resolvable" → must NOT appear.
          agentBlock({ id: 'mock-agent', capabilities: ['cap-c'], provider: 'mock' }),
        ],
        knowledgeBases: [{ name: 'kb-slot', useMcpServer: 'kb-mcp', description: '待接线' }],
      }),
    })
    expect(r.status).toBe(200)
    expect(r.json.postInstallChecklist).toBeDefined()
    // KB ref slot needs wiring (no inline mcpServer).
    expect(r.json.postInstallChecklist.kbSlotsToWire).toEqual([
      { name: 'kb-slot', useMcpServer: 'kb-mcp' },
    ])
    // Only the no-key anthropic agent is flagged; mock is skipped, has-key resolves.
    expect(r.json.postInstallChecklist.agentsMissingKey).toEqual([
      { id: 'no-key-agent', provider: 'anthropic' },
    ])
    // The probe was consulted for both non-mock agents (mock short-circuits before).
    expect(probed.map((p) => p.id).sort()).toEqual(['has-key-agent', 'no-key-agent'])
  })

  it('omits agentsMissingKey when no key probe is wired (zero regression)', async () => {
    // The default beforeEach server has no llmKeyProbe.
    const r = await importReq({
      template: templateText({
        name: 'no-probe',
        agents: [agentBlock({ id: 'a1', capabilities: ['cap-a'], provider: 'anthropic' })],
        knowledgeBases: [{ name: 'kb-slot', useMcpServer: 'kb-mcp' }],
      }),
    })
    expect(r.status).toBe(200)
    // KB half is always derivable; missing-key half is empty without a probe.
    expect(r.json.postInstallChecklist.kbSlotsToWire).toEqual([
      { name: 'kb-slot', useMcpServer: 'kb-mcp' },
    ])
    expect(r.json.postInstallChecklist.agentsMissingKey).toEqual([])
  })

  it('reports declared connector slots as connectorsToWire (FDE-M1)', async () => {
    const r = await importReq({
      template: templateText({
        name: 'with-slots',
        agents: [agentBlock({ id: 'a1', capabilities: ['cap-a'] })],
        requires: {
          connectors: [
            { id: 'calendar', kind: 'mcp', optional: true, hint: '挂个日历', capability: 'calendar.read' },
            { id: 'crm', kind: 'mcp' },
          ],
        },
      }),
    })
    expect(r.status).toBe(200)
    // Reported, never auto-wired — same posture as kbSlotsToWire.
    expect(r.json.postInstallChecklist.connectorsToWire).toEqual([
      { id: 'calendar', optional: true, hint: '挂个日历', capability: 'calendar.read' },
      { id: 'crm', optional: false },
    ])
  })

  it('connectorsToWire is [] for a template without requires (zero regression)', async () => {
    const r = await importReq({
      template: templateText({ name: 'no-slots', agents: [agentBlock()] }),
    })
    expect(r.status).toBe(200)
    expect(r.json.postInstallChecklist.connectorsToWire).toEqual([])
  })
})

// ── RES-M2: adaptation proposals attached to the checklist ──────────────────
// The real engine lives host-side (host/src/resource-adaptation.ts, unit-tested
// in host/tests/resource-adaptation.test.ts). Here we pin only the web seam: the
// import route consults the injected `resourceAdaptation` surface for the
// freshly-created agents + KB slots and echoes its proposals verbatim under
// `postInstallChecklist.adaptations`; absent surface → no `adaptations` field.
describe('POST /api/admin/templates/import — RES-M2 adaptations', () => {
  it('attaches the surface proposals for the created agents + KB slots', async () => {
    await b.server.close()
    const seen: { agents: { id: string; provider: string }[]; kbSlots?: { name: string; useMcpServer?: string }[] }[] = []
    const resourceAdaptation = {
      propose: async (input: { agents: { id: string; provider: string }[]; kbSlots?: { name: string; useMcpServer?: string }[] }) => {
        seen.push(input)
        // A canned proposal per keyless agent, echoed verbatim by the route.
        return input.agents.map((a) => ({
          kind: 'use_local_endpoint' as const,
          id: `adapt:use_local_endpoint:${a.id}:Ollama`,
          title: `让「${a.id}」改用本地 Ollama`,
          detail: '……',
          applicable: true,
          agentId: a.id,
          fromProvider: a.provider,
          endpointLabel: 'Ollama',
          suggestedBaseURL: 'http://127.0.0.1:11434/v1',
        }))
      },
    }
    const workflows = { importFromText: async () => ({ id: 'x' }) } as unknown as WorkflowSurface
    b.server = await serveWeb(b.hub, { host: '127.0.0.1', port: 0, workflows, resourceAdaptation })

    const r = await importReq({
      template: templateText({
        name: 'res-template',
        // `anthropic` is a valid managed-agent provider (deepseek isn't a literal
        // — it'd be openai-compatible + baseURL). The stub echoes proposals per
        // agent regardless; provider validity is the manifest layer's concern.
        agents: [
          agentBlock({ id: 'mentor', capabilities: ['cap-a'], provider: 'anthropic' }),
          agentBlock({ id: 'mock-agent', capabilities: ['cap-b'], provider: 'mock' }),
        ],
        knowledgeBases: [{ name: 'kb-slot', useMcpServer: 'kb-mcp', description: '待接线' }],
      }),
    })
    expect(r.status).toBe(200)
    // The surface saw the freshly-created agents + KB slots to wire.
    expect(seen).toHaveLength(1)
    expect(seen[0].agents.map((a) => a.id).sort()).toEqual(['mentor', 'mock-agent'])
    expect(seen[0].kbSlots).toEqual([{ name: 'kb-slot', useMcpServer: 'kb-mcp' }])
    // The proposals round-trip verbatim under the checklist.
    const adaptations = r.json.postInstallChecklist.adaptations
    expect(Array.isArray(adaptations)).toBe(true)
    expect(adaptations).toHaveLength(2)
    expect(adaptations.find((p: any) => p.agentId === 'mentor')).toMatchObject({
      kind: 'use_local_endpoint',
      applicable: true,
      suggestedBaseURL: 'http://127.0.0.1:11434/v1',
    })
  })

  it('a proposal fault never fails the import (best-effort → empty adaptations)', async () => {
    await b.server.close()
    const resourceAdaptation = {
      propose: async () => {
        throw new Error('inventory probe blew up')
      },
    }
    const workflows = { importFromText: async () => ({ id: 'x' }) } as unknown as WorkflowSurface
    b.server = await serveWeb(b.hub, { host: '127.0.0.1', port: 0, workflows, resourceAdaptation })

    const r = await importReq({
      template: templateText({ name: 't', agents: [agentBlock({ provider: 'anthropic' })] }),
    })
    expect(r.status).toBe(200)
    expect(r.json.team.created.map((a: any) => a.id)).toEqual(['support-agent'])
    expect(r.json.postInstallChecklist.adaptations).toEqual([])
  })

  it('no surface wired → adaptations is empty (zero regression)', async () => {
    // Default beforeEach server has no resourceAdaptation surface.
    const r = await importReq({
      template: templateText({ name: 't', agents: [agentBlock({ provider: 'anthropic' })] }),
    })
    expect(r.status).toBe(200)
    expect(r.json.postInstallChecklist.adaptations).toEqual([])
  })
})

// ── FDE-M1b: durable connector-slot recording ────────────────────────────────
// The registry itself lives host-side (host/src/template-connector-slots.ts,
// unit-tested there). Here we pin only the web seam: a successful import calls
// the injected sink with (template.name, declared slots) — [] included, since
// recording [] is how a reinstall that DROPPED its `requires` clears the stale
// entry — and a sink fault never fails the install (advisory registry).
describe('POST /api/admin/templates/import — connector-slot sink (FDE-M1b)', () => {
  it('records declared slots under the template name after install', async () => {
    await b.server.close()
    const recorded: { pack: string; connectors: unknown }[] = []
    const connectorSlots = {
      record: async (pack: string, connectors: unknown) => {
        recorded.push({ pack, connectors })
      },
    }
    const workflows = { importFromText: async () => ({ id: 'x' }) } as unknown as WorkflowSurface
    b.server = await serveWeb(b.hub, { host: '127.0.0.1', port: 0, workflows, connectorSlots })

    const r = await importReq({
      template: templateText({
        name: 'with-slots',
        agents: [agentBlock()],
        requires: {
          connectors: [{ id: 'calendar', kind: 'mcp', optional: true, hint: '挂个日历' }],
        },
      }),
    })
    expect(r.status).toBe(200)
    // The sink sees the PARSED slots verbatim (kind included); trimming to the
    // persisted shape is the store's job, not the route's.
    expect(recorded).toEqual([
      {
        pack: 'with-slots',
        connectors: [{ id: 'calendar', kind: 'mcp', optional: true, hint: '挂个日历' }],
      },
    ])
  })

  it('records [] for a template without requires (clears a stale entry)', async () => {
    await b.server.close()
    const recorded: { pack: string; connectors: unknown }[] = []
    const connectorSlots = {
      record: async (pack: string, connectors: unknown) => {
        recorded.push({ pack, connectors })
      },
    }
    const workflows = { importFromText: async () => ({ id: 'x' }) } as unknown as WorkflowSurface
    b.server = await serveWeb(b.hub, { host: '127.0.0.1', port: 0, workflows, connectorSlots })

    const r = await importReq({
      template: templateText({ name: 'no-slots', agents: [agentBlock()] }),
    })
    expect(r.status).toBe(200)
    expect(recorded).toEqual([{ pack: 'no-slots', connectors: [] }])
  })

  it('a sink fault never fails the import', async () => {
    await b.server.close()
    const connectorSlots = {
      record: async () => {
        throw new Error('disk hiccup')
      },
    }
    const workflows = { importFromText: async () => ({ id: 'x' }) } as unknown as WorkflowSurface
    b.server = await serveWeb(b.hub, { host: '127.0.0.1', port: 0, workflows, connectorSlots })

    const r = await importReq({
      template: templateText({
        name: 'faulty-sink',
        agents: [agentBlock()],
        requires: { connectors: [{ id: 'calendar', kind: 'mcp' }] },
      }),
    })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    // Agent still landed despite the sink fault.
    const ids = (await b.space.agents()).map((a) => a.id)
    expect(ids).toContain('support-agent')
  })
})

// ── FDE-M2: golden acceptance cases at import ────────────────────────────────
// Runner + registry live host-side (host/src/template-acceptance.ts). The web
// seams pinned here: cases land in the checklist (ids only), a successful
// import records them through the injected surface ([] included — that clears
// a stale entry on reinstall), and a record fault never fails the install.
describe('POST /api/admin/templates/import — acceptance cases (FDE-M2)', () => {
  const acceptanceSurface = () => {
    const recorded: { pack: string; cases: unknown }[] = []
    return {
      recorded,
      surface: {
        record: async (pack: string, cases: unknown) => {
          recorded.push({ pack, cases })
        },
        list: async () => [],
        run: async () => ({ pack: '', ranBy: '', allGreen: true, results: [] }),
      },
    }
  }

  it('reports cases in the checklist and records them under the template name', async () => {
    await b.server.close()
    const { recorded, surface } = acceptanceSurface()
    const workflows = { importFromText: async () => ({ id: 'x' }) } as unknown as WorkflowSurface
    b.server = await serveWeb(b.hub, {
      host: '127.0.0.1',
      port: 0,
      workflows,
      templateAcceptance: surface,
    })

    const r = await importReq({
      template: templateText({
        name: 'with-cases',
        agents: [agentBlock()],
        workflows: [{ id: 'wf-a', trigger: { capability: 'cap-a' }, steps: [] }],
        acceptance: [
          {
            id: 'smoke',
            workflowId: 'wf-a',
            trigger: { focus: 'x' },
            assert: { contains: ['今日重点'] },
          },
        ],
      }),
    })
    expect(r.status).toBe(200)
    expect(r.json.postInstallChecklist.acceptanceCases).toEqual([
      { id: 'smoke', workflowId: 'wf-a' },
    ])
    expect(recorded).toEqual([
      {
        pack: 'with-cases',
        cases: [
          {
            id: 'smoke',
            workflowId: 'wf-a',
            trigger: { focus: 'x' },
            assert: { contains: ['今日重点'] },
          },
        ],
      },
    ])
  })

  it('records [] for a case-less template (clears a stale entry) and a fault never fails', async () => {
    await b.server.close()
    const { recorded, surface } = acceptanceSurface()
    surface.record = async (pack: string, cases: unknown) => {
      recorded.push({ pack, cases })
      throw new Error('disk hiccup')
    }
    const workflows = { importFromText: async () => ({ id: 'x' }) } as unknown as WorkflowSurface
    b.server = await serveWeb(b.hub, {
      host: '127.0.0.1',
      port: 0,
      workflows,
      templateAcceptance: surface,
    })

    const r = await importReq({
      template: templateText({ name: 'no-cases', agents: [agentBlock()] }),
    })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(recorded).toEqual([{ pack: 'no-cases', cases: [] }])
    // checklist still present with an empty list (zero regression shape)
    expect(r.json.postInstallChecklist.acceptanceCases).toEqual([])
  })
})
