/**
 * butler-maintenance-librarian.test.ts — LIB-M4 host 接线承重门。
 *
 * 真 tmp 命名空间跑 `runButlerMaintenanceOnce`,与生产完全同一条链:
 * patchMeta-backed shelve(close+promotedTo 一次补丁)+ 真 openKnowledgeLibrary
 * (与 factory 同一条 `ownerDir(root,{user,id})/knowledge` 派生)。三道:
 *   1. librarian: true — 事实上架进真文件、INDEX 落盘、记忆侧 bitemporal 关闭
 *      (可逆:条目还在盘上,validTo+promotedTo 都可查)。
 *   2. 收敛 — 第二 tick 候选(已上架被滤)掉到门槛下,librarian 一次模型调用
 *      都不再花,盘上字节不漂移。
 *   3. 未开(默认)字节不变 — knowledge/ 目录根本不存在,零事实被关。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@gotong/core'
import { META_PROMOTED_TO } from '@gotong/personal-butler'
import { isActive, validToOf, type MemorySummarizer } from '@gotong/personal-memory'

import { runButlerMaintenanceOnce } from '../src/personal-butler-maintenance.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

/**
 * 只替 LIBRARIAN pass 说话的 summarizer(蒸馏/抽取/其他 pass 得 '' = 干净 no-op),
 * 从 prompt 里读真实(文件分配的)id,把两条装修事实上架进 projects/装修.md ——
 * 模型的主题判断,做成确定性;同时计数,收敛测试要用。
 */
function librarianSummarize(counter: { calls: number }): MemorySummarizer {
  return async ({ system, user }) => {
    if (!system.includes('LIBRARIAN')) return ''
    counter.calls++
    const ids = user
      .split('\n')
      .filter((l) => l.startsWith('- ') && (l.includes('厨房') || l.includes('工头')))
      .map((l) => l.slice(2, l.indexOf(':')).trim())
    if (ids.length === 0) return JSON.stringify({ promotions: [] })
    return JSON.stringify({
      promotions: [
        { path: 'projects/装修.md', title: '装修', append: '- 厨房翻新预算 1.2 万\n- 工头姓陈,周三来量尺', factIds: ids },
      ],
      index: '# 知识库\n- projects/装修.md — 老家厨房翻新台账\n',
    })
  }
}

/** 12 条活跃 ad-hoc 事实(≥ 图书馆员门槛):2 条主题类 + 10 条身份/偏好类。 */
async function seedFacts(rootDir: string, userId: string) {
  const mem = openButlerMemory({ rootDir, userId, logger: silentLogger })
  await mem.remember({ kind: 'semantic', text: '老家厨房翻新预算敲定 1.2 万' })
  await mem.remember({ kind: 'semantic', text: '装修工头姓陈,周三来量尺' })
  for (const t of ['喜欢喝奶茶', '养了一只猫', '每天早上跑步', '生日是三月', '工作在软件公司', '会说三种语言', '喜欢看科幻电影', '住在槟城', '周末常去爬山', '对花生过敏']) {
    await mem.remember({ kind: 'semantic', text: t })
  }
  return mem
}

const bySubstr = (mem: Awaited<ReturnType<typeof seedFacts>>, needle: string) =>
  mem.recall({ kinds: ['semantic'], k: 50 }).then((all) => all.find((e) => e.text.includes(needle)))

describe('LIB-M4 — the 6h sweep shelves topical facts only when librarian mode is on', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'butler-librn-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('librarian: true — 上架进真文件 + INDEX 落盘 + 记忆侧关闭(可逆,带出处)', async () => {
    const mem = await seedFacts(tmp, 'alice')
    const counter = { calls: 0 }

    const now = 2_000_000_000_000
    const summary = await runButlerMaintenanceOnce({
      rootDir: tmp, userId: 'alice', summarize: librarianSummarize(counter),
      logger: silentLogger, now: () => now, librarian: true,
    })

    // 文件树:与 factory 同一条派生路径 <root>/user/<id>/knowledge/。
    const kdir = join(tmp, 'user', 'alice', 'knowledge')
    const reno = readFileSync(join(kdir, 'projects/装修.md'), 'utf8')
    expect(reno).toContain('# 装修')
    expect(reno).toContain('厨房翻新预算 1.2 万')
    expect(readFileSync(join(kdir, 'INDEX.md'), 'utf8')).toContain('- projects/装修.md — 老家厨房翻新台账')

    // 记忆侧:上架的两条被 CLOSE(不是 forget)+ promotedTo 出处;其余照旧活跃。
    const shelved = await bySubstr(mem, '厨房')
    expect(shelved).toBeDefined() // 条目还在盘上 = 可逆
    expect(validToOf(shelved!)).toBe(now)
    expect(isActive(shelved!, now)).toBe(false)
    expect(shelved!.meta?.[META_PROMOTED_TO]).toBe('projects/装修.md')
    expect(isActive((await bySubstr(mem, '奶茶'))!, now)).toBe(true)
    expect(summary).toContain('librarian: shelved 2 facts')
  })

  it('收敛:第二 tick 候选掉到门槛下 → 零模型调用,盘上字节不漂移', async () => {
    const mem = await seedFacts(tmp, 'carol')
    const counter = { calls: 0 }
    const summarize = librarianSummarize(counter)

    const tick1 = 2_000_000_000_000
    await runButlerMaintenanceOnce({
      rootDir: tmp, userId: 'carol', summarize, logger: silentLogger,
      now: () => tick1, librarian: true,
    })
    expect(counter.calls).toBe(1)
    const idx1 = readFileSync(join(tmp, 'user', 'carol', 'knowledge', 'INDEX.md'), 'utf8')

    // 上架掉 2 条后剩 10 条活跃候选 < 门槛 12 → 图书馆员自门控空转。
    const tick2 = tick1 + 6 * 60 * 60 * 1000
    await runButlerMaintenanceOnce({
      rootDir: tmp, userId: 'carol', summarize, logger: silentLogger,
      now: () => tick2, librarian: true,
    })
    expect(counter.calls).toBe(1) // 没有第二次调用
    expect(validToOf((await bySubstr(mem, '厨房'))!)).toBe(tick1) // 关闭时刻不漂移
    expect(readFileSync(join(tmp, 'user', 'carol', 'knowledge', 'INDEX.md'), 'utf8')).toBe(idx1)
  })

  it('默认(librarian off)— 字节不变:knowledge/ 不存在,零事实被关', async () => {
    const mem = await seedFacts(tmp, 'bob')
    const counter = { calls: 0 }

    await runButlerMaintenanceOnce({
      rootDir: tmp, userId: 'bob', summarize: librarianSummarize(counter), logger: silentLogger,
    })

    expect(counter.calls).toBe(0) // LIBRARIAN prompt 从没发出
    expect(existsSync(join(tmp, 'user', 'bob', 'knowledge'))).toBe(false)
    const all = await mem.recall({ kinds: ['semantic'], k: 50 })
    expect(all.every((e) => validToOf(e) === undefined)).toBe(true)
    expect(all.every((e) => e.meta?.[META_PROMOTED_TO] === undefined)).toBe(true)
  })
})
