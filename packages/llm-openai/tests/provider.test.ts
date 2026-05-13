import { describe, expect, it, vi } from 'vitest'
import type { LlmRequest } from '@aipehub/llm'

import { OpenAIProvider } from '../src/index.js'

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
