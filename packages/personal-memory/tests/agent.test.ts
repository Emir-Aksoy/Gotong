import type { Task } from '@aipehub/core'
import type {
  LlmAgentToolset,
  LlmProvider,
  LlmRequest,
  LlmStreamChunk,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@aipehub/llm'
import { describe, expect, it } from 'vitest'

import { MemoryAugmentedAgent, PersonalMemoryError } from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

/** Minimal capturing provider — plain text, no tools. Records every request. */
class CaptureProvider implements LlmProvider {
  readonly name = 'capture'
  readonly requests: LlmRequest[] = []
  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(req)
    yield { type: 'text', text: 'ok' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

/** Scripted provider — one chunk-list per turn (the last entry repeats). */
class ScriptProvider implements LlmProvider {
  readonly name = 'script'
  readonly requests: LlmRequest[] = []
  private i = 0
  constructor(private readonly turns: LlmStreamChunk[][]) {}
  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(req)
    const turn = this.turns[Math.min(this.i, this.turns.length - 1)]!
    this.i++
    for (const c of turn) yield c
  }
}

function task(id: string, prompt: string, to = 'butler'): Task {
  return { id, from: 'user:alice', strategy: { kind: 'explicit', to }, payload: prompt }
}

describe('MemoryAugmentedAgent', () => {
  it('throws PersonalMemoryError when constructed with no memory handle', () => {
    expect(() => new MemoryAugmentedAgent({ id: 'butler', provider: new CaptureProvider() })).toThrow(
      PersonalMemoryError,
    )
  })

  it('injects the frozen memory block at the FRONT of the system prompt', async () => {
    const mem = makeFakeMemory([entry('a', 'semantic', 'user likes tea', 100)])
    const provider = new CaptureProvider()
    const agent = new MemoryAugmentedAgent({
      id: 'butler',
      provider,
      memory: mem,
      system: 'You are a helpful butler.',
    })

    const res = await agent.onTask(task('t1', 'hi'))
    expect(res.kind).toBe('ok')

    const sys = provider.requests[0]!.system!
    expect(sys.startsWith('<!-- aipehub:memory:begin -->')).toBe(true)
    expect(sys).toContain('user likes tea')
    // The agent's own system prompt follows the memory block.
    expect(sys.indexOf('You are a helpful butler.')).toBeGreaterThan(sys.indexOf('user likes tea'))
  })

  it('keeps the system prefix byte-identical across turns (prompt cache preserved)', async () => {
    const mem = makeFakeMemory([entry('a', 'semantic', 'user likes tea', 100)])
    const provider = new CaptureProvider()
    const agent = new MemoryAugmentedAgent({ id: 'butler', provider, memory: mem, system: 'base' })

    await agent.onTask(task('t1', 'one'))
    await agent.onTask(task('t2', 'two'))

    expect(provider.requests.length).toBe(2)
    expect(provider.requests[1]!.system).toBe(provider.requests[0]!.system)
    // Recall ran once for the whole session.
    expect(mem.recallCount).toBe(1)
  })

  it('composes memory tools with a caller toolset (no name collision)', async () => {
    const extra: LlmAgentToolset = {
      listTools(): LlmToolDefinition[] {
        return [{ name: 'do_thing', description: 'x', inputSchema: { type: 'object', properties: {} } }]
      },
      async callTool(): Promise<LlmToolCallResult> {
        return { content: [{ type: 'text', text: 'done' }] }
      },
    }
    const provider = new CaptureProvider()
    const agent = new MemoryAugmentedAgent({
      id: 'butler',
      provider,
      memory: makeFakeMemory(),
      tools: extra,
    })

    await agent.onTask(task('t1', 'hi'))
    const toolNames = (provider.requests[0]!.tools ?? []).map((t) => t.name)
    expect(toolNames).toEqual(expect.arrayContaining(['remember', 'recall', 'forget', 'do_thing']))
  })

  it("a mid-session remember surfaces in the NEXT session's frozen block, not this one", async () => {
    const mem = makeFakeMemory([entry('seed', 'semantic', 'user likes tea', 100)])
    // Turn 1: model calls `remember`. Turn 2: model ends.
    const provider = new ScriptProvider([
      [
        {
          type: 'tool_use',
          toolUse: {
            type: 'tool_use',
            id: 'tu1',
            name: 'remember',
            input: { text: 'user prefers morning', kind: 'semantic' },
          },
        },
        { type: 'end', stopReason: 'tool_use' },
      ],
      [
        { type: 'text', text: 'noted' },
        { type: 'end', stopReason: 'end_turn' },
      ],
    ])

    const agent1 = new MemoryAugmentedAgent({ id: 'butler', provider, memory: mem, system: 'base' })
    const res = await agent1.onTask(task('t1', 'remember I prefer morning'))
    expect(res.kind).toBe('ok')

    // The remember tool actually wrote to memory.
    expect(mem.entries.some((e) => e.text.includes('morning'))).toBe(true)
    // This session's block was frozen BEFORE the write — no leak.
    expect(agent1.memorySession.frozenBlockSync()).not.toContain('morning')

    // A NEW agent (new session) over the same memory injects the new fact.
    const provider2 = new CaptureProvider()
    const agent2 = new MemoryAugmentedAgent({
      id: 'butler',
      provider: provider2,
      memory: mem,
      system: 'base',
    })
    await agent2.onTask(task('t2', 'hi again'))
    const sys2 = provider2.requests[0]!.system!
    expect(sys2).toContain('user prefers morning')
    expect(sys2).toContain('user likes tea')
  })
})
