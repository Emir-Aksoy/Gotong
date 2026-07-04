/**
 * Personal Butler M6d — "敏感记忆写人在环" (sensitive memory-write, human in the
 * loop). The honest claim of this milestone is that there is NO NEW MECHANISM:
 * a sensitive memory write is just a memory-writing tool REGISTERED in the SAME
 * `GovernedActionToolset` the butler already uses for delete / spend / send, and
 * classified `approve`. Because that gate is tool-NAME-agnostic, the write parks
 * (`SuspendTaskError` → `/me` inbox) exactly like `delete_agent` does, runs only
 * on a human approval, and fails closed on denial.
 *
 * What makes this M6d and not a copy of agent.test.ts: the gated side effect IS
 * a memory write, so we assert the MEMORY STORE — it gains the entry only after
 * approval, and never after denial. And we contrast it with a BENIGN memory
 * write (the auto-capture / ordinary `remember` path) that runs inline without
 * ever parking — proving the gate is a POLICY choice on specific writes, not a
 * tax on every memory write.
 */

import { SuspendTaskError, type Task } from '@gotong/core'
import type {
  LlmAgentToolset,
  LlmProvider,
  LlmRequest,
  LlmStreamChunk,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@gotong/llm'
import type {
  MemoryEntry,
  MemoryHandle,
  MemoryKind,
  MemoryQuery,
  NewMemoryEntry,
} from '@gotong/services-sdk'
import { describe, expect, it } from 'vitest'

import {
  GovernedActionToolset,
  PersonalButlerAgent,
  readButlerGateState,
} from '../src/index.js'

// ── harness ────────────────────────────────────────────────────────────────

/** Scripted provider — one turn (chunk list) per `stream` call; last repeats. */
class ScriptProvider implements LlmProvider {
  readonly name = 'script'
  private i = 0
  constructor(private readonly turns: LlmStreamChunk[][]) {}
  async *stream(_req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const turn = this.turns[Math.min(this.i, this.turns.length - 1)]!
    this.i++
    for (const c of turn) yield c
  }
}

function textTurn(text: string): LlmStreamChunk[] {
  return [{ type: 'text', text }, { type: 'end', stopReason: 'end_turn' }]
}

function toolTurn(
  ...calls: Array<{ id: string; name: string; input: Record<string, unknown> }>
): LlmStreamChunk[] {
  const chunks: LlmStreamChunk[] = calls.map((c) => ({
    type: 'tool_use',
    toolUse: { type: 'tool_use', id: c.id, name: c.name, input: c.input },
  }))
  chunks.push({ type: 'end', stopReason: 'tool_use' })
  return chunks
}

/**
 * In-memory `MemoryHandle` that CAPTURES writes so a test can assert what the
 * butler actually committed to long-term memory. Same shape as the agent.test
 * fake, but here `list()` is the assertion surface.
 */
function captureMemory(): MemoryHandle {
  const entries: MemoryEntry[] = []
  let seq = 0
  return {
    async recall(_q: MemoryQuery): Promise<MemoryEntry[]> {
      return []
    },
    async remember(ne: NewMemoryEntry): Promise<MemoryEntry> {
      seq++
      const e: MemoryEntry = { id: ne.id ?? `m${seq}`, kind: ne.kind, text: ne.text, ts: 1000 + seq }
      entries.push(e)
      return e
    },
    async list(): Promise<MemoryEntry[]> {
      return [...entries]
    },
    async forget(): Promise<void> {},
    async clear(_kind?: MemoryKind): Promise<void> {},
  }
}

/**
 * The SAME governed toolset, but the gated tool is a MEMORY WRITE: `pin_memory`
 * pins a fact into the butler's long-term semantic memory. Its executor writes
 * straight to `mem` — so "did the write happen" == "is it in `mem.list()`". The
 * classifier tiers it `approve`, which is the only thing that makes this write
 * sensitive; the gate machinery is unchanged.
 */
function governedMemoryWrite(mem: MemoryHandle): GovernedActionToolset {
  return new GovernedActionToolset({
    tools: [
      {
        name: 'pin_memory',
        description: 'pin a fact into long-term memory',
        inputSchema: {
          type: 'object',
          properties: { kind: { type: 'string' }, text: { type: 'string' } },
        },
      },
    ],
    classify: async () => ({ decision: 'approve', reason: 'pins a sensitive fact into long-term memory' }),
    execute: async (_name: string, args: Record<string, unknown>) => {
      const e = await mem.remember({ kind: (args.kind as MemoryKind) ?? 'semantic', text: String(args.text) })
      return { text: `pinned ${e.id}` }
    },
  })
}

/** A BENIGN memory tool: ordinary capture / remember, runs inline (no gate). */
function benignMemoryWrite(mem: MemoryHandle): LlmAgentToolset {
  return {
    listTools(): LlmToolDefinition[] {
      return [
        {
          name: 'note',
          description: 'jot a routine note',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        },
      ]
    },
    async callTool(_name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
      const e = await mem.remember({ kind: 'episodic', text: String(args.text) })
      return { content: [{ type: 'text', text: `noted ${e.id}` }] }
    },
  }
}

function task(id: string, prompt: string): Task {
  return { id, from: 'user:alice', strategy: { kind: 'explicit', to: 'butler' }, payload: prompt }
}

function okText(res: { kind: string; output?: unknown }): string {
  expect(res.kind).toBe('ok')
  return (res.output as { text: string }).text
}

async function parkOf(agent: PersonalButlerAgent, t: Task): Promise<unknown> {
  try {
    await agent.onTask(t)
    throw new Error('expected a park')
  } catch (e) {
    if (e instanceof SuspendTaskError) return e.state
    throw e
  }
}

// ── tests ────────────────────────────────────────────────────────────────

describe('Personal Butler M6d — a sensitive memory write goes through the EXISTING governed gate', () => {
  it('parks the write before it touches memory (no new mechanism — same gate as delete)', async () => {
    const mem = captureMemory()
    const provider = new ScriptProvider([
      toolTurn({ id: 't1', name: 'pin_memory', input: { kind: 'semantic', text: '主人的家庭住址是 ...' } }),
    ])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: mem,
      system: 'base',
      captureTurns: false,
      governed: governedMemoryWrite(mem),
    })

    const state = await parkOf(agent, task('a', '把我家地址记下来'))
    const gate = readButlerGateState(state)
    expect(gate).not.toBeNull()
    expect(gate!.pending).toBeDefined()
    expect(gate!.pending!.approval.toolName).toBe('pin_memory')
    expect(gate!.pending!.approval.reason).toContain('long-term memory')
    // The write is gated BEFORE the side effect — nothing committed to memory.
    expect(await mem.list()).toHaveLength(0)
  })

  it('approve → the write commits exactly once', async () => {
    const mem = captureMemory()
    const provider = new ScriptProvider([
      toolTurn({ id: 't1', name: 'pin_memory', input: { kind: 'semantic', text: '主人在做奶茶店项目' } }),
      textTurn('记住了'),
    ])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: mem,
      system: 'base',
      captureTurns: false,
      governed: governedMemoryWrite(mem),
    })

    const state = await parkOf(agent, task('a', '记住我的项目'))
    expect(await mem.list()).toHaveLength(0) // still nothing before approval

    const res = await agent.onResume(task('a', '记住我的项目'), {
      ...(state as object),
      answer: { approved: true },
    })
    expect(okText(res)).toBe('记住了')
    const stored = await mem.list()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.kind).toBe('semantic')
    expect(stored[0]!.text).toBe('主人在做奶茶店项目')
  })

  it('deny → fail-closed: nothing is ever written to memory', async () => {
    const mem = captureMemory()
    const provider = new ScriptProvider([
      toolTurn({ id: 't1', name: 'pin_memory', input: { kind: 'semantic', text: '一条不该被记住的隐私' } }),
      textTurn('好的,没有记下来'),
    ])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: mem,
      system: 'base',
      captureTurns: false,
      governed: governedMemoryWrite(mem),
    })

    const state = await parkOf(agent, task('a', '别记这条'))
    const res = await agent.onResume(task('a', '别记这条'), {
      ...(state as object),
      answer: { approved: false, note: '隐私太敏感' },
    })
    expect(okText(res)).toBe('好的,没有记下来')
    expect(await mem.list()).toHaveLength(0) // fail-closed — the write never ran
  })

  it('no decision recorded → fail-closed (treated as denial, never an implicit write)', async () => {
    const mem = captureMemory()
    const provider = new ScriptProvider([
      toolTurn({ id: 't1', name: 'pin_memory', input: { kind: 'semantic', text: '无人裁决的写入' } }),
      textTurn('已取消'),
    ])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: mem,
      system: 'base',
      captureTurns: false,
      governed: governedMemoryWrite(mem),
    })

    const state = await parkOf(agent, task('a', '写点东西'))
    // Resume with the raw park state — no `answer` injected.
    const res = await agent.onResume(task('a', '写点东西'), state)
    expect(okText(res)).toBe('已取消')
    expect(await mem.list()).toHaveLength(0)
  })
})

describe('Personal Butler M6d — a BENIGN memory write runs inline (the gate is a policy on specific writes)', () => {
  it('an ordinary note is captured without ever parking', async () => {
    const mem = captureMemory()
    const provider = new ScriptProvider([
      toolTurn({ id: 't1', name: 'note', input: { text: '今天聊了奶茶店' } }),
      textTurn('记下了'),
    ])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: mem,
      system: 'base',
      captureTurns: false,
      benign: benignMemoryWrite(mem),
      // A governed toolset must exist, but its tool isn't called this turn.
      governed: governedMemoryWrite(mem),
    })

    // Runs to completion — no SuspendTaskError — and the note IS in memory.
    const res = await agent.onTask(task('a', '记一笔'))
    expect(okText(res)).toBe('记下了')
    const stored = await mem.list()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.kind).toBe('episodic')
    expect(stored[0]!.text).toBe('今天聊了奶茶店')
  })
})
