import { describe, expect, it } from 'vitest'

import {
  AGENT_SCHEMA_V1,
  ManifestError,
  TEAM_SCHEMA_V1,
  parseManifest,
  renderAgentManifest,
} from '../src/manifest.js'

/**
 * Manifest parser covers the contract the public template library
 * relies on. The parser is the single trust boundary between
 * "untrusted YAML from the internet" and the supervisor — every reject
 * needs a clear, human-friendly message so the admin UI can show it.
 */
describe('parseManifest (aipehub.agent/v1)', () => {
  it('parses a minimal agent manifest from YAML', () => {
    const yaml = `
schema: aipehub.agent/v1
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
      schema: 'aipehub.agent/v1',
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
schema: aipehub.agent/v1
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
schema: aipehub.agent/v1
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

describe('parseManifest (aipehub.team/v1)', () => {
  it('parses a team with multiple agents', () => {
    const yaml = `
schema: aipehub.team/v1
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
schema: aipehub.team/v1
team:
  agents:
    - { id: w, capabilities: [a], provider: mock, system: x }
    - { id: w, capabilities: [b], provider: mock, system: y }
`
    expect(() => parseManifest(yaml)).toThrow(/duplicate agent id 'w'/)
  })

  it('rejects empty team.agents', () => {
    const yaml = `
schema: aipehub.team/v1
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
    expect(() => parseManifest('schema: aipehub.future/v9')).toThrow(/unknown schema/)
  })

  it('rejects unsafe id characters', () => {
    const yaml = `
schema: aipehub.agent/v1
agent: { id: "writer/../etc/passwd", capabilities: [x], provider: mock, system: hi }
`
    expect(() => parseManifest(yaml)).toThrow(/only contain letters, digits/)
  })

  it('rejects empty capabilities array', () => {
    const yaml = `
schema: aipehub.agent/v1
agent: { id: w, capabilities: "draft", provider: mock, system: hi }
`
    expect(() => parseManifest(yaml)).toThrow(/capabilities must be an array/)
  })

  it('rejects unknown provider', () => {
    const yaml = `
schema: aipehub.agent/v1
agent: { id: w, capabilities: [x], provider: bedrock, system: hi }
`
    expect(() => parseManifest(yaml)).toThrow(/provider must be/)
  })

  it('rejects missing system prompt', () => {
    const yaml = `
schema: aipehub.agent/v1
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
