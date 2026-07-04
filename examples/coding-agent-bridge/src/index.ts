/**
 * Stream E E2-M3 — coding-agent CLI bridge demo.
 *
 * The §7 P0 deliverable of AGENT-ADAPTER-CONTRACT: a parameterised shell-out that
 * lets the hub DRIVE a self-hosted coding-agent CLI (Claude Code / Codex / OpenCode
 * / Aider / Goose), with all five control seams. This walks the §5 user story
 * against a deterministic mock CLI (no API key):
 *
 *   [1] OBSERVE     — stream the CLI's output live as it runs
 *   [2] INTERCEPT   — a human "takes over" mid-task → it parks at the next turn
 *   [3] HANDOFF     — the parked task carries full context to a reviewer
 *   [4] RESUME      — the reviewer edits the instruction + approves → it continues
 *   [5] ACTION GATE — a destructive prompt parks BEFORE running; deny → fails closed
 *   [6] TERMINATE   — a wedged task is cancelled → the child process is killed
 *
 * To drive a REAL CLI, swap `command`/`args` for a `CLI_PRESETS` entry (see
 * presets.ts) and drop the mock. The control plane is identical.
 *
 * Run:  pnpm demo:coding-agent-bridge
 */

import { fileURLToPath } from 'node:url'

import { Hub, InMemoryStorage, type Task, type TaskId } from '@gotong/core'
import { CliParticipant, TakeoverController, dangerousCommandGate } from '@gotong/cli-agent'

import { CLI_PRESETS } from './presets.js'

const MOCK_CLI = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url))

/** Parked tasks captured from the hub's suspend notifier (id → task + state). */
const parked = new Map<TaskId, { task: Task; state: unknown }>()

async function main(): Promise<void> {
  printPresets()

  const takeover = new TakeoverController()
  const hub = new Hub({
    storage: new InMemoryStorage(),
    suspendNotifier: (task, _by, s) => {
      parked.set(task.id, { task, state: s.state })
    },
  })
  await hub.start()

  const coder = new CliParticipant({
    id: 'codex',
    capabilities: ['code'],
    command: process.execPath,
    args: [MOCK_CLI, '--prompt', '{prompt}'],
    promptVia: 'arg',
    takeover,
    gate: dangerousCommandGate(),
    maxTurns: 3,
    onChunk: (_taskId, chunk) => process.stdout.write(`      │ ${chunk.text.trimEnd()}\n`),
    next: (_result, ctx) => {
      // A human watching the stream clicks "take over" after the first turn.
      if (ctx.turn === 0) {
        takeover.requestTakeover(ctx.taskId)
        return 'apply the change'
      }
      return null
    },
  })
  hub.register(coder)

  // [1]+[2] OBSERVE + INTERCEPT — a benign refactor; the human takes over after
  // turn 0 streams; the task parks at turn 1.
  section('[1+2] OBSERVE + INTERCEPT (on-demand takeover)')
  const fired = await hub.dispatch({
    from: 'human',
    strategy: { kind: 'capability', capabilities: ['code'] },
    payload: { prompt: 'refactor the auth module' },
  })
  console.log(`  → dispatch result: ${fired.kind}`)
  if (fired.kind !== 'suspended') throw new Error('expected the takeover to park the task')
  const handle = parked.get(fired.taskId)!
  const parkState = handle.state as { kind: string; reason: string; turn: number }
  console.log(`  → parked: kind=${parkState.kind}, at turn ${parkState.turn} ("${parkState.reason}")`)

  // [3]+[4] HANDOFF + RESUME — the reviewer edits the instruction and approves;
  // the task continues from where it parked (turn 0's work is preserved).
  section('[3+4] HANDOFF + RESUME (reviewer edits the instruction)')
  const resumed = await hub.resumeTask('codex', handle.task, {
    ...(handle.state as object),
    decision: { approved: true, prompt: 'apply only the safe edits' },
  })
  console.log(`  → resume result: ${resumed.kind}`)
  if (resumed.kind === 'ok') {
    const out = resumed.output as { text: string; turns: number }
    console.log(`  → final output (turns=${out.turns}): ${JSON.stringify(out.text)}`)
  }

  // [5] ACTION GATE — a destructive prompt parks BEFORE the CLI runs; the reviewer
  // denies it; the task fails closed and the CLI never ran.
  section('[5] ACTION GATE (T2) — destructive prompt, fail-closed')
  parked.clear()
  const gated = await hub.dispatch({
    from: 'human',
    strategy: { kind: 'capability', capabilities: ['code'] },
    payload: { prompt: 'rm -rf build/ and git push --force' },
  })
  console.log(`  → dispatch result: ${gated.kind} (parked before any spawn — no output above)`)
  if (gated.kind === 'suspended') {
    const g = parked.get(gated.taskId)!
    const denied = await hub.resumeTask('codex', g.task, {
      ...(g.state as object),
      decision: { approved: false, note: 'too destructive' },
    })
    console.log(`  → reviewer denies → ${denied.kind}: ${denied.kind === 'failed' ? denied.error : ''}`)
  }

  // [6] TERMINATE — a wedged CLI is cancelled; the child process is killed. The
  // hub routes a task cancel to `onTaskCancelled` (hub.ts) — the same seam.
  section('[6] TERMINATE — cancel kills the child')
  const slow = new CliParticipant({
    id: 'slow-coder',
    capabilities: ['slow'],
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 10000)'],
  })
  const slowTask: Task = {
    id: 'terminate-me',
    from: 'human',
    strategy: { kind: 'capability', capabilities: ['slow'] },
    payload: { prompt: 'a task that wedges' },
    createdAt: Date.now(),
  }
  const slowRun = slow.onTask(slowTask)
  setTimeout(() => slow.onTaskCancelled('terminate-me', 'operator cancel'), 100)
  const killed = await slowRun
  console.log(`  → cancelled task result: ${killed.kind}: ${killed.kind === 'failed' ? killed.error : ''}`)

  await hub.stop()
  section('done')
  console.log('  All five control seams demonstrated against a mock CLI.')
}

function printPresets(): void {
  section('CLI presets (point the adapter at a real coding agent)')
  for (const [key, p] of Object.entries(CLI_PRESETS)) {
    console.log(`  ${key.padEnd(12)} ${p.note}`)
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
