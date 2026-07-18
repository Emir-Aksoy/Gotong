import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import {
  AGENT_SCHEMA_V1,
  ManifestError,
  TEAM_SCHEMA_V1,
  parseBundle,
  parseManifest,
  renderAgentManifest,
} from '../src/manifest.js'

/**
 * Manifest parser covers the contract the public template library
 * relies on. The parser is the single trust boundary between
 * "untrusted YAML from the internet" and the supervisor — every reject
 * needs a clear, human-friendly message so the admin UI can show it.
 */
describe('parseManifest (gotong.agent/v1)', () => {
  it('parses a minimal agent manifest from YAML', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: writer
  capabilities: [draft]
  kind: llm
  provider: anthropic
  model: claude-opus-4-7
  system: |
    You are a writer.
`
    const m = parseManifest(yaml)
    expect(m.schema).toBe(AGENT_SCHEMA_V1)
    expect(m.agents).toHaveLength(1)
    const a = m.agents[0]!
    expect(a.id).toBe('writer')
    expect(a.capabilities).toEqual(['draft'])
    expect(a.managed.provider).toBe('anthropic')
    expect(a.managed.model).toBe('claude-opus-4-7')
    expect(a.managed.system).toMatch(/^You are a writer/)
  })

  it('parses the equivalent JSON manifest', () => {
    const json = JSON.stringify({
      schema: 'gotong.agent/v1',
      agent: {
        id: 'writer',
        capabilities: ['draft'],
        kind: 'llm',
        provider: 'anthropic',
        system: 'You write.',
      },
    })
    const m = parseManifest(json)
    expect(m.agents).toHaveLength(1)
    expect(m.agents[0]!.id).toBe('writer')
  })

  it('accepts displayName + weightDefault and round-trips them', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: writer
  displayName: 中文写作助手
  capabilities: [draft]
  kind: llm
  provider: anthropic
  weightDefault: 2.5
  system: hi
`
    const m = parseManifest(yaml)
    expect(m.agents[0]!.displayName).toBe('中文写作助手')
    expect(m.agents[0]!.managed.weightDefault).toBe(2.5)
  })

  it('defaults missing kind to llm (the only supported value today)', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: mock
  system: hi
`
    const m = parseManifest(yaml)
    expect(m.agents[0]!.managed.kind).toBe('llm')
  })
})

describe('parseManifest (gotong.team/v1)', () => {
  it('parses a team with multiple agents', () => {
    const yaml = `
schema: gotong.team/v1
team:
  name: editorial
  description: writer + reviewer
  agents:
    - id: writer
      capabilities: [draft]
      kind: llm
      provider: mock
      system: a
    - id: reviewer
      capabilities: [review]
      kind: llm
      provider: mock
      system: b
`
    const m = parseManifest(yaml)
    expect(m.schema).toBe(TEAM_SCHEMA_V1)
    expect(m.teamName).toBe('editorial')
    expect(m.teamDescription).toBe('writer + reviewer')
    expect(m.agents).toHaveLength(2)
    expect(m.agents.map((a) => a.id)).toEqual(['writer', 'reviewer'])
  })

  it('rejects duplicate ids inside a team', () => {
    const yaml = `
schema: gotong.team/v1
team:
  agents:
    - { id: w, capabilities: [a], provider: mock, system: x }
    - { id: w, capabilities: [b], provider: mock, system: y }
`
    expect(() => parseManifest(yaml)).toThrow(/duplicate agent id 'w'/)
  })

  it('rejects empty team.agents', () => {
    const yaml = `
schema: gotong.team/v1
team:
  agents: []
`
    expect(() => parseManifest(yaml)).toThrow(/non-empty array/)
  })
})

describe('parseManifest — error surface', () => {
  it('throws on empty body', () => {
    expect(() => parseManifest('')).toThrow(ManifestError)
  })

  it('throws when schema is missing', () => {
    expect(() => parseManifest('agent: {id: x}')).toThrow(/missing 'schema'/)
  })

  it('throws on unknown schema', () => {
    expect(() => parseManifest('schema: gotong.future/v9')).toThrow(/unknown schema/)
  })

  it('rejects unsafe id characters', () => {
    const yaml = `
schema: gotong.agent/v1
agent: { id: "writer/../etc/passwd", capabilities: [x], provider: mock, system: hi }
`
    expect(() => parseManifest(yaml)).toThrow(/only contain letters, digits/)
  })

  it('rejects empty capabilities array', () => {
    const yaml = `
schema: gotong.agent/v1
agent: { id: w, capabilities: "draft", provider: mock, system: hi }
`
    expect(() => parseManifest(yaml)).toThrow(/capabilities must be an array/)
  })

  it('rejects unknown provider', () => {
    const yaml = `
schema: gotong.agent/v1
agent: { id: w, capabilities: [x], provider: bedrock, system: hi }
`
    expect(() => parseManifest(yaml)).toThrow(/provider must be/)
  })

  it('rejects missing system prompt', () => {
    const yaml = `
schema: gotong.agent/v1
agent: { id: w, capabilities: [x], provider: mock }
`
    expect(() => parseManifest(yaml)).toThrow(/system is required/)
  })

  it('reports JSON syntax errors plainly', () => {
    expect(() => parseManifest('{ bad json')).toThrow(/not valid JSON/)
  })
})

describe('renderAgentManifest', () => {
  it('round-trips an agent through render + parse', () => {
    const rec = {
      id: 'writer',
      allowedCapabilities: ['draft', 'edit'],
      displayName: 'My Writer',
      managed: {
        kind: 'llm' as const,
        provider: 'anthropic' as const,
        model: 'claude-opus-4-7',
        system: 'be brief',
        weightDefault: 2.0,
      },
    }
    const rendered = renderAgentManifest(rec)
    const m = parseManifest(JSON.stringify(rendered))
    expect(m.agents).toHaveLength(1)
    const a = m.agents[0]!
    expect(a.id).toBe('writer')
    expect(a.displayName).toBe('My Writer')
    expect(a.capabilities).toEqual(['draft', 'edit'])
    expect(a.managed.provider).toBe('anthropic')
    expect(a.managed.model).toBe('claude-opus-4-7')
    expect(a.managed.system).toBe('be brief')
    expect(a.managed.weightDefault).toBe(2.0)
  })

  it('refuses to render an externally-connected agent', () => {
    expect(() =>
      renderAgentManifest({
        id: 'x',
        allowedCapabilities: [],
      }),
    ).toThrow(/no managed spec/)
  })
})

/**
 * `uses:` (Hub Services declarations) — added in PR-7.
 *
 * The parser is plugin-agnostic: it validates only the shape, not the
 * existence of any specific plugin. Plugin resolution happens at agent
 * spawn time, where a missing plugin surfaces as PluginNotFoundError.
 */
describe('parseManifest — uses: (Hub Services)', () => {
  it('parses a minimal uses array', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: mock
  system: hi
  uses:
    - type: memory
      impl: file
      config: { scope: private, kinds: [episodic] }
    - type: artifact
      impl: file
      config: { name: reports }
    - type: datastore
      impl: sqlite
      config: { name: cases }
    - type: datastore
      impl: sqlite
      config: { name: sessions }
`
    const m = parseManifest(yaml)
    const uses = m.agents[0]!.managed.uses
    expect(uses).toHaveLength(4)
    expect(uses![0]).toEqual({
      type: 'memory',
      impl: 'file',
      config: { scope: 'private', kinds: ['episodic'] },
    })
    expect(uses![2]!.type).toBe('datastore')
    expect(uses![3]!.config!.name).toBe('sessions')
  })

  it('an agent without uses parses cleanly and reports undefined', () => {
    const yaml = `
schema: gotong.agent/v1
agent: { id: w, capabilities: [x], provider: mock, system: hi }
`
    const m = parseManifest(yaml)
    expect(m.agents[0]!.managed.uses).toBeUndefined()
  })

  it('rejects uses that is not an array', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: mock
  system: hi
  uses: "memory"
`
    expect(() => parseManifest(yaml)).toThrow(/uses must be an array/)
  })

  it('rejects a uses entry missing type', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: mock
  system: hi
  uses:
    - impl: file
`
    expect(() => parseManifest(yaml)).toThrow(/uses\[0\]\.type is required/)
  })

  it('rejects a uses entry missing impl', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: mock
  system: hi
  uses:
    - type: memory
`
    expect(() => parseManifest(yaml)).toThrow(/uses\[0\]\.impl is required/)
  })

  it('rejects non-object config', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: mock
  system: hi
  uses:
    - type: memory
      impl: file
      config: "not-an-object"
`
    expect(() => parseManifest(yaml)).toThrow(/config must be an object/)
  })

  it('rejects duplicate memory entries (singular type)', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: mock
  system: hi
  uses:
    - type: memory
      impl: file
    - type: memory
      impl: file
`
    expect(() => parseManifest(yaml)).toThrow(/memory:file more than once/)
  })

  it('rejects duplicate artifact entries (singular type)', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: mock
  system: hi
  uses:
    - type: artifact
      impl: file
    - type: artifact
      impl: file
`
    expect(() => parseManifest(yaml)).toThrow(/artifact:file more than once/)
  })

  it('allows repeated datastore entries (each keyed by config.name)', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: mock
  system: hi
  uses:
    - type: datastore
      impl: sqlite
      config: { name: a }
    - type: datastore
      impl: sqlite
      config: { name: b }
`
    const m = parseManifest(yaml)
    expect(m.agents[0]!.managed.uses).toHaveLength(2)
  })

  it('renderAgentManifest round-trips uses byte-for-byte', () => {
    const rec = {
      id: 'coach',
      allowedCapabilities: ['intake'],
      managed: {
        kind: 'llm' as const,
        provider: 'mock' as const,
        system: 'be brief',
        uses: [
          {
            type: 'memory',
            impl: 'file',
            config: { scope: 'private', kinds: ['episodic'] },
          },
          {
            type: 'artifact',
            impl: 'file',
            config: { name: 'reports' },
          },
        ],
      },
    }
    const rendered = renderAgentManifest(rec)
    const parsed = parseManifest(JSON.stringify(rendered))
    expect(parsed.agents[0]!.managed.uses).toEqual(rec.managed.uses)
  })

  it('renderAgentManifest omits uses entirely when not declared', () => {
    const rendered = renderAgentManifest({
      id: 'plain',
      allowedCapabilities: ['x'],
      managed: { kind: 'llm', provider: 'mock', system: 'hi' },
    })
    const a = (rendered.agent as Record<string, unknown>)
    expect(a.uses).toBeUndefined()
  })
})

// MR-M2 — agent manifests can declare an ordered `fallbacks:` chain for
// deterministic model routing / failover. The parser validates shape only;
// the RoutingProvider that consumes them is built at spawn time in
// LocalAgentPool. Absent / empty = today's single-provider behaviour.
describe('parseManifest — fallbacks: (model routing)', () => {
  it('parses an ordered fallback chain across vendors', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: anthropic
  system: hi
  fallbacks:
    - provider: openai
      model: gpt-5
    - provider: openai-compatible
      baseURL: https://api.deepseek.com/v1
      model: deepseek-chat
      providerLabel: DeepSeek
`
    const m = parseManifest(yaml)
    const fb = m.agents[0]!.managed.fallbacks
    expect(fb).toHaveLength(2)
    expect(fb![0]).toEqual({ provider: 'openai', model: 'gpt-5' })
    expect(fb![1]).toEqual({
      provider: 'openai-compatible',
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      providerLabel: 'DeepSeek',
    })
  })

  it('an agent without fallbacks parses cleanly and reports undefined', () => {
    const yaml = `
schema: gotong.agent/v1
agent: { id: w, capabilities: [x], provider: mock, system: hi }
`
    const m = parseManifest(yaml)
    expect(m.agents[0]!.managed.fallbacks).toBeUndefined()
  })

  it('rejects fallbacks that is not an array', () => {
    const yaml = `
schema: gotong.agent/v1
agent: { id: w, capabilities: [x], provider: mock, system: hi, fallbacks: openai }
`
    expect(() => parseManifest(yaml)).toThrow(/fallbacks must be an array/)
  })

  it('rejects a fallback with an unknown provider', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: mock
  system: hi
  fallbacks:
    - provider: gemini
`
    expect(() => parseManifest(yaml)).toThrow(/fallbacks\[0\]\.provider must be/)
  })

  it('rejects an openai-compatible fallback with no baseURL', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: mock
  system: hi
  fallbacks:
    - provider: openai-compatible
      model: llama3
`
    expect(() => parseManifest(yaml)).toThrow(/fallbacks\[0\]\.baseURL is required/)
  })

  it('rejects a baseURL on a non-compatible fallback provider', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: mock
  system: hi
  fallbacks:
    - provider: anthropic
      baseURL: https://nope.example/v1
`
    expect(() => parseManifest(yaml)).toThrow(/baseURL is only valid when provider is/)
  })

  it('rejects a chain longer than the cap', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: mock
  system: hi
  fallbacks:
    - { provider: openai }
    - { provider: openai }
    - { provider: openai }
    - { provider: openai }
    - { provider: openai }
    - { provider: openai }
`
    expect(() => parseManifest(yaml)).toThrow(/at most 5 fallback candidates/)
  })

  it('renderAgentManifest round-trips fallbacks byte-for-byte', () => {
    const rec = {
      id: 'router',
      allowedCapabilities: ['x'],
      managed: {
        kind: 'llm' as const,
        provider: 'anthropic' as const,
        system: 'be brief',
        fallbacks: [
          { provider: 'openai' as const, model: 'gpt-5' },
          {
            provider: 'openai-compatible' as const,
            baseURL: 'https://api.deepseek.com/v1',
            model: 'deepseek-chat',
            providerLabel: 'DeepSeek',
          },
        ],
      },
    }
    const rendered = renderAgentManifest(rec)
    const parsed = parseManifest(JSON.stringify(rendered))
    expect(parsed.agents[0]!.managed.fallbacks).toEqual(rec.managed.fallbacks)
  })

  it('renderAgentManifest omits fallbacks entirely when not declared', () => {
    const rendered = renderAgentManifest({
      id: 'plain',
      allowedCapabilities: ['x'],
      managed: { kind: 'llm', provider: 'mock', system: 'hi' },
    })
    expect((rendered.agent as Record<string, unknown>).fallbacks).toBeUndefined()
  })
})

// NA-M5 — agent manifests can declare a `maintenanceModel:` override so the 6h
// butler maintenance sweep runs on a cheaper model. Same provider / same key —
// only `req.model` changes, and only for background distillation. Absent =
// maintenance uses the provider's default model, byte-identical to today.
describe('parseManifest — maintenanceModel: (NA-M5 maintenance override)', () => {
  it('parses and trims a maintenanceModel string', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: anthropic
  system: hi
  maintenanceModel: '  claude-haiku-4-5  '
`
    const m = parseManifest(yaml)
    expect(m.agents[0]!.managed.maintenanceModel).toBe('claude-haiku-4-5')
  })

  it('an agent without maintenanceModel parses cleanly and reports undefined', () => {
    const yaml = `
schema: gotong.agent/v1
agent: { id: w, capabilities: [x], provider: mock, system: hi }
`
    const m = parseManifest(yaml)
    expect(m.agents[0]!.managed.maintenanceModel).toBeUndefined()
  })

  it('rejects an empty or non-string maintenanceModel', () => {
    for (const bad of ["maintenanceModel: ''", 'maintenanceModel: 42']) {
      const yaml = `
schema: gotong.agent/v1
agent: { id: w, capabilities: [x], provider: mock, system: hi, ${bad} }
`
      expect(() => parseManifest(yaml)).toThrow(/maintenanceModel must be a non-empty string/)
    }
  })

  it('renderAgentManifest round-trips maintenanceModel', () => {
    const rec = {
      id: 'maint',
      allowedCapabilities: ['x'],
      managed: {
        kind: 'llm' as const,
        provider: 'anthropic' as const,
        system: 'be brief',
        maintenanceModel: 'claude-haiku-4-5',
      },
    }
    const rendered = renderAgentManifest(rec)
    const parsed = parseManifest(JSON.stringify(rendered))
    expect(parsed.agents[0]!.managed.maintenanceModel).toBe('claude-haiku-4-5')
  })

  it('renderAgentManifest omits maintenanceModel entirely when not declared', () => {
    const rendered = renderAgentManifest({
      id: 'plain',
      allowedCapabilities: ['x'],
      managed: { kind: 'llm', provider: 'mock', system: 'hi' },
    })
    expect((rendered.agent as Record<string, unknown>).maintenanceModel).toBeUndefined()
  })
})

// DUO-M1 — agent manifests can declare an `escalateTo:` target so the butler's
// escalate tool hands heavy work to a sibling agent. Shape-only at config time
// (the target may be defined later in the same import); ownership is enforced
// at call time against the live roster. Absent = the tool isn't registered,
// byte-identical to today.
describe('parseManifest — escalateTo: (DUO-M1 escalate target)', () => {
  it('parses and trims an escalateTo string', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: anthropic
  system: hi
  escalateTo: '  expert-agent  '
`
    const m = parseManifest(yaml)
    expect(m.agents[0]!.managed.escalateTo).toBe('expert-agent')
  })

  it('an agent without escalateTo parses cleanly and reports undefined', () => {
    const yaml = `
schema: gotong.agent/v1
agent: { id: w, capabilities: [x], provider: mock, system: hi }
`
    const m = parseManifest(yaml)
    expect(m.agents[0]!.managed.escalateTo).toBeUndefined()
  })

  it('rejects an empty or non-string escalateTo', () => {
    for (const bad of ["escalateTo: ''", 'escalateTo: 42']) {
      const yaml = `
schema: gotong.agent/v1
agent: { id: w, capabilities: [x], provider: mock, system: hi, ${bad} }
`
      expect(() => parseManifest(yaml)).toThrow(/escalateTo must be a non-empty string/)
    }
  })

  it('renderAgentManifest round-trips escalateTo', () => {
    const rec = {
      id: 'reception',
      allowedCapabilities: ['x'],
      managed: {
        kind: 'llm' as const,
        provider: 'anthropic' as const,
        system: 'be brief',
        escalateTo: 'expert-agent',
      },
    }
    const rendered = renderAgentManifest(rec)
    const parsed = parseManifest(JSON.stringify(rendered))
    expect(parsed.agents[0]!.managed.escalateTo).toBe('expert-agent')
  })

  it('renderAgentManifest omits escalateTo entirely when not declared', () => {
    const rendered = renderAgentManifest({
      id: 'plain',
      allowedCapabilities: ['x'],
      managed: { kind: 'llm', provider: 'mock', system: 'hi' },
    })
    expect((rendered.agent as Record<string, unknown>).escalateTo).toBeUndefined()
  })
})

// DUO-M4a — `thinking:` is the reasoning-depth switch (LongCat-2.0 official
// `thinking:{type}` body shape, attached by the host only for
// openai-compatible specs). Closed enum: a typo must fail at import time,
// not silently ship a body the vendor ignores.
describe('parseManifest — thinking: (DUO-M4a reasoning switch)', () => {
  it('parses both allowed values', () => {
    for (const v of ['enabled', 'disabled'] as const) {
      const yaml = `
schema: gotong.agent/v1
agent: { id: w, capabilities: [x], provider: openai-compatible, baseURL: 'https://api.longcat.chat/openai/v1', system: hi, thinking: ${v} }
`
      const m = parseManifest(yaml)
      expect(m.agents[0]!.managed.thinking).toBe(v)
    }
  })

  it('an agent without thinking parses cleanly and reports undefined', () => {
    const yaml = `
schema: gotong.agent/v1
agent: { id: w, capabilities: [x], provider: mock, system: hi }
`
    const m = parseManifest(yaml)
    expect(m.agents[0]!.managed.thinking).toBeUndefined()
  })

  it('rejects values outside the closed enum', () => {
    for (const bad of ["thinking: 'off'", 'thinking: true', 'thinking: 42']) {
      const yaml = `
schema: gotong.agent/v1
agent: { id: w, capabilities: [x], provider: mock, system: hi, ${bad} }
`
      expect(() => parseManifest(yaml)).toThrow(/thinking must be 'enabled' or 'disabled'/)
    }
  })

  it('renderAgentManifest round-trips thinking', () => {
    const rec = {
      id: 'reception',
      allowedCapabilities: ['x'],
      managed: {
        kind: 'llm' as const,
        provider: 'openai-compatible' as const,
        baseURL: 'https://api.longcat.chat/openai/v1',
        system: 'be brief',
        thinking: 'disabled' as const,
      },
    }
    const rendered = renderAgentManifest(rec)
    const parsed = parseManifest(JSON.stringify(rendered))
    expect(parsed.agents[0]!.managed.thinking).toBe('disabled')
  })

  it('renderAgentManifest omits thinking entirely when not declared', () => {
    const rendered = renderAgentManifest({
      id: 'plain',
      allowedCapabilities: ['x'],
      managed: { kind: 'llm', provider: 'mock', system: 'hi' },
    })
    expect((rendered.agent as Record<string, unknown>).thinking).toBeUndefined()
  })
})

// MR-M6 — `apiKeyEnv:` names an env VAR whose value is the credential for that
// spec / candidate. The manifest carries the NAME only, never the key itself —
// the validator's shape rule (identifier chars) is what makes pasting a real
// key here fail loudly instead of being committed to disk.
describe('parseManifest — apiKeyEnv: (MR-M6 per-candidate env credentials)', () => {
  it('parses and trims apiKeyEnv on the primary and on a fallback candidate', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: openai-compatible
  baseURL: https://api.longcat.chat/openai/v1
  system: hi
  apiKeyEnv: '  LONGCAT_API_KEY  '
  fallbacks:
    - provider: openai-compatible
      baseURL: https://token-plan-cn.xiaomimimo.com/v1
      model: mimo-v2.5-pro
      apiKeyEnv: MIMO_API_KEY
`
    const m = parseManifest(yaml)
    expect(m.agents[0]!.managed.apiKeyEnv).toBe('LONGCAT_API_KEY')
    expect(m.agents[0]!.managed.fallbacks![0]!.apiKeyEnv).toBe('MIMO_API_KEY')
  })

  it('an agent without apiKeyEnv parses cleanly and reports undefined at both levels', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: mock
  system: hi
  fallbacks:
    - provider: openai
`
    const m = parseManifest(yaml)
    expect(m.agents[0]!.managed.apiKeyEnv).toBeUndefined()
    expect(m.agents[0]!.managed.fallbacks![0]!.apiKeyEnv).toBeUndefined()
  })

  it('rejects a key-shaped value (not an identifier) — the manifest must never hold the key itself', () => {
    for (const bad of ['sk-longcat-abc123', 'has space', '9STARTS_WITH_DIGIT']) {
      const yaml = `
schema: gotong.agent/v1
agent: { id: w, capabilities: [x], provider: mock, system: hi, apiKeyEnv: '${bad}' }
`
      expect(() => parseManifest(yaml)).toThrow(/apiKeyEnv must be an env var NAME/)
    }
  })

  it('rejects an empty or non-string apiKeyEnv', () => {
    for (const bad of ["apiKeyEnv: ''", 'apiKeyEnv: 42']) {
      const yaml = `
schema: gotong.agent/v1
agent: { id: w, capabilities: [x], provider: mock, system: hi, ${bad} }
`
      expect(() => parseManifest(yaml)).toThrow(/apiKeyEnv must be a non-empty string/)
    }
  })

  it('rejects a bad apiKeyEnv on a fallback candidate with the indexed path', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: w
  capabilities: [x]
  provider: mock
  system: hi
  fallbacks:
    - provider: openai
      apiKeyEnv: 'sk-not-a-name'
`
    expect(() => parseManifest(yaml)).toThrow(/fallbacks\[0\]\.apiKeyEnv must be an env var NAME/)
  })

  it('renderAgentManifest round-trips apiKeyEnv at both levels', () => {
    const rec = {
      id: 'router',
      allowedCapabilities: ['x'],
      managed: {
        kind: 'llm' as const,
        provider: 'openai-compatible' as const,
        baseURL: 'https://api.longcat.chat/openai/v1',
        system: 'be brief',
        apiKeyEnv: 'LONGCAT_API_KEY',
        fallbacks: [
          {
            provider: 'openai-compatible' as const,
            baseURL: 'https://token-plan-cn.xiaomimimo.com/v1',
            model: 'mimo-v2.5-pro',
            apiKeyEnv: 'MIMO_API_KEY',
          },
        ],
      },
    }
    const rendered = renderAgentManifest(rec)
    const parsed = parseManifest(JSON.stringify(rendered))
    expect(parsed.agents[0]!.managed.apiKeyEnv).toBe('LONGCAT_API_KEY')
    expect(parsed.agents[0]!.managed.fallbacks).toEqual(rec.managed.fallbacks)
  })

  it('renderAgentManifest omits apiKeyEnv entirely when not declared', () => {
    const rendered = renderAgentManifest({
      id: 'plain',
      allowedCapabilities: ['x'],
      managed: { kind: 'llm', provider: 'mock', system: 'hi' },
    })
    expect((rendered.agent as Record<string, unknown>).apiKeyEnv).toBeUndefined()
  })
})

// v0.3+ — agent manifests can declare third-party MCP servers under
// `mcpServers:`. The parser validates shape (name regex, type
// constraints) at import time; the actual spawn happens later in
// LocalAgentPool.
describe('parseManifest — mcpServers: (third-party MCP tools)', () => {
  function withMcpServers(extra: string): string {
    return `
schema: gotong.agent/v1
agent:
  id: writer
  capabilities: [draft]
  kind: llm
  provider: anthropic
  system: writes things
  mcpServers:${extra}
`.trim()
  }

  it('parses a minimal mcpServers entry (name + command)', () => {
    const parsed = parseManifest(
      withMcpServers(`
    - name: fs
      command: npx
      args: [-y, '@modelcontextprotocol/server-filesystem', './workspace']`),
    )
    expect(parsed.schema).toBe(AGENT_SCHEMA_V1)
    expect(parsed.agents).toHaveLength(1)
    expect(parsed.agents[0]!.managed.mcpServers).toHaveLength(1)
    expect(parsed.agents[0]!.managed.mcpServers![0]).toEqual({
      name: 'fs',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', './workspace'],
    })
  })

  it('parses env + cwd', () => {
    const parsed = parseManifest(
      withMcpServers(`
    - name: github
      command: npx
      args: [-y, '@modelcontextprotocol/server-github']
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: \${GITHUB_TOKEN}
      cwd: /var/work/repo`),
    )
    expect(parsed.agents).toHaveLength(1)
    const s = parsed.agents[0]!.managed.mcpServers![0]!
    expect(s.env).toEqual({
      GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}',
    })
    expect(s.cwd).toBe('/var/work/repo')
  })

  it('parses multiple servers in order', () => {
    const parsed = parseManifest(
      withMcpServers(`
    - { name: fs,     command: npx, args: [-y, '@modelcontextprotocol/server-filesystem', './work'] }
    - { name: github, command: npx, args: [-y, '@modelcontextprotocol/server-github'] }
    - { name: slack,  command: npx, args: [-y, '@modelcontextprotocol/server-slack'] }`),
    )
    expect(parsed.agents).toHaveLength(1)
    expect(parsed.agents[0]!.managed.mcpServers!.map((s) => s.name)).toEqual([
      'fs',
      'github',
      'slack',
    ])
  })

  it('rejects an mcpServers entry without name', () => {
    expect(() =>
      parseManifest(
        withMcpServers(`
    - command: npx`),
      ),
    ).toThrow(ManifestError)
  })

  it('rejects an mcpServers entry without command', () => {
    expect(() =>
      parseManifest(
        withMcpServers(`
    - name: fs`),
      ),
    ).toThrow(ManifestError)
  })

  it('rejects a duplicate server name within the same agent', () => {
    expect(() =>
      parseManifest(
        withMcpServers(`
    - { name: fs, command: npx }
    - { name: fs, command: npx }`),
      ),
    ).toThrowError(/duplicates/)
  })

  it('rejects an invalid name (starts with digit, has dot, has space)', () => {
    for (const bad of ['1fs', 'fs.io', 'has space']) {
      expect(() =>
        parseManifest(
          withMcpServers(`
    - { name: '${bad}', command: npx }`),
        ),
      ).toThrowError(/must match/)
    }
  })

  it('rejects non-string args entries', () => {
    expect(() =>
      parseManifest(
        withMcpServers(`
    - name: fs
      command: npx
      args: [42, 'ok']`),
      ),
    ).toThrowError(/must be a string/)
  })

  it('rejects non-string env values', () => {
    expect(() =>
      parseManifest(
        withMcpServers(`
    - name: github
      command: npx
      env:
        TOKEN: 12345`),
      ),
    ).toThrowError(/must be a string/)
  })

  // --- R4: remote transports (http / sse) ----------------------------------

  it('parses an http server (transport + url + headers)', () => {
    const parsed = parseManifest(
      withMcpServers(`
    - name: hosted
      transport: http
      url: https://mcp.example.com/v1
      headers:
        Authorization: Bearer \${MCP_PAT}`),
    )
    expect(parsed.agents[0]!.managed.mcpServers![0]).toEqual({
      name: 'hosted',
      transport: 'http',
      url: 'https://mcp.example.com/v1',
      headers: { Authorization: 'Bearer ${MCP_PAT}' },
    })
  })

  it('parses an sse server (no headers)', () => {
    const parsed = parseManifest(
      withMcpServers(`
    - name: legacy
      transport: sse
      url: https://sse.example.com/stream`),
    )
    expect(parsed.agents[0]!.managed.mcpServers![0]).toEqual({
      name: 'legacy',
      transport: 'sse',
      url: 'https://sse.example.com/stream',
    })
  })

  it('omitting transport defaults to a stdio spec (no transport key emitted)', () => {
    const parsed = parseManifest(
      withMcpServers(`
    - { name: fs, command: npx }`),
    )
    const s = parsed.agents[0]!.managed.mcpServers![0]!
    expect(s).toEqual({ name: 'fs', command: 'npx' })
    expect('transport' in s).toBe(false)
  })

  it('rejects an http server without url', () => {
    expect(() =>
      parseManifest(
        withMcpServers(`
    - { name: hosted, transport: http }`),
      ),
    ).toThrowError(/url is required/)
  })

  it('rejects an unknown transport value', () => {
    expect(() =>
      parseManifest(
        withMcpServers(`
    - { name: x, transport: carrier-pigeon, url: https://x }`),
      ),
    ).toThrowError(/transport must be one of/)
  })

  it('rejects non-string header values', () => {
    expect(() =>
      parseManifest(
        withMcpServers(`
    - name: hosted
      transport: http
      url: https://x
      headers:
        X-Count: 42`),
      ),
    ).toThrowError(/must be a string/)
  })

  it('renderAgentManifest round-trips mcpServers', () => {
    const yaml = withMcpServers(`
    - name: fs
      command: npx
      args: [-y, '@modelcontextprotocol/server-filesystem', './workspace']
      env:
        FOO: bar
      cwd: /tmp/work`)
    const parsed = parseManifest(yaml)
    expect(parsed.agents).toHaveLength(1)
    const rendered = renderAgentManifest({
      id: parsed.agents[0]!.id,
      allowedCapabilities: parsed.agents[0]!.capabilities,
      managed: parsed.agents[0]!.managed,
    })
    const reparsed = parseManifest(JSON.stringify(rendered))
    expect(reparsed.agents).toHaveLength(1)
    expect(reparsed.agents[0]!.managed.mcpServers).toEqual(
      parsed.agents[0]!.managed.mcpServers,
    )
  })

  it('renderAgentManifest round-trips a mixed stdio + http + sse fleet', () => {
    const yaml = withMcpServers(`
    - { name: fs, command: npx, args: [-y, server-fs] }
    - name: hosted
      transport: http
      url: https://mcp.example.com/v1
      headers:
        Authorization: Bearer \${MCP_PAT}
    - { name: legacy, transport: sse, url: https://sse.example.com/stream }`)
    const parsed = parseManifest(yaml)
    const rendered = renderAgentManifest({
      id: parsed.agents[0]!.id,
      allowedCapabilities: parsed.agents[0]!.capabilities,
      managed: parsed.agents[0]!.managed,
    })
    const reparsed = parseManifest(JSON.stringify(rendered))
    expect(reparsed.agents[0]!.managed.mcpServers).toEqual(
      parsed.agents[0]!.managed.mcpServers,
    )
  })

  // --- M1: useMcpServers (hub-registry opt-in) ------------------------------

  it('parses useMcpServers as a list of registry names', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: writer
  capabilities: [draft]
  kind: llm
  provider: anthropic
  system: hi
  useMcpServers: [shared-fs, team-github]
`.trim()
    const parsed = parseManifest(yaml)
    expect(parsed.agents[0]!.managed.useMcpServers).toEqual(['shared-fs', 'team-github'])
  })

  it('rejects a useMcpServers entry with a bad name', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: writer
  capabilities: [draft]
  kind: llm
  provider: anthropic
  system: hi
  useMcpServers: ['has space']
`.trim()
    expect(() => parseManifest(yaml)).toThrowError(/must match/)
  })

  it('accepts a cross-hub <peer>:<server> ref (#2-M3)', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: writer
  capabilities: [draft]
  kind: llm
  provider: anthropic
  system: hi
  useMcpServers: ['shared-fs', 'hub_a1b2c3d4:filesystem']
`.trim()
    const parsed = parseManifest(yaml)
    expect(parsed.agents[0]!.managed.useMcpServers).toEqual([
      'shared-fs',
      'hub_a1b2c3d4:filesystem',
    ])
  })

  it('rejects a cross-hub ref whose server segment is malformed (#2-M3)', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: writer
  capabilities: [draft]
  kind: llm
  provider: anthropic
  system: hi
  useMcpServers: ['hub_x:has space']
`.trim()
    expect(() => parseManifest(yaml)).toThrowError(/must match/)
  })

  it('renderAgentManifest round-trips useMcpServers', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: writer
  capabilities: [draft]
  kind: llm
  provider: anthropic
  system: hi
  useMcpServers: [shared-fs]
  mcpServers:
    - { name: local, command: npx }
`.trim()
    const parsed = parseManifest(yaml)
    const rendered = renderAgentManifest({
      id: parsed.agents[0]!.id,
      allowedCapabilities: parsed.agents[0]!.capabilities,
      managed: parsed.agents[0]!.managed,
    })
    const reparsed = parseManifest(JSON.stringify(rendered))
    expect(reparsed.agents[0]!.managed.useMcpServers).toEqual(['shared-fs'])
    expect(reparsed.agents[0]!.managed.mcpServers).toEqual(
      parsed.agents[0]!.managed.mcpServers,
    )
  })

  it('renderAgentManifest round-trips a heartbeat block (v5 D-M4)', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: watcher
  capabilities: [watch]
  kind: llm
  provider: mock
  system: hi
  heartbeat:
    enabled: true
    intervalMs: 1800000
    checklist: check the inbox
`.trim()
    const parsed = parseManifest(yaml)
    expect(parsed.agents[0]!.managed.heartbeat).toEqual({
      enabled: true,
      intervalMs: 1_800_000,
      checklist: 'check the inbox',
    })
    const rendered = renderAgentManifest({
      id: parsed.agents[0]!.id,
      allowedCapabilities: parsed.agents[0]!.capabilities,
      managed: parsed.agents[0]!.managed,
    })
    const reparsed = parseManifest(JSON.stringify(rendered))
    expect(reparsed.agents[0]!.managed.heartbeat).toEqual(parsed.agents[0]!.managed.heartbeat)
  })

  it('rejects a heartbeat with a non-positive intervalMs', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: bad
  capabilities: [x]
  provider: mock
  system: hi
  heartbeat: { enabled: true, intervalMs: 0 }
`.trim()
    expect(() => parseManifest(yaml)).toThrow(/intervalMs must be a positive number/)
  })

  it('absent mcpServers (the common case) yields undefined, not []', () => {
    const yaml = `
schema: gotong.agent/v1
agent:
  id: writer
  capabilities: [draft]
  kind: llm
  provider: anthropic
  system: hi
`.trim()
    const parsed = parseManifest(yaml)
    expect(parsed.agents).toHaveLength(1)
    expect(parsed.agents[0]!.managed.mcpServers).toBeUndefined()
  })
})

/**
 * The repo ships standard YAML templates under /templates. Smoke them
 * through the parser so a typo in a template trips CI rather than
 * surprising an end-user at import time.
 */
describe('repo templates parse cleanly', async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')

  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = join(here, '..', '..', '..')

  // Walk all known template trees: the initial reference set under
  // templates/{agents,teams}/, the community-adapted set under
  // templates/community/{agents,teams}/, and any future <subset>/{agents,teams}/
  // sibling — so PRs that add a new tree automatically get coverage.
  const trees = [
    join(repoRoot, 'templates'),
    join(repoRoot, 'templates', 'community'),
  ]

  for (const root of trees) {
    for (const sub of ['agents', 'teams']) {
      const dir = join(root, sub)
      let files: string[] = []
      try { files = await readdir(dir) } catch { /* dir may not exist in some checkouts */ }
      for (const f of files) {
        if (!f.endsWith('.yaml') && !f.endsWith('.yml') && !f.endsWith('.json')) continue
        const rel = dir.slice(repoRoot.length + 1) + '/' + f
        it(rel, async () => {
          const raw = await readFile(join(dir, f), 'utf8')
          const m = parseManifest(raw)
          expect(m.agents.length).toBeGreaterThan(0)
          for (const a of m.agents) {
            expect(a.id.length).toBeGreaterThan(0)
            expect(a.capabilities.length).toBeGreaterThan(0)
            expect(a.managed.system.length).toBeGreaterThan(0)
          }
        })
      }
    }
  }
})

/**
 * The personal-growth bundle is the artifact admins actually import to
 * get the 7-coach team + workflow. Phase 14 added a member-facing
 * surface.me to the workflow; this confirms the bundle pipeline
 * (generator → parseBundle re-wrap) preserves it, so the imported
 * workflow lands member-facing. Also the repo's first builtin-bundle
 * smoke test — guards against a future generator regression.
 */
describe('builtin personal-growth bundle round-trips surface.me (Phase 14)', async () => {
  const { readFile } = await import('node:fs/promises')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = dirname(fileURLToPath(import.meta.url))
  const bundleFile = join(here, '..', 'static', 'builtin-bundles', 'personal-growth.yaml')

  it('parseBundle preserves the workflow surface.me through the re-wrap', async () => {
    const parsed = parseBundle(await readFile(bundleFile, 'utf8'))
    expect(parsed.workflowYaml).toBeDefined()
    // workflowYaml is the re-wrapped (JSON-serialized) workflow the importer
    // feeds to parseWorkflow — keys stay snake_case as authored.
    const wfDoc = parseYaml(parsed.workflowYaml!) as {
      workflow?: {
        surface?: {
          me?: { enabled?: boolean; user_scope_field?: string; input_schema?: Array<{ id?: string }> }
        }
      }
    }
    const me = wfDoc.workflow?.surface?.me
    expect(me?.enabled).toBe(true)
    expect(me?.user_scope_field).toBe('case_id')
    const ids = (me?.input_schema ?? []).map((f) => f.id)
    expect(ids).toEqual(['present_state', 'aspirations', 'struggles', 'focus_request'])
  })
})
