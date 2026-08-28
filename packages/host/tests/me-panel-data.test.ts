/**
 * SDUI-C1a — me-panel-data projections (the /api/me/panel/data/* backing).
 *
 * Load-bearing claims:
 *  - tasksForUser reads the REAL notebook file layout (ownerDir + tasks.json,
 *    the same path the butler factory writes) and projects open tasks only —
 *    the free-form `note` never enters the projection;
 *  - observer contract holds end-to-end: missing / corrupt / hostile-userId
 *    all → [] with zero side effects (no quarantine — the butler's turn stays
 *    the file's only writer);
 *  - schedulesForUser is a pure passthrough of the SEN-M4 surface (null when
 *    unwired — the route's {available:false});
 *  - hubStatus projects derivePatrolCards over the SAME snapshot authority the
 *    patrol uses, and a failing probe degrades to [] (never throws into the
 *    route);
 *  - usageForUser (C1-b) windows the ledger aggregate to 7/30 days and
 *    re-sorts chronologically (the SQL orders by cost DESC — chart order);
 *  - longRunForUser (OBS-M2) reads the REAL dossier layout the driver writes
 *    (butlerLongRunRoot + ownerDir), and its two load-bearing folds hold: the
 *    sticky `waitingForChildren` flag only reads as 「在等」 when a child is
 *    actually in flight, and every truncation reports what it dropped.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openLongRunDossierStore, openTaskNotebook } from '@gotong/personal-butler'
import { ownerDir } from '@gotong/service-memory-file'

import type { HealthSnapshot } from '../src/admin-health.js'
import { butlerLongRunRoot } from '../src/butler-space-dirs.js'
import { buildMePanelData } from '../src/me-panel-data.js'

let butlerRoot: string
let memoryRoot: string

beforeEach(async () => {
  // 镜像生产布局:`<space>/butler/memory` 与 `<space>/butler/longrun` 是**兄弟**
  // 目录。夹具必须给 memoryRoot 一个自己的父目录——直接拿 mkdtemp 的结果当
  // memoryRoot,它的兄弟就落进了系统临时目录本身(测试之间共享,还会漏在盘上)。
  butlerRoot = await mkdtemp(join(tmpdir(), 'gotong-panel-data-'))
  memoryRoot = join(butlerRoot, 'memory')
  await mkdir(memoryRoot, { recursive: true })
})

afterEach(async () => {
  await rm(butlerRoot, { recursive: true, force: true })
})

function build(overrides?: Partial<Parameters<typeof buildMePanelData>[0]>) {
  return buildMePanelData({
    memoryRoot,
    schedules: () => undefined,
    health: () => undefined,
    ...overrides,
  })
}

function healthSnapshot(partial?: Partial<HealthSnapshot>): HealthSnapshot {
  return {
    agents: [],
    agentsMissingKey: 0,
    managedCount: 0,
    onlineCount: 0,
    mcpServers: [],
    mcpUnwired: 0,
    spaceWritable: true,
    spacePath: '/space',
    ...partial,
  }
}

describe('me-panel-data: tasksForUser', () => {
  it('projects open tasks (title + progress) from the real notebook file, note stays out', async () => {
    const userDir = ownerDir(memoryRoot, { kind: 'user', id: 'alice' })
    await mkdir(userDir, { recursive: true })
    const notebook = openTaskNotebook({ file: join(userDir, 'tasks.json') })
    const opened = await notebook.openNote({
      title: '筹备生日',
      steps: ['订蛋糕', '发邀请'],
      note: '私密草稿不该出现在投影里',
    })
    await notebook.updateNote(opened.id, { doneSteps: [1] })
    const closed = await notebook.openNote({ title: '已完结的', steps: ['x'] })
    await notebook.closeNote(closed.id, 'done')

    const rows = await build().tasksForUser('alice')
    expect(rows).toHaveLength(1)
    expect(rows![0]).toMatchObject({
      id: opened.id,
      title: '筹备生日',
      stepsDone: 1,
      stepsTotal: 2,
    })
    expect(typeof rows![0]!.updatedAt).toBe('number')
    // Narrow projection — the working note is structurally absent.
    expect(Object.keys(rows![0]!)).not.toContain('note')
    expect(JSON.stringify(rows)).not.toContain('私密草稿')
  })

  it('missing file → [] (wired-but-empty, not unavailable)', async () => {
    expect(await build().tasksForUser('nobody')).toEqual([])
  })

  it('corrupt file → [] and the evidence stays untouched (observer never quarantines)', async () => {
    const userDir = ownerDir(memoryRoot, { kind: 'user', id: 'bob' })
    await mkdir(userDir, { recursive: true })
    await writeFile(join(userDir, 'tasks.json'), '{not json', 'utf8')
    expect(await build().tasksForUser('bob')).toEqual([])
    expect(await readdir(userDir)).toEqual(['tasks.json']) // no .corrupt-* rename
  })

  it('hostile userId cannot traverse — ownerDir assert → []', async () => {
    expect(await build().tasksForUser('../../etc')).toEqual([])
  })
})

describe('me-panel-data: schedulesForUser', () => {
  it('surface unwired → null (route answers {available:false})', async () => {
    expect(await build().schedulesForUser('alice')).toBeNull()
  })

  it('passes the SEN-M4 projection through untouched', async () => {
    const rows = [
      {
        workflowId: 'daily-brief',
        cadence: { kind: 'daily' as const, hour: 8, tzOffsetMinutes: 480 },
        enabled: true,
        valid: true,
        lastFiredMark: '2026-07-25',
      },
    ]
    const data = build({
      schedules: () => ({
        listForUser: async (userId: string) => (userId === 'alice' ? rows : []),
      }),
    })
    expect(await data.schedulesForUser('alice')).toEqual(rows)
    expect(await data.schedulesForUser('other')).toEqual([])
  })
})

describe('me-panel-data: hubStatus', () => {
  it('surface unwired → null', async () => {
    expect(await build().hubStatus()).toBeNull()
  })

  it('projects derivePatrolCards over the health snapshot ({id,severity,label,fact} only)', async () => {
    const snap = healthSnapshot({
      agents: [
        { id: 'atong', provider: 'openai-compatible', online: true, missingKey: true },
      ] as HealthSnapshot['agents'],
      mcpServers: [{ name: 'notes', wired: false }] as HealthSnapshot['mcpServers'],
    })
    const data = build({ health: () => ({ snapshot: async () => snap }) })
    const cards = await data.hubStatus()
    expect(cards!.map((c) => c.id)).toEqual(['agent-key:atong', 'mcp-unwired:notes'])
    for (const c of cards!) {
      expect(c.severity).toBe('yellow')
      expect(Object.keys(c).sort()).toEqual(['fact', 'id', 'label', 'severity'])
    }
  })

  it('healthy hub → [] (renderer shows 一切正常, not unavailable)', async () => {
    const data = build({ health: () => ({ snapshot: async () => healthSnapshot() }) })
    expect(await data.hubStatus()).toEqual([])
  })

  it('failing probe → warn + [] (never throws into the route)', async () => {
    const warns: string[] = []
    const data = build({
      health: () => ({ snapshot: async () => { throw new Error('probe down') } }),
      logger: { warn: (msg) => warns.push(msg) },
    })
    expect(await data.hubStatus()).toEqual([])
    expect(warns.length).toBe(1)
  })
})

describe('me-panel-data: usageForUser (C1-b)', () => {
  it('surface unwired → null (route answers {available:false})', async () => {
    expect(await build().usageForUser('alice', 'week')).toBeNull()
  })

  it('week → 7-day window, month → 30-day window, userId passed through', async () => {
    const asked: Array<{ userId: string; since: number }> = []
    const data = build({
      usage: () => ({
        dailyForUser: (userId, since) => {
          asked.push({ userId, since })
          return []
        },
      }),
    })
    const before = Date.now()
    await data.usageForUser('alice', 'week')
    await data.usageForUser('alice', 'month')
    expect(asked.map((a) => a.userId)).toEqual(['alice', 'alice'])
    // since ≈ now − N days (allow the test's own elapsed ms as slack).
    expect(before - asked[0]!.since).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000)
    expect(Date.now() - asked[0]!.since).toBeLessThanOrEqual(7 * 86_400_000 + 1000)
    expect(before - asked[1]!.since).toBeGreaterThanOrEqual(30 * 86_400_000 - 1000)
    expect(Date.now() - asked[1]!.since).toBeLessThanOrEqual(30 * 86_400_000 + 1000)
  })

  it('maps key→day and re-sorts chronologically (ledger aggregate comes cost-DESC)', async () => {
    const data = build({
      usage: () => ({
        dailyForUser: () => [
          { key: '2026-07-25', calls: 9, inputTokens: 900, outputTokens: 90, costMicros: 5000 },
          { key: '2026-07-23', calls: 1, inputTokens: 100, outputTokens: 10, costMicros: 200 },
          { key: '2026-07-24', calls: 4, inputTokens: 400, outputTokens: 40, costMicros: 900 },
        ],
      }),
    })
    const rows = await data.usageForUser('alice', 'week')
    expect(rows!.map((r) => r.day)).toEqual(['2026-07-23', '2026-07-24', '2026-07-25'])
    expect(rows![2]).toEqual({
      day: '2026-07-25',
      calls: 9,
      inputTokens: 900,
      outputTokens: 90,
      costMicros: 5000,
    })
  })

  it('aggregate throw → warn + [] (never throws into the route)', async () => {
    const warns: string[] = []
    const data = build({
      usage: () => ({
        dailyForUser: () => { throw new Error('db locked') },
      }),
      logger: { warn: (msg) => warns.push(msg) },
    })
    expect(await data.usageForUser('alice', 'week')).toEqual([])
    expect(warns.length).toBe(1)
  })
})

describe('me-panel-data: longRunForUser (OBS-M2)', () => {
  /** 在成员真实的档案目录上开一个 store —— 驱动器写的就是这个布局。 */
  function driverStore(userId: string) {
    return openLongRunDossierStore({
      dir: ownerDir(butlerLongRunRoot(memoryRoot), { kind: 'user', id: userId }),
      now: () => 1_700_000_000_000,
    })
  }

  it('从没开过长任务 ⇒ 空快照(不是 null、更不是错)', async () => {
    expect(await build().longRunForUser('alice')).toEqual({ tasks: [], more: 0 })
  })

  it('敌意 userId 过不了 ownerDir 那道 assert ⇒ 空快照', async () => {
    expect(await build().longRunForUser('../../etc')).toEqual({ tasks: [], more: 0 })
  })

  it('投影出计划 / 预算 / 子活 / 日志,自由文本按码点截断且总数随行', async () => {
    const store = driverStore('alice')
    await store.create({ taskId: 'photos', userId: 'alice', objective: '整理照片库' })
    await store.mutate('photos', (d) => {
      // 计划 14 条 > PLAN_ROWS 12;子活 8 条 > CHILD_ROWS 6。
      d.plan = Array.from({ length: 14 }, (_, i) => ({ text: `第 ${i} 步`, done: i < 5 }))
      d.children = Array.from({ length: 8 }, (_, i) => ({
        id: `c${i}`,
        summary: `子活 ${i}`,
        status: 'ok' as const,
      }))
      d.budget = { tokensUsed: 300, tokenBudget: 1000, timeUsedSec: 60, timeBudgetSec: 600 }
      d.segments = 3
    })
    for (const seg of [1, 2, 3, 4]) {
      await store.appendJournal('photos', { seg, did: `第 ${seg} 段`, next: '继续' })
    }

    const snap = await build().longRunForUser('alice')
    expect(snap).not.toBeNull()
    const row = snap!.tasks[0]!
    expect(row.taskId).toBe('photos')
    expect(row.segments).toBe(3)
    // 截了要说:列出来的是 12 条,而盘上真实是 14 条、已勾 5 条。
    expect(row.plan).toHaveLength(12)
    expect(row.planTotal).toBe(14)
    expect(row.planDone).toBe(5)
    // 子活取**最后** 6 条(最近的那些),总数随行。
    expect(row.children.map((c) => c.id)).toEqual(['c2', 'c3', 'c4', 'c5', 'c6', 'c7'])
    expect(row.childrenTotal).toBe(8)
    expect(row.childrenPending).toBe(0)
    expect(row.budget).toEqual({ tokensUsed: 300, tokenBudget: 1000, timeUsedSec: 60, timeBudgetSec: 600 })
    // 日志只取最近 3 段,旧→新。
    expect(row.journal.map((e) => e.seg)).toEqual([2, 3, 4])
  })

  it('objective 按码点截断——增补平面的字不会被劈成两半', async () => {
    const store = driverStore('alice')
    // 250 个四字节码点。按码元截会在第 200 个「半个字」上断开。
    const wide = '\u{1F600}'.repeat(250)
    await store.create({ taskId: 'wide', userId: 'alice', objective: wide })
    const row = (await build().longRunForUser('alice'))!.tasks[0]!
    expect(Array.from(row.objective)).toHaveLength(201) // 200 + 省略号
    expect(row.objective.endsWith('\u2026')).toBe(true)
    expect(Array.from(row.objective).slice(0, 200).every((c) => c === '\u{1F600}')).toBe(true)
  })

  it('sticky 的等待旗:收齐了就不该再显示「在等」', async () => {
    const store = driverStore('alice')
    await store.create({ taskId: 't', userId: 'alice', objective: '目标' })
    await store.mutate('t', (d) => {
      // 旗还立着(裁决那边靠第二道 `pending > 0` 守卫,故它可以 sticky),
      // 但两件子活都结算完了。照旗直报 = 卡上永远「在等」。
      d.waitingForChildren = true
      d.children = [
        { id: 'c1', summary: '一', status: 'ok' },
        { id: 'c2', summary: '二', status: 'failed' },
      ]
    })
    let row = (await build().longRunForUser('alice'))!.tasks[0]!
    expect(row.waiting).toBeNull()
    expect(row.childrenPending).toBe(0)

    // 真有一件在飞 ⇒ 这时候才是「在等」。
    await store.mutate('t', (d) => {
      d.children.push({ id: 'c3', summary: '三', status: 'pending' })
    })
    row = (await build().longRunForUser('alice'))!.tasks[0]!
    expect(row.waiting).toBe('children')
    expect(row.childrenPending).toBe(1)
  })

  it('等子活压过待命——位序镜像段末裁决自己的臂序', async () => {
    const store = driverStore('alice')
    await store.create({ taskId: 't', userId: 'alice', objective: '跟踪体重' })
    await store.mutate('t', (d) => {
      d.standby = { sinceMs: 1, checkBackAtMs: 999, note: '等成员报数' }
    })
    let row = (await build().longRunForUser('alice'))!.tasks[0]!
    expect(row.waiting).toBe('standby')
    expect(row.standbyNote).toBe('等成员报数')
    expect(row.standbyCheckBackAt).toBe(999)

    await store.mutate('t', (d) => {
      d.waitingForChildren = true
      d.children = [{ id: 'c1', summary: '在飞', status: 'pending' }]
    })
    row = (await build().longRunForUser('alice'))!.tasks[0]!
    expect(row.waiting).toBe('children')
    // 不是这一档就不带这一档的字段——渲染层因此不必自己判该显示哪句。
    expect(row.standbyNote).toBeUndefined()
    expect(row.standbyCheckBackAt).toBeUndefined()
  })

  it('maxFinished 透传给观察者,more 如实报被留下的数目', async () => {
    const store = driverStore('alice')
    await store.create({ taskId: 'live', userId: 'alice', objective: '在跑' })
    for (const id of ['a', 'b']) {
      await store.create({ taskId: id, userId: 'alice', objective: id })
      await store.mutate(id, (d) => {
        d.status = 'done'
      })
    }
    const snap = await build().longRunForUser('alice', 0)
    expect(snap!.tasks.map((t) => t.taskId)).toEqual(['live'])
    expect(snap!.more).toBe(2)
  })

  it('坏档跳过 —— 隔离仍然只是写者的特权', async () => {
    const dir = ownerDir(butlerLongRunRoot(memoryRoot), { kind: 'user', id: 'alice' })
    await mkdir(join(dir, 'broken'), { recursive: true })
    await writeFile(join(dir, 'broken', 'dossier.json'), '{ 不是 JSON')
    const snap = await build().longRunForUser('alice')
    expect(snap).toEqual({ tasks: [], more: 0 })
    expect(await readdir(join(dir, 'broken'))).toEqual(['dossier.json'])
  })
})
