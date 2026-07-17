/**
 * `PersonalButlerAgent` — the bounded, governance-gated tool-loop.
 *
 * These tests drive the butler with a scripted provider + fake memory and
 * assert the M4 contract: benign tools run inline, governed tools PARK before
 * any side effect (`SuspendTaskError`), and resume injects a human decision —
 * approve runs the deferred action, deny / no-decision fails closed.
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
import type { MemoryEntry, MemoryHandle, MemoryKind, MemoryQuery, NewMemoryEntry } from '@gotong/services-sdk'
import { describe, expect, it } from 'vitest'

import {
  GovernedActionToolset,
  PersonalButlerAgent,
  buildButlerClockProbe,
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

describe('PersonalButlerAgent — current-time awareness (clock probe → system tail)', () => {
  it('injects the current-time card AFTER the persona, as the variable prompt tail', async () => {
    // 2025-07-08 22:34 in Asia/Kuala_Lumpur (== 14:34Z).
    const FIXED = 1_751_985_240_000
    const provider = new ScriptProvider([textTurn('ok')])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: emptyMemory(),
      system: 'base',
      captureTurns: false,
      contextProbe: buildButlerClockProbe({ now: () => FIXED, timeZone: 'Asia/Kuala_Lumpur' }),
    })

    await agent.onTask(task('a', '现在几点'))
    const req = provider.requests[0]!
    const card = '【当前时间】2025-07-08 星期二 22:34（Asia/Kuala_Lumpur, UTC+08:00）· UTC 2025-07-08T14:34Z'
    // NA-M3 — the persona stays alone in the STABLE slice (`system`): the
    // minute-level clock card must never churn the cached persona +
    // frozen-block prefix. The card rides `systemVolatile`, carrying its own
    // '\n\n' separator so providers' verbatim concatenation reproduces the
    // exact pre-M3 on-wire bytes.
    expect(req.system).toContain('base')
    expect(req.system).not.toContain('【当前时间】')
    expect(req.systemVolatile).toBeDefined()
    expect(req.systemVolatile!.startsWith('\n\n')).toBe(true)
    expect(req.systemVolatile).toContain(card)
    expect(req.systemVolatile!.trimEnd().endsWith('· UTC 2025-07-08T14:34Z')).toBe(true)
  })
})

describe('PersonalButlerAgent — LIB-M3 stable card (stableContext → req.system tail)', () => {
  it('appends the card to the STABLE segment; volatile advice stays separate', async () => {
    const FIXED = 1_751_985_240_000 // 2025-07-08 22:34 Asia/Kuala_Lumpur
    const provider = new ScriptProvider([textTurn('ok')])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: emptyMemory(),
      system: 'base',
      captureTurns: false,
      contextProbe: buildButlerClockProbe({ now: () => FIXED, timeZone: 'Asia/Kuala_Lumpur' }),
      stableContext: async () => '【知识库索引】\n- user/家人.md — 家人档案',
    })

    await agent.onTask(task('a', '你知道什么'))
    const req = provider.requests[0]!
    // State rides `system` (the cached segment), at the very tail: frozen
    // block leads, persona follows, the card closes the stable slice.
    expect(req.system!.startsWith('<!-- gotong:memory:begin -->')).toBe(true)
    expect(req.system!.endsWith('base\n\n【知识库索引】\n- user/家人.md — 家人档案')).toBe(true)
    // Advice (the clock) still rides `systemVolatile`, never the stable slice.
    expect(req.systemVolatile).toContain('【当前时间】')
    expect(req.systemVolatile).not.toContain('知识库索引')
  })

  it('null / throw ⇒ req.system byte-identical to a butler without the option', async () => {
    const mk = (stableContext?: () => Promise<string | null>) => {
      const provider = new ScriptProvider([textTurn('ok')])
      const agent = new PersonalButlerAgent({
        id: 'butler',
        provider,
        memory: emptyMemory(),
        system: 'base',
        captureTurns: false,
        ...(stableContext ? { stableContext } : {}),
      })
      return { provider, agent }
    }
    const bare = mk()
    await bare.agent.onTask(task('a', 'hi'))
    const nulled = mk(async () => null)
    await nulled.agent.onTask(task('a', 'hi'))
    const sick = mk(async () => {
      throw new Error('boom')
    })
    await sick.agent.onTask(task('a', 'hi'))

    expect(nulled.provider.requests[0]!.system).toBe(bare.provider.requests[0]!.system)
    expect(sick.provider.requests[0]!.system).toBe(bare.provider.requests[0]!.system)
    expect(sick.provider.requests[0]!.systemVolatile).toBeUndefined()
  })

  it('resume re-reads the card (state semantics — unlike the probe, which stays silent)', async () => {
    let card = '【知识库索引】v1'
    const exec: string[] = []
    const provider = new ScriptProvider([
      toolTurn({ id: 't1', name: 'delete_agent', input: { handle: 'mailer' } }),
      textTurn('done'),
    ])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: emptyMemory(),
      system: 'base',
      captureTurns: false,
      governed: governedToolset(exec, async () => ({ decision: 'approve', reason: 'destructive' })),
      stableContext: async () => card,
    })
    const t = task('a', 'delete mailer')
    let state: unknown
    try {
      await agent.onTask(t)
      throw new Error('expected a park')
    } catch (e) {
      if (!(e instanceof SuspendTaskError)) throw e
      state = e.state
    }
    expect(provider.requests[0]!.system).toContain('v1')

    // 批准等待期间索引被重组(比如另一场对话里阿同整理了书架)——resume 的
    // 请求必须带当前状态,镜像冻结块重启后按当前记忆重组的先例。
    card = '【知识库索引】v2'
    const res = await agent.onResume(t, { ...(state as object), answer: { approved: true } })
    okText(res)
    const resumeReq = provider.requests.at(-1)!
    expect(resumeReq.system).toContain('v2')
    expect(resumeReq.system).not.toContain('v1')
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

describe('PersonalButlerAgent — multiple governed gates coexist (steward + MCP writes)', () => {
  // S1-M2: the butler can carry TWO self-contained governed toolsets — the
  // steward action set (`delete_agent`) AND the write half of a notes/calendar
  // MCP (`notes_create`). A tool routes to the FIRST gate that governs it; each
  // gate keeps its OWN classify / describe / execute. This proves the park picks
  // the RIGHT gate's title and the RIGHT gate's executor — and never touches the
  // other gate.
  function mcpWriteToolset(execLog: string[]): GovernedActionToolset {
    return new GovernedActionToolset({
      tools: [{ name: 'notes_create', description: 'create a note', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }],
      classify: async () => ({ decision: 'approve', reason: '会在你的笔记上新建一条' }),
      describe: (_name, args) => `在你的笔记上创建:${String(args.title)}`,
      execute: async (_name, args) => {
        execLog.push(`note:${String(args.title)}`)
        return { text: `created ${String(args.title)}` }
      },
    })
  }

  it('parks an MCP-write via its OWN gate (title + executor), leaving the steward gate untouched', async () => {
    const stewardExec: string[] = []
    const mcpExec: string[] = []
    const provider = new ScriptProvider([
      toolTurn({ id: 't1', name: 'notes_create', input: { title: '买牛奶' } }),
      textTurn('已帮你记下'),
    ])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: emptyMemory(),
      system: 'base',
      captureTurns: false,
      // Two gates, in array order — steward first, MCP writes second.
      governed: [governedToolset(stewardExec), mcpWriteToolset(mcpExec)],
    })
    const t = task('a', '帮我记一下买牛奶')

    let state: unknown
    try {
      await agent.onTask(t)
      throw new Error('expected a park')
    } catch (e) {
      if (!(e instanceof SuspendTaskError)) throw e
      state = e.state
    }
    const gate = readButlerGateState(state)
    // The inbox title came from the MCP gate's describe, not the steward gate's.
    expect(gate!.pending!.approval.toolName).toBe('notes_create')
    expect(gate!.pending!.approval.title).toBe('在你的笔记上创建:买牛奶')
    expect(gate!.pending!.approval.reason).toContain('笔记')
    expect(mcpExec).toEqual([]) // nothing ran before approval
    expect(stewardExec).toEqual([])

    const res = await agent.onResume(t, { ...(state as object), answer: { approved: true } })
    expect(okText(res)).toBe('已帮你记下')
    expect(mcpExec).toEqual(['note:买牛奶']) // executed via the MCP gate
    expect(stewardExec).toEqual([]) // the steward gate was never involved
  })

  it('routes each gate independently — steward delete parks via the steward gate', async () => {
    const stewardExec: string[] = []
    const mcpExec: string[] = []
    const provider = new ScriptProvider([
      toolTurn({ id: 't1', name: 'delete_agent', input: { handle: 'mailer' } }),
      textTurn('mailer is gone'),
    ])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: emptyMemory(),
      system: 'base',
      captureTurns: false,
      governed: [
        governedToolset(stewardExec, async () => ({ decision: 'approve', reason: 'destructive — deletes an agent' })),
        mcpWriteToolset(mcpExec),
      ],
    })
    const t = task('a', 'delete mailer')

    let state: unknown
    try {
      await agent.onTask(t)
      throw new Error('expected a park')
    } catch (e) {
      if (!(e instanceof SuspendTaskError)) throw e
      state = e.state
    }
    const gate = readButlerGateState(state)
    expect(gate!.pending!.approval.toolName).toBe('delete_agent')
    expect(gate!.pending!.approval.reason).toContain('destructive')

    const res = await agent.onResume(t, { ...(state as object), answer: { approved: true } })
    expect(okText(res)).toBe('mailer is gone')
    expect(stewardExec).toEqual(['delete:mailer'])
    expect(mcpExec).toEqual([]) // the MCP gate stayed out of it
  })
})

describe('PersonalButlerAgent — pure-memory (no governed toolset)', () => {
  // The IM fold-in's first cut: a butler that REMEMBERS across sessions but has
  // no approval-gated actions yet. With `governed` omitted the loop can never
  // park — every tool is benign — so a live chat agent gains memory with
  // near-zero behaviour change.
  it('runs benign tools inline and never parks when constructed without `governed`', async () => {
    const log: string[] = []
    const provider = new ScriptProvider([
      toolTurn({ id: 't1', name: 'echo', input: { msg: 'hi' } }),
      textTurn('done'),
    ])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: emptyMemory(),
      system: 'base',
      captureTurns: false,
      benign: benignToolset(log),
      // no `governed`
    })

    const res = await agent.onTask(task('a', 'say hi'))
    expect(okText(res)).toBe('done')
    expect(log).toEqual(['echo:hi']) // benign ran inline; nothing parked
  })

  it('works with NEITHER benign nor governed — memory only, a plain turn finishes', async () => {
    // Exercises the `composed === undefined` constructor path: the base still
    // composes the memory tools in front, so the butler always has memory.
    const provider = new ScriptProvider([textTurn('hello, I remember you')])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: emptyMemory(),
      system: 'base',
      captureTurns: false,
    })

    const res = await agent.onTask(task('a', 'hi'))
    expect(okText(res)).toBe('hello, I remember you')
  })

  it('captures the turn into episodic memory so a later session can recall it', async () => {
    // Capture is THE cross-session-memory mechanism — extractive (no model call),
    // it runs in handleTask whether or not the model touched a tool. With no
    // governed toolset (pure-memory butler) it still records the turn verbatim.
    const mem = emptyMemory()
    const provider = new ScriptProvider([textTurn('好的，我记住了')])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: mem,
      system: 'base',
      captureTurns: true, // turn-end capture ON (the default)
    })

    const res = await agent.onTask(task('a', '我在做一个奶茶店项目'))
    expect(res.kind).toBe('ok')
    // The episodic log holds "User: …奶茶店…\nButler: 好的，我记住了".
    const stored = await mem.list()
    expect(stored.some((e) => e.kind === 'episodic' && e.text.includes('奶茶店'))).toBe(true)
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

describe('PersonalButlerAgent — approval scope is exactly what the human saw', () => {
  // A round can mix governed actions with DIFFERENT verdicts. The park shows the
  // human ONE action; resume must not launder the rest. Regression for the P0
  // where resume re-ran every deferred governed call on a single approval —
  // executing a server-REFUSED sibling and a SECOND unseen `approve`.
  function twoActionGate(execLog: string[], classify: GovernedClassifier): GovernedActionToolset {
    return new GovernedActionToolset({
      tools: [
        { name: 'delete_agent', description: 'delete a managed agent', inputSchema: { type: 'object', properties: { handle: { type: 'string' } } } },
        { name: 'send_email', description: 'send an email', inputSchema: { type: 'object', properties: { to: { type: 'string' } } } },
      ],
      classify,
      execute: async (name: string, args: Record<string, unknown>) => {
        execLog.push(`${name}:${String(args.handle ?? args.to)}`)
        return { text: `${name} done` }
      },
    })
  }

  it('a REFUSED sibling never runs when a DIFFERENT action is approved', async () => {
    const exec: string[] = []
    // delete_agent → refuse (hard no); send_email → approve (parks).
    const classify: GovernedClassifier = async (name) =>
      name === 'delete_agent'
        ? { decision: 'refuse', reason: 'destructive — deletes an agent' }
        : { decision: 'approve', reason: '会替你发一封邮件' }
    const provider = new ScriptProvider([
      toolTurn(
        { id: 't1', name: 'delete_agent', input: { handle: 'mailer' } },
        { id: 't2', name: 'send_email', input: { to: 'bob' } },
      ),
      textTurn('sent the email'),
    ])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: emptyMemory(),
      system: 'base',
      captureTurns: false,
      governed: twoActionGate(exec, classify),
    })
    const t = task('a', 'delete mailer and email bob')

    let state: unknown
    try {
      await agent.onTask(t)
      throw new Error('expected a park')
    } catch (e) {
      if (!(e instanceof SuspendTaskError)) throw e
      state = e.state
    }
    const gate = readButlerGateState(state)
    expect(gate!.pending!.approval.toolName).toBe('send_email') // parked on the APPROVE one
    expect(gate!.pending!.approvedId).toBe('t2')
    expect(gate!.pending!.verdicts.t1!.decision).toBe('refuse') // the refuse is on record

    const res = await agent.onResume(t, { ...(state as object), answer: { approved: true } })
    expect(okText(res)).toBe('sent the email')
    // ONLY the approved action ran; the server-refused delete NEVER did.
    expect(exec).toEqual(['send_email:bob'])
  })

  it('a SECOND approve the human never saw does not run on the first approval', async () => {
    const exec: string[] = []
    // Both need approval; the park shows only the FIRST.
    const classify: GovernedClassifier = async () => ({ decision: 'approve', reason: '需要批准' })
    const provider = new ScriptProvider([
      toolTurn(
        { id: 't1', name: 'send_email', input: { to: 'bob' } },
        { id: 't2', name: 'delete_agent', input: { handle: 'mailer' } },
      ),
      textTurn('done'),
    ])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: emptyMemory(),
      system: 'base',
      captureTurns: false,
      governed: twoActionGate(exec, classify),
    })
    const t = task('a', 'email bob and delete mailer')

    let state: unknown
    try {
      await agent.onTask(t)
      throw new Error('expected a park')
    } catch (e) {
      if (!(e instanceof SuspendTaskError)) throw e
      state = e.state
    }
    const gate = readButlerGateState(state)
    expect(gate!.pending!.approval.toolName).toBe('send_email') // human sees only the first
    expect(gate!.pending!.approvedId).toBe('t1')

    const res = await agent.onResume(t, { ...(state as object), answer: { approved: true } })
    expect(okText(res)).toBe('done')
    // Approving the email must NOT also delete the agent — that action was never shown.
    expect(exec).toEqual(['send_email:bob'])
  })
})
