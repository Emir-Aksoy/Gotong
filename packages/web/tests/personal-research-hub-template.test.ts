/**
 * Anti-rot acceptance gate for the personal-research-hub loadable template (CR2).
 *
 * It reads the SHIPPED
 * `examples/personal-research-hub/template/personal-research-hub.template.yaml`
 * off disk and runs it through the real parser + the real import route, so the
 * example can never silently drift out of sync with the template schema. This is
 * the "runnable proof" that the personal-research-hub config is a LOADABLE file
 * (not a built-in TS literal): import the one file → the whole research team
 * (librarian + compiler + researcher) + an addressable Obsidian wiki KB slot
 * (with a presetData POINTER, never content) land.
 *
 * Unlike personal-coding-hub (1 agent — the CLI coders are CliParticipant, not
 * template-able), all three here are genuine managed LLM agents, so this gate
 * also exercises the template's N-agent plurality.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Hub, Space } from '@gotong/core'

import { serveWeb, type WebServerHandle, type WorkflowSurface } from '../src/server.js'
import { parseTemplate } from '../src/template-manifest.js'

const EXAMPLE_PATH = fileURLToPath(
  new URL(
    '../../../examples/personal-research-hub/template/personal-research-hub.template.yaml',
    import.meta.url,
  ),
)

let templateText: string

beforeEach(async () => {
  templateText = await readFile(EXAMPLE_PATH, 'utf8')
})

describe('examples/personal-research-hub/template (CR2)', () => {
  it('parses as a valid gotong.template/v1 manifest', () => {
    const t = parseTemplate(templateText)
    expect(t.name).toBe('个人研究中枢(Karpathy 知识库循环)')
    expect(t.version).toBe(1)
    // The whole team, no workflow (orchestration is code-driven), one KB slot.
    expect(t.agents.map((a) => a.id)).toEqual(['librarian', 'compiler', 'researcher'])
    expect(t.workflows).toEqual([])
    expect(t.knowledgeBases.map((k) => k.name)).toEqual(['research_wiki'])
  })

  it('every agent reaches the wiki KB via mcp-obsidian, with ${ENV} secrets only', () => {
    const agents = parseTemplate(templateText).agents
    // Capabilities the example's DispatchToolset routes across.
    expect(agents.find((a) => a.id === 'librarian')!.capabilities).toContain('route')
    expect(agents.find((a) => a.id === 'compiler')!.capabilities).toContain('compile')
    expect(agents.find((a) => a.id === 'researcher')!.capabilities).toContain('research')
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

  it('declares the KB as MCP wiring + a presetData POINTER (never content)', () => {
    const kb = parseTemplate(templateText).knowledgeBases[0]!
    // Decision #4: the KB is wired via an inline MCP server, and any seed data is
    // a pointer the importer fetches explicitly — not inline knowledge content.
    expect(kb.mcpServer?.name).toBe('obsidian')
    expect(kb.presetData?.kind).toBe('url')
    expect(kb.presetData?.ref).toMatch(/^https:\/\//)
  })

  it('carries a one-click apiKeyPrompt', () => {
    const t = parseTemplate(templateText)
    expect(t.apiKeyPrompt).toMatchObject({ provider: 'openai-compatible', label: 'DeepSeek' })
  })

  it('imports end-to-end: the whole team lands, KB slot is reported', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'gotong-prh-'))
    const { space } = await Space.init(tmp, { name: 'prh-test' })
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
      // All three agents actually landed in the Space, in template order.
      const landed = (await space.agents()).map((a) => a.id)
      expect(landed).toContain('librarian')
      expect(landed).toContain('compiler')
      expect(landed).toContain('researcher')
      expect(json.team.created.map((a: any) => a.id)).toEqual(['librarian', 'compiler', 'researcher'])
      // No workflow in this template — orchestration is code-driven (src/index.ts).
      expect(json.workflows).toEqual([])
      expect(wfCalls).toHaveLength(0)
      // The KB slot is reported (inline wiring), never auto-wired (decision #4).
      expect(json.knowledgeBases).toEqual([
        {
          name: 'research_wiki',
          description: '个人研究 wiki(raw 源材料编译成的互链 Obsidian vault via mcp-obsidian)',
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
