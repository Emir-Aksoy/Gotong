/**
 * Live onboarding self-rescue gate: the wizard key probe + a freshly-built
 * agent, exercised against a REAL model (ease-of-use ❹-M2).
 *
 * The onboarding promise — "paste a key, build an assistant, and if the key is
 * wrong you get a one-click 去补 key rescue, not a dead agent" — already has
 * hermetic coverage everywhere: llm-key-test.test.ts injects fake 401s, and
 * the local self-check (scripts/local-onboarding-check.mjs) walks the probe
 * with an injected provider. What nobody had walked is the SAME testLlmKey
 * primitive against a live vendor. This file does:
 *   1. a freshly-built real LlmAgent answers a real dispatch (the "I built an
 *      assistant and it works" moment), and
 *   2. the wizard probe greenlights a real key AND classifies a wrong key as a
 *      去补 key root cause (invalid_key / insufficient_quota) over the live
 *      wire — the self-rescue signal the UI reads, proven end to end.
 *
 * Part of the nightly/release live gate (.github/workflows/live.yml), the only
 * place a real key is supplied (repo secrets). Skipped unless ANTHROPIC_API_KEY
 * or OPENAI_API_KEY is exported, so normal `pnpm -r test` and key-less shells
 * skip it (skipped != failed). Cost discipline mirrors live-workflow.test.ts:
 * one-token probes, a 64-token agent cap, cheap models by default (Claude
 * Haiku / gpt-4o-mini); point at DeepSeek with OPENAI_API_KEY +
 * OPENAI_BASE_URL=https://api.deepseek.com + GOTONG_LIVE_OPENAI_MODEL=deepseek-chat.
 *
 * Deliberately NOT a hard release blocker (paid, non-deterministic third-party
 * API) — same posture as the rest of the live gate.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Hub, Space, type TaskResult } from '@gotong/core'
import { LlmAgent, type LlmAgentOptions, type LlmProvider } from '@gotong/llm'
import { AnthropicProvider } from '@gotong/llm-anthropic'
import { OpenAIProvider } from '@gotong/llm-openai'

import { testLlmKey, type LlmKeyTestInput } from '../src/llm-key-test.js'

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)

// The two codes whose frontend fix hint is errFixKey — i.e. the failures the
// member/admin quick-chat lights up a one-click "去补 key" button for. Mirror
// of app-core.js ERROR_FIX_KEYS; the self-rescue path is exactly these.
const KEY_FIX_CODES = new Set(['invalid_key', 'insufficient_quota'])

/**
 * Cheapest available real provider for the agent (mirror of
 * live-workflow.test.ts): Anthropic wins when both keys are set, else the
 * OpenAI-compatible path (covers OpenAI and DeepSeek via OPENAI_BASE_URL).
 */
function liveProvider(): { provider: LlmProvider; label: string } {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      label: 'anthropic',
      provider: new AnthropicProvider({
        defaultModel: process.env.GOTONG_LIVE_ANTHROPIC_MODEL ?? 'claude-3-5-haiku-latest',
        defaultMaxTokens: 64,
      }),
    }
  }
  return {
    label: 'openai',
    provider: new OpenAIProvider({
      defaultModel: process.env.GOTONG_LIVE_OPENAI_MODEL ?? 'gpt-4o-mini',
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    }),
  }
}

/**
 * The same provider+key, shaped for the wizard probe (testLlmKey). Anthropic
 * wins when set; otherwise OpenAI-compatible with the optional DeepSeek
 * baseURL + model override. Returns the real key — the test passes it to the
 * probe and never logs it.
 */
function realKeyTestInput(): LlmKeyTestInput {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      ...(process.env.GOTONG_LIVE_ANTHROPIC_MODEL ? { model: process.env.GOTONG_LIVE_ANTHROPIC_MODEL } : {}),
    }
  }
  return {
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY ?? '',
    ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    ...(process.env.GOTONG_LIVE_OPENAI_MODEL ? { model: process.env.GOTONG_LIVE_OPENAI_MODEL } : {}),
  }
}

describe.skipIf(!HAS_KEY)('live onboarding — real LLM self-rescue path', () => {
  let root: string
  let hub: Hub

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-live-onboard-'))
    const { space } = await Space.init(root, { name: 'live-onboarding' })
    hub = new Hub({ space })
    await hub.start()

    const { provider } = liveProvider()
    // The agent a first-run user would build: one capability, a terse system
    // prompt, a tight token cap. Registering it is the "I created an assistant"
    // step; dispatching to it is the "does it answer?" step.
    const agent = new LlmAgent({
      id: 'live-onboarding-agent',
      capabilities: ['live-onboarding-chat'],
      provider,
      system: 'You are a terse assistant. Follow the instruction exactly; do not add commentary.',
      maxTokens: 64,
    } as LlmAgentOptions)
    hub.register(agent)
  }, 30_000)

  afterAll(async () => {
    await hub?.stop()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('a freshly-built agent answers a real dispatch (the assistant works)', async () => {
    const result: TaskResult = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['live-onboarding-chat'] },
      payload: { prompt: 'Reply with exactly this one word and nothing else: OK' },
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const out = result.output as { text?: unknown }
    // Don't over-assert the exact reply (live models drift); proving the real
    // agent call path produced a text answer is the onboarding signal.
    expect(typeof out.text).toBe('string')
    expect((out.text as string).length).toBeGreaterThan(0)
  }, 60_000)

  it('the wizard probe greenlights a real key over the live wire', async () => {
    // testLlmKey is the exact primitive the setup wizard / agent-create form
    // call; a green verdict here means the real "test connection" button works.
    const verdict = await testLlmKey(realKeyTestInput())
    expect(verdict.ok).toBe(true)
    expect(verdict.code).toBeUndefined()
    expect(verdict.model.length).toBeGreaterThan(0)
  }, 30_000)

  it('a wrong key classifies as a 去补 key root cause over the live wire', async () => {
    // Failure injection: the SAME real endpoint, a deliberately garbage key.
    // The authoritative "断言根因分类" — the vendor's 401 must classify into a
    // KEY_FIX_CODES code so the UI shows the one-click rescue, not a stack
    // trace. (A provider could route a bad key to 404/network depending on its
    // gateway; assert the rescue-path code, the common + correct case.)
    const wrong: LlmKeyTestInput = {
      ...realKeyTestInput(),
      apiKey: 'sk-gotong-deliberately-wrong-key-000000000000',
    }
    const verdict = await testLlmKey(wrong)
    expect(verdict.ok).toBe(false)
    expect(verdict.code).toBeDefined()
    expect(KEY_FIX_CODES.has(verdict.code as string)).toBe(true)
  }, 30_000)
})
