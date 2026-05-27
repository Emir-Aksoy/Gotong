/**
 * Phase 10 M5 — architect-team example.
 *
 * Demonstrates the Phase 10 dispatch path end-to-end: an architect
 * `LlmAgent` uses its tool-use loop (via `DispatchToolset`) to fan
 * out three sub-tasks — one each to writer / reviewer / tester
 * sub-agents — then aggregates their replies into a final plan.
 *
 * No real LLM is used. The architect's provider is a scripted
 * `MockLlmProvider` that, on round 1, emits three `tool_use` chunks
 * targeting the sub-agents, and on round 2 emits the aggregated
 * plan as plain text. Swapping in a real provider would be a
 * one-line change — the dispatch wiring is provider-agnostic.
 *
 * What this example proves:
 *
 *   1. `DispatchToolset` is a first-class entry to `hub.dispatch`
 *      from inside a tool-use loop.
 *   2. Sub-tasks carry the parent's ancestry — the transcript
 *      shows the chain explicitly.
 *   3. Capability matching still works for sub-agents (writer /
 *      reviewer / tester each advertise one capability).
 *
 * Run:  pnpm demo:architect-team
 */

import { Hub, AgentParticipant, type Task, type TranscriptEntry } from '@aipehub/core'
import {
  DispatchToolset,
  LlmAgent,
  MockLlmProvider,
  type LlmStreamChunk,
} from '@aipehub/llm'

// --- Sub-agents — plain echo-style AgentParticipants -------------------------

class EchoAgent extends AgentParticipant {
  constructor(
    id: string,
    capabilities: readonly string[],
    private readonly reply: string,
  ) {
    super({ id, capabilities })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    // Pull the topic out of the dispatched payload so the reply
    // looks plausible. `payload` is `unknown` over the wire.
    const topic =
      typeof task.payload === 'object' &&
      task.payload !== null &&
      'topic' in task.payload &&
      typeof (task.payload as { topic: unknown }).topic === 'string'
        ? (task.payload as { topic: string }).topic
        : '(no topic)'
    return { from: this.id, topic, text: this.reply }
  }
}

// --- Architect provider — scripted dispatch + aggregation --------------------

/**
 * A bespoke provider that mocks an LLM's "use dispatch_task three times,
 * then write the final plan" flow. Round 1 emits three `tool_use`
 * chunks. Round 2 (after the agent has resolved all three tool calls
 * and fed their results back into messages) emits the aggregated
 * plan as plain text.
 */
class ScriptedArchitectProvider {
  public readonly name = 'architect-mock'
  private round = 0
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *stream(_req: unknown): AsyncIterable<LlmStreamChunk> {
    const r = this.round++
    if (r === 0) {
      // Three parallel sub-task dispatches via tool-use.
      for (const t of [
        {
          id: 'tu-writer',
          agentId: 'writer',
          topic: 'why TypeScript',
        },
        {
          id: 'tu-reviewer',
          agentId: 'reviewer',
          topic: 'why TypeScript',
        },
        {
          id: 'tu-tester',
          agentId: 'tester',
          topic: 'why TypeScript',
        },
      ]) {
        yield {
          type: 'tool_use',
          toolUse: {
            type: 'tool_use',
            id: t.id,
            name: 'dispatch_task',
            input: { agentId: t.agentId, payload: { topic: t.topic } },
          },
        }
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }
    // Round 2: the LLM "synthesises" the three tool results into a
    // final plan. We just emit a static placeholder; a real provider
    // would actually read messages here.
    yield {
      type: 'text',
      text: [
        '# Plan',
        '',
        '1. Draft per writer.',
        '2. Review per reviewer.',
        '3. Test per tester.',
      ].join('\n'),
    }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

// --- Transcript pretty-print -------------------------------------------------

function describe(e: TranscriptEntry): string {
  switch (e.kind) {
    case 'task': {
      const s = e.data.strategy
      const target =
        s.kind === 'explicit'
          ? `to=${s.to}`
          : s.kind === 'capability'
            ? `caps=[${s.capabilities.join(',')}]`
            : 'broadcast'
      const anc = e.data.ancestry
        ? ` ancestry=${e.data.ancestry.map((n) => n.by).join('→')}`
        : ''
      return `TASK     ${e.data.from} "${e.data.title ?? '(untitled)'}" via ${s.kind} ${target}${anc}`
    }
    case 'task_result':
      if (e.data.kind === 'ok') return `RESULT   ok by ${e.data.by}`
      if (e.data.kind === 'failed') return `RESULT   failed by ${e.data.by}: ${e.data.error}`
      if (e.data.kind === 'cancelled') return `RESULT   cancelled: ${e.data.reason}`
      return `RESULT   no_participant: ${e.data.reason}`
    case 'participant_joined':
      return `JOIN     ${e.data.id} caps=[${e.data.capabilities.join(',')}]`
    case 'llm_stream_chunk':
      return `STREAM   ${e.data.agentId} task=${e.data.taskId.slice(0, 8)}…`
    default:
      return e.kind
  }
}

async function main(): Promise<void> {
  const hub = Hub.inMemory()
  await hub.start()
  hub.onEvent((e) => {
    console.log(`  [seq=${String(e.seq).padStart(2, '0')}] ${describe(e)}`)
  })

  // Register the three sub-agents directly (cap-routed, no LLM).
  hub.register(
    new EchoAgent(
      'writer',
      ['draft'],
      'TypeScript shrinks the gap between intent and code.',
    ),
  )
  hub.register(
    new EchoAgent(
      'reviewer',
      ['review'],
      "Tighten the second clause — say it's a typed JS, not a new language.",
    ),
  )
  hub.register(
    new EchoAgent('tester', ['test'], 'No syntax errors; one logic gap on null narrowing.'),
  )

  // The architect: an LlmAgent backed by the scripted provider, with
  // a DispatchToolset whose allow-list points at the three subs.
  const architectId = 'architect'
  const dispatchToolset = DispatchToolset.create({
    hub,
    selfId: architectId,
    allowedAgents: ['writer', 'reviewer', 'tester'],
  })
  hub.register(
    new LlmAgent({
      id: architectId,
      capabilities: ['plan'],
      provider: new ScriptedArchitectProvider() as unknown as ConstructorParameters<
        typeof LlmAgent
      >[0]['provider'],
      system:
        'You are an architect. Dispatch sub-tasks to writer/reviewer/tester then synthesise.',
      tools: dispatchToolset,
    }),
  )

  console.log('\n=== AipeHub demo: architect-team (Phase 10) ===\n')

  // Kick off the plan request. Dispatch is capability-routed, so the
  // hub picks the architect (the sole 'plan' agent). The architect's
  // tool-use loop then fan-outs sub-tasks via dispatch_task.
  const result = await hub.dispatch({
    from: 'system',
    strategy: { kind: 'capability', capabilities: ['plan'] },
    payload: { topic: 'why TypeScript' },
    title: 'plan something',
  })
  if (result.kind !== 'ok') {
    throw new Error(`plan failed: ${JSON.stringify(result)}`)
  }
  const out = result.output as { text?: string }
  console.log('\n  📐 architect plan:\n')
  console.log(
    (out.text ?? '(no text)')
      .split('\n')
      .map((l) => `     ${l}`)
      .join('\n'),
  )
  console.log(`\n  transcript: ${hub.transcript.size()} entries\n`)

  await hub.stop()
  process.exit(0)
}

main().catch((err) => {
  console.error('[architect-team] fatal:', err)
  process.exit(1)
})
