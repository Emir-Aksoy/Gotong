/**
 * `MemoryRetriever` — the swappable `recall` backend (M4).
 *
 * Proves the seam's two invariants:
 *   1. The `recall` tool routes through an injected retriever (vector / hybrid /
 *      chroma-mcp), NOT the handle's substring `recall`.
 *   2. Writes (`remember` / `forget`) and the byte-stable frozen block still go
 *      to the `MemoryHandle` — the retriever only answers queries.
 */

import type { Task } from '@gotong/core'
import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@gotong/llm'
import type { MemoryEntry, MemoryQuery } from '@gotong/services-sdk'
import { describe, expect, it } from 'vitest'

import { MemoryAugmentedAgent, MemoryToolset, type MemoryRetriever } from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

function recallText(out: { content: ReadonlyArray<unknown> }): string {
  return (out.content[0] as { text: string }).text
}

describe('MemoryToolset — swappable retriever', () => {
  it('routes the recall tool through an injected retriever, not the handle', async () => {
    const mem = makeFakeMemory([entry('a', 'semantic', 'user likes tea', 100)])
    const seen: MemoryQuery[] = []
    const retriever: MemoryRetriever = {
      async retrieve(q) {
        seen.push(q)
        return [entry('vec1', 'semantic', 'VECTOR HIT: prefers oolong', 5000)]
      },
    }
    const ts = new MemoryToolset({ memory: mem, retriever })

    const out = await ts.callTool('recall', { query: 'tea', k: 3 })
    expect(out.isError).toBeUndefined()
    expect(recallText(out)).toContain('VECTOR HIT')
    // The handle's own recall was NEVER consulted by the tool.
    expect(mem.recallCount).toBe(0)
    // The query reached the retriever with the clamped k.
    expect(seen).toHaveLength(1)
    expect(seen[0]!.text).toBe('tea')
    expect(seen[0]!.k).toBe(3)
  })

  it('falls back to the handle recall when no retriever is injected', async () => {
    const mem = makeFakeMemory([entry('a', 'semantic', 'user likes tea', 100)])
    const ts = new MemoryToolset({ memory: mem })

    const out = await ts.callTool('recall', { query: 'tea' })
    expect(recallText(out)).toContain('user likes tea')
    expect(mem.recallCount).toBe(1)
  })

  it('remember / forget always hit the handle, never the retriever', async () => {
    const mem = makeFakeMemory([])
    let retrieveCalls = 0
    const retriever: MemoryRetriever = {
      async retrieve() {
        retrieveCalls++
        return []
      },
    }
    const ts = new MemoryToolset({ memory: mem, retriever })

    await ts.callTool('remember', { text: 'durable fact', kind: 'semantic' })
    expect(mem.entries.some((e) => e.text === 'durable fact')).toBe(true)
    const id = mem.entries[0]!.id
    await ts.callTool('forget', { id })
    expect(mem.entries.length).toBe(0)
    expect(retrieveCalls).toBe(0)
  })
})

// ── agent-level wiring ───────────────────────────────────────────────────

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

describe('MemoryAugmentedAgent — memoryRetriever threads to the recall tool', () => {
  it('recall tool uses the retriever; frozen block still uses the handle', async () => {
    const mem = makeFakeMemory([entry('seed', 'semantic', 'user likes tea', 100)])
    const retrieved: MemoryQuery[] = []
    const retriever: MemoryRetriever = {
      async retrieve(q) {
        retrieved.push(q)
        return [entry('vec1', 'episodic', 'VECTOR: ordered oolong last week', 6000) as MemoryEntry]
      },
    }
    // Turn 1: model calls recall. Turn 2: ends.
    const provider = new ScriptProvider([
      [
        { type: 'tool_use', toolUse: { type: 'tool_use', id: 'r1', name: 'recall', input: { query: 'oolong' } } },
        { type: 'end', stopReason: 'tool_use' },
      ],
      [
        { type: 'text', text: 'found it' },
        { type: 'end', stopReason: 'end_turn' },
      ],
    ])

    const agent = new MemoryAugmentedAgent({
      id: 'butler',
      provider,
      memory: mem,
      memoryRetriever: retriever,
      system: 'base',
      captureTurns: false,
    })

    const t: Task = { id: 't1', from: 'user:alice', strategy: { kind: 'explicit', to: 'butler' }, payload: 'what tea did I order' }
    const res = await agent.onTask(t)
    expect(res.kind).toBe('ok')

    // The recall TOOL hit the retriever.
    expect(retrieved).toHaveLength(1)
    expect(retrieved[0]!.text).toBe('oolong')
    // The frozen block used the HANDLE (curated semantic profile), proven by the
    // handle's own `list` having run at session warm-up — NOT the retriever.
    expect(mem.listCount).toBeGreaterThanOrEqual(1)
    // The injected vector hit fed back to the model (second request carries the tool result).
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain('VECTOR: ordered oolong')
  })
})
