/**
 * life-toolset.test.ts — LIFE 工具面。
 *
 * 承重点:
 *   - 目标/规程只认成员原话:user_quote 必须整句等于当轮消息(只摘一段的拒),否则只能
 *     提议;没有原话的轮次(心跳、长任务分段)也只能提议;本轮刚提的提议本轮不能确认。
 *   - 读取预算:同一内容(按哈希)重复读不再扣、不再给;写入后重查拿到新数;额度用完响亮拒。
 *   - 一等工具描述不点名目录工具(防腐门的结构断言)。
 *   - 拒绝一律以文本回给模型,绝不炸轮。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryReadBudget } from '@gotong/personal-memory'
import type { LlmAgentToolset, LlmToolCallResult } from '@gotong/llm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openLifeArchive, type LifeArchive } from '../src/life-store.js'
import { LONGRUN_SEGMENT_PAYLOAD_KEY } from '../src/longrun-dossier.js'
import { createLifeToolsets, lifeTurnText } from '../src/life-toolset.js'

let parent: string
let archive: LifeArchive
let turns: Map<string, string>
let core: LlmAgentToolset
let arch: LlmAgentToolset
const NOW = Date.UTC(2026, 9, 20, 2, 0) // MYT 10-20 10:00

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'gotong-life-tools-'))
  archive = openLifeArchive({ dir: join(parent, 'life'), timeZone: 'Asia/Kuala_Lumpur', now: () => NOW })
  turns = new Map()
  const sets = createLifeToolsets({
    archive,
    budget: new MemoryReadBudget(9000, 3600),
    turnText: (task) => turns.get(task.id),
  })
  core = sets.core
  arch = sets.archive
})

afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

const out = (r: LlmToolCallResult) => (r.content[0] as { text: string }).text

/** 在一个任务作用域里跑(两个 toolset 都套上,与 ComposedToolset 的嵌套一致)。 */
function inTask<T>(id: string, said: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (said !== undefined) turns.set(id, said)
  return core.runForTask!({ id, from: 'u' }, () => arch.runForTask!({ id, from: 'u' }, fn))
}

const call = (ts: LlmAgentToolset, name: string, args: Record<string, unknown>) => ts.callTool(name, args)

describe('工具面形状', () => {
  it('一等四件、目录一件;一等描述不点名目录工具', () => {
    expect(core.listTools().map((t) => t.name)).toEqual(['open_dossier', 'log_record', 'query_records', 'update_dossier'])
    expect(arch.listTools().map((t) => t.name)).toEqual(['read_records'])
    const blob = JSON.stringify(core.listTools())
    expect(blob).not.toContain('read_records')
  })
})

describe('当轮原话的来源', () => {
  it('与 remember 证据门同源;心跳与长任务段不算成员原话', () => {
    expect(lifeTurnText({ id: 't', from: 'u', payload: '就按每月 2000 来' })).toBe('就按每月 2000 来')
    expect(lifeTurnText({ id: 't', from: 'u', payload: { prompt: '好' } })).toBe('好')
    expect(lifeTurnText({ id: 't', from: 'u', payload: { heartbeat: true, prompt: '巡检' } })).toBeUndefined()
    expect(
      lifeTurnText({ id: 't', from: 'u', payload: { prompt: '接力提示', [LONGRUN_SEGMENT_PAYLOAD_KEY]: 'lr-20261020-abcdef' } }),
    ).toBeUndefined()
    expect(lifeTurnText({ id: 't', from: 'u' })).toBeUndefined()
  })
})

describe('记录与查询', () => {
  it('记一条体重:回执带 id 与代码算的现状;源头附上成员原话片段', async () => {
    await inTask('t1', '今早称了一下 72.4 公斤,空腹', async () => {
      const r = await call(core, 'log_record', { stream: 'health.weight', fields: { kg: 72.4, condition: '晨起空腹' } })
      expect(r.isError).toBeUndefined()
      expect(out(r)).toContain('id weight-1')
      expect(out(r)).toContain('72.4')
    })
    const rows = await archive.readRecords('health.weight')
    expect(rows[0]!.source).toEqual({ kind: 'user', excerpt: '今早称了一下 72.4 公斤,空腹' })
  })

  it('没有成员原话的轮次(心跳、长任务分段)记下的值标为推断', async () => {
    await inTask('hb', undefined, () => call(core, 'log_record', { stream: 'health.weight', fields: { kg: 72 } }))
    expect((await archive.readRecords('health.weight'))[0]!.source.kind).toBe('inferred')
  })

  it('坏输入以文本拒,带正确写法,不炸轮', async () => {
    await inTask('t1', 'x', async () => {
      const r = await call(core, 'log_record', { stream: 'health.weight', fields: { kg: 720 } })
      expect(r.isError).toBe(true)
      expect(out(r)).toContain('不能大于 300')
      const q = await call(core, 'query_records', { stream: 'finance.tx', agg: 'median' })
      expect(q.isError).toBe(true)
    })
  })

  it('query_records:本月餐饮支出由代码求和', async () => {
    await inTask('t1', 'x', async () => {
      for (const [d, amt] of [['2026-10-02', 30], ['2026-10-09', 45.5], ['2026-09-28', 99]] as const) {
        await call(core, 'log_record', { stream: 'finance.tx', fields: { amount: amt, direction: '支出', category: '餐饮' }, at: d })
      }
      const r = await call(core, 'query_records', { stream: 'finance.tx', agg: 'sum', period: 'this_month', where: { direction: '支出', category: '餐饮' } })
      expect(out(r)).toContain('结果:75.5')
      expect(out(r)).toContain('2026-10-01~2026-10-20')
    })
  })

  it('read_records 分页给出 id(含被取代的历史行)', async () => {
    await inTask('t1', 'x', async () => {
      await call(core, 'log_record', { stream: 'health.weight', fields: { kg: 27.2 } })
      await call(core, 'log_record', { stream: 'health.weight', fields: { kg: 72.2 }, supersedes: 'weight-1' })
      const r = await call(arch, 'read_records', { stream: 'health.weight' })
      expect(out(r)).toContain('weight-1')
      expect(out(r)).toContain('取代 weight-1')
    })
  })
})

describe('读取预算', () => {
  it('同一档案卡重复打开不再给;额度用完响亮拒;新任务额度重置', async () => {
    // 空档案卡约 1–1.4KB,五本全开也在 9000 以内;这里换一份小额度把「用完」逼出来。
    const sets = createLifeToolsets({ archive, budget: new MemoryReadBudget(3000, 3600), turnText: (task) => turns.get(task.id) })
    core = sets.core
    arch = sets.archive
    await inTask('t1', 'x', async () => {
      const a = await call(core, 'open_dossier', { domain: 'health' })
      expect(out(a)).toContain('【健康】')
      const again = await call(core, 'open_dossier', { domain: 'health' })
      expect(out(again)).toContain('已经返回过')
      const opened: LlmToolCallResult[] = []
      for (const d of ['mind', 'finance', 'career', 'decisions']) opened.push(await call(core, 'open_dossier', { domain: d }))
      expect(opened.some((r) => r.isError && out(r).includes('读取额度已用完'))).toBe(true)
      // 写入回执不扣预算:额度用完后仍能记
      const w = await call(core, 'log_record', { stream: 'mind.mood', fields: { mood: 6 } })
      expect(w.isError).toBeUndefined()
    })
    await inTask('t2', 'x', async () => {
      const a = await call(core, 'open_dossier', { domain: 'decisions' })
      expect(a.isError).toBeUndefined()
    })
  })
})

describe('读取预算按内容去重', () => {
  it('写入后同一查询拿到新数,不会被当成「已经返回过」', async () => {
    await inTask('t1', '72.4', async () => {
      await call(core, 'log_record', { stream: 'health.weight', fields: { kg: 72.4 } })
      const a = await call(core, 'query_records', { stream: 'health.weight', agg: 'latest' })
      expect(out(a)).toContain('kg=72.4')
      await call(core, 'log_record', { stream: 'health.weight', fields: { kg: 72.1 } })
      const b = await call(core, 'query_records', { stream: 'health.weight', agg: 'latest' })
      expect(out(b)).toContain('kg=72.1')
      const c = await call(core, 'query_records', { stream: 'health.weight', agg: 'latest' })
      expect(out(c)).toContain('已经返回过')
    })
  })
})

describe('目标与规程只认成员原话', () => {
  const metric = { stream: 'finance.tx', agg: 'month_sum', where: { direction: '支出', category: '餐饮' }, op: '<=', target: 2000 }

  it('没有原话证据 → 拒;只能提议', async () => {
    await inTask('t1', '最近吃饭花得有点多', async () => {
      const bad = await call(core, 'update_dossier', {
        domain: 'finance', revision: 0, section: 'goals', op: 'set', text: '餐饮每月不超过 2000', metric, user_quote: '餐饮每月不超过2000',
      })
      expect(bad.isError).toBe(true)
      expect(out(bad)).toContain('完整原话')
      const p = await call(core, 'update_dossier', { domain: 'finance', revision: 0, section: 'goals', op: 'propose', text: '餐饮每月不超过 2000', metric })
      expect(p.isError).toBeUndefined()
      expect(out(p)).toContain('提议新目标 p1')
    })
    const d = await archive.readDossier('finance')
    expect(d.goals).toEqual([])
    expect(d.proposals.map((x) => x.id)).toEqual(['p1'])
  })

  it('成员原话确认提议 → 生效为目标,并记下原话;进度由代码算', async () => {
    await inTask('t1', '最近吃饭花得有点多', () =>
      call(core, 'update_dossier', { domain: 'finance', revision: 0, section: 'goals', op: 'propose', text: '餐饮每月不超过 2000', metric }),
    )
    await inTask('t2', '可以，就按每月餐饮 2000 来', async () => {
      // 只摘一段不行
      const part = await call(core, 'update_dossier', { domain: 'finance', revision: 1, section: 'proposals', op: 'confirm', id: 'p1', user_quote: '可以' })
      expect(part.isError).toBe(true)
      const r = await call(core, 'update_dossier', { domain: 'finance', revision: 1, section: 'proposals', op: 'confirm', id: 'p1', user_quote: '可以，就按每月餐饮 2000 来' })
      expect(r.isError).toBeUndefined()
      await call(core, 'log_record', { stream: 'finance.tx', fields: { amount: 1700, direction: '支出', category: '餐饮' } })
      const card = out(await call(core, 'open_dossier', { domain: 'finance' }))
      expect(card).toMatch(/餐饮每月不超过 2000——当前 1700,已达成\(85%\)/)
    })
    const d = await archive.readDossier('finance')
    expect(d.proposals).toEqual([])
    expect(d.goals[0]!.quote).toBe('可以，就按每月餐饮 2000 来')
    // 没写币种的金额目标按默认币种算
    expect(d.goals[0]!.metric?.where).toEqual({ direction: '支出', category: '餐饮', currency: 'CNY' })
  })

  it('碎片原话配不上目标:「今天」不能把任意目标设进去', async () => {
    await inTask('t1', '我今天称了体重', async () => {
      const r = await call(core, 'update_dossier', {
        domain: 'health', revision: 0, section: 'goals', op: 'set', text: '每天跑 10 公里', user_quote: '今天',
      })
      expect(r.isError).toBe(true)
    })
    expect((await archive.readDossier('health')).goals).toEqual([])
  })

  it('本轮刚提的提议本轮不能确认,下一轮可以', async () => {
    await inTask('t1', '好的', async () => {
      await call(core, 'update_dossier', { domain: 'health', revision: 0, section: 'protocol', op: 'propose', text: '体重只记晨起空腹' })
      const r = await call(core, 'update_dossier', { domain: 'health', revision: 1, section: 'proposals', op: 'confirm', id: 'p1', user_quote: '好的' })
      expect(r.isError).toBe(true)
      expect(out(r)).toContain('这一轮刚提的')
    })
    // 审批挂起再恢复是同一任务的新作用域:提议记在盘上,照样认得出
    await inTask('t1', '好的', async () => {
      const r = await call(core, 'update_dossier', { domain: 'health', revision: 1, section: 'proposals', op: 'confirm', id: 'p1', user_quote: '好的' })
      expect(out(r)).toContain('这一轮刚提的')
    })
    await inTask('t2', '好的', async () => {
      const r = await call(core, 'update_dossier', { domain: 'health', revision: 1, section: 'proposals', op: 'confirm', id: 'p1', user_quote: '好的' })
      expect(r.isError).toBeUndefined()
    })
    expect((await archive.readDossier('health')).protocolAdditions.map((a) => a.text)).toEqual(['体重只记晨起空腹'])
  })

  it('拿不到当轮原话(审批恢复)→ 直接设定也拒', async () => {
    await inTask('t1', undefined, async () => {
      const r = await call(core, 'update_dossier', {
        domain: 'health', revision: 0, section: 'protocol', op: 'set', text: '体重只记晨起空腹', user_quote: '体重只记晨起空腹',
      })
      expect(r.isError).toBe(true)
      expect(out(r)).toContain('没有成员原话')
    })
  })

  it('整句原话(忽略空白)即可直接设定条款;撤回提议不需要原话', async () => {
    await inTask('t1', '以后体重只记 晨起空腹 的', async () => {
      const r = await call(core, 'update_dossier', {
        domain: 'health', revision: 0, section: 'protocol', op: 'set', text: '体重只记晨起空腹', user_quote: '以后体重只记晨起空腹的',
      })
      expect(r.isError).toBeUndefined()
      await call(core, 'update_dossier', { domain: 'health', revision: 1, section: 'protocol', op: 'propose', text: '睡眠记入睡时间' })
      const rej = await call(core, 'update_dossier', { domain: 'health', revision: 2, section: 'proposals', op: 'reject', id: 'p2' })
      expect(rej.isError).toBeUndefined()
    })
    const d = await archive.readDossier('health')
    expect(d.protocolAdditions.map((a) => a.text)).toEqual(['体重只记晨起空腹'])
    expect(d.proposals).toEqual([])
  })
})

describe('档案分区更新', () => {
  it('旧版本号写不进;洞察必须带证据;未知 section/op 组合拒', async () => {
    await inTask('t1', 'x', async () => {
      const ok = await call(core, 'update_dossier', { domain: 'mind', revision: 0, section: 'insights', op: 'add', text: '周一压力偏高', evidence: '09-01~10-20', confidence: '中' })
      expect(out(ok)).toContain('版本 r1')
      const stale = await call(core, 'update_dossier', { domain: 'mind', revision: 0, section: 'status_note', op: 'set', text: '平稳' })
      expect(stale.isError).toBe(true)
      expect(out(stale)).toContain('先 open_dossier')
      const noEv = await call(core, 'update_dossier', { domain: 'mind', revision: 1, section: 'insights', op: 'add', text: '没有证据的洞察' })
      expect(noEv.isError).toBe(true)
      const weird = await call(core, 'update_dossier', { domain: 'mind', revision: 1, section: 'insights', op: 'confirm', id: 'i1' })
      expect(weird.isError).toBe(true)
      expect(out(weird)).toContain('不支持')
    })
  })

  it('写入后刷新给人看的 md 视图', async () => {
    await inTask('t1', 'x', () => call(core, 'log_record', { stream: 'health.sleep', fields: { hours: 7.5 } }))
    await new Promise((r) => setTimeout(r, 30))
    const md = readFileSync(join(parent, 'life', 'views', '健康.md'), 'utf8')
    expect(md).toContain('generated: true')
    expect(md).toContain('7.5')
  })
})
