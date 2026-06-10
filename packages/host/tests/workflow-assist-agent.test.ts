/**
 * Phase 13 M3 — host wiring for the WorkflowAssistantAgent.
 *
 * Tests cover the `createWorkflowAssistAgent` factory + the
 * `WorkflowAssistSurface` it returns:
 *   - returns null when AIPE_ASSISTANT_DISABLED=1 (via resolveWorkflowAssistConfig)
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

import { createLogger, Hub, InMemoryStorage } from '@aipehub/core'
import { WORKFLOW_ASSISTANT_CAPABILITY } from '@aipehub/workflow-assistant'

import {
  createWorkflowAssistAgent,
  resolveWorkflowAssistConfig,
} from '../src/workflow-assist-agent.js'

const logger = createLogger('wf-assist-test', { disabled: true })

describe('resolveWorkflowAssistConfig', () => {
  const ORIG = { ...process.env }
  beforeEach(() => {
    delete process.env.AIPE_ASSISTANT_DISABLED
    delete process.env.AIPE_ASSISTANT_PROVIDER
    delete process.env.AIPE_ASSISTANT_MODEL
    delete process.env.AIPE_ASSISTANT_MAX_TOKENS
  })
  afterEach(() => {
    // Restore — vitest doesn't isolate process.env between tests.
    process.env = { ...ORIG }
  })

  it('returns null when AIPE_ASSISTANT_DISABLED=1', () => {
    process.env.AIPE_ASSISTANT_DISABLED = '1'
    expect(resolveWorkflowAssistConfig()).toBeNull()
  })

  it("returns null when AIPE_ASSISTANT_DISABLED='true'", () => {
    process.env.AIPE_ASSISTANT_DISABLED = 'true'
    expect(resolveWorkflowAssistConfig()).toBeNull()
  })

  it('defaults to anthropic when no env vars set', () => {
    expect(resolveWorkflowAssistConfig()).toEqual({ provider: 'anthropic' })
  })

  it('honours provider override', () => {
    process.env.AIPE_ASSISTANT_PROVIDER = 'openai'
    expect(resolveWorkflowAssistConfig()).toEqual({ provider: 'openai' })
  })

  it('falls back to anthropic on unknown provider name', () => {
    process.env.AIPE_ASSISTANT_PROVIDER = 'gemini'
    expect(resolveWorkflowAssistConfig()).toEqual({ provider: 'anthropic' })
  })

  it('reads model + maxTokens overrides', () => {
    process.env.AIPE_ASSISTANT_PROVIDER = 'mock'
    process.env.AIPE_ASSISTANT_MODEL = 'claude-3-5-sonnet-latest'
    process.env.AIPE_ASSISTANT_MAX_TOKENS = '8192'
    expect(resolveWorkflowAssistConfig()).toEqual({
      provider: 'mock',
      model: 'claude-3-5-sonnet-latest',
      maxTokens: 8192,
    })
  })

  it('ignores malformed maxTokens', () => {
    process.env.AIPE_ASSISTANT_MAX_TOKENS = 'lots'
    const cfg = resolveWorkflowAssistConfig()
    expect(cfg).toBeTruthy()
    expect(cfg!.maxTokens).toBeUndefined()
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
    expect(out.yaml).toContain('schema: aipehub.workflow/v1')
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
})
