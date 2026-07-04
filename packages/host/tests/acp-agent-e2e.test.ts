/**
 * `@gotong/acp-agent` M6 — the ACP adapter acceptance gate (end-to-end).
 *
 * THE test the feature exists to pass (AGENT-ADAPTER-CONTRACT §5): the hub
 * OpenClaw-style "manages from startup → holds the session → dispatches" to an
 * external coding agent (Claude Code / Codex) over a long-lived ACP session, a
 * person can intercept a per-action permission, hand it to a reviewer, and
 * resume it with no drift — and can kill a wedged turn. The five seams in one
 * story, but with the property cli-agent CANNOT give: context held across tasks.
 *
 *   OBSERVE    — `session/update` chunks stream live to a sink (host → transcript)
 *   HOLD       — a SECOND task hits the SAME held session (turn counter advances)
 *   INTERCEPT  — a destructive `session/request_permission` escalates → the task
 *                parks while the subprocess stays BLOCKED on the open request
 *   HANDOFF    — the parked task becomes an inbox item, delegated to a reviewer
 *   RESUME     — approve → the held permission is answered, the SAME turn finishes,
 *                and the pre-permission stream is preserved verbatim (no drift)
 *   TERMINATE  — cancelling a wedged turn ends it (ACP cancel + abort)
 *
 * Everything that can be real is real:
 *   - a real Hub (InMemoryStorage) with a production-shaped suspendNotifier
 *     persisting parked tasks to a real IdentityStore (tmp sqlite),
 *   - the real `AcpParticipant` driving a deterministic mock ACP server SPAWNED
 *     for real (process.execPath <fixture>) — real stdio, real NDJSON framing,
 *     no API key, no network,
 *   - the real `FileInboxStore` carrying the handoff between operator and reviewer.
 *
 * The mock ACP server stands in for `npx @zed-industries/claude-code-acp` /
 * `codex-acp`; the control plane the test exercises is byte-for-byte the one a
 * real bridge runs under (swap command/args for an ACP_PRESETS entry — see
 * examples/acp-coding-bridge).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, InMemoryStorage, type Task, type TaskId } from '@gotong/core'
import { AcpParticipant, ACP_NEVER_RESUME_AT } from '@gotong/acp-agent'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import { FileInboxStore } from '@gotong/inbox'

// The real-spawned mock ACP agent. `process.execPath <this>` exercises the real
// stdio / NDJSON path (unlike the unit tests' in-memory PassThrough mock).
const MOCK_ACP = fileURLToPath(new URL('./fixtures/mock-acp-server.mjs', import.meta.url))

/** A chunk captured from the OBSERVE sink. */
interface Seen {
  taskId: string
  text: string | undefined
}

/** Shape of AcpParticipant's ok output (it's `unknown` at the seam). */
interface AcpOutput {
  text: string
  stopReason: string
  sessionId?: string
  permissionApproved?: boolean
}

/** Park state shape persisted by the suspendNotifier. */
interface AcpParkState {
  kind: string
  permissionToken: string
  tool: { kind?: string; title?: string }
}

const outputOf = (r: { output?: unknown }): AcpOutput => r.output as AcpOutput

/** Poll until a condition holds — deterministic readiness, no fixed sleeps. */
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('acp-agent M6 — ACP adapter acceptance gate', () => {
  let tmp: string
  let identity: IdentityStore
  let hub: Hub
  let inboxStore: FileInboxStore
  let acp: AcpParticipant
  let seen: Seen[]

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-acp-e2e-'))
    identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
    hub = new Hub({
      storage: new InMemoryStorage(),
      // Production-shaped: any participant that throws SuspendTaskError is
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
    seen = []

    acp = new AcpParticipant({
      id: 'acp-coder',
      capabilities: ['code'],
      command: process.execPath,
      args: [MOCK_ACP],
      // OBSERVE seam: stream every chunk out, attributed to the task.
      onChunk: (taskId, chunk) => seen.push({ taskId, text: chunk.text }),
      // Default gate (dangerousToolGate) escalates a destructive tool → T2.
    })
    hub.register(acp)
  })

  afterEach(async () => {
    await hub.stop()
    await acp.onShutdown() // kill the held child (idempotent)
    identity.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('observe streaming + holds ONE session across two tasks (context preserved)', async () => {
    // ── OBSERVE + first turn ─────────────────────────────────────────────
    const r1 = await hub.dispatch({
      from: 'human',
      strategy: { kind: 'capability', capabilities: ['code'] },
      payload: { prompt: 'summarize the repo' },
    })
    expect(r1.kind).toBe('ok')
    if (r1.kind !== 'ok') return
    const t1 = r1.taskId

    // OBSERVE: the chunk streamed live during the turn (a sink saw it).
    expect(seen.some((c) => c.taskId === t1 && c.text?.includes('echo:summarize the repo'))).toBe(true)
    expect(outputOf(r1).text).toContain('turn=1')

    // ── HOLD: a SECOND task hits the SAME held session ───────────────────
    // The mock's per-process turn counter only advances because the subprocess
    // (and its ACP session) stayed alive between tasks — the cli-agent can't do
    // this; it spawns a fresh process per task.
    const r2 = await hub.dispatch({
      from: 'human',
      strategy: { kind: 'capability', capabilities: ['code'] },
      payload: { prompt: 'and the tests' },
    })
    expect(r2.kind).toBe('ok')
    if (r2.kind !== 'ok') return
    expect(outputOf(r2).text).toContain('turn=2')
    expect(acp.sessionId).toBe('mock-1') // handshook once, held
  })

  it('intercept destructive → inbox handoff → resume approved, no drift', async () => {
    // ── INTERCEPT ────────────────────────────────────────────────────────
    // The agent asks permission to run "rm -rf build"; the default gate
    // escalates; the hub parks the task while the subprocess stays BLOCKED on
    // the open reverse request.
    const fired = await hub.dispatch({
      from: 'human',
      strategy: { kind: 'capability', capabilities: ['code'] },
      payload: { prompt: 'cleanup please — NEED_PERM' },
    })
    expect(fired.kind).toBe('suspended')
    if (fired.kind !== 'suspended') return
    const taskId = fired.taskId

    // OBSERVE: the pre-permission chunk streamed before the park.
    expect(seen.some((c) => c.taskId === taskId && c.text?.includes('echo:'))).toBe(true)

    // Parked at the never-resume sentinel → the resume sweep can NEVER wake it.
    const row = identity.getSuspendedTask(taskId)
    expect(row).not.toBeNull()
    expect(row!.resumeAt).toBe(ACP_NEVER_RESUME_AT)
    const park = row!.state as AcpParkState
    expect(park.kind).toBe('permission')
    expect(park.permissionToken).toMatch(/^acp-perm-/)
    expect(park.tool.title).toBe('rm -rf build')
    const due = identity.listDueSuspendedTasks({ now: Date.now() })
    expect(due.some((d) => d.taskId === taskId)).toBe(false)

    // ── HANDOFF ──────────────────────────────────────────────────────────
    await inboxStore.write({
      itemId: taskId,
      userId: 'alice',
      kind: 'approval',
      prompt: `ACP permission: ${park.tool.title} — approve before continuing`,
      parentKind: 'agent',
      status: 'pending',
      createdAt: 1,
    })
    expect(await inboxStore.listPending('alice')).toHaveLength(1)
    await inboxStore.delegate(taskId, 'bob', { actor: 'alice', note: 'you review this one' })
    const bobItems = await inboxStore.listPending('bob')
    expect(bobItems).toHaveLength(1)
    expect(bobItems[0]!.prompt).toContain('ACP permission')
    expect(await inboxStore.listPending('alice')).toHaveLength(0)

    // ── RESUME (approved, no drift) ──────────────────────────────────────
    // Race-guarded resolve runs BEFORE resume; then the host resumes the parked
    // task with the carried state verbatim plus the decision. The held permission
    // is answered, the subprocess unblocks, the SAME turn finishes.
    await inboxStore.markResolved(taskId, { kind: 'approval', approved: true })
    const task = JSON.parse(row!.taskJson) as Task
    const resumed = await hub.resumeTask('acp-coder', task, {
      ...(row!.state as object),
      decision: { approved: true },
    })
    identity.removeSuspendedTask(taskId)

    expect(resumed.kind).toBe('ok')
    if (resumed.kind !== 'ok') return
    const out = outputOf(resumed)
    expect(out.stopReason).toBe('end_turn')
    expect(out.permissionApproved).toBe(true)
    // NO DRIFT: the pre-permission stream is preserved AND the post-permission
    // work landed — one continuous turn across the park.
    expect(out.text).toContain('echo:')
    expect(out.text).toContain('perm:allowed')
  })

  it('rejecting a destructive permission → the action never happens (fail-closed)', async () => {
    const fired = await hub.dispatch({
      from: 'human',
      strategy: { kind: 'capability', capabilities: ['code'] },
      payload: { prompt: 'wipe everything — NEED_PERM' },
    })
    expect(fired.kind).toBe('suspended')
    if (fired.kind !== 'suspended') return

    const row = identity.getSuspendedTask(fired.taskId)
    const task = JSON.parse(row!.taskJson) as Task
    const denied = await hub.resumeTask('acp-coder', task, {
      ...(row!.state as object),
      decision: { approved: false },
    })

    // ACP semantics: a denied permission is NOT a hub-level task failure — the
    // agent declines the tool and finishes the turn with a 'refusal' stopReason.
    expect(denied.kind).toBe('ok')
    if (denied.kind !== 'ok') return
    const out = outputOf(denied)
    expect(out.stopReason).toBe('refusal')
    expect(out.permissionApproved).toBe(false)
    // Fail-closed: the destructive "perm:allowed" work never streamed.
    expect(out.text).not.toContain('perm:allowed')
  })

  it('cancelling a wedged turn ends it as cancelled (terminate seam)', async () => {
    // A dedicated instance driving the real mock; the prompt HANGs until cancel.
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
    const task: Task = {
      id: 'kill-me' as TaskId,
      from: 'human',
      strategy: { kind: 'capability', capabilities: ['slow'] },
      payload: { prompt: 'a turn that wedges — HANG' },
      createdAt: Date.now(),
    }
    const run = term.onTask(task)
    // Cancel only once the prompt is genuinely in-flight (first chunk observed),
    // so the abort lands on the running turn rather than mid-handshake.
    await waitFor(() => started)
    term.onTaskCancelled('kill-me' as TaskId, 'operator cancel')

    const result = await run
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') expect(outputOf(result).stopReason).toBe('cancelled')
    await term.onShutdown()
  })
})
