/**
 * SEN-M4 承重门 — the butler's benign schedules eye (`list_schedules`).
 *
 * Pins the projection's contract:
 *
 *   1. member scoping — the surface returns ONLY rows whose userId is the
 *      asking member; an invalid row whose userId could not be recovered
 *      (admin invalidView yields '') matches nobody;
 *   2. minimal projection — `inputs` / schedule id / userId structurally never
 *      enter the row (list_peers red-line posture);
 *   3. honest rendering — cadence in plain words per its REAL fields, the
 *      last-fired mark per its REAL encoding (daily/weekly = local date,
 *      interval = epoch-ms → UTC), invalid rows say 没在跑, never a guess;
 *   4. absence is honest — empty roster / read failure → friendly text,
 *      never a crash.
 */

import { describe, expect, it } from 'vitest'

import {
  buildButlerScheduleSurface,
  buildButlerSchedulesToolset,
  type ButlerScheduleRow,
  type ButlerScheduleSurface,
} from '../src/personal-butler-schedules.js'

const surfaceOf = (rows: ButlerScheduleRow[]): ButlerScheduleSurface => ({
  listForUser: async () => rows,
})

const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => c.text ?? '').join('\n')

const row = (over: Partial<ButlerScheduleRow>): ButlerScheduleRow => ({
  workflowId: 'wf-brief',
  cadence: { kind: 'daily', hour: 7, tzOffsetMinutes: 480 },
  enabled: true,
  valid: true,
  lastFiredMark: null,
  ...over,
})

describe('SEN-M4 — buildButlerScheduleSurface(成员向过滤 + 最小投影)', () => {
  const adminRows = [
    {
      workflowId: 'wf-brief',
      userId: 'u1',
      cadence: { kind: 'daily' as const, hour: 7, tzOffsetMinutes: 480 },
      enabled: true,
      valid: true,
      lastFiredMark: '2026-07-15',
      // Sloppy-upstream simulation: extra fields must never survive the join.
      inputs: { secretKeyName: 'WEATHER_KEY' },
      id: 'sched-internal-1',
    },
    {
      workflowId: 'wf-other',
      userId: 'u2',
      cadence: { kind: 'daily' as const, hour: 9, tzOffsetMinutes: 480 },
      enabled: true,
      valid: true,
    },
    // Broken row whose userId could not be recovered — belongs to no member view.
    { workflowId: '', userId: '', cadence: null, enabled: false, valid: false },
    // Broken row whose userId still parsed — u1 SHOULD see it as 配置有误.
    { workflowId: 'wf-broken', userId: 'u1', cadence: null, enabled: false, valid: false },
  ]

  it('returns only the asking member rows; unrecoverable broken rows match nobody', async () => {
    const mine = await buildButlerScheduleSurface({ admin: { list: async () => adminRows } }).listForUser('u1')
    expect(mine.map((r) => r.workflowId)).toEqual(['wf-brief', 'wf-broken'])

    const theirs = await buildButlerScheduleSurface({ admin: { list: async () => adminRows } }).listForUser('u2')
    expect(theirs.map((r) => r.workflowId)).toEqual(['wf-other'])
  })

  it('minimal projection: inputs / id / userId structurally never enter the row', async () => {
    const mine = await buildButlerScheduleSurface({ admin: { list: async () => adminRows } }).listForUser('u1')
    expect(mine[0]).toEqual({
      workflowId: 'wf-brief',
      cadence: { kind: 'daily', hour: 7, tzOffsetMinutes: 480 },
      enabled: true,
      valid: true,
      lastFiredMark: '2026-07-15',
    })
    expect('inputs' in mine[0]!).toBe(false)
    expect('userId' in mine[0]!).toBe(false)
    expect('id' in mine[0]!).toBe(false)
    // And the rendered text never carries another member's rows or the payload.
    const out = textOf(await buildButlerSchedulesToolset({ userId: 'u1', schedules: surfaceOf(mine) }).callTool('list_schedules', {}))
    expect(out).not.toContain('wf-other')
    expect(out).not.toContain('WEATHER_KEY')
  })

  it('copies cadence defensively — mutating the projection never touches the admin row', async () => {
    const mine = await buildButlerScheduleSurface({ admin: { list: async () => adminRows } }).listForUser('u1')
    ;(mine[0]!.cadence as { hour: number }).hour = 23
    expect(adminRows[0]!.cadence!.hour).toBe(7)
  })
})

describe('SEN-M4 — list_schedules(渲染诚实)', () => {
  const render = async (rows: ButlerScheduleRow[]): Promise<string> =>
    textOf(await buildButlerSchedulesToolset({ userId: 'u1', schedules: surfaceOf(rows) }).callTool('list_schedules', {}))

  it('daily/weekly/interval cadences render in plain words with their real tz', async () => {
    const out = await render([
      row({ workflowId: 'wf-a', cadence: { kind: 'daily', hour: 7, tzOffsetMinutes: 480 } }),
      row({ workflowId: 'wf-b', cadence: { kind: 'weekly', weekday: 1, hour: 9, tzOffsetMinutes: 0 } }),
      row({ workflowId: 'wf-c', cadence: { kind: 'interval', everyMs: 90 * 60_000 } }),
      row({ workflowId: 'wf-d', cadence: { kind: 'interval', everyMs: 2 * 60 * 60_000 } }),
    ])
    expect(out).toContain('你的定时工作流(4 条)')
    expect(out).toContain('工作流 wf-a — 每天 07:00(UTC+8)')
    expect(out).toContain('工作流 wf-b — 每周一 09:00(UTC)')
    expect(out).toContain('工作流 wf-c — 每 90 分钟')
    expect(out).toContain('工作流 wf-d — 每 2 小时')
  })

  it('half-hour tz offsets render as UTC+5:30, not a rounded lie', async () => {
    const out = await render([row({ cadence: { kind: 'daily', hour: 8, tzOffsetMinutes: 330 } })])
    expect(out).toContain('每天 08:00(UTC+5:30)')
  })

  it('last-fired mark renders per its real encoding: date as-is / interval ms as UTC / never as 还没触发过', async () => {
    const out = await render([
      row({ workflowId: 'wf-a', lastFiredMark: '2026-07-15' }),
      row({
        workflowId: 'wf-b',
        cadence: { kind: 'interval', everyMs: 60_000 },
        lastFiredMark: String(Date.UTC(2026, 6, 15, 23, 5)),
      }),
      row({ workflowId: 'wf-c', lastFiredMark: null }),
    ])
    expect(out).toContain('上次触发:2026-07-15')
    expect(out).toContain('上次触发:2026-07-15 23:05(UTC)')
    expect(out).toContain('还没触发过')
  })

  it('an interval mark that fails to parse says so, never printed as a fake date', async () => {
    const out = await render([
      row({ cadence: { kind: 'interval', everyMs: 60_000 }, lastFiredMark: 'garbage' }),
    ])
    expect(out).toContain('上次触发:(记录无法解析)')
  })

  it('disabled renders 已停用; a broken row says 配置有误 and never invents a cadence', async () => {
    const out = await render([
      row({ workflowId: 'wf-off', enabled: false }),
      row({ workflowId: 'wf-broken', cadence: null, valid: false, enabled: false }),
      row({ workflowId: '', cadence: null, valid: false, enabled: false }),
    ])
    expect(out).toContain('wf-off — 每天 07:00(UTC+8);已停用')
    expect(out).toContain('工作流 wf-broken — 配置有误,这条没在跑;请管理员在面板检查')
    expect(out).toContain('工作流 (工作流未知) — 配置有误')
  })

  it('members have no write face — the copy points at the admin panel, never a tool name', async () => {
    const some = await render([row({})])
    expect(some).toContain('请管理员在面板配置')
    const empty = await render([])
    expect(empty).toContain('你名下没有定时工作流')
    expect(empty).toContain('请管理员在面板新增')
  })

  it('surface throw → friendly error; unknown tool → typed refusal', async () => {
    const broken = buildButlerSchedulesToolset({
      userId: 'u1',
      schedules: { listForUser: async () => { throw new Error('disk gone') } },
    })
    const err = await broken.callTool('list_schedules', {})
    expect(err.isError).toBe(true)
    expect(textOf(err)).toContain('暂时读不到')

    const bad = await buildButlerSchedulesToolset({ userId: 'u1', schedules: surfaceOf([]) }).callTool('rm_rf', {})
    expect(bad.isError).toBe(true)
  })

  it('listTools: exactly the one read-only tool, description names no directory tool', () => {
    const tools = buildButlerSchedulesToolset({ userId: 'u1', schedules: surfaceOf([]) }).listTools()
    expect(tools.map((t) => t.name)).toEqual(['list_schedules'])
    // 指路指空红线:描述指「管理员在面板」这句人话,绝不点名其他工具。
    expect(tools[0]!.description).not.toMatch(/hub_health|my_status|list_my_llms|run_my_workflow/)
  })
})
