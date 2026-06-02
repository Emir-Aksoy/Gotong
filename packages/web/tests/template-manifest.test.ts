import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { ManifestError } from '../src/manifest.js'
import {
  TEMPLATE_SCHEMA_V1,
  parseTemplate,
  renderTemplate,
  type TemplateAgentInput,
} from '../src/template-manifest.js'

/**
 * The v5 Stream B template parser is the trust boundary between "untrusted
 * template YAML from the internet" and the supervisor — same contract as the
 * agent/bundle parsers. The defining rule it must enforce: a template carries
 * *structure + references* (agents, workflows, addressable KB wiring) and
 * NEVER knowledge content. These tests pin the format down (decision #4).
 */

const FULL = `
schema: aipehub.template/v1
template:
  name: 客服知识助手
  description: 一个客服 agent + 工单工作流 + 指向你自己 KB 的接线
  version: 2
  agents:
    - id: support-agent
      capabilities: [answer-ticket]
      kind: llm
      provider: openai-compatible
      model: deepseek-v4-flash
      baseURL: https://api.deepseek.com/v1
      system: 你是客服助手。
      useMcpServers: [kb-support]
  workflows:
    - id: ticket-flow
      name: 工单处理
      trigger:
        capability: answer-ticket
      steps:
        - id: answer
          dispatch:
            strategy: { kind: capability, capabilities: [answer-ticket] }
            payload: { q: $trigger.payload.q }
    - id: escalation-flow
      trigger:
        capability: escalate
      steps:
        - id: esc
          dispatch:
            strategy: { kind: capability, capabilities: [escalate] }
            payload: {}
  knowledgeBases:
    - name: kb-support
      description: 公司客服知识库(向量检索)
      mcpServer:
        name: kb-support
        command: npx
        args: [-y, chroma-mcp]
        env:
          CHROMA_URL: \${CHROMA_URL}
      presetData:
        kind: url
        ref: https://example.com/kb-support.tar.zst
        description: 预置的脱敏样例 KB
    - name: kb-policy
      useMcpServer: company-policy
  defaults:
    apiKeyPrompt:
      provider: openai-compatible
      baseURL: https://api.deepseek.com/v1
      label: DeepSeek
`

describe('parseTemplate (aipehub.template/v1)', () => {
  it('parses a full template (agents + workflows + KBs + defaults)', () => {
    const t = parseTemplate(FULL)
    expect(t.schema).toBe(TEMPLATE_SCHEMA_V1)
    expect(t.name).toBe('客服知识助手')
    expect(t.description).toContain('工单工作流')
    expect(t.version).toBe(2)

    // agents — delegated to parseManifest, so the full agent shape is honored
    expect(t.agents).toHaveLength(1)
    const a = t.agents[0]!
    expect(a.id).toBe('support-agent')
    expect(a.managed.provider).toBe('openai-compatible')
    expect(a.managed.baseURL).toBe('https://api.deepseek.com/v1')
    expect(a.managed.useMcpServers).toEqual(['kb-support'])

    // workflows — multiple, listed by id
    expect(t.workflows.map((w) => w.id)).toEqual(['ticket-flow', 'escalation-flow'])

    // knowledge bases — addressable, two wiring forms
    expect(t.knowledgeBases.map((k) => k.name)).toEqual(['kb-support', 'kb-policy'])
    const kb0 = t.knowledgeBases[0]!
    expect(kb0.mcpServer?.name).toBe('kb-support')
    expect(kb0.mcpServer?.command).toBe('npx')
    expect(kb0.useMcpServer).toBeUndefined()
    expect(kb0.presetData).toEqual({
      kind: 'url',
      ref: 'https://example.com/kb-support.tar.zst',
      description: '预置的脱敏样例 KB',
    })
    const kb1 = t.knowledgeBases[1]!
    expect(kb1.useMcpServer).toBe('company-policy')
    expect(kb1.mcpServer).toBeUndefined()

    // defaults — same apiKeyPrompt shape as the bundle
    expect(t.apiKeyPrompt).toEqual({
      provider: 'openai-compatible',
      baseURL: 'https://api.deepseek.com/v1',
      label: 'DeepSeek',
    })
  })

  it('re-serializes each workflow into a parseable aipehub.workflow/v1 yaml', () => {
    const t = parseTemplate(FULL)
    const wf = t.workflows[0]!
    const doc = parseYaml(wf.yaml) as { schema?: string; workflow?: Record<string, unknown> }
    expect(doc.schema).toBe('aipehub.workflow/v1')
    expect(doc.workflow?.id).toBe('ticket-flow')
    // the whole block round-trips verbatim — steps survive untouched
    expect(Array.isArray(doc.workflow?.steps)).toBe(true)
  })

  it('parses the equivalent JSON template', () => {
    const json = JSON.stringify({
      schema: 'aipehub.template/v1',
      template: {
        name: 'json-template',
        knowledgeBases: [{ name: 'kb', useMcpServer: 'some-mcp' }],
      },
    })
    const t = parseTemplate(json)
    expect(t.name).toBe('json-template')
    expect(t.version).toBe(1) // default
    expect(t.knowledgeBases[0]!.useMcpServer).toBe('some-mcp')
  })

  it('allows a template with only one section (agents / workflows / KB each alone)', () => {
    const agentsOnly = parseTemplate(
      tmpl({ agents: [llmAgent('a1')] }),
    )
    expect(agentsOnly.agents).toHaveLength(1)
    expect(agentsOnly.workflows).toEqual([])
    expect(agentsOnly.knowledgeBases).toEqual([])

    const kbOnly = parseTemplate(tmpl({ knowledgeBases: [{ name: 'k', useMcpServer: 'm' }] }))
    expect(kbOnly.knowledgeBases).toHaveLength(1)
    expect(kbOnly.agents).toEqual([])
  })

  it('defaults version to 1 and rejects a bad version', () => {
    expect(parseTemplate(tmpl({ knowledgeBases: [{ name: 'k', useMcpServer: 'm' }] })).version).toBe(1)
    expect(() => parseTemplate(tmpl({ version: 0, knowledgeBases: [{ name: 'k', useMcpServer: 'm' }] })))
      .toThrow(/version must be a positive integer/)
    expect(() => parseTemplate(tmpl({ version: 1.5, knowledgeBases: [{ name: 'k', useMcpServer: 'm' }] })))
      .toThrow(ManifestError)
  })

  it('rejects a wrong / missing schema', () => {
    expect(() => parseTemplate('schema: aipehub.bundle/v1\nbundle: {}')).toThrow(/schema must be/)
    expect(() => parseTemplate('template:\n  name: x')).toThrow(ManifestError)
  })

  it('rejects a missing template object / missing name', () => {
    expect(() => parseTemplate('schema: aipehub.template/v1')).toThrow(/template.template is required/)
    expect(() => parseTemplate('schema: aipehub.template/v1\ntemplate: {}')).toThrow(/name is required/)
  })

  it('rejects an entirely empty template (no agents / workflows / KBs)', () => {
    expect(() => parseTemplate(tmpl({}))).toThrow(/at least one of agents/)
  })

  it('delegates agent validation to parseManifest (bad provider bubbles up)', () => {
    const bad = tmpl({ agents: [{ id: 'a1', capabilities: ['x'], provider: 'martian', system: 'hi' }] })
    expect(() => parseTemplate(bad)).toThrow(/provider must be/)
  })

  it('rejects a duplicate workflow id', () => {
    const dup = tmpl({
      workflows: [
        { id: 'w', trigger: { capability: 'c' }, steps: [] },
        { id: 'w', trigger: { capability: 'c' }, steps: [] },
      ],
    })
    expect(() => parseTemplate(dup)).toThrow(/duplicate workflow id 'w'/)
  })

  it('requires a workflow id', () => {
    const noId = tmpl({ workflows: [{ trigger: { capability: 'c' }, steps: [] }] })
    expect(() => parseTemplate(noId)).toThrow(/workflows\[0\].id is required/)
  })

  describe('knowledge base wiring', () => {
    it('requires a name matching KB_NAME_RE and rejects duplicates', () => {
      expect(() => parseTemplate(tmpl({ knowledgeBases: [{ useMcpServer: 'm' }] })))
        .toThrow(/name is required/)
      expect(() => parseTemplate(tmpl({ knowledgeBases: [{ name: '1bad', useMcpServer: 'm' }] })))
        .toThrow(/name must match/)
      expect(() =>
        parseTemplate(
          tmpl({ knowledgeBases: [{ name: 'k', useMcpServer: 'm' }, { name: 'k', useMcpServer: 'n' }] }),
        ),
      ).toThrow(/duplicate knowledgeBase name 'k'/)
    })

    it('requires exactly one wiring form', () => {
      // neither
      expect(() => parseTemplate(tmpl({ knowledgeBases: [{ name: 'k' }] })))
        .toThrow(/must declare its wiring/)
      // both
      expect(() =>
        parseTemplate(
          tmpl({
            knowledgeBases: [
              { name: 'k', useMcpServer: 'm', mcpServer: { name: 'k', command: 'x' } },
            ],
          }),
        ),
      ).toThrow(/exactly one of 'mcpServer' or 'useMcpServer'/)
    })

    it('validates the inline mcpServer via the shared MCP validator', () => {
      // missing command on a stdio server → the reused validator complains
      expect(() =>
        parseTemplate(tmpl({ knowledgeBases: [{ name: 'k', mcpServer: { name: 'k' } }] })),
      ).toThrow(/command is required/)
      // a valid http transport server round-trips
      const t = parseTemplate(
        tmpl({
          knowledgeBases: [
            { name: 'k', mcpServer: { name: 'k', transport: 'http', url: 'https://kb.example/mcp' } },
          ],
        }),
      )
      expect(t.knowledgeBases[0]!.mcpServer).toMatchObject({
        transport: 'http',
        url: 'https://kb.example/mcp',
      })
    })

    it('validates the presetData pointer (kind url/artifact, ref required) — never content', () => {
      expect(() =>
        parseTemplate(
          tmpl({ knowledgeBases: [{ name: 'k', useMcpServer: 'm', presetData: { kind: 'inline', ref: 'x' } }] }),
        ),
      ).toThrow(/kind must be 'url' or 'artifact'/)
      expect(() =>
        parseTemplate(tmpl({ knowledgeBases: [{ name: 'k', useMcpServer: 'm', presetData: { kind: 'url' } }] })),
      ).toThrow(/ref is required/)
      const t = parseTemplate(
        tmpl({ knowledgeBases: [{ name: 'k', useMcpServer: 'm', presetData: { kind: 'artifact', ref: 'uploads/2026/x.tar' } }] }),
      )
      expect(t.knowledgeBases[0]!.presetData).toEqual({ kind: 'artifact', ref: 'uploads/2026/x.tar' })
    })
  })

  it('rejects malformed YAML / JSON with a friendly message', () => {
    expect(() => parseTemplate('{ not json')).toThrow(/not valid JSON/)
    expect(() => parseTemplate('   ')).toThrow(/template is empty/)
  })
})

/**
 * renderTemplate is the inverse of parseTemplate — it turns selected hub
 * structure into an aipehub.template/v1 object. Its job is the structure-safe
 * DEFAULT export (decision #5): structure + wiring + references, and by
 * construction NO personnel, NO knowledge content, NO literal secrets.
 */
describe('renderTemplate (B-M2 structure export)', () => {
  function agentRec(over: Partial<TemplateAgentInput> = {}): TemplateAgentInput {
    return {
      id: 'support-agent',
      allowedCapabilities: ['answer-ticket'],
      managed: { kind: 'llm', provider: 'openai-compatible', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', system: '你是客服。' },
      ...over,
    }
  }

  it('renders agents + workflows + KBs and round-trips through parseTemplate', () => {
    const out = renderTemplate({
      name: '客服模板',
      description: '导出的结构',
      version: 3,
      agents: [agentRec()],
      workflows: [{ id: 'ticket-flow', workflow: { id: 'ticket-flow', trigger: { capability: 'answer-ticket' }, steps: [{ id: 's', dispatch: { strategy: { kind: 'capability', capabilities: ['answer-ticket'] }, payload: {} } }] } }],
      knowledgeBases: [{ name: 'kb', useMcpServer: 'company-kb' }],
      apiKeyPrompt: { provider: 'openai-compatible', baseURL: 'https://api.deepseek.com/v1', label: 'DeepSeek' },
    })
    expect(out.schema).toBe(TEMPLATE_SCHEMA_V1)
    // The whole rendered object must parse back cleanly (the route relies on this).
    const t = parseTemplate(JSON.stringify(out))
    expect(t.name).toBe('客服模板')
    expect(t.version).toBe(3)
    expect(t.agents.map((a) => a.id)).toEqual(['support-agent'])
    expect(t.workflows.map((w) => w.id)).toEqual(['ticket-flow'])
    expect(t.knowledgeBases[0]!.useMcpServer).toBe('company-kb')
    expect(t.apiKeyPrompt?.label).toBe('DeepSeek')
  })

  it('defaults version to 1 and omits empty sections', () => {
    const out = renderTemplate({ name: 'agents-only', agents: [agentRec()] })
    const template = out.template as Record<string, unknown>
    expect(template.version).toBe(1)
    expect(template.workflows).toBeUndefined()
    expect(template.knowledgeBases).toBeUndefined()
    expect(template.defaults).toBeUndefined()
  })

  it('NEVER leaks personnel — owner / grant fields never appear in the output', () => {
    // Even if the input record carries extra fields, only agent config is rendered.
    const polluted = { ...agentRec(), ownerUserId: 'user-alice', grants: [{ who: 'bob' }] } as unknown as TemplateAgentInput
    const out = renderTemplate({ name: 't', agents: [polluted] })
    const json = JSON.stringify(out)
    expect(json).not.toContain('ownerUserId')
    expect(json).not.toContain('user-alice')
    expect(json).not.toContain('grants')
  })

  it('skips externally-connected agents (no managed spec to export)', () => {
    const external: TemplateAgentInput = { id: 'remote', allowedCapabilities: ['x'] } // no managed
    const out = renderTemplate({ name: 't', agents: [external], knowledgeBases: [{ name: 'k', useMcpServer: 'm' }] })
    expect((out.template as Record<string, unknown>).agents).toBeUndefined()
  })

  it('placeholder-izes literal MCP secrets (env + headers) so none leak', () => {
    const withSecrets = agentRec({
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'hi',
        mcpServers: [
          { name: 'kb', command: 'npx', env: { CHROMA_TOKEN: 'sk-LITERAL-secret', SAFE: '${ALREADY_PLACEHOLDER}' } },
          { name: 'api', transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer real-token' } },
        ],
      },
    })
    const out = renderTemplate({ name: 't', agents: [withSecrets] })
    const json = JSON.stringify(out)
    expect(json).not.toContain('sk-LITERAL-secret')
    expect(json).not.toContain('real-token')
    // The literal was replaced with a placeholder named after the key; the
    // pre-existing placeholder is preserved verbatim.
    expect(json).toContain('${CHROMA_TOKEN}')
    expect(json).toContain('${ALREADY_PLACEHOLDER}')
    expect(json).toContain('${AUTHORIZATION}')
  })

  it('a bad operator-supplied KB makes the rendered template fail the parse gate', () => {
    const out = renderTemplate({ name: 't', knowledgeBases: [{ name: 'bad-kb-no-wiring' }] })
    // The renderer is permissive; the route's parseTemplate gate is the validator.
    expect(() => parseTemplate(JSON.stringify(out))).toThrow(/must declare its wiring/)
  })
})

// ── helpers ──────────────────────────────────────────────────────────────

/** Build a `template:` document around an arbitrary inner object (JSON form). */
function tmpl(inner: Record<string, unknown>): string {
  return JSON.stringify({
    schema: 'aipehub.template/v1',
    template: { name: 'test-template', ...inner },
  })
}

function llmAgent(id: string): Record<string, unknown> {
  return { id, capabilities: ['chat'], kind: 'llm', provider: 'mock', system: 'hi' }
}
