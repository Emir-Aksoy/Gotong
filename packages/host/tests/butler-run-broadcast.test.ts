/**
 * butler-run-broadcast — Track A BE-M5. The butler's UNPROMPTED "your run finished"
 * notice: a background sweep that announces each of a member's runs the moment it
 * crosses into a terminal state, exactly once.
 *
 * Isolated from the hub + IM (tmp config dir + fake runs surface + fake push), this
 * pins the parts that must not drift:
 *   1. DEDUP — a single monotonic high-water mark; a run is announced iff its
 *      `endedAt` is strictly past the mark, so it fires exactly once and never twice.
 *   2. NO BACKFILL — a fresh opt-in stamps the mark to `now()`; runs finished before
 *      opt-in are never announced.
 *   3. TERMINAL-ONLY — a `running` (incl. human-parked) run is never announced.
 *   4. BEST-EFFORT — a delivery miss does NOT advance the mark (that run retries);
 *      a read fault fails closed (mark untouched); oldest-finish-first + burst cap.
 *
 * Deterministic: a tmp rootDir for the opt-in file, fake surfaces, injected clock.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@aipehub/core'

import {
  ButlerRunBroadcastSweeper,
  buildButlerRunBroadcastToolset,
  readButlerRunBroadcastConfig,
  runBroadcastMessage,
  writeButlerRunBroadcastConfig,
} from '../src/personal-butler-run-broadcast.js'
import type { ButlerRunSurface, ButlerRunView } from '../src/personal-butler-observe.js'

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

function run(over: Partial<ButlerRunView> & Pick<ButlerRunView, 'runId'>): ButlerRunView {
  return {
    workflowId: 'daily-todo',
    status: 'done',
    startedAt: 0,
    endedAt: 100,
    ...over,
  }
}

/** A runs surface that returns a fixed list per user + records every query. */
function fakeRuns(byUser: Record<string, ButlerRunView[]>): {
  surface: ButlerRunSurface
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    surface: {
      async listRunsByUser(userId, opts) {
        calls.push(userId)
        const rows = (byUser[userId] ?? []).slice().sort((a, b) => b.startedAt - a.startedAt)
        return opts?.limit ? rows.slice(0, opts.limit) : rows
      },
    },
  }
}

/** A push sink that records deliveries and can be scripted to fail on given texts. */
function fakePush(opts?: { failWhen?: (text: string) => boolean; throwWhen?: (text: string) => boolean }): {
  push: (userId: string, text: string) => Promise<{ delivered: boolean; reason?: string }>
  sent: Array<{ userId: string; text: string }>
} {
  const sent: Array<{ userId: string; text: string }> = []
  return {
    sent,
    async push(userId, text) {
      if (opts?.throwWhen?.(text)) throw new Error('bridge exploded')
      sent.push({ userId, text })
      if (opts?.failWhen?.(text)) return { delivered: false, reason: 'no_bridge' }
      return { delivered: true }
    },
  }
}

describe('butler-run-broadcast — the deterministic message', () => {
  it('phrases done / failed(+reason) / cancelled distinctly, always with the run ref', () => {
    const done = runBroadcastMessage(run({ runId: 'r1', workflowId: 'wf', status: 'done' }))
    expect(done).toContain('跑完了')
    expect(done).toContain('成功')
    expect(done).toContain('[run: r1]')

    const failed = runBroadcastMessage(run({ runId: 'r2', status: 'failed', error: '密钥无效' }))
    expect(failed).toContain('失败')
    expect(failed).toContain('密钥无效')
    expect(failed).toContain('[run: r2]')

    const failedNoReason = runBroadcastMessage(run({ runId: 'r3', status: 'failed' }))
    expect(failedNoReason).toContain('失败')
    expect(failedNoReason).not.toContain('原因')

    const cancelled = runBroadcastMessage(run({ runId: 'r4', status: 'cancelled' }))
    expect(cancelled).toContain('取消')
    expect(cancelled).toContain('[run: r4]')
  })
})

describe('butler-run-broadcast — config store', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aipe-runbroadcast-cfg-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('returns null for a member who never opted in', async () => {
    expect(await readButlerRunBroadcastConfig(root, 'u1')).toBeNull()
  })

  it('round-trips a written config', async () => {
    await writeButlerRunBroadcastConfig(root, 'u1', { enabled: true, announcedMax: 4242 })
    expect(await readButlerRunBroadcastConfig(root, 'u1')).toEqual({ enabled: true, announcedMax: 4242 })
  })

  it('normalizes a partial/garbage file to off/mark=0', async () => {
    // Write a valid one, then a hand-edited partial through the raw writer's dir.
    await writeButlerRunBroadcastConfig(root, 'u1', { enabled: false, announcedMax: 0 })
    // A missing announcedMax degrades to 0; a non-bool enabled degrades to false.
    await writeButlerRunBroadcastConfig(root, 'u1', { enabled: true } as never)
    const back = await readButlerRunBroadcastConfig(root, 'u1')
    expect(back).toEqual({ enabled: true, announcedMax: 0 })
  })
})

describe('butler-run-broadcast — sweeper dedup + high-water mark', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aipe-runbroadcast-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  function sweeper(runs: ButlerRunSurface, push: fakePushReturn['push'], over?: { maxPerTick?: number }) {
    return new ButlerRunBroadcastSweeper({
      rootDir: root,
      runs,
      push,
      logger: silentLogger,
      ...(over ?? {}),
    })
  }

  it('skips a member who never opted in', async () => {
    const runs = fakeRuns({ u1: [run({ runId: 'r1' })] })
    const push = fakePush()
    const out = await sweeper(runs.surface, push.push).runOnceForMember('u1')
    expect(out).toEqual({ announced: 0, reason: 'disabled' })
    expect(push.sent).toHaveLength(0)
  })

  it('announces a run finished past the mark, then never again (idempotent)', async () => {
    await writeButlerRunBroadcastConfig(root, 'u1', { enabled: true, announcedMax: 50 })
    const runs = fakeRuns({ u1: [run({ runId: 'r1', endedAt: 100 })] })
    const push = fakePush()
    const sw = sweeper(runs.surface, push.push)

    const first = await sw.runOnceForMember('u1')
    expect(first).toEqual({ announced: 1 })
    expect(push.sent).toHaveLength(1)
    expect(push.sent[0]!.text).toContain('[run: r1]')
    // Mark advanced to the run's endedAt.
    expect(await readButlerRunBroadcastConfig(root, 'u1')).toEqual({ enabled: true, announcedMax: 100 })

    // Second sweep: same run is now at-or-below the mark → nothing.
    const second = await sw.runOnceForMember('u1')
    expect(second).toEqual({ announced: 0, reason: 'nothing-new' })
    expect(push.sent).toHaveLength(1)
  })

  it('never backfills a run that finished at/before the mark (no history dump on opt-in)', async () => {
    await writeButlerRunBroadcastConfig(root, 'u1', { enabled: true, announcedMax: 100 })
    const runs = fakeRuns({ u1: [run({ runId: 'old', endedAt: 80 }), run({ runId: 'boundary', endedAt: 100 })] })
    const push = fakePush()
    const out = await sweeper(runs.surface, push.push).runOnceForMember('u1')
    expect(out).toEqual({ announced: 0, reason: 'nothing-new' })
    expect(push.sent).toHaveLength(0)
  })

  it('announces only TERMINAL runs — a running/parked run is skipped', async () => {
    await writeButlerRunBroadcastConfig(root, 'u1', { enabled: true, announcedMax: 0 })
    const runs = fakeRuns({
      u1: [
        run({ runId: 'live', status: 'running', endedAt: undefined }),
        run({ runId: 'fin', status: 'done', endedAt: 200 }),
      ],
    })
    const push = fakePush()
    const out = await sweeper(runs.surface, push.push).runOnceForMember('u1')
    expect(out).toEqual({ announced: 1 })
    expect(push.sent.map((s) => s.text.includes('[run: fin]'))).toEqual([true])
    // The mark advanced past the finished run only.
    expect((await readButlerRunBroadcastConfig(root, 'u1'))!.announcedMax).toBe(200)
  })

  it('announces oldest-finish-first so the mark advances monotonically', async () => {
    await writeButlerRunBroadcastConfig(root, 'u1', { enabled: true, announcedMax: 0 })
    const runs = fakeRuns({
      u1: [
        run({ runId: 'c', endedAt: 300, startedAt: 3 }),
        run({ runId: 'a', endedAt: 100, startedAt: 1 }),
        run({ runId: 'b', endedAt: 200, startedAt: 2 }),
      ],
    })
    const push = fakePush()
    const out = await sweeper(runs.surface, push.push).runOnceForMember('u1')
    expect(out).toEqual({ announced: 3 })
    expect(push.sent.map((s) => s.text.match(/\[run: (\w+)\]/)![1])).toEqual(['a', 'b', 'c'])
    expect((await readButlerRunBroadcastConfig(root, 'u1'))!.announcedMax).toBe(300)
  })
})

describe('butler-run-broadcast — burst cap + best-effort delivery', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aipe-runbroadcast-be-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('caps per tick and picks the rest up next tick', async () => {
    await writeButlerRunBroadcastConfig(root, 'u1', { enabled: true, announcedMax: 0 })
    const runs = fakeRuns({
      u1: [
        run({ runId: 'a', endedAt: 100, startedAt: 1 }),
        run({ runId: 'b', endedAt: 200, startedAt: 2 }),
        run({ runId: 'c', endedAt: 300, startedAt: 3 }),
      ],
    })
    const push = fakePush()
    const sw = new ButlerRunBroadcastSweeper({ rootDir: root, runs: runs.surface, push: push.push, logger: silentLogger, maxPerTick: 2 })

    const first = await sw.runOnceForMember('u1')
    expect(first).toEqual({ announced: 2 })
    expect(push.sent.map((s) => s.text.match(/\[run: (\w+)\]/)![1])).toEqual(['a', 'b'])
    expect((await readButlerRunBroadcastConfig(root, 'u1'))!.announcedMax).toBe(200)

    const second = await sw.runOnceForMember('u1')
    expect(second).toEqual({ announced: 1 })
    expect(push.sent.map((s) => s.text.match(/\[run: (\w+)\]/)![1])).toEqual(['a', 'b', 'c'])
    expect((await readButlerRunBroadcastConfig(root, 'u1'))!.announcedMax).toBe(300)
  })

  it('a delivery MISS cuts the batch short and does not advance past the failed run', async () => {
    await writeButlerRunBroadcastConfig(root, 'u1', { enabled: true, announcedMax: 0 })
    const runs = fakeRuns({
      u1: [
        run({ runId: 'a', endedAt: 100, startedAt: 1 }),
        run({ runId: 'b', endedAt: 200, startedAt: 2 }),
        run({ runId: 'c', endedAt: 300, startedAt: 3 }),
      ],
    })
    // 'b' fails to deliver → a announces, b + c retry next tick.
    const push = fakePush({ failWhen: (t) => t.includes('[run: b]') })
    const sw = new ButlerRunBroadcastSweeper({ rootDir: root, runs: runs.surface, push: push.push, logger: silentLogger })

    const first = await sw.runOnceForMember('u1')
    expect(first).toEqual({ announced: 1, reason: 'delivery-failed' })
    expect((await readButlerRunBroadcastConfig(root, 'u1'))!.announcedMax).toBe(100) // only past 'a'

    // Next tick with a healthy bridge re-announces b then c (a stays below the mark).
    const push2 = fakePush()
    const sw2 = new ButlerRunBroadcastSweeper({ rootDir: root, runs: runs.surface, push: push2.push, logger: silentLogger })
    const second = await sw2.runOnceForMember('u1')
    expect(second).toEqual({ announced: 2 })
    expect(push2.sent.map((s) => s.text.match(/\[run: (\w+)\]/)![1])).toEqual(['b', 'c'])
    expect((await readButlerRunBroadcastConfig(root, 'u1'))!.announcedMax).toBe(300)
  })

  it('a push THROW is treated as a miss (no advance, no crash)', async () => {
    await writeButlerRunBroadcastConfig(root, 'u1', { enabled: true, announcedMax: 0 })
    const runs = fakeRuns({ u1: [run({ runId: 'a', endedAt: 100 })] })
    const push = fakePush({ throwWhen: () => true })
    const out = await new ButlerRunBroadcastSweeper({ rootDir: root, runs: runs.surface, push: push.push, logger: silentLogger }).runOnceForMember('u1')
    expect(out).toEqual({ announced: 0, reason: 'delivery-failed' })
    expect((await readButlerRunBroadcastConfig(root, 'u1'))!.announcedMax).toBe(0) // untouched
  })

  it('fails closed when the runs read throws — the mark is never advanced', async () => {
    await writeButlerRunBroadcastConfig(root, 'u1', { enabled: true, announcedMax: 42 })
    const push = fakePush()
    const runs: ButlerRunSurface = { async listRunsByUser() { throw new Error('db down') } }
    const out = await new ButlerRunBroadcastSweeper({ rootDir: root, runs, push: push.push, logger: silentLogger }).runOnceForMember('u1')
    expect(out).toEqual({ announced: 0, reason: 'read-error' })
    expect(push.sent).toHaveLength(0)
    expect((await readButlerRunBroadcastConfig(root, 'u1'))!.announcedMax).toBe(42)
  })
})

describe('butler-run-broadcast — sweep across members (best-effort)', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aipe-runbroadcast-multi-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('one member throwing does not stop the others', async () => {
    await writeButlerRunBroadcastConfig(root, 'good', { enabled: true, announcedMax: 0 })
    await writeButlerRunBroadcastConfig(root, 'bad', { enabled: true, announcedMax: 0 })
    const runs: ButlerRunSurface = {
      async listRunsByUser(userId) {
        if (userId === 'bad') throw new Error('boom')
        return [run({ runId: 'g1', endedAt: 100 })]
      },
    }
    const push = fakePush()
    // runOnce enumerates user dirs; both configs above created user/good + user/bad.
    await new ButlerRunBroadcastSweeper({ rootDir: root, runs, push: push.push, logger: silentLogger }).runOnce()
    expect(push.sent.map((s) => s.userId)).toEqual(['good'])
  })

  it('an empty root (no members) is a clean no-op', async () => {
    const push = fakePush()
    await new ButlerRunBroadcastSweeper({ rootDir: root, runs: fakeRuns({}).surface, push: push.push, logger: silentLogger }).runOnce()
    expect(push.sent).toHaveLength(0)
  })
})

describe('butler-run-broadcast — the set_run_broadcast opt-in tool', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aipe-runbroadcast-tool-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  function textOf(result: { content: { type: string; text?: string }[] }): string {
    return result.content.map((c) => c.text ?? '').join('')
  }

  it('offers exactly the one tool', () => {
    const tools = buildButlerRunBroadcastToolset({ userId: 'u1', rootDir: root })
    expect(tools.listTools().map((t) => t.name)).toEqual(['set_run_broadcast'])
  })

  it('turn-ON stamps the mark to now() so nothing is backfilled', async () => {
    const tools = buildButlerRunBroadcastToolset({ userId: 'u1', rootDir: root, now: () => 5000 })
    const res = await tools.callTool('set_run_broadcast', { enabled: true })
    expect(res.isError).toBeFalsy()
    expect(await readButlerRunBroadcastConfig(root, 'u1')).toEqual({ enabled: true, announcedMax: 5000 })
  })

  it('disable keeps the mark; re-enable does NOT reset it back (no off-window dump), it re-stamps now()', async () => {
    // ON at t=1000 (mark=1000), OFF (mark kept), ON again at t=9000 → re-stamp 9000.
    let clock = 1000
    const tools = buildButlerRunBroadcastToolset({ userId: 'u1', rootDir: root, now: () => clock })
    await tools.callTool('set_run_broadcast', { enabled: true })
    expect((await readButlerRunBroadcastConfig(root, 'u1'))!.announcedMax).toBe(1000)

    await tools.callTool('set_run_broadcast', { enabled: false })
    expect(await readButlerRunBroadcastConfig(root, 'u1')).toEqual({ enabled: false, announcedMax: 1000 })

    clock = 9000
    await tools.callTool('set_run_broadcast', { enabled: true })
    // Fresh turn-ON re-stamps now() so runs finished while OFF are not announced.
    expect(await readButlerRunBroadcastConfig(root, 'u1')).toEqual({ enabled: true, announcedMax: 9000 })
  })

  it('refuses a non-boolean enabled', async () => {
    const tools = buildButlerRunBroadcastToolset({ userId: 'u1', rootDir: root })
    const res = await tools.callTool('set_run_broadcast', { enabled: 'yes' as never })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('开启')
  })
})

// Local alias so the sweeper helper's push param types cleanly.
type fakePushReturn = ReturnType<typeof fakePush>
