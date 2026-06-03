/**
 * Live end-to-end gate: a complete multi-step workflow driven by a REAL LLM.
 *
 * Skipped unless a real key is exported (ANTHROPIC_API_KEY or OPENAI_API_KEY).
 * This is the workflow half of the nightly/release live gate
 * (.github/workflows/live.yml) — the only place a real key is supplied, via
 * repo secrets; normal `pnpm -r test` and key-less shells skip it.
 *
 * Where the provider live tests (packages/llm-anthropic + llm-openai) pin
 * the raw vendor round-trip, this pins the whole local stack on top of it:
 *   Hub + a real LlmAgent + parseWorkflow + WorkflowRunner
 * A green run proves the runner dispatches a capability step to a live model,
 * threads step-1's output into step-2's prompt ($echo.output), and surfaces
 * both in the run output map — the integration the mock-provider E2E tests
 * (industry-consultation-flow.test.ts) deliberately can't cover.
 *
 * Cost discipline: one run, two one-word prompts, a 64-token cap, cheap
 * models by default (Claude Haiku / gpt-4o-mini). Point it at DeepSeek with
 * OPENAI_API_KEY + OPENAI_BASE_URL=https://api.deepseek.com +
 * AIPE_LIVE_OPENAI_MODEL=deepseek-chat for the cheapest path.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Hub, Space, type TaskResult } from '@aipehub/core'
import { LlmAgent, type LlmAgentOptions, type LlmProvider } from '@aipehub/llm'
import { AnthropicProvider } from '@aipehub/llm-anthropic'
import { OpenAIProvider } from '@aipehub/llm-openai'
import { parseWorkflow, WorkflowRunner } from '@aipehub/workflow'

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)

/**
 * Build the cheapest available real provider. Anthropic wins when both keys
 * are set (Haiku is the bounded default); otherwise the OpenAI-compatible
 * path covers OpenAI and DeepSeek (via OPENAI_BASE_URL).
 */
function liveProvider(): { provider: LlmProvider; label: string } {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      label: 'anthropic',
      provider: new AnthropicProvider({
        defaultModel: process.env.AIPE_LIVE_ANTHROPIC_MODEL ?? 'claude-3-5-haiku-latest',
        defaultMaxTokens: 64,
      }),
    }
  }
  return {
    label: 'openai',
    provider: new OpenAIProvider({
      defaultModel: process.env.AIPE_LIVE_OPENAI_MODEL ?? 'gpt-4o-mini',
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    }),
  }
}

// A faithful two-step workflow: step `echo` asks the model for one token,
// step `wrap` consumes `$echo.output` (proving the runner threads refs into
// a live prompt). Inlined here, no template file needed.
const WORKFLOW_YAML = `
schema: aipehub.workflow/v1
workflow:
  id: live-smoke-flow
  name: Live LLM smoke
  trigger:
    capability: live-smoke
  steps:
    - id: echo
      dispatch:
        strategy: { kind: capability, capabilities: [live-echo] }
        title: echo
        payload:
          prompt: |
            Reply with exactly this one word and nothing else: PONG
    - id: wrap
      dispatch:
        strategy: { kind: capability, capabilities: [live-wrap] }
        title: wrap
        payload:
          prompt: |
            Below is a JSON object produced by a previous step. Reply with only
            the value of its "text" field, nothing else:
            $echo.output
  output:
    echo: $echo.output
    wrap: $wrap.output
`

describe.skipIf(!HAS_KEY)('live workflow — real LLM end to end', () => {
  let root: string
  let hub: Hub

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'aipe-live-wf-'))
    const { space } = await Space.init(root, { name: 'live-smoke' })
    hub = new Hub({ space })
    await hub.start()

    const { provider } = liveProvider()
    const agent = new LlmAgent({
      id: 'live-smoke-agent',
      capabilities: ['live-echo', 'live-wrap'],
      provider,
      system: 'You are a terse assistant. Follow the instruction exactly; do not add commentary.',
      maxTokens: 64,
    } as LlmAgentOptions)

    const runner = new WorkflowRunner({ definition: parseWorkflow(WORKFLOW_YAML), hub })
    hub.register(agent)
    hub.register(runner)
  }, 30_000)

  afterAll(async () => {
    await hub?.stop()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('runs both steps against the model and threads step-1 output into step-2', async () => {
    const result: TaskResult = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['live-smoke'] },
      payload: {},
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return

    const out = result.output as {
      echo: { text: string }
      wrap: { text: string }
    }
    // Step 1: the live model produced the requested token.
    expect(typeof out.echo.text).toBe('string')
    expect(out.echo.text.toLowerCase()).toContain('pong')
    // Step 2: the runner threaded $echo.output into step-2's prompt and the
    // live model echoed the token back out — the ref-passing path is live.
    expect(out.wrap.text.toLowerCase()).toContain('pong')
  }, 60_000)
})
