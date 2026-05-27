/**
 * llm-real — the cross-vendor demo.
 *
 * Hub + two LlmAgents:
 *   - writer:   AnthropicProvider (Claude) — capability "draft"
 *   - reviewer: OpenAIProvider (GPT)       — capability "review"
 *
 * Requires both ANTHROPIC_API_KEY and OPENAI_API_KEY in the environment.
 * Run only the side you have a key for? Set the other key to a fake value;
 * we exit early with a clear message if neither is present.
 *
 * Goal: show that swapping the provider is a one-line change. The agent
 * code is identical to examples/llm-mock — only the provider differs.
 */

import { Hub, type TranscriptEntry } from '@aipehub/core'
import { LlmAgent } from '@aipehub/llm'
import { AnthropicProvider } from '@aipehub/llm-anthropic'
import { OpenAIProvider } from '@aipehub/llm-openai'

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
  }
}

async function main(): Promise<void> {
  const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY)
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY)

  if (!hasClaude && !hasOpenAI) {
    console.error(
      '[llm-real] Neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set in the environment.',
    )
    console.error(
      '            Set at least one and rerun. Set both for the full cross-vendor demo.',
    )
    console.error(
      '            See examples/llm-mock for a no-key demo that exercises the same pipeline.',
    )
    process.exit(2)
  }
  if (!hasClaude) {
    console.warn('[llm-real] ANTHROPIC_API_KEY not set — substituting OpenAI for the writer.')
  }
  if (!hasOpenAI) {
    console.warn('[llm-real] OPENAI_API_KEY not set — substituting Anthropic for the reviewer.')
  }

  const hub = Hub.inMemory()
  await hub.start()
  hub.onEvent((e) => {
    console.log(`  [seq=${String(e.seq).padStart(2, '0')}] ${describe(e)}`)
  })

  // Writer: prefer Claude, fall back to GPT if no Claude key.
  const writerProvider = hasClaude
    ? new AnthropicProvider({ defaultMaxTokens: 256 })
    : new OpenAIProvider({ defaultModel: 'gpt-4o-mini' })

  // Reviewer: prefer GPT, fall back to Claude if no OpenAI key.
  const reviewerProvider = hasOpenAI
    ? new OpenAIProvider({ defaultModel: 'gpt-4o-mini' })
    : new AnthropicProvider({ defaultMaxTokens: 256 })

  hub.register(
    new LlmAgent({
      id: 'writer',
      capabilities: ['draft'],
      provider: writerProvider,
      system:
        'You are a precise, terse writer. Reply with ONE sentence of at most 30 words.',
      maxTokens: 256,
    }),
  )
  hub.register(
    new LlmAgent({
      id: 'reviewer',
      capabilities: ['review'],
      provider: reviewerProvider,
      system:
        'You are a strict copy editor. Read the draft and return ONE concrete revision suggestion (one sentence).',
      maxTokens: 256,
    }),
  )

  console.log('\n=== AipeHub demo: LlmAgent + real providers ===')
  console.log(`  writer  -> ${writerProvider.name}`)
  console.log(`  reviewer-> ${reviewerProvider.name}\n`)

  const draft = await hub.dispatch({
    from: 'system',
    strategy: { kind: 'capability', capabilities: ['draft'] },
    payload: { topic: 'why TypeScript matters for distributed agent systems' },
    title: 'write a draft',
  })
  if (draft.kind !== 'ok') throw new Error(`draft failed: ${JSON.stringify(draft)}`)
  const draftOut = draft.output as {
    text: string
    by: string
    usage?: { inputTokens: number; outputTokens: number }
  }
  console.log(
    `\n  ✏️  draft (by=${draftOut.by}, in=${draftOut.usage?.inputTokens ?? '?'} out=${draftOut.usage?.outputTokens ?? '?'}):`,
  )
  console.log(`     ${draftOut.text.replace(/\n/g, '\n     ')}\n`)

  const review = await hub.dispatch({
    from: 'system',
    strategy: { kind: 'capability', capabilities: ['review'] },
    payload: { prompt: `Review this draft and give one suggestion:\n\n${draftOut.text}` },
    title: 'review the draft',
  })
  if (review.kind !== 'ok') throw new Error(`review failed: ${JSON.stringify(review)}`)
  const reviewOut = review.output as {
    text: string
    by: string
    usage?: { inputTokens: number; outputTokens: number }
  }
  console.log(
    `  📝 review (by=${reviewOut.by}, in=${reviewOut.usage?.inputTokens ?? '?'} out=${reviewOut.usage?.outputTokens ?? '?'}):`,
  )
  console.log(`     ${reviewOut.text.replace(/\n/g, '\n     ')}\n`)

  console.log(`  transcript: ${hub.transcript.size()} entries`)

  await hub.stop()
  process.exit(0)
}

main().catch((err) => {
  console.error('[llm-real] fatal:', err)
  process.exit(1)
})
