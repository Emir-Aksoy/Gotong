/**
 * Stream E E2-M3 — the CLI shell-out adapter acceptance gate (end-to-end).
 *
 * THE test the feature exists to pass (AGENT-ADAPTER-CONTRACT §5): the hub
 * DRIVES an external coding-agent CLI as a `Participant`, and a person can take
 * it over mid-run, hand it to a reviewer, and resume it with an edited
 * instruction — with no drift across the park — and can kill a wedged run. The
 * five control seams in one story:
 *
 *   OBSERVE    — the CLI's stdout streams live to a sink (host → transcript)
 *   INTERCEPT  — a human "takes over" → the task parks at the next turn
 *   HANDOFF    — the parked task becomes an inbox item, delegated to a reviewer
 *   RESUME     — the reviewer edits the prompt + approves → it continues, and
 *                turn 0's work is preserved verbatim (no drift)
 *   TERMINATE  — cancelling a running task kills the child process
 *
 * Everything that can be real is real:
 *   - a real Hub (InMemoryStorage) with a production-shaped suspendNotifier
 *     persisting parked tasks to a real IdentityStore (tmp sqlite),
 *   - the real `CliParticipant` driving a deterministic mock CLI (node `-e`,
 *     no API key, no network),
 *   - the real `FileInboxStore` carrying the handoff between the operator and
 *     the reviewer.
 *
 * The mock CLI stands in for Claude Code / Codex / Aider; the control plane the
 * test exercises is byte-for-byte the one a real CLI runs under (swap
 * `command`/`args` for a `CLI_PRESETS` entry — see examples/coding-agent-bridge).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, InMemoryStorage, type Task } from '@aipehub/core'
import {
  CliParticipant,
  TakeoverController,
  dangerousCommandGate,
  CLI_NEVER_RESUME_AT,
} from '@aipehub/cli-agent'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'
import { FileInboxStore } from '@aipehub/inbox'

// A deterministic mock CLI: read the prompt from stdin, stream a planning line,
// then echo the prompt back as the "result". `process.execPath -e <this>` is a
// hermetic stand-in for a real coding agent — same stdin/stdout/exit contract.
const MOCK_CLI = [
  "let d='';",
  "process.stdin.setEncoding('utf8');",
  'process.stdin.on("data",c=>d+=c);',
  'process.stdin.on("end",()=>{',
  '  process.stdout.write("step: planning\\n");',
  '  process.stdout.write("result: "+d.trim());',
  '});',
].join('')

/** A chunk captured from the OBSERVE sink. */
interface Seen {
  taskId: string
  text: string
}

/** Shape of the CliParticipant's ok output (it's `unknown` at the seam). */
interface CliOutput {
  text: string
  turns: number
  transcript: Array<{ turn: number; output: string }>
}

describe('Stream E E2-M3 — CLI adapter acceptance gate', () => {
  let tmp: string
  let identity: IdentityStore
  let hub: Hub
  let inboxStore: FileInboxStore
  let takeover: TakeoverController
  let seen: Seen[]

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-cli-e2e-'))
    identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
    hub = new Hub({
      storage: new InMemoryStorage(),
      // Production-shaped: any participant that throws SuspendTaskError gets
      // persisted here, exactly as host/main.ts wires it.
      suspendNotifier: (task, by, s) => {
        identity.persistSuspendedTask({
          taskId: task.id,
          agentId: by,
          hubId: 'local',
          originUserId: task.origin?.userId ?? null,
          resumeAt: s.resumeAt,
          state: s.state,
          taskJson: JSON.stringify(task),
        })
      },
    })
    await hub.start()

    inboxStore = new FileInboxStore(tmp)
    inboxStore.ensureDirs()

    takeover = new TakeoverController()
    seen = []

    const coder = new CliParticipant({
      id: 'codex',
      capabilities: ['code'],
      command: process.execPath,
      args: ['-e', MOCK_CLI],
      promptVia: 'stdin',
      // OBSERVE seam: stream every chunk out, attributed to the task.
      onChunk: (taskId, chunk) => seen.push({ taskId, text: chunk.text }),
      // T2 action gate — destructive prompts park before the CLI runs.
      gate: dangerousCommandGate(),
      maxTurns: 3,
      takeover,
      // A human watching the stream clicks "take over" after the first turn.
      next: (_result, ctx) => {
        if (ctx.turn === 0) {
          takeover.requestTakeover(ctx.taskId)
          return 'apply the change'
        }
        return null
      },
    })
    hub.register(coder)
  })

  afterEach(async () => {
    await hub.stop()
    identity.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('observe → on-demand takeover → inbox handoff → resume edited, no drift', async () => {
    // ── OBSERVE + INTERCEPT ──────────────────────────────────────────────
    // Dispatch a benign refactor. Turn 0 runs and streams; the human takes
    // over; the task parks at turn 1 (before the next CLI invocation).
    const fired = await hub.dispatch({
      from: 'human',
      strategy: { kind: 'capability', capabilities: ['code'] },
      payload: { prompt: 'refactor the auth module' },
    })
    expect(fired.kind).toBe('suspended')
    if (fired.kind !== 'suspended') return
    const taskId = fired.taskId

    // OBSERVE: turn 0's output streamed live (not a single blob at the end).
    expect(seen.some((c) => c.taskId === taskId && c.text.includes('step: planning'))).toBe(true)
    expect(seen.some((c) => c.text.includes('result: refactor the auth module'))).toBe(true)

    // The park is persisted at the never-resume sentinel → the resume sweep
    // can NEVER auto-wake it. Only a human-driven resume continues it.
    const row = identity.getSuspendedTask(taskId)
    expect(row).not.toBeNull()
    expect(row!.resumeAt).toBe(CLI_NEVER_RESUME_AT)
    const parkState = row!.state as {
      kind: string
      turn: number
      transcript: Array<{ output: string }>
    }
    expect(parkState.kind).toBe('takeover')
    expect(parkState.turn).toBe(1)
    // The parked state carries turn 0's work — resume won't re-run it.
    expect(parkState.transcript[0]!.output).toContain('refactor the auth module')
    const due = identity.listDueSuspendedTasks({ now: Date.now() })
    expect(due.some((d) => d.taskId === taskId)).toBe(false)

    // ── HANDOFF ──────────────────────────────────────────────────────────
    // A host maps the park to an inbox approval item and delegates it to a
    // steadier reviewer, who gets the full context.
    await inboxStore.write({
      itemId: taskId,
      userId: 'alice',
      kind: 'approval',
      prompt: `CLI takeover at turn ${parkState.turn}: review before continuing`,
      parentKind: 'agent',
      status: 'pending',
      createdAt: 1,
    })
    expect(await inboxStore.listPending('alice')).toHaveLength(1)
    await inboxStore.delegate(taskId, 'bob', { actor: 'alice', note: 'you take this one' })
    const bobItems = await inboxStore.listPending('bob')
    expect(bobItems).toHaveLength(1)
    expect(bobItems[0]!.prompt).toContain('CLI takeover')
    expect(await inboxStore.listPending('alice')).toHaveLength(0)

    // ── RESUME (edited, no drift) ────────────────────────────────────────
    // Bob approves with an edited instruction. The race-guarded resolve runs
    // BEFORE resume; then the host resumes the parked task with the carried
    // state verbatim plus the decision.
    await inboxStore.markResolved(taskId, { kind: 'approval', approved: true })
    const task = JSON.parse(row!.taskJson) as Task
    const resumed = await hub.resumeTask('codex', task, {
      ...(row!.state as object),
      decision: { approved: true, prompt: 'apply only the safe edits' },
    })
    identity.removeSuspendedTask(taskId)

    expect(resumed.kind).toBe('ok')
    if (resumed.kind !== 'ok') return
    const out = resumed.output as CliOutput
    expect(out.turns).toBe(2)
    // HANDOFF steered it: turn 1 ran the EDITED instruction.
    expect(out.text).toContain('apply only the safe edits')
    // NO DRIFT: turn 0's original work is preserved verbatim across the park.
    expect(out.transcript[0]!.output).toContain('refactor the auth module')
    expect(out.transcript[1]!.output).toContain('apply only the safe edits')
  })

  it('a destructive prompt parks BEFORE the CLI runs and fails closed on denial', async () => {
    // The action gate is a T2 chokepoint: a dangerous invocation suspends for
    // human approval before any process spawns.
    const fired = await hub.dispatch({
      from: 'human',
      strategy: { kind: 'capability', capabilities: ['code'] },
      payload: { prompt: 'rm -rf build/ and then git push --force' },
    })
    expect(fired.kind).toBe('suspended')
    if (fired.kind !== 'suspended') return
    // Parked BEFORE any spawn — nothing streamed.
    expect(seen).toHaveLength(0)
    const row = identity.getSuspendedTask(fired.taskId)
    expect((row!.state as { kind: string }).kind).toBe('action_gate')

    // Deny → fail closed; the CLI still never ran.
    const task = JSON.parse(row!.taskJson) as Task
    const denied = await hub.resumeTask('codex', task, {
      ...(row!.state as object),
      decision: { approved: false, note: 'too destructive' },
    })
    expect(denied.kind).toBe('failed')
    if (denied.kind === 'failed') expect(denied.error).toMatch(/denied/i)
    expect(seen).toHaveLength(0)
  })

  it('cancelling a running task kills the child process (terminate seam)', async () => {
    // A wedged CLI that would hang for 10s; the operator cancels it.
    const slow = new CliParticipant({
      id: 'slow',
      capabilities: ['slow'],
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
    })
    const task: Task = {
      id: 'kill-me',
      from: 'human',
      strategy: { kind: 'capability', capabilities: ['slow'] },
      payload: { prompt: 'a task that wedges' },
      createdAt: Date.now(),
    }
    const run = slow.onTask(task)
    setTimeout(() => slow.onTaskCancelled('kill-me', 'operator cancel'), 80)
    const result = await run
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') expect(result.error).toMatch(/cancel/i)
  })
})
