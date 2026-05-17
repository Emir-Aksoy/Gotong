/**
 * `MockLlmProvider` is the test/demo backbone for the whole `llm` package
 * — every example, every integration test of an LLM-backed agent leans
 * on it. `agent.test.ts` exercises it indirectly; this file pins down
 * its own option matrix so we'd catch a regression in the mock itself.
 */

import { describe, expect, it } from 'vitest'

import { MockLlmProvider, type LlmRequest } from '../src/index.js'

describe('MockLlmProvider — reply forms', () => {
  it('static string reply returns verbatim', async () => {
    const p = new MockLlmProvider({ reply: 'hello' })
    const r = await p.complete({ messages: [{ role: 'user', content: 'x' }] })
    expect(r.text).toBe('hello')
  })

  it('function reply receives the full LlmRequest', async () => {
    let received: LlmRequest | undefined
    const p = new MockLlmProvider({
      reply: (req) => {
        received = req
        return `echo:${req.messages[0]?.content ?? ''}`
      },
    })
    const r = await p.complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
      temperature: 0.3,
      model: 'm',
    })
    expect(r.text).toBe('echo:hi')
    expect(received?.system).toBe('sys')
    expect(received?.maxTokens).toBe(50)
    expect(received?.temperature).toBe(0.3)
    expect(received?.model).toBe('m')
  })
})

describe('MockLlmProvider — name override', () => {
  it('defaults to "mock"', () => {
    expect(new MockLlmProvider({ reply: '' }).name).toBe('mock')
  })

  it('honours an explicit name', () => {
    expect(new MockLlmProvider({ reply: '', name: 'mock-prod' }).name).toBe('mock-prod')
  })
})

describe('MockLlmProvider — stopReason override', () => {
  it("defaults to 'end_turn'", async () => {
    const p = new MockLlmProvider({ reply: '' })
    const r = await p.complete({ messages: [] })
    expect(r.stopReason).toBe('end_turn')
  })

  it('passes through the explicit stopReason', async () => {
    const p = new MockLlmProvider({ reply: 'truncated', stopReason: 'max_tokens' })
    const r = await p.complete({ messages: [{ role: 'user', content: 'long...' }] })
    expect(r.stopReason).toBe('max_tokens')
  })
})

describe('MockLlmProvider — throwError', () => {
  it('rejects with an Error whose message matches', async () => {
    const p = new MockLlmProvider({ reply: 'never used', throwError: 'rate_limited' })
    await expect(
      p.complete({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/rate_limited/)
  })

  it('throws even when delayMs is also set', async () => {
    const p = new MockLlmProvider({ reply: '', throwError: 'oops', delayMs: 1 })
    await expect(p.complete({ messages: [] })).rejects.toThrow(/oops/)
  })
})

describe('MockLlmProvider — delayMs', () => {
  it('waits at least the configured ms before resolving', async () => {
    const p = new MockLlmProvider({ reply: 'ok', delayMs: 20 })
    const t0 = Date.now()
    await p.complete({ messages: [{ role: 'user', content: 'x' }] })
    const elapsed = Date.now() - t0
    // Allow scheduler jitter — but the resolver shouldn't fire before
    // the configured delay.
    expect(elapsed).toBeGreaterThanOrEqual(15)
  })

  it('zero delay resolves on the same microtask boundary', async () => {
    const p = new MockLlmProvider({ reply: 'ok' })
    const t0 = Date.now()
    await p.complete({ messages: [] })
    expect(Date.now() - t0).toBeLessThan(20)
  })
})

describe('MockLlmProvider — usage estimation', () => {
  it('reports both inputTokens and outputTokens', async () => {
    const p = new MockLlmProvider({ reply: 'a'.repeat(40) })
    const r = await p.complete({
      messages: [{ role: 'user', content: 'b'.repeat(80) }],
    })
    // ceil(80/4) = 20, ceil(40/4) = 10
    expect(r.usage?.inputTokens).toBe(20)
    expect(r.usage?.outputTokens).toBe(10)
  })

  it('counts the system prompt toward inputTokens', async () => {
    const p = new MockLlmProvider({ reply: '' })
    const noSys = await p.complete({
      messages: [{ role: 'user', content: 'b'.repeat(40) }],
    })
    const withSys = await p.complete({
      system: 's'.repeat(40),
      messages: [{ role: 'user', content: 'b'.repeat(40) }],
    })
    expect(withSys.usage?.inputTokens).toBeGreaterThan(noSys.usage?.inputTokens ?? 0)
  })

  it('does NOT populate cacheCreationTokens / cacheReadTokens (mock has no cache)', async () => {
    const p = new MockLlmProvider({ reply: 'hi' })
    const r = await p.complete({ messages: [{ role: 'user', content: 'x' }] })
    expect(r.usage?.cacheCreationTokens).toBeUndefined()
    expect(r.usage?.cacheReadTokens).toBeUndefined()
  })

  it('handles a request with neither system nor messages (length 0)', async () => {
    const p = new MockLlmProvider({ reply: '' })
    const r = await p.complete({ messages: [] })
    expect(r.usage?.inputTokens).toBe(0)
    expect(r.usage?.outputTokens).toBe(0)
  })
})
