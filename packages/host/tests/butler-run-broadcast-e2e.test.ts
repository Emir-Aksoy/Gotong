/**
 * butler-run-broadcast-e2e — Track A BE-M5. The "your run finished" broadcast end to
 * end, closing the seams the unit test fakes away:
 *
 *   ① The REAL opt-in tool (`set_run_broadcast`) writes the per-user config the REAL
 *      sweeper then reads — the two halves actually meet on disk.
 *   ② The sweeper observes runs through the REAL `WorkflowController.listRunsByUser`
 *      — the exact object wired as `butlerObserveRunsRef` in main.ts — so the member-
 *      facing projection (userId scoping + secret scrub) is what drives the notice.
 *   ③ A terminal run this member started is announced ONCE (oldest-finish first); a
 *      second sweep is silent; a failed run's reason rides along in the notice.
 *   ④ no-leak: a run ANOTHER member started never reaches this member's sweep.
 *
 * The controller, run store, opt-in tool, config store, and sweeper are all the real
 * code; only the IM push is a recording fake (so the delivered text is verifiable).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, InMemoryStorage, type Logger } from '@aipehub/core'
import { RunStore, type RunState } from '@aipehub/workflow'

import { WorkflowController } from '../src/workflow-controller.js'
import {
  ButlerRunBroadcastSweeper,
  buildButlerRunBroadcastToolset,
  readButlerRunBroadcastConfig,
} from '../src/personal-butler-run-broadcast.js'

const USER = 'u1'
const OTHER = 'u2'

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

/** Seed a full RunState for `store.write`, defaulting the boilerplate fields. */
function makeRun(
  over: Partial<RunState> & Pick<RunState, 'runId' | 'workflowId' | 'startedAt' | 'status'>,
): RunState {
  return { triggeredByTaskId: 't_x', triggerPayload: {}, steps: [], ...over }
}

interface Rig {
  tmp: string
  memRoot: string
  hub: Hub
  controller: WorkflowController
  store: RunStore
  sent: Array<{ userId: string; text: string }>
  push: (userId: string, text: string) => Promise<{ delivered: boolean }>
}

async function boot(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipe-runbroadcast-e2e-'))
  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()
  const controller = new WorkflowController({ hub, definitionsDir: join(tmp, 'wf'), spaceRoot: tmp })
  const store = new RunStore(tmp)
  store.ensureDirs()
  const sent: Array<{ userId: string; text: string }> = []
  const push = async (userId: string, text: string) => {
    sent.push({ userId, text })
    return { delivered: true }
  }
  return { tmp, memRoot: join(tmp, 'mem'), hub, controller, store, sent, push }
}

describe('butler-run-broadcast-e2e — BE-M5 (real controller + real tool + real sweeper)', () => {
  let r: Rig
  beforeEach(async () => { r = await boot() })
  afterEach(async () => {
    await r.hub.stop().catch(() => {})
    await rm(r.tmp, { recursive: true, force: true })
  })

  /** Turn the broadcast on for a member THROUGH THE REAL TOOL, stamping the mark at `at`. */
  async function optIn(userId: string, at: number): Promise<void> {
    const tools = buildButlerRunBroadcastToolset({ userId, rootDir: r.memRoot, now: () => at, logger: silentLogger })
    const res = await tools.callTool('set_run_broadcast', { enabled: true })
    expect(res.isError).toBeFalsy()
    expect((await readButlerRunBroadcastConfig(r.memRoot, userId))!.announcedMax).toBe(at)
  }

  function sweeper(): ButlerRunBroadcastSweeper {
    return new ButlerRunBroadcastSweeper({ rootDir: r.memRoot, runs: r.controller, push: r.push, logger: silentLogger })
  }

  // ① + ② + ③ — opt in via the tool, seed two terminal runs the member started, and
  // let the sweeper observe them through the REAL controller projection.
  it('announces this member\'s finished runs once, oldest-first, with the failure reason', async () => {
    await optIn(USER, 100) // mark = 100; only runs finishing after count
    // A clean finish and a failed one, both attributed to USER, both past the mark.
    await r.store.write(makeRun({
      runId: 'r_done', workflowId: '每日待办', startedAt: 150, endedAt: 200, status: 'done',
      finalOutput: 'ok', triggeredByOrigin: { orgId: 'local', userId: USER },
    }))
    await r.store.write(makeRun({
      runId: 'r_fail', workflowId: '对账', startedAt: 160, endedAt: 300, status: 'failed',
      error: '上游超时', triggeredByOrigin: { orgId: 'local', userId: USER },
    }))

    const out = await sweeper().runOnceForMember(USER)
    expect(out).toEqual({ announced: 2 })
    // Oldest-finish first: r_done (200) then r_fail (300).
    expect(r.sent.map((s) => s.userId)).toEqual([USER, USER])
    expect(r.sent[0]!.text).toContain('每日待办')
    expect(r.sent[0]!.text).toContain('成功')
    expect(r.sent[0]!.text).toContain('[run: r_done]')
    expect(r.sent[1]!.text).toContain('对账')
    expect(r.sent[1]!.text).toContain('失败')
    expect(r.sent[1]!.text).toContain('上游超时') // the failure reason rode along
    expect(r.sent[1]!.text).toContain('[run: r_fail]')
    // Mark advanced to the latest finish; a second sweep is silent (once-only).
    expect((await readButlerRunBroadcastConfig(r.memRoot, USER))!.announcedMax).toBe(300)

    const again = await sweeper().runOnceForMember(USER)
    expect(again).toEqual({ announced: 0, reason: 'nothing-new' })
    expect(r.sent).toHaveLength(2)
  })

  // ④ no-leak — a run ANOTHER member started is invisible to this member's sweep,
  // because the REAL `listRunsByUser` scopes on `triggeredByOrigin.userId`.
  it('never announces another member\'s run', async () => {
    await optIn(USER, 0)
    await r.store.write(makeRun({
      runId: 'r_mine', workflowId: 'mine', startedAt: 10, endedAt: 100, status: 'done',
      triggeredByOrigin: { orgId: 'local', userId: USER },
    }))
    await r.store.write(makeRun({
      runId: 'r_theirs', workflowId: 'theirs', startedAt: 20, endedAt: 200, status: 'done',
      triggeredByOrigin: { orgId: 'local', userId: OTHER },
    }))

    const out = await sweeper().runOnceForMember(USER)
    expect(out).toEqual({ announced: 1 })
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]!.text).toContain('[run: r_mine]')
    expect(r.sent.some((s) => s.text.includes('r_theirs'))).toBe(false) // no leak
  })

  // A member who never opted in gets nothing even with a finished run on disk.
  it('stays silent for a member who never opted in', async () => {
    await r.store.write(makeRun({
      runId: 'r_x', workflowId: 'wf', startedAt: 10, endedAt: 100, status: 'done',
      triggeredByOrigin: { orgId: 'local', userId: USER },
    }))
    const out = await sweeper().runOnceForMember(USER)
    expect(out).toEqual({ announced: 0, reason: 'disabled' })
    expect(r.sent).toHaveLength(0)
  })
})
