/**
 * Phase 13 M3 — host wiring for the WorkflowAssistantAgent.
 *
 * Tests cover the `createWorkflowAssistAgent` factory + the
 * `WorkflowAssistSurface` it returns:
 *   - returns null when GOTONG_ASSISTANT_DISABLED=1 (via resolveWorkflowAssistConfig)
 *   - returns null when a real provider is configured but no key resolves
 *   - mock provider works without a key (registration succeeds, surface usable)
 *   - surface.assist dispatches to capability=workflow:assist + returns
 *     the agent's typed output (with draftStatus)
 *   - surface.assist throws a clear error when no participant matches
 *     (i.e. when the agent wasn't registered — sanity check)
 *
 * Real Anthropic / OpenAI provider calls are exercised in M5's example
 * (Phase 13). Here we use the mock provider, which is a 3-line stub the
 * factory wires up unconditionally — no network, no key.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLogger, Hub, InMemoryStorage } from '@gotong/core'
import { WORKFLOW_ASSISTANT_CAPABILITY } from '@gotong/workflow-assistant'

import {
  createWorkflowAssistAgent,
  resolveWorkflowAssistConfig,
} from '../src/workflow-assist-agent.js'

const logger = createLogger('wf-assist-test', { disabled: true })

describe('resolveWorkflowAssistConfig', () => {
  const ORIG = { ...process.env }
  beforeEach(() => {
    delete process.env.GOTONG_ASSISTANT_DISABLED
    delete process.env.GOTONG_ASSISTANT_PROVIDER
    delete process.env.GOTONG_ASSISTANT_MODEL
    delete process.env.GOTONG_ASSISTANT_MAX_TOKENS
    delete process.env.GOTONG_ASSISTANT_BASE_URL
    delete process.env.GOTONG_ASSISTANT_API_KEY_ENV
  })
  afterEach(() => {
    // Restore — vitest doesn't isolate process.env between tests.
    process.env = { ...ORIG }
  })

  it('returns null when GOTONG_ASSISTANT_DISABLED=1', () => {
    process.env.GOTONG_ASSISTANT_DISABLED = '1'
    expect(resolveWorkflowAssistConfig()).toBeNull()
  })

  it("returns null when GOTONG_ASSISTANT_DISABLED='true'", () => {
    process.env.GOTONG_ASSISTANT_DISABLED = 'true'
    expect(resolveWorkflowAssistConfig()).toBeNull()
  })

  it('defaults to anthropic when no env vars set', () => {
    expect(resolveWorkflowAssistConfig()).toEqual({ provider: 'anthropic' })
  })

  it('honours provider override', () => {
    process.env.GOTONG_ASSISTANT_PROVIDER = 'openai'
    expect(resolveWorkflowAssistConfig()).toEqual({ provider: 'openai' })
  })

  it('falls back to anthropic on unknown provider name', () => {
    process.env.GOTONG_ASSISTANT_PROVIDER = 'gemini'
    expect(resolveWorkflowAssistConfig()).toEqual({ provider: 'anthropic' })
  })

  it('reads model + maxTokens overrides', () => {
    process.env.GOTONG_ASSISTANT_PROVIDER = 'mock'
    process.env.GOTONG_ASSISTANT_MODEL = 'claude-3-5-sonnet-latest'
    process.env.GOTONG_ASSISTANT_MAX_TOKENS = '8192'
    expect(resolveWorkflowAssistConfig()).toEqual({
      provider: 'mock',
      model: 'claude-3-5-sonnet-latest',
      maxTokens: 8192,
    })
  })

  it('ignores malformed maxTokens', () => {
    process.env.GOTONG_ASSISTANT_MAX_TOKENS = 'lots'
    const cfg = resolveWorkflowAssistConfig()
    expect(cfg).toBeTruthy()
    expect(cfg!.maxTokens).toBeUndefined()
  })

  // S1-M4 — openai-compatible (MiMo / DeepSeek / …) via env.
  it('reads openai-compatible + baseURL + apiKeyEnv (pointer, never the key)', () => {
    process.env.GOTONG_ASSISTANT_PROVIDER = 'openai-compatible'
    process.env.GOTONG_ASSISTANT_BASE_URL = 'https://vendor.example/v1'
    process.env.GOTONG_ASSISTANT_API_KEY_ENV = 'VENDOR_KEY'
    process.env.GOTONG_ASSISTANT_MODEL = 'mimo-v2.5-pro'
    expect(resolveWorkflowAssistConfig()).toEqual({
      provider: 'openai-compatible',
      model: 'mimo-v2.5-pro',
      baseURL: 'https://vendor.example/v1',
      apiKeyEnv: 'VENDOR_KEY',
    })
  })

  it('openai-compatible fields are ignored for other providers', () => {
    process.env.GOTONG_ASSISTANT_PROVIDER = 'openai'
    process.env.GOTONG_ASSISTANT_BASE_URL = 'https://vendor.example/v1'
    process.env.GOTONG_ASSISTANT_API_KEY_ENV = 'VENDOR_KEY'
    expect(resolveWorkflowAssistConfig()).toEqual({ provider: 'openai' })
  })
})

describe('createWorkflowAssistAgent', () => {
  let hub: Hub
  const ORIG = { ...process.env }

  beforeEach(async () => {
    hub = new Hub({ storage: new InMemoryStorage() })
    await hub.start()
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
  })
  afterEach(async () => {
    await hub.stop()
    process.env = { ...ORIG }
  })

  it('returns null when provider=anthropic but no API key available', () => {
    const surface = createWorkflowAssistAgent({
      hub,
      config: { provider: 'anthropic' },
      logger,
    })
    expect(surface).toBeNull()
    // No registration occurred.
    expect(hub.participants().some((p) => p.id === 'workflow-assistant')).toBe(false)
  })

  it('returns null when provider=openai but no API key available', () => {
    const surface = createWorkflowAssistAgent({
      hub,
      config: { provider: 'openai' },
      logger,
    })
    expect(surface).toBeNull()
  })

  it('registers the mock provider without a key', () => {
    const surface = createWorkflowAssistAgent({
      hub,
      config: { provider: 'mock' },
      logger,
    })
    expect(surface).not.toBeNull()
    expect(hub.participants().some((p) => p.id === 'workflow-assistant')).toBe(true)
    const agent = hub.participant('workflow-assistant')
    expect(agent?.capabilities).toContain(WORKFLOW_ASSISTANT_CAPABILITY)
  })

  it('uses ANTHROPIC_API_KEY env when no org-pool entry', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic-fake'
    const surface = createWorkflowAssistAgent({
      hub,
      config: { provider: 'anthropic' },
      logger,
    })
    expect(surface).not.toBeNull()
  })

  // S1-M4 — openai-compatible (MiMo / DeepSeek / …). Registration is offline
  // (the provider client is constructed lazily, no network at boot), so these
  // exercise the real wiring with a fake key in a fake env var.
  describe('openai-compatible (S1-M4)', () => {
    afterEach(() => {
      delete process.env.TEST_VENDOR_KEY
    })

    it('registers when baseURL + the named key env var are set', () => {
      process.env.TEST_VENDOR_KEY = 'sk-vendor-fake'
      const surface = createWorkflowAssistAgent({
        hub,
        config: {
          provider: 'openai-compatible',
          baseURL: 'https://vendor.example/v1',
          apiKeyEnv: 'TEST_VENDOR_KEY',
          model: 'mimo-v2.5-pro',
        },
        logger,
      })
      expect(surface).not.toBeNull()
      expect(hub.participants().some((p) => p.id === 'workflow-assistant')).toBe(true)
    })

    it('skips when the named key env var is unset (fail-closed, no boom)', () => {
      const surface = createWorkflowAssistAgent({
        hub,
        config: {
          provider: 'openai-compatible',
          baseURL: 'https://vendor.example/v1',
          apiKeyEnv: 'TEST_VENDOR_KEY',
        },
        logger,
      })
      expect(surface).toBeNull()
      expect(hub.participants().some((p) => p.id === 'workflow-assistant')).toBe(false)
    })

    it('skips when no apiKeyEnv is configured — never falls back to OPENAI_API_KEY', () => {
      // The real OpenAI key must NEVER be silently sent to a third-party endpoint.
      process.env.OPENAI_API_KEY = 'sk-real-openai-fake'
      const surface = createWorkflowAssistAgent({
        hub,
        config: { provider: 'openai-compatible', baseURL: 'https://vendor.example/v1' },
        logger,
      })
      expect(surface).toBeNull()
    })

    it('skips when baseURL is missing (provider build fails → warn, boot survives)', () => {
      process.env.TEST_VENDOR_KEY = 'sk-vendor-fake'
      const surface = createWorkflowAssistAgent({
        hub,
        config: { provider: 'openai-compatible', apiKeyEnv: 'TEST_VENDOR_KEY' },
        logger,
      })
      expect(surface).toBeNull()
    })
  })

  it('mock surface.assist dispatches + returns draftStatus=valid output', async () => {
    const surface = createWorkflowAssistAgent({
      hub,
      config: { provider: 'mock' },
      logger,
    })
    expect(surface).not.toBeNull()
    const out = await surface!.assist({
      description: 'crawl 3 news sources weekly',
      by: 'admin',
    })
    expect(out.draftStatus).toBe('valid')
    expect(out.yaml).toContain('schema: gotong.workflow/v1')
    expect(out.yaml).toContain('id: assistant-mock-draft')
    expect(out.validationError).toBeUndefined()
    expect(out.raw).toContain('Mock assistant')
  })

  it('mock surface forwards contextHints through to the agent', async () => {
    // The mock provider ignores the user message but the round-trip
    // confirms the contextHints field doesn't break the dispatch path.
    const surface = createWorkflowAssistAgent({
      hub,
      config: { provider: 'mock' },
      logger,
    })
    const out = await surface!.assist({
      description: 'with hints',
      contextHints: {
        agents: [{ id: 'writer', capabilities: ['draft'] }],
        existingWorkflowIds: ['existing-1'],
      },
      by: 'admin',
    })
    expect(out.draftStatus).toBe('valid')
  })

  it('throws a clear error when dispatched against an unregistered hub', async () => {
    // Create the surface, then deregister the agent — assist now hits
    // no_participant, which the surface translates to a thrown Error.
    const surface = createWorkflowAssistAgent({
      hub,
      config: { provider: 'mock' },
      logger,
    })
    hub.unregister('workflow-assistant')
    await expect(
      surface!.assist({ description: 'after dereg', by: 'admin' }),
    ).rejects.toThrow(/no participant/i)
  })

  // WFEDIT-D4 — per-call chunk sinks. The mock provider streams its reply in 8
  // chunks, so these exercise the real streaming path end to end.
  describe('per-call onChunk (WFEDIT-D4)', () => {
    it('streams THIS call’s chunks into the caller’s sink (joined === raw)', async () => {
      const surface = createWorkflowAssistAgent({ hub, config: { provider: 'mock' }, logger })
      const chunks: string[] = []
      const out = await surface!.assist({
        description: 'stream me',
        by: 'member-1',
        onChunk: (c) => chunks.push(c),
      })
      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks.join('')).toBe(out.raw)
    })

    it('never leaks a concurrent sibling call’s chunks into the sink', async () => {
      // A streams into a sink, B (same agent, concurrent) does not. If routing
      // were keyed on anything global, B's 8 chunks would also land in A's sink
      // and the joined text would be the reply doubled. Exact equality with A's
      // own raw proves per-call isolation — the member-safety property.
      const surface = createWorkflowAssistAgent({ hub, config: { provider: 'mock' }, logger })
      const chunks: string[] = []
      const [a] = await Promise.all([
        surface!.assist({ description: 'call A', by: 'member-a', onChunk: (c) => chunks.push(c) }),
        surface!.assist({ description: 'call B', by: 'member-b' }),
      ])
      expect(chunks.join('')).toBe(a.raw)
    })

    it('a throwing sink never breaks the assist call', async () => {
      const surface = createWorkflowAssistAgent({ hub, config: { provider: 'mock' }, logger })
      const out = await surface!.assist({
        description: 'sink throws',
        by: 'member-1',
        onChunk: () => {
          throw new Error('client gone')
        },
      })
      expect(out.draftStatus).toBe('valid')
    })
  })

  // ARCH-M2 — architect dimensions threaded through the surface: `graph` rides
  // the verbatim output, and mode/detail/subjectYaml reach the agent payload.
  describe('architect dimensions (ARCH-M2)', () => {
    it('author mode now attaches a graph for a valid draft', async () => {
      const surface = createWorkflowAssistAgent({ hub, config: { provider: 'mock' }, logger })
      const out = await surface!.assist({ description: 'author with graph', by: 'admin' })
      expect(out.draftStatus).toBe('valid')
      // The mock draft's id is 'assistant-mock-draft'; the graph is the pure
      // projection of THAT parsed YAML, so its workflowId matches.
      expect(out.graph).toBeDefined()
      expect(out.graph?.workflowId).toBe('assistant-mock-draft')
      expect(out.graph?.nodes.length).toBeGreaterThan(0)
    })

    it('explain mode echoes subjectYaml verbatim + projects ITS graph (not the LLM echo)', async () => {
      const subject = [
        'schema: gotong.workflow/v1',
        'workflow:',
        '  id: explain-subject',
        '  trigger:',
        '    capability: kickoff',
        '  steps:',
        '    - id: do-thing',
        '      dispatch:',
        '        strategy: { kind: capability, capabilities: [chat] }',
        '        payload: {}',
      ].join('\n')
      const surface = createWorkflowAssistAgent({ hub, config: { provider: 'mock' }, logger })
      const out = await surface!.assist({
        description: 'ignored in explain mode',
        mode: 'explain',
        detail: 'detailed',
        subjectYaml: subject,
        by: 'admin',
      })
      // YAML is the subject verbatim — never the mock's own 'assistant-mock-draft'.
      expect(out.yaml).toBe(subject)
      expect(out.yaml).not.toContain('assistant-mock-draft')
      expect(out.draftStatus).toBe('valid')
      // Graph is projected from the subject, so its id is the subject's id.
      expect(out.graph?.workflowId).toBe('explain-subject')
    })

    it('explain mode with an unparseable subject → invalid + no graph', async () => {
      const surface = createWorkflowAssistAgent({ hub, config: { provider: 'mock' }, logger })
      const out = await surface!.assist({
        description: 'ignored',
        mode: 'explain',
        subjectYaml: 'not: a: valid: workflow',
        by: 'admin',
      })
      expect(out.draftStatus).toBe('invalid')
      expect(out.graph).toBeUndefined()
    })
  })
})
