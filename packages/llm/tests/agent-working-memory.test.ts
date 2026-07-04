/**
 * Phase 11 M4 — LlmAgent working memory across suspend/resume.
 *
 * The story:
 *   1. LlmAgent runs a tool-use loop. Round N tool result inflates the
 *      `req.messages` array.
 *   2. Round N+1 starts. `preCallHook` (or the provider, but we use the
 *      hook for determinism in tests) throws SuspendTaskError.
 *   3. LlmAgent catches it, re-throws with `state.__llmMessages` set to
 *      the current messages array — so `runOne`'s persistence path
 *      (Phase 11 M2) stores the conversation alongside the suspend
 *      record.
 *   4. Hub.resumeTask later (Phase 11 M3) reads the row and calls
 *      `onResume(task, state)`. LlmAgent.handleResume splices
 *      `__llmMessages` back into the request and continues the loop.
 *
 * Coverage:
 *   - Pre-call SuspendTaskError mid-loop wraps current messages
 *   - User-supplied state ride along under `state.user`
 *   - Resume with persisted memory continues the loop
 *   - Resume without persisted memory falls back to fresh handleTask
 *   - Resume without a toolset (no loop) also falls back
 *   - First-round suspend (no progress yet) is handled — messages array
 *     is the initial user message
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  Hub,
  SuspendTaskError,
  isSuspendTaskError,
  type ParticipantId,
  type Task,
} from '@gotong/core'

import {
  LlmAgent,
  type LlmAgentToolset,
  type LlmMessage,
  type LlmStreamChunk,
} from '../src/index.js'

// --- A scripted provider — emits one tool_use round, then text. -------------

class ScriptedProvider {
  public readonly name = 'scripted-mem'
  private round = 0
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *stream(_req: unknown): AsyncIterable<LlmStreamChunk> {
    const r = this.round++
    if (r === 0) {
      yield {
        type: 'tool_use',
        toolUse: {
          type: 'tool_use',
          id: 'tu-1',
          name: 'noop',
          input: { x: 1 },
        },
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }
    yield { type: 'text', text: 'final-after-resume' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

// A minimal toolset whose only tool is a no-op — keeps the loop alive
// so we can drive it through a second round.
const noopToolset: LlmAgentToolset = {
  async listTools() {
    return [{ name: 'noop', description: 'noop', inputSchema: { type: 'object' } }]
  },
  async callTool(_name, _input) {
    return { content: [{ type: 'text', text: 'ok' }] }
  },
}

// --- Fixtures ----------------------------------------------------------------

function makeTask(): Task {
  return {
    id: 'task-mem-1',
    from: 'system',
    strategy: { kind: 'explicit', to: 'mem-agent' },
    payload: { prompt: 'do the thing' },
    createdAt: 1_000,
  }
}

describe('LlmAgent — working memory persists across suspend/resume', () => {
  let hub: Hub
  beforeEach(async () => {
    hub = Hub.inMemory()
    await hub.start()
  })
  afterEach(async () => {
    await hub.stop()
  })

  it('preCall SuspendTaskError mid-loop is wrapped with __llmMessages', async () => {
    let preCallCalls = 0
    const agent = new LlmAgent({
      id: 'mem-agent',
      capabilities: ['x'],
      provider: new ScriptedProvider() as unknown as ConstructorParameters<
        typeof LlmAgent
      >[0]['provider'],
      tools: noopToolset,
      // Round 1's tool result lands; round 2's preCall fires → suspend.
      preCallHook: async () => {
        preCallCalls++
        if (preCallCalls === 2) {
          throw new SuspendTaskError({
            resumeAt: 12_345,
            state: { reason: 'budget gate trip' },
          })
        }
      },
    })

    let caught: unknown
    try {
      await agent.onTask(makeTask())
      expect.fail('expected SuspendTaskError')
    } catch (err) {
      caught = err
    }
    expect(isSuspendTaskError(caught)).toBe(true)
    const e = caught as SuspendTaskError
    expect(e.resumeAt).toBe(12_345)

    // The packed state must carry the messages from the round-2 request.
    // Round 1 added assistant + tool_result blocks; round 2's req
    // therefore has at least: initial user msg + assistant + tool_result
    // = 3 entries before the suspend fired.
    expect(e.state).toBeTypeOf('object')
    const s = e.state as {
      __llmMessages?: unknown
      __llmAgentMemVersion?: unknown
      user?: unknown
    }
    expect(Array.isArray(s.__llmMessages)).toBe(true)
    expect(s.__llmAgentMemVersion).toBe(1)
    expect(s.user).toEqual({ reason: 'budget gate trip' })
    const msgs = s.__llmMessages as LlmMessage[]
    expect(msgs.length).toBe(3)
    expect(msgs[0]!.role).toBe('user')
    expect(msgs[1]!.role).toBe('assistant') // round-1 tool_use
    expect(msgs[2]!.role).toBe('user') // round-1 tool_result
  })

  it('handleResume splices __llmMessages back into the request and continues the loop', async () => {
    const agent = new LlmAgent({
      id: 'mem-agent',
      capabilities: ['x'],
      provider: new ScriptedProvider() as unknown as ConstructorParameters<
        typeof LlmAgent
      >[0]['provider'],
      tools: noopToolset,
    })
    // Prebake a state shape that mimics what M2 would have persisted.
    const restored: LlmMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'noop', input: { x: 1 } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'tu-1', content: 'ok' }],
      },
    ]
    const result = await agent.onResume(makeTask(), {
      __llmAgentMemVersion: 1,
      __llmMessages: restored,
      user: { reason: 'rebuilt' },
    })
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      // ScriptedProvider's round 0 was already consumed in the
      // suspended view; with restored messages, the loop should
      // call stream() once and hit the 'text' path (which the
      // provider scripts as round 1's content "final-after-resume").
      const out = result.output as { text?: string }
      expect(out.text).toBe('final-after-resume')
    }
  })

  it('handleResume without persisted memory falls back to handleTask (fresh run)', async () => {
    const agent = new LlmAgent({
      id: 'mem-agent',
      capabilities: ['x'],
      provider: new ScriptedProvider() as unknown as ConstructorParameters<
        typeof LlmAgent
      >[0]['provider'],
      tools: noopToolset,
    })
    // No __llmMessages field — should run a fresh tool-use loop.
    const result = await agent.onResume(makeTask(), { someUserField: 'unused' })
    expect(result.kind).toBe('ok')
    // Fresh run consumed scripted round 0 (tool_use); response is the
    // tool result feed-back round 1 text.
    if (result.kind === 'ok') {
      const out = result.output as { text?: string }
      expect(out.text).toBe('final-after-resume')
    }
  })

  it('handleResume without a toolset returns from handleTask (single-shot path)', async () => {
    // No toolset → handleTask hits the no-tool branch, single stream call.
    const provider = new ScriptedProvider()
    const agent = new LlmAgent({
      id: 'mem-agent',
      capabilities: ['x'],
      provider: provider as unknown as ConstructorParameters<
        typeof LlmAgent
      >[0]['provider'],
    })
    const result = await agent.onResume(makeTask(), {
      __llmAgentMemVersion: 1,
      __llmMessages: [
        { role: 'user', content: [{ type: 'text', text: 'old' }] },
      ],
    })
    // The first stream() call from ScriptedProvider emits a tool_use
    // chunk, but since there's no toolset, LlmAgent's no-tool path
    // just hands the stream's end result up. The output text is
    // empty because the assistant chose to use a tool we won't run.
    expect(result.kind).toBe('ok')
  })

  it('first-round preCall suspend captures the initial user message only', async () => {
    let preCallCalls = 0
    const agent = new LlmAgent({
      id: 'mem-agent',
      capabilities: ['x'],
      provider: new ScriptedProvider() as unknown as ConstructorParameters<
        typeof LlmAgent
      >[0]['provider'],
      tools: noopToolset,
      preCallHook: async () => {
        preCallCalls++
        // suspend on the very first call
        throw new SuspendTaskError({ resumeAt: 9, state: { round: 1 } })
      },
    })
    let caught: unknown
    try {
      await agent.onTask(makeTask())
    } catch (err) {
      caught = err
    }
    expect(isSuspendTaskError(caught)).toBe(true)
    const e = caught as SuspendTaskError
    const s = e.state as { __llmMessages?: LlmMessage[] }
    expect(s.__llmMessages?.length).toBe(1)
    expect(s.__llmMessages?.[0]!.role).toBe('user')
    expect(preCallCalls).toBe(1)
  })

  it('plain (non-suspend) error from preCall is not wrapped', async () => {
    const agent = new LlmAgent({
      id: 'mem-agent',
      capabilities: ['x'],
      provider: new ScriptedProvider() as unknown as ConstructorParameters<
        typeof LlmAgent
      >[0]['provider'],
      tools: noopToolset,
      preCallHook: async () => {
        throw new Error('rate limited')
      },
    })
    const result = await agent.onTask(makeTask())
    // Plain throw → AgentParticipant.onTask turns it into failed.
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toBe('rate limited')
    }
  })
})

// --- R11 — working-memory schema version gate -------------------------------
//
// `extractRestoredMessages` must replay a persisted `__llmMessages` blob ONLY
// when its `__llmAgentMemVersion` matches the current code's version. A row
// written under an older (incompatible) schema is discarded — the resume
// falls back to a fresh `handleTask` rather than splicing now-malformed
// messages into `provider.stream`. We observe which messages reach the
// provider on its first call to tell "replayed stale memory" apart from
// "ran fresh".

// Records the text blocks of every message handed to `stream` on the FIRST
// call, then completes the turn. A toolset is attached so the resume path
// goes through the tool loop (where memory would be spliced).
class FirstCallRecordingProvider {
  public readonly name = 'recording-mem'
  public firstCallTexts: string[] | null = null
  private round = 0
  async *stream(req: {
    messages?: Array<{ content?: unknown }>
  }): AsyncIterable<LlmStreamChunk> {
    if (this.round === 0) {
      const texts: string[] = []
      for (const m of req.messages ?? []) {
        const content = (m as { content?: unknown }).content
        if (Array.isArray(content)) {
          for (const b of content) {
            const blk = b as { type?: string; text?: string }
            if (blk.type === 'text' && typeof blk.text === 'string') {
              texts.push(blk.text)
            }
          }
        } else if (typeof content === 'string') {
          texts.push(content)
        }
      }
      this.firstCallTexts = texts
    }
    this.round++
    yield { type: 'text', text: 'recorded-done' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

const STALE_MARKER = 'STALE-MEMORY-MARKER-DO-NOT-REPLAY'

function staleMemory(): LlmMessage[] {
  return [{ role: 'user', content: [{ type: 'text', text: STALE_MARKER }] }]
}

function makeRecordingAgent(provider: FirstCallRecordingProvider): LlmAgent {
  return new LlmAgent({
    id: 'mem-agent',
    capabilities: ['x'],
    provider: provider as unknown as ConstructorParameters<
      typeof LlmAgent
    >[0]['provider'],
    tools: noopToolset,
  })
}

describe('LlmAgent — R11 working-memory version gate', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('replays restored memory when the version matches (current = 1)', async () => {
    const provider = new FirstCallRecordingProvider()
    const agent = makeRecordingAgent(provider)
    const result = await agent.onResume(makeTask(), {
      __llmAgentMemVersion: 1,
      __llmMessages: staleMemory(),
    })
    expect(result.kind).toBe('ok')
    // The marker message reached the provider → memory WAS replayed.
    expect(provider.firstCallTexts).toContain(STALE_MARKER)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('discards memory + falls back to fresh handleTask when version mismatches', async () => {
    const provider = new FirstCallRecordingProvider()
    const agent = makeRecordingAgent(provider)
    const result = await agent.onResume(makeTask(), {
      __llmAgentMemVersion: 999, // a future, incompatible schema
      __llmMessages: staleMemory(),
    })
    // Fresh run still succeeds — the task is re-executed from scratch.
    expect(result.kind).toBe('ok')
    // The stale marker must NOT have reached the provider; the fresh
    // `buildRequest` seeds messages from the task payload instead.
    expect(provider.firstCallTexts).not.toContain(STALE_MARKER)
    expect(provider.firstCallTexts).toContain('do the thing')
    // Mismatch is logged so operators can see a schema bump took effect.
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]![0])).toMatch(/version mismatch/i)
  })

  it('treats a memory blob missing the version field as a mismatch (fail-safe)', async () => {
    const provider = new FirstCallRecordingProvider()
    const agent = makeRecordingAgent(provider)
    const result = await agent.onResume(makeTask(), {
      // No __llmAgentMemVersion — a malformed or pre-versioning blob.
      __llmMessages: staleMemory(),
    })
    expect(result.kind).toBe('ok')
    expect(provider.firstCallTexts).not.toContain(STALE_MARKER)
    expect(provider.firstCallTexts).toContain('do the thing')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})
