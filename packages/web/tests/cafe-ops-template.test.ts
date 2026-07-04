/**
 * Anti-rot acceptance gate for the cafe-ops loadable template (SM2).
 *
 * cafe-ops is the FIRST organization template — and the first with a non-empty
 * `template.workflows[]`. So beyond the usual "agents + KB land" checks (mirrors
 * the battle-monk gate), this test runs EACH embedded workflow block through the
 * REAL `parseWorkflow`, proving the opaque re-serialization round-trips: the
 * `human:` HITL sugar desugars to `gotong.human/v1`, `surface.me` survives, and
 * a broken block would fail loudly instead of importing a dead workflow.
 *
 * It reads the SHIPPED
 * `examples/cafe-ops/template/cafe-ops.template.yaml` off disk → real
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
  new URL('../../../examples/cafe-ops/template/cafe-ops.template.yaml', import.meta.url),
)

// Workflow ids in declaration order — the template lists them onboarding →
// shift → overtime, and the importer reports them in that order.
const WORKFLOW_IDS = ['cafe-staff-onboarding', 'cafe-shift-availability', 'cafe-overtime-claim']

let templateText: string

beforeEach(async () => {
  templateText = await readFile(EXAMPLE_PATH, 'utf8')
})

describe('examples/cafe-ops/template (SM2)', () => {
  it('parses as a valid gotong.template/v1 manifest', () => {
    const t = parseTemplate(templateText)
    expect(t.name).toBe('门店运营(奶茶 / 咖啡店)')
    expect(t.version).toBe(1)
    // Two agents covering exactly the three capabilities the workflows dispatch.
    expect(t.agents.map((a) => a.id)).toEqual(['onboarding-trainer', 'ops-assistant'])
    // Three declarative workflows — the new bit no personal template exercised.
    expect(t.workflows.map((w) => w.id)).toEqual(WORKFLOW_IDS)
    expect(t.knowledgeBases.map((k) => k.name)).toEqual(['store_ops_manual'])
  })

  it('each agent covers the workflow capabilities + reaches the manual via mcp-obsidian', () => {
    const agents = parseTemplate(templateText).agents
    const trainer = agents.find((a) => a.id === 'onboarding-trainer')!
    const ops = agents.find((a) => a.id === 'ops-assistant')!
    expect(trainer.capabilities).toEqual(['cafe.train-position'])
    // ops-assistant serves both the overtime + scheduling capabilities.
    expect(ops.capabilities).toEqual(['cafe.overtime-policy', 'cafe.schedule-draft'])
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

    const onboarding = byId.get('cafe-staff-onboarding')!
    expect(onboarding.trigger.capability).toBe('cafe.onboard-staff')
    expect(onboarding.surface?.me?.enabled).toBe(true)
    // snake_case user_scope_field survives the template→workflow re-serialization.
    expect(onboarding.surface?.me?.userScopeField).toBe('trainee_id')

    const shift = byId.get('cafe-shift-availability')!
    expect(shift.trigger.capability).toBe('cafe.submit-availability')
    // The `human:` step sugar desugared to the inbox capability.
    expect(JSON.stringify(shift)).toContain('gotong.human/v1')

    const overtime = byId.get('cafe-overtime-claim')!
    expect(overtime.trigger.capability).toBe('cafe.claim-overtime')
    expect(JSON.stringify(overtime)).toContain('gotong.human/v1')
    // Salary data is flagged confidential in governance (declarative, not a gate).
    expect(overtime.governance?.dataSensitivity).toBe('confidential')
  })

  it('declares the store-ops-manual KB as MCP wiring + a presetData POINTER (never content)', () => {
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
    const tmp = await mkdtemp(join(tmpdir(), 'gotong-cafe-'))
    const { space } = await Space.init(tmp, { name: 'cafe-test' })
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
      for (const id of ['onboarding-trainer', 'ops-assistant']) expect(landed).toContain(id)
      expect(json.team.created.map((a: any) => a.id)).toEqual(['onboarding-trainer', 'ops-assistant'])

      // All three workflows imported, in order, each having passed parseWorkflow.
      expect(json.workflows).toEqual(WORKFLOW_IDS.map((id) => ({ id, ok: true })))
      expect(importedIds).toEqual(WORKFLOW_IDS)

      // The KB slot is reported (inline wiring), never auto-wired (decision #4).
      expect(json.knowledgeBases).toEqual([
        {
          name: 'store_ops_manual',
          description: '店面运营手册(岗位 SOP / 规范 / 加班政策 / 排班规则,via mcp-obsidian)',
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
