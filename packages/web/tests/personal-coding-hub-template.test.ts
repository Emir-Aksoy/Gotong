/**
 * Anti-rot acceptance gate for the personal-coding-hub loadable template (CW4).
 *
 * It reads the SHIPPED
 * `examples/personal-coding-hub/template/personal-coding-hub.template.yaml` off
 * disk and runs it through the real parser + the real import route, so the
 * example can never silently drift out of sync with the template schema. This
 * is the "runnable proof" that the personal-coding-hub config is a LOADABLE file
 * (not a built-in TS literal): import the one file → the methodology-aware
 * coding-mentor agent + an addressable Obsidian KB slot (with a presetData
 * POINTER, never content) land.
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
    '../../../examples/personal-coding-hub/template/personal-coding-hub.template.yaml',
    import.meta.url,
  ),
)

let templateText: string

beforeEach(async () => {
  templateText = await readFile(EXAMPLE_PATH, 'utf8')
})

describe('examples/personal-coding-hub/template (CW4)', () => {
  it('parses as a valid gotong.template/v1 manifest', () => {
    const t = parseTemplate(templateText)
    expect(t.name).toBe('个人编码导师(Karpathy 工作流)')
    expect(t.version).toBe(1)
    // One mentor agent, no workflow (the router is code-driven), one KB slot.
    expect(t.agents.map((a) => a.id)).toEqual(['coding-mentor'])
    expect(t.workflows).toEqual([])
    expect(t.knowledgeBases.map((k) => k.name)).toEqual(['coding_methodology'])
  })

  it('the mentor agent reaches the methodology KB via mcp-obsidian', () => {
    const agent = parseTemplate(templateText).agents[0]!
    expect(agent.capabilities).toContain('mentor')
    // The agent declares the obsidian MCP server inline (host spawns it).
    const servers = agent.managed.mcpServers ?? []
    const obsidian = servers.find((s) => s.name === 'obsidian')
    expect(obsidian).toBeDefined()
    // Credentials ride as ${ENV} placeholders — never literal secrets in a template.
    expect((obsidian as { env?: Record<string, string> }).env?.OBSIDIAN_API_KEY).toBe(
      '${OBSIDIAN_API_KEY}',
    )
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

  it('imports end-to-end: the mentor agent lands, KB slot is reported', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'gotong-pch-'))
    const { space } = await Space.init(tmp, { name: 'pch-test' })
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
      // The mentor agent actually landed in the Space.
      expect((await space.agents()).map((a) => a.id)).toContain('coding-mentor')
      expect(json.team.created.map((a: any) => a.id)).toEqual(['coding-mentor'])
      // No workflow in this template — the router is code-driven (src/index.ts).
      expect(json.workflows).toEqual([])
      expect(wfCalls).toHaveLength(0)
      // The KB slot is reported (inline wiring), never auto-wired (decision #4).
      expect(json.knowledgeBases).toEqual([
        {
          name: 'coding_methodology',
          description: '卡帕西式编程方法论知识库(Obsidian vault via mcp-obsidian)',
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
