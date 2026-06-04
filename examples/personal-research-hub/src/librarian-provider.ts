/**
 * The librarian's "brain" — a deterministic stand-in for the LLM that reads the
 * GOAL + the wiki's CURRENT state and dispatches accordingly. This is the upgrade
 * (结合使用者的情况): no more fixed "compile both, ask one hardcoded question"
 * script regardless of what was asked or what's already compiled.
 *
 * It is a real `LlmProvider` (not a fixed `MockLlmProvider` script), because the
 * ingest-vs-retrieve decision now depends on the input the way a real model's would:
 *
 *   · Every `stream(req)` call sees the goal + a `知识库状态: {...}` snapshot the
 *     hub injected into the prompt (which raw sources exist, which are already
 *     compiled). It calls the pure `planResearch(goal, snapshot)` to decide the
 *     steps — compile ONLY the missing sources, retrieve only when a question was
 *     asked — then dispatches one step per turn.
 *   · It knows which turn it is on by COUNTING prior `tool_use` blocks — so turn k
 *     dispatches `plan.steps[k]`, then it reports how it routed and why.
 *
 * Swap this for a real provider (Anthropic / OpenAI / DeepSeek) and the judgement
 * becomes the model's; the hub wiring is identical.
 */

import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@aipehub/llm'

import { planResearch, type KbSnapshot } from './research-plan.js'

export function createLibrarianProvider(): LlmProvider {
  return new SituationAwareLibrarianProvider()
}

class SituationAwareLibrarianProvider implements LlmProvider {
  readonly name = 'librarian-situation-aware'

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const { goal, snap } = readContext(req)
    const plan = planResearch(goal, snap)
    const turn = countDispatched(req)

    if (turn < plan.steps.length) {
      const step = plan.steps[turn]!
      if (step.kind === 'compile') {
        yield { type: 'text', text: `→ compile ${step.source}` }
        yield dispatch(`compile-${turn}`, 'compiler', `compile ${step.source}`, { source: step.source })
      } else {
        yield { type: 'text', text: '→ retrieve (ask-your-wiki)' }
        yield dispatch(`retrieve-${turn}`, 'researcher', 'answer from the wiki', { question: step.question })
      }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }

    // Routing done — report how it adapted to the wiki state (the rationale is the
    // proof the dispatch fitted the situation, not a fixed compile-both script).
    const nCompiled = plan.steps.filter((s) => s.kind === 'compile').length
    const tail = plan.retrieve ? 'answered from the wiki' : 'no question asked'
    yield {
      type: 'text',
      text: `Plan [ingest=${plan.ingest}, retrieve=${plan.retrieve}]: compiled ${nCompiled} new source(s), ${tail}. ${plan.rationale}.`,
    }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

/** One `dispatch_task` tool_use chunk to the named worker agent. */
function dispatch(id: string, agentId: string, title: string, payload: unknown): LlmStreamChunk {
  return { type: 'tool_use', toolUse: { type: 'tool_use', id, name: 'dispatch_task', input: { agentId, title, payload } } }
}

/** The goal + injected wiki snapshot, both read from the first user message. */
function readContext(req: LlmRequest): { goal: string; snap: KbSnapshot } {
  const full = firstUserString(req)
  const marker = full.indexOf('知识库状态:')
  const goal = (marker >= 0 ? full.slice(0, marker) : full).trim()
  return { goal, snap: parseSnapshot(full) }
}

/** The goal = the first user message with string content (tool results are arrays). */
function firstUserString(req: LlmRequest): string {
  for (const m of req.messages) {
    if (m.role === 'user' && typeof m.content === 'string') return m.content
  }
  return ''
}

/** Pull the `知识库状态: {…}` JSON the hub injected; default to an empty wiki. */
function parseSnapshot(full: string): KbSnapshot {
  const m = full.match(/知识库状态:\s*([\s\S]*)$/)
  if (m) {
    try {
      const obj = JSON.parse(m[1]!.trim()) as Partial<KbSnapshot>
      return { rawSources: obj.rawSources ?? [], compiledSlugs: obj.compiledSlugs ?? [] }
    } catch {
      // fall through to the empty default
    }
  }
  return { rawSources: [], compiledSlugs: [] }
}

/** Which turn we're on = how many `tool_use` blocks the loop has already appended. */
function countDispatched(req: LlmRequest): number {
  let n = 0
  for (const msg of req.messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue
    for (const b of msg.content) if (b.type === 'tool_use') n++
  }
  return n
}
