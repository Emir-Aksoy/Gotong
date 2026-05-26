/**
 * Phase 8 M1 — MockLlmProvider.stream() and the drainStream helper.
 *
 * Coverage focus:
 *   - stream emits text → usage → end in that order for simple replies
 *   - script tool_use entries emit a `tool_use` chunk + end{stopReason:'tool_use'}
 *   - textChunkCount splits the reply into N text chunks
 *   - empty reply emits NO text chunks (per LlmStreamTextChunk contract)
 *   - throwError throws SYNCHRONOUSLY before the iterator yields
 *   - drainStream reproduces the legacy LlmResponse exactly
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
    // Calling .stream() itself must throw — mirrors the legacy
    // `await complete()` rejection so LlmAgent's existing error path
    // and onAuthFailure hook keep firing in M5.
    expect(() => p.stream({ messages: [] })).toThrow(/auth_failed/)
  })

  it('complete() still rejects (drainStream surfaces the sync throw)', async () => {
    const p = new MockLlmProvider({ reply: '', throwError: 'oops' })
    await expect(p.complete({ messages: [] })).rejects.toThrow(/oops/)
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

  it('round-trips MockLlmProvider.stream() identically to legacy complete()', async () => {
    const p = new MockLlmProvider({
      reply: 'roundtrip',
      stopReason: 'end_turn',
    })
    const viaStream = await drainStream(p.stream({ messages: [] }))
    const viaComplete = await p.complete({ messages: [] })
    // text + stopReason + usage tokens must match exactly.
    expect(viaStream.text).toBe(viaComplete.text)
    expect(viaStream.stopReason).toBe(viaComplete.stopReason)
    expect(viaStream.usage?.inputTokens).toBe(viaComplete.usage?.inputTokens)
    expect(viaStream.usage?.outputTokens).toBe(viaComplete.usage?.outputTokens)
  })
})
