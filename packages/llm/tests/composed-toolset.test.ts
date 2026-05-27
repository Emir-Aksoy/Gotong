/**
 * Phase 10 M4 — ComposedToolset behaviour.
 *
 * Validates the multiplexer LlmAgent will use to attach more than one
 * toolset (typically McpToolset + DispatchToolset) at a single `tools:`
 * slot.
 */
import { describe, expect, it, vi } from 'vitest'

import { ComposedToolset } from '../src/composed-toolset.js'
import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from '../src/types.js'

function fakeToolset(opts: {
  tools: LlmToolDefinition[]
  call?: (name: string, args: Record<string, unknown>) => Promise<LlmToolCallResult>
  runForTask?: <T>(task: unknown, fn: () => Promise<T>) => Promise<T>
}): LlmAgentToolset {
  return {
    listTools: () => opts.tools,
    callTool:
      opts.call ??
      (async (name) => ({
        content: [{ type: 'text', text: `default ${name}` }],
      })),
    ...(opts.runForTask ? { runForTask: opts.runForTask } : {}),
  } as LlmAgentToolset
}

describe('ComposedToolset.listTools', () => {
  it('concatenates each child\'s tool list', async () => {
    const a = fakeToolset({
      tools: [{ name: 'a1', inputSchema: { type: 'object' } }],
    })
    const b = fakeToolset({
      tools: [
        { name: 'b1', inputSchema: { type: 'object' } },
        { name: 'b2', inputSchema: { type: 'object' } },
      ],
    })
    const composed = ComposedToolset.of(a, b)
    const tools = await composed.listTools()
    expect(tools.map((t) => t.name)).toEqual(['a1', 'b1', 'b2'])
  })

  it('returns empty list when no children attached', async () => {
    const composed = ComposedToolset.of()
    expect(await composed.listTools()).toEqual([])
  })
})

describe('ComposedToolset.callTool — name routing', () => {
  it('routes to the child that advertises the tool', async () => {
    const aCall = vi.fn(async () => ({
      content: [{ type: 'text', text: 'from-a' }],
    }))
    const bCall = vi.fn(async () => ({
      content: [{ type: 'text', text: 'from-b' }],
    }))
    const a = fakeToolset({
      tools: [{ name: 'a-tool', inputSchema: { type: 'object' } }],
      call: aCall,
    })
    const b = fakeToolset({
      tools: [{ name: 'b-tool', inputSchema: { type: 'object' } }],
      call: bCall,
    })
    const composed = ComposedToolset.of(a, b)

    const r = await composed.callTool('b-tool', { x: 1 })
    expect((r.content[0] as { text: string }).text).toBe('from-b')
    expect(bCall).toHaveBeenCalledWith('b-tool', { x: 1 })
    expect(aCall).not.toHaveBeenCalled()
  })

  it('first-match-wins on duplicate tool names', async () => {
    const aCall = vi.fn(async () => ({
      content: [{ type: 'text', text: 'a-wins' }],
    }))
    const bCall = vi.fn(async () => ({
      content: [{ type: 'text', text: 'b-loses' }],
    }))
    const a = fakeToolset({
      tools: [{ name: 'shared', inputSchema: { type: 'object' } }],
      call: aCall,
    })
    const b = fakeToolset({
      tools: [{ name: 'shared', inputSchema: { type: 'object' } }],
      call: bCall,
    })
    const composed = ComposedToolset.of(a, b)
    const r = await composed.callTool('shared', {})
    expect((r.content[0] as { text: string }).text).toBe('a-wins')
    expect(bCall).not.toHaveBeenCalled()
  })

  it('returns isError on unknown tool name', async () => {
    const composed = ComposedToolset.of(
      fakeToolset({
        tools: [{ name: 'known', inputSchema: { type: 'object' } }],
      }),
    )
    const r = await composed.callTool('unknown', {})
    expect(r.isError).toBe(true)
    expect((r.content[0] as { text: string }).text).toMatch(/unknown tool: unknown/)
  })
})

describe('ComposedToolset.runForTask — nesting', () => {
  it('returns fn\'s value verbatim when no child implements runForTask', async () => {
    const composed = ComposedToolset.of(
      fakeToolset({ tools: [] }),
      fakeToolset({ tools: [] }),
    )
    const r = await composed.runForTask(
      { id: 't', from: 'me' },
      async () => 42,
    )
    expect(r).toBe(42)
  })

  it('invokes each child\'s runForTask, nesting outer-to-inner in add order', async () => {
    const order: string[] = []
    const a = fakeToolset({
      tools: [],
      runForTask: async (_task, fn) => {
        order.push('a-enter')
        try {
          return await fn()
        } finally {
          order.push('a-exit')
        }
      },
    })
    const b = fakeToolset({
      tools: [],
      runForTask: async (_task, fn) => {
        order.push('b-enter')
        try {
          return await fn()
        } finally {
          order.push('b-exit')
        }
      },
    })
    const composed = ComposedToolset.of(a, b)
    await composed.runForTask({ id: 't', from: 'me' }, async () => {
      order.push('body')
      return null
    })
    // First-added (a) is OUTER; last-added (b) is INNER.
    expect(order).toEqual([
      'a-enter',
      'b-enter',
      'body',
      'b-exit',
      'a-exit',
    ])
  })

  it('skips children without runForTask while still wrapping those that have it', async () => {
    const order: string[] = []
    const wrapped = fakeToolset({
      tools: [],
      runForTask: async (_task, fn) => {
        order.push('wrap')
        return fn()
      },
    })
    const plain = fakeToolset({ tools: [] })
    const composed = ComposedToolset.of(plain, wrapped, plain)
    await composed.runForTask({ id: 't', from: 'me' }, async () => {
      order.push('body')
    })
    expect(order).toEqual(['wrap', 'body'])
  })

  it('propagates fn\'s thrown error', async () => {
    const composed = ComposedToolset.of(
      fakeToolset({
        tools: [],
        runForTask: async (_task, fn) => fn(),
      }),
    )
    await expect(
      composed.runForTask({ id: 't', from: 'me' }, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })
})
