/**
 * Phase 8 M5 — LlmAgent.onStreamChunk hook.
 *
 * Coverage:
 *   - hook fires once per chunk in wire order (text → usage → end)
 *   - hook receives the same Task that handleTask runs against
 *   - async hook is awaited per chunk (no chunk dropped while hook works)
 *   - hook throwing does NOT abort the stream; LlmResponse still complete
 *   - hook fires for EVERY round of the tool-use loop, not just the first
 *   - hook fires for error chunks AND end chunks (terminal chunks count)
 *   - chunks option (mocked raw stream) is observable end-to-end through LlmAgent
 */

import { describe, expect, it } from 'vitest'
import { Hub } from '@aipehub/core'

import {
  LlmAgent,
  MockLlmProvider,
  type LlmStreamChunk,
  type LlmAgentToolset,
} from '../src/index.js'
import type { Task } from '@aipehub/core'

function makeTask(payload: unknown, capabilities = ['draft']) {
  return {
    from: 'system' as const,
    strategy: { kind: 'capability' as const, capabilities },
    payload,
  }
}

describe('LlmAgent — onStreamChunk hook (Phase 8 M5)', () => {
  it('fires once per chunk in arrival order with the task', async () => {
    const seen: { type: string; taskTitle?: string }[] = []
    const provider = new MockLlmProvider({
      reply: 'hello world',
      textChunkCount: 2,
    })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider,
        onStreamChunk: (chunk, task) => {
          seen.push({ type: chunk.type, taskTitle: task.title })
        },
      }),
    )

    const out = await hub.dispatch({
      ...makeTask('go'),
      title: 'task-title',
    })
    await hub.stop()

    expect(out.kind).toBe('ok')
    // text x2 → usage → end
    expect(seen.map((s) => s.type)).toEqual(['text', 'text', 'usage', 'end'])
    expect(seen[0]!.taskTitle).toBe('task-title')
  })

  it('async hook is awaited per chunk (no concurrent overlap)', async () => {
    const order: string[] = []
    const provider = new MockLlmProvider({ reply: 'abc', textChunkCount: 3 })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider,
        onStreamChunk: async (chunk) => {
          order.push(`enter:${chunk.type}`)
          await new Promise((r) => setTimeout(r, 5))
          order.push(`exit:${chunk.type}`)
        },
      }),
    )
    await hub.dispatch(makeTask('go'))
    await hub.stop()

    // Each chunk's enter/exit must bracket cleanly — no enter:X
    // before exit of the previous chunk's hook call.
    for (let i = 0; i < order.length; i++) {
      if (order[i]!.startsWith('enter:')) {
        // Next entry must be the matching exit.
        expect(order[i + 1]!.startsWith('exit:')).toBe(true)
      }
    }
  })

  it('hook throwing does NOT abort the stream; LlmResponse still complete', async () => {
    const provider = new MockLlmProvider({
      reply: 'still works',
      textChunkCount: 2,
    })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider,
        onStreamChunk: () => {
          throw new Error('hook-blew-up')
        },
      }),
    )
    const out = await hub.dispatch(makeTask('go'))
    await hub.stop()
    expect(out.kind).toBe('ok')
    if (out.kind === 'ok') {
      const o = out.output as { text: string }
      expect(o.text).toBe('still works')
    }
  })

  it('fires for every tool-use round (NOT just first)', async () => {
    // 2-round tool-use loop: first round emits tool_use chunk, second
    // round emits final text. The hook must see chunks from BOTH rounds.
    const provider = new MockLlmProvider({
      reply: 'unused',
      script: [
        {
          kind: 'tool_use',
          toolUses: [
            { type: 'tool_use', id: 't1', name: 'noop', input: {} },
          ],
        },
        { kind: 'text', text: 'all done' },
      ],
    })
    const toolset: LlmAgentToolset = {
      listTools: () => [{ name: 'noop', inputSchema: { type: 'object' } }],
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    }
    const chunkTypes: string[] = []
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider,
        tools: toolset,
        onStreamChunk: (c) => {
          chunkTypes.push(c.type)
        },
      }),
    )
    const out = await hub.dispatch(makeTask('go'))
    await hub.stop()

    expect(out.kind).toBe('ok')
    // Round 1: tool_use → usage → end{tool_use}
    // Round 2: text → usage → end{end_turn}
    expect(chunkTypes).toEqual([
      'tool_use',
      'usage',
      'end',
      'text',
      'usage',
      'end',
    ])
  })

  it('observes error chunks via chunks raw-stream option', async () => {
    const rawChunks: LlmStreamChunk[] = [
      { type: 'text', text: 'partial' },
      { type: 'error', code: 'mocked', message: 'simulated mid-stream fail' },
    ]
    const provider = new MockLlmProvider({ reply: '', chunks: rawChunks })
    const seen: LlmStreamChunk[] = []
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider,
        onStreamChunk: (c) => {
          seen.push(c)
        },
      }),
    )
    const out = await hub.dispatch(makeTask('go'))
    await hub.stop()

    expect(seen).toEqual(rawChunks)
    // Aggregated response carries the error in text + stopReason=error.
    expect(out.kind).toBe('ok')
    if (out.kind === 'ok') {
      const o = out.output as { text: string; stopReason: string }
      expect(o.stopReason).toBe('error')
      expect(o.text).toContain('partial')
      expect(o.text).toContain('mocked')
    }
  })

  it('legacy complete-only provider (no stream method) still works via fallback', async () => {
    // This is the Phase 8 M5 transition shim that covers fake test
    // providers + SDK consumers that haven't upgraded. To be removed
    // in M8 along with LlmProvider.complete.
    const legacy = {
      name: 'legacy',
      complete: async () => ({
        text: 'via-complete',
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 1, outputTokens: 2 },
      }),
    }
    const seenTypes: string[] = []
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider: legacy as any,
        onStreamChunk: (c) => {
          seenTypes.push(c.type)
        },
      }),
    )
    const out = await hub.dispatch(makeTask('go'))
    await hub.stop()
    expect(out.kind).toBe('ok')
    // Fallback yields text → usage → end synthesized from complete().
    expect(seenTypes).toEqual(['text', 'usage', 'end'])
  })

  it('provider with neither stream nor complete fails with a clear error', async () => {
    const empty = { name: 'empty' }
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider: empty as any,
      }),
    )
    const out = await hub.dispatch(makeTask('go'))
    await hub.stop()
    expect(out.kind).toBe('failed')
    if (out.kind === 'failed') {
      expect(out.error).toMatch(/neither stream\(\) nor complete\(\)/)
    }
  })

  it('hook is OPTIONAL — provider runs unchanged when not set', async () => {
    // Sanity check: nothing in the rest of LlmAgent depends on
    // onStreamChunk being defined.
    const provider = new MockLlmProvider({ reply: 'fine' })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({ id: 'a', capabilities: ['draft'], provider }),
    )
    const out = await hub.dispatch(makeTask('go'))
    await hub.stop()
    expect(out.kind).toBe('ok')
  })
})

// Touch Task in a type-only context so the import is preserved.
// (Otherwise tsc warns about a phantom import.)
const _typeOnly: Task | undefined = undefined
void _typeOnly
