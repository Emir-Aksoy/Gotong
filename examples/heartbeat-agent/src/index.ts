/**
 * v5 Stream D-M5 — heartbeat (proactive autonomy) example.
 *
 * "OpenClaw-style" autonomy: an agent wakes ITSELF on a cadence, runs a full
 * turn against a standing checklist, and either ACTS + reports, or — when
 * nothing needs attention — replies `HEARTBEAT_OK` and is suppressed.
 * The convention is "don't bother me when there's nothing to do."
 *
 * It is built ENTIRELY on the Phase 11 suspend/resume machinery — NO new
 * table, NO new timer:
 *
 *   - A singleton broker ({@link BROKER_ID}) parks a SELF-RENEWING suspended
 *     task row, one per heartbeat-enabled agent. The resume sweep is the
 *     heartbeat's clock.
 *   - Each wake the broker fires one heartbeat at the target agent (a full
 *     turn), classifies the reply, then re-throws `SuspendTaskError` with
 *     `resumeAt = now + intervalMs`. The notifier's INSERT-OR-REPLACE on the
 *     deterministic task id renews the SAME row → one row == one agent's
 *     next-due time, surviving restarts without drift.
 *   - The target agent needs ZERO heartbeat awareness — it just receives a
 *     normal task whose `payload.prompt` carries the checklist.
 *
 * The production engine lives in `packages/host/src/heartbeat.ts` (backed by
 * identity-SQLite, with a 16-test suite). This demo reproduces the same data
 * flow with core-only imports + a `Map` store — exactly like
 * `examples/long-running-agent` stands in for SQLite — so it is one file and
 * runs in ~2 s. The small helpers below (`HEARTBEAT_OK`,
 * `buildHeartbeatPayload`, `classifyHeartbeatResult`) deliberately MIRROR the
 * host engine; the host's test suite is the source of truth.
 *
 *   sweep tick (resume_at <= now)
 *     │
 *     ├─ hub.resumeTask(broker, task, state)
 *     │     │
 *     │     ▼  broker.handleResume:
 *     │        ├─ fire → hub.dispatch(target, heartbeat payload)
 *     │        │     │
 *     │        │     ▼  target runs a full turn against the checklist,
 *     │        │        returns HEARTBEAT_OK (idle) | a summary (acted)
 *     │        ├─ classify → suppress idle / surface active
 *     │        └─ throw SuspendTaskError(resumeAt = now + interval)  ← re-park SAME row
 *     ▼
 *   (one interval later the sweep wakes it again — forever)
 *
 * Run:  pnpm demo:heartbeat-agent
 */

import {
  AgentParticipant,
  Hub,
  SuspendTaskError,
  type ParticipantId,
  type Task,
  type TaskResult,
} from '@aipehub/core'

// --- Mirror of packages/host/src/heartbeat.ts (the canonical engine) --------

/** Fixed id of the singleton heartbeat broker. */
const BROKER_ID: ParticipantId = 'aipehub:heartbeat'
/** Deterministic task id → exactly one self-renewing row per agent. */
const TASK_PREFIX = 'heartbeat:'
/** The reply an agent sends when nothing needs attention → suppressed. */
const HEARTBEAT_OK = 'HEARTBEAT_OK'

/** Opaque state the broker round-trips through suspend/resume. */
interface HeartbeatState {
  targetAgentId: string
  intervalMs: number
  checklist?: string
}

/**
 * The dispatched heartbeat task's payload. The checklist rides as a
 * ready-to-read `prompt` so a *default* `LlmAgent` (whose `buildRequest`
 * turns `payload.prompt` into the user turn) wakes on-topic with ZERO
 * heartbeat awareness. Structured fields ride alongside for aware agents.
 */
function buildHeartbeatPayload(state: HeartbeatState, now: number): Record<string, unknown> {
  const checklist = (state.checklist ?? '').trim()
  const lines = ['[Heartbeat] Scheduled proactive check-in.', '']
  if (checklist.length > 0) {
    lines.push('Run through this checklist and act on anything that needs attention:', '', checklist)
  } else {
    lines.push('Review your standing responsibilities and act on anything that needs attention.')
  }
  lines.push('', `If nothing needs action, reply with exactly ${HEARTBEAT_OK} and do nothing else.`)
  const payload: Record<string, unknown> = { heartbeat: true, firedAt: now, prompt: lines.join('\n') }
  if (state.checklist !== undefined) payload.checklist = state.checklist
  return payload
}

type Disposition =
  | { kind: 'idle' }
  | { kind: 'active'; summary: string }
  | { kind: 'failed'; error: string }

/** Pull the agent's reply text out of a heartbeat result (string | {text}). */
function heartbeatResultText(result: TaskResult): string | undefined {
  if (result.kind !== 'ok') return undefined
  const out = result.output
  if (typeof out === 'string') return out
  if (out && typeof out === 'object' && typeof (out as { text?: unknown }).text === 'string') {
    return (out as { text: string }).text
  }
  return undefined
}

/**
 * The "don't bother me when idle" policy: exactly HEARTBEAT_OK → suppress;
 * an error → surface; any other readable text → the agent acted, surface it.
 * The transcript still records EVERY heartbeat — this governs noise, not audit.
 */
function classifyHeartbeatResult(result: TaskResult): Disposition {
  if (result.kind === 'failed') return { kind: 'failed', error: result.error }
  if (result.kind === 'ok') {
    const text = heartbeatResultText(result)
    if (text !== undefined && text.trim() === HEARTBEAT_OK) return { kind: 'idle' }
    if (text !== undefined && text.trim().length > 0) return { kind: 'active', summary: text.trim() }
    return { kind: 'idle' }
  }
  return { kind: 'idle' }
}

// --- In-memory suspended-task store (stands in for identity-SQLite) ----------

interface ParkedRow {
  taskId: string
  agentId: string
  resumeAt: number
  state: unknown
  task: Task
}
const parked = new Map<string, ParkedRow>()

// --- The broker — a durable recurring trigger, never does real work ----------

class HeartbeatBroker extends AgentParticipant {
  constructor(private readonly fire: (state: HeartbeatState) => Promise<void>) {
    // Empty capabilities: never capability-routed, only resumed by id.
    super({ id: BROKER_ID, capabilities: [] })
  }

  /**
   * A seed dispatch (rare — seeding normally writes the row directly) just
   * schedules the first wake one interval out WITHOUT firing, so a boot never
   * triggers a heartbeat burst.
   */
  protected override handleTask(task: Task): unknown {
    const st = task.payload as HeartbeatState
    throw new SuspendTaskError({ resumeAt: Date.now() + st.intervalMs, state: st })
  }

  /** Each wake: fire one heartbeat at the target, then re-park for the next. */
  protected override async handleResume(_task: Task, state: unknown): Promise<unknown> {
    const st = state as HeartbeatState
    try {
      await this.fire(st)
    } catch {
      // A failing heartbeat must never stop the cadence — swallow and re-park.
    }
    throw new SuspendTaskError({ resumeAt: Date.now() + st.intervalMs, state: st })
  }
}

// --- The target — an inbox-monitor that wakes itself to triage mail ----------

/**
 * A toy "monitor my inbox" agent. It has ZERO knowledge that it's being driven
 * by a heartbeat — it just answers the task it's handed. On each beat it peeks
 * a scripted mailbox: usually empty (→ HEARTBEAT_OK, suppressed), occasionally
 * a VIP message arrives (→ it drafts a reply and reports, surfaced).
 */
class InboxMonitorAgent extends AgentParticipant {
  private beat = 0
  /** Scripted arrivals keyed by beat number → deterministic output. */
  private readonly mailbox: Record<number, string> = {
    3: '客户 Acme 来信：报价单 #4471 今天到期，请确认。',
  }

  constructor() {
    super({ id: 'inbox-monitor', capabilities: ['inbox-monitor'] })
  }

  protected override handleTask(task: Task): unknown {
    this.beat += 1
    const payload = (task.payload ?? {}) as Record<string, unknown>
    // A heartbeat-aware agent can branch on the marker; a plain LlmAgent would
    // just read payload.prompt. We show the aware path for clarity.
    const isHeartbeat = payload.heartbeat === true
    const arrival = this.mailbox[this.beat]
    if (!isHeartbeat || arrival === undefined) {
      // Nothing to do — the suppression sentinel keeps the heartbeat quiet.
      return HEARTBEAT_OK
    }
    // Something needs attention → act, then report a one-line summary.
    return `处理了 1 封 VIP 邮件 — ${arrival} 已起草确认回复草稿待你过目。`
  }
}

// --- The sweep — same shape as host/src/main.ts (here every 150 ms) ----------

async function runSweep(hub: Hub): Promise<number> {
  const now = Date.now()
  const due = [...parked.values()].filter((r) => r.resumeAt <= now).sort((a, b) => a.resumeAt - b.resumeAt)
  for (const row of due) {
    // On a re-park the suspendNotifier already overwrote `parked[taskId]` with
    // the next resumeAt (self-renewal). The broker always re-parks, so a
    // heartbeat row lives forever — we never delete it here.
    await hub.resumeTask(row.agentId as ParticipantId, row.task, row.state)
  }
  return due.length
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n=== AipeHub demo: heartbeat-agent (v5 Stream D) ===\n')

  let fired = 0
  const hub = Hub.inMemory({
    // Phase 11 M2 — captures both the initial seed and every re-park. The
    // deterministic task id makes this an INSERT-OR-REPLACE: one row per agent.
    suspendNotifier: (task, by, suspend) => {
      parked.set(task.id, {
        taskId: task.id,
        agentId: by,
        resumeAt: suspend.resumeAt,
        state: suspend.state,
        task: JSON.parse(JSON.stringify(task)) as Task,
      })
    },
  })
  await hub.start()

  hub.register(new InboxMonitorAgent())

  // `fire` is where the host wires dispatch → classify → surface/suppress.
  const fire = async (st: HeartbeatState): Promise<void> => {
    fired += 1
    const now = Date.now()
    const result = await hub.dispatch({
      from: BROKER_ID,
      strategy: { kind: 'capability', capabilities: [st.targetAgentId] },
      payload: buildHeartbeatPayload(st, now),
      title: `heartbeat:${st.targetAgentId}`,
    })
    const disp = classifyHeartbeatResult(result)
    const tag = `  [heartbeat #${fired} → ${st.targetAgentId}]`
    if (disp.kind === 'idle') {
      console.log(`${tag} 没事 → 安静（HEARTBEAT_OK，已抑制，不打扰）`)
    } else if (disp.kind === 'active') {
      console.log(`${tag} 有事 → 上报：${disp.summary}`)
    } else {
      console.log(`${tag} 失败 → ${disp.error}`)
    }
  }

  hub.register(new HeartbeatBroker(fire))

  // Seed one self-renewing row — exactly what HeartbeatScheduler.reconcile
  // writes on boot. The first wake is one interval out (no boot burst).
  const intervalMs = 150
  const state: HeartbeatState = {
    targetAgentId: 'inbox-monitor',
    intervalMs,
    checklist: '1) 检查收件箱有没有 VIP / 到期的邮件\n2) 有就起草回复并上报；没有就回 HEARTBEAT_OK',
  }
  const seedAt = Date.now()
  parked.set(TASK_PREFIX + state.targetAgentId, {
    taskId: TASK_PREFIX + state.targetAgentId,
    agentId: BROKER_ID,
    resumeAt: seedAt + intervalMs,
    state,
    task: {
      id: TASK_PREFIX + state.targetAgentId,
      from: BROKER_ID,
      strategy: { kind: 'explicit', to: BROKER_ID },
      payload: { ...state },
      title: `heartbeat:${state.targetAgentId}`,
      createdAt: seedAt,
    },
  })
  console.log(`  [system] seeded heartbeat for "inbox-monitor" every ${intervalMs} ms; sweeping…\n`)

  // Pretend the host's resume sweep runs every 50 ms (real default: 30 s). Run
  // until 4 heartbeats have fired so the suppress/surface pattern is visible.
  for (let tick = 0; tick < 200 && fired < 4; tick++) {
    await new Promise((r) => setTimeout(r, 50))
    await runSweep(hub)
  }

  console.log(`\n  [system] ${fired} heartbeats fired; 1 surfaced, ${fired - 1} suppressed.`)
  console.log(`  [system] the row is still parked (resumeAt in the future) — it would beat forever.`)
  console.log(`  transcript: ${hub.transcript.size()} entries (every beat is audited, even the quiet ones)\n`)

  await hub.stop()
  process.exit(0)
}

main().catch((err) => {
  console.error('[heartbeat-agent] fatal:', err)
  process.exit(1)
})
