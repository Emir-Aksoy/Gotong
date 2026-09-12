import type { Task } from '@gotong/core'
import type { LlmProvider, LlmStreamChunk } from '@gotong/llm'
import { describe, expect, it } from 'vitest'
import { MemoryAugmentedAgent } from '../src/agent.js'
import { makeFakeMemory } from './fake-memory.js'

const start = Date.parse('2026-09-11T06:59:59Z')
const task: Task = { id: 'time-test', from: 'user:alice', strategy: { kind: 'explicit', to: 'butler' },
  payload: { prompt: 'today I ate barbecue', observedAt: 0, timeZone: 'Asia/Tokyo' } }

describe('agent turn observation', () => {
  it('captures before model work across midnight and ignores payload/static-meta timestamps', async () => {
    let now = start
    const provider: LlmProvider = { name: 'clock-test', async *stream(): AsyncIterable<LlmStreamChunk> {
      now += 60_000
      yield { type: 'text', text: 'ok' }
      yield { type: 'end', stopReason: 'end_turn' }
    } }
    const memory = makeFakeMemory()
    const agent = new MemoryAugmentedAgent({ id: 'butler', provider, memory,
      captureNow: () => now, captureTimeZone: 'America/Los_Angeles',
      captureMeta: { temporal: { v: 1, observedAt: 0, timeZone: 'UTC', basis: 'turn-start' } },
    })
    expect((await agent.onTask(task)).kind).toBe('ok')
    expect(memory.entries[0]!.meta?.temporal).toEqual({ v: 1, observedAt: start, timeZone: 'America/Los_Angeles', basis: 'turn-start' })
    await agent.onTask({ ...task, id: 'second' })
    expect(memory.entries).toHaveLength(2)
    expect(memory.entries[1]!.meta?.temporal).toMatchObject({ observedAt: start + 60_000 })
  })

  it('does not invent an original observation timestamp when resuming without one', async () => {
    class ResumeAgent extends MemoryAugmentedAgent {
      async finishResume() { return this.handleResume(task, {}) }
      protected override async resumeBody() { return { text: 'resumed' } }
    }
    const memory = makeFakeMemory()
    const provider: LlmProvider = { name: 'unused', async *stream() { yield { type: 'end' as const, stopReason: 'end_turn' as const } } }
    const agent = new ResumeAgent({ id: 'butler', provider, memory,
      captureMeta: { temporal: { v: 1, observedAt: 0, timeZone: 'UTC', basis: 'turn-start' } },
    })
    await agent.finishResume()
    expect(memory.entries).toHaveLength(1)
    expect(memory.entries[0]!.meta).not.toHaveProperty('temporal')
  })

  it('captures a base-LLM fresh-run fallback on resume only once and without a new original time', async () => {
    class ResumeAgent extends MemoryAugmentedAgent {
      async finishResume() { return this.handleResume(task, {}) }
    }
    const memory = makeFakeMemory()
    const provider: LlmProvider = { name: 'fallback', async *stream(): AsyncIterable<LlmStreamChunk> {
      yield { type: 'text', text: 'resumed with fresh working context' }
      yield { type: 'end', stopReason: 'end_turn' }
    } }
    const agent = new ResumeAgent({ id: 'butler', provider, memory, captureNow: () => start })
    await agent.finishResume()
    expect(memory.entries).toHaveLength(1)
    expect(memory.entries[0]!.meta).not.toHaveProperty('temporal')
    await agent.onTask({ ...task, id: 'fresh' })
    expect(memory.entries[1]!.meta?.temporal).toMatchObject({ observedAt: start })
  })

  it('does not leak resume state into a concurrent fresh call on the same task object', async () => {
    class ResumeAgent extends MemoryAugmentedAgent {
      async finishResume() { return this.handleResume(task, {}) }
    }
    let release!: () => void
    let signal!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { signal = resolve })
    let calls = 0
    const provider: LlmProvider = { name: 'concurrent', async *stream(): AsyncIterable<LlmStreamChunk> {
      if (++calls === 1) { signal(); await held }
      yield { type: 'text', text: 'ok' }
      yield { type: 'end', stopReason: 'end_turn' }
    } }
    const memory = makeFakeMemory()
    const agent = new ResumeAgent({ id: 'butler', provider, memory, captureNow: () => start })
    const resumed = agent.finishResume()
    await started
    try { expect((await agent.onTask(task)).kind).toBe('ok') } finally { release() }
    await resumed
    expect(memory.entries).toHaveLength(2)
    expect(memory.entries[0]!.meta?.temporal).toMatchObject({ observedAt: start })
    expect(memory.entries[1]!.meta).not.toHaveProperty('temporal')
  })
})
