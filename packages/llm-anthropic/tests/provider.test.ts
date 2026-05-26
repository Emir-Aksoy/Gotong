import { describe, expect, it, vi } from 'vitest'
import { drainStream, type LlmRequest, type LlmStreamChunk } from '@aipehub/llm'

import { AnthropicProvider } from '../src/index.js'

/**
 * Phase 8 M8 — `LlmProvider.complete` is gone. Most of the tests below
 * still describe themselves in terms of "translate this Anthropic
 * response object" because that's the easiest way to specify wire
 * behavior at a glance — even though under the hood the provider now
 * only speaks streaming. We bridge by translating a non-stream-shaped
 * `AnthropicMessageLike` into the SSE event sequence the real SDK
 * would emit for the same final message, then letting `provider.stream`
 * + `drainStream` reproduce the same `LlmResponse` the old `complete()`
 * would have returned (minus the `raw` field, which can't survive
 * the stream contract).
 *
 * Build a fake Anthropic SDK client exposing only the methods the provider
 * actually calls. The shape is duck-typed to match the real SDK; we cast to
 * `any` at the constructor boundary so we don't need to pin to a specific
 * SDK version's types in tests.
 */
function makeFakeClient(
  impl: (body: Record<string, unknown>) => Promise<unknown> | unknown,
) {
  const create = vi.fn(async (body: Record<string, unknown>) => {
    const msg = (await impl(body)) as AnthropicMessageLike
    // We always stream — the production code path doesn't have a non-stream
    // mode any more, so if a test ever sends body.stream=false something
    // is wrong elsewhere.
    return synthesizeAnthropicStream(msg)
  })
  return {
    client: { messages: { create } },
    create,
  }
}

interface AnthropicMessageLike {
  content?: ReadonlyArray<{
    type: string
    text?: string
    id?: string
    name?: string
    input?: unknown
  }>
  stop_reason?: string | null
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

/**
 * Convert a non-streaming Anthropic message shape into the SSE-event
 * sequence the real SDK would emit. Used by `makeFakeClient` so tests
 * can keep declaring "the model returned this message" instead of
 * hand-rolling event sequences for every case.
 *
 * NOTE: this is a *test-only* helper. It deliberately does NOT cover
 * malformed-JSON-args paths or other adversarial scenarios — those
 * live in the dedicated streaming tests that build SSE event lists
 * directly via `makeFakeStreamingClient`.
 */
async function* synthesizeAnthropicStream(
  msg: AnthropicMessageLike,
): AsyncIterable<unknown> {
  const startUsage: Record<string, unknown> = {}
  if (msg.usage) {
    startUsage.input_tokens = msg.usage.input_tokens
    startUsage.output_tokens = 0
    if (msg.usage.cache_creation_input_tokens !== undefined) {
      startUsage.cache_creation_input_tokens = msg.usage.cache_creation_input_tokens
    }
    if (msg.usage.cache_read_input_tokens !== undefined) {
      startUsage.cache_read_input_tokens = msg.usage.cache_read_input_tokens
    }
  }
  yield { type: 'message_start', message: { usage: startUsage } }
  for (const block of msg.content ?? []) {
    if (block.type === 'text') {
      yield { type: 'content_block_start', content_block: { type: 'text' } }
      if (typeof block.text === 'string' && block.text.length > 0) {
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: block.text },
        }
      }
      yield { type: 'content_block_stop' }
    } else if (block.type === 'tool_use') {
      yield {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: block.id, name: block.name },
      }
      // Anthropic's streamer emits input as input_json_delta fragments;
      // we send the whole thing in one delta. The streamImpl in
      // provider.ts re-parses it, so non-object inputs (arrays /
      // strings) round-trip into `{}` via the same coercion path the
      // production code uses.
      if (block.input !== undefined && block.input !== null) {
        const serialized = JSON.stringify(block.input)
        if (serialized.length > 0 && serialized !== '{}') {
          yield {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: serialized },
          }
        }
      }
      yield { type: 'content_block_stop' }
    }
  }
  const delta: Record<string, unknown> = {}
  if (msg.stop_reason !== undefined && msg.stop_reason !== null) {
    delta.stop_reason = msg.stop_reason
  }
  const finalUsage: Record<string, unknown> = msg.usage
    ? { output_tokens: msg.usage.output_tokens }
    : {}
  yield { type: 'message_delta', delta, usage: finalUsage }
  yield { type: 'message_stop' }
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

    await drainStream(provider.stream(req))

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

    await drainStream(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }))

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

    await drainStream(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }))

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

    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
    }))

    expect(res.text).toBe('hello world')
    expect(res.stopReason).toBe('end_turn')
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 3 })
    // Phase 8 M8: `raw` was the escape hatch on the old complete() path;
    // the stream contract doesn't carry it, so we don't assert it any more.
  })

  it('maps stop_sequence to end_turn', async () => {
    const { client } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'stop_sequence',
    }))
    const provider = new AnthropicProvider({ client: client as any })

    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
    }))
    expect(res.stopReason).toBe('end_turn')
  })

  it('maps max_tokens stop_reason to max_tokens', async () => {
    const { client } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'truncated...' }],
      stop_reason: 'max_tokens',
    }))
    const provider = new AnthropicProvider({ client: client as any })

    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
    }))
    expect(res.stopReason).toBe('max_tokens')
  })

  it('maps unknown stop_reason values to error', async () => {
    // v0.3 made `tool_use` a known stop reason — use a value Anthropic
    // hasn't introduced yet (e.g. `pause_turn`) to exercise the
    // unknown-fallback branch.
    const { client } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: '' }],
      stop_reason: 'pause_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any })

    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
    }))
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
    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
    }))
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
    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
    }))
    expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 10 })
  })

  it('still emits a usage chunk (zeroed) when the response carries no usage data', async () => {
    // Phase 8 M8 — the streaming code path always coalesces a usage
    // chunk on message_stop, even if every counter is zero. This is
    // different from the old complete()'s behavior (which omitted
    // .usage entirely when the SDK message had none) but it's the
    // more honest shape for a stream: a usage chunk arrived, we
    // forward it. Accounting code that wants to skip zero-token
    // usage can do so at the consumer.
    const { client } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any })

    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
    }))
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
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
    await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
    }))
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
    await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-opus-4-9',
      temperature: 0.7,
    }))
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.temperature).toBeUndefined()
  })

  it('keeps temperature for non-thinking models', async () => {
    const { client, create } = makeFakeClient(async () => ({
      content: [],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any })
    await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-sonnet-4-6',
      temperature: 0.3,
    }))
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.temperature).toBe(0.3)
  })
})

// Phase 8 M2 — native streaming. The provider speaks the SDK's
// SSE event vocabulary (message_start / content_block_start /
// content_block_delta / content_block_stop / message_delta /
// message_stop) and translates it into LlmStreamChunk. These
// tests fake the SDK's async-iterable so we can assert the
// translation deterministically without a live network.

/**
 * Build a fake Anthropic SDK client that, on stream=true, returns the
 * given pre-recorded SSE events; on stream=false, falls back to the
 * non-stream `impl`. Mirrors the dual call shape AnthropicProvider
 * uses internally.
 */
function makeFakeStreamingClient(
  events: ReadonlyArray<unknown>,
  impl?: (body: Record<string, unknown>) => Promise<unknown> | unknown,
) {
  const create = vi.fn(async (body: Record<string, unknown>) => {
    if (body.stream === true) {
      async function* gen() {
        for (const ev of events) yield ev
      }
      return gen()
    }
    if (impl) return impl(body)
    throw new Error('non-stream call not configured on this fake')
  })
  return { client: { messages: { create } }, create }
}

async function collect(
  stream: AsyncIterable<LlmStreamChunk>,
): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = []
  for await (const c of stream) out.push(c)
  return out
}

describe('AnthropicProvider — native streaming (Phase 8 M2)', () => {
  it('translates text-only SSE sequence to text → usage → end', async () => {
    const { client } = makeFakeStreamingClient([
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello ' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } },
      { type: 'content_block_stop' },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
      { type: 'message_stop' },
    ])
    const provider = new AnthropicProvider({ client: client as any })
    const chunks = await collect(
      provider.stream({ messages: [{ role: 'user', content: 'hi' }] }),
    )
    // Type sequence
    expect(chunks.map((c) => c.type)).toEqual(['text', 'text', 'usage', 'end'])
    // Concatenated text reproduces the response
    const text = chunks
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('')
    expect(text).toBe('hello world')
    // Usage carries both halves (input from message_start, output from message_delta)
    const usage = chunks[2]!
    expect(usage.type).toBe('usage')
    if (usage.type === 'usage') {
      expect(usage.usage.inputTokens).toBe(5)
      expect(usage.usage.outputTokens).toBe(8)
    }
    // Terminal end carries the mapped stopReason
    const end = chunks.at(-1)!
    if (end.type === 'end') expect(end.stopReason).toBe('end_turn')
  })

  it('filters empty text_delta strings (LlmStreamTextChunk contract)', async () => {
    const { client } = makeFakeStreamingClient([
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'real' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } },
      { type: 'content_block_stop' },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ])
    const provider = new AnthropicProvider({ client: client as any })
    const chunks = await collect(provider.stream({ messages: [] }))
    const texts = chunks.filter((c) => c.type === 'text')
    expect(texts.length).toBe(1)
    if (texts[0]?.type === 'text') expect(texts[0].text).toBe('real')
  })

  it('passes prompt-cache usage fields through (creation + read)', async () => {
    const { client } = makeFakeStreamingClient([
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 20,
            output_tokens: 0,
            cache_creation_input_tokens: 1500,
            cache_read_input_tokens: 8000,
          },
        },
      },
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop' },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ])
    const provider = new AnthropicProvider({ client: client as any })
    const chunks = await collect(provider.stream({ messages: [] }))
    const usage = chunks.find((c) => c.type === 'usage')!
    if (usage.type === 'usage') {
      expect(usage.usage).toEqual({
        inputTokens: 20,
        outputTokens: 5,
        cacheCreationTokens: 1500,
        cacheReadTokens: 8000,
      })
    }
  })

  it('accumulates input_json_delta into a single tool_use chunk with parsed input', async () => {
    const { client } = makeFakeStreamingClient([
      { type: 'message_start', message: { usage: { input_tokens: 30 } } },
      // Anthropic streams: optional assistant text BEFORE the tool block.
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'let me check' } },
      { type: 'content_block_stop' },
      // Then a tool_use block, with its args JSON arriving in fragments.
      {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'toolu_x', name: 'fs__read' },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '"README.md"}' },
      },
      { type: 'content_block_stop' },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ])
    const provider = new AnthropicProvider({ client: client as any })
    const chunks = await collect(provider.stream({ messages: [] }))
    // Sequence: text → tool_use → usage → end
    expect(chunks.map((c) => c.type)).toEqual(['text', 'tool_use', 'usage', 'end'])
    const tu = chunks[1]!
    if (tu.type === 'tool_use') {
      expect(tu.toolUse.id).toBe('toolu_x')
      expect(tu.toolUse.name).toBe('fs__read')
      expect(tu.toolUse.input).toEqual({ path: 'README.md' })
    }
    const end = chunks.at(-1)!
    if (end.type === 'end') expect(end.stopReason).toBe('tool_use')
  })

  it('emits an error chunk and stops on malformed tool args JSON', async () => {
    const { client } = makeFakeStreamingClient([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'toolu_y', name: 'broken' },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{not json' },
      },
      { type: 'content_block_stop' },
      // The provider must stop BEFORE seeing message_delta.
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ])
    const provider = new AnthropicProvider({ client: client as any })
    const chunks = await collect(provider.stream({ messages: [] }))
    const last = chunks.at(-1)!
    expect(last.type).toBe('error')
    if (last.type === 'error') {
      expect(last.code).toBe('malformed_tool_args')
      expect(last.message).toMatch(/broken/)
    }
    // And no `end` after the error — the iterator returned early.
    expect(chunks.find((c) => c.type === 'end')).toBeUndefined()
  })

  it('handles tool_use with empty input (model called the tool with no args)', async () => {
    const { client } = makeFakeStreamingClient([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 't1', name: 'noop' },
      },
      // No input_json_delta events at all.
      { type: 'content_block_stop' },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ])
    const provider = new AnthropicProvider({ client: client as any })
    const chunks = await collect(provider.stream({ messages: [] }))
    const tu = chunks.find((c) => c.type === 'tool_use')!
    if (tu.type === 'tool_use') expect(tu.toolUse.input).toEqual({})
  })

  it('rethrows SDK errors synchronously (auth → onAuthFailure path)', async () => {
    const create = vi.fn(async () => {
      throw new Error('auth_denied')
    })
    const provider = new AnthropicProvider({
      client: { messages: { create } } as any,
    })
    // First `.next()` (or first await) on the iterator must surface
    // the SDK throw — mirrors how a real Anthropic 401 would behave.
    await expect(
      (async () => {
        for await (const _c of provider.stream({ messages: [] })) {
          /* unreachable */
        }
      })(),
    ).rejects.toThrow(/auth_denied/)
  })

  it('forwards stream:true and the tools translation on the body', async () => {
    const { client, create } = makeFakeStreamingClient([
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ])
    const provider = new AnthropicProvider({ client: client as any })
    await collect(
      provider.stream({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'lookup',
            inputSchema: { type: 'object' },
          },
        ],
      }),
    )
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(body.tools).toEqual([
      { name: 'lookup', input_schema: { type: 'object' } },
    ])
  })

  it('forwards AbortSignal to the SDK', async () => {
    const create = vi.fn(async (_body: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
      // Echo back so we can assert. Yield nothing → defensive end is emitted.
      async function* gen() {
        // attach an assertion hook
        ;(create as unknown as { _lastSignal?: unknown })._lastSignal = opts?.signal
      }
      return gen()
    })
    const provider = new AnthropicProvider({
      client: { messages: { create } } as any,
    })
    const ac = new AbortController()
    await collect(provider.stream({ messages: [] }, ac.signal))
    expect((create as unknown as { _lastSignal?: unknown })._lastSignal).toBe(ac.signal)
  })
})

describe('AnthropicProvider — error propagation', () => {
  it('rethrows SDK errors so LlmAgent maps to failed TaskResult', async () => {
    const { client } = makeFakeClient(async () => {
      throw new Error('auth_denied')
    })
    const provider = new AnthropicProvider({ client: client as any })

    await expect(
      drainStream(provider.stream({ messages: [{ role: 'user', content: 'hi' }] })),
    ).rejects.toThrow('auth_denied')
  })
})

// v0.3 added tool-use plumbing. These tests exercise the request +
// response translation paths the LlmAgent's tool-use loop drives end-to-end.
describe('AnthropicProvider — tool-use translation', () => {
  it('sends tools with input_schema (snake_case for the wire)', async () => {
    const { client, create } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any })

    await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'read README' }],
      tools: [
        {
          name: 'fs__read_file',
          description: 'Read a file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    }))

    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.tools).toEqual([
      {
        name: 'fs__read_file',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
    ])
  })

  it('omits tools field when request.tools is empty or undefined', async () => {
    const { client, create } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any })

    await drainStream(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }))
    const body1 = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body1).not.toHaveProperty('tools')

    await drainStream(provider.stream({ messages: [{ role: 'user', content: 'hi' }], tools: [] }))
    const body2 = create.mock.calls[1]![0] as Record<string, unknown>
    expect(body2).not.toHaveProperty('tools')
  })

  it('extracts tool_use blocks into response.toolUses + maps stop_reason', async () => {
    const { client } = makeFakeClient(async () => ({
      content: [
        { type: 'text', text: 'let me check that file' },
        {
          type: 'tool_use',
          id: 'toolu_01abc',
          name: 'fs__read_file',
          input: { path: 'README.md' },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 30, output_tokens: 20 },
    }))
    const provider = new AnthropicProvider({ client: client as any })

    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'read README' }],
      tools: [
        {
          name: 'fs__read_file',
          inputSchema: { type: 'object' },
        },
      ],
    }))

    expect(res.stopReason).toBe('tool_use')
    expect(res.text).toBe('let me check that file')
    expect(res.toolUses).toEqual([
      {
        type: 'tool_use',
        id: 'toolu_01abc',
        name: 'fs__read_file',
        input: { path: 'README.md' },
      },
    ])
  })

  it('coerces malformed tool_use.input into an empty object rather than passing junk through', async () => {
    const { client } = makeFakeClient(async () => ({
      content: [
        // SDK is forgiving and would normally produce {} here; the
        // provider guards against pathological responses too.
        { type: 'tool_use', id: 't1', name: 'fs__list', input: ['oops', 'array'] },
        { type: 'tool_use', id: 't2', name: 'fs__list', input: 'string-not-object' },
      ],
      stop_reason: 'tool_use',
    }))
    const provider = new AnthropicProvider({ client: client as any })

    const res = await drainStream(provider.stream({
      messages: [{ role: 'user', content: 'list' }],
      tools: [{ name: 'fs__list', inputSchema: { type: 'object' } }],
    }))

    expect(res.toolUses?.[0]!.input).toEqual({})
    expect(res.toolUses?.[1]!.input).toEqual({})
  })

  it('translates assistant tool_use blocks + user tool_result blocks to Anthropic wire shape', async () => {
    const { client, create } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'all done' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any })

    await drainStream(provider.stream({
      messages: [
        { role: 'user', content: 'read README' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'on it' },
            {
              type: 'tool_use',
              id: 'toolu_01abc',
              name: 'fs__read_file',
              input: { path: 'README.md' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: 'toolu_01abc',
              content: '# AipeHub\n…',
            },
          ],
        },
      ],
      tools: [{ name: 'fs__read_file', inputSchema: { type: 'object' } }],
    }))

    const body = create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.messages).toEqual([
      { role: 'user', content: 'read README' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'on it' },
          {
            type: 'tool_use',
            id: 'toolu_01abc',
            name: 'fs__read_file',
            input: { path: 'README.md' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01abc',
            content: '# AipeHub\n…',
          },
        ],
      },
    ])
  })

  it('forwards isError on tool_result blocks (snake_case is_error on the wire)', async () => {
    const { client, create } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'noted' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any })

    await drainStream(provider.stream({
      messages: [
        { role: 'user', content: 'do thing' },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: 't1',
              content: 'ENOENT',
              isError: true,
            },
          ],
        },
      ],
      tools: [{ name: 'fs__read', inputSchema: { type: 'object' } }],
    }))

    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const msgs = body.messages as Array<Record<string, unknown>>
    const toolResultBlock = (msgs[1]!.content as Array<Record<string, unknown>>)[0]!
    expect(toolResultBlock.tool_use_id).toBe('t1')
    expect(toolResultBlock.is_error).toBe(true)
    expect(toolResultBlock.content).toBe('ENOENT')
  })
})

/**
 * Phase 9 M2 — multimodal content block translation. Covers all three
 * source kinds (base64 / url / artifact_ref) for LlmImageBlock, the
 * audio rejection path, file_ref mime routing, the inline cap, and
 * the parallel-resolution behavior.
 */
describe('AnthropicProvider — multimodal translation (Phase 9 M2)', () => {
  // Helper: tiny inline PNG bytes for tests. We don't need a real PNG —
  // just a couple of non-utf-8 bytes to prove the bytes survive a round
  // trip through base64.
  const SAMPLE_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xab, 0xcd])
  // 'iVBORw==' is 'iVBORw' + '==' padding — corresponds to <0x89 0x50 0x46>
  // Let me precompute the actual b64 for SAMPLE_PNG_BYTES:
  //   bytes: 89 50 4E 47 AB CD = 6 bytes → exactly 8 b64 chars no padding
  const SAMPLE_PNG_B64 = Buffer.from(SAMPLE_PNG_BYTES).toString('base64')

  it('translates LlmImageBlock with base64 source to vision API shape', async () => {
    const { client, create } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'I see a tiny PNG' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any })
    await drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          {
            type: 'image',
            source: { kind: 'base64', data: SAMPLE_PNG_B64, mime: 'image/png' },
          },
        ],
      }],
    }))
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const msgs = body.messages as Array<Record<string, unknown>>
    const blocks = msgs[0]!.content as Array<Record<string, unknown>>
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'text', text: 'what is this?' })
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: SAMPLE_PNG_B64 },
    })
  })

  it('translates LlmImageBlock with url source to url-shaped Anthropic image', async () => {
    const { client, create } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any })
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
    const msgs = body.messages as Array<Record<string, unknown>>
    const blocks = msgs[0]!.content as Array<Record<string, unknown>>
    expect(blocks[0]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/cat.png' },
    })
  })

  it('strips RFC 2045 soft-wrap whitespace before sending base64 to vendor', async () => {
    const { client, create } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any })
    const wrapped = SAMPLE_PNG_B64.split('').join('\n  ')
    await drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { kind: 'base64', data: wrapped, mime: 'image/jpeg' },
        }],
      }],
    }))
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const blocks = (body.messages as any[])[0].content
    expect(blocks[0].source.data).toBe(SAMPLE_PNG_B64) // wire bytes are clean
    expect(blocks[0].source.media_type).toBe('image/jpeg')
  })

  it('resolves artifact_ref source via the configured artifactResolver and base64-encodes', async () => {
    const resolver = vi.fn(async (artifactId: string) => {
      expect(artifactId).toBe('photos/me.png')
      return { bytes: SAMPLE_PNG_BYTES, mime: 'image/png' }
    })
    const { client, create } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({
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
    expect(resolver).toHaveBeenCalledTimes(1)
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const blocks = (body.messages as any[])[0].content
    expect(blocks[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: SAMPLE_PNG_B64 },
    })
  })

  it('artifact_ref source without a resolver throws MultimodalNotSupportedError', async () => {
    const { client } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any }) // no resolver
    await expect(drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { kind: 'artifact_ref', artifactId: 'photos/me.png', mime: 'image/png' },
        }],
      }],
    }))).rejects.toMatchObject({
      code: 'MULTIMODAL_NOT_SUPPORTED',
      providerName: 'anthropic',
      blockType: 'image',
    })
  })

  it('audio block throws MultimodalNotSupportedError (Anthropic has no audio API)', async () => {
    const { client } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'never' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any })
    await expect(drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{
          type: 'audio',
          source: { kind: 'base64', data: 'AAAA', mime: 'audio/wav' },
        }],
      }],
    }))).rejects.toMatchObject({
      code: 'MULTIMODAL_NOT_SUPPORTED',
      providerName: 'anthropic',
      blockType: 'audio',
    })
  })

  it('file_ref with image/* mime routes through artifactResolver as an image block', async () => {
    const resolver = vi.fn(async () => ({
      bytes: SAMPLE_PNG_BYTES,
      mime: 'image/png',
    }))
    const { client, create } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({
      client: client as any,
      artifactResolver: resolver,
    })
    await drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{
          type: 'file_ref',
          artifactId: 'uploads/x.png',
          mime: 'image/png',
        }],
      }],
    }))
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const blocks = (body.messages as any[])[0].content
    expect(blocks[0].type).toBe('image')
    expect(blocks[0].source.media_type).toBe('image/png')
    expect(blocks[0].source.data).toBe(SAMPLE_PNG_B64)
  })

  it('file_ref with text/* mime is rendered as a text block (utf-8 decoded)', async () => {
    const resolver = vi.fn(async () => ({
      bytes: new TextEncoder().encode('# notes\n你好'),
      mime: 'text/markdown',
    }))
    const { client, create } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({
      client: client as any,
      artifactResolver: resolver,
    })
    await drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{
          type: 'file_ref',
          artifactId: 'notes/q1.md',
          mime: 'text/markdown',
        }],
      }],
    }))
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const blocks = (body.messages as any[])[0].content
    expect(blocks[0]).toEqual({ type: 'text', text: '# notes\n你好' })
  })

  it('file_ref with application/json mime is rendered as text', async () => {
    const resolver = vi.fn(async () => ({
      bytes: new TextEncoder().encode('{"a":1}'),
      mime: 'application/json',
    }))
    const { client, create } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({
      client: client as any,
      artifactResolver: resolver,
    })
    await drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{
          type: 'file_ref',
          artifactId: 'data/x.json',
          mime: 'application/json',
        }],
      }],
    }))
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const blocks = (body.messages as any[])[0].content
    expect(blocks[0]).toEqual({ type: 'text', text: '{"a":1}' })
  })

  it('file_ref with unsupported mime (e.g. application/pdf) throws', async () => {
    const resolver = vi.fn(async () => ({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      mime: 'application/pdf',
    }))
    const { client } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'never' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({
      client: client as any,
      artifactResolver: resolver,
    })
    await expect(drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{
          type: 'file_ref',
          artifactId: 'docs/spec.pdf',
          mime: 'application/pdf',
        }],
      }],
    }))).rejects.toMatchObject({
      code: 'MULTIMODAL_NOT_SUPPORTED',
      blockType: 'file_ref',
    })
  })

  it('throws MultimodalInlineSizeError when inline base64 exceeds maxInlineBytes', async () => {
    const { client } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'never' }],
      stop_reason: 'end_turn',
    }))
    // cap of 4 bytes — any non-empty payload will trip it.
    const provider = new AnthropicProvider({
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
      blockType: 'image',
      inlineByteSize: 6,
      capBytes: 4,
    })
  })

  it('artifact_ref resolver returning oversized bytes hits the cap too', async () => {
    const resolver = vi.fn(async () => ({
      bytes: new Uint8Array(100), // bigger than cap below
      mime: 'image/png',
    }))
    const { client } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'never' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({
      client: client as any,
      artifactResolver: resolver,
      maxInlineBytes: 50,
    })
    await expect(drainStream(provider.stream({
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { kind: 'artifact_ref', artifactId: 'big.png', mime: 'image/png' },
        }],
      }],
    }))).rejects.toMatchObject({
      inlineByteSize: 100,
      capBytes: 50,
    })
  })

  it('parallelizes multiple artifact_ref resolutions in one message (race-style)', async () => {
    const callOrder: string[] = []
    const finishOrder: string[] = []
    // Resolver A finishes after B even though it was called first — proves
    // we awaited Promise.all rather than serializing.
    const resolver = vi.fn(async (artifactId: string) => {
      callOrder.push(artifactId)
      const delay = artifactId === 'a' ? 20 : 1
      await new Promise((r) => setTimeout(r, delay))
      finishOrder.push(artifactId)
      return { bytes: SAMPLE_PNG_BYTES, mime: 'image/png' }
    })
    const { client, create } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({
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
    expect(resolver).toHaveBeenCalledTimes(2)
    expect(callOrder).toEqual(['a', 'b'])
    // b finished first despite a being scheduled first — only possible if
    // both ran concurrently rather than serially.
    expect(finishOrder).toEqual(['b', 'a'])
    // Output order in body still matches input order — Promise.all preserves index.
    const body = create.mock.calls[0]![0] as Record<string, unknown>
    const blocks = (body.messages as any[])[0].content
    expect(blocks).toHaveLength(2)
    expect(blocks[0].source.data).toBe(SAMPLE_PNG_B64)
    expect(blocks[1].source.data).toBe(SAMPLE_PNG_B64)
  })

  it('mixes text + image in a single user turn without re-ordering', async () => {
    const { client, create } = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }))
    const provider = new AnthropicProvider({ client: client as any })
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
    const blocks = (body.messages as any[])[0].content
    expect(blocks.map((b: any) => b.type)).toEqual(['text', 'image', 'text'])
    expect(blocks[0].text).toBe('before')
    expect(blocks[2].text).toBe('after')
  })
})
