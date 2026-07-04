/**
 * BF-M8 unit — `butlerSummarizer`, the one host seam that binds an `LlmProvider`
 * to the provider-agnostic `MemorySummarizer` the distillation engine wants.
 * The sweep E2E exercises it through a mock provider end to end; this pins the
 * request SHAPE it hands the provider (so a drift in defaults is caught here,
 * not in a fuzzy integration failure).
 */

import { describe, expect, it } from 'vitest'

import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@gotong/llm'

import { butlerSummarizer } from '../src/personal-butler-maintenance.js'

/** A provider that records the request it was handed and replies with a fixed text. */
function capturingProvider(reply = 'distilled'): { provider: LlmProvider; seen: LlmRequest[] } {
  const seen: LlmRequest[] = []
  const provider: LlmProvider = {
    name: 'capture',
    async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
      seen.push(req)
      yield { type: 'text', text: reply }
      yield { type: 'end', stopReason: 'end_turn' }
    },
  }
  return { provider, seen }
}

describe('butlerSummarizer — provider → MemorySummarizer seam', () => {
  it('shapes a single-user-message request with the default token budget and returns the text', async () => {
    const { provider, seen } = capturingProvider('主人偏好: 奶茶少糖')
    const summarize = butlerSummarizer(provider)

    const out = await summarize({ system: '你是策展员', user: '把这些回合蒸馏成画像' })

    expect(out).toBe('主人偏好: 奶茶少糖')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.system).toBe('你是策展员')
    expect(seen[0]!.messages).toEqual([{ role: 'user', content: '把这些回合蒸馏成画像' }])
    expect(seen[0]!.maxTokens).toBe(512) // default distillation budget
    expect(seen[0]!.model).toBeUndefined() // omitted → provider's own default model
  })

  it('passes through explicit model + maxTokens overrides', async () => {
    const { provider, seen } = capturingProvider()
    const summarize = butlerSummarizer(provider, { model: 'mimo-v2.5-pro', maxTokens: 1024 })

    await summarize({ system: 's', user: 'u' })

    expect(seen[0]!.model).toBe('mimo-v2.5-pro')
    expect(seen[0]!.maxTokens).toBe(1024)
  })
})
