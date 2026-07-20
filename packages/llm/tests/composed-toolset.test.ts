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

// The routing table. `callTool` used to re-list every child on every single
// call; for an McpToolset child that's a live `tools/list` round-trip per
// server. These pin the two halves of the fix: the steady state costs zero
// listings, and the miss path still picks up a tool face that moved.
describe('ComposedToolset.callTool — route cache', () => {
  /** A child whose tool list is mutable and whose listings are counted. */
  function countingToolset(names: string[]) {
    const state = {
      names: [...names],
      listCalls: 0,
      calledWith: [] as string[],
    }
    const toolset: LlmAgentToolset = {
      listTools: async () => {
        state.listCalls++
        return state.names.map((name) => ({
          name,
          inputSchema: { type: 'object' as const },
        }))
      },
      callTool: async (name: string) => {
        state.calledWith.push(name)
        return { content: [{ type: 'text' as const, text: `ran ${name}` }] }
      },
    }
    return { state, toolset }
  }

  it('lists each child once no matter how many calls follow', async () => {
    const a = countingToolset(['a1', 'a2'])
    const b = countingToolset(['b1'])
    const composed = ComposedToolset.of(a.toolset, b.toolset)

    for (const n of ['a1', 'b1', 'a2', 'a1', 'b1']) await composed.callTool(n, {})

    // One rebuild, triggered by the first (cold) call. Before the cache this
    // was 5 sweeps × 2 children = 10 listings — and each of those is a network
    // round-trip when the child is an McpToolset.
    expect(a.state.listCalls).toBe(1)
    expect(b.state.listCalls).toBe(1)
    expect(a.state.calledWith).toEqual(['a1', 'a2', 'a1'])
    expect(b.state.calledWith).toEqual(['b1', 'b1'])
  })

  it('picks up a tool hot-added after the cache is warm', async () => {
    // This is what `local-agent-pool.installMcpServer` does to a running
    // agent's toolset. A cache that never rebuilt would strand the new tool.
    const a = countingToolset(['a1'])
    const composed = ComposedToolset.of(a.toolset)
    await composed.callTool('a1', {})
    expect(a.state.listCalls).toBe(1)

    a.state.names.push('late')
    const r = await composed.callTool('late', {})

    expect((r.content[0] as { text: string }).text).toBe('ran late')
    expect(a.state.listCalls).toBe(2) // the miss forced exactly one re-list
    // ...and the newly-learned name is now cached too.
    await composed.callTool('late', {})
    expect(a.state.listCalls).toBe(2)
  })

  it('lets the old owner answer for a name that disappeared', async () => {
    // `uninstallMcpServer` removes a server mid-session. The stale entry routes
    // to the child that owned it, which reports its own specific failure
    // ("no server named 'x'"). LlmAgent turns that throw into an isError tool
    // result, so the turn survives — with a better diagnosis than the old
    // code's blanket "unknown tool".
    const state = { names: ['gone'], listCalls: 0 }
    const child: LlmAgentToolset = {
      listTools: async () => {
        state.listCalls++
        return state.names.map((name) => ({ name, inputSchema: { type: 'object' as const } }))
      },
      callTool: async (name: string) => {
        if (!state.names.includes(name)) throw new Error(`no server named '${name}'`)
        return { content: [{ type: 'text' as const, text: `ran ${name}` }] }
      },
    }
    const composed = ComposedToolset.of(child)
    await composed.callTool('gone', {})

    state.names = []
    await expect(composed.callTool('gone', {})).rejects.toThrow(/no server named 'gone'/)
  })

  it('shares one rebuild across concurrent misses', async () => {
    // Without the in-flight guard, parallel tool_use with N unknown names would
    // fan out N full sweeps — the exact cost this cache exists to remove.
    const a = countingToolset(['a1', 'a2', 'a3'])
    const composed = ComposedToolset.of(a.toolset)
    await Promise.all([
      composed.callTool('a1', {}),
      composed.callTool('a2', {}),
      composed.callTool('a3', {}),
    ])
    expect(a.state.listCalls).toBe(1)
  })

  it('still answers isError for a name no child has', async () => {
    const a = countingToolset(['a1'])
    const composed = ComposedToolset.of(a.toolset)
    const r = await composed.callTool('nope', {})
    expect(r.isError).toBe(true)
    expect((r.content[0] as { text: string }).text).toMatch(/unknown tool: nope/)
    expect(a.state.calledWith).toEqual([])
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
