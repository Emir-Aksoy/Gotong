/**
 * life-records.test.ts — LIFE 纯核:字段校验、事件时间、取代解析、聚合、提醒。
 *
 * 承重点:数是代码算的,所以聚合必须对;校验必须响亮且带正确写法(模型据此自纠);
 * 提醒 id 必须稳定(推送去重靠它)。
 */

import { describe, expect, it } from 'vitest'

import { ButlerError } from '../src/errors.js'
import {
  addDays,
  evaluateLifeAlerts,
  goalProgress,
  isoWeekLabel,
  localDate,
  nextMonthlyDate,
  normalizeAt,
  queryLifeRecords,
  resolveActive,
  slopePerDay,
  validateLifeFields,
  weekStart,
  type LifeRecord,
} from '../src/life-records.js'
import { findLifeDomain, findLifeStream } from '../src/life-templates.js'

const spec = (ref: string) => findLifeStream(ref)!.stream

let seq = 0
function rec(stream: string, at: string, fields: LifeRecord['fields'], extra: Partial<LifeRecord> = {}): LifeRecord {
  seq++
  return {
    id: `${stream.split('.')[1]}-${seq}`,
    stream,
    at,
    recordedAt: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    source: { kind: 'user' },
    fields,
    ...extra,
  }
}

function expectInvalid(fn: () => unknown, contains: string): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(ButlerError)
    expect((err as ButlerError).code).toBe('life_invalid')
    expect((err as Error).message).toContain(contains)
    return
  }
  throw new Error('expected life_invalid')
}

describe('日期', () => {
  it('本地日期按时区算(马来西亚 +8 的早晨不是 UTC 的前一天)', () => {
    const ms = Date.UTC(2026, 9, 19, 23, 30) // UTC 10-19 23:30 = MYT 10-20 07:30
    expect(localDate(ms, 'Asia/Kuala_Lumpur')).toBe('2026-10-20')
    expect(localDate(ms, 'UTC')).toBe('2026-10-19')
  })

  it('周起点是周一;ISO 周标签跨年正确', () => {
    expect(weekStart('2026-10-20')).toBe('2026-10-19') // 周二 → 周一
    expect(weekStart('2026-10-19')).toBe('2026-10-19')
    expect(isoWeekLabel('2026-01-01')).toBe('2026-W01')
    expect(isoWeekLabel('2027-01-01')).toBe('2026-W53')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
  })

  it('事件时间:缺省今天、带时刻规范化、未来与远古拒', () => {
    expect(normalizeAt(undefined, '2026-10-20')).toBe('2026-10-20')
    expect(normalizeAt('2026-10-19T07:05', '2026-10-20')).toBe('2026-10-19 07:05')
    expectInvalid(() => normalizeAt('2026-10-21', '2026-10-20'), '未来')
    expectInvalid(() => normalizeAt('1999-12-31', '2026-10-20'), '太早')
    expectInvalid(() => normalizeAt('昨天', '2026-10-20'), 'YYYY-MM-DD')
    expectInvalid(() => normalizeAt('2026-02-30', '2026-10-20'), 'YYYY-MM-DD')
  })

  it('每月扣款日:本月已过取下月,短月取月末', () => {
    expect(nextMonthlyDate('2026-10-20', 25)).toBe('2026-10-25')
    expect(nextMonthlyDate('2026-10-20', 5)).toBe('2026-11-05')
    expect(nextMonthlyDate('2026-02-10', 31)).toBe('2026-02-28')
  })
})

describe('字段校验', () => {
  it('数值:越界拒且报错带单位和范围;按小数位四舍五入;缺省值补上', () => {
    const w = spec('health.weight')
    expect(validateLifeFields(w, { kg: '72.46' })).toEqual({ kg: 72.5, condition: '其他' })
    expectInvalid(() => validateLifeFields(w, { kg: 720 }), '不能大于 300')
    expectInvalid(() => validateLifeFields(w, { kg: '七十二' }), '单位按 kg')
  })

  it('未知字段与缺必填一律拒,并列出这条流水的字段', () => {
    const w = spec('health.weight')
    expectInvalid(() => validateLifeFields(w, { weight: 72 }), '不认识的字段:weight')
    expectInvalid(() => validateLifeFields(w, { condition: '晨起空腹' }), '缺少必填字段 kg')
  })

  it('枚举、条件必填、至少一项', () => {
    expectInvalid(() => validateLifeFields(spec('finance.tx'), { amount: 10, direction: '花了', category: '餐饮' }), '只能是 支出 / 收入')
    expectInvalid(
      () => validateLifeFields(spec('career.project'), { name: 'A', status: '搁置' }),
      'status 为「搁置」时必填',
    )
    expectInvalid(() => validateLifeFields(spec('mind.mood'), { trigger: '加班' }), '至少要填')
    expect(validateLifeFields(spec('mind.mood'), { stress: 8 })).toEqual({ stress: 8 })
  })

  it('财务默认币种 CNY', () => {
    expect(validateLifeFields(spec('finance.tx'), { amount: 35, direction: '支出', category: '餐饮' }).currency).toBe('CNY')
  })
})

describe('取代解析', () => {
  it('被取代的与撤回的都不算;状态型流水按键只留最新', () => {
    const a = rec('health.weight', '2026-10-18', { kg: 73 })
    const b = rec('health.weight', '2026-10-19', { kg: 7.2 })
    const b2 = rec('health.weight', '2026-10-19', { kg: 72 }, { supersedes: b.id })
    const c = rec('health.weight', '2026-10-20', { kg: 71.8 })
    const cx = rec('health.weight', '2026-10-20', {}, { supersedes: c.id, retracted: true })
    const active = resolveActive([a, b, b2, c, cx], spec('health.weight'))
    expect(active.map((r) => r.fields.kg)).toEqual([73, 72])

    const p1 = rec('career.project', '2026-10-01', { name: 'X', status: '进行' })
    const p2 = rec('career.project', '2026-10-10', { name: 'Y', status: '进行' })
    const p3 = rec('career.project', '2026-10-15', { name: 'X', status: '完成' })
    const cur = resolveActive([p1, p2, p3], spec('career.project'))
    expect(cur.map((r) => `${r.fields.name}:${r.fields.status}`)).toEqual(['Y:进行', 'X:完成'])
  })
})

describe('聚合(数由代码算)', () => {
  it('支出按月求和、按类别分组;多币种不混加', () => {
    const tx = spec('finance.tx')
    const rows = [
      rec('finance.tx', '2026-10-02', { amount: 30, direction: '支出', category: '餐饮', currency: 'CNY' }),
      rec('finance.tx', '2026-10-05', { amount: 70, direction: '支出', category: '交通', currency: 'CNY' }),
      rec('finance.tx', '2026-10-06', { amount: 5000, direction: '收入', category: '收入', currency: 'CNY' }),
      rec('finance.tx', '2026-09-30', { amount: 99, direction: '支出', category: '餐饮', currency: 'CNY' }),
    ]
    const sum = queryLifeRecords(rows, tx, { agg: 'sum', from: '2026-10-01', to: '2026-10-20', where: { direction: '支出' } })
    expect(sum.value).toBe(100)
    expect(sum.n).toBe(2)
    const by = queryLifeRecords(rows, tx, { agg: 'sum', from: '2026-10-01', to: '2026-10-20', where: { direction: '支出' }, groupBy: 'category' })
    expect(by.groups?.map((g) => [g.key, g.value])).toEqual(
      expect.arrayContaining([
        ['餐饮', 30],
        ['交通', 70],
      ]),
    )
    const mixed = [...rows, rec('finance.tx', '2026-10-07', { amount: 40, direction: '支出', category: '餐饮', currency: 'MYR' })]
    const split = queryLifeRecords(mixed, tx, { agg: 'sum', from: '2026-10-01', to: '2026-10-20', where: { direction: '支出' } })
    expect(split.value).toBeUndefined()
    expect(split.byCurrency).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ currency: 'CNY', value: 100 }),
        expect.objectContaining({ currency: 'MYR', value: 40 }),
      ]),
    )
    // 分列时每个币种仍按原 agg 算:ma7 是均值不是总和,trend 数据不足就说不足
    const ma7 = queryLifeRecords(mixed, tx, { agg: 'ma7', to: '2026-10-07', where: { direction: '支出' } })
    expect(ma7.byCurrency?.find((c) => c.currency === 'CNY')).toEqual(expect.objectContaining({ value: 50, note: '2 天有数据' }))
    const trend = queryLifeRecords(mixed, tx, { agg: 'trend', to: '2026-10-07', where: { direction: '支出' } })
    expect(trend.byCurrency?.find((c) => c.currency === 'MYR')).toEqual(
      expect.objectContaining({ note: '不足 3 天数据,算不出趋势' }),
    )
    expect(trend.byCurrency?.find((c) => c.currency === 'MYR')?.value).toBeUndefined()
  })

  it('七日均值与周斜率;不足三天不给趋势', () => {
    const w = spec('health.weight')
    const rows = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'].map(
      (d, i) => rec('health.weight', d, { kg: 74 - i * 0.2 }),
    )
    const ma = queryLifeRecords(rows, w, { agg: 'ma7', to: '2026-10-20' })
    expect(ma.value).toBeCloseTo(73.4, 5)
    const tr = queryLifeRecords(rows, w, { agg: 'trend', to: '2026-10-20' })
    expect(tr.value).toBeCloseTo(-1.4, 5) // 每天 -0.2 ⇒ 每周 -1.4
    expect(slopePerDay([['2026-10-19', 1], ['2026-10-20', 2]])).toBeUndefined()
  })

  it('latest 返回最新一条带 id,count 只数范围内', () => {
    const w = spec('health.weight')
    const rows = [rec('health.weight', '2026-10-01', { kg: 75 }), rec('health.weight', '2026-10-20', { kg: 72 })]
    const latest = queryLifeRecords(rows, w, { agg: 'latest', to: '2026-10-20' })
    expect(latest.current?.[0]?.fields.kg).toBe(72)
    expect(queryLifeRecords(rows, w, { agg: 'count', from: '2026-10-10', to: '2026-10-20' }).value).toBe(1)
  })
})

describe('目标与提醒', () => {
  it('月度预算目标:已用比例与达标判断', () => {
    const tx = spec('finance.tx')
    const rows = [rec('finance.tx', '2026-10-03', { amount: 1700, direction: '支出', category: '餐饮', currency: 'CNY' })]
    const metric = { stream: 'finance.tx', agg: 'month_sum' as const, where: { direction: '支出', category: '餐饮' }, op: '<=' as const, target: 2000 }
    const p = goalProgress(metric, rows, tx, '2026-10-20')
    expect(p.current).toBe(1700)
    expect(p.ratio).toBeCloseTo(0.85, 5)
    expect(p.met).toBe(true)
  })

  it('预算跨过 80% 出提醒,id 在同一周期内稳定', () => {
    const finance = findLifeDomain('finance')!
    const rows = [rec('finance.tx', '2026-10-03', { amount: 1700, direction: '支出', category: '餐饮', currency: 'CNY' })]
    const goals = [
      {
        id: 'g1',
        text: '餐饮每月 ≤2000',
        metric: { stream: 'finance.tx', agg: 'month_sum' as const, where: { direction: '支出', category: '餐饮' }, op: '<=' as const, target: 2000 },
      },
    ]
    const a1 = evaluateLifeAlerts(finance, new Map([['tx', rows]]), goals, '2026-10-20')
    const a2 = evaluateLifeAlerts(finance, new Map([['tx', rows]]), goals, '2026-10-21')
    const budget = a1.filter((a) => a.id.startsWith('finance-budget'))
    expect(budget).toHaveLength(1)
    expect(budget[0]!.push).toBe(true)
    expect(a2.find((a) => a.id.startsWith('finance-budget'))?.id).toBe(budget[0]!.id)
  })

  it('连续低落出提醒;从没记过的流水不催', () => {
    const mind = findLifeDomain('mind')!
    const low = ['2026-10-18', '2026-10-19', '2026-10-20'].map((d) => rec('mind.mood', d, { mood: 3 }))
    const alerts = evaluateLifeAlerts(mind, new Map([['mood', low]]), [], '2026-10-20')
    expect(alerts.some((a) => a.id.startsWith('mind-low-run'))).toBe(true)
    const health = findLifeDomain('health')!
    expect(evaluateLifeAlerts(health, new Map(), [], '2026-10-20')).toEqual([])
  })

  it('多日没训练会提醒(不推送),承诺临期会提醒', () => {
    const health = findLifeDomain('health')!
    const w = [rec('health.workout', '2026-10-10', { type: '跑步', minutes: 30 })]
    const a = evaluateLifeAlerts(health, new Map([['workout', w]]), [], '2026-10-20')
    const nw = a.find((x) => x.id.startsWith('health-no-workout'))
    expect(nw).toBeDefined()
    expect(nw!.push).toBe(false)
    // 文字报实际天数(不是阈值),id 只认最近一次,隔天文字变而 id 不变
    expect(nw!.text).toContain('已经 10 天没有训练记录')
    const next = evaluateLifeAlerts(health, new Map([['workout', w]]), [], '2026-10-21').find((x) => x.id.startsWith('health-no-workout'))
    expect(next!.id).toBe(nw!.id)
    expect(next!.text).toContain('已经 11 天')

    const career = findLifeDomain('career')!
    const c = [rec('career.commitment', '2026-10-15', { what: '交方案', due: '2026-10-21', status: '待办' })]
    const ca = evaluateLifeAlerts(career, new Map([['commitment', c]]), [], '2026-10-20')
    expect(ca.some((x) => x.id.startsWith('career-due') && x.text.includes('交方案'))).toBe(true)
    const done = [rec('career.commitment', '2026-10-15', { what: '交方案', due: '2026-10-21', status: '完成' })]
    expect(evaluateLifeAlerts(career, new Map([['commitment', done]]), [], '2026-10-20').some((x) => x.id.startsWith('career-due'))).toBe(false)
  })
})
