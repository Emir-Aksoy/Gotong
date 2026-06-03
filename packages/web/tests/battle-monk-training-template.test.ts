/**
 * Anti-rot acceptance gate for the battle-monk-training loadable template (BM2).
 *
 * It reads the SHIPPED
 * `examples/battle-monk-training/template/battle-monk-training.template.yaml` off
 * disk and runs it through the real parser + the real import route, so the
 * example can never silently drift out of sync with the template schema. This is
 * the "runnable proof" that the battle-monk-training config is a LOADABLE file
 * (not a built-in TS literal): import the one file → the whole monastic order
 * (preceptor + body/mind/lore drills) + an addressable Codex KB slot (with a
 * presetData POINTER, never content) land.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Hub, Space } from '@aipehub/core'

import { serveWeb, type WebServerHandle, type WorkflowSurface } from '../src/server.js'
import { parseTemplate } from '../src/template-manifest.js'

const EXAMPLE_PATH = fileURLToPath(
  new URL(
    '../../../examples/battle-monk-training/template/battle-monk-training.template.yaml',
    import.meta.url,
  ),
)

let templateText: string

beforeEach(async () => {
  templateText = await readFile(EXAMPLE_PATH, 'utf8')
})

describe('examples/battle-monk-training/template (BM2)', () => {
  it('parses as a valid aipehub.template/v1 manifest', () => {
    const t = parseTemplate(templateText)
    expect(t.name).toBe('战斗修士锻炼(身-心-学三柱)')
    expect(t.version).toBe(1)
    // The whole order, no workflow (orchestration is code-driven), one KB slot.
    expect(t.agents.map((a) => a.id)).toEqual(['preceptor', 'body-drill', 'mind-forge', 'lore-scribe'])
    expect(t.workflows).toEqual([])
    expect(t.knowledgeBases.map((k) => k.name)).toEqual(['acolyte_codex'])
  })

  it('every agent reaches the Codex via mcp-obsidian, with ${ENV} secrets only', () => {
    const agents = parseTemplate(templateText).agents
    // The capabilities the example's DispatchToolset routes across.
    expect(agents.find((a) => a.id === 'preceptor')!.capabilities).toContain('route')
    expect(agents.find((a) => a.id === 'body-drill')!.capabilities).toContain('body')
    expect(agents.find((a) => a.id === 'mind-forge')!.capabilities).toContain('mind')
    expect(agents.find((a) => a.id === 'lore-scribe')!.capabilities).toContain('lore')
    // Each agent declares the obsidian MCP server inline (host spawns it), and
    // credentials ride as ${ENV} placeholders — never literal secrets.
    for (const a of agents) {
      const obsidian = (a.managed.mcpServers ?? []).find((s) => s.name === 'obsidian')
      expect(obsidian, `${a.id} must wire obsidian`).toBeDefined()
      expect((obsidian as { env?: Record<string, string> }).env?.OBSIDIAN_API_KEY).toBe(
        '${OBSIDIAN_API_KEY}',
      )
    }
  })

  it('declares the Codex KB as MCP wiring + a presetData POINTER (never content)', () => {
    const kb = parseTemplate(templateText).knowledgeBases[0]!
    // Decision #4: the KB is wired via an inline MCP server, and any seed data is
    // a pointer the importer fetches explicitly — not inline state content.
    expect(kb.mcpServer?.name).toBe('obsidian')
    expect(kb.presetData?.kind).toBe('url')
    expect(kb.presetData?.ref).toMatch(/^https:\/\//)
  })

  it('carries a one-click apiKeyPrompt', () => {
    const t = parseTemplate(templateText)
    expect(t.apiKeyPrompt).toMatchObject({ provider: 'openai-compatible', label: 'DeepSeek' })
  })

  it('imports end-to-end: the whole order lands, Codex slot is reported', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'aipehub-bmt-'))
    const { space } = await Space.init(tmp, { name: 'bmt-test' })
    const hub = new Hub({ space })
    await hub.start()
    const { token } = await space.createAdmin('TestAdmin')

    const wfCalls: string[] = []
    const workflows = {
      importFromText: async (yaml: string) => {
        wfCalls.push(yaml)
        return { id: 'unused' }
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
      // All four agents actually landed in the Space.
      const landed = (await space.agents()).map((a) => a.id)
      for (const id of ['preceptor', 'body-drill', 'mind-forge', 'lore-scribe']) {
        expect(landed).toContain(id)
      }
      expect(json.team.created.map((a: any) => a.id)).toEqual([
        'preceptor',
        'body-drill',
        'mind-forge',
        'lore-scribe',
      ])
      // No workflow in this template — orchestration is code-driven (src/index.ts).
      expect(json.workflows).toEqual([])
      expect(wfCalls).toHaveLength(0)
      // The KB slot is reported (inline wiring), never auto-wired (decision #4).
      expect(json.knowledgeBases).toEqual([
        {
          name: 'acolyte_codex',
          description: '修士档案 Codex(三柱状态:肉身 / 心志 / 学识,via mcp-obsidian)',
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
