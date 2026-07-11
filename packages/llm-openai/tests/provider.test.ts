import { describe, expect, it, vi } from 'vitest'
import { drainStream, type LlmRequest, type LlmStreamChunk } from '@gotong/llm'

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
    yield {
      choices: [{ delta: {}, finish_reason: choice.finish_reason ?? 'stop' }],
    }
    // Genuine-OpenAI ordering: `stream_options.include_usage` delivers the
    // usage payload on a trailing empty-choices chunk AFTER finish_reason.
    // The provider keeps draining past finish_reason to catch it.
    if (msg.usage) {
      yield { choices: [], usage: msg.usage }
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
    // Genuine OpenAI (`stream_options.include_usage`) sends usage on a
    // trailing EMPTY-choices chunk AFTER finish_reason. The provider must
    // keep draining past finish_reason to catch it, then emit the terminal
    // `usage` → `end` pair (audit P1 regression: a `return` at
    // finish_reason silently dropped streamed usage for genuine OpenAI —
    // DeepSeek's same-chunk quirk masked it on the default provider).
    expect(chunks.map((c) => c.type)).toEqual(['text', 'text', 'usage', 'end'])
    const usageChunk = chunks[2]!
    if (usageChunk.type === 'usage') {
      expect(usageChunk.usage).toEqual({ inputTokens: 7, outputTokens: 4 })
    }
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

/**
 * Phase 9 M3 — multimodal content block translation for OpenAI's
 * chat.completions API. Covers image_url shape (base64 / url /
 * artifact_ref), input_audio shape with model gating, file_ref mime
 * routing, the inline cap, and parallel artifact resolution.
 */
describe('OpenAIProvider — multimodal translation (Phase 9 M3)', () => {
  const SAMPLE_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xab, 0xcd])
  const SAMPLE_PNG_B64 = Buffer.from(SAMPLE_PNG_BYTES).toString('base64')
  const SAMPLE_WAV_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46])
  const SAMPLE_WAV_B64 = Buffer.from(SAMPLE_WAV_BYTES).toString('base64')

  it('translates LlmImageBlock(base64) to image_url with data: URL', async () => {
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })
    await drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image', source: { kind: 'base64', data: SAMPLE_PNG_B64, mime: 'image/png' } },
        ],
      }],
    }))
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const msgs = body.messages as any[]
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toEqual([
      { type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${SAMPLE_PNG_B64}` } },
    ])
  })

  it('translates LlmImageBlock(url) to image_url passing the URL through', async () => {
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })
    await drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { kind: 'url', url: 'https://example.com/cat.png' },
        }],
      }],
    }))
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const msgs = body.messages as any[]
    expect(msgs[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
    ])
  })

  it('resolves artifact_ref image source via the configured artifactResolver', async () => {
    const resolver = vi.fn(async () => ({ bytes: SAMPLE_PNG_BYTES, mime: 'image/png' }))
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({
      client: client as any,
      artifactResolver: resolver,
    })
    await drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { kind: 'artifact_ref', artifactId: 'photos/me.png', mime: 'image/png' },
        }],
      }],
    }))
    expect(resolver).toHaveBeenCalledWith('photos/me.png')
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const msgs = body.messages as any[]
    expect(msgs[0].content[0]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${SAMPLE_PNG_B64}` },
    })
  })

  it('artifact_ref image source without resolver throws', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'never' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })
    await expect(drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { kind: 'artifact_ref', artifactId: 'x', mime: 'image/png' },
        }],
      }],
    }))).rejects.toMatchObject({
      code: 'MULTIMODAL_NOT_SUPPORTED',
      providerName: 'openai',
      blockType: 'image',
    })
  })

  it('keeps pure-text user message as legacy string content (no array wrap)', async () => {
    // OpenAI-compat backends sometimes refuse the array form for plain
    // text. Verify we don't accidentally regress that.
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })
    await drainStream(provider.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const msgs = body.messages as any[]
    expect(msgs[0].content).toBe('hi') // string, not array
  })

  it('audio block on non-audio model throws MultimodalNotSupportedError', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'never' }, finish_reason: 'stop' }],
    }))
    // defaultModel is 'gpt-4o-mini' — no 'audio' in the name.
    const provider = new OpenAIProvider({ client: client as any })
    await expect(drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{
          type: 'audio',
          source: { kind: 'base64', data: SAMPLE_WAV_B64, mime: 'audio/wav' },
          format: 'wav',
        }],
      }],
    }))).rejects.toMatchObject({
      code: 'MULTIMODAL_NOT_SUPPORTED',
      blockType: 'audio',
    })
  })

  it('audio block on audio-capable model translates to input_audio', async () => {
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({
      client: client as any,
      defaultModel: 'gpt-4o-audio-preview',
    })
    await drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{
          type: 'audio',
          source: { kind: 'base64', data: SAMPLE_WAV_B64, mime: 'audio/wav' },
          format: 'wav',
        }],
      }],
    }))
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const msgs = body.messages as any[]
    expect(msgs[0].content[0]).toEqual({
      type: 'input_audio',
      input_audio: { data: SAMPLE_WAV_B64, format: 'wav' },
    })
  })

  it('audio with unsupported format (webm) throws even on audio-capable model', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'never' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({
      client: client as any,
      defaultModel: 'gpt-4o-audio-preview',
    })
    await expect(drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{
          type: 'audio',
          source: { kind: 'base64', data: 'AAAA', mime: 'audio/webm' },
          format: 'webm',
        }],
      }],
    }))).rejects.toMatchObject({
      code: 'MULTIMODAL_NOT_SUPPORTED',
      blockType: 'audio',
    })
  })

  it('audio with url source throws (input_audio is base64-only)', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'never' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({
      client: client as any,
      defaultModel: 'gpt-4o-audio-preview',
    })
    await expect(drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{
          type: 'audio',
          source: { kind: 'url', url: 'https://example.com/clip.wav' },
          format: 'wav',
        }],
      }],
    }))).rejects.toMatchObject({
      code: 'MULTIMODAL_NOT_SUPPORTED',
    })
  })

  it('file_ref with image/* mime routes to image_url', async () => {
    const resolver = vi.fn(async () => ({ bytes: SAMPLE_PNG_BYTES, mime: 'image/png' }))
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({
      client: client as any,
      artifactResolver: resolver,
    })
    await drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{ type: 'file_ref', artifactId: 'uploads/x.png', mime: 'image/png' }],
      }],
    }))
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const msgs = body.messages as any[]
    expect(msgs[0].content[0]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${SAMPLE_PNG_B64}` },
    })
  })

  it('file_ref with audio/* mime routes to input_audio (audio model)', async () => {
    const resolver = vi.fn(async () => ({ bytes: SAMPLE_WAV_BYTES, mime: 'audio/wav' }))
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({
      client: client as any,
      defaultModel: 'gpt-4o-audio-preview',
      artifactResolver: resolver,
    })
    await drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{ type: 'file_ref', artifactId: 'clips/a.wav', mime: 'audio/wav' }],
      }],
    }))
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const msgs = body.messages as any[]
    expect(msgs[0].content[0]).toEqual({
      type: 'input_audio',
      input_audio: { data: SAMPLE_WAV_B64, format: 'wav' },
    })
  })

  it('file_ref with text/* mime routes to text part (single-block collapse → string)', async () => {
    // Single-text-block user messages collapse to legacy string content
    // for compat with older OpenAI-compatible backends (DeepSeek, Qwen,
    // Ollama) that refuse the array form for pure text.
    const resolver = vi.fn(async () => ({
      bytes: new TextEncoder().encode('hello\n你好'),
      mime: 'text/plain',
    }))
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({
      client: client as any,
      artifactResolver: resolver,
    })
    await drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{ type: 'file_ref', artifactId: 'notes/x.txt', mime: 'text/plain' }],
      }],
    }))
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const msgs = body.messages as any[]
    expect(msgs[0].content).toBe('hello\n你好')
  })

  it('file_ref text/* alongside another image block keeps array shape (no collapse)', async () => {
    // When the user message has > 1 content part, we keep the array
    // form even if one of them happens to be text — only the
    // single-block case collapses.
    const resolver = vi.fn(async (id: string) => {
      if (id === 'notes/x.txt') {
        return { bytes: new TextEncoder().encode('inline doc'), mime: 'text/plain' }
      }
      return { bytes: SAMPLE_PNG_BYTES, mime: 'image/png' }
    })
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({
      client: client as any,
      artifactResolver: resolver,
    })
    await drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [
          { type: 'file_ref', artifactId: 'notes/x.txt', mime: 'text/plain' },
          { type: 'file_ref', artifactId: 'photos/x.png', mime: 'image/png' },
        ],
      }],
    }))
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const parts = (body.messages as any[])[0].content
    expect(Array.isArray(parts)).toBe(true)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ type: 'text', text: 'inline doc' })
    expect(parts[1].type).toBe('image_url')
  })

  it('file_ref with application/pdf mime throws', async () => {
    const resolver = vi.fn(async () => ({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      mime: 'application/pdf',
    }))
    const { client } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'never' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({
      client: client as any,
      artifactResolver: resolver,
    })
    await expect(drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{ type: 'file_ref', artifactId: 'docs/x.pdf', mime: 'application/pdf' }],
      }],
    }))).rejects.toMatchObject({
      code: 'MULTIMODAL_NOT_SUPPORTED',
      blockType: 'file_ref',
    })
  })

  it('inline base64 image exceeding maxInlineBytes throws MultimodalInlineSizeError', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'never' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({
      client: client as any,
      maxInlineBytes: 4,
    })
    await expect(drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { kind: 'base64', data: SAMPLE_PNG_B64, mime: 'image/png' }, // 6 bytes
        }],
      }],
    }))).rejects.toMatchObject({
      code: 'MULTIMODAL_NOT_SUPPORTED',
      inlineByteSize: 6,
      capBytes: 4,
    })
  })

  it('image / audio / file_ref blocks on assistant turn throw (OpenAI restriction)', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'never' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })
    await expect(drainStream(provider.stream({
      messages: [{
        role: 'assistant',
        content: [{
          type: 'image',
          source: { kind: 'url', url: 'https://example.com/a.png' },
        }],
      }],
    }))).rejects.toMatchObject({
      code: 'MULTIMODAL_NOT_SUPPORTED',
      blockType: 'image',
    })
  })

  it('mixed text + image preserves order within the content array', async () => {
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })
    await drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'before' },
          { type: 'image', source: { kind: 'url', url: 'https://example.com/a.png' } },
          { type: 'text', text: 'after' },
        ],
      }],
    }))
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const parts = (body.messages as any[])[0].content
    expect(parts.map((p: any) => p.type)).toEqual(['text', 'image_url', 'text'])
    expect(parts[0].text).toBe('before')
    expect(parts[2].text).toBe('after')
  })

  it('parallel artifact_ref resolution within one user message', async () => {
    const finishOrder: string[] = []
    const resolver = vi.fn(async (artifactId: string) => {
      const delay = artifactId === 'a' ? 15 : 1
      await new Promise((r) => setTimeout(r, delay))
      finishOrder.push(artifactId)
      return { bytes: SAMPLE_PNG_BYTES, mime: 'image/png' }
    })
    const { client } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({
      client: client as any,
      artifactResolver: resolver,
    })
    await drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { kind: 'artifact_ref', artifactId: 'a', mime: 'image/png' } },
          { type: 'image', source: { kind: 'artifact_ref', artifactId: 'b', mime: 'image/png' } },
        ],
      }],
    }))
    // b finished first despite a being scheduled first — only possible
    // if both ran concurrently.
    expect(finishOrder).toEqual(['b', 'a'])
  })

  it('tool_result blocks still fan out as separate {role:tool} messages', async () => {
    // Regression: make sure multimodal refactor didn't break the
    // tool-use loop flow. A user turn with tool_result + image should
    // produce a `{role:'tool', ...}` standalone message + a `{role:'user', ...}`
    // message with just the image.
    const { client, create } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))
    const provider = new OpenAIProvider({ client: client as any })
    await drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 't1', content: 'tool ran' },
          { type: 'image', source: { kind: 'url', url: 'https://example.com/x.png' } },
        ],
      }],
    }))
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const msgs = body.messages as any[]
    // Expect 2 messages: one user (with image), one tool (with tool_result).
    // Order is user-first (we unshift the user message) and tool follows.
    const roles = msgs.map((m: any) => m.role)
    expect(roles).toContain('user')
    expect(roles).toContain('tool')
    const userMsg = msgs.find((m: any) => m.role === 'user')!
    expect(Array.isArray(userMsg.content)).toBe(true)
    expect((userMsg.content as any[])[0].type).toBe('image_url')
    const toolMsg = msgs.find((m: any) => m.role === 'tool')!
    expect(toolMsg.tool_call_id).toBe('t1')
    expect(toolMsg.content).toBe('tool ran')
  })
})

/**
 * NA-M1b — OpenAI-side prefix caching is automatic; we only enter the hits
 * into the books. Invariant under test: `LlmUsage.inputTokens` is the FRESH
 * slice (OpenAI's prompt_tokens INCLUDES the cached part → subtract), and
 * `cacheReadTokens` carries the cached slice for the 0.1×-rate pricing lane.
 */
describe('OpenAIProvider — cached prompt tokens entered into the books (NA-M1b)', () => {
  it('OpenAI shape: prompt_tokens_details.cached_tokens splits fresh vs cached', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    }))
    const provider = new OpenAIProvider({ client: client as any, apiKey: 'k' })
    const res = await drainStream(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }))
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 5, cacheReadTokens: 80 })
  })

  it('DeepSeek shape: prompt_cache_hit_tokens splits fresh vs cached', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 3,
        prompt_cache_hit_tokens: 30,
      },
    }))
    const provider = new OpenAIProvider({ client: client as any, apiKey: 'k' })
    const res = await drainStream(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }))
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 3, cacheReadTokens: 30 })
  })

  it('zero / absent cached slice leaves usage untouched (no cacheReadTokens key)', async () => {
    const { client } = makeFakeClient(async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    }))
    const provider = new OpenAIProvider({ client: client as any, apiKey: 'k' })
    const res = await drainStream(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }))
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 2 })
  })
})
