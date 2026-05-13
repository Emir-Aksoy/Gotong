import { describe, expect, it } from 'vitest'

import { OpenAIProvider } from '../src/index.js'

/**
 * Live integration test against the real OpenAI API. Skipped in CI and in
 * any local shell that has no OPENAI_API_KEY exported. Send a tiny prompt
 * with a small max-tokens cap so cost stays near zero.
 */
describe.skipIf(!process.env.OPENAI_API_KEY)('OpenAIProvider — live API', () => {
  it('returns non-empty text for a tiny prompt', async () => {
    const provider = new OpenAIProvider()

    const res = await provider.complete({
      messages: [{ role: 'user', content: 'Say the single word: pong' }],
      maxTokens: 32,
    })

    expect(typeof res.text).toBe('string')
    expect(res.text.length).toBeGreaterThan(0)
    // We don't assert exact content — model is non-deterministic — but a
    // healthy completion should not be flagged as error.
    expect(['end_turn', 'max_tokens']).toContain(res.stopReason)
  }, 30_000)
})
