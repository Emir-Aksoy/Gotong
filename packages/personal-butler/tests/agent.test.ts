/**
 * `PersonalButlerAgent` — the bounded, governance-gated tool-loop.
 *
 * These tests drive the butler with a scripted provider + fake memory and
 * assert the M4 contract: benign tools run inline, governed tools PARK before
 * any side effect (`SuspendTaskError`), and resume injects a human decision —
 * approve runs the deferred action, deny / no-decision fails closed.
 */

import { SuspendTaskError, type Task } from '@aipehub/core'
import type {
  LlmAgentToolset,
  LlmProvider,
  LlmRequest,
  LlmStreamChunk,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@aipehub/llm'
import type { MemoryEntry, MemoryHandle, MemoryKind, MemoryQuery, NewMemoryEntry } from '@aipehub/services-sdk'
import { describe, expect, it } from 'vitest'

import {
  GovernedActionToolset,
  PersonalButlerAgent,
  readButlerGateState,
  type GovernedClassifier,
} from '../src/index.js'

// ── harness ────────────────────────────────────────────────────────────────

/** Scripted provider — one turn (chunk list) per `stream` call; last repeats. */
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

/** Minimal in-memory `MemoryHandle` (recall is irrelevant here — empty seed). */
function emptyMemory(): MemoryHandle {
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

/** A benign toolset exposing `echo` — runs inline, logs every call. */
function benignToolset(log: string[]): LlmAgentToolset {
  return {
    listTools(): LlmToolDefinition[] {
      return [{ name: 'echo', description: 'echo a message', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }]
    },
    async callTool(_name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
      log.push(`echo:${String(args.msg)}`)
      return { content: [{ type: 'text', text: `echoed ${String(args.msg)}` }] }
    },
  }
}

/** A governed toolset exposing `delete_agent`. */
function governedToolset(execLog: string[], classify?: GovernedClassifier): GovernedActionToolset {
  return new GovernedActionToolset({
    tools: [{ name: 'delete_agent', description: 'delete a managed agent', inputSchema: { type: 'object', properties: { handle: { type: 'string' } } } }],
    ...(classify ? { classify } : {}),
    execute: async (_name: string, args: Record<string, unknown>) => {
      execLog.push(`delete:${String(args.handle)}`)
      return { text: `deleted ${String(args.handle)}` }
    },
  })
}

function task(id: string, prompt: string): Task {
  return { id, from: 'user:alice', strategy: { kind: 'explicit', to: 'butler' }, payload: prompt }
}

function okText(res: { kind: string; output?: unknown }): string {
  expect(res.kind).toBe('ok')
  return (res.output as { text: string }).text
}

// ── tests ────────────────────────────────────────────────────────────────

describe('PersonalButlerAgent — benign tools run inline', () => {
  it('executes a benign tool and finishes without suspending', async () => {
    const log: string[] = []
    const exec: string[] = []
    const provider = new ScriptProvider([toolTurn({ id: 't1', name: 'echo', input: { msg: 'hi' } }), textTurn('done')])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: emptyMemory(),
      system: 'base',
      captureTurns: false,
      benign: benignToolset(log),
      governed: governedToolset(exec),
    })

    const res = await agent.onTask(task('a', 'say hi'))
    expect(okText(res)).toBe('done')
    expect(log).toEqual(['echo:hi'])
    expect(exec).toEqual([]) // governed executor never touched
  })
})

describe('PersonalButlerAgent — governed tool parks for approval', () => {
  it('throws SuspendTaskError with a never-resume park + pending approval context', async () => {
    const exec: string[] = []
    // classify → approve → must park BEFORE the executor runs.
    const provider = new ScriptProvider([toolTurn({ id: 't1', name: 'delete_agent', input: { handle: 'mailer' } })])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: emptyMemory(),
      system: 'base',
      captureTurns: false,
      governed: governedToolset(exec, async () => ({ decision: 'approve', reason: 'destructive — deletes an agent' })),
    })

    let thrown: unknown
    try {
      await agent.onTask(task('a', 'delete mailer'))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SuspendTaskError)
    const err = thrown as SuspendTaskError
    expect(err.resumeAt).toBe(9_999_999_999_000) // never auto-resume — only a human wakes it

    const gate = readButlerGateState(err.state)
    expect(gate).not.toBeNull()
    expect(gate!.pending).toBeDefined()
    expect(gate!.pending!.toolUses.map((t) => t.name)).toEqual(['delete_agent'])
    expect(gate!.pending!.approval.toolName).toBe('delete_agent')
    expect(gate!.pending!.approval.reason).toContain('destructive')
    // Side effect did NOT happen — the gate is before execution.
    expect(exec).toEqual([])
  })
})

describe('PersonalButlerAgent — resume injects the decision', () => {
  function parkedThenScript(extraTurns: LlmStreamChunk[][]): {
    agent: PersonalButlerAgent
    exec: string[]
    t: Task
    parkState: () => Promise<unknown>
  } {
    const exec: string[] = []
    const provider = new ScriptProvider([
      toolTurn({ id: 't1', name: 'delete_agent', input: { handle: 'mailer' } }),
      ...extraTurns,
    ])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: emptyMemory(),
      system: 'base',
      captureTurns: false,
      governed: governedToolset(exec, async () => ({ decision: 'approve', reason: 'destructive' })),
    })
    const t = task('a', 'delete mailer')
    const parkState = async (): Promise<unknown> => {
      try {
        await agent.onTask(t)
        throw new Error('expected a park')
      } catch (e) {
        if (e instanceof SuspendTaskError) return e.state
        throw e
      }
    }
    return { agent, exec, t, parkState }
  }

  it('approve → runs the deferred action, then continues the loop', async () => {
    const { agent, exec, t, parkState } = parkedThenScript([textTurn('mailer is gone')])
    const state = await parkState()
    expect(exec).toEqual([]) // still nothing before approval

    const res = await agent.onResume(t, { ...(state as object), answer: { approved: true } })
    expect(okText(res)).toBe('mailer is gone')
    expect(exec).toEqual(['delete:mailer']) // executed exactly once, on approval
  })

  it('deny → fails closed (no side effect) and the model adapts', async () => {
    const { agent, exec, t, parkState } = parkedThenScript([textTurn('okay, I left mailer alone')])
    const state = await parkState()

    const res = await agent.onResume(t, { ...(state as object), answer: { approved: false, note: 'too risky' } })
    expect(okText(res)).toBe('okay, I left mailer alone')
    expect(exec).toEqual([]) // fail-closed: the action never ran
  })

  it('no decision recorded → fails closed (treated as denial, never implicit approval)', async () => {
    const { agent, exec, t, parkState } = parkedThenScript([textTurn('cancelled')])
    const state = await parkState()

    // Resume with the raw park state — no `answer` / `decision` injected.
    const res = await agent.onResume(t, state)
    expect(okText(res)).toBe('cancelled')
    expect(exec).toEqual([])
  })
})

describe('PersonalButlerAgent — refuse runs inline (no human)', () => {
  it('a refused governed tool returns an isError result without suspending', async () => {
    const exec: string[] = []
    const provider = new ScriptProvider([
      toolTurn({ id: 't1', name: 'delete_agent', input: { handle: 'mailer' } }),
      textTurn('I cannot do that'),
    ])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: emptyMemory(),
      system: 'base',
      captureTurns: false,
      governed: governedToolset(exec, async () => ({ decision: 'refuse', reason: 'out of scope' })),
    })

    const res = await agent.onTask(task('a', 'delete mailer'))
    expect(okText(res)).toBe('I cannot do that')
    expect(exec).toEqual([]) // refused → never executed, never parked
  })
})

describe('PersonalButlerAgent — mixed round parks the WHOLE round', () => {
  it('defers a benign sibling until the governed action is approved', async () => {
    const log: string[] = []
    const exec: string[] = []
    const provider = new ScriptProvider([
      // One turn requesting BOTH a benign echo and a governed delete.
      toolTurn(
        { id: 't1', name: 'echo', input: { msg: 'before' } },
        { id: 't2', name: 'delete_agent', input: { handle: 'mailer' } },
      ),
      textTurn('all done'),
    ])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: emptyMemory(),
      system: 'base',
      captureTurns: false,
      benign: benignToolset(log),
      governed: governedToolset(exec, async () => ({ decision: 'approve', reason: 'destructive' })),
    })
    const t = task('a', 'echo then delete')

    let state: unknown
    try {
      await agent.onTask(t)
      throw new Error('expected a park')
    } catch (e) {
      if (!(e instanceof SuspendTaskError)) throw e
      state = e.state
    }
    // The benign sibling did NOT run before the human decided — the round is atomic.
    expect(log).toEqual([])
    expect(exec).toEqual([])
    const gate = readButlerGateState(state)
    expect(gate!.pending!.toolUses.map((tu) => tu.name)).toEqual(['echo', 'delete_agent'])

    const res = await agent.onResume(t, { ...(state as object), answer: { approved: true } })
    expect(okText(res)).toBe('all done')
    // On approval BOTH run.
    expect(log).toEqual(['echo:before'])
    expect(exec).toEqual(['delete:mailer'])
  })

  it('mixed round + deny → benign sibling still runs, governed fails closed', async () => {
    const log: string[] = []
    const exec: string[] = []
    const provider = new ScriptProvider([
      toolTurn(
        { id: 't1', name: 'echo', input: { msg: 'before' } },
        { id: 't2', name: 'delete_agent', input: { handle: 'mailer' } },
      ),
      textTurn('echoed but kept mailer'),
    ])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: emptyMemory(),
      system: 'base',
      captureTurns: false,
      benign: benignToolset(log),
      governed: governedToolset(exec, async () => ({ decision: 'approve', reason: 'destructive' })),
    })
    const t = task('a', 'echo then delete')

    let state: unknown
    try {
      await agent.onTask(t)
      throw new Error('expected a park')
    } catch (e) {
      if (!(e instanceof SuspendTaskError)) throw e
      state = e.state
    }

    const res = await agent.onResume(t, { ...(state as object), answer: { approved: false } })
    expect(okText(res)).toBe('echoed but kept mailer')
    expect(log).toEqual(['echo:before']) // benign sibling deferred to resume, then ran
    expect(exec).toEqual([]) // governed fail-closed
  })
})

describe('PersonalButlerAgent — bounded', () => {
  it('aborts after maxToolRounds instead of looping forever', async () => {
    const log: string[] = []
    // Provider ALWAYS asks for another echo — would loop forever if unbounded.
    const provider = new ScriptProvider([toolTurn({ id: 'tN', name: 'echo', input: { msg: 'again' } })])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: emptyMemory(),
      system: 'base',
      captureTurns: false,
      maxToolRounds: 3,
      benign: benignToolset(log),
      governed: governedToolset([]),
    })

    const res = await agent.onTask(task('a', 'loop'))
    expect(res.kind).toBe('ok')
    expect(okText(res)).toContain('aborted after 3 tool-use rounds')
    expect(log.length).toBe(3) // ran exactly maxToolRounds benign calls, then stopped
  })
})
