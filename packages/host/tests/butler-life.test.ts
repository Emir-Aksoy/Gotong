/**
 * butler-life.test.ts — LIFE 宿主侧:驾驶舱卡、稳定段拼卡、后台扫描(零模型)。
 *
 * 承重点:没有登记表就什么都不做(提示词字节不变、不推送);签到只在 21 点窗口、
 * 当天只问一次、已经记过就不问;推送型提醒按稳定 id 只推一次;周一推周回顾并
 * 落 reviews/,同一周不重复;驾驶舱卡能看到「今天已发签到」。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openLifeArchive, type LifeArchive } from '@gotong/personal-butler'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ButlerLifeSweeper,
  LIFE_CHECKIN_TEXT,
  buildButlerLifeCockpitCard,
  composeStableCards,
} from '../src/butler-life.js'

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
const TZ = 'Asia/Kuala_Lumpur'
const at = (iso: string) => Date.parse(`${iso}+08:00`)

let root: string
let clock: number
let sent: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gotong-life-host-'))
  sent = []
  pushResult = { delivered: true }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const archiveFor = (userId = 'u1'): LifeArchive =>
  openLifeArchive({ dir: join(root, 'user', userId, 'life'), timeZone: TZ, now: () => clock })

let pushResult: { delivered: boolean; reason?: string }
const sweeper = (extra: Partial<ConstructorParameters<typeof ButlerLifeSweeper>[0]> = {}) =>
  new ButlerLifeSweeper({
    memoryRoot: root,
    logger: log,
    timeZone: TZ,
    now: () => clock,
    ...extra,
    push: async (_u, text) => {
      sent.push(text)
      return pushResult
    },
  })

describe('驾驶舱卡与拼卡', () => {
  it('没有登记表 → null;有了才出现;拼卡跳过 null、单张失败不拖累', async () => {
    clock = at('2026-10-20T10:00:00')
    const a = archiveFor()
    const card = buildButlerLifeCockpitCard({ archive: a })
    expect(await card()).toBeNull()
    await a.ensureRegistry()
    expect(await card()).toContain('【生活档案】')

    const idx = async () => '【知识库索引】x'
    const bad = async (): Promise<string | null> => {
      throw new Error('boom')
    }
    expect(await composeStableCards(idx, bad, card)()).toMatch(/^【知识库索引】x\n\n<!-- gotong:life-cockpit -->/)
    expect(await composeStableCards(async () => null, async () => null)()).toBeNull()
  })

  it('日期翻过去后卡上的「截至」随之更新', async () => {
    clock = at('2026-10-20T10:00:00')
    const a = archiveFor()
    await a.ensureRegistry()
    await a.recomputeState()
    clock = at('2026-10-21T08:00:00')
    expect(await buildButlerLifeCockpitCard({ archive: archiveFor() })()).toContain('截至 10-21')
  })
})

describe('扫描器', () => {
  it('没有登记表:什么都不做', async () => {
    clock = at('2026-10-20T21:10:00')
    await archiveFor().appendRecord({ stream: 'health.weight', fields: { kg: 70 }, source: { kind: 'user' } })
    await sweeper().runOnce()
    expect(sent).toEqual([])
  })

  it('21 点签到:当天只问一次;驾驶舱卡记下签到时刻', async () => {
    clock = at('2026-10-20T21:10:00')
    const a = archiveFor()
    await a.ensureRegistry()
    const s = sweeper()
    await s.runOnce()
    expect(sent).toEqual([LIFE_CHECKIN_TEXT])
    await s.runOnce()
    expect(sent).toHaveLength(1)
    expect(await buildButlerLifeCockpitCard({ archive: a })()).toContain('今天 21:10已发出心境签到')
    // 第二天卡上不再提
    clock = at('2026-10-21T10:00:00')
    expect(await buildButlerLifeCockpitCard({ archive: archiveFor() })()).not.toContain('已发出心境签到')
  })

  it('签到被闸丢弃(当日上限)不记已发,窗口内下一轮再试;投递失败交出不重推,但卡上不说已发出', async () => {
    clock = at('2026-10-20T21:05:00')
    const a = archiveFor()
    await a.ensureRegistry()
    const s = sweeper()
    pushResult = { delivered: false, reason: 'dropped_cap' }
    await s.runOnce()
    expect(await buildButlerLifeCockpitCard({ archive: a })()).not.toContain('已发出心境签到')
    pushResult = { delivered: false, reason: 'send_failed' } // outbox 已接手
    clock = at('2026-10-20T21:20:00')
    await s.runOnce()
    clock = at('2026-10-20T21:35:00')
    await s.runOnce()
    expect(sent).toEqual([LIFE_CHECKIN_TEXT, LIFE_CHECKIN_TEXT])
    // 成员没看到的签到:不能让阿同把之后的话当成回答
    expect(await buildButlerLifeCockpitCard({ archive: a })()).not.toContain('已发出心境签到')
  })

  it('签到窗口按成员本地钟判(生产传免打扰闸的钟),与档案时区无关', async () => {
    // 服务器在 UTC:按档案钟此刻 13:05,不在窗口;成员本地(+8)是 21:05,该问
    clock = at('2026-10-20T21:05:00')
    const a = openLifeArchive({ dir: join(root, 'user', 'u1', 'life'), timeZone: 'UTC', now: () => clock })
    await a.ensureRegistry()
    await sweeper({ timeZone: 'UTC' }).runOnce()
    expect(sent).toEqual([])
    const plus8 = (ms: number) => {
      const d = new Date(ms + 8 * 3_600_000)
      return { hour: d.getUTCHours(), time: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` }
    }
    await sweeper({ timeZone: 'UTC', memberClock: plus8 }).runOnce()
    expect(sent).toEqual([LIFE_CHECKIN_TEXT])
    expect(await buildButlerLifeCockpitCard({ archive: a })()).toContain('今天 21:05已发出心境签到')
  })

  it('今天已记过心境就不问;过了窗口(22 点)不补', async () => {
    clock = at('2026-10-20T20:00:00')
    const a = archiveFor()
    await a.ensureRegistry()
    await a.appendRecord({ stream: 'mind.mood', fields: { mood: 7 }, source: { kind: 'user' } })
    clock = at('2026-10-20T21:20:00')
    await sweeper().runOnce()
    expect(sent).toEqual([])

    clock = at('2026-10-21T22:15:00')
    await sweeper().runOnce()
    expect(sent).toEqual([])
  })

  it('推送型提醒按 id 只推一次;非推送型不推', async () => {
    clock = at('2026-10-18T12:00:00')
    const a = archiveFor()
    await a.ensureRegistry()
    for (const d of ['2026-10-16', '2026-10-17', '2026-10-18']) {
      await a.appendRecord({ stream: 'mind.mood', fields: { mood: 3 }, at: d, source: { kind: 'user' } })
    }
    await a.appendRecord({ stream: 'health.workout', fields: { type: '跑步', minutes: 30 }, at: '2026-10-10', source: { kind: 'user' } })
    const s = sweeper()
    await s.runOnce()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('【心境与精力】')
    expect(sent[0]).not.toContain('训练') // health-no-workout 是非推送型
    await s.runOnce()
    expect(sent).toHaveLength(1)
  })

  it('提醒投递失败也记为已交出(outbox 会重投),不每 15 分钟重推', async () => {
    clock = at('2026-10-18T12:00:00')
    const a = archiveFor()
    await a.ensureRegistry()
    for (const d of ['2026-10-16', '2026-10-17', '2026-10-18']) {
      await a.appendRecord({ stream: 'mind.mood', fields: { mood: 3 }, at: d, source: { kind: 'user' } })
    }
    pushResult = { delivered: false, reason: 'unknown_member' }
    const s = sweeper()
    await s.runOnce()
    clock = at('2026-10-18T12:15:00')
    await s.runOnce()
    expect(sent).toHaveLength(1)
  })

  it('周一推上周回顾,落 reviews/;同一周不重复;上周没记录就不发', async () => {
    clock = at('2026-10-14T12:00:00')
    const a = archiveFor()
    await a.ensureRegistry()
    await a.appendRecord({ stream: 'health.weight', fields: { kg: 72 }, source: { kind: 'user' } })
    await a.appendRecord({ stream: 'finance.tx', fields: { amount: 30, direction: '支出', category: '餐饮' }, source: { kind: 'user' } })
    clock = at('2026-10-19T09:30:00') // 周一
    const s = sweeper()
    await s.runOnce()
    const review = sent.find((t) => t.includes('生活档案小结'))
    expect(review).toBeDefined()
    expect(review).toContain('10-12 ~ 10-18')
    expect(review).toContain('健康:本周记了 1 条')
    expect(existsSync(join(root, 'user', 'u1', 'life', 'reviews', '2026-W42.md'))).toBe(true)
    expect(readFileSync(join(root, 'user', 'u1', 'life', 'reviews', '2026-W42.md'), 'utf8')).toContain('数字由代码计算')
    const n = sent.length
    await s.runOnce()
    expect(sent.length).toBe(n)

    // 下一周一,上周一条都没有 ⇒ 不发
    clock = at('2026-10-26T10:00:00')
    await sweeper().runOnce()
    expect(sent.filter((t) => t.includes('生活档案小结'))).toHaveLength(1)
  })
})
