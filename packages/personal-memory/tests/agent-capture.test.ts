import type { Task } from '@aipehub/core'
import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@aipehub/llm'
import type { MemoryEntry, MemoryHandle } from '@aipehub/services-sdk'
import { describe, expect, it } from 'vitest'

import { MemoryAugmentedAgent } from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

/** Plain text-in/text-out provider with a fixed reply. */
class TextProvider implements LlmProvider {
  readonly name = 'text'
  constructor(private readonly reply: string) {}
  async *stream(_req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield { type: 'text', text: this.reply }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

function task(prompt: unknown, id = 't1', from = 'user:alice'): Task {
  return { id, from, strategy: { kind: 'explicit', to: 'butler' }, payload: prompt }
}

function turns(mem: { entries: readonly MemoryEntry[] }): MemoryEntry[] {
  return mem.entries.filter((e) => (e.meta as { turn?: unknown } | undefined)?.turn === true)
}

describe('MemoryAugmentedAgent turn capture (M2)', () => {
  it('records a completed turn into episodic memory by default', async () => {
    const mem = makeFakeMemory()
    const agent = new MemoryAugmentedAgent({
      id: 'butler',
      provider: new TextProvider('sure thing'),
      memory: mem,
      system: 'base',
    })

    const res = await agent.onTask(task({ prompt: 'remember milk' }, 't9'))
    expect(res.kind).toBe('ok')

    const captured = turns(mem)
    expect(captured.length).toBe(1)
    expect(captured[0]!.kind).toBe('episodic')
    expect(captured[0]!.text).toContain('remember milk')
    expect(captured[0]!.text).toContain('sure thing')
    expect(captured[0]!.meta).toMatchObject({ turn: true, taskId: 't9', from: 'user:alice' })
  })

  it('does not pollute THIS session’s frozen block (episodic excluded)', async () => {
    const mem = makeFakeMemory([entry('s', 'semantic', 'user likes tea', 100)])
    const agent = new MemoryAugmentedAgent({
      id: 'butler',
      provider: new TextProvider('green tea it is'),
      memory: mem,
      system: 'base',
    })

    await agent.onTask(task({ prompt: 'hi' }))
    const block = agent.memorySession.frozenBlockSync()
    expect(block).toContain('user likes tea') // semantic, present
    expect(block).not.toContain('green tea it is') // the captured turn must not leak in
    expect(block).not.toContain('User:')
  })

  it('captureTurns:false opts out of capture entirely', async () => {
    const mem = makeFakeMemory()
    const agent = new MemoryAugmentedAgent({
      id: 'butler',
      provider: new TextProvider('ok'),
      memory: mem,
      captureTurns: false,
    })
    await agent.onTask(task({ prompt: 'something' }))
    expect(turns(mem).length).toBe(0)
  })

  it('never captures a heartbeat tick (episodic is the conversation log)', async () => {
    const mem = makeFakeMemory()
    const agent = new MemoryAugmentedAgent({
      id: 'butler',
      provider: new TextProvider('HEARTBEAT_OK'),
      memory: mem,
    })
    await agent.onTask(task({ heartbeat: true, prompt: '[Heartbeat] check' }))
    expect(turns(mem).length).toBe(0)
  })

  it('merges captureMeta into every capture (per-user namespace)', async () => {
    const mem = makeFakeMemory()
    const agent = new MemoryAugmentedAgent({
      id: 'butler',
      provider: new TextProvider('done'),
      memory: mem,
      captureMeta: { user: 'alice' },
    })
    await agent.onTask(task({ prompt: 'note this' }))
    const captured = turns(mem)
    expect(captured.length).toBe(1)
    expect(captured[0]!.meta).toMatchObject({ turn: true, user: 'alice' })
  })

  it('is best-effort: a capture write failure does not fail the turn', async () => {
    const base = makeFakeMemory([entry('s', 'semantic', 'x', 100)])
    const mem: MemoryHandle = {
      recall: base.recall.bind(base),
      remember: async () => {
        throw new Error('disk full')
      },
      list: base.list.bind(base),
      forget: base.forget.bind(base),
      clear: base.clear.bind(base),
    }
    const agent = new MemoryAugmentedAgent({
      id: 'butler',
      provider: new TextProvider('still answered'),
      memory: mem,
    })
    const res = await agent.onTask(task({ prompt: 'hi' }))
    expect(res.kind).toBe('ok')
    expect(res.kind === 'ok' && (res.output as { text: string }).text).toBe('still answered')
  })
})
