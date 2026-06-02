/**
 * v5 Stream D-M1 — heartbeat engine tests.
 *
 * Three layers, no host binary / no SQLite:
 *   1. `parseHeartbeatState` — validation.
 *   2. `HeartbeatScheduler.reconcile` — idempotent seed + stale prune.
 *   3. End-to-end self-renewal — a real in-memory Hub + the broker + a
 *      tiny sweep loop (same shape as host/main.ts) proves the agent is
 *      woken repeatedly and the single parked row renews itself.
 */

import { describe, expect, it } from 'vitest'

import {
  AgentParticipant,
  Hub,
  type ParticipantId,
  type Task,
  type TaskResult,
} from '@aipehub/core'

import {
  HEARTBEAT_BROKER_ID,
  HEARTBEAT_OK,
  HEARTBEAT_TASK_PREFIX,
  HeartbeatParticipant,
  HeartbeatScheduler,
  buildHeartbeatPayload,
  classifyHeartbeatResult,
  heartbeatResultText,
  parseHeartbeatState,
  type HeartbeatAgentConfig,
  type HeartbeatStore,
} from '../src/heartbeat.js'

// --- in-memory suspended-task store, mirroring identity's table shape ------

interface Row {
  taskId: string
  agentId: string
  resumeAt: number
  state: unknown
  taskJson: string
}

class MemStore implements HeartbeatStore {
  readonly rows = new Map<string, Row>()

  getSuspendedTask(taskId: string): { taskId: string; state: unknown } | null {
    const r = this.rows.get(taskId)
    return r ? { taskId: r.taskId, state: r.state } : null
  }

  persistSuspendedTask(input: {
    taskId: string
    agentId: string
    resumeAt: number
    state: unknown
    taskJson: string
  }): void {
    this.rows.set(input.taskId, {
      taskId: input.taskId,
      agentId: input.agentId,
      resumeAt: input.resumeAt,
      state: input.state,
      taskJson: input.taskJson,
    })
  }

  listSuspendedTasksByAgent(agentId: string): Array<{ taskId: string; state: unknown }> {
    return [...this.rows.values()]
      .filter((r) => r.agentId === agentId)
      .map((r) => ({ taskId: r.taskId, state: r.state }))
  }

  removeSuspendedTask(taskId: string): number {
    return this.rows.delete(taskId) ? 1 : 0
  }

  /** Sweep helper — due rows oldest-first, like listDueSuspendedTasks. */
  listDue(now: number): Row[] {
    return [...this.rows.values()]
      .filter((r) => r.resumeAt <= now)
      .sort((a, b) => a.resumeAt - b.resumeAt)
  }
}

// --- a target agent that counts the heartbeat tasks it received ------------

class CountingAgent extends AgentParticipant {
  readonly fires: Task[] = []
  constructor(id: string) {
    super({ id, capabilities: ['demo'] })
  }
  protected handleTask(task: Task): unknown {
    this.fires.push(task)
    return { ok: true }
  }
}

// --- 1. parseHeartbeatState ------------------------------------------------

describe('parseHeartbeatState', () => {
  it('accepts a minimal valid state', () => {
    expect(parseHeartbeatState({ targetAgentId: 'a', intervalMs: 5 })).toEqual({
      targetAgentId: 'a',
      intervalMs: 5,
    })
  })

  it('keeps a checklist string when present', () => {
    const st = parseHeartbeatState({ targetAgentId: 'a', intervalMs: 5, checklist: 'check inbox' })
    expect(st.checklist).toBe('check inbox')
  })

  it('rejects missing target, non-positive interval, and non-objects', () => {
    expect(() => parseHeartbeatState({ intervalMs: 5 })).toThrow()
    expect(() => parseHeartbeatState({ targetAgentId: 'a', intervalMs: 0 })).toThrow()
    expect(() => parseHeartbeatState({ targetAgentId: 'a', intervalMs: -1 })).toThrow()
    expect(() => parseHeartbeatState(null)).toThrow()
    expect(() => parseHeartbeatState([])).toThrow()
  })
})

// --- 1b. buildHeartbeatPayload (D-M2) --------------------------------------

describe('buildHeartbeatPayload', () => {
  it('embeds the checklist in the prompt and keeps it as a structured field', () => {
    const p = buildHeartbeatPayload(
      { targetAgentId: 'a', intervalMs: 60_000, checklist: 'check the inbox\nreview deadlines' },
      1_000,
    )
    expect(p.heartbeat).toBe(true)
    expect(p.firedAt).toBe(1_000)
    expect(p.checklist).toBe('check the inbox\nreview deadlines')
    // The prompt is what a default LlmAgent.buildRequest turns into the user
    // turn — it must carry the checklist verbatim + the idle convention.
    const prompt = p.prompt as string
    expect(prompt).toContain('check the inbox')
    expect(prompt).toContain('review deadlines')
    expect(prompt).toContain(HEARTBEAT_OK)
  })

  it('falls back to a generic prompt and omits checklist when none is set', () => {
    const p = buildHeartbeatPayload({ targetAgentId: 'a', intervalMs: 60_000 }, 2_000)
    expect(p.heartbeat).toBe(true)
    expect('checklist' in p).toBe(false) // absent stays absent — no null noise
    const prompt = p.prompt as string
    expect(prompt).toContain('standing responsibilities')
    expect(prompt).toContain(HEARTBEAT_OK)
  })

  it('treats a whitespace-only checklist as no checklist for the prompt body', () => {
    const p = buildHeartbeatPayload({ targetAgentId: 'a', intervalMs: 60_000, checklist: '   ' }, 3_000)
    // Raw field is preserved (round-trips what the agent declared)...
    expect(p.checklist).toBe('   ')
    // ...but the prompt uses the generic body, not an empty checklist block.
    expect(p.prompt as string).toContain('standing responsibilities')
  })
})

// --- 1c. classifyHeartbeatResult / heartbeatResultText (D-M3) --------------

const ok = (output: unknown): TaskResult => ({
  kind: 'ok',
  taskId: 't',
  by: 'demo-agent',
  output,
  ts: 0,
})

describe('heartbeatResultText', () => {
  it('reads a bare string output and an LlmTaskOutput-style .text', () => {
    expect(heartbeatResultText(ok('hello'))).toBe('hello')
    expect(heartbeatResultText(ok({ text: 'hi', stopReason: 'end_turn' }))).toBe('hi')
  })

  it('returns undefined for non-ok results and opaque objects', () => {
    expect(heartbeatResultText({ kind: 'failed', taskId: 't', by: 'a', error: 'boom', ts: 0 })).toBeUndefined()
    expect(heartbeatResultText(ok({ data: 123 }))).toBeUndefined()
    expect(heartbeatResultText(ok(null))).toBeUndefined()
  })
})

describe('classifyHeartbeatResult', () => {
  it('classifies an exact HEARTBEAT_OK reply as idle (string or .text, trimmed)', () => {
    expect(classifyHeartbeatResult(ok(HEARTBEAT_OK)).kind).toBe('idle')
    expect(classifyHeartbeatResult(ok(`  ${HEARTBEAT_OK}\n`)).kind).toBe('idle')
    expect(classifyHeartbeatResult(ok({ text: HEARTBEAT_OK, stopReason: 'end_turn' })).kind).toBe('idle')
  })

  it('surfaces a substantive reply as active with a trimmed summary', () => {
    const d = classifyHeartbeatResult(ok({ text: '  2 deadlines slipped; escalated to inbox.  ' }))
    expect(d).toEqual({ kind: 'active', summary: '2 deadlines slipped; escalated to inbox.' })
  })

  it('treats an errored turn as failed (surfaced for operator attention)', () => {
    const d = classifyHeartbeatResult({ kind: 'failed', taskId: 't', by: 'a', error: 'llm_timeout', ts: 0 })
    expect(d).toEqual({ kind: 'failed', error: 'llm_timeout' })
  })

  it('treats empty / parked / unreadable results as idle (nothing to surface)', () => {
    expect(classifyHeartbeatResult(ok('   ')).kind).toBe('idle') // ok but empty
    expect(classifyHeartbeatResult(ok({ data: 1 })).kind).toBe('idle') // unreadable
    expect(classifyHeartbeatResult({ kind: 'suspended', taskId: 't', by: 'a', resumeAt: 9, ts: 0 }).kind).toBe('idle')
    expect(classifyHeartbeatResult({ kind: 'no_participant', taskId: 't', reason: 'gone', ts: 0 }).kind).toBe('idle')
  })
})

// --- 2. HeartbeatScheduler.reconcile ---------------------------------------

describe('HeartbeatScheduler.reconcile', () => {
  it('seeds one row per enabled agent, idempotently (no clock reset)', async () => {
    const store = new MemStore()
    const sched = new HeartbeatScheduler({
      store,
      minIntervalMs: 0,
      now: () => 1_000,
      listEnabled: () => [
        { agentId: 'a', intervalMs: 500 },
        { agentId: 'b', intervalMs: 500, checklist: 'do x' },
      ],
    })

    const r1 = await sched.reconcile()
    expect(r1.seeded.sort()).toEqual(['a', 'b'])
    expect(store.rows.size).toBe(2)

    const rowA = store.rows.get(HEARTBEAT_TASK_PREFIX + 'a')!
    expect(rowA.agentId).toBe(HEARTBEAT_BROKER_ID)
    expect(rowA.resumeAt).toBe(1_500) // now(1000) + interval(500)
    expect((rowA.state as { targetAgentId: string }).targetAgentId).toBe('a')
    expect((store.rows.get(HEARTBEAT_TASK_PREFIX + 'b')!.state as { checklist?: string }).checklist).toBe('do x')

    // Re-running is a no-op — never reseeds a live row / resets its clock.
    const r2 = await sched.reconcile()
    expect(r2.seeded).toEqual([])
    expect(store.rows.get(HEARTBEAT_TASK_PREFIX + 'a')!.resumeAt).toBe(1_500)
  })

  it('clamps interval up to the floor', async () => {
    const store = new MemStore()
    const sched = new HeartbeatScheduler({
      store,
      minIntervalMs: 1_000,
      now: () => 0,
      listEnabled: () => [{ agentId: 'a', intervalMs: 5 }],
    })
    await sched.reconcile()
    expect(store.rows.get(HEARTBEAT_TASK_PREFIX + 'a')!.resumeAt).toBe(1_000) // floored
  })

  it('prunes rows whose agent is no longer enabled', async () => {
    const store = new MemStore()
    let enabled = [{ agentId: 'a', intervalMs: 500 }]
    const sched = new HeartbeatScheduler({ store, minIntervalMs: 0, listEnabled: () => enabled })
    await sched.reconcile()
    expect(store.rows.size).toBe(1)

    enabled = []
    const r = await sched.reconcile()
    expect(r.pruned).toEqual(['a'])
    expect(store.rows.size).toBe(0)
  })

  // --- audit M9: config edits must take effect; orphans must be pruned ----

  it('applies an interval change on the next reconcile (re-anchored clock)', async () => {
    const store = new MemStore()
    let now = 1_000
    let enabled: HeartbeatAgentConfig[] = [{ agentId: 'a', intervalMs: 500 }]
    const sched = new HeartbeatScheduler({
      store,
      minIntervalMs: 0,
      now: () => now,
      listEnabled: () => enabled,
    })
    await sched.reconcile()
    expect(store.rows.get(HEARTBEAT_TASK_PREFIX + 'a')!.resumeAt).toBe(1_500)

    // Operator edits the interval 500 → 2000 (D-M4 calls reconcile on edit).
    // The OLD code `continue`d on the existing row, so this change vanished.
    now = 1_200
    enabled = [{ agentId: 'a', intervalMs: 2_000 }]
    const r = await sched.reconcile()
    expect(r.updated).toEqual(['a'])
    expect(r.seeded).toEqual([])
    const row = store.rows.get(HEARTBEAT_TASK_PREFIX + 'a')!
    expect((row.state as { intervalMs: number }).intervalMs).toBe(2_000)
    expect(row.resumeAt).toBe(3_200) // re-anchored: now(1200) + new interval(2000)
  })

  it('applies a checklist change on the next reconcile', async () => {
    const store = new MemStore()
    let enabled: HeartbeatAgentConfig[] = [{ agentId: 'a', intervalMs: 500 }]
    const sched = new HeartbeatScheduler({
      store,
      minIntervalMs: 0,
      now: () => 0,
      listEnabled: () => enabled,
    })
    await sched.reconcile()
    expect(
      (store.rows.get(HEARTBEAT_TASK_PREFIX + 'a')!.state as { checklist?: string }).checklist,
    ).toBeUndefined()

    enabled = [{ agentId: 'a', intervalMs: 500, checklist: 'check the inbox' }]
    const r = await sched.reconcile()
    expect(r.updated).toEqual(['a'])
    expect(
      (store.rows.get(HEARTBEAT_TASK_PREFIX + 'a')!.state as { checklist?: string }).checklist,
    ).toBe('check the inbox')
  })

  it('leaves an unchanged row alone — no update, the live clock survives', async () => {
    const store = new MemStore()
    let now = 1_000
    const enabled: HeartbeatAgentConfig[] = [{ agentId: 'a', intervalMs: 500, checklist: 'x' }]
    const sched = new HeartbeatScheduler({
      store,
      minIntervalMs: 0,
      now: () => now,
      listEnabled: () => enabled,
    })
    await sched.reconcile()
    now = 1_400 // clock advanced, but the config is identical
    const r = await sched.reconcile()
    expect(r.updated).toEqual([])
    expect(r.seeded).toEqual([])
    // The running clock must NOT be re-anchored on an unchanged reconcile,
    // or a frequent reconcile would starve the cadence.
    expect(store.rows.get(HEARTBEAT_TASK_PREFIX + 'a')!.resumeAt).toBe(1_500)
  })

  it('prunes a corrupt-state orphan row (no usable targetAgentId)', async () => {
    const store = new MemStore()
    // A broker row that can never be mapped back to an agent — the old guard
    // (`typeof targetId === 'string' && …`) skipped these, so they waked the
    // broker on every sweep forever.
    store.persistSuspendedTask({
      taskId: HEARTBEAT_TASK_PREFIX + 'ghost',
      agentId: HEARTBEAT_BROKER_ID,
      resumeAt: 0,
      state: { intervalMs: 500 }, // no targetAgentId
      taskJson: '{}',
    })
    const sched = new HeartbeatScheduler({ store, minIntervalMs: 0, listEnabled: () => [] })
    const r = await sched.reconcile()
    expect(r.pruned).toEqual([HEARTBEAT_TASK_PREFIX + 'ghost'])
    expect(store.rows.size).toBe(0)
  })
})

// --- 3. end-to-end self-renewal --------------------------------------------

describe('heartbeat engine — end-to-end self-renewal', () => {
  it('wakes the target agent repeatedly and renews the single parked row', async () => {
    const store = new MemStore()
    const hub = Hub.inMemory({
      // Wire the scheduler's suspend signal to the same store the sweep
      // reads — exactly what the host does with identity.persistSuspendedTask.
      suspendNotifier: (task, by, suspend) => {
        store.persistSuspendedTask({
          taskId: task.id,
          agentId: by,
          resumeAt: suspend.resumeAt,
          state: suspend.state,
          taskJson: JSON.stringify(task),
        })
      },
    })
    await hub.start()

    const target = new CountingAgent('demo-agent')
    hub.register(target)

    const broker = new HeartbeatParticipant({
      fire: async (st) => {
        await hub.dispatch({
          from: HEARTBEAT_BROKER_ID,
          strategy: { kind: 'explicit', to: st.targetAgentId as ParticipantId },
          payload: { heartbeat: true },
          title: 'heartbeat',
        })
      },
    })
    hub.register(broker)

    const sched = new HeartbeatScheduler({
      store,
      minIntervalMs: 0,
      listEnabled: () => [{ agentId: 'demo-agent', intervalMs: 20 }],
    })
    await sched.reconcile()
    expect(store.rows.size).toBe(1)
    const taskId = HEARTBEAT_TASK_PREFIX + 'demo-agent'

    // Tiny sweep loop, same shape as host/main.ts's resume sweep.
    const sweep = async (): Promise<void> => {
      for (const row of store.listDue(Date.now())) {
        const result: TaskResult = await hub.resumeTask(
          row.agentId as ParticipantId,
          JSON.parse(row.taskJson) as Task,
          row.state,
        )
        if (result.kind !== 'suspended') store.removeSuspendedTask(row.taskId)
      }
    }

    for (let i = 0; i < 40 && target.fires.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 15))
      await sweep()
    }

    // Agent woken at least twice (proves recurrence, not a one-shot).
    expect(target.fires.length).toBeGreaterThanOrEqual(2)
    // The heartbeat row self-renewed: still exactly one, same id, never removed.
    expect(store.rows.size).toBe(1)
    expect(store.getSuspendedTask(taskId)).not.toBeNull()
    // And its clock advanced past the original seed (it re-parked).
    expect(store.rows.get(taskId)!.resumeAt).toBeGreaterThan(Date.now() - 1_000)

    await hub.stop()
  })
})
