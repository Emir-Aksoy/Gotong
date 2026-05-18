import { describe, expect, it, vi } from 'vitest'
import type { LlmRequest } from '@aipehub/llm'

import { AnthropicProvider } from '../src/index.js'

/**
 * Build a fake Anthropic SDK client exposing only the methods the provider
 * actually calls. The shape is duck-typed to match the real SDK; we cast to
 * `any` at the constructor boundary so we don't need to pin to a specific
 * SDK version's types in tests.
 */
function makeFakeClient(
  impl: (body: Record<string, unknown>) => Promise<unknown> | unknown,
) {
  const create = vi.fn(async (body: Record<string, unknown>) => impl(body))
  return {
    client: { messages: { create } },
    create,
  }
}

describe('AnthropicProvider — request translation', () => {
  it('forwards system, messages, maxTokens, temperature, model verbatim', async () => {
    const { client, create } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }))
    const provider = new AnthropicProvider({ client: client as any })

    const req: LlmRequest = {
      system: 'You are a poet.',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'go on' },
      ],
      maxTokens: 256,
      temperature: 0.3,
      model: 'claude-3-5-sonnet-latest',
    }

    await provider.complete(req)

    expect(create).toHaveBeenCalledTimes(1)
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.system).toBe('You are a poet.')
    expect(body.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'go on' },
    ])
    expect(body.max_tokens).toBe(256)
    expect(body.temperature).toBe(0.3)
    expect(body.model).toBe('claude-3-5-sonnet-latest')
  })

  it('falls back to defaultModel and defaultMaxTokens when request omits them', async () => {
    const { client, create } = makeFakeClient(async () => ({
      content: [],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({
      client: client as any,
      defaultModel: 'claude-default',
      defaultMaxTokens: 42,
    })

    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] })

    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.model).toBe('claude-default')
    expect(body.max_tokens).toBe(42)
    expect(body.system).toBeUndefined()
    expect(body.temperature).toBeUndefined()
  })

  it('uses built-in defaults when constructor opts omit them', async () => {
    const { client, create } = makeFakeClient(async () => ({
      content: [],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any })

    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] })

    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.model).toBe('claude-opus-4-7')
    expect(body.max_tokens).toBe(1024)
  })
})

describe('AnthropicProvider — response translation', () => {
  it('concatenates all text blocks and ignores non-text content', async () => {
    const { client } = makeFakeClient(async () => ({
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'tool_use', id: 'x', name: 'noop', input: {} },
        { type: 'text', text: 'world' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    }))
    const provider = new AnthropicProvider({ client: client as any })

    const res = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(res.text).toBe('hello world')
    expect(res.stopReason).toBe('end_turn')
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 3 })
    expect(res.raw).toBeDefined()
  })

  it('maps stop_sequence to end_turn', async () => {
    const { client } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'stop_sequence',
    }))
    const provider = new AnthropicProvider({ client: client as any })

    const res = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.stopReason).toBe('end_turn')
  })

  it('maps max_tokens stop_reason to max_tokens', async () => {
    const { client } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'truncated...' }],
      stop_reason: 'max_tokens',
    }))
    const provider = new AnthropicProvider({ client: client as any })

    const res = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.stopReason).toBe('max_tokens')
  })

  it('maps unknown stop_reason values to error', async () => {
    const { client } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: '' }],
      stop_reason: 'tool_use',
    }))
    const provider = new AnthropicProvider({ client: client as any })

    const res = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.stopReason).toBe('error')
  })

  // L2: when prompt caching is in use, Anthropic returns
  // `cache_creation_input_tokens` + `cache_read_input_tokens` alongside
  // a smaller `input_tokens` (the FRESH slice). Pre-v3.1 the provider
  // dropped the cache fields and exposed only `input_tokens`, causing
  // downstream billing code to undercount the prompt by 10–100x on
  // long system prompts. Now both cache fields surface.
  it('surfaces cache_creation_input_tokens and cache_read_input_tokens', async () => {
    const { client } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        cache_creation_input_tokens: 1500,
        cache_read_input_tokens: 8000,
      },
    }))
    const provider = new AnthropicProvider({ client: client as any })
    const res = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.usage).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      cacheCreationTokens: 1500,
      cacheReadTokens: 8000,
    })
  })

  it('omits cache fields when zero (clean snapshot for non-cached calls)', async () => {
    const { client } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 50,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }))
    const provider = new AnthropicProvider({ client: client as any })
    const res = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 10 })
  })

  it('omits usage when the response has none', async () => {
    const { client } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any })

    const res = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.usage).toBeUndefined()
  })

  it('exposes provider name', () => {
    const provider = new AnthropicProvider({ client: {} as any })
    expect(provider.name).toBe('anthropic')
  })
})

// L1: opus-4.x ("thinking") models reject `temperature` outright.
// The provider used to forward the parameter and the API returned
// 400, silently breaking every existing caller that had a temperature
// in their request. Now we drop the param when the target model is in
// the thinking family.
describe('AnthropicProvider — temperature handling for thinking models', () => {
  it('drops temperature when targeting claude-opus-4-7 (default model)', async () => {
    const { client, create } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any })
    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
    })
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.temperature).toBeUndefined()
    expect(body.model).toBe('claude-opus-4-7')
  })

  it('drops temperature when targeting any claude-opus-4-* model', async () => {
    const { client, create } = makeFakeClient(async () => ({
      content: [],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any })
    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-opus-4-9',
      temperature: 0.7,
    })
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.temperature).toBeUndefined()
  })

  it('keeps temperature for non-thinking models', async () => {
    const { client, create } = makeFakeClient(async () => ({
      content: [],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any })
    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-sonnet-4-6',
      temperature: 0.3,
    })
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.temperature).toBe(0.3)
  })
})

describe('AnthropicProvider — error propagation', () => {
  it('rethrows SDK errors so LlmAgent maps to failed TaskResult', async () => {
    const { client } = makeFakeClient(async () => {
      throw new Error('auth_denied')
    })
    const provider = new AnthropicProvider({ client: client as any })

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('auth_denied')
  })
})
