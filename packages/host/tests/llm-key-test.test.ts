// Unit tests for the LLM key "test connection" service (ease-of-use ①).
//
// We inject a fake provider via `buildProvider` so every error-classification
// branch is exercised deterministically — no network, no real SDK. The one
// real-clock case is the timeout, which drives the AbortController for real
// against a hanging fake.

import { describe, it, expect } from 'vitest'
import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@aipehub/llm'
import {
  testLlmKey,
  createLlmKeyTestSurface,
  type LlmKeyTestInput,
} from '../src/llm-key-test.js'

/** Fake provider that yields a normal short stream. */
function okProvider(): LlmProvider {
  return {
    name: 'fake-ok',
    async *stream(_req: LlmRequest): AsyncIterable<LlmStreamChunk> {
      yield { type: 'text', text: 'pong' }
      yield { type: 'end', stopReason: 'end_turn' }
    },
  }
}

/** Fake provider whose stream throws synchronously (the real auth/transport contract). */
function throwingProvider(err: unknown): LlmProvider {
  return {
    name: 'fake-throw',
    stream(_req: LlmRequest): AsyncIterable<LlmStreamChunk> {
      throw err
    },
  }
}

/** Fake provider that hangs until the abort signal fires, then throws an AbortError. */
function hangingProvider(): LlmProvider {
  return {
    name: 'fake-hang',
    async *stream(_req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamChunk> {
      await new Promise<void>((_resolve, reject) => {
        if (!signal) return
        signal.addEventListener('abort', () => {
          const e = new Error('aborted') as Error & { name: string }
          e.name = 'AbortError'
          reject(e)
        })
      })
      yield { type: 'end', stopReason: 'end_turn' }
    },
  }
}

/** Shorthand: build an HTTP-style vendor error carrying `.status`. */
function httpError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  const e = new Error(message) as Error & { status: number }
  e.status = status
  return e
}

const ANTHROPIC: LlmKeyTestInput = { provider: 'anthropic', apiKey: 'sk-ant-xxxxxxxxxxxx' }

describe('testLlmKey — happy path', () => {
  it('returns ok with the resolved default model when the stream yields', async () => {
    const r = await testLlmKey(ANTHROPIC, { buildProvider: okProvider })
    expect(r.ok).toBe(true)
    expect(r.model).toBe('claude-haiku-4-5-20251001')
    expect(r.code).toBeUndefined()
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('honors an explicit model over the per-provider default', async () => {
    const r = await testLlmKey({ ...ANTHROPIC, model: 'claude-3-5-sonnet' }, { buildProvider: okProvider })
    expect(r.ok).toBe(true)
    expect(r.model).toBe('claude-3-5-sonnet')
  })

  it('measures latency from the injected clock', async () => {
    let t = 1000
    const r = await testLlmKey(ANTHROPIC, {
      buildProvider: okProvider,
      now: () => (t += 25), // started=1025, ended=1050
    })
    expect(r.latencyMs).toBe(25)
  })
})

describe('testLlmKey — empty key short-circuit', () => {
  it('rejects an empty key without constructing a provider', async () => {
    let built = false
    const r = await testLlmKey(
      { provider: 'anthropic', apiKey: '   ' },
      { buildProvider: () => { built = true; return okProvider() } },
    )
    expect(built).toBe(false)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('invalid_key')
    expect(r.model).toBe('')
    expect(r.latencyMs).toBe(0)
  })
})

describe('testLlmKey — error classification', () => {
  const cases: Array<[string, unknown, string]> = [
    ['401 → invalid_key', httpError(401), 'invalid_key'],
    ['403 → invalid_key', httpError(403), 'invalid_key'],
    ['402 → insufficient_quota', httpError(402), 'insufficient_quota'],
    ['429 + balance wording → insufficient_quota', httpError(429, 'Insufficient Balance'), 'insufficient_quota'],
    ['429 + quota wording → insufficient_quota', httpError(429, 'You exceeded your current quota'), 'insufficient_quota'],
    ['429 plain → rate_limited', httpError(429, 'Too Many Requests'), 'rate_limited'],
    ['404 → not_found', httpError(404, 'model not found'), 'not_found'],
    ['400 → bad_request', httpError(400), 'bad_request'],
    ['422 → bad_request', httpError(422), 'bad_request'],
    ['500 → upstream', httpError(500), 'upstream'],
    ['503 → upstream', httpError(503), 'upstream'],
  ]
  for (const [label, err, expected] of cases) {
    it(label, async () => {
      const r = await testLlmKey(ANTHROPIC, { buildProvider: () => throwingProvider(err) })
      expect(r.ok).toBe(false)
      expect(r.code).toBe(expected)
      // Even on failure we report the model we attempted, for the UI to echo.
      expect(r.model).toBe('claude-haiku-4-5-20251001')
    })
  }

  it('classifies a network error code as network', async () => {
    const e = new Error('connect ECONNREFUSED') as Error & { code: string }
    e.code = 'ECONNREFUSED'
    const r = await testLlmKey(ANTHROPIC, { buildProvider: () => throwingProvider(e) })
    expect(r.code).toBe('network')
  })

  it('classifies a "fetch failed" message as network', async () => {
    const r = await testLlmKey(ANTHROPIC, { buildProvider: () => throwingProvider(new Error('fetch failed')) })
    expect(r.code).toBe('network')
  })

  it('classifies a wrapped cause network code as network', async () => {
    const e = new Error('request failed') as Error & { cause: { code: string } }
    e.cause = { code: 'ENOTFOUND' }
    const r = await testLlmKey(ANTHROPIC, { buildProvider: () => throwingProvider(e) })
    expect(r.code).toBe('network')
  })

  it('falls back to unknown for an unclassifiable error', async () => {
    const r = await testLlmKey(ANTHROPIC, { buildProvider: () => throwingProvider(new Error('weird')) })
    expect(r.code).toBe('unknown')
  })
})

describe('testLlmKey — timeout', () => {
  it('aborts and reports timeout when no chunk arrives in the budget', async () => {
    const r = await testLlmKey(ANTHROPIC, { buildProvider: hangingProvider, timeoutMs: 20 })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('timeout')
  })
})

describe('testLlmKey — key scrubbing', () => {
  it('never echoes the key back in the message', async () => {
    const key = 'sk-secret-DO-NOT-LEAK-123456'
    const err = httpError(400, `bad request for key ${key}`)
    const r = await testLlmKey({ provider: 'openai', apiKey: key }, { buildProvider: () => throwingProvider(err) })
    expect(r.message ?? '').not.toContain(key)
    expect(r.message ?? '').toContain('***')
  })
})

describe('testLlmKey — provider/model resolution', () => {
  it('passes a trimmed key to the provider builder', async () => {
    let seen: LlmKeyTestInput | undefined
    await testLlmKey(
      { provider: 'openai', apiKey: '  sk-trim-me  ' },
      { buildProvider: (input) => { seen = input; return okProvider() } },
    )
    expect(seen?.apiKey).toBe('sk-trim-me')
  })

  it('defaults openai to gpt-4o-mini', async () => {
    const r = await testLlmKey({ provider: 'openai', apiKey: 'sk-x' }, { buildProvider: okProvider })
    expect(r.model).toBe('gpt-4o-mini')
  })

  it('sniffs a DeepSeek baseURL to default deepseek-chat', async () => {
    const r = await testLlmKey(
      { provider: 'deepseek', apiKey: 'sk-x', baseURL: 'https://api.deepseek.com/v1' },
      { buildProvider: okProvider },
    )
    expect(r.model).toBe('deepseek-chat')
  })

  it('defaults an unknown openai-compatible baseURL to gpt-4o-mini', async () => {
    const r = await testLlmKey(
      { provider: 'qwen', apiKey: 'sk-x', baseURL: 'https://example.test/v1' },
      { buildProvider: okProvider },
    )
    expect(r.model).toBe('gpt-4o-mini')
  })
})

describe('createLlmKeyTestSurface', () => {
  it('exposes testLlmKey and uses the real builder by default (no network here)', () => {
    const surface = createLlmKeyTestSurface()
    expect(typeof surface.testLlmKey).toBe('function')
  })
})
