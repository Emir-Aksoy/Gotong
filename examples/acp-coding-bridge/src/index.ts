/**
 * `@gotong/acp-agent` demo — the OpenClaw-style ACP coding-agent bridge.
 *
 * The hub MANAGES a coding agent from startup, HOLDS one ACP session, and
 * dispatches many tasks to it — the lifecycle ownership the one-shot cli-agent
 * bridge can't give (it spawns a fresh process per task). This walks the five
 * AGENT-ADAPTER-CONTRACT seams against a deterministic mock ACP server (no API
 * key, no network, no real CLI):
 *
 *   [1] OBSERVE + HOLD — stream output live AND prove a second task hit the SAME
 *                        held session (the turn counter only advances because the
 *                        subprocess + ACP session stayed alive)
 *   [2] INTERCEPT      — a destructive `session/request_permission` escalates → the
 *                        task parks while the subprocess stays BLOCKED on the request
 *   [3] HANDOFF        — the park carries the tool context (the host maps it to an
 *                        inbox item; this demo has zero inbox dep, just shows it)
 *   [4] RESUME         — approve → the held permission is answered, the SAME turn
 *                        finishes, and the pre-permission stream is preserved (no drift)
 *   [5] FAIL-CLOSED    — reject → the destructive tool never runs (refusal)
 *   [6] TERMINATE      — cancel a wedged turn → ACP cancel + abort ends it
 *
 * To drive a REAL agent, swap command/args for an `ACP_PRESETS` entry (see
 * presets.ts) and drop the mock — the control plane is identical. The live path
 * is non-hermetic (needs the agent installed + logged in); see start:live.
 *
 * Run:  pnpm demo:acp-coding-bridge
 */

import { fileURLToPath } from 'node:url'

import { Hub, InMemoryStorage, type Task, type TaskId } from '@gotong/core'
import { AcpParticipant, ACP_NEVER_RESUME_AT } from '@gotong/acp-agent'

import { ACP_PRESETS } from './presets.js'

const MOCK_ACP = fileURLToPath(new URL('./mock-acp-server.mjs', import.meta.url))

interface AcpOutput {
  text: string
  stopReason: string
  sessionId?: string
  permissionApproved?: boolean
}

/** Parked tasks captured from the hub's suspend notifier (id → task + state). */
const parked = new Map<TaskId, { task: Task; state: unknown }>()

async function main(): Promise<void> {
  printPresets()

  const hub = new Hub({
    storage: new InMemoryStorage(),
    suspendNotifier: (task, _by, s) => {
      parked.set(task.id, { task, state: s.state })
    },
  })
  await hub.start()

  const coder = new AcpParticipant({
    id: 'acp-coder',
    capabilities: ['code'],
    command: process.execPath,
    args: [MOCK_ACP],
    // OBSERVE seam: stream every chunk out.
    onChunk: (_taskId, chunk) => {
      if (chunk.text) process.stdout.write(`      │ ${chunk.text}\n`)
    },
    // Default gate (dangerousToolGate) escalates a destructive tool → Tier 2.
  })
  hub.register(coder)

  // [1] OBSERVE + HOLD ─────────────────────────────────────────────────────
  section('[1] OBSERVE + HOLD ONE SESSION (dispatch twice)')
  const r1 = await dispatch(hub, 'summarize the repo')
  if (r1.kind !== 'ok') throw new Error(`expected ok, got ${r1.kind}`)
  const r2 = await dispatch(hub, 'now skim the tests')
  if (r2.kind !== 'ok') throw new Error(`expected ok, got ${r2.kind}`)
  if (!outputOf(r2).text.includes('turn=2')) {
    throw new Error('expected the SECOND task to reuse the held session (turn=2)')
  }
  console.log(`  → both tasks ran on session "${coder.sessionId}" — turn counter advanced ⇒ context held`)

  // [2] INTERCEPT ───────────────────────────────────────────────────────────
  section('[2] INTERCEPT — a destructive tool escalates → parks')
  const fired = await dispatch(hub, 'tidy up — NEED_PERM remove the stale build dir')
  if (fired.kind !== 'suspended') throw new Error('expected the destructive permission to park the task')
  const handle = parked.get(fired.taskId)!
  const park = handle.state as { kind: string; permissionToken: string; tool: { title?: string } }
  if (park.kind !== 'permission') throw new Error('expected a permission park')
  console.log(`  → parked: tool="${park.tool.title}", token=${park.permissionToken}`)
  console.log(`  → subprocess stays BLOCKED on the open request; resumeAt=${ACP_NEVER_RESUME_AT} ⇒ the sweep can't wake it`)

  // [3]+[4] HANDOFF + RESUME (approve, no drift) ────────────────────────────
  section('[3+4] HANDOFF + RESUME (approve) — same turn finishes, no drift')
  const approved = await hub.resumeTask('acp-coder', handle.task, {
    ...(handle.state as object),
    decision: { approved: true },
  })
  if (approved.kind !== 'ok') throw new Error(`expected ok on approve, got ${approved.kind}`)
  const outA = outputOf(approved)
  if (outA.stopReason !== 'end_turn' || !outA.text.includes('perm:allowed')) {
    throw new Error('expected the approved turn to finish with the tool run (perm:allowed)')
  }
  console.log(`  → approved ⇒ stopReason=${outA.stopReason}, output=${JSON.stringify(outA.text)}`)

  // [5] FAIL-CLOSED ─────────────────────────────────────────────────────────
  section('[5] FAIL-CLOSED — reject a destructive tool')
  parked.clear()
  const fired2 = await dispatch(hub, 'wipe everything — NEED_PERM')
  if (fired2.kind !== 'suspended') throw new Error('expected the second destructive permission to park')
  const handle2 = parked.get(fired2.taskId)!
  const denied = await hub.resumeTask('acp-coder', handle2.task, {
    ...(handle2.state as object),
    decision: { approved: false },
  })
  if (denied.kind !== 'ok') throw new Error(`expected ok on reject (agent refuses), got ${denied.kind}`)
  const outD = outputOf(denied)
  if (outD.stopReason !== 'refusal' || outD.text.includes('perm:allowed')) {
    throw new Error('expected the rejected tool to NOT run')
  }
  console.log(`  → rejected ⇒ stopReason=${outD.stopReason}; the destructive work never ran (fail-closed)`)

  // [6] TERMINATE ───────────────────────────────────────────────────────────
  section('[6] TERMINATE — cancel a wedged turn')
  let started = false
  const term = new AcpParticipant({
    id: 'acp-term',
    capabilities: ['slow'],
    command: process.execPath,
    args: [MOCK_ACP],
    onChunk: () => {
      started = true
    },
  })
  const wedge: Task = {
    id: 'terminate-me' as TaskId,
    from: 'human',
    strategy: { kind: 'capability', capabilities: ['slow'] },
    payload: { prompt: 'a turn that wedges — HANG' },
    createdAt: Date.now(),
  }
  const run = term.onTask(wedge)
  await waitFor(() => started) // cancel only once the prompt is genuinely in-flight
  term.onTaskCancelled('terminate-me' as TaskId, 'operator cancel')
  const killed = await run
  if (killed.kind !== 'ok' || outputOf(killed).stopReason !== 'cancelled') {
    throw new Error('expected cancel to end the wedged turn as cancelled')
  }
  console.log(`  → cancelled ⇒ stopReason=${outputOf(killed).stopReason}`)
  await term.onShutdown()

  await coder.onShutdown()
  await hub.stop()

  section('done')
  console.log('  All five seams demonstrated over a real ACP session (mock agent).')
  console.log('  Swap command/args for an ACP_PRESETS entry to drive a real Claude Code / Codex (see README + start:live).')
}

async function dispatch(hub: Hub, prompt: string) {
  return hub.dispatch({
    from: 'human',
    strategy: { kind: 'capability', capabilities: ['code'] },
    payload: { prompt },
  })
}

function outputOf(r: { output: unknown }): AcpOutput {
  return r.output as AcpOutput
}

/** Poll until a condition holds — deterministic readiness, no fixed sleeps. */
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function printPresets(): void {
  section('ACP presets (point the adapter at a real coding agent)')
  for (const [key, p] of Object.entries(ACP_PRESETS)) {
    console.log(`  ${key.padEnd(16)} ${p.note}`)
    console.log(`  ${' '.repeat(16)} auth: ${p.auth}`)
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
