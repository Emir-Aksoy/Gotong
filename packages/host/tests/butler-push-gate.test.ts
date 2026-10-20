/**
 * butler-push-gate.test.ts — LIFE 主动推送的免打扰闸与每日上限。
 *
 * 承重点:夜里不发但也不丢(暂存、报「已接收」以免扫描器每 tick 重试堆重复);
 * 早上 7 点后合成一条发出;每日上限超了推到次日;底层失败交给 outbox,本闸不重交
 * (重交会让 outbox 多一份);过时即无意义的消息可以要求「发不了就丢」;重启后暂存还在。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ButlerPushGate, inQuietHours, mergeDeferred, nextMorningMs } from '../src/butler-push-gate.js'

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
// 本地(+08)时刻 → epoch
const at = (iso: string) => Date.parse(`${iso}+08:00`)

let dir: string
let clock: number
let sent: Array<{ userId: string; text: string }>
let result: { delivered: boolean; reason?: string }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gotong-push-gate-'))
  sent = []
  result = { delivered: true }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const gate = (cap?: number) =>
  new ButlerPushGate({
    dir,
    logger: log,
    now: () => clock,
    ...(cap !== undefined ? { dailyCap: cap } : {}),
    push: async (userId, text) => {
      sent.push({ userId, text })
      return result
    },
  })


describe('时刻计算', () => {
  it('22:00–07:00 是免打扰;下一个 07:00 正确跨日', () => {
    expect(inQuietHours(21)).toBe(false)
    expect(inQuietHours(22)).toBe(true)
    expect(inQuietHours(3)).toBe(true)
    expect(inQuietHours(7)).toBe(false)
    expect(nextMorningMs(at('2026-10-20T23:10:00'), 480)).toBe(at('2026-10-21T07:00:00'))
    expect(nextMorningMs(at('2026-10-21T02:00:00'), 480)).toBe(at('2026-10-21T07:00:00'))
    expect(nextMorningMs(at('2026-10-21T15:00:00'), 480, true)).toBe(at('2026-10-22T07:00:00'))
  })
})

describe('免打扰', () => {
  it('白天直发;夜里暂存并报已接收;早上合成一条发出', async () => {
    const g = gate()
    clock = at('2026-10-20T15:00:00')
    expect(await g.push('u1', '白天的提醒')).toEqual({ delivered: true })
    expect(sent).toHaveLength(1)

    clock = at('2026-10-20T23:30:00')
    expect(await g.push('u1', '巡检黄牌')).toEqual({ delivered: true, reason: 'deferred_quiet' })
    clock = at('2026-10-21T02:00:00')
    await g.push('u1', '预算到 80%')
    expect(sent).toHaveLength(1)
    expect(await g.pending('u1')).toBe(2)

    clock = at('2026-10-21T05:00:00')
    await g.flushDue()
    expect(sent).toHaveLength(1) // 还在免打扰

    clock = at('2026-10-21T07:05:00')
    await new ButlerPushGate({ dir, logger: log, now: () => clock, push: async (u, t) => (sent.push({ userId: u, text: t }), result) }).flushDue() // 重启后的新实例照样读得到
    expect(sent).toHaveLength(2)
    expect(sent[1]!.text).toContain('免打扰期间暂存的 2 条消息')
    expect(sent[1]!.text).toContain('巡检黄牌')
    expect(sent[1]!.text).toContain('预算到 80%')
    expect(await g.pending('u1')).toBe(0)
  })

  it('只暂存一条时原样发出', async () => {
    const g = gate()
    clock = at('2026-10-20T22:30:00')
    await g.push('u1', '只有这一条')
    clock = at('2026-10-21T08:00:00')
    await g.flushDue()
    expect(sent.map((s) => s.text)).toEqual(['只有这一条'])
  })

  it('底层失败已由 outbox 接手:交出即删,不重交', async () => {
    const g = gate()
    clock = at('2026-10-20T23:00:00')
    await g.push('u1', 'A')
    clock = at('2026-10-21T07:30:00')
    result = { delivered: false, reason: 'no_bridge' }
    await g.flushDue()
    expect(await g.pending('u1')).toBe(0)
    await g.flushDue()
    expect(sent).toHaveLength(1)
  })

  it('capExempt(运行播报):不占也不受每日上限,但仍守免打扰', async () => {
    const g = gate(1)
    clock = at('2026-10-21T10:00:00')
    await g.push('u1', '晨报')
    expect(await g.push('u1', '播报 1', { capExempt: true })).toEqual({ delivered: true })
    expect(await g.push('u1', '播报 2', { capExempt: true })).toEqual({ delivered: true })
    expect(await g.push('u1', '巡检')).toEqual({ delivered: true, reason: 'deferred_cap' })
    clock = at('2026-10-21T23:00:00')
    expect(await g.push('u1', '夜间播报', { capExempt: true })).toEqual({ delivered: true, reason: 'deferred_quiet' })
    expect(sent.map((x) => x.text)).toEqual(['晨报', '播报 1', '播报 2'])
  })

  it('成员本地钟与免打扰同一口径(+8)', () => {
    expect(gate().memberClock(Date.parse('2026-10-20T13:05:00Z'))).toEqual({ hour: 21, time: '21:05' })
  })

  it('暂存写不进盘就如实报没收下,让调用方下一轮再交', async () => {
    writeFileSync(join(dir, 'blocker'), '')
    const g = new ButlerPushGate({ dir: join(dir, 'blocker', 'gate'), logger: log, now: () => clock, push: async () => result })
    clock = at('2026-10-20T23:00:00')
    expect(await g.push('u1', 'A')).toEqual({ delivered: false, reason: 'defer_failed' })
  })

  it('dropIfDeferred:夜里或超上限直接丢弃,不暂存', async () => {
    const g = gate(1)
    clock = at('2026-10-20T23:00:00')
    expect(await g.push('u1', '签到', { dropIfDeferred: true })).toEqual({ delivered: false, reason: 'dropped_quiet' })
    expect(await g.pending('u1')).toBe(0)
    clock = at('2026-10-21T10:00:00')
    await g.push('u1', '第一条')
    expect(await g.push('u1', '签到', { dropIfDeferred: true })).toEqual({ delivered: false, reason: 'dropped_cap' })
    expect(await g.pending('u1')).toBe(0)
    expect(sent.map((x) => x.text)).toEqual(['第一条'])
  })
})

describe('每日上限', () => {
  it('超过上限推到次日早上,不丢', async () => {
    const g = gate(2)
    clock = at('2026-10-20T10:00:00')
    await g.push('u1', '1')
    await g.push('u1', '2')
    expect(await g.push('u1', '3')).toEqual({ delivered: true, reason: 'deferred_cap' })
    expect(sent).toHaveLength(2)
    clock = at('2026-10-20T18:00:00')
    await g.flushDue()
    expect(sent).toHaveLength(2) // 当天额度已满,不提前
    clock = at('2026-10-21T07:10:00')
    await g.flushDue()
    expect(sent.map((s) => s.text)).toEqual(['1', '2', '3'])
  })

  it('成员之间互不占用额度', async () => {
    const g = gate(1)
    clock = at('2026-10-20T10:00:00')
    await g.push('u1', 'a')
    await g.push('u2', 'b')
    expect(sent).toHaveLength(2)
  })
})

describe('合并', () => {
  it('超出字数顶时保留最新的,明说省略了几条较早的', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ text: `第 ${i} 条:${'很长的内容'.repeat(30)}`, at: 0, notBefore: 0 }))
    const text = mergeDeferred(items)
    expect(text.length).toBeLessThanOrEqual(3200)
    expect(text).toMatch(/另有 \d+ 条较早的消息已省略/)
    expect(text).toContain('第 29 条')
    expect(text).not.toContain('第 0 条')
  })
})
