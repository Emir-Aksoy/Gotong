/**
 * cli-human — the terminal as a HumanParticipant adapter.
 *
 * What you get:
 *   1. An LlmAgent (mock provider) writes three short drafts in a loop.
 *   2. Each draft is dispatched to `you` — a HumanParticipant — for approval.
 *   3. You see the task in the terminal; type the response (Enter alone
 *      accepts with "ok"; `r <reason>` rejects).
 *   4. The Hub records each result in the transcript.
 *
 * This is a tiny reference for building your own CLI / chat / IM adapter
 * on top of `HumanParticipant`. The pattern is:
 *   - Spawn a loop calling `human.next()` to pull pending tasks FIFO.
 *   - Render the task in your medium (here: stdout).
 *   - Capture the response (here: stdin via readline).
 *   - Call `human.complete()` / `human.reject()`.
 *
 * Auto-mode (for CI / non-TTY shells): set `AIPE_AUTO=1` to skip the prompt
 * and auto-approve each draft with "ok".
 */

import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import {
  Hub,
  HumanParticipant,
  type Task,
  type TranscriptEntry,
} from '@aipehub/core'
import { LlmAgent, MockLlmProvider } from '@aipehub/llm'

const AUTO = process.env.AIPE_AUTO === '1' || !input.isTTY

interface ApprovalPayload {
  draft: string
}

class WriterAgent extends LlmAgent {
  // No customisation needed beyond what LlmAgent already does — included
  // here as a subclass so the agent name shows up clearly in the transcript.
  constructor(provider: MockLlmProvider) {
    super({
      id: 'writer',
      capabilities: ['draft'],
      provider,
      system: 'You write one short sentence and stop.',
    })
  }
}

function describe(e: TranscriptEntry): string {
  switch (e.kind) {
    case 'participant_joined':
      return `JOIN     ${e.data.id} (${e.data.participantKind})`
    case 'participant_left':
      return `LEAVE    ${e.data.id}`
    case 'task':
      return `TASK     "${e.data.title ?? '(untitled)'}" via ${e.data.strategy.kind}`
    case 'task_result':
      if (e.data.kind === 'ok') return `RESULT   ok by ${e.data.by}`
      if (e.data.kind === 'failed') return `RESULT   failed by ${e.data.by}: ${e.data.error}`
      if (e.data.kind === 'cancelled') return `RESULT   cancelled: ${e.data.reason}`
      return `RESULT   no_participant: ${e.data.reason}`
    case 'message':
      return `MSG      ${e.data.from} -> #${e.data.channel}`
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
  }
}

async function runCliLoop(you: HumanParticipant, signal: AbortSignal): Promise<void> {
  const rl = AUTO ? null : createInterface({ input, output })
  try {
    while (!signal.aborted) {
      const task = await Promise.race([
        you.next(),
        new Promise<Task | null>((resolve) => {
          signal.addEventListener('abort', () => resolve(null), { once: true })
        }),
      ])
      if (!task) return

      const payload = task.payload as ApprovalPayload
      console.log('\n┌────────────────────────────────────────────────────────────')
      console.log(`│ TASK for you: "${task.title ?? task.id}"`)
      console.log(`│ Draft:`)
      console.log(`│   ${payload.draft}`)
      console.log('└────────────────────────────────────────────────────────────')

      if (AUTO) {
        console.log('  (AIPE_AUTO=1) auto-approving with "ok"')
        you.complete(task.id, { approved: true, comment: 'ok' })
        continue
      }

      const answer = (
        await rl!.question(
          '  Response — Enter to approve, "r <reason>" to reject: ',
        )
      ).trim()

      if (answer.toLowerCase().startsWith('r')) {
        const reason = answer.slice(1).trim() || 'no reason given'
        you.reject(task.id, reason)
        console.log(`  → rejected: ${reason}`)
      } else {
        you.complete(task.id, { approved: true, comment: answer || 'ok' })
        console.log(`  → approved${answer ? ` ("${answer}")` : ''}`)
      }
    }
  } finally {
    rl?.close()
  }
}

async function main(): Promise<void> {
  const hub = Hub.inMemory()
  await hub.start()
  hub.onEvent((e) => {
    console.log(`  [seq=${String(e.seq).padStart(2, '0')}] ${describe(e)}`)
  })

  // A mock LLM provider that varies its output per topic so the human sees
  // visibly different drafts. Replace with AnthropicProvider/OpenAIProvider
  // (see examples/llm-real) to drive a real model.
  const provider = new MockLlmProvider({
    name: 'mock-writer',
    reply: (req) => {
      const last = req.messages[req.messages.length - 1]
      const m = /Please write about: (.+)$/.exec(last?.content ?? '')
      const topic = m ? m[1] : 'something'
      return `Draft on ${topic}: it matters because the join of intent and action is where systems live or die.`
    },
  })

  const writer = new WriterAgent(provider)
  const you = new HumanParticipant({ id: 'you', capabilities: ['approve'] })
  hub.register(writer)
  hub.register(you)

  const ac = new AbortController()
  const loop = runCliLoop(you, ac.signal)

  console.log('\n=== AipeHub demo: CLI human-in-the-loop ===')
  console.log(AUTO
    ? '(non-TTY / AIPE_AUTO=1 — drafts will be auto-approved)\n'
    : '(type the response when prompted; Enter to approve, "r <reason>" to reject)\n')

  const topics = ['why TypeScript', 'remote agents', 'humans as participants']
  for (const topic of topics) {
    const draftRes = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: { topic },
      title: `write a draft on '${topic}'`,
    })
    if (draftRes.kind !== 'ok') {
      console.error(`draft failed: ${JSON.stringify(draftRes)}`)
      continue
    }
    const draftText = (draftRes.output as { text: string }).text

    const approveRes = await hub.dispatch({
      from: 'writer',
      strategy: { kind: 'explicit', to: you.id },
      payload: { draft: draftText } satisfies ApprovalPayload,
      title: `approve draft about '${topic}'`,
    })
    if (approveRes.kind === 'ok') {
      console.log(
        `  → final state: approved${(approveRes.output as { comment: string }).comment ? ` ("${(approveRes.output as { comment: string }).comment}")` : ''}`,
      )
    } else if (approveRes.kind === 'failed') {
      console.log(`  → final state: rejected — ${approveRes.error}`)
    }
  }

  console.log('\n=== done ===')
  console.log(`transcript: ${hub.transcript.size()} entries`)
  ac.abort()
  await loop
  await hub.stop()
  process.exit(0)
}

main().catch((err) => {
  console.error('[cli-human] fatal:', err)
  process.exit(1)
})
