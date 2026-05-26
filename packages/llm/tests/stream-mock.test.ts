/**
 * Phase 8 — MockLlmProvider.stream() and the drainStream helper.
 *
 * Coverage focus:
 *   - stream emits text → usage → end in that order for simple replies
 *   - script tool_use entries emit a `tool_use` chunk + end{stopReason:'tool_use'}
 *   - textChunkCount splits the reply into N text chunks
 *   - empty reply emits NO text chunks (per LlmStreamTextChunk contract)
 *   - throwError throws SYNCHRONOUSLY before the iterator yields
 *   - drainStream folds chunks into an LlmResponse with the same field
 *     semantics the legacy `complete()` API had (text/stopReason/usage)
 *   - drainStream maps an error chunk to stopReason='error' + appends message
 *   - drainStream takes the FIRST usage chunk (defensive vs misbehaving providers)
 *   - drainStream defaults stopReason='end_turn' when no terminal chunk
 *     (provider-bug fallback)
 */

import { describe, expect, it } from 'vitest'

import {
  MockLlmProvider,
  drainStream,
  type LlmStreamChunk,
  type LlmToolUseBlock,
} from '../src/index.js'

async function collect(
  stream: AsyncIterable<LlmStreamChunk>,
): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = []
  for await (const c of stream) out.push(c)
  return out
}

describe('MockLlmProvider — stream() basics', () => {
  it('emits text → usage → end for a plain reply', async () => {
    const p = new MockLlmProvider({ reply: 'hi' })
    const chunks = await collect(p.stream({ messages: [{ role: 'user', content: 'x' }] }))
    expect(chunks.map((c) => c.type)).toEqual(['text', 'usage', 'end'])
    // Concatenating text chunks reproduces the reply.
    const text = chunks
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('')
    expect(text).toBe('hi')
    const end = chunks.at(-1)!
    expect(end.type).toBe('end')
    if (end.type === 'end') expect(end.stopReason).toBe('end_turn')
  })

  it('empty reply emits NO text chunks (only usage + end)', async () => {
    const p = new MockLlmProvider({ reply: '' })
    const chunks = await collect(p.stream({ messages: [] }))
    expect(chunks.map((c) => c.type)).toEqual(['usage', 'end'])
  })

  it('textChunkCount splits the reply across multiple text chunks', async () => {
    const p = new MockLlmProvider({ reply: 'abcdefgh', textChunkCount: 4 })
    const chunks = await collect(p.stream({ messages: [] }))
    const texts = chunks
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
    expect(texts.length).toBe(4)
    expect(texts.join('')).toBe('abcdefgh')
  })

  it('honors stopReason override on the terminal end chunk', async () => {
    const p = new MockLlmProvider({ reply: 'cut', stopReason: 'max_tokens' })
    const chunks = await collect(p.stream({ messages: [] }))
    const end = chunks.at(-1)!
    expect(end.type).toBe('end')
    if (end.type === 'end') expect(end.stopReason).toBe('max_tokens')
  })

  it('honors delayMs (delays first chunk arrival)', async () => {
    const p = new MockLlmProvider({ reply: 'ok', delayMs: 15 })
    const t0 = Date.now()
    await collect(p.stream({ messages: [] }))
    expect(Date.now() - t0).toBeGreaterThanOrEqual(10)
  })
})

describe('MockLlmProvider — stream() error semantics', () => {
  it('throwError throws SYNCHRONOUSLY (before iterator yields)', () => {
    const p = new MockLlmProvider({ reply: 'never', throwError: 'auth_failed' })
    // Calling .stream() itself must throw so LlmAgent's existing error
    // path and onAuthFailure hook (M5) fire on the synchronous throw
    // rather than waiting for the iterator's first .next().
    expect(() => p.stream({ messages: [] })).toThrow(/auth_failed/)
  })

  it('drainStream surfaces the sync throw from stream()', async () => {
    const p = new MockLlmProvider({ reply: '', throwError: 'oops' })
    // The throw fires inside `p.stream(...)` synchronously, BEFORE
    // drainStream sees the iterator. Wrap in an async IIFE so the
    // throw lands as a rejected promise rather than escaping the
    // expect() expression unmediated.
    await expect(
      (async () => drainStream(p.stream({ messages: [] })))(),
    ).rejects.toThrow(/oops/)
  })
})

describe('MockLlmProvider — script tool_use entries', () => {
  it('emits a tool_use chunk + end{tool_use}', async () => {
    const toolUse: LlmToolUseBlock = {
      type: 'tool_use',
      id: 'call_1',
      name: 'lookup',
      input: { q: 'cats' },
    }
    const p = new MockLlmProvider({
      reply: 'fallback',
      script: [{ kind: 'tool_use', toolUses: [toolUse] }],
    })
    const chunks = await collect(p.stream({ messages: [] }))
    expect(chunks.map((c) => c.type)).toEqual(['tool_use', 'usage', 'end'])
    const tu = chunks[0]!
    if (tu.type === 'tool_use') {
      expect(tu.toolUse.name).toBe('lookup')
      expect(tu.toolUse.input).toEqual({ q: 'cats' })
    }
    const end = chunks.at(-1)!
    if (end.type === 'end') expect(end.stopReason).toBe('tool_use')
  })

  it('emits accompanying text BEFORE the tool_use chunk when set', async () => {
    const p = new MockLlmProvider({
      reply: 'unused',
      script: [
        {
          kind: 'tool_use',
          text: 'let me check',
          toolUses: [{ type: 'tool_use', id: 'a', name: 't', input: {} }],
        },
      ],
    })
    const chunks = await collect(p.stream({ messages: [] }))
    expect(chunks.map((c) => c.type)).toEqual(['text', 'tool_use', 'usage', 'end'])
  })

  it('script text entries behave like a normal reply', async () => {
    const p = new MockLlmProvider({
      reply: 'fallback',
      script: [{ kind: 'text', text: 'scripted', stopReason: 'end_turn' }],
    })
    const chunks = await collect(p.stream({ messages: [] }))
    const end = chunks.at(-1)!
    if (end.type === 'end') expect(end.stopReason).toBe('end_turn')
  })
})

describe('MockLlmProvider — chunks option (M4 raw stream control)', () => {
  it('emits a fixed chunk list verbatim on every call', async () => {
    const fixed: LlmStreamChunk[] = [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'end', stopReason: 'end_turn' },
    ]
    const p = new MockLlmProvider({ reply: 'IGNORED', chunks: fixed })
    const r1 = await collect(p.stream({ messages: [] }))
    const r2 = await collect(p.stream({ messages: [] }))
    expect(r1).toEqual(fixed)
    expect(r2).toEqual(fixed)
  })

  it('per-call matrix advances cursor each call, then falls back to reply', async () => {
    const matrix: LlmStreamChunk[][] = [
      [
        { type: 'text', text: 'first' },
        { type: 'end', stopReason: 'end_turn' },
      ],
      [
        { type: 'text', text: 'second' },
        { type: 'end', stopReason: 'end_turn' },
      ],
    ]
    const p = new MockLlmProvider({ reply: 'fallback', chunks: matrix })
    const c1 = await collect(p.stream({ messages: [] }))
    const c2 = await collect(p.stream({ messages: [] }))
    const c3 = await collect(p.stream({ messages: [] }))
    expect(c1[0]).toEqual({ type: 'text', text: 'first' })
    expect(c2[0]).toEqual({ type: 'text', text: 'second' })
    // 3rd call falls back to reply.
    const c3Texts = c3.filter(
      (c): c is { type: 'text'; text: string } => c.type === 'text',
    )
    expect(c3Texts.map((c) => c.text).join('')).toBe('fallback')
  })

  it('chunks containing an error chunk surface via drainStream stopReason=error', async () => {
    const p = new MockLlmProvider({
      reply: '',
      chunks: [
        { type: 'text', text: 'partial' },
        { type: 'error', code: 'mock_simulated', message: 'boom' },
      ],
    })
    const res = await drainStream(p.stream({ messages: [] }))
    expect(res.stopReason).toBe('error')
    expect(res.text).toContain('partial')
    expect(res.text).toContain('mock_simulated')
  })

  it('throwError still wins over chunks (sync throw before generator)', () => {
    const p = new MockLlmProvider({
      reply: '',
      chunks: [{ type: 'end', stopReason: 'end_turn' }],
      throwError: 'mock_blocked',
    })
    expect(() => p.stream({ messages: [] })).toThrow(/mock_blocked/)
  })

  it('supports a stream with NO terminal end chunk (provider-bug simulation)', async () => {
    const p = new MockLlmProvider({
      reply: '',
      chunks: [{ type: 'text', text: 'no end' }],
    })
    const res = await drainStream(p.stream({ messages: [] }))
    // drainStream's provider-bug fallback fills end_turn.
    expect(res.text).toBe('no end')
    expect(res.stopReason).toBe('end_turn')
  })
})

describe('drainStream — generic chunk → LlmResponse', () => {
  async function* gen(
    chunks: LlmStreamChunk[],
  ): AsyncIterable<LlmStreamChunk> {
    for (const c of chunks) yield c
  }

  it('concatenates text chunks in arrival order', async () => {
    const r = await drainStream(
      gen([
        { type: 'text', text: 'hel' },
        { type: 'text', text: 'lo' },
        { type: 'end', stopReason: 'end_turn' },
      ]),
    )
    expect(r.text).toBe('hello')
    expect(r.stopReason).toBe('end_turn')
  })

  it('collects multiple tool_use chunks into response.toolUses', async () => {
    const r = await drainStream(
      gen([
        {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'a', name: 't1', input: {} },
        },
        {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'b', name: 't2', input: { x: 1 } },
        },
        { type: 'end', stopReason: 'tool_use' },
      ]),
    )
    expect(r.toolUses?.length).toBe(2)
    expect(r.toolUses?.[0]?.name).toBe('t1')
    expect(r.toolUses?.[1]?.name).toBe('t2')
    expect(r.stopReason).toBe('tool_use')
  })

  it('takes the FIRST usage chunk; ignores subsequent ones', async () => {
    const r = await drainStream(
      gen([
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
        { type: 'usage', usage: { inputTokens: 9999, outputTokens: 9999 } },
        { type: 'end', stopReason: 'end_turn' },
      ]),
    )
    expect(r.usage?.inputTokens).toBe(10)
    expect(r.usage?.outputTokens).toBe(5)
  })

  it('maps an error chunk to stopReason=error + appends message', async () => {
    const r = await drainStream(
      gen([
        { type: 'text', text: 'partial' },
        { type: 'error', code: 'content_filter', message: 'blocked' },
      ]),
    )
    expect(r.stopReason).toBe('error')
    expect(r.text).toContain('partial')
    expect(r.text).toContain('content_filter')
    expect(r.text).toContain('blocked')
  })

  it('defaults stopReason=end_turn when no terminal chunk (provider bug)', async () => {
    const r = await drainStream(gen([{ type: 'text', text: 'only' }]))
    expect(r.text).toBe('only')
    expect(r.stopReason).toBe('end_turn')
  })

  it('omits toolUses field when no tool_use chunks arrived', async () => {
    const r = await drainStream(
      gen([
        { type: 'text', text: 'plain' },
        { type: 'end', stopReason: 'end_turn' },
      ]),
    )
    expect(r.toolUses).toBeUndefined()
  })

  it('reproduces the canonical LlmResponse shape (text/stopReason/usage)', async () => {
    // Sanity check for the basic happy path. Phase 8 M8 removed the
    // legacy `provider.complete()` method this test used to compare
    // against — drainStream is now the single source of truth.
    const p = new MockLlmProvider({
      reply: 'roundtrip',
      stopReason: 'end_turn',
    })
    const res = await drainStream(p.stream({ messages: [] }))
    expect(res.text).toBe('roundtrip')
    expect(res.stopReason).toBe('end_turn')
    expect(res.usage?.inputTokens).toBe(0)
    expect(res.usage?.outputTokens).toBe(Math.ceil('roundtrip'.length / 4))
  })
})
