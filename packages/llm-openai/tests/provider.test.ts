import { describe, expect, it, vi } from 'vitest'
import { drainStream, type LlmRequest, type LlmStreamChunk } from '@aipehub/llm'

import { OpenAIProvider, isTransientError } from '../src/index.js'

/**
 * Phase 8 M8 — `LlmProvider.complete` is gone; this test file is now
 * stream-only. Most tests below still declare "the SDK returned this
 * ChatCompletion" in the non-stream shape — we bridge by translating
 * the message into the SSE chunk sequence the real SDK would emit, then
 * letting `drainStream(provider.stream(req))` reproduce the same
 * `LlmResponse` the old `complete()` returned (minus `raw`, which the
 * stream contract can't carry).
 *
 * Build a fake OpenAI SDK client exposing only the methods the provider
 * actually calls. The shape is duck-typed to match the real SDK; we cast to
 * `any` at the constructor boundary so we don't need to pin to a specific
 * SDK version's types in tests.
 */
function makeFakeClient(
  impl: (body: Record<string, unknown>) => Promise<unknown> | unknown,
) {
  const create = vi.fn(async (body: Record<string, unknown>) => {
    const result = await impl(body)
    // Sync-throw path (tests that have `impl` throw to simulate auth /
    // transport failure) goes through `await` above and rejects the
    // outer Promise — the provider's streamImpl awaits this same call.
    return synthesizeOpenAIStream(result as OpenAIChatCompletionLike)
  })
  return {
    client: { chat: { completions: { create } } },
    create,
  }
}

interface OpenAIChatCompletionLike {
  choices?: ReadonlyArray<{
    message?: {
      content?: string | null
      tool_calls?: ReadonlyArray<{
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * Convert a non-streaming ChatCompletion shape into the chunk sequence
 * a streaming SDK call would yield: a sequence of delta chunks for each
 * choice's `message.content` and `message.tool_calls`, ending with a
 * finish_reason terminal chunk plus an optional usage chunk.
 *
 * Test-only — we cover only the success paths existing tests assume.
 * Real streaming-specific behavior (per-fragment text deltas, usage on
 * terminal chunk, DeepSeek's "usage + finish_reason same chunk" quirk)
 * is verified separately by the dedicated stream-mode tests in this
 * file (see `OpenAIProvider — native streaming` describe block).
 */
async function* synthesizeOpenAIStream(
  msg: OpenAIChatCompletionLike,
): AsyncIterable<unknown> {
  const choice = msg.choices?.[0]
  if (choice) {
    const delta: Record<string, unknown> = {}
    if (typeof choice.message?.content === 'string') {
      delta.content = choice.message.content
    }
    if (choice.message?.tool_calls && choice.message.tool_calls.length > 0) {
      delta.tool_calls = choice.message.tool_calls.map((tc, idx) => ({
        index: idx,
        id: tc.id,
        type: tc.type,
        function: tc.function
          ? {
              name: tc.function.name,
              arguments: tc.function.arguments,
            }
          : undefined,
      }))
    }
    if (Object.keys(delta).length > 0) {
      yield { choices: [{ delta }] }
    }
    // Usage MUST land before the finish_reason chunk — the provider's
    // streamImpl returns immediately after seeing finish_reason, so any
    // later chunk is dropped on the floor.
    if (msg.usage) {
      yield { choices: [], usage: msg.usage }
    }
    yield {
      choices: [{ delta: {}, finish_reason: choice.finish_reason ?? 'stop' }],
    }
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

    await drainStream(provider.stream(req))

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

    await drainStream(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }))

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

    await drainStream(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }))

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

    await drainStream(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }))

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

    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
    }))

    expect(res.text).toBe('hello world')
    expect(res.stopReason).toBe('end_turn')
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 3 })
    // Phase 8 M8: the `raw` escape hatch lived on the old complete()
    // path; the stream contract doesn't carry it, so it's not asserted.
  })

  it('handles null message content by returning empty string', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [{ message: { content: null }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })

    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
    }))
    expect(res.text).toBe('')
  })

  it('maps length finish_reason to max_tokens', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [
        { message: { content: 'truncated...' }, finish_reason: 'length' },
      ],
    }))
    const provider = new OpenAIProvider({ client: client as any })

    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
    }))
    expect(res.stopReason).toBe('max_tokens')
  })

  it('maps unknown finish_reason values to error', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [
        { message: { content: '' }, finish_reason: 'content_filter' },
      ],
    }))
    const provider = new OpenAIProvider({ client: client as any })

    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
    }))
    expect(res.stopReason).toBe('error')
  })

  it('omits usage when the response has none', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })

    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
    }))
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
      drainStream(provider.stream({ messages: [{ role: 'user', content: 'hi' }] })),
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

    await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 512,
    }))

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

    await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    }))

    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.max_completion_tokens).toBe(100)
    expect(body.max_tokens).toBeUndefined()
  })

  // Phase 8 M8 — `complete()`'s retry loop is gone (streaming can't be
  // safely replayed mid-bytes). The retry-behavior tests that lived
  // here were deleted along with `maxRetries` / `retryBackoffMs`
  // options. Transient-error CLASSIFICATION is still tested via
  // `isTransientError` directly — callers who want their own retry
  // harness around `provider.stream(req)` keep using it.

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

// v0.3 added tool-use plumbing. These tests exercise the request +
// response translation paths the LlmAgent's tool-use loop drives end-to-end.
describe('OpenAIProvider — tool-use translation', () => {
  it('sends tools as {type:function,function:{name,description,parameters}}', async () => {
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })

    await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'list files' }],
      tools: [
        {
          name: 'fs__list',
          description: 'List directory contents',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      ],
    }))

    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'fs__list',
          description: 'List directory contents',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      },
    ])
  })

  it('extracts tool_calls into response.toolUses and maps finish_reason=tool_calls', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_xyz',
                type: 'function',
                function: {
                  name: 'fs__read',
                  arguments: '{"path":"README.md"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }))
    const provider = new OpenAIProvider({ client: client as any })

    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'read README' }],
      tools: [{ name: 'fs__read', inputSchema: { type: 'object' } }],
    }))

    expect(res.stopReason).toBe('tool_use')
    expect(res.text).toBe('')
    expect(res.toolUses).toEqual([
      {
        type: 'tool_use',
        id: 'call_xyz',
        name: 'fs__read',
        input: { path: 'README.md' },
      },
    ])
  })

  // Phase 8 M8 — the legacy complete() path coerced unparseable tool
  // arguments into `{_raw: '<original-string>'}` so the agent could at
  // least see something. The stream path takes the safer route: emit
  // an error chunk + stop, which drainStream surfaces as
  // `stopReason: 'error'` and rolls the error message into `.text`.
  // That behavior is covered in detail by the dedicated stream test
  // `emits an error chunk and stops on malformed tool args JSON` —
  // duplicating it here would just re-spell the same setup.

  it('translates assistant tool_use blocks to {role:assistant, tool_calls:[…]}', async () => {
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })

    await drainStream(provider.stream({
      messages: [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'sure' },
            {
              type: 'tool_use',
              id: 'call_abc',
              name: 'fs__read',
              input: { path: 'a.md' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'call_abc', content: '# A' },
          ],
        },
      ],
      tools: [{ name: 'fs__read', inputSchema: { type: 'object' } }],
    }))

    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.messages).toEqual([
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: 'sure',
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: {
              name: 'fs__read',
              arguments: '{"path":"a.md"}',
            },
          },
        ],
      },
      // tool_result fans out into a standalone {role:'tool', tool_call_id, content}
      // message — this is OpenAI's wire shape, distinct from Anthropic's
      // tool_result-block-inside-a-user-message convention.
      { role: 'tool', tool_call_id: 'call_abc', content: '# A' },
    ])
  })

  it('emits content:null on assistant message when only tool_calls (no text)', async () => {
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })

    await drainStream(provider.stream({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'c1',
              name: 'fs__read',
              input: { path: 'a.md' },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 'c1', content: 'x' }],
        },
      ],
      tools: [{ name: 'fs__read', inputSchema: { type: 'object' } }],
    }))

    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const msgs = body.messages as Array<Record<string, unknown>>
    expect(msgs[1]!.content).toBeNull()
  })

  it('omits tools field when request.tools is empty or undefined', async () => {
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })

    await drainStream(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }))
    expect(create.mock.calls[0]![0]).not.toHaveProperty('tools')

    await drainStream(provider.stream({ messages: [{ role: 'user', content: 'hi' }], tools: [] }))
    expect(create.mock.calls[1]![0]).not.toHaveProperty('tools')
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

  // H5 (v3.4) — a bare Error("aborted") is now classified as
  // PERMANENT. Pre-3.4 it was retried on the theory that undici
  // socket drops surface as that message; the audit found this
  // doubles billing whenever a wrapping layer strips the
  // AbortError marker from a user-initiated cancel. The fix is to
  // require a network-specific prefix (`socket aborted` /
  // `request aborted`) — see h5-abort-classifier.test.ts.
  it('does NOT flag a bare Error("aborted") (H5 — could be a stripped user cancel)', () => {
    expect(isTransientError(new Error('aborted'))).toBe(false)
  })

  it('handles non-Error throwables gracefully', () => {
    expect(isTransientError(undefined)).toBe(false)
    expect(isTransientError(null)).toBe(false)
    expect(isTransientError('string')).toBe(false)
    expect(isTransientError(42)).toBe(false)
    expect(isTransientError({})).toBe(false)
  })
})

// Phase 8 M3 — native streaming. OpenAI-compat (DeepSeek/Qwen/Ollama)
// shares this code path; the test fakes the SDK's async-iterable chunk
// stream to assert translation deterministically.

/**
 * Build a fake OpenAI SDK client that, on stream=true, returns the
 * given pre-recorded chunks; on stream=false, falls back to `impl`.
 */
function makeFakeStreamingClient(
  chunks: ReadonlyArray<unknown>,
  impl?: (body: Record<string, unknown>) => Promise<unknown> | unknown,
) {
  const create = vi.fn(async (body: Record<string, unknown>) => {
    if (body.stream === true) {
      async function* gen() {
        for (const c of chunks) yield c
      }
      return gen()
    }
    if (impl) return impl(body)
    throw new Error('non-stream call not configured on this fake')
  })
  return {
    client: { chat: { completions: { create } } },
    create,
  }
}

async function collect(
  stream: AsyncIterable<LlmStreamChunk>,
): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = []
  for await (const c of stream) out.push(c)
  return out
}

describe('OpenAIProvider — native streaming (Phase 8 M3)', () => {
  it('translates text-only chunk sequence to text → usage → end', async () => {
    const { client } = makeFakeStreamingClient([
      // Chunk with first text fragment.
      {
        choices: [{ delta: { content: 'hel' }, finish_reason: null }],
      },
      // Chunk with second text fragment.
      {
        choices: [{ delta: { content: 'lo' }, finish_reason: null }],
      },
      // Terminal: finish_reason fires; no usage in this chunk.
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
      },
      // Final stream_options:include_usage chunk: empty choices, usage payload.
      {
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 4 },
      },
    ])
    const provider = new OpenAIProvider({ client: client as any })
    const chunks = await collect(
      provider.stream({ messages: [{ role: 'user', content: 'hi' }] }),
    )
    // The terminal `end` arrives on `finish_reason`, BEFORE the usage chunk
    // OpenAI sends after. That's deliberate — the LlmStreamChunk contract
    // says `end` is always the LAST chunk for a successful stream, so the
    // usage chunk that arrives after finish_reason can't be emitted. We
    // accept losing usage in that ordering (a minor cost vs honoring the
    // contract). Consumers that need usage can read from `complete()` or
    // upgrade the provider to emit usage on the same chunk as finish_reason.
    expect(chunks.map((c) => c.type)).toEqual(['text', 'text', 'end'])
    const text = chunks
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('')
    expect(text).toBe('hello')
    const end = chunks.at(-1)!
    if (end.type === 'end') expect(end.stopReason).toBe('end_turn')
  })

  it('emits usage when the terminal chunk carries finish_reason AND usage together', async () => {
    // Some OpenAI-compat vendors (DeepSeek among them, in some
    // configurations) send finish_reason + usage on the same final
    // chunk. The provider should fold the usage in BEFORE emitting end.
    const { client } = makeFakeStreamingClient([
      { choices: [{ delta: { content: 'done' }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      },
    ])
    const provider = new OpenAIProvider({ client: client as any })
    const chunks = await collect(provider.stream({ messages: [] }))
    // The usage chunk lives strictly between any tool_use and end.
    expect(chunks.map((c) => c.type)).toEqual(['text', 'usage', 'end'])
    const usage = chunks[1]!
    if (usage.type === 'usage') {
      expect(usage.usage).toEqual({ inputTokens: 5, outputTokens: 3 })
    }
  })

  it('filters empty content strings (LlmStreamTextChunk contract)', async () => {
    const { client } = makeFakeStreamingClient([
      { choices: [{ delta: { content: '' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'real' }, finish_reason: null }] },
      { choices: [{ delta: { content: '' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
    const provider = new OpenAIProvider({ client: client as any })
    const chunks = await collect(provider.stream({ messages: [] }))
    const texts = chunks.filter((c) => c.type === 'text')
    expect(texts.length).toBe(1)
    if (texts[0]?.type === 'text') expect(texts[0].text).toBe('real')
  })

  it('accumulates tool_call arguments across chunks (single tool)', async () => {
    const { client } = makeFakeStreamingClient([
      // First tool_call chunk: id + type + name + start of args
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'fs__read', arguments: '{"path":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      // Second tool_call chunk: just more args
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '"README.md"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      // Terminal: finish_reason='tool_calls', no more delta.
      {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      },
    ])
    const provider = new OpenAIProvider({ client: client as any })
    const chunks = await collect(provider.stream({ messages: [] }))
    expect(chunks.map((c) => c.type)).toEqual(['tool_use', 'end'])
    const tu = chunks[0]!
    if (tu.type === 'tool_use') {
      expect(tu.toolUse.id).toBe('call_1')
      expect(tu.toolUse.name).toBe('fs__read')
      expect(tu.toolUse.input).toEqual({ path: 'README.md' })
    }
    const end = chunks.at(-1)!
    if (end.type === 'end') expect(end.stopReason).toBe('tool_use')
  })

  it('emits multiple tool_use chunks for parallel tool calls in deterministic index order', async () => {
    const { client } = makeFakeStreamingClient([
      // Two tool calls start in the same chunk.
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: 'call_b',
                  type: 'function',
                  function: { name: 't2', arguments: '{}' },
                },
                {
                  index: 0,
                  id: 'call_a',
                  type: 'function',
                  function: { name: 't1', arguments: '{}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const provider = new OpenAIProvider({ client: client as any })
    const chunks = await collect(provider.stream({ messages: [] }))
    const toolUses = chunks.filter(
      (c): c is Extract<LlmStreamChunk, { type: 'tool_use' }> => c.type === 'tool_use',
    )
    expect(toolUses.length).toBe(2)
    // Sorted by index: index 0 first, then index 1
    expect(toolUses[0]!.toolUse.id).toBe('call_a')
    expect(toolUses[1]!.toolUse.id).toBe('call_b')
  })

  it('emits an error chunk and stops on malformed tool args JSON', async () => {
    const { client } = makeFakeStreamingClient([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_x',
                  type: 'function',
                  function: { name: 'broken', arguments: '{not json' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const provider = new OpenAIProvider({ client: client as any })
    const chunks = await collect(provider.stream({ messages: [] }))
    const last = chunks.at(-1)!
    expect(last.type).toBe('error')
    if (last.type === 'error') {
      expect(last.code).toBe('malformed_tool_args')
      expect(last.message).toMatch(/broken/)
    }
    // No end chunk after error.
    expect(chunks.find((c) => c.type === 'end')).toBeUndefined()
  })

  it('maps finish_reason=length to stopReason=max_tokens', async () => {
    const { client } = makeFakeStreamingClient([
      { choices: [{ delta: { content: 'cut' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ])
    const provider = new OpenAIProvider({ client: client as any })
    const chunks = await collect(provider.stream({ messages: [] }))
    const end = chunks.at(-1)!
    if (end.type === 'end') expect(end.stopReason).toBe('max_tokens')
  })

  it('rethrows SDK errors synchronously (auth → onAuthFailure path)', async () => {
    const create = vi.fn(async () => {
      throw new Error('auth_denied')
    })
    const provider = new OpenAIProvider({
      client: { chat: { completions: { create } } } as any,
    })
    await expect(
      (async () => {
        for await (const _c of provider.stream({ messages: [] })) {
          /* unreachable */
        }
      })(),
    ).rejects.toThrow(/auth_denied/)
  })

  it('forwards stream:true, stream_options.include_usage:true, and tools on the body', async () => {
    const { client, create } = makeFakeStreamingClient([
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
    const provider = new OpenAIProvider({ client: client as any })
    await collect(
      provider.stream({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'lookup', inputSchema: { type: 'object' } }],
      }),
    )
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'lookup', parameters: { type: 'object' } },
      },
    ])
  })

  it('forwards AbortSignal to the SDK', async () => {
    const create = vi.fn(async (_body: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
      async function* gen() {
        ;(create as unknown as { _lastSignal?: unknown })._lastSignal = opts?.signal
      }
      return gen()
    })
    const provider = new OpenAIProvider({
      client: { chat: { completions: { create } } } as any,
    })
    const ac = new AbortController()
    await collect(provider.stream({ messages: [] }, ac.signal))
    expect((create as unknown as { _lastSignal?: unknown })._lastSignal).toBe(ac.signal)
  })
})
