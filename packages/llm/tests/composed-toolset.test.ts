/**
 * Phase 10 M4 — ComposedToolset behaviour.
 *
 * Validates the multiplexer LlmAgent will use to attach more than one
 * toolset (typically McpToolset + DispatchToolset) at a single `tools:`
 * slot.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  ComposedToolset,
  ComposedToolNameCollisionError,
} from '../src/composed-toolset.js'
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

// R8 — listTools() is the wiring chokepoint: a name advertised by >1 child
// means callTool would silently first-match the wrong one. The agent's tool
// loop calls listTools() at turn start, so a collision fails loud (degrades to
// a `failed` task) instead of mis-routing at runtime. callTool's low-level
// first-match primitive (tested above) is unchanged; in the integrated flow it
// is only reached after listTools() has already gated.
describe('ComposedToolset.listTools — cross-child name collision (R8)', () => {
  it('throws a typed error listing the colliding name + child indices', async () => {
    const a = fakeToolset({ tools: [{ name: 'shared', inputSchema: { type: 'object' } }] })
    const b = fakeToolset({ tools: [{ name: 'shared', inputSchema: { type: 'object' } }] })
    const composed = ComposedToolset.of(a, b)
    await expect(composed.listTools()).rejects.toBeInstanceOf(
      ComposedToolNameCollisionError,
    )
    try {
      await composed.listTools()
      throw new Error('should have thrown')
    } catch (err) {
      const e = err as ComposedToolNameCollisionError
      expect(e.name).toBe('ComposedToolNameCollisionError')
      expect(e.collisions).toEqual([{ name: 'shared', childIndices: [0, 1] }])
      expect(e.message).toMatch(/shared/)
    }
  })

  it('does not throw when every name is distinct', async () => {
    const a = fakeToolset({ tools: [{ name: 'a1', inputSchema: { type: 'object' } }] })
    const b = fakeToolset({ tools: [{ name: 'b1', inputSchema: { type: 'object' } }] })
    const composed = ComposedToolset.of(a, b)
    const tools = await composed.listTools()
    expect(tools.map((t) => t.name)).toEqual(['a1', 'b1'])
  })

  it('reports all child indices when three children share a name', async () => {
    const mk = () => fakeToolset({ tools: [{ name: 'x', inputSchema: { type: 'object' } }] })
    const composed = ComposedToolset.of(mk(), mk(), mk())
    const err = await composed.listTools().then(
      () => null,
      (e: ComposedToolNameCollisionError) => e,
    )
    expect(err).toBeInstanceOf(ComposedToolNameCollisionError)
    expect(err!.collisions).toEqual([{ name: 'x', childIndices: [0, 1, 2] }])
  })

  it('detects collisions across non-adjacent children', async () => {
    const a = fakeToolset({ tools: [{ name: 'dup', inputSchema: { type: 'object' } }] })
    const mid = fakeToolset({ tools: [{ name: 'mid', inputSchema: { type: 'object' } }] })
    const c = fakeToolset({ tools: [{ name: 'dup', inputSchema: { type: 'object' } }] })
    const composed = ComposedToolset.of(a, mid, c)
    const err = await composed.listTools().then(
      () => null,
      (e: ComposedToolNameCollisionError) => e,
    )
    expect(err!.collisions).toEqual([{ name: 'dup', childIndices: [0, 2] }])
  })

  it('does NOT treat a single child listing a name twice as a collision', async () => {
    // A child's internal duplicate is its own concern — callTool would route to
    // that one child anyway, no cross-child mis-route. The composer stays quiet.
    const a = fakeToolset({
      tools: [
        { name: 'twice', inputSchema: { type: 'object' } },
        { name: 'twice', inputSchema: { type: 'object' } },
      ],
    })
    const b = fakeToolset({ tools: [{ name: 'other', inputSchema: { type: 'object' } }] })
    const composed = ComposedToolset.of(a, b)
    const tools = await composed.listTools()
    expect(tools.map((t) => t.name)).toEqual(['twice', 'twice', 'other'])
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
