/**
 * Anti-rot acceptance gate for the v5 B-M5 one-click template example.
 *
 * It reads the SHIPPED `examples/oneclick-template/template.yaml` off disk and
 * runs it through the real parser + the real import route, so the example can
 * never silently drift out of sync with the template schema. This is the
 * "runnable proof" for B-M5: import the one file → an agent + a workflow + an
 * addressable KB slot (with a presetData pointer) land, and the apiKeyPrompt
 * surfaces for the one-click flow.
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
  new URL('../../../examples/oneclick-template/template.yaml', import.meta.url),
)

let templateText: string

beforeEach(async () => {
  templateText = await readFile(EXAMPLE_PATH, 'utf8')
})

describe('examples/oneclick-template/template.yaml (v5 B-M5)', () => {
  it('parses as a valid gotong.template/v1 manifest', () => {
    const t = parseTemplate(templateText)
    expect(t.name).toBe('客服知识助手(一键模板)')
    expect(t.version).toBe(1)
    // One agent, one workflow, one addressable KB slot.
    expect(t.agents.map((a) => a.id)).toEqual(['support-agent'])
    expect(t.workflows.map((w) => w.id)).toEqual(['ticket-flow'])
    expect(t.knowledgeBases.map((k) => k.name)).toEqual(['company_kb'])
  })

  it('declares the KB as MCP wiring + a presetData POINTER (never content)', () => {
    const kb = parseTemplate(templateText).knowledgeBases[0]!
    // Decision #4: the KB is wired via an inline MCP server, and any seed data
    // is a pointer the importer fetches explicitly — not inline content.
    expect(kb.mcpServer?.name).toBe('company_kb')
    expect(kb.presetData?.kind).toBe('url')
    expect(kb.presetData?.ref).toMatch(/^https:\/\//)
  })

  it('carries a one-click apiKeyPrompt', () => {
    const t = parseTemplate(templateText)
    expect(t.apiKeyPrompt).toMatchObject({ provider: 'openai-compatible', label: 'DeepSeek' })
  })

  it('imports end-to-end: agent lands, workflow imports, KB slot is reported', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'gotong-oneclick-'))
    const { space } = await Space.init(tmp, { name: 'oneclick-test' })
    const hub = new Hub({ space })
    await hub.start()
    const { token } = await space.createAdmin('TestAdmin')

    const wfCalls: string[] = []
    const workflows = {
      importFromText: async (yaml: string) => {
        wfCalls.push(yaml)
        return { id: 'ticket-flow' }
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
      // The agent actually landed in the Space.
      expect((await space.agents()).map((a) => a.id)).toContain('support-agent')
      expect(json.team.created.map((a: any) => a.id)).toEqual(['support-agent'])
      // The workflow was handed to the runner.
      expect(json.workflows).toEqual([{ id: 'ticket-flow', ok: true }])
      expect(wfCalls).toHaveLength(1)
      // The KB slot is reported (inline wiring), never auto-wired (decision #4).
      expect(json.knowledgeBases).toEqual([
        { name: 'company_kb', description: '公司客服知识库(chroma-mcp 本机向量检索)', wiring: 'inline', useMcpServer: undefined },
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
