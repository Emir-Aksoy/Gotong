import { describe, expect, it } from 'vitest'
import { drainStream, type LlmToolDefinition } from '@aipehub/llm'

import { AnthropicProvider } from '../src/index.js'

/**
 * Live integration tests against the real Anthropic API. Skipped in CI and
 * in any local shell that has no ANTHROPIC_API_KEY exported. These are the
 * nightly/release gate (.github/workflows/live.yml) — the only place a real
 * key is supplied, via repo secrets; normal `pnpm -r test` skips them.
 *
 * Cost discipline: tiny prompts, a small max-tokens cap, and a cheap model
 * by default (Claude Haiku). Override the model with AIPE_LIVE_ANTHROPIC_MODEL
 * if an account doesn't have Haiku enabled.
 */
const MODEL = process.env.AIPE_LIVE_ANTHROPIC_MODEL ?? 'claude-3-5-haiku-latest'

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('AnthropicProvider — live API', () => {
  it('returns non-empty text for a tiny prompt', async () => {
    const provider = new AnthropicProvider({ defaultModel: MODEL, defaultMaxTokens: 32 })

    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'Say the single word: pong' }],
    }))

    expect(typeof res.text).toBe('string')
    expect(res.text.length).toBeGreaterThan(0)
    // We don't assert exact content — model is non-deterministic — but a
    // healthy completion should not be flagged as error.
    expect(['end_turn', 'max_tokens']).toContain(res.stopReason)
  }, 30_000)

  // This is the load-bearing gate: a green run here means the whole
  // tool-use contract (declare → the model picks the tool → we feed a
  // tool_result → the model folds it into its answer) survives against the
  // live vendor, across both stream translation directions. Unit tests
  // mock the wire; only this exercises the real round-trip.
  it('completes a tool-use round-trip and folds the result into the reply', async () => {
    const provider = new AnthropicProvider({ defaultModel: MODEL, defaultMaxTokens: 256 })

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
