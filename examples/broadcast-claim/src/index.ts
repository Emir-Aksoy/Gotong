/**
 * broadcast-claim — proves the `broadcast` dispatch strategy.
 *
 * Three reviewers all match capability 'review' but respond at different
 * speeds. The scheduler races them: the first `ok` wins and the rest are
 * notified via onTaskCancelled.
 */

import {
  AgentParticipant,
  Hub,
  type Task,
  type TaskId,
  type TranscriptEntry,
} from '@aipehub/core'

type ReviewPayload = { draft: string }
type ReviewOutput = { note: string; respondedInMs: number }

class ReviewerAgent extends AgentParticipant {
  // Each reviewer sleeps `delayMs` before responding, so we can predict who wins.
  constructor(
    id: string,
    private readonly delayMs: number,
  ) {
    super({ id, capabilities: ['review'] })
  }

  protected async handleTask(_task: Task): Promise<ReviewOutput> {
    await sleep(this.delayMs)
    return {
      note: `[${this.id}] suggests: tighten the opening sentence.`,
      respondedInMs: this.delayMs,
    }
  }

  override onTaskCancelled(_taskId: TaskId, reason: string): void {
    console.log(`  [${this.id}] cancelled: ${reason}`)
  }
}

async function main(): Promise<void> {
  const hub = new Hub()
  await hub.start()

  hub.onEvent((e) => {
    console.log(`  [seq=${String(e.seq).padStart(2, '0')}] ${describe(e)}`)
  })

  // Fast wins, medium and slow should both get cancelled.
  hub.register(new ReviewerAgent('reviewer-fast', 100))
  hub.register(new ReviewerAgent('reviewer-medium', 300))
  hub.register(new ReviewerAgent('reviewer-slow', 500))

  console.log('\n=== AipeHub demo: broadcast claim ===\n')

  // `from: 'system'` is fine — `from` is a free-form string, not a participant lookup.
  const result = await hub.dispatch({
    from: 'system',
    strategy: { kind: 'broadcast', capabilities: ['review'] },
    payload: { draft: 'TypeScript helps large teams move faster.' } satisfies ReviewPayload,
    title: 'race the reviewers',
  })

  // Give the cancel notifications a tick to print before we shut down.
  await sleep(50)

  console.log('\n=== winning result ===')
  console.log(result)

  console.log(`\ntranscript length: ${hub.transcript.size()} entries`)

  await hub.stop()
  process.exit(0)
}

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
        s.kind === 'explicit'
          ? `to=${s.to}`
          : s.kind === 'capability'
            ? `caps=[${s.capabilities.join(',')}]`
            : `broadcast caps=[${(s.capabilities ?? []).join(',')}]`
      return `TASK     ${e.data.from} "${e.data.title ?? '(untitled)'}" via ${s.kind} ${target}`
    }
    case 'task_result': {
      const r = e.data
      if (r.kind === 'ok') return `RESULT   ok by ${r.by}`
      if (r.kind === 'failed') return `RESULT   failed by ${r.by}: ${r.error}`
      if (r.kind === 'cancelled') return `RESULT   cancelled: ${r.reason}`
      return `RESULT   no_participant: ${r.reason}`
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
