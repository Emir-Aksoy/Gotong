import { describe, expect, it } from 'vitest'
import { drainStream } from '@aipehub/llm'

import { AnthropicProvider } from '../src/index.js'

/**
 * Live integration test against the real Anthropic API. Skipped in CI and in
 * any local shell that has no ANTHROPIC_API_KEY exported. Send a tiny prompt
 * with a small max-tokens cap so cost stays near zero.
 */
describe.skipIf(!process.env.ANTHROPIC_API_KEY)('AnthropicProvider — live API', () => {
  it('returns non-empty text for a tiny prompt', async () => {
    const provider = new AnthropicProvider({ defaultMaxTokens: 32 })

    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'Say the single word: pong' }],
    }))

    expect(typeof res.text).toBe('string')
    expect(res.text.length).toBeGreaterThan(0)
    // We don't assert exact content — model is non-deterministic — but a
    // healthy completion should not be flagged as error.
    expect(['end_turn', 'max_tokens']).toContain(res.stopReason)
  }, 30_000)
})
