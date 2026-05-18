import { describe, expect, it, vi } from 'vitest'
import type { LlmRequest } from '@aipehub/llm'

import { OpenAIProvider, isTransientError } from '../src/index.js'

/**
 * Build a fake OpenAI SDK client exposing only the methods the provider
 * actually calls. The shape is duck-typed to match the real SDK; we cast to
 * `any` at the constructor boundary so we don't need to pin to a specific
 * SDK version's types in tests.
 */
function makeFakeClient(
  impl: (body: Record<string, unknown>) => Promise<unknown> | unknown,
) {
  const create = vi.fn(async (body: Record<string, unknown>) => impl(body))
  return {
    client: { chat: { completions: { create } } },
    create,
  }
}

describe('OpenAIProvider — request translation', () => {
  it('hoists system to a leading message and forwards messages, maxTokens, temperature, model', async () => {
    const { client, create } = makeFakeClient(async () => ({
      choices: [
        {
          message: { content: 'hi' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }))
    const provider = new OpenAIProvider({ client: client as any })

    const req: LlmRequest = {
      system: 'You are a poet.',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'go on' },
      ],
      maxTokens: 256,
      temperature: 0.3,
      model: 'gpt-4o',
    }

    await provider.complete(req)

    expect(create).toHaveBeenCalledTimes(1)
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.model).toBe('gpt-4o')
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are a poet.' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'go on' },
    ])
    expect(body.max_completion_tokens).toBe(256)
    expect(body.temperature).toBe(0.3)
    // The deprecated legacy field must not be sent.
    expect(body.max_tokens).toBeUndefined()
  })

  it('omits system message when request has no system field', async () => {
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: '' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })

    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] })

    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('falls back to defaultModel when request omits model', async () => {
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: '' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({
      client: client as any,
      defaultModel: 'gpt-default',
    })

    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] })

    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.model).toBe('gpt-default')
    // No maxTokens / temperature provided — should not be on the body either.
    expect(body.max_completion_tokens).toBeUndefined()
    expect(body.temperature).toBeUndefined()
  })

  it('uses built-in default model when constructor opts omit it', async () => {
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: '' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })

    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] })

    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.model).toBe('gpt-4o-mini')
  })
})

describe('OpenAIProvider — response translation', () => {
  it('returns choices[0].message.content as text', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [
        {
          message: { content: 'hello world' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    }))
    const provider = new OpenAIProvider({ client: client as any })

    const res = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(res.text).toBe('hello world')
    expect(res.stopReason).toBe('end_turn')
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 3 })
    expect(res.raw).toBeDefined()
  })

  it('handles null message content by returning empty string', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [{ message: { content: null }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })

    const res = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.text).toBe('')
  })

  it('maps length finish_reason to max_tokens', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [
        { message: { content: 'truncated...' }, finish_reason: 'length' },
      ],
    }))
    const provider = new OpenAIProvider({ client: client as any })

    const res = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.stopReason).toBe('max_tokens')
  })

  it('maps unknown finish_reason values to error', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [
        { message: { content: '' }, finish_reason: 'content_filter' },
      ],
    }))
    const provider = new OpenAIProvider({ client: client as any })

    const res = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.stopReason).toBe('error')
  })

  it('omits usage when the response has none', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })

    const res = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.usage).toBeUndefined()
  })

  it('exposes provider name', () => {
    const provider = new OpenAIProvider({ client: {} as any })
    expect(provider.name).toBe('openai')
  })
})

describe('OpenAIProvider — error propagation', () => {
  it('rethrows SDK errors so LlmAgent maps to failed TaskResult', async () => {
    const { client } = makeFakeClient(async () => {
      throw new Error('auth_denied')
    })
    const provider = new OpenAIProvider({ client: client as any })

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('auth_denied')
  })
})

// Tests for the OpenAI-compatible vendor extension (DeepSeek, Qwen,
// Zhipu, Moonshot, Ollama, vLLM, …). These all share the OpenAIProvider
// class but get `baseURL`, `name`, and `maxTokensField: 'max_tokens'`
// wired in by the host's `buildProvider`. The provider class doesn't
// care about the baseURL itself (the OpenAI SDK does); we test the
// fields that *we* control: the `name`, the `maxTokensField` switch,
// and that `baseURL` is forwarded to the SDK constructor when no
// `client` is injected.
describe('OpenAIProvider — openai-compatible extensions', () => {
  it('uses custom name when provided (defaults to "openai" otherwise)', () => {
    const a = new OpenAIProvider({ client: {} as any })
    expect(a.name).toBe('openai')
    const b = new OpenAIProvider({ client: {} as any, name: 'deepseek' })
    expect(b.name).toBe('deepseek')
  })

  it('sends max_tokens instead of max_completion_tokens when maxTokensField is overridden', async () => {
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({
      client: client as any,
      maxTokensField: 'max_tokens',
    })

    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 512,
    })

    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.max_tokens).toBe(512)
    // The newer field must not be on the wire — that's what would
    // trigger a 400 from non-OpenAI compatible endpoints.
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('keeps default max_completion_tokens field when maxTokensField is omitted', async () => {
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })

    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    })

    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.max_completion_tokens).toBe(100)
    expect(body.max_tokens).toBeUndefined()
  })

  it('retries on Premature close and eventually succeeds', async () => {
    let calls = 0
    const { client, create } = makeFakeClient(async () => {
      calls += 1
      if (calls < 3) {
        // Mimic the exact undici / fetch surface DeepSeek produces.
        const err = new Error(
          'Invalid response body while trying to fetch https://api.deepseek.com/v1/chat/completions: Premature close',
        )
        throw err
      }
      return {
        choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }
    })
    const provider = new OpenAIProvider({
      client: client as any,
      maxRetries: 3,
      retryBackoffMs: () => 1, // 1ms — keep test fast
    })
    const res = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.text).toBe('done')
    expect(create).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry on a permanent error (401 auth)', async () => {
    const { client, create } = makeFakeClient(async () => {
      const err: Error & { status?: number } = new Error('Unauthorized')
      err.status = 401
      throw err
    })
    const provider = new OpenAIProvider({
      client: client as any,
      maxRetries: 3,
      retryBackoffMs: () => 1,
    })
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/Unauthorized/)
    expect(create).toHaveBeenCalledTimes(1) // no retries
  })

  it('gives up after maxRetries+1 attempts and rethrows the last error', async () => {
    const { client, create } = makeFakeClient(async () => {
      const err = new Error('Premature close') as Error & { code?: string }
      err.code = 'ECONNRESET'
      throw err
    })
    const provider = new OpenAIProvider({
      client: client as any,
      maxRetries: 2,
      retryBackoffMs: () => 1,
    })
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/Premature close/)
    expect(create).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
  })

  it('with maxRetries=0 makes exactly one attempt (default behaviour)', async () => {
    const { client, create } = makeFakeClient(async () => {
      throw new Error('Premature close')
    })
    const provider = new OpenAIProvider({ client: client as any })
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/Premature close/)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('passes baseURL to the OpenAI SDK when constructing its own client', () => {
    // No `client` injected → provider builds its own. The OpenAI SDK
    // exposes `baseURL` on the constructed client (and lower-cases the
    // path to whatever it normalized internally), so we can read it
    // back to verify the option survived the constructor.
    const provider = new OpenAIProvider({
      apiKey: 'sk-test-not-real',
      baseURL: 'https://api.deepseek.com/v1',
    })
    // Reach into the private field — the alternative (mocking the
    // openai module) is more brittle than this typed escape hatch.
    const inner = (provider as unknown as { client: { baseURL: string } }).client
    expect(inner.baseURL).toBe('https://api.deepseek.com/v1')
  })
})

describe('isTransientError classifier', () => {
  it('flags Premature close as transient (the original motivation)', () => {
    expect(
      isTransientError(
        new Error(
          'Invalid response body while trying to fetch https://api.deepseek.com/v1/chat/completions: Premature close',
        ),
      ),
    ).toBe(true)
  })

  it('flags ECONNRESET / ECONNREFUSED / ETIMEDOUT as transient', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_SOCKET']) {
      const err: Error & { code?: string } = new Error('socket fail')
      err.code = code
      expect(isTransientError(err)).toBe(true)
    }
  })

  it('reads error.cause.code for undici-wrapped errors', () => {
    const err: Error & { cause?: { code?: string } } = new Error('fetch failed')
    err.cause = { code: 'ECONNRESET' }
    expect(isTransientError(err)).toBe(true)
  })

  it('flags 429 and 5xx as transient', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const err: Error & { status?: number } = new Error(`http ${status}`)
      err.status = status
      expect(isTransientError(err)).toBe(true)
    }
  })

  it('does NOT flag 4xx (other than 429) as transient', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const err: Error & { status?: number } = new Error(`http ${status}`)
      err.status = status
      expect(isTransientError(err)).toBe(false)
    }
  })

  it('does NOT flag a generic Error with no recognised marker', () => {
    expect(isTransientError(new Error('your prompt is malformed'))).toBe(false)
  })

  // L3: an AbortController-initiated cancellation surfaces as a
  // DOMException with name='AbortError' and a message like "The
  // operation was aborted". The pre-3.1 regex matched "aborted" and
  // retried — defeating the user's cancel and burning the retry
  // budget. The classifier now short-circuits on AbortError before
  // the regex runs.
  it('does NOT flag AbortError from a deliberate cancellation', () => {
    const err = new Error('The operation was aborted')
    ;(err as Error & { name: string }).name = 'AbortError'
    expect(isTransientError(err)).toBe(false)
  })

  it('does NOT flag DOMException-like aborts via error.cause.name', () => {
    // Undici / fetch wrap the AbortError in a TypeError("fetch failed")
    // with the AbortError on `cause`.
    const err: Error & { cause?: { name?: string; message?: string } } =
      new Error('fetch failed')
    err.cause = { name: 'AbortError', message: 'The operation was aborted' }
    expect(isTransientError(err)).toBe(false)
  })

  it('does NOT flag errors with code ABORT_ERR', () => {
    const err: Error & { code?: string } = new Error('aborted')
    err.code = 'ABORT_ERR'
    expect(isTransientError(err)).toBe(false)
  })

  // Sibling case: a generic Error("aborted") with no AbortError marker
  // is still treated as transient — this matches the undici-surface
  // "aborted" message we got on real DeepSeek socket drops.
  it('still flags a bare Error("aborted") as transient (network-level)', () => {
    expect(isTransientError(new Error('aborted'))).toBe(true)
  })

  it('handles non-Error throwables gracefully', () => {
    expect(isTransientError(undefined)).toBe(false)
    expect(isTransientError(null)).toBe(false)
    expect(isTransientError('string')).toBe(false)
    expect(isTransientError(42)).toBe(false)
    expect(isTransientError({})).toBe(false)
  })
})
