/**
 * hello-collab — the minimum demo that proves the AipeHub abstraction holds.
 *
 * Scenario:
 *   1. A WriterAgent drafts a short writeup on a topic.
 *   2. A ReviewerAgent reads the draft and suggests one revision.
 *   3. The WriterAgent revises based on the suggestion.
 *   4. A HumanParticipant (Alice) is asked to approve the final version.
 *
 * Steps 1–3 exercise *capability matching* — the dispatcher does not name
 * the agent, only the required capability.
 * Step 4 exercises *explicit* routing — the dispatcher names Alice.
 *
 * Alice's UI is simulated here as a small loop that auto-approves after
 * a short "thinking" delay. In a real app this loop is what the web UI
 * does for you.
 */

import {
  AgentParticipant,
  Hub,
  HumanParticipant,
  type Task,
  type TranscriptEntry,
} from '@aipehub/core'

// --- payload shapes (just for clarity in this demo) -------------------------

type DraftPayload = { kind: 'draft'; topic: string }
type ReviewPayload = { kind: 'review'; draft: string }
type RevisePayload = { kind: 'revise'; draft: string; reviewNote: string }
type ApprovePayload = { final: string }

type DraftOutput = { text: string }
type ReviewOutput = { note: string }
type ReviseOutput = { text: string }

// --- the two agents ---------------------------------------------------------

class WriterAgent extends AgentParticipant {
  constructor() {
    super({ id: 'writer', capabilities: ['draft', 'revise'] })
  }

  protected async handleTask(task: Task): Promise<DraftOutput | ReviseOutput> {
    const payload = task.payload as DraftPayload | RevisePayload
    await sleep(300)
    if (payload.kind === 'draft') {
      return {
        text:
          `Why TypeScript matters for ${payload.topic}: ` +
          `it catches whole categories of bugs at compile time, ` +
          `keeps refactors honest across module boundaries, ` +
          `and lets editors give meaningful guidance.`,
      }
    }
    return {
      text: `${payload.draft}\n\n— revised note: ${payload.reviewNote}`,
    }
  }
}

class ReviewerAgent extends AgentParticipant {
  constructor() {
    super({ id: 'reviewer', capabilities: ['review'] })
  }

  protected async handleTask(_task: Task): Promise<ReviewOutput> {
    await sleep(300)
    return {
      note: 'Solid, but mention IDE autocompletion as a concrete day-to-day win.',
    }
  }
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  const hub = Hub.inMemory()
  await hub.start()

  hub.onEvent((e) => {
    console.log(`  [seq=${String(e.seq).padStart(2, '0')}] ${describe(e)}`)
  })

  const writer = new WriterAgent()
  const reviewer = new ReviewerAgent()
  const alice = new HumanParticipant({ id: 'alice', capabilities: ['approve'] })

  hub.register(writer)
  hub.register(reviewer)
  hub.register(alice)

  // Simulated UI: Alice's CLI/web loop. In a real app this is replaced
  // by the web UI's task inbox.
  const aliceLoop = (async () => {
    while (true) {
      const task = await alice.next()
      const payload = task.payload as ApprovePayload
      console.log(`\n  👤 alice sees task "${task.title ?? task.id}"`)
      console.log(`     content: ${payload.final.replace(/\n/g, '\n              ')}`)
      console.log(`     ...thinking 500ms, then approving.`)
      await sleep(500)
      alice.complete(task.id, { approved: true, comment: 'LGTM' })
    }
  })()
  // We don't await aliceLoop; it lives until process exit.
  void aliceLoop

  console.log('\n=== AipeHub demo: collaborative writeup ===\n')

  // 1. capability dispatch -> WriterAgent
  const draftRes = await hub.dispatch({
    from: 'system',
    strategy: { kind: 'capability', capabilities: ['draft'] },
    payload: { kind: 'draft', topic: 'large codebases' } satisfies DraftPayload,
    title: 'write draft',
  })
  if (draftRes.kind !== 'ok') throw new Error(`draft failed: ${JSON.stringify(draftRes)}`)
  const draftText = (draftRes.output as DraftOutput).text

  // 2. capability dispatch -> ReviewerAgent
  const reviewRes = await hub.dispatch({
    from: 'system',
    strategy: { kind: 'capability', capabilities: ['review'] },
    payload: { kind: 'review', draft: draftText } satisfies ReviewPayload,
    title: 'review draft',
  })
  if (reviewRes.kind !== 'ok') throw new Error(`review failed: ${JSON.stringify(reviewRes)}`)
  const reviewNote = (reviewRes.output as ReviewOutput).note

  // 3. capability dispatch -> WriterAgent (same agent, different capability tag)
  const reviseRes = await hub.dispatch({
    from: 'system',
    strategy: { kind: 'capability', capabilities: ['revise'] },
    payload: {
      kind: 'revise',
      draft: draftText,
      reviewNote,
    } satisfies RevisePayload,
    title: 'revise draft',
  })
  if (reviseRes.kind !== 'ok') throw new Error(`revise failed: ${JSON.stringify(reviseRes)}`)
  const finalText = (reviseRes.output as ReviseOutput).text

  // 4. explicit dispatch -> Alice
  const approveRes = await hub.dispatch({
    from: 'system',
    strategy: { kind: 'explicit', to: alice.id },
    payload: { final: finalText } satisfies ApprovePayload,
    title: 'final approval',
  })

  console.log('\n=== final ===')
  console.log(finalText)
  console.log('\napproval result:', approveRes)
  console.log(`\ntranscript length: ${hub.transcript.size()} entries`)

  await hub.stop()
  process.exit(0)
}

// --- helpers ----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

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
        s.kind === 'explicit' ? `to=${s.to}` : s.kind === 'capability' ? `caps=[${s.capabilities.join(',')}]` : `broadcast`
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
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
