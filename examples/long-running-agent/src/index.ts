/**
 * Phase 11 M5 — long-running agent example.
 *
 * Demonstrates the suspend/resume path end-to-end without spinning
 * up SQLite or the host binary: a custom `BatchAgent` processes a
 * list of items, gets parked partway through via `SuspendTaskError`,
 * and is then woken up by a tiny in-process resume sweep — which
 * calls `Hub.resumeTask(agentId, task, state)` with the persisted
 * working memory. The agent reads `state.processed` and continues
 * from the next index.
 *
 * Real deployments use the host's identity-SQLite persistence
 * (Phase 11 M2 + M3); here a `Map` stands in so the demo is one
 * file and runs in ~2 seconds. Conceptually it's the same data
 * flow:
 *
 *   handleTask
 *     │
 *     ├─ process items 0..midpoint
 *     ├─ throw SuspendTaskError({ resumeAt, state })
 *     │     │
 *     │     ▼  notifier captures (taskId, state, resumeAt)
 *     │      (host wires this to identity.persistSuspendedTask)
 *     ▼
 *   transcript: task_result kind='suspended'
 *
 *  (...time passes — resumeAt arrives...)
 *
 *   resume sweep tick
 *     │
 *     ├─ finds due row
 *     ├─ hub.resumeTask(agentId, task, state)
 *     │     │
 *     │     ▼  routes through participant.onResume
 *     │      handleResume(task, state) reads state.processed
 *     │      continues at next index
 *     ▼
 *   transcript: task_resumed → task_result kind='ok'
 *
 * Run:  pnpm demo:long-running-agent
 */

import {
  AgentParticipant,
  Hub,
  SuspendTaskError,
  type ParticipantId,
  type Task,
  type TaskResult,
  type TranscriptEntry,
} from '@gotong/core'

// --- In-memory suspended-task store ----------------------------------------

/**
 * Stands in for `IdentityStore.suspended_tasks` in this demo. Real
 * deployments use the SQLite-backed table (Phase 11 M2); the shape
 * is the same.
 */
interface ParkedRow {
  taskId: string
  agentId: string
  resumeAt: number
  state: unknown
  task: Task
}
const parked = new Map<string, ParkedRow>()

// --- The agent — processes a list of items, suspends midway -----------------

interface BatchState {
  /** Item indexes that have already been processed in a prior run. */
  processed: number[]
}

class BatchAgent extends AgentParticipant {
  constructor(
    id: string,
    private readonly items: readonly string[],
    /** How many items to process before suspending the first time. */
    private readonly midpoint: number,
    /** Milliseconds to park before resume. Short for demo purposes. */
    private readonly napMs: number,
  ) {
    super({ id, capabilities: ['batch'] })
  }

  protected override async handleTask(task: Task): Promise<unknown> {
    return this.processFrom(task, [])
  }

  /**
   * Phase 11 M4 — override `handleResume` to splice persisted state
   * back into the running computation. The framework wraps any
   * value in `SuspendTaskError.state` and hands it back here.
   */
  protected override async handleResume(task: Task, state: unknown): Promise<unknown> {
    const restored = (state as BatchState | undefined)?.processed ?? []
    console.log(
      `  [agent] resumed — already processed ${restored.length} of ${this.items.length} items`,
    )
    return this.processFrom(task, restored)
  }

  /** Shared work body — runs from index `processed.length` to end. */
  private processFrom(task: Task, processed: number[]): unknown {
    const start = processed.length
    for (let i = start; i < this.items.length; i++) {
      // Mid-run suspend: only on the FIRST visit (start === 0). On
      // resume `start > 0`, we just run to completion. A real agent
      // might suspend on every quota refresh boundary.
      if (i >= this.midpoint && start === 0) {
        const resumeAt = Date.now() + this.napMs
        console.log(
          `  [agent] reached midpoint after ${i} items — suspending until ${new Date(resumeAt).toISOString()}`,
        )
        throw new SuspendTaskError({
          resumeAt,
          state: { processed } satisfies BatchState,
        })
      }
      const item = this.items[i]!
      console.log(`  [agent] processing "${item}" (#${i + 1})`)
      processed.push(i)
    }
    return { processedCount: processed.length, items: processed.map((i) => this.items[i]) }
  }
}

// --- Transcript pretty-print -----------------------------------------------

function describe(e: TranscriptEntry): string {
  switch (e.kind) {
    case 'participant_joined':
      return `JOIN     ${e.data.id} caps=[${e.data.capabilities.join(',')}]`
    case 'task':
      return `TASK     ${e.data.from} "${e.data.title ?? '(untitled)'}" via ${e.data.strategy.kind}`
    case 'task_result':
      if (e.data.kind === 'ok') {
        const out = e.data.output as { processedCount?: number } | undefined
        return `RESULT   ok by ${e.data.by}${out?.processedCount !== undefined ? ` (${out.processedCount} processed)` : ''}`
      }
      if (e.data.kind === 'failed') return `RESULT   failed by ${e.data.by}: ${e.data.error}`
      if (e.data.kind === 'cancelled') return `RESULT   cancelled: ${e.data.reason}`
      if (e.data.kind === 'suspended')
        return `RESULT   suspended by ${e.data.by} until ${new Date(e.data.resumeAt).toISOString()}`
      return `RESULT   no_participant: ${e.data.reason}`
    case 'task_resumed':
      return `RESUME   task=${e.data.taskId.slice(0, 8)}… by ${e.data.by}`
    default:
      return e.kind
  }
}

// --- The resume sweep — same shape as host/src/main.ts ---------------------

async function runSweep(hub: Hub): Promise<number> {
  const now = Date.now()
  const due: ParkedRow[] = []
  for (const row of parked.values()) {
    if (row.resumeAt <= now) due.push(row)
  }
  due.sort((a, b) => a.resumeAt - b.resumeAt)
  let resumed = 0
  for (const row of due) {
    const result = await hub.resumeTask(
      row.agentId as ParticipantId,
      row.task,
      row.state,
    )
    if (result.kind !== 'suspended') {
      parked.delete(row.taskId)
      resumed++
    }
  }
  return resumed
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n=== Gotong demo: long-running-agent (Phase 11) ===\n')

  const hub = Hub.inMemory({
    // Phase 11 M2 — when the agent throws SuspendTaskError the
    // scheduler routes here; in a real host this would persist to
    // SQLite (identity.persistSuspendedTask).
    suspendNotifier: (task, by, suspend) => {
      parked.set(task.id, {
        taskId: task.id,
        agentId: by,
        resumeAt: suspend.resumeAt,
        state: suspend.state,
        // Cloning the task here is what the host's `task_json`
        // round-trip would do — kept structurally identical.
        task: JSON.parse(JSON.stringify(task)) as Task,
      })
    },
  })
  await hub.start()
  hub.onEvent((e) => {
    console.log(`  [seq=${String(e.seq).padStart(2, '0')}] ${describe(e)}`)
  })

  const items = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
  hub.register(new BatchAgent('batch-agent', items, /* midpoint */ 2, /* napMs */ 800))

  // Round 1 — initial dispatch. The agent will suspend at midpoint.
  const r1 = await hub.dispatch({
    from: 'system',
    strategy: { kind: 'capability', capabilities: ['batch'] },
    payload: null,
    title: 'process 5 items',
  })
  console.log(`\n  [system] round 1 → ${r1.kind}`)
  if (r1.kind !== 'suspended') {
    throw new Error(`expected suspended on round 1, got ${r1.kind}`)
  }
  console.log(`  [system] parked ${parked.size} task(s); waiting for sweep…\n`)

  // Pretend the host's sweep loop runs every 200 ms. In a real host
  // this is the GOTONG_RESUME_SWEEP_MS setInterval (default 30 s).
  let resumed = 0
  for (let tick = 0; tick < 20 && resumed === 0; tick++) {
    await new Promise((r) => setTimeout(r, 200))
    resumed = await runSweep(hub)
  }
  if (resumed === 0) {
    throw new Error('sweep never resumed the parked task within 4 s')
  }
  console.log(`\n  [system] sweep resumed ${resumed} task(s); done.\n`)
  console.log(`  transcript: ${hub.transcript.size()} entries\n`)

  await hub.stop()
  process.exit(0)
}

main().catch((err) => {
  console.error('[long-running-agent] fatal:', err)
  process.exit(1)
})
