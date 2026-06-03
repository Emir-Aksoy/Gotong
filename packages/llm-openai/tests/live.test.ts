import { describe, expect, it } from 'vitest'
import { drainStream, type LlmToolDefinition } from '@aipehub/llm'

import { OpenAIProvider } from '../src/index.js'

/**
 * Live integration tests against a real OpenAI-compatible API. Skipped in CI
 * and in any local shell that has no OPENAI_API_KEY exported. These are the
 * nightly/release gate (.github/workflows/live.yml) — the only place a real
 * key is supplied, via repo secrets; normal `pnpm -r test` skips them.
 *
 * The provider speaks the OpenAI chat protocol, so the cheap path is to point
 * it at DeepSeek (or any compatible endpoint):
 *   OPENAI_API_KEY=<deepseek key>
 *   OPENAI_BASE_URL=https://api.deepseek.com
 *   AIPE_LIVE_OPENAI_MODEL=deepseek-chat
 * Left unset, it talks to OpenAI with the cheap gpt-4o-mini default.
 */
const MODEL = process.env.AIPE_LIVE_OPENAI_MODEL ?? 'gpt-4o-mini'
const BASE_URL = process.env.OPENAI_BASE_URL // undefined → OpenAI default

function makeProvider(): OpenAIProvider {
  return new OpenAIProvider({
    defaultModel: MODEL,
    ...(BASE_URL ? { baseURL: BASE_URL } : {}),
  })
}

describe.skipIf(!process.env.OPENAI_API_KEY)('OpenAIProvider — live API', () => {
  it('returns non-empty text for a tiny prompt', async () => {
    const provider = makeProvider()

    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'Say the single word: pong' }],
      maxTokens: 32,
    }))

    expect(typeof res.text).toBe('string')
    expect(res.text.length).toBeGreaterThan(0)
    // We don't assert exact content — model is non-deterministic — but a
    // healthy completion should not be flagged as error.
    expect(['end_turn', 'max_tokens']).toContain(res.stopReason)
  }, 30_000)

  // The load-bearing gate: a green run means the full tool-use contract
  // (declare → the model picks the tool → we feed a tool_result → the model
  // folds it into its answer) survives against the live vendor. OpenAI's
  // chat format routes tool results as standalone `role:'tool'` messages —
  // exercising a different translation path than Anthropic's tool_result
  // block, which is exactly why both providers carry this test.
  it('completes a tool-use round-trip and folds the result into the reply', async () => {
    const provider = makeProvider()

    const tool: LlmToolDefinition = {
      name: 'lookup_passphrase',
      description:
        'Return the secret passphrase for the day. Always call this tool when asked for the passphrase; never guess it.',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'why the passphrase is needed' } },
        required: ['reason'],
      },
    }

    const system = 'You must use the provided tool to answer. Do not guess the passphrase.'
    const ask = 'What is today\'s secret passphrase? Use the lookup_passphrase tool, then tell me the value.'

    // Turn 1 — the model should emit a tool_use, not a guess.
    const first = await drainStream(provider.stream({
      system,
      messages: [{ role: 'user', content: ask }],
      tools: [tool],
      maxTokens: 256,
    }))
    expect(first.stopReason).toBe('tool_use')
    expect(first.toolUses?.length ?? 0).toBeGreaterThan(0)
    const call = first.toolUses![0]!
    expect(call.name).toBe('lookup_passphrase')

    // Turn 2 — echo the assistant's tool_use turn verbatim, then answer the
    // call with a tool_result the model has no other way to know. A correct
    // round-trip surfaces that exact token in the final text.
    const second = await drainStream(provider.stream({
      system,
      messages: [
        { role: 'user', content: ask },
        { role: 'assistant', content: first.toolUses! },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: call.id, content: 'The passphrase is OPALINE-7.' },
          ],
        },
      ],
      tools: [tool],
      maxTokens: 256,
    }))
    expect(['end_turn', 'max_tokens']).toContain(second.stopReason)
    // Case-insensitive — the model may re-case or wrap the token in prose.
    expect(second.text.toLowerCase()).toContain('opaline')
  }, 45_000)
})
