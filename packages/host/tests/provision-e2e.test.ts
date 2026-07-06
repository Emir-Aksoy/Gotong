/**
 * provision-e2e — FDE-M3 acceptance gate: `gotong provision` drives the WHOLE
 * 开荒 loop against a real hub over real HTTP, with the REAL dogfood pack
 * (`examples/morning-brief-hub`, which now ships a `schedules[]` suggestion).
 *
 * Every hop is the production seam: real `serveWeb` (Bearer admin auth), the
 * real import route (parser + suggestion recording), the real schedule-admin
 * surface (upsert normalisation), the real acceptance service (member gate +
 * zero-LLM judging), and the real sweeper for the post-provision fire. The
 * only stand-in is the brief writer — a bare Participant with switchable
 * output, because the claims under test are the provisioning loop and the
 * judging, not the prose.
 *
 * Pinned:
 *   1. `--user`: install green + schedule row REALLY lands (via the same POST
 *      upsert as the admin card) + acceptance green → exit 0; afterwards the
 *      sweeper fires that row AS the member (attribution to `--user`, not to
 *      the admin who provisioned).
 *   2. no `--user`: suggestion stays intent — yellow line, no row on disk,
 *      suggestion recorded durably for the 定时卡; still exit 0 (yellow ≠ red).
 *   3. acceptance red (stub drops the required sections) → exit 3 with
 *      per-violation lines.
 *   4. dead hub → exit 2; usage error → exit 1.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { provision } from '@gotong/cli'
import { Hub, Space, type Logger, type Participant, type Task, type TaskResult } from '@gotong/core'
import { serveWeb, type WebServerHandle } from '@gotong/web'

import { createTemplateAcceptanceService } from '../src/template-acceptance.js'
import { createScheduleSuggestionStore } from '../src/template-schedule-suggestions.js'
import { WorkflowController } from '../src/workflow-controller.js'
import { createWorkflowScheduleAdminSurface } from '../src/workflow-schedule-admin.js'
import { WorkflowScheduleSweeper } from '../src/workflow-schedule-sweeper.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const PACK = join(repoRoot, 'examples', 'morning-brief-hub', 'template', 'morning-brief-hub.template.yaml')

const MEMBER = 'u-emir'
/** Passes the pack's golden assertions (今日重点/提醒/今日一学, no AI 套话). */
const GOOD_BRIEF = '1. 今日重点: 上线 FDE-M3。\n2. 提醒: 检查交付。\n3. 今日一学: 开荒一条命令。'
/** Misses every required section → 3 missing_phrase violations. */
const BAD_BRIEF = '早上好,这是一段不含任何要求小节的回显。'

// 2026-07-06 (Monday) 08:30 member-local (+08:00 Malaysia default).
const MON_0830 = Date.UTC(2026, 6, 6, 8, 30) - 480 * 60_000

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 15))
  }
}

describe('FDE-M3 — gotong provision e2e (real web + controller + sweeper + acceptance)', () => {
  let root: string
  let hub: Hub
  let web: WebServerHandle
  let adminToken: string
  let controller: WorkflowController
  let sweeper: WorkflowScheduleSweeper
  let nowMs: number
  let briefText: string
  let out: string[]
  let err: string[]

  const runProvision = (extra: string[]): Promise<number> =>
    provision([PACK, '--url', web.url, '--token', adminToken, ...extra], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    })
  const allOut = (): string => out.join('\n')

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-provision-'))
    const init = await Space.init(root, { name: 'provision-e2e', adminDisplayName: 'Operator' })
    adminToken = init.adminToken!
    hub = new Hub({ space: init.space })
    await hub.start()

    briefText = GOOD_BRIEF
    const writer: Participant = {
      id: 'brief-writer-stub',
      kind: 'agent',
      capabilities: ['brief.compose'],
      async onTask(task: Task): Promise<TaskResult> {
        return { kind: 'ok', taskId: task.id, by: 'brief-writer-stub', output: { brief: briefText }, ts: Date.now() }
      },
    }
    hub.register(writer)

    controller = new WorkflowController({
      hub,
      definitionsDir: join(root, 'workflows', 'definitions'),
      spaceRoot: root,
    })
    nowMs = MON_0830
    sweeper = new WorkflowScheduleSweeper({
      spaceDir: root,
      workflows: controller,
      hub,
      logger: silentLogger,
      clock: () => nowMs,
    })
    web = await serveWeb(hub, {
      host: '127.0.0.1',
      port: 0,
      workflows: controller,
      templateAcceptance: createTemplateAcceptanceService({
        spaceDir: root,
        workflows: controller,
        hub,
        timeoutMs: 10_000,
      }),
      scheduleSuggestions: createScheduleSuggestionStore({ spaceDir: root }),
      workflowSchedules: createWorkflowScheduleAdminSurface({
        spaceDir: root,
        sweeper,
        logger: silentLogger,
      }),
    })
    out = []
    err = []
  })

  afterEach(async () => {
    await web.close().catch(() => {})
    await hub.stop().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })

  it('--user: install green, schedule REALLY lands, acceptance green, exit 0 — and the sweeper then fires the row AS the member', async () => {
    const code = await runProvision(['--user', MEMBER])
    const report = allOut()
    expect(code).toBe(0)
    expect(report).toContain('[绿] 装入模板')
    expect(report).toContain('[绿] 定时已建: morning-brief 每天 8:00 → u-emir')
    expect(report).toContain('[绿] 验收 smoke-brief: 通过')
    // The pack's optional calendar slot is honestly yellow, not silently green.
    expect(report).toContain('[黄] 连接器槽待接: calendar (可选)')
    expect(report).not.toContain('[红]')

    // The row is REAL admin-card state, not provision-private bookkeeping.
    const schedRes = await fetch(`${web.url}/api/admin/workflow-schedules`, {
      headers: { authorization: `Bearer ${adminToken}` },
    })
    const schedules = ((await schedRes.json()) as { schedules: Record<string, unknown>[] }).schedules
    expect(schedules).toHaveLength(1)
    expect(schedules[0]).toMatchObject({
      workflowId: 'morning-brief',
      userId: MEMBER,
      enabled: true,
      cadence: { kind: 'daily', hour: 8, tzOffsetMinutes: 480 },
    })

    // And the durable suggestion intent is there for the 定时卡.
    const suggRes = await fetch(`${web.url}/api/admin/workflow-schedules/suggestions`, {
      headers: { authorization: `Bearer ${adminToken}` },
    })
    const packs = ((await suggRes.json()) as { packs: { pack: string }[] }).packs
    expect(packs.map((p) => p.pack)).toEqual(['我的晨报(定时工作流)'])

    // 08:30 member-local — the REAL sweeper fires the provisioned row through
    // the member gate; the run belongs to --user, not the provisioning admin.
    const sweep = await sweeper.runOnce()
    expect(sweep.fired).toHaveLength(1)
    await waitFor(async () => {
      const runs = await controller.listRunsByUser(MEMBER)
      return runs.some((r) => r.workflowId === 'morning-brief' && r.status === 'done')
    })
  })

  it('no --user: suggestion stays intent — yellow, no row on disk, still exit 0', async () => {
    const code = await runProvision([])
    const report = allOut()
    expect(code).toBe(0)
    expect(report).toContain('[黄] 定时建议未补人: morning-brief 每天 8:00')
    expect(report).toContain('[绿] 验收 smoke-brief: 通过')

    const schedRes = await fetch(`${web.url}/api/admin/workflow-schedules`, {
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(((await schedRes.json()) as { schedules: unknown[] }).schedules).toEqual([])
  })

  it('acceptance red → exit 3 with per-violation lines', async () => {
    briefText = BAD_BRIEF
    const code = await runProvision(['--user', MEMBER])
    const report = allOut()
    expect(code).toBe(3)
    expect(report).toContain('[红] 验收 smoke-brief: assert_failed')
    expect(report).toContain('missing_phrase')
    // The schedule half still landed — red acceptance doesn't undo provisioning.
    expect(report).toContain('[绿] 定时已建')
  })

  it('--skip-acceptance: golden cases not run, recorded as yellow', async () => {
    briefText = BAD_BRIEF // would be red — proving it did NOT run
    const code = await runProvision(['--user', MEMBER, '--skip-acceptance'])
    expect(code).toBe(0)
    expect(allOut()).toContain('[黄] 跳过验收')
  })

  it('dead hub → exit 2; usage error → exit 1', async () => {
    const dead = await provision(
      [PACK, '--url', 'http://127.0.0.1:9', '--token', 'x'],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
    )
    expect(dead).toBe(2)
    const usage = await provision([PACK, '--token', 'x'], { out: () => {}, err: (l) => err.push(l) })
    expect(usage).toBe(1)
    expect(err.join('\n')).toContain('--url')
  })
})
