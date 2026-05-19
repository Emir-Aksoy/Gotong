import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub } from '../src/hub.js'
import { AgentParticipant } from '../src/participants/agent.js'
import { Space } from '../src/space.js'
import type { Task } from '../src/types.js'

// H16: Space-backed tests previously leaked their `mkdtempSync` dirs.
// Sweep them up in afterEach — best-effort, never mask the real failure.
const tempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(d)
  return d
}
afterEach(async () => {
  const dirs = tempDirs.splice(0)
  await Promise.all(
    dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})),
  )
})

/**
 * Contribution-system tests (v2.1).
 *
 * The system itself is two new pieces:
 *
 *   - Task.weight  — sanitised in dispatch() to [0.1, 10.0], one decimal,
 *                    default 1.0.
 *   - hub.leaderboard({ from, to })  — derived from the transcript:
 *                                       contribution = weight × rating,
 *                                       latest rated evaluation wins.
 *
 * What matters to us: defaults are sane, clamping is correct, re-evaluation
 * is honoured, time windows filter, and the byCapability breakdown is
 * faithful to the dispatch strategy.
 */

class EchoAgent extends AgentParticipant {
  constructor(id: string, capabilities: readonly string[] = []) {
    super({ id, capabilities })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    return { echo: task.payload }
  }
}

describe('Task.weight sanitisation', () => {
  it('defaults to 1.0 when dispatch omits weight', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('w', ['x']))

    await hub.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['x'] },
      payload: {},
    })
    const tasks = hub.tasks()
    expect(tasks[0]!.task.weight).toBe(1.0)
    expect(tasks[0]!.weight).toBe(1.0)
    await hub.stop()
  })

  it('rounds weight to one decimal', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('w', ['x']))

    await hub.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['x'] },
      payload: {},
      weight: 3.27,
    })
    expect(hub.tasks()[0]!.weight).toBe(3.3)
    await hub.stop()
  })

  it('clamps weight below 0.1 up to 0.1', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('w', ['x']))
    await hub.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['x'] },
      payload: {},
      weight: 0.04,
    })
    expect(hub.tasks()[0]!.weight).toBe(0.1)
    await hub.stop()
  })

  it('clamps weight above 10.0 down to 10.0', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('w', ['x']))
    await hub.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['x'] },
      payload: {},
      weight: 999,
    })
    expect(hub.tasks()[0]!.weight).toBe(10.0)
    await hub.stop()
  })

  it('NaN / Infinity / negative all collapse to defaults', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('w', ['x']))
    await hub.dispatch({
      from: 'admin', strategy: { kind: 'capability', capabilities: ['x'] }, payload: {}, weight: NaN,
    })
    await hub.dispatch({
      from: 'admin', strategy: { kind: 'capability', capabilities: ['x'] }, payload: {}, weight: -5,
    })
    await hub.dispatch({
      from: 'admin', strategy: { kind: 'capability', capabilities: ['x'] }, payload: {}, weight: Infinity,
    })
    const ts = hub.tasks()
    expect(ts[0]!.weight).toBe(1.0)   // NaN → default
    expect(ts[1]!.weight).toBe(0.1)   // -5 → clamp up
    expect(ts[2]!.weight).toBe(1.0)   // Infinity → default
    await hub.stop()
  })
})

describe('Evaluation rating sanitisation', () => {
  it('clamps rating to [0, 5] and rounds to one decimal', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('w', ['x']))
    const r = await hub.dispatch({
      from: 'admin', strategy: { kind: 'capability', capabilities: ['x'] }, payload: {},
    })

    const ev1 = hub.evaluate({ taskId: r.taskId, by: 'admin', rating: 7 })
    expect(ev1.rating).toBe(5)
    const ev2 = hub.evaluate({ taskId: r.taskId, by: 'admin', rating: -1 })
    expect(ev2.rating).toBe(0)
    const ev3 = hub.evaluate({ taskId: r.taskId, by: 'admin', rating: 3.27 })
    expect(ev3.rating).toBe(3.3)
    const ev4 = hub.evaluate({ taskId: r.taskId, by: 'admin', rating: NaN })
    expect(ev4.rating).toBeUndefined()
    await hub.stop()
  })
})

describe('TaskView contribution derivation', () => {
  it('contribution = weight × rating, with latest rating winning', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('w', ['x']))

    const r = await hub.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['x'] },
      payload: {},
      weight: 4.0,
    })
    expect(r.kind).toBe('ok')

    // first eval → 3, contribution = 4.0 × 3 = 12
    hub.evaluate({ taskId: r.taskId, by: 'admin', rating: 3 })
    let v = hub.tasks()[0]!
    expect(v.effectiveRating).toBe(3)
    expect(v.contribution).toBe(12.0)

    // re-evaluate → 4.5, contribution = 4.0 × 4.5 = 18
    hub.evaluate({ taskId: r.taskId, by: 'admin', rating: 4.5 })
    v = hub.tasks()[0]!
    expect(v.effectiveRating).toBe(4.5)
    expect(v.contribution).toBe(18.0)
    expect(v.evaluations).toHaveLength(2)
    await hub.stop()
  })

  it('comment-only evaluation does not overwrite an existing rating', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('w', ['x']))
    const r = await hub.dispatch({
      from: 'admin', strategy: { kind: 'capability', capabilities: ['x'] }, payload: {}, weight: 2.0,
    })
    hub.evaluate({ taskId: r.taskId, by: 'admin', rating: 5 })
    hub.evaluate({ taskId: r.taskId, by: 'admin', comment: 'PS: forgot to add the part about caching' })
    const v = hub.tasks()[0]!
    expect(v.effectiveRating).toBe(5)
    expect(v.contribution).toBe(10.0)
    await hub.stop()
  })

  it('done-but-unrated tasks have no contribution field', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('w', ['x']))
    await hub.dispatch({
      from: 'admin', strategy: { kind: 'capability', capabilities: ['x'] }, payload: {}, weight: 3.0,
    })
    const v = hub.tasks()[0]!
    expect(v.status).toBe('done')
    expect(v.contribution).toBeUndefined()
    expect(v.effectiveRating).toBeUndefined()
    await hub.stop()
  })
})

describe('Hub.leaderboard()', () => {
  it('aggregates rated done tasks; ignores failed, cancelled, and unrated', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('alice', ['draft']))
    hub.register(new EchoAgent('bob', ['draft']))

    // alice: 2 tasks rated 4 and 5, weight 2.0 each
    const r1 = await hub.dispatch({
      from: 'admin', strategy: { kind: 'explicit', to: 'alice' }, payload: {}, weight: 2.0,
    })
    hub.evaluate({ taskId: r1.taskId, by: 'admin', rating: 4 })
    const r2 = await hub.dispatch({
      from: 'admin', strategy: { kind: 'explicit', to: 'alice' }, payload: {}, weight: 2.0,
    })
    hub.evaluate({ taskId: r2.taskId, by: 'admin', rating: 5 })

    // bob: 1 task rated 5, weight 3.0
    const r3 = await hub.dispatch({
      from: 'admin', strategy: { kind: 'explicit', to: 'bob' }, payload: {}, weight: 3.0,
    })
    hub.evaluate({ taskId: r3.taskId, by: 'admin', rating: 5 })

    // unrated alice task — should bump unratedTaskCount but not totals
    await hub.dispatch({
      from: 'admin', strategy: { kind: 'explicit', to: 'alice' }, payload: {}, weight: 1.0,
    })

    // failed task — completely ignored
    await hub.dispatch({
      from: 'admin', strategy: { kind: 'explicit', to: 'ghost' }, payload: {},
    })

    const lb = hub.leaderboard()
    // alice: 2.0*4 + 2.0*5 = 18, average rating 4.5
    // bob:   3.0*5 = 15, average rating 5
    expect(lb.rows).toHaveLength(2)
    expect(lb.rows[0]!.participantId).toBe('alice')
    expect(lb.rows[0]!.totalContribution).toBe(18)
    expect(lb.rows[0]!.taskCount).toBe(2)
    expect(lb.rows[0]!.totalWeight).toBe(4)
    expect(lb.rows[0]!.averageRating).toBe(4.5)
    expect(lb.rows[1]!.participantId).toBe('bob')
    expect(lb.rows[1]!.totalContribution).toBe(15)
    expect(lb.rows[1]!.averageRating).toBe(5)
    expect(lb.unratedTaskCount).toBe(1)
    // 2 alice rated + 1 bob rated + 1 alice unrated = 4 done; the failed
    // dispatch to ghost is not 'done' so it does not count.
    expect(lb.totalTaskCount).toBe(4)
    await hub.stop()
  })

  it('filters by [from, to) window using completedAt', async () => {
    let clock = 1000
    const hub = new (await import('../src/hub.js')).Hub({
      storage: new (await import('../src/storage/index.js')).InMemoryStorage(),
      now: () => clock,
    })
    await hub.start()
    hub.register(new EchoAgent('alice', ['x']))

    clock = 1000
    const r1 = await hub.dispatch({
      from: 'admin', strategy: { kind: 'explicit', to: 'alice' }, payload: {}, weight: 1.0,
    })
    hub.evaluate({ taskId: r1.taskId, by: 'admin', rating: 5 })

    clock = 5000
    const r2 = await hub.dispatch({
      from: 'admin', strategy: { kind: 'explicit', to: 'alice' }, payload: {}, weight: 1.0,
    })
    hub.evaluate({ taskId: r2.taskId, by: 'admin', rating: 4 })

    // window covers only the second task
    const lb = hub.leaderboard({ from: 3000, to: 9999 })
    expect(lb.rows).toHaveLength(1)
    expect(lb.rows[0]!.taskCount).toBe(1)
    expect(lb.rows[0]!.totalContribution).toBe(4)
    expect(lb.totalTaskCount).toBe(1)
    await hub.stop()
  })

  it('breaks contribution down by capability for capability + broadcast routing', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('alice', ['draft', 'review']))

    // a draft task and a review task, both routed by capability
    const r1 = await hub.dispatch({
      from: 'admin', strategy: { kind: 'capability', capabilities: ['draft'] }, payload: {}, weight: 2.0,
    })
    hub.evaluate({ taskId: r1.taskId, by: 'admin', rating: 5 })

    const r2 = await hub.dispatch({
      from: 'admin', strategy: { kind: 'capability', capabilities: ['review'] }, payload: {}, weight: 1.0,
    })
    hub.evaluate({ taskId: r2.taskId, by: 'admin', rating: 4 })

    // explicit dispatch should NOT appear under any capability
    const r3 = await hub.dispatch({
      from: 'admin', strategy: { kind: 'explicit', to: 'alice' }, payload: {}, weight: 1.0,
    })
    hub.evaluate({ taskId: r3.taskId, by: 'admin', rating: 3 })

    const row = hub.leaderboard().rows[0]!
    expect(row.byCapability.draft).toEqual({ count: 1, contribution: 10 })
    expect(row.byCapability.review).toEqual({ count: 1, contribution: 4 })
    expect(row.totalContribution).toBe(17)
    expect(row.taskCount).toBe(3)
    await hub.stop()
  })

  it('orders rows by totalContribution desc, then lastActivityTs desc for ties', async () => {
    let clock = 1000
    const { Hub: H } = await import('../src/hub.js')
    const { InMemoryStorage } = await import('../src/storage/index.js')
    const hub = new H({ storage: new InMemoryStorage(), now: () => clock })
    await hub.start()
    hub.register(new EchoAgent('alice', ['x']))
    hub.register(new EchoAgent('bob', ['x']))

    clock = 1000
    const a1 = await hub.dispatch({
      from: 'admin', strategy: { kind: 'explicit', to: 'alice' }, payload: {}, weight: 1.0,
    })
    hub.evaluate({ taskId: a1.taskId, by: 'admin', rating: 4 })

    clock = 5000
    const b1 = await hub.dispatch({
      from: 'admin', strategy: { kind: 'explicit', to: 'bob' }, payload: {}, weight: 1.0,
    })
    hub.evaluate({ taskId: b1.taskId, by: 'admin', rating: 4 })

    const lb = hub.leaderboard()
    // identical 4.0 contribution; bob completed later → ranks first
    expect(lb.rows[0]!.participantId).toBe('bob')
    expect(lb.rows[1]!.participantId).toBe('alice')
    await hub.stop()
  })
})

describe('retry() preserves weight', () => {
  it('a retried task carries the original weight', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    // first dispatch fails (no participant)
    const r1 = await hub.dispatch({
      from: 'admin', strategy: { kind: 'explicit', to: 'ghost' }, payload: {}, weight: 7.5,
    })
    // Unregistered recipient → no_participant (Hub.tasks() surfaces this
    // as status 'failed', but the raw result.kind is 'no_participant').
    expect(r1.kind).toBe('no_participant')

    // register, then retry — the new task should still be weight 7.5
    hub.register(new EchoAgent('ghost', []))
    await hub.retry(r1.taskId, 'admin')
    const tasks = hub.tasks()
    expect(tasks[1]!.weight).toBe(7.5)
    await hub.stop()
  })

  it('a retried task carries the original countContribution flag', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('w', ['x']))
    const r1 = await hub.dispatch({
      from: 'admin', strategy: { kind: 'capability', capabilities: ['x'] }, payload: {},
      countContribution: false,
    })
    expect(r1.kind).toBe('ok')
    await hub.retry(r1.taskId, 'admin')
    const ts = hub.tasks()
    expect(ts[0]!.task.countContribution).toBe(false)
    expect(ts[1]!.task.countContribution).toBe(false)
    await hub.stop()
  })
})

describe('Per-task contribution opt-out', () => {
  it('countContribution=false hides the task from the leaderboard entirely', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('alice', ['x']))

    // counted task
    const r1 = await hub.dispatch({
      from: 'admin', strategy: { kind: 'explicit', to: 'alice' }, payload: {}, weight: 2.0,
    })
    hub.evaluate({ taskId: r1.taskId, by: 'admin', rating: 5 })

    // opted-out task — same handler, same rating, but should not enter
    // any leaderboard total or the unrated bookkeeping
    const r2 = await hub.dispatch({
      from: 'admin', strategy: { kind: 'explicit', to: 'alice' }, payload: {}, weight: 10.0,
      countContribution: false,
    })
    hub.evaluate({ taskId: r2.taskId, by: 'admin', rating: 5 })

    // a third opt-out task left unrated — must not appear in unratedTaskCount
    await hub.dispatch({
      from: 'admin', strategy: { kind: 'explicit', to: 'alice' }, payload: {},
      countContribution: false,
    })

    const lb = hub.leaderboard()
    expect(lb.rows).toHaveLength(1)
    expect(lb.rows[0]!.taskCount).toBe(1)
    expect(lb.rows[0]!.totalContribution).toBe(10) // 2.0 × 5 only
    expect(lb.unratedTaskCount).toBe(0)
    expect(lb.totalTaskCount).toBe(1)
    await hub.stop()
  })

  it('countContribution=true (or undefined) keeps the task counted', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('alice', ['x']))

    const a = await hub.dispatch({
      from: 'admin', strategy: { kind: 'explicit', to: 'alice' }, payload: {}, weight: 1.0,
      countContribution: true,
    })
    hub.evaluate({ taskId: a.taskId, by: 'admin', rating: 4 })

    const b = await hub.dispatch({
      from: 'admin', strategy: { kind: 'explicit', to: 'alice' }, payload: {}, weight: 1.0,
      // omit countContribution -> default counts
    })
    hub.evaluate({ taskId: b.taskId, by: 'admin', rating: 4 })

    const lb = hub.leaderboard()
    expect(lb.rows[0]!.taskCount).toBe(2)
    expect(lb.rows[0]!.totalContribution).toBe(8)
    await hub.stop()
  })

  it('handler still earns when publisher opted out — opt-out is publisher-scoped', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('alice', ['x']))

    // Simulate Bob opting out: web layer would stamp countContribution=false
    // on Bob's dispatch. Alice handles it.
    const r = await hub.dispatch({
      from: 'bob', strategy: { kind: 'explicit', to: 'alice' }, payload: {}, weight: 2.0,
      countContribution: false,
    })
    hub.evaluate({ taskId: r.taskId, by: 'admin', rating: 5 })

    const lb1 = hub.leaderboard()
    expect(lb1.rows).toHaveLength(0) // Bob's task isn't counted; Alice's row never forms from it

    // Now Carol dispatches WITHOUT opting out — Alice gets credit.
    const r2 = await hub.dispatch({
      from: 'carol', strategy: { kind: 'explicit', to: 'alice' }, payload: {}, weight: 1.0,
    })
    hub.evaluate({ taskId: r2.taskId, by: 'admin', rating: 4 })

    const lb2 = hub.leaderboard()
    expect(lb2.rows).toHaveLength(1)
    expect(lb2.rows[0]!.participantId).toBe('alice')
    expect(lb2.rows[0]!.totalContribution).toBe(4)
    await hub.stop()
  })
})

describe('Space.setAdminContributionOptOut / setWorkerContributionOptOut', () => {
  it('persists and round-trips per-record opt-out flags', async () => {
    const root = makeTempDir('aipehub-optout-')
    const { space } = await Space.init(root, { name: 'test', adminDisplayName: 'Op' })
    const admins = await space.admins()
    const adminId = admins[0]!.id

    expect(admins[0]!.contributionOptOut).toBeUndefined()
    const updated = await space.setAdminContributionOptOut(adminId, true)
    expect(updated?.contributionOptOut).toBe(true)
    const afterRead = (await space.admins())[0]!
    expect(afterRead.contributionOptOut).toBe(true)

    // worker side
    const { worker } = await space.createWorker('alice', ['x'])
    expect(worker.contributionOptOut).toBeUndefined()
    const w2 = await space.setWorkerContributionOptOut('alice', true)
    expect(w2?.contributionOptOut).toBe(true)
    const afterReadW = (await space.workers())[0]!
    expect(afterReadW.contributionOptOut).toBe(true)

    // unknown id returns null
    expect(await space.setAdminContributionOptOut('ghost', true)).toBeNull()
    expect(await space.setWorkerContributionOptOut('ghost', true)).toBeNull()
  })
})
