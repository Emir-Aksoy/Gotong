/**
 * life-store.test.ts — LIFE 存储层与确定性渲染。
 *
 * 承重点:追加只增不改(更正走取代);档案带版本号,旧版本写不进;上限响亮拒;
 * 坏文件隔离不炸;并发写串行(id 不撞);派生状态无变化不写盘;
 * 驾驶舱卡字节确定、有顶、没有登记表就不出现。
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ButlerError } from '../src/errors.js'
import {
  LIFE_COCKPIT_MARKER,
  LIFE_COCKPIT_MAX_BYTES,
  LIFE_DOSSIER_CARD_MAX_BYTES,
  renderLifeCockpit,
  renderLifeDossierCard,
} from '../src/life-render.js'
import { queryLifeRecords } from '../src/life-records.js'
import { openLifeArchive, type LifeArchive } from '../src/life-store.js'
import { findLifeStream } from '../src/life-templates.js'

let parent: string
let dir: string
// 固定时钟:MYT 2026-10-20 10:00
const NOW = Date.UTC(2026, 9, 20, 2, 0)

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'gotong-life-'))
  dir = join(parent, 'life')
})

afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

const open = (extra: Partial<Parameters<typeof openLifeArchive>[0]> = {}): LifeArchive =>
  openLifeArchive({ dir, timeZone: 'Asia/Kuala_Lumpur', now: () => NOW, ...extra })

async function expectCode(p: Promise<unknown>, code: string, contains?: string): Promise<void> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(ButlerError)
    expect((err as ButlerError).code).toBe(code)
    if (contains) expect((err as Error).message).toContain(contains)
    return
  }
  throw new Error(`expected ${code}`)
}

describe('登记表', () => {
  it('ensureRegistry 幂等;默认五本、CNY、心境每晚签到、推送开', async () => {
    const a = open()
    expect(await a.readRegistry()).toBeNull()
    const r1 = await a.ensureRegistry()
    const r2 = await a.ensureRegistry()
    expect(r2).toEqual(r1)
    expect(r1.domains).toEqual(['health', 'mind', 'finance', 'career', 'decisions'])
    expect(r1.defaultCurrency).toBe('CNY')
    expect(r1.checkin.mind).toEqual({ enabled: true, hour: 21 })
    expect(r1.push).toEqual({ alerts: true, review: true })
  })
})

describe('流水', () => {
  it('追加 → 读回;更正走取代;撤回后不再计入', async () => {
    const a = open()
    const { record: r1 } = await a.appendRecord({ stream: 'health.weight', fields: { kg: 27.24 }, source: { kind: 'user' } })
    expect(r1.id).toBe('weight-1')
    expect(r1.at).toBe('2026-10-20 10:00') // 今天的记录补上当前时刻
    const { record: r2, target } = await a.appendRecord({
      stream: 'health.weight',
      fields: { kg: 72.4 },
      supersedes: r1.id,
      source: { kind: 'user' },
    })
    expect(target?.id).toBe('weight-1')
    expect(r2.at).toBe(r1.at) // 更正沿用原事件时间
    const raw = readFileSync(join(dir, 'health', 'weight.jsonl'), 'utf8').trim().split('\n')
    expect(raw).toHaveLength(2) // 只增不改
    let snap = await a.snapshot('health')
    expect(snap.activeByStream.get('weight')?.map((r) => r.fields.kg)).toEqual([72.4])

    // 被取代的那条不能再被取代
    await expectCode(a.appendRecord({ stream: 'health.weight', fields: { kg: 72 }, supersedes: r1.id, source: { kind: 'user' } }), 'life_invalid', '已被')
    await a.appendRecord({ stream: 'health.weight', supersedes: r2.id, retract: true, source: { kind: 'user' } })
    snap = await a.snapshot('health')
    expect(snap.activeByStream.get('weight')).toEqual([])
  })

  it('坏流水名、坏字段、单条超限都响亮拒', async () => {
    const a = open({ limits: { maxRecordBytes: 300 } })
    await expectCode(a.appendRecord({ stream: 'health.bmi', fields: {}, source: { kind: 'user' } }), 'life_not_found', 'health.weight')
    await expectCode(a.appendRecord({ stream: 'health.weight', fields: { kg: 'x' }, source: { kind: 'user' } }), 'life_invalid')
    await expectCode(
      a.appendRecord({ stream: 'health.condition', fields: { kind: '其他', detail: '很'.repeat(150) }, source: { kind: 'user' } }),
      'life_limit',
      '300',
    )
    expect(existsSync(join(dir, 'health', 'condition.jsonl'))).toBe(false)
  })

  it('并发追加串行:两个句柄同时写,id 不撞', async () => {
    const a = open()
    const b = open()
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? a : b).appendRecord({ stream: 'mind.mood', fields: { mood: (i % 10) + 1 }, source: { kind: 'user' } }),
      ),
    )
    const ids = (await a.readRecords('mind.mood')).map((r) => r.id)
    expect(new Set(ids).size).toBe(12)
  })

  it('同一天先记带时刻的、后记不带时刻的:当前状态取后记的那条', async () => {
    const a = open()
    await a.appendRecord({ stream: 'career.commitment', at: '2026-10-20 08:00', fields: { what: '交方案', due: '2026-10-25', status: '待办' }, source: { kind: 'user' } })
    await a.appendRecord({ stream: 'career.commitment', fields: { what: '交方案', due: '2026-10-25', status: '完成' }, source: { kind: 'user' } })
    const snap = await a.snapshot('career')
    expect(snap.activeByStream.get('commitment')!.map((r) => r.fields.status)).toEqual(['完成'])
    // 往日补记不编时刻
    const { record } = await a.appendRecord({ stream: 'health.weight', at: '2026-10-18', fields: { kg: 71 }, source: { kind: 'user' } })
    expect(record.at).toBe('2026-10-18')
  })

  it('末尾半行(崩溃留下)不吞新记录;删行后 id 不回退撞号', async () => {
    const a = open()
    for (const kg of [70, 71, 72]) await a.appendRecord({ stream: 'health.weight', fields: { kg }, source: { kind: 'user' } })
    const file = join(dir, 'health', 'weight.jsonl')
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    // 只留第三行 + 一段没写完的半行
    writeFileSync(file, `${lines[2]}\n{"id":"weight-9","at":"2026`)
    const { record } = await a.appendRecord({ stream: 'health.weight', fields: { kg: 73 }, source: { kind: 'user' } })
    expect(record.id).toBe('weight-4')
    const rows = await a.readRecords('health.weight')
    expect(rows.map((r) => r.id)).toEqual(['weight-3', 'weight-4'])
  })

  it('档案能解析但形状不对:隔离,不当空档案覆盖', async () => {
    const a = open()
    mkdirSync(join(dir, 'health'), { recursive: true })
    writeFileSync(join(dir, 'health', 'dossier.json'), JSON.stringify({ version: 2, goals: 'x' }))
    expect((await a.readDossier('health')).revision).toBe(0)
    expect(readdirSync(join(dir, 'health')).some((f) => f.startsWith('dossier.json.corrupt-'))).toBe(true)
  })

  it('多币种:分组不相加;卡上默认币种之外的收支各列一行', async () => {
    const a = open()
    await a.appendRecord({ stream: 'finance.tx', fields: { amount: 100, direction: '支出', category: '餐饮' }, source: { kind: 'user' } })
    await a.appendRecord({ stream: 'finance.tx', fields: { amount: 50, direction: '支出', category: '餐饮', currency: 'MYR' }, source: { kind: 'user' } })
    const snap = await a.snapshot('finance')
    expect(snap.statusLines.some((l) => l.startsWith('本月支出:100'))).toBe(true)
    expect(snap.statusLines.some((l) => l.startsWith('本月支出(MYR):50'))).toBe(true)
    const res = queryLifeRecords(snap.activeByStream.get('tx')!, findLifeStream('finance.tx')!.stream, {
      agg: 'sum', to: '2026-10-20', groupBy: 'category',
    })
    expect(res.groups!.map((g) => [g.key, g.value])).toEqual([['餐饮·CNY', 100], ['餐饮·MYR', 50]])
  })

  it('坏行跳过不炸', async () => {
    const a = open()
    await a.appendRecord({ stream: 'health.sleep', fields: { hours: 7 }, source: { kind: 'user' } })
    writeFileSync(join(dir, 'health', 'sleep.jsonl'), `${readFileSync(join(dir, 'health', 'sleep.jsonl'), 'utf8')}{坏行\n`)
    await a.appendRecord({ stream: 'health.sleep', fields: { hours: 6.5 }, source: { kind: 'user' } })
    const rows = await a.readRecords('health.sleep')
    expect(rows.map((r) => r.fields.hours)).toEqual([7, 6.5])
    expect(new Set(rows.map((r) => r.id)).size).toBe(2)
  })
})

describe('档案', () => {
  it('版本号:旧版本写不进;上限响亮拒;维护记录有顶', async () => {
    const a = open({ limits: { maxInsights: 2, logEntries: 3 } })
    const d1 = await a.updateDossier('health', 0, (d, nextId) => ({
      dossier: { ...d, insights: [...d.insights, { id: nextId('i'), text: 'A', evidence: '10-01~10-20', confidence: '中', at: '2026-10-20' }] },
      log: 'add A',
    }))
    expect(d1.revision).toBe(1)
    expect(d1.insights[0]!.id).toBe('i1')
    await expectCode(a.updateDossier('health', 0, (d) => ({ dossier: d, log: 'stale' })), 'life_conflict', '版本 1')
    const add = (rev: number, t: string) =>
      a.updateDossier('health', rev, (d, nextId) => ({
        dossier: { ...d, insights: [...d.insights, { id: nextId('i'), text: t, evidence: '-', confidence: '低', at: '2026-10-20' }] },
        log: `add ${t}`,
      }))
    await add(1, 'B')
    await expectCode(add(2, 'C'), 'life_limit', '洞察最多 2 条')
    for (let i = 0; i < 4; i++) {
      const cur = await a.readDossier('health')
      await a.updateDossier('health', cur.revision, (d) => ({ dossier: d, log: `noop ${i}` }))
    }
    expect((await a.readDossier('health')).log).toHaveLength(3)
  })

  it('坏档案文件隔离后按空档案继续', async () => {
    mkdirSync(join(dir, 'finance'), { recursive: true })
    writeFileSync(join(dir, 'finance', 'dossier.json'), '{not json')
    const a = open()
    const d = await a.readDossier('finance')
    expect(d.revision).toBe(0)
    expect(readdirSync(join(dir, 'finance')).some((f) => f.startsWith('dossier.json.corrupt-'))).toBe(true)
  })
})

describe('派生状态与渲染', () => {
  it('state.json 内容不变就不重写', async () => {
    const a = open()
    await a.ensureRegistry()
    await a.appendRecord({ stream: 'health.weight', fields: { kg: 72 }, source: { kind: 'user' } })
    const file = join(dir, 'state.json')
    const m1 = statSync(file).mtimeMs
    await new Promise((r) => setTimeout(r, 15))
    await a.recomputeState()
    expect(statSync(file).mtimeMs).toBe(m1)
  })

  it('驾驶舱卡:无登记表 → null;同状态同字节;有顶;签到当天才提示', async () => {
    const a = open()
    expect(renderLifeCockpit(await a.readRegistry(), await a.readState())).toBeNull()
    const reg = await a.ensureRegistry()
    await a.appendRecord({ stream: 'health.weight', fields: { kg: 72 }, source: { kind: 'user' } })
    const state = await a.recomputeState()
    const c1 = renderLifeCockpit(reg, state)!
    const c2 = renderLifeCockpit(reg, await a.readState())!
    expect(c1).toBe(c2)
    expect(c1.startsWith(LIFE_COCKPIT_MARKER)).toBe(true)
    expect(c1).toContain('最近记录 10-20')
    expect(c1).not.toMatch(/天前|刚刚/)
    expect(Buffer.byteLength(c1, 'utf8')).toBeLessThanOrEqual(LIFE_COCKPIT_MAX_BYTES)
    expect(c1).not.toContain('心境签到;')
    const withCheckin = renderLifeCockpit(reg, state, { lastSentDate: '2026-10-20', lastSentTime: '21:00' })!
    expect(withCheckin).toContain('今天 21:00已发出心境签到')
    expect(renderLifeCockpit(reg, state, { lastSentDate: '2026-10-19', lastSentTime: '21:00' })).toBe(c1)
  })

  it('驾驶舱卡提醒过多时收缩并明说', async () => {
    const a = open()
    const reg = await a.ensureRegistry()
    const state = await a.recomputeState()
    const many = {
      ...state,
      domains: {
        ...state.domains,
        finance: { records: 1, openItems: 0, alerts: Array.from({ length: 60 }, (_, i) => ({ id: `x${i}`, domain: 'finance', text: `固定支出「订阅服务第 ${i} 项」将于 10-2${i % 10} 扣款`, push: true })) },
      },
    }
    const card = renderLifeCockpit(reg, many)!
    expect(Buffer.byteLength(card, 'utf8')).toBeLessThanOrEqual(LIFE_COCKPIT_MAX_BYTES)
    expect(card).toMatch(/另有 \d+ 条提醒/)
  })

  it('档案卡:洞察过多先收缩洞察并明说,规程始终在', async () => {
    const a = open({ limits: { maxInsights: 50 } })
    await a.updateDossier('decisions', 0, (d, nextId) => ({
      dossier: {
        ...d,
        insights: Array.from({ length: 40 }, () => ({
          id: nextId('i'),
          text: '这是一条比较长的洞察,用来把档案卡撑过字节上限,看看收缩是否明说而不是静默截断。'.repeat(2),
          evidence: '2026-09-01~2026-10-20',
          confidence: '中' as const,
          at: '2026-10-20',
        })),
      },
      log: 'bulk',
    }))
    const card = renderLifeDossierCard(await a.snapshot('decisions'))
    expect(Buffer.byteLength(card, 'utf8')).toBeLessThanOrEqual(LIFE_DOSSIER_CARD_MAX_BYTES)
    expect(card).toMatch(/洞察只显示前 \d+\/40 条/)
    expect(card).toContain('规程:')
    expect(card).toContain('版本 r1')
  })

  it('档案卡目标进度:水平型说还差多少,累计型给比例', async () => {
    const a = open()
    await a.appendRecord({ stream: 'health.weight', fields: { kg: 71.3 }, source: { kind: 'user' } })
    await a.updateDossier('health', 0, (d, nextId) => ({
      dossier: {
        ...d,
        goals: [
          { id: nextId('g'), text: '体重降到 65kg', metric: { stream: 'health.weight', agg: 'latest', op: '<=', target: 65 }, confirmedAt: '2026-10-20', quote: 'q' },
        ],
      },
      log: 'g',
    }))
    const card = renderLifeDossierCard(await a.snapshot('health'))
    expect(card).toContain('当前 71.3,距目标还差 6.3')
    expect(card).not.toMatch(/71\.3\(\d+%\)/)

    await a.appendRecord({ stream: 'finance.tx', fields: { amount: 800, direction: '支出', category: '餐饮' }, source: { kind: 'user' } })
    await a.updateDossier('finance', 0, (d, nextId) => ({
      dossier: {
        ...d,
        goals: [
          { id: nextId('g'), text: '本月餐饮不超过 1000', metric: { stream: 'finance.tx', agg: 'month_sum', where: { direction: '支出', category: '餐饮' }, op: '<=', target: 1000 }, confirmedAt: '2026-10-20', quote: 'q' },
        ],
      },
      log: 'g',
    }))
    expect(renderLifeDossierCard(await a.snapshot('finance'))).toContain('当前 800,已达成(80%)')
  })

  it('派生 md 只能写进 views/ 或 reviews/', async () => {
    const a = open()
    await a.writeDerived('views/健康.md', '# x\n')
    expect(await a.readDerived('views/健康.md')).toBe('# x\n')
    await expectCode(a.writeDerived('../escape.md', 'x'), 'life_invalid')
    await expectCode(a.writeDerived('health/weight.jsonl', 'x'), 'life_invalid')
  })
})
