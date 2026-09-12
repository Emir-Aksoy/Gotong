import type { Task } from '@gotong/core'
import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@gotong/llm'
import type { MemoryEntry, MemoryHandle } from '@gotong/services-sdk'
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

describe('MemoryAugmentedAgent 写侧新颖门 (M4)', () => {
  /** 不同任务即使字面相同,也不能抹掉各自的时间证据。 */
  const runThrice = async (foldRestatements?: boolean) => {
    const mem = makeFakeMemory()
    const agent = new MemoryAugmentedAgent({
      id: 'butler',
      provider: new TextProvider('改到明天下午 4 点,在三号会议室。'),
      memory: mem,
      system: 'base',
      ...(foldRestatements !== undefined ? { foldRestatements } : {}),
    })
    for (let i = 0; i < 3; i++) {
      const res = await agent.onTask(task({ prompt: '明天下午的会议改到几点了?' }, `t${i}`))
      expect(res.kind).toBe('ok')
    }
    return mem
  }

  it('时间锚优先:同一句问三遍,保留三个任务的证据', async () => {
    const mem = await runThrice()
    const captured = turns(mem)
    expect(captured).toHaveLength(3)
    expect(captured.map(e => e.meta?.taskId)).toEqual(['t0', 't1', 't2'])
    for (const e of captured) {
      expect(e.meta?.temporal).toMatchObject({ v: 1, basis: 'turn-start' })
      expect(e.meta).not.toHaveProperty('restatedCount')
    }
  })

  it('foldRestatements: false 同样保留三条', async () => {
    expect(turns(await runThrice(false))).toHaveLength(3)
  })

  it('不同的轮次照常各写各的', async () => {
    const mem = makeFakeMemory()
    const agent = new MemoryAugmentedAgent({
      id: 'butler',
      provider: new TextProvider('好的,已经安排上了。'),
      memory: mem,
      system: 'base',
    })
    await agent.onTask(task({ prompt: '帮我订周五飞吉隆坡的机票' }, 'a'))
    await agent.onTask(task({ prompt: '那台服务器磁盘还剩多少' }, 'b'))
    expect(turns(mem)).toHaveLength(2)
  })
})
