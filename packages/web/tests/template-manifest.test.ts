import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import type { ManagedAgentSpec } from '@gotong/core'

import { ManifestError } from '../src/manifest.js'
import { encryptJson } from '../src/template-crypto.js'
import {
  TEMPLATE_SCHEMA_V1,
  injectAgentSecrets,
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
schema: gotong.template/v1
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

describe('parseTemplate (gotong.template/v1)', () => {
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

  it('re-serializes each workflow into a parseable gotong.workflow/v1 yaml', () => {
    const t = parseTemplate(FULL)
    const wf = t.workflows[0]!
    const doc = parseYaml(wf.yaml) as { schema?: string; workflow?: Record<string, unknown> }
    expect(doc.schema).toBe('gotong.workflow/v1')
    expect(doc.workflow?.id).toBe('ticket-flow')
    // the whole block round-trips verbatim — steps survive untouched
    expect(Array.isArray(doc.workflow?.steps)).toBe(true)
  })

  it('parses the equivalent JSON template', () => {
    const json = JSON.stringify({
      schema: 'gotong.template/v1',
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
    expect(() => parseTemplate('schema: gotong.bundle/v1\nbundle: {}')).toThrow(/schema must be/)
    expect(() => parseTemplate('template:\n  name: x')).toThrow(ManifestError)
  })

  it('rejects a missing template object / missing name', () => {
    expect(() => parseTemplate('schema: gotong.template/v1')).toThrow(/template.template is required/)
    expect(() => parseTemplate('schema: gotong.template/v1\ntemplate: {}')).toThrow(/name is required/)
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
 * structure into an gotong.template/v1 object. Its `template` is the
 * structure-safe DEFAULT export (decision #5): structure + wiring + references,
 * and by construction NO personnel, NO knowledge content, NO literal secrets.
 * Any scrubbed literal secrets are returned *separately* as `secrets` (the B-M3
 * sidecar input) and never appear in `template`.
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
    const { template: out } = renderTemplate({
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
    const { template: out } = renderTemplate({ name: 'agents-only', agents: [agentRec()] })
    const template = out.template as Record<string, unknown>
    expect(template.version).toBe(1)
    expect(template.workflows).toBeUndefined()
    expect(template.knowledgeBases).toBeUndefined()
    expect(template.defaults).toBeUndefined()
  })

  it('NEVER leaks personnel — owner / grant fields never appear in the output', () => {
    // Even if the input record carries extra fields, only agent config is rendered.
    const polluted = { ...agentRec(), ownerUserId: 'user-alice', grants: [{ who: 'bob' }] } as unknown as TemplateAgentInput
    const { template: out } = renderTemplate({ name: 't', agents: [polluted] })
    const json = JSON.stringify(out)
    expect(json).not.toContain('ownerUserId')
    expect(json).not.toContain('user-alice')
    expect(json).not.toContain('grants')
  })

  it('skips externally-connected agents (no managed spec to export)', () => {
    const external: TemplateAgentInput = { id: 'remote', allowedCapabilities: ['x'] } // no managed
    const { template: out } = renderTemplate({ name: 't', agents: [external], knowledgeBases: [{ name: 'k', useMcpServer: 'm' }] })
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
    const { template: out, secrets } = renderTemplate({ name: 't', agents: [withSecrets] })
    const json = JSON.stringify(out)
    expect(json).not.toContain('sk-LITERAL-secret')
    expect(json).not.toContain('real-token')
    // The literal was replaced with a placeholder named after the key; the
    // pre-existing placeholder is preserved verbatim.
    expect(json).toContain('${CHROMA_TOKEN}')
    expect(json).toContain('${ALREADY_PLACEHOLDER}')
    expect(json).toContain('${AUTHORIZATION}')
    // B-M3 — the scrubbed literals are returned separately (keyed by placeholder)
    // for the encrypted sidecar; an already-placeholder value is NOT captured.
    expect(secrets['${CHROMA_TOKEN}']).toBe('sk-LITERAL-secret')
    expect(secrets['${AUTHORIZATION}']).toBe('Bearer real-token')
    expect(secrets['${SAFE}']).toBeUndefined()
    expect(Object.keys(secrets)).toHaveLength(2)
  })

  it('captures no secrets when every MCP value is already an env placeholder', () => {
    const clean = agentRec({
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'hi',
        mcpServers: [{ name: 'kb', command: 'npx', env: { TOKEN: '${TOKEN}' } }],
      },
    })
    const { secrets } = renderTemplate({ name: 't', agents: [clean] })
    expect(Object.keys(secrets)).toHaveLength(0)
  })

  it('placeholder-izes literal secrets in uses[].config but keeps structural keys (audit M6)', () => {
    const withConfig = agentRec({
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'hi',
        uses: [
          {
            type: 'datastore',
            impl: 'http-kv',
            config: {
              scope: 'private', // structural — must survive verbatim
              maxBytes: 1000, // structural non-string — untouched
              apiKey: 'sk-LITERAL-cfg', // secret — must be scrubbed
              endpoint: 'https://kv.example', // non-secret key — survives
              auth: { token: 'tok-NESTED-secret' }, // nested secret — scrubbed
            },
          },
        ],
      },
    })
    const { template: out, secrets } = renderTemplate({ name: 't', agents: [withConfig] })
    const json = JSON.stringify(out)
    // The literal credentials are gone from the public structure export.
    expect(json).not.toContain('sk-LITERAL-cfg')
    expect(json).not.toContain('tok-NESTED-secret')
    // Structural keys (and the endpoint URL) survive intact.
    expect(json).toContain('private')
    expect(json).toContain('https://kv.example')
    expect(json).toContain('1000')
    // Both literals (top-level + nested) were captured into the sidecar.
    const captured = Object.values(secrets)
    expect(captured).toContain('sk-LITERAL-cfg')
    expect(captured).toContain('tok-NESTED-secret')
  })

  it('does not mutate the input record when scrubbing uses[].config (shared nested object)', () => {
    const sharedConfig = { apiKey: 'sk-DONT-MUTATE', scope: 'private' }
    const rec = agentRec({
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'hi',
        uses: [{ type: 'datastore', impl: 'http-kv', config: sharedConfig }],
      },
    })
    renderTemplate({ name: 't', agents: [rec] })
    // The live record's config literal must be intact — the export builds a
    // fresh scrubbed copy rather than overwriting the shared object.
    expect(sharedConfig.apiKey).toBe('sk-DONT-MUTATE')
  })

  it('uses fresh unique placeholders so two services’ different apiKeys do not collide', () => {
    const rec = agentRec({
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'hi',
        uses: [
          { type: 'datastore', impl: 'a', config: { apiKey: 'sk-AAA' } },
          { type: 'datastore', impl: 'b', config: { apiKey: 'sk-BBB' } },
        ],
      },
    })
    const { secrets } = renderTemplate({ name: 't', agents: [rec] })
    // Distinct placeholders → both literals survive in the sidecar (no last-wins).
    const captured = Object.values(secrets)
    expect(captured).toContain('sk-AAA')
    expect(captured).toContain('sk-BBB')
    expect(Object.keys(secrets)).toHaveLength(2)
  })

  it('two MCP servers’ same-named env secrets don’t collide; round-trip restores each (audit L10)', () => {
    const twoServers = agentRec({
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'hi',
        mcpServers: [
          { name: 'svc-a', command: 'npx', env: { API_KEY: 'literal-A' } },
          { name: 'svc-b', command: 'npx', env: { API_KEY: 'literal-B' } },
        ],
      },
    })
    const { template: out, secrets } = renderTemplate({ name: 't', agents: [twoServers] })

    // Both distinct literals must survive in the sidecar — keying by env-name
    // alone made the second overwrite the first (last-wins).
    expect(Object.values(secrets).sort()).toEqual(['literal-A', 'literal-B'])
    expect(Object.keys(secrets)).toHaveLength(2)
    // Neither literal leaks into the structure export.
    const json = JSON.stringify(out)
    expect(json).not.toContain('literal-A')
    expect(json).not.toContain('literal-B')

    // Full round-trip: each server gets ITS OWN secret back, not the survivor's.
    const reparsed = parseTemplate(json)
    const restored = injectAgentSecrets(reparsed.agents[0]!.managed!, secrets)
    expect(restored.mcpServers?.[0]?.env?.API_KEY).toBe('literal-A')
    expect(restored.mcpServers?.[1]?.env?.API_KEY).toBe('literal-B')
  })

  it('two MCP servers sharing the SAME env literal reuse one placeholder (dedup)', () => {
    const shared = agentRec({
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'hi',
        mcpServers: [
          { name: 'svc-a', command: 'npx', env: { API_KEY: 'same-literal' } },
          { name: 'svc-b', command: 'npx', env: { API_KEY: 'same-literal' } },
        ],
      },
    })
    const { secrets } = renderTemplate({ name: 't', agents: [shared] })
    // Identical value → one entry; no needless `${API_KEY__2}` proliferation.
    expect(Object.keys(secrets)).toEqual(['${API_KEY}'])
    expect(secrets['${API_KEY}']).toBe('same-literal')
  })

  it('a bad operator-supplied KB makes the rendered template fail the parse gate', () => {
    const { template: out } = renderTemplate({ name: 't', knowledgeBases: [{ name: 'bad-kb-no-wiring' }] })
    // The renderer is permissive; the route's parseTemplate gate is the validator.
    expect(() => parseTemplate(JSON.stringify(out))).toThrow(/must declare its wiring/)
  })
})

/**
 * B-M4 — the import half. parseTemplate must carry the B-M3 encrypted sidecar
 * through verbatim (it has no structural meaning, but a malformed blob is a
 * corruption signal), and injectAgentSecrets must put the decrypted literals
 * back where scrubAgentSecrets took them — without mutating the parsed input.
 */
describe('parseTemplate carries the B-M3 encrypted sidecar (B-M4)', () => {
  it('passes a well-formed encrypted blob through untouched', () => {
    const { blob } = encryptJson({ secrets: { '${KB_TOKEN}': 'sk-REAL' } })
    const t = parseTemplate(
      JSON.stringify({
        schema: 'gotong.template/v1',
        template: { name: 't', agents: [llmAgent('a')], encrypted: blob },
      }),
    )
    expect(t.encrypted).toEqual(blob)
  })

  it('a present-but-malformed encrypted block is rejected loudly', () => {
    expect(() =>
      parseTemplate(
        JSON.stringify({
          schema: 'gotong.template/v1',
          template: { name: 't', agents: [llmAgent('a')], encrypted: { algo: 'aes-256-gcm', iv: 'x' } },
        }),
      ),
    ).toThrow(/encrypted is present but malformed/)
  })

  it('no sidecar → encrypted is undefined (the structure-only default)', () => {
    const t = parseTemplate(tmpl({ agents: [llmAgent('a')] }))
    expect(t.encrypted).toBeUndefined()
  })
})

describe('injectAgentSecrets (B-M4 re-injection)', () => {
  function managed(): ManagedAgentSpec {
    return {
      kind: 'llm',
      provider: 'mock',
      system: 'hi',
      mcpServers: [
        { name: 'kb', command: 'npx', env: { KB_TOKEN: '${KB_TOKEN}', OTHER: '${SUPPLIED_BY_IMPORTER}' } },
        { name: 'api', transport: 'http', url: 'https://x/mcp', headers: { Authorization: '${AUTHORIZATION}' } },
      ],
    }
  }

  it('replaces a known placeholder with its real value (env + headers)', () => {
    const out = injectAgentSecrets(managed(), {
      '${KB_TOKEN}': 'sk-REAL',
      '${AUTHORIZATION}': 'Bearer real-token',
    })
    expect(out.mcpServers?.[0]?.env?.KB_TOKEN).toBe('sk-REAL')
    expect(out.mcpServers?.[1]?.headers?.Authorization).toBe('Bearer real-token')
  })

  it('leaves an unknown placeholder untouched (importer supplies it via env)', () => {
    const out = injectAgentSecrets(managed(), { '${KB_TOKEN}': 'sk-REAL' })
    expect(out.mcpServers?.[0]?.env?.OTHER).toBe('${SUPPLIED_BY_IMPORTER}')
  })

  it('deep-copies — the parsed input is never mutated', () => {
    const input = managed()
    const out = injectAgentSecrets(input, { '${KB_TOKEN}': 'sk-REAL' })
    expect(input.mcpServers?.[0]?.env?.KB_TOKEN).toBe('${KB_TOKEN}') // original intact
    expect(out.mcpServers).not.toBe(input.mcpServers) // a fresh array
    expect(out.mcpServers?.[0]).not.toBe(input.mcpServers?.[0]) // fresh server objects
  })

  it('an agent without MCP servers is returned unchanged', () => {
    const bare: ManagedAgentSpec = { kind: 'llm', provider: 'mock', system: 'hi' }
    expect(injectAgentSecrets(bare, { '${X}': 'y' })).toBe(bare)
  })

  it('re-injects known placeholders into uses[].config, incl. nested (audit M6)', () => {
    const m: ManagedAgentSpec = {
      kind: 'llm',
      provider: 'mock',
      system: 'hi',
      uses: [
        {
          type: 'datastore',
          impl: 'http-kv',
          config: {
            scope: 'private',
            apiKey: '${CONFIG_APIKEY_0}',
            auth: { token: '${CONFIG_TOKEN_0}' },
            other: '${SUPPLIED_BY_IMPORTER}',
          },
        },
      ],
    }
    const out = injectAgentSecrets(m, {
      '${CONFIG_APIKEY_0}': 'sk-REAL',
      '${CONFIG_TOKEN_0}': 'tok-REAL',
    })
    const cfg = out.uses![0]!.config as Record<string, unknown>
    expect(cfg.apiKey).toBe('sk-REAL')
    expect((cfg.auth as Record<string, unknown>).token).toBe('tok-REAL')
    expect(cfg.scope).toBe('private') // structural untouched
    expect(cfg.other).toBe('${SUPPLIED_BY_IMPORTER}') // unknown placeholder left
    // The parsed input is never mutated.
    expect((m.uses![0]!.config as Record<string, unknown>).apiKey).toBe('${CONFIG_APIKEY_0}')
  })

  it('round-trips a uses[].config secret: export scrub → parse → inject (audit M6)', () => {
    const { template: out, secrets } = renderTemplate({
      name: 't',
      agents: [
        {
          id: 'svc-agent',
          allowedCapabilities: ['chat'],
          managed: {
            kind: 'llm',
            provider: 'mock',
            system: 'hi',
            uses: [{ type: 'datastore', impl: 'http-kv', config: { scope: 'private', apiKey: 'sk-RT' } }],
          },
        },
      ],
    })
    // The scrubbed structure parses back, then the captured secret re-injects.
    const t = parseTemplate(JSON.stringify(out))
    const restored = injectAgentSecrets(t.agents[0]!.managed!, secrets)
    const cfg = restored.uses![0]!.config as Record<string, unknown>
    expect(cfg.apiKey).toBe('sk-RT')
    expect(cfg.scope).toBe('private')
  })
})

// The additive provenance block is the community citation graph: it carries no
// structural meaning, but a typo'd field must fail loud at import (not silently
// drop a citation edge), and it must round-trip through render → parse so a
// shared template keeps its attribution. These pin both halves down (item 6).
describe('template provenance (citation graph)', () => {
  it('parses author + derivedFrom + notes', () => {
    const t = parseTemplate(
      tmpl({
        agents: [llmAgent('a')],
        provenance: {
          author: 'alice',
          derivedFrom: ['cafe-ops', 'smart-home-hub'],
          notes: 'added a baking-prep workflow',
        },
      }),
    )
    expect(t.provenance).toEqual({
      author: 'alice',
      derivedFrom: ['cafe-ops', 'smart-home-hub'],
      notes: 'added a baking-prep workflow',
    })
  })

  it('is undefined when absent (original / unattributed is the common case)', () => {
    const t = parseTemplate(tmpl({ agents: [llmAgent('a')] }))
    expect(t.provenance).toBeUndefined()
  })

  it('dedupes derivedFrom (first-seen order) and trims entries', () => {
    const t = parseTemplate(
      tmpl({ agents: [llmAgent('a')], provenance: { derivedFrom: ['cafe-ops', ' cafe-ops ', 'warband-club'] } }),
    )
    expect(t.provenance?.derivedFrom).toEqual(['cafe-ops', 'warband-club'])
  })

  it('treats an empty provenance block as absent (no empty {} noise)', () => {
    expect(parseTemplate(tmpl({ agents: [llmAgent('a')], provenance: {} })).provenance).toBeUndefined()
    // A whitespace-only notes / empty derivedFrom collapses to absent too.
    expect(
      parseTemplate(tmpl({ agents: [llmAgent('a')], provenance: { notes: '   ', derivedFrom: [] } })).provenance,
    ).toBeUndefined()
  })

  it('fails loud on a malformed provenance block (typo surfaces at import)', () => {
    const bad = (prov: unknown) => () => parseTemplate(tmpl({ agents: [llmAgent('a')], provenance: prov }))
    expect(bad(['cafe-ops'])).toThrow(ManifestError) // array, not object
    expect(bad({ derivedFrom: 'cafe-ops' })).toThrow(ManifestError) // string, not array
    expect(bad({ derivedFrom: ['cafe-ops', 42] })).toThrow(ManifestError) // non-string entry
    expect(bad({ derivedFrom: ['cafe-ops', ''] })).toThrow(ManifestError) // empty entry
    expect(bad({ author: '' })).toThrow(ManifestError) // empty author
    expect(bad({ author: '   ' })).toThrow(ManifestError) // whitespace author
    expect(bad({ notes: 7 })).toThrow(ManifestError) // non-string notes
  })

  it('round-trips through renderTemplate → parseTemplate', () => {
    const { template: out } = renderTemplate({
      name: 'derived',
      knowledgeBases: [{ name: 'kb', useMcpServer: 'm' }],
      provenance: { author: 'bob', derivedFrom: ['cafe-ops'], notes: 'tweaked' },
    })
    const t = parseTemplate(JSON.stringify(out))
    expect(t.provenance).toEqual({ author: 'bob', derivedFrom: ['cafe-ops'], notes: 'tweaked' })
  })

  it('emits no provenance key for an original template (tidy export)', () => {
    const { template: out } = renderTemplate({ name: 'original', knowledgeBases: [{ name: 'kb', useMcpServer: 'm' }] })
    expect((out.template as Record<string, unknown>).provenance).toBeUndefined()
    // An empty derivedFrom doesn't emit the field either.
    const { template: out2 } = renderTemplate({
      name: 'still-original',
      knowledgeBases: [{ name: 'kb', useMcpServer: 'm' }],
      provenance: { derivedFrom: [] },
    })
    expect((out2.template as Record<string, unknown>).provenance).toBeUndefined()
  })
})

// ── helpers ──────────────────────────────────────────────────────────────

/** Build a `template:` document around an arbitrary inner object (JSON form). */
function tmpl(inner: Record<string, unknown>): string {
  return JSON.stringify({
    schema: 'gotong.template/v1',
    template: { name: 'test-template', ...inner },
  })
}

function llmAgent(id: string): Record<string, unknown> {
  return { id, capabilities: ['chat'], kind: 'llm', provider: 'mock', system: 'hi' }
}

// ── FDE-M1: template.requires — abstract connector slots ────────────────────
// The additive block that turns "要读真实数据自己挂 MCP" prose into a
// machine-checkable declaration. Same trust-boundary posture as the rest of
// the parser: recognized fields validate LOUDLY, absent block costs nothing,
// and an old host ignores the key entirely (graceful degradation).

const slotTemplate = (requires: unknown): string =>
  JSON.stringify({
    schema: TEMPLATE_SCHEMA_V1,
    template: { name: 'slots', workflows: [{ id: 'wf' }], requires },
  })

describe('template.requires — FDE-M1 connector slots', () => {
  it('parses slots; optional defaults false; hint/capability trimmed', () => {
    const t = parseTemplate(
      slotTemplate({
        connectors: [
          { id: 'calendar', kind: 'mcp', optional: true, capability: ' calendar.read ', hint: ' 挂个日历 ' },
          { id: 'notes', kind: 'mcp' },
        ],
      }),
    )
    expect(t.connectorSlots).toEqual([
      { id: 'calendar', kind: 'mcp', optional: true, capability: 'calendar.read', hint: '挂个日历' },
      { id: 'notes', kind: 'mcp', optional: false },
    ])
  })

  it('absent requires → empty slots (old templates unchanged)', () => {
    const t = parseTemplate(
      JSON.stringify({
        schema: TEMPLATE_SCHEMA_V1,
        template: { name: 'plain', workflows: [{ id: 'wf' }] },
      }),
    )
    expect(t.connectorSlots).toEqual([])
  })

  it('rejects a non-mcp kind loudly (no uncheckable green)', () => {
    expect(() => slotsOf([{ id: 'ext', kind: 'a2a' }])).toThrowError(ManifestError)
    expect(() => slotsOf([{ id: 'ext', kind: 'a2a' }])).toThrowError(/kind must be 'mcp'/)
  })

  it('rejects duplicate slot ids', () => {
    expect(() => slotsOf([{ id: 'x', kind: 'mcp' }, { id: 'x', kind: 'mcp' }])).toThrowError(
      /duplicate connector slot id 'x'/,
    )
  })

  it('rejects a slot id that cannot be an MCP server name', () => {
    expect(() => slotsOf([{ id: '日历', kind: 'mcp' }])).toThrowError(/must match/)
    expect(() => slotsOf([{ id: '1st', kind: 'mcp' }])).toThrowError(/must match/)
  })

  it('rejects malformed requires shapes loudly', () => {
    expect(() => parseTemplate(slotTemplate('nope'))).toThrowError(/requires must be an object/)
    expect(() => parseTemplate(slotTemplate({ connectors: 'nope' }))).toThrowError(
      /connectors must be an array/,
    )
    expect(() => slotsOf([{ kind: 'mcp' }])).toThrowError(/id is required/)
    expect(() => slotsOf([{ id: 'x', kind: 'mcp', optional: 'yes' }])).toThrowError(
      /optional must be a boolean/,
    )
  })
})

function slotsOf(connectors: unknown[]): unknown {
  return parseTemplate(slotTemplate({ connectors }))
}

// ── FDE-M2: template.acceptance — golden run cases ──────────────────────────
// Same additive posture as `requires`. Two rules with teeth: workflowId must
// name a workflow SHIPPED IN THIS TEMPLATE (a typo'd id would read as a
// forever-red case blaming the hub), and assert must carry ≥1 real assertion
// (an assertion-free case would always pass and read as "verified").

const acceptTemplate = (acceptance: unknown): string =>
  JSON.stringify({
    schema: TEMPLATE_SCHEMA_V1,
    template: { name: 'accept', workflows: [{ id: 'wf-a' }, { id: 'wf-b' }], acceptance },
  })

const caseOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'smoke',
  workflowId: 'wf-a',
  trigger: { focus: 'x' },
  assert: { contains: ['今日重点'] },
  ...over,
})

describe('template.acceptance — FDE-M2 golden cases', () => {
  it('parses cases; trigger defaults {}; note trimmed; assert entries trimmed', () => {
    const t = parseTemplate(
      acceptTemplate([
        caseOf({ note: ' 诚实模式即合格线 ' }),
        { id: 'no-trigger', workflowId: 'wf-b', assert: { sections: [' 核心判断 '], maxBytes: 4000 } },
      ]),
    )
    expect(t.acceptanceCases).toEqual([
      {
        id: 'smoke',
        workflowId: 'wf-a',
        trigger: { focus: 'x' },
        assert: { contains: ['今日重点'] },
        note: '诚实模式即合格线',
      },
      {
        id: 'no-trigger',
        workflowId: 'wf-b',
        trigger: {},
        assert: { sections: ['核心判断'], maxBytes: 4000 },
      },
    ])
  })

  it('absent acceptance → empty cases (old templates unchanged)', () => {
    const t = parseTemplate(
      JSON.stringify({
        schema: TEMPLATE_SCHEMA_V1,
        template: { name: 'plain', workflows: [{ id: 'wf' }] },
      }),
    )
    expect(t.acceptanceCases).toEqual([])
  })

  it('rejects a workflowId not shipped in this template', () => {
    expect(() => parseTemplate(acceptTemplate([caseOf({ workflowId: 'typo' })]))).toThrowError(
      /does not match any workflow shipped in this template/,
    )
  })

  it('rejects an assertion-free case (it would always pass)', () => {
    expect(() => parseTemplate(acceptTemplate([caseOf({ assert: {} })]))).toThrowError(
      /at least one assertion/,
    )
    expect(() =>
      parseTemplate(acceptTemplate([caseOf({ assert: { contains: [] } })])),
    ).toThrowError(/at least one assertion/)
    expect(() => parseTemplate(acceptTemplate([caseOf({ assert: undefined })]))).toThrowError(
      /assert is required/,
    )
  })

  it('rejects duplicate case ids and malformed shapes loudly', () => {
    expect(() => parseTemplate(acceptTemplate([caseOf(), caseOf()]))).toThrowError(
      /duplicate acceptance case id 'smoke'/,
    )
    expect(() => parseTemplate(acceptTemplate('nope'))).toThrowError(/must be an array/)
    expect(() => parseTemplate(acceptTemplate([caseOf({ trigger: 'nope' })]))).toThrowError(
      /trigger must be an object/,
    )
    expect(() =>
      parseTemplate(acceptTemplate([caseOf({ assert: { contains: [''] } })])),
    ).toThrowError(/non-empty strings/)
    expect(() =>
      parseTemplate(acceptTemplate([caseOf({ assert: { maxBytes: 0 } })])),
    ).toThrowError(/positive integer/)
  })

  it('acceptance alone does not satisfy the empty-template rejection', () => {
    expect(() =>
      parseTemplate(
        JSON.stringify({
          schema: TEMPLATE_SCHEMA_V1,
          template: { name: 'only-tests', acceptance: [] },
        }),
      ),
    ).toThrowError(/at least one of agents \/ workflows \/ knowledgeBases/)
  })
})
