/**
 * Anti-rot acceptance gate for the smart-home-hub loadable template.
 *
 * smart-home-hub is a SMALL personal smart-home template: 1 managed agent wired
 * to a Home Assistant MCP server (米家 → ha_xiaomi_home → HA MCP Server) + 1
 * declarative workflow whose security action is held behind a `human:` step. So
 * beyond the usual "agent lands" check it runs the embedded workflow block through
 * the REAL `parseWorkflow`, proving the opaque re-serialization round-trips: the
 * `human:` HITL sugar desugars to `aipehub.human/v1`, `surface.me` survives, and
 * the `when:`-gated secure step stays gated.
 *
 * It reads the SHIPPED
 * `examples/smart-home-hub/template/smart-home-hub.template.yaml` off disk → real
 * parseTemplate → real parseWorkflow → real import route, so the example can never
 * silently drift out of sync with either schema.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Hub, Space } from '@aipehub/core'
import { parseWorkflow } from '@aipehub/workflow'

import { serveWeb, type WebServerHandle, type WorkflowSurface } from '../src/server.js'
import { parseTemplate } from '../src/template-manifest.js'

const EXAMPLE_PATH = fileURLToPath(
  new URL('../../../examples/smart-home-hub/template/smart-home-hub.template.yaml', import.meta.url),
)

let templateText: string

beforeEach(async () => {
  templateText = await readFile(EXAMPLE_PATH, 'utf8')
})

describe('examples/smart-home-hub/template', () => {
  it('parses as a valid aipehub.template/v1 manifest (1 agent, 1 workflow, no KB)', () => {
    const t = parseTemplate(templateText)
    expect(t.name).toBe('智能家居(小米 / Home Assistant)')
    expect(t.version).toBe(1)
    // One managed agent serving both home capabilities.
    expect(t.agents.map((a) => a.id)).toEqual(['home-steward'])
    // One declarative workflow.
    expect(t.workflows.map((w) => w.id)).toEqual(['home-goodnight'])
    // Intentionally NO KB slot — devices are the live HA state via MCP, not a vault.
    expect(t.knowledgeBases).toEqual([])
  })

  it('the home-steward covers both capabilities + reaches devices via a Home Assistant MCP server', () => {
    const steward = parseTemplate(templateText).agents.find((a) => a.id === 'home-steward')!
    expect(steward.capabilities).toEqual(['home.apply-scene', 'home.secure'])
    const ha = (steward.managed.mcpServers ?? []).find((s) => s.name === 'homeassistant')
    expect(ha, 'home-steward must wire the homeassistant MCP server').toBeDefined()
    // The HA endpoint + token ride as ${ENV} placeholders — never literal secrets.
    const env = (ha as { env?: Record<string, string> }).env ?? {}
    expect(env.SSE_URL).toBe('${HA_MCP_SSE_URL}')
    expect(env.API_ACCESS_TOKEN).toBe('${HA_TOKEN}')
  })

  it('the embedded workflow round-trips through the real parseWorkflow (human: + when gates survive)', () => {
    const t = parseTemplate(templateText)
    // The opaque-blob trick is only sound if the re-serialized block is in fact a
    // valid aipehub.workflow/v1 — assert it against the SAME parser the host runs.
    const wf = parseWorkflow(t.workflows[0]!.yaml)
    expect(wf.id).toBe('home-goodnight')
    expect(wf.trigger.capability).toBe('home.run-goodnight')
    // surface.me survives (snake_case user_scope_field → camelCase).
    expect(wf.surface?.me?.enabled).toBe(true)
    expect(wf.surface?.me?.userScopeField).toBe('resident_id')
    // The `human:` security step desugared to the inbox capability.
    expect(JSON.stringify(wf)).toContain('aipehub.human/v1')
    // The secure step is gated on the approval — reject → it is skipped (fail-closed).
    const secure = wf.steps.find((s) => s.id === 'secure')!
    expect(secure.when).toBe('$confirm-lock.output.approved == true')
  })

  it('carries a one-click apiKeyPrompt', () => {
    const t = parseTemplate(templateText)
    expect(t.apiKeyPrompt).toMatchObject({ provider: 'openai-compatible', label: 'DeepSeek' })
  })

  it('imports end-to-end: 1 agent lands, 1 workflow imports (re-validated), no KB', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'aipehub-smart-home-'))
    const { space } = await Space.init(tmp, { name: 'smart-home-test' })
    const hub = new Hub({ space })
    await hub.start()
    const { token } = await space.createAdmin('TestAdmin')

    // The mock workflow surface re-parses the yaml with the REAL parseWorkflow,
    // so the route-level path validates the embedded block exactly as a real host
    // would before registering it.
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

      // The agent landed in the Space.
      const landed = (await space.agents()).map((a) => a.id)
      expect(landed).toContain('home-steward')
      expect(json.team.created.map((a: any) => a.id)).toEqual(['home-steward'])

      // The workflow imported, having passed parseWorkflow.
      expect(json.workflows).toEqual([{ id: 'home-goodnight', ok: true }])
      expect(importedIds).toEqual(['home-goodnight'])

      // No KB slot to report (this template carries none, by design).
      expect(json.knowledgeBases).toEqual([])

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
