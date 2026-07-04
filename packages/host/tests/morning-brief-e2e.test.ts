/**
 * morning-brief-e2e — LIFE-L2① acceptance gate: the whole「每早晨报」loop,
 * deterministic (no LLM, no key, injected clock), on the REAL seams.
 *
 * The shipped story: install the morning-brief workflow (the exact yaml the
 * gallery template registers — `templates/workflows/morning-brief-flow.yaml`
 * is kept same-shape by the web-side template test), add ONE schedule row,
 * and at 08:00 member-local the zero-LLM sweep fires the run AS that member;
 * a `brief.compose` participant completes it; the finished run is attributed
 * to the member (`listRunsByUser` — the same projection BE-M5's run-broadcast
 * reads), and `runBroadcastMessage` composes the IM notice with zero LLM.
 *
 * Every hop is the real code: real `WorkflowController` (import → published
 * rev1), real `Hub` dispatch, real `WorkflowScheduleSweeper` reading the real
 * on-disk intent file. The only stand-in is the brief writer itself — a bare
 * `Participant` (the PARTICIPANT.md 20-line recipe) that COMPLETES the run
 * deterministically, because the claim under test is the scheduling loop,
 * not the prose.
 *
 * Pinned invariants beyond the happy path:
 *   - due gate: 07:59 member-local does NOT fire; 08:30 does (tz defaulted
 *     to +480 when the row omits it — the Malaysia default);
 *   - one gate: the row's spoofed `reader_id` + undeclared field are dropped,
 *     the scope key is force-set to the row's member — a hand-written row
 *     cannot smuggle another member in (and the victim sees nothing);
 *   - same-day dedup: a second sweep the same member-local day is a no-op.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, Space, type Logger, type Participant, type Task, type TaskResult } from '@aipehub/core'

import { runBroadcastMessage } from '../src/personal-butler-run-broadcast.js'
import { WorkflowController } from '../src/workflow-controller.js'
import { WorkflowScheduleSweeper, WORKFLOW_SCHEDULES_FILE } from '../src/workflow-schedule-sweeper.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const FLOW = join(repoRoot, 'templates', 'workflows', 'morning-brief-flow.yaml')

const READER = 'u-emir'

/** Member-local (+08:00 Malaysia) wall time → epoch ms. */
function mytMs(y: number, mo: number, d: number, h: number, min: number): number {
  return Date.UTC(y, mo - 1, d, h, min) - 480 * 60_000
}
// 2026-07-06 is a Monday; the row says daily @ 8 with tz omitted (defaults +480).
const MON_0759 = mytMs(2026, 7, 6, 7, 59)
const MON_0830 = mytMs(2026, 7, 6, 8, 30)
const MON_0900 = mytMs(2026, 7, 6, 9, 0)

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silentLogger
  },
}

/** The PARTICIPANT.md bare-interface recipe: a brief writer that COMPLETES the
 *  compose step (a HumanParticipant would only park it — the run must finish
 *  for the attribution + broadcast claims). */
function briefWriterStub(seen: Array<Record<string, unknown>>): Participant {
  return {
    id: 'brief-writer-stub',
    kind: 'agent',
    capabilities: ['brief.compose'],
    async onTask(task: Task): Promise<TaskResult> {
      const p = task.payload
      if (p && typeof p === 'object' && !Array.isArray(p)) seen.push(p as Record<string, unknown>)
      return {
        kind: 'ok',
        taskId: task.id,
        by: 'brief-writer-stub',
        output: { brief: '今日重点:上线 LIFE-L2①。' },
        ts: Date.now(),
      }
    },
  }
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 15))
  }
}

describe('LIFE-L2① — morning-brief schedule loop e2e (real controller + hub + sweeper)', () => {
  let root: string
  let hub: Hub
  let controller: WorkflowController
  let composed: Array<Record<string, unknown>>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aipe-morning-brief-'))
    const { space } = await Space.init(root, { name: 'morning-brief-e2e' })
    hub = new Hub({ space })
    await hub.start()
    composed = []
    hub.register(briefWriterStub(composed))
    controller = new WorkflowController({
      hub,
      definitionsDir: join(root, 'workflows', 'definitions'),
      spaceRoot: root,
    })
    // The single-install path: import publishes morning-brief rev1.
    await controller.importFromText(await readFile(FLOW, 'utf8'))
  })

  afterEach(async () => {
    await hub.stop().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })

  it('a schedule row fires at 08:00 member-local, the run completes AS the member, spoof nowhere, same-day dedup holds, broadcast message composes', async () => {
    // The intent file a human/admin API writes — with a spoofed scope key and
    // an undeclared field, to prove the gate strips both.
    await writeFile(
      join(root, WORKFLOW_SCHEDULES_FILE),
      JSON.stringify([
        {
          id: 'sched-mb',
          workflowId: 'morning-brief',
          userId: READER,
          cadence: { kind: 'daily', hour: 8 }, // tz omitted → +480 (Malaysia default)
          inputs: { focus: '高效开始这一天', reader_id: 'u-attacker', sneaky: 'x' },
          enabled: true,
        },
      ]),
      'utf8',
    )

    let nowMs = MON_0759
    const sweeper = new WorkflowScheduleSweeper({
      spaceDir: root,
      workflows: controller,
      hub,
      logger: silentLogger,
      clock: () => nowMs,
    })

    // 07:59 member-local — before the hour, nothing fires.
    const early = await sweeper.runOnce()
    expect(early.fired).toEqual([])
    expect(early.notDue).toBe(1)
    expect(early.unrunnable).toEqual([])

    // 08:30 member-local — due; the sweep dispatches through the member gate.
    nowMs = MON_0830
    const due = await sweeper.runOnce()
    expect(due.fired).toEqual(['sched-mb'])

    // Fire-and-forget: wait for the run to COMPLETE, attributed to the member.
    await waitFor(async () => {
      const runs = await controller.listRunsByUser(READER)
      return runs.some((r) => r.workflowId === 'morning-brief' && r.status === 'done')
    })

    // Attribution: the member sees their run; the spoofed id owns nothing.
    const mine = await controller.listRunsByUser(READER)
    const run = mine.find((r) => r.workflowId === 'morning-brief' && r.status === 'done')!
    expect(run).toBeDefined()
    expect(await controller.listRunsByUser('u-attacker')).toEqual([])

    // One gate: across every task payload the hub recorded, the scope key is
    // the row's member, the spoof + undeclared field appear nowhere, and the
    // declared input survived all the way into the compose step.
    const payloads = hub
      .tasks()
      .map((t) => t.task.payload)
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && !Array.isArray(p))
    const scoped = payloads.filter((p) => 'reader_id' in p)
    expect(scoped.length).toBeGreaterThan(0)
    expect(scoped.every((p) => p.reader_id === READER)).toBe(true)
    expect(payloads.every((p) => p.reader_id !== 'u-attacker' && !('sneaky' in p))).toBe(true)
    expect(composed.length).toBeGreaterThan(0)
    expect(composed[0]).toMatchObject({ focus: '高效开始这一天', reader_id: READER })

    // Same member-local day: the fired mark holds, nothing re-fires.
    nowMs = MON_0900
    const again = await sweeper.runOnce()
    expect(again.fired).toEqual([])
    expect(again.notDue).toBe(1)

    // BE-M5's notice for this run composes with zero LLM (RunSummary is
    // structurally the ButlerRunView the broadcast sweep reads).
    const notice = runBroadcastMessage(run)
    expect(notice).toContain('「morning-brief」')
    expect(notice).toContain('成功')
    expect(notice).toContain(run.runId)
  })
})
