/**
 * v5 B — the full export → transport → import-activate round-trip.
 *
 * This is the "one file, activate to use" closed loop the user asked for: a hub
 * is fully described by ONE aipehub.template/v1 file; carry that file to a fresh
 * hub and importing it reconstitutes an equivalent hub.
 *
 * The two existing template tests each cover only HALF of this:
 *   - template-routes.test.ts        proves an EXPORT blob parses (stops there)
 *   - template-gallery-install.test.ts  proves a STATIC blob IMPORTS cleanly
 * Neither connects a LIVE export on one hub to a FRESH import on a DIFFERENT
 * hub. That connection — export(A) → one file → import(B) → equivalent hub — is
 * the thing nobody asserts, and it's the whole point of the template format.
 *
 * So this gate stands up two SEPARATE hubs:
 *   A  a source hub holding a managed agent (with a literal MCP secret) + a
 *      workflow + a KB slot, configured so the real export route can read them;
 *   B  a fresh, empty hub — the place the file gets activated.
 * It exports from A, serializes to a single file ON DISK, reads it back, feeds
 * it to B's real import route, and asserts B is now equivalent (same agent +
 * workflow landed, KB slot reported), the orchestration skeleton transported
 * intact, and the literal secret NEVER rode along (placeholder-ized — the
 * structure-only default, decision #5). Zero framework change: both routes are
 * the production ones, wired exactly as the admin UI / gallery wire them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'

import { serveWeb, type WebServerHandle, type WorkflowSurface } from '../src/server.js'

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

interface BootedHub {
  tmp: string
  space: Space
  hub: Hub
  server: WebServerHandle
  token: string
}

async function bootHub(name: string, workflows: WorkflowSurface): Promise<BootedHub> {
  const tmp = await mkdtemp(join(tmpdir(), `aipehub-roundtrip-${name}-`))
  const init = await Space.init(tmp, { name: `roundtrip-${name}` })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()
  const { token } = await space.createAdmin('TestAdmin')
  const server = await serveWeb(hub, { host: '127.0.0.1', port: 0, workflows })
  return { tmp, space, hub, server, token }
}

async function teardown(h: BootedHub): Promise<void> {
  await h.server.close()
  await h.hub.stop?.()
  await rm(h.tmp, { recursive: true, force: true })
}

const post = (h: BootedHub, path: string, body: unknown) =>
  fetch(`${h.server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${h.token}` },
    body: JSON.stringify(body),
  })

let A: BootedHub // exporting hub (the source)
let B: BootedHub // fresh importing hub (the destination)
let wfLandedOnB: string[]

beforeEach(async () => {
  // Hub A — the source: a managed agent carrying a LITERAL MCP secret, plus an
  // exportable workflow the export route can read by id.
  A = await bootHub('a', {
    exportDefinitionText: async (id: string) => (id === 'ticket-flow' ? WF_YAML : null),
  } as unknown as WorkflowSurface)
  await A.space.upsertAgent({
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

  // Hub B — a SEPARATE, empty hub: where the one file gets activated. Records
  // every workflow yaml the import route forwards so we can prove it transported.
  wfLandedOnB = []
  B = await bootHub('b', {
    importFromText: async (yaml: string) => {
      wfLandedOnB.push(yaml)
      return { id: 'ticket-flow' }
    },
  } as unknown as WorkflowSurface)
})

afterEach(async () => {
  await teardown(A)
  await teardown(B)
})

describe('template export → transport → import-activate round-trip (v5 B)', () => {
  it('one exported file activates an equivalent hub on a fresh, separate hub B', async () => {
    // B starts empty — it knows nothing about A's agent.
    expect((await B.space.agents()).map((a) => a.id)).not.toContain('support-agent')

    // 1) EXPORT on A — the real route renders the self-contained structure.
    const exp = await post(A, '/api/admin/templates/export', {
      name: '客服模板',
      description: '一个文件装下整套',
      agentIds: ['support-agent'],
      workflowIds: ['ticket-flow'],
      knowledgeBases: [{ name: 'company-kb', useMcpServer: 'company-kb' }],
    })
    expect(exp.status).toBe(200)
    const expJson = (await exp.json()) as { ok: boolean; template: unknown; encryptionKey?: string }
    expect(expJson.ok).toBe(true)
    // Default export is structure-only: no key handed back means no secret
    // sidecar was built, so nothing sensitive can possibly ride to B.
    expect(expJson.encryptionKey).toBeUndefined()

    // 2) TRANSPORT — serialize to ONE file, save it to disk, read it back. This
    // is literally "导出 → 传输": a single artifact the operator carries to B.
    const filePath = join(A.tmp, 'support.aipehub.template.json')
    await writeFile(filePath, JSON.stringify(expJson.template, null, 2), 'utf8')
    const oneFile = await readFile(filePath, 'utf8')
    expect(oneFile).toContain('aipehub.template/v1')
    // The literal secret stayed home; only a ${PLACEHOLDER} reference travels.
    expect(oneFile).not.toContain('sk-LITERAL')
    expect(oneFile).toContain('${KB_TOKEN}')

    // 3) IMPORT / ACTIVATE on B — feed that one file to the real import route.
    const imp = await post(B, '/api/admin/templates/import', { template: oneFile })
    expect(imp.status).toBe(200)
    const impJson = (await imp.json()) as any
    expect(impJson.ok).toBe(true)

    // Equivalent hub: the agent + workflow that defined A now define B.
    expect(impJson.team.created.map((a: any) => a.id)).toEqual(['support-agent'])
    expect((await B.space.agents()).map((a) => a.id)).toContain('support-agent')
    expect(impJson.workflows).toHaveLength(1)
    expect(impJson.workflows[0]).toMatchObject({ id: 'ticket-flow', ok: true })
    // The orchestration skeleton transported intact — id + capability arrive on
    // B regardless of the serialization form the template carries them in.
    expect(wfLandedOnB).toHaveLength(1)
    expect(wfLandedOnB[0]).toContain('ticket-flow')
    expect(wfLandedOnB[0]).toContain('answer-ticket')

    // The KB slot is reported for the operator to wire their OWN store to —
    // "activate to use" surfaces the last mile, never auto-connects (decision #4).
    expect(impJson.knowledgeBases.map((k: any) => k.name)).toEqual(['company-kb'])
    expect(impJson.postInstallChecklist.kbSlotsToWire.map((k: any) => k.name)).toContain(
      'company-kb',
    )

    // No leak on the DESTINATION: B's landed agent holds the placeholder, never
    // the literal. The secret never crossed to a different hub.
    const landed = (await B.space.agents()).find((a) => a.id === 'support-agent')!
    const landedJson = JSON.stringify(landed)
    expect(landedJson).not.toContain('sk-LITERAL')
    expect(landedJson).toContain('${KB_TOKEN}')
  })

  it('re-activating the same file on B is idempotent — agent skipped, not cloned', async () => {
    const exp = await post(A, '/api/admin/templates/export', {
      name: '客服模板',
      agentIds: ['support-agent'],
      workflowIds: ['ticket-flow'],
    })
    const { template } = (await exp.json()) as { template: unknown }
    const oneFile = JSON.stringify(template)

    const first = await post(B, '/api/admin/templates/import', { template: oneFile })
    expect((await first.json()).team.created.map((a: any) => a.id)).toEqual(['support-agent'])

    const second = await post(B, '/api/admin/templates/import', { template: oneFile })
    const secondJson = (await second.json()) as any
    expect(secondJson.team.created).toEqual([])
    expect(secondJson.team.skipped).toEqual(['support-agent'])
    // Exactly one support-agent on B — re-activating never duplicates.
    expect((await B.space.agents()).filter((a) => a.id === 'support-agent')).toHaveLength(1)
  })
})
