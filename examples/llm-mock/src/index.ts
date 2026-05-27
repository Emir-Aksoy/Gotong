/**
 * llm-mock — exercises the LlmAgent pipeline without any LLM API key.
 *
 * Two agents, both LlmAgent instances backed by MockLlmProvider:
 *   - writer: capability "draft", reply derived from the topic
 *   - reviewer: capability "review", canned response
 *
 * The point is to show that LlmAgent + LlmProvider is the right abstraction —
 * swapping `MockLlmProvider` for `AnthropicProvider` or `OpenAIProvider` (see
 * examples/llm-real) requires zero changes to the agent code itself.
 */

import { Hub, type TranscriptEntry } from '@aipehub/core'
import {
  LlmAgent,
  MockLlmProvider,
  type LlmRequest,
} from '@aipehub/llm'

function describe(e: TranscriptEntry): string {
  switch (e.kind) {
    case 'participant_joined':
      return `JOIN     ${e.data.id} (${e.data.participantKind}) caps=[${e.data.capabilities.join(',')}]`
    case 'participant_left':
      return `LEAVE    ${e.data.id}`
    case 'message':
      return `MSG      ${e.data.from} -> #${e.data.channel}`
    case 'task': {
      const s = e.data.strategy
      const target =
        s.kind === 'explicit'
          ? `to=${s.to}`
          : s.kind === 'capability'
            ? `caps=[${s.capabilities.join(',')}]`
            : `broadcast`
      return `TASK     ${e.data.from} "${e.data.title ?? '(untitled)'}" via ${s.kind} ${target}`
    }
    case 'task_result': {
      const r = e.data
      if (r.kind === 'ok') return `RESULT   ok by ${r.by}`
      if (r.kind === 'failed') return `RESULT   failed by ${r.by}: ${r.error}`
      if (r.kind === 'cancelled') return `RESULT   cancelled: ${r.reason}`
      if (r.kind === 'suspended')
        return `RESULT   suspended by ${r.by} until ${new Date(r.resumeAt).toISOString()}`
      return `RESULT   no_participant: ${r.reason}`
    }
    case 'agent_pending':
      return `PENDING  ${e.data.agents.map((a) => a.id).join(',')}`
    case 'agent_approved':
      return `APPROVE  ${e.data.agentIds.join(',')}`
    case 'agent_rejected':
      return `REJECT   ${e.data.agentIds.join(',')} — ${e.data.reason}`
    case 'evaluation':
      return `EVAL     ${e.data.taskId.slice(0, 8)}… by ${e.data.by}`
    case 'service_trashed':
      return `TRASH    ${e.data.type}:${e.data.impl} owner=${e.data.ownerKind}/${e.data.ownerId}`
    case 'service_purged':
      return `PURGE    ${e.data.type}:${e.data.impl} trashId=${e.data.trashId}`
    case 'service_call':
      // v1.2 audit entry — one line per resolved SERVICE_CALL.
      return `SVCCALL  ${e.data.from} ${e.data.type}:${e.data.impl}#${e.data.method} → ${e.data.outcome} (${e.data.durationMs}ms)`
    case 'llm_stream_chunk':
      // Phase 8 — too noisy to print per chunk, just acknowledge.
      return `STREAM   ${e.data.agentId} task=${e.data.taskId.slice(0, 8)}…`
    case 'task_resumed':
      return `RESUME   task=${e.data.taskId.slice(0, 8)}… by ${e.data.by}`
  }
}

async function main(): Promise<void> {
  const hub = Hub.inMemory()
  await hub.start()
  hub.onEvent((e) => {
    console.log(`  [seq=${String(e.seq).padStart(2, '0')}] ${describe(e)}`)
  })

  // --- Writer: derives "smart" mock text from the prompt ----------------------
  const writerProvider = new MockLlmProvider({
    name: 'mock-writer',
    reply: (req: LlmRequest) => {
      const last = req.messages[req.messages.length - 1]
      // v0.3 made `content` a union of string | content blocks; for this
      // mock writer the input is always plain text (LlmAgent's default
      // buildRequest doesn't emit blocks), so narrow to string and skip
      // the block-array case.
      const prompt =
        typeof last?.content === 'string' ? last.content : ''
      // Extract a topic if the prompt follows the "Please write about: X" pattern
      // that LlmAgent's default buildRequest produces from { topic }.
      const m = /^Please write about: (.+)$/.exec(prompt)
      const subject = m ? m[1] : prompt
      return (
        `[mock-writer] Here is a sentence about ${subject}: ` +
        `${subject} matters because it sits at the join of intent and execution, ` +
        `and getting that join right is what good software is for.`
      )
    },
  })

  // --- Reviewer: canned response ---------------------------------------------
  const reviewerProvider = new MockLlmProvider({
    name: 'mock-reviewer',
    reply:
      '[mock-reviewer] Tighten the second clause; the cause-and-effect could be stated more directly.',
  })

  hub.register(
    new LlmAgent({
      id: 'writer',
      capabilities: ['draft'],
      provider: writerProvider,
      system: 'You are a precise, terse writer. One sentence only.',
    }),
  )
  hub.register(
    new LlmAgent({
      id: 'reviewer',
      capabilities: ['review'],
      provider: reviewerProvider,
      system: 'You are an editor. Return one revision suggestion.',
    }),
  )

  console.log('\n=== AipeHub demo: LlmAgent + mock provider ===\n')

  // Capability dispatch to the writer
  const draft = await hub.dispatch({
    from: 'system',
    strategy: { kind: 'capability', capabilities: ['draft'] },
    payload: { topic: 'why TypeScript' },
    title: 'write a draft',
  })
  if (draft.kind !== 'ok') throw new Error(`draft failed: ${JSON.stringify(draft)}`)
  const draftOut = draft.output as { text: string; by: string; usage?: { inputTokens: number; outputTokens: number } }
  console.log(`\n  ✏️  draft (by=${draftOut.by}, tokens=${draftOut.usage?.outputTokens ?? '?'}):`)
  console.log(`     ${draftOut.text}\n`)

  // Capability dispatch to the reviewer, passing the draft as the prompt
  const review = await hub.dispatch({
    from: 'system',
    strategy: { kind: 'capability', capabilities: ['review'] },
    payload: { prompt: `Review this draft and give one suggestion:\n\n${draftOut.text}` },
    title: 'review the draft',
  })
  if (review.kind !== 'ok') throw new Error(`review failed: ${JSON.stringify(review)}`)
  const reviewOut = review.output as { text: string; by: string }
  console.log(`  📝 review (by=${reviewOut.by}):`)
  console.log(`     ${reviewOut.text}\n`)

  console.log(`  transcript: ${hub.transcript.size()} entries`)

  await hub.stop()
  process.exit(0)
}

main().catch((err) => {
  console.error('[llm-mock] fatal:', err)
  process.exit(1)
})
