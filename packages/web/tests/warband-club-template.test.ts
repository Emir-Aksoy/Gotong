/**
 * Anti-rot acceptance gate for the warband-club loadable template (W2).
 *
 * warband-club is the SECOND organization template (after cafe-ops) and the
 * second with a non-empty `template.workflows[]`. Where cafe-ops models a
 * storefront's top-down approvals, warband-club models collaboration over a
 * SHARED resource — so this gate proves the same opaque-blob round-trip holds:
 * each embedded workflow block runs through the REAL `parseWorkflow`, the
 * `human:` muster gate desugars to `gotong.human/v1`, `surface.me` member
 * self-service survives, and a broken block would fail loudly instead of
 * importing a dead workflow.
 *
 * It reads the SHIPPED
 * `examples/warband-club/template/warband-club.template.yaml` off disk → real
 * parseTemplate → real parseWorkflow per block → real import route, so the
 * example can never silently drift out of sync with either schema.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Hub, Space } from '@gotong/core'
import { parseWorkflow } from '@gotong/workflow'

import { serveWeb, type WebServerHandle, type WorkflowSurface } from '../src/server.js'
import { parseTemplate } from '../src/template-manifest.js'

const EXAMPLE_PATH = fileURLToPath(
  new URL('../../../examples/warband-club/template/warband-club.template.yaml', import.meta.url),
)

// Workflow ids in declaration order — the template lists them contribute →
// consult → muster, and the importer reports them in that order.
const WORKFLOW_IDS = ['warband-contribute', 'warband-consult', 'warband-muster']

let templateText: string

beforeEach(async () => {
  templateText = await readFile(EXAMPLE_PATH, 'utf8')
})

describe('examples/warband-club/template (W2)', () => {
  it('parses as a valid gotong.template/v1 manifest', () => {
    const t = parseTemplate(templateText)
    expect(t.name).toBe('战团同好会(共享档案库)')
    expect(t.version).toBe(1)
    // Two agents covering exactly the three capabilities the workflows dispatch.
    expect(t.agents.map((a) => a.id)).toEqual(['archivist', 'herald'])
    // Three declarative workflows — collaboration's write / read / decide.
    expect(t.workflows.map((w) => w.id)).toEqual(WORKFLOW_IDS)
    expect(t.knowledgeBases.map((k) => k.name)).toEqual(['warband_archive'])
  })

  it('the archivist serves both shared-archive capabilities; all agents reach it via mcp-obsidian', () => {
    const agents = parseTemplate(templateText).agents
    const archivist = agents.find((a) => a.id === 'archivist')!
    const herald = agents.find((a) => a.id === 'herald')!
    // The archivist both files into and consults the SAME shared archive.
    expect(archivist.capabilities).toEqual(['warband.file-contribution', 'warband.consult-archive'])
    expect(herald.capabilities).toEqual(['warband.draft-muster'])
    // Credentials ride as ${ENV} placeholders — never literal secrets.
    for (const a of agents) {
      const obsidian = (a.managed.mcpServers ?? []).find((s) => s.name === 'obsidian')
      expect(obsidian, `${a.id} must wire obsidian`).toBeDefined()
      expect((obsidian as { env?: Record<string, string> }).env?.OBSIDIAN_API_KEY).toBe(
        '${OBSIDIAN_API_KEY}',
      )
    }
  })

  it('every embedded workflow block round-trips through the real parseWorkflow', () => {
    const t = parseTemplate(templateText)
    // The opaque-blob trick is only sound if each re-serialized block is in fact
    // a valid gotong.workflow/v1 — assert it against the SAME parser the host
    // would run on import, not parseTemplate (which never inspects steps).
    const byId = new Map(t.workflows.map((w) => [w.id, parseWorkflow(w.yaml)]))

    const contribute = byId.get('warband-contribute')!
    expect(contribute.trigger.capability).toBe('warband.contribute')
    expect(contribute.surface?.me?.enabled).toBe(true)
    // snake_case user_scope_field survives the template→workflow re-serialization.
    expect(contribute.surface?.me?.userScopeField).toBe('contributor_id')

    const consult = byId.get('warband-consult')!
    expect(consult.trigger.capability).toBe('warband.ask')
    expect(consult.surface?.me?.userScopeField).toBe('asker_id')

    const muster = byId.get('warband-muster')!
    expect(muster.trigger.capability).toBe('warband.propose-muster')
    // The `human:` leader-confirm step desugared to the inbox capability.
    expect(JSON.stringify(muster)).toContain('gotong.human/v1')
    expect(muster.surface?.me?.userScopeField).toBe('proposer_id')
  })

  it('declares the warband-archive KB as MCP wiring + a presetData POINTER (never content)', () => {
    const kb = parseTemplate(templateText).knowledgeBases[0]!
    expect(kb.mcpServer?.name).toBe('obsidian')
    expect(kb.presetData?.kind).toBe('url')
    expect(kb.presetData?.ref).toMatch(/^https:\/\//)
  })

  it('carries a one-click apiKeyPrompt', () => {
    const t = parseTemplate(templateText)
    expect(t.apiKeyPrompt).toMatchObject({ provider: 'openai-compatible', label: 'DeepSeek' })
  })

  it('imports end-to-end: 2 agents land, 3 workflows import (each re-validated)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'gotong-warband-'))
    const { space } = await Space.init(tmp, { name: 'warband-test' })
    const hub = new Hub({ space })
    await hub.start()
    const { token } = await space.createAdmin('TestAdmin')

    // The mock workflow surface re-parses each yaml with the REAL parseWorkflow,
    // so the route-level path validates every embedded block exactly as a real
    // host would before registering it.
    const importedIds: string[] = []
    const workflows = {
      importFromText: async (yaml: string) => {
        const def = parseWorkflow(yaml)
        importedIds.push(def.id)
        return { id: def.id }
      },
    } as unknown as WorkflowSurface

    let server: WebServerHandle | undefined
    try {
      server = await serveWeb(hub, { host: '127.0.0.1', port: 0, workflows })
      const res = await fetch(`${server.url}/api/admin/templates/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ template: templateText }),
      })
      expect(res.status).toBe(200)
      const json: any = await res.json()
      expect(json.ok).toBe(true)

      // Both agents landed in the Space.
      const landed = (await space.agents()).map((a) => a.id)
      for (const id of ['archivist', 'herald']) expect(landed).toContain(id)
      expect(json.team.created.map((a: any) => a.id)).toEqual(['archivist', 'herald'])

      // All three workflows imported, in order, each having passed parseWorkflow.
      expect(json.workflows).toEqual(WORKFLOW_IDS.map((id) => ({ id, ok: true })))
      expect(importedIds).toEqual(WORKFLOW_IDS)

      // The KB slot is reported (inline wiring), never auto-wired (decision #4).
      expect(json.knowledgeBases).toEqual([
        {
          name: 'warband_archive',
          description:
            '战团共享档案库(涂装方案 / 战报 / 典籍 / 集结章程,全团共读共写,via mcp-obsidian)',
          wiring: 'inline',
          useMcpServer: undefined,
        },
      ])

      // A structure-only import carries no secrets and omits nothing sensitive.
      expect(json.secretsApplied).toBe(0)
      expect(json.encryptedSkipped).toBe(false)
      expect(json.personnelOmitted).toBe(false)
    } finally {
      await server?.close()
      await hub.stop?.()
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
