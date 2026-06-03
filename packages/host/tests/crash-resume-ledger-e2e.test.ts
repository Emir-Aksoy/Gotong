/**
 * Route B P0-M5 (M5-M4) — crash/restart + ledger no-double-charge ACCEPTANCE GATE.
 *
 * This is the host-level composition of the M5 work: it proves that an agent
 * task parked across a simulated process restart resumes EXACTLY ONCE and is
 * charged to the usage ledger EXACTLY ONCE — no lost work, no double charge.
 *
 * Everything here is the real machinery, not stubbed:
 *   - a real `Hub` whose `suspendNotifier` persists to a real `IdentityStore`
 *     (tmp sqlite) `suspended_tasks` row — exactly as `main.ts` wires it;
 *   - a real `LlmAgent` whose `preCallHook` parks the FIRST attempt (the
 *     quota-gate-trips shape) and passes on resume, with a real ledger
 *     `usageSink` mirroring `LocalAgentPool` (`appendLedger` + `recordUsage`);
 *   - a faithful copy of `main.ts`'s resume sweep (`listDueSuspendedTasks` →
 *     `hub.resumeTask` → remove the row only on a terminal, non-suspend result);
 *   - a simulated RESTART: close the identity store and reopen it on the same
 *     sqlite file under the same master key, then drive the sweep from the
 *     reopened store — proving the parked row + ledger survive the boundary.
 *
 * The invariant chain (each step is a gate):
 *   dispatch parks  → ledger 0 rows  (the parked attempt never hit the provider,
 *                                     so usageSink never fired — no phantom charge)
 *   …survives restart → the parked row + empty ledger reopen intact
 *   sweep resumes    → ledger 1 row  (resume charged exactly once)
 *   sweep again      → ledger 1 row  (row consumed; the idempotent second boot
 *                                     does NOT replay → no double charge)
 *
 * Falsifiable: neutralise the sweep's "remove on terminal result" and the
 * second sweep replays the still-parked task → a second ledger row → the
 * no-double-charge gate goes RED (verified, then reverted).
 */

import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, Space, SuspendTaskError, type Task } from '@aipehub/core'
import {
  LlmAgent,
  MockLlmProvider,
  type LlmUsage,
  type LlmUsageSinkMeta,
} from '@aipehub/llm'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@aipehub/identity'

import { DEFAULT_PRICING, estimateCostMicros } from '../src/pricing.js'

/**
 * A faithful copy of `main.ts`'s resume sweep: re-hydrate each due row, resume
 * via the hub, and remove the row ONLY when the result is terminal (a
 * suspend-again already re-parked it via INSERT OR REPLACE). Returns how many
 * rows were resumed this pass so the test can assert idempotency.
 */
async function sweepOnce(identity: IdentityStore, hub: Hub, now: number): Promise<number> {
  const due = identity.listDueSuspendedTasks({ now, limit: 100 })
  let resumed = 0
  for (const row of due) {
    if (row.corrupt) {
      identity.removeSuspendedTask(row.taskId)
      continue
    }
    const task = JSON.parse(row.taskJson) as Task
    const result = await hub.resumeTask(row.agentId, task, row.state)
    resumed++
    if (result.kind !== 'suspended') {
      identity.removeSuspendedTask(row.taskId)
    }
  }
  return resumed
}

describe('Route B P0-M5 — crash/restart + ledger no-double-charge acceptance gate', () => {
  let root: string
  let dbPath: string
  let masterKey: Buffer
  let space: Space
  let hub: Hub
  let identity: IdentityStore
  // The "live" store the agent's sink + the hub's notifier write through. A
  // simulated restart repoints this at the reopened store, exactly as a real
  // reboot would re-bind the same code to the reopened sqlite file.
  let liveId: IdentityStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aipe-crash-resume-e2e-'))
    await rm(root, { recursive: true, force: true })
    dbPath = join(root, 'identity.sqlite')
    masterKey = randomBytes(MASTER_KEY_LEN_BYTES)
    space = (await Space.init(root, { name: 'test' })).space
    identity = openIdentityStore({ dbPath, masterKey })
    liveId = identity
    hub = new Hub({
      space,
      // Exactly main.ts's suspendNotifier, but writing through `liveId` so a
      // simulated restart can repoint it at the reopened store.
      suspendNotifier: (task, by, suspend) => {
        liveId.persistSuspendedTask({
          taskId: task.id,
          agentId: by,
          hubId: 'local',
          originUserId: task.origin?.userId ?? null,
          resumeAt: suspend.resumeAt,
          state: suspend.state,
          taskJson: JSON.stringify(task),
        })
      },
    })
    await hub.start()
  })

  afterEach(async () => {
    try { liveId.close() } catch { /* already closed */ }
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  it('a task parked across a restart resumes once and charges the ledger exactly once', async () => {
    const user = liveId.createUser({
      email: 'crash-e2e@test.local',
      displayName: 'Crash E2E',
      role: 'member',
    })

    // The ledger sink mirrors LocalAgentPool: append a priced row per provider
    // response AND record the budget consumption (ungated). It fires only when
    // the provider actually responds — so a parked-before-the-call round writes
    // nothing.
    const sink = (task: Task, usage: LlmUsage, meta: LlmUsageSinkMeta): void => {
      const { costMicros, unpriced } = estimateCostMicros(usage, meta.model, DEFAULT_PRICING)
      liveId.appendLedger({
        orgId: task.origin?.orgId ?? null,
        userId: task.origin?.userId ?? null,
        agentId: 'biller',
        taskId: task.id,
        model: meta.model,
        provider: meta.provider,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        costMicros,
        unpriced,
      })
      const userId = task.origin?.userId
      if (userId) {
        liveId.recordUsage({
          userId,
          metric: 'llm_tokens',
          period: 'daily',
          amount: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        })
      }
    }

    // Park the FIRST attempt before it can reach the provider (the shape a
    // quota-gate suspend takes), then pass forever after. `resumeAt: 1` keeps
    // the row immediately due so the sweep picks it up.
    let parkedOnce = false
    hub.register(
      new LlmAgent({
        id: 'biller',
        capabilities: ['bill'],
        model: 'claude-opus-4',
        provider: new MockLlmProvider({ reply: 'done' }),
        preCallHook: () => {
          if (!parkedOnce) {
            parkedOnce = true
            throw new SuspendTaskError({ resumeAt: 1 })
          }
        },
        usageSink: sink,
      }),
    )

    // --- 1. dispatch → the agent parks BEFORE the provider call.
    const fired = await hub.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['bill'] },
      payload: { q: 'charge me once' },
      origin: { orgId: 'local', userId: user.id },
    })
    expect(fired.kind).toBe('suspended')
    // === GATE 1: the parked attempt cost nothing (provider never responded). ===
    expect(liveId.queryLedger({})).toHaveLength(0)
    expect(liveId.listDueSuspendedTasks({ now: Date.now() })).toHaveLength(1)

    // --- 2. simulate a process RESTART: close + reopen the sqlite store, then
    //        repoint the live binding (as a reboot re-binds the same code).
    identity.close()
    const reopened = openIdentityStore({ dbPath, masterKey })
    liveId = reopened
    // === GATE 2: the parked row + empty ledger survive the restart. ===
    expect(reopened.listDueSuspendedTasks({ now: Date.now() })).toHaveLength(1)
    expect(reopened.queryLedger({})).toHaveLength(0)

    // --- 3. post-restart sweep resumes the parked task exactly once.
    const resumedA = await sweepOnce(reopened, hub, Date.now())
    expect(resumedA).toBe(1)
    // === GATE 3: resume charged the ledger exactly once + consumed the row. ===
    const rows = reopened.queryLedger({})
    expect(rows).toHaveLength(1)
    expect(rows[0].userId).toBe(user.id)
    expect(rows[0].agentId).toBe('biller')
    expect(rows[0].model).toBe('claude-opus-4')
    expect(rows[0].costMicros).toBeGreaterThan(0)
    expect(reopened.listDueSuspendedTasks({ now: Date.now() })).toHaveLength(0)

    // --- 4. a SECOND sweep (a later boot / sweep tick) finds nothing to do.
    const resumedB = await sweepOnce(reopened, hub, Date.now())
    expect(resumedB).toBe(0)
    // === GATE 4 (the point of this test): NO double charge. ===
    expect(reopened.queryLedger({})).toHaveLength(1)

    // …and the budget counter advanced exactly once, in lockstep with the row.
    const usage = reopened.listUsage({ userId: user.id, metric: 'llm_tokens', period: 'daily' })
    expect(usage[0]?.used ?? 0).toBeGreaterThan(0)
    expect(usage[0]?.used).toBe(rows[0].inputTokens + rows[0].outputTokens)
  })
})
