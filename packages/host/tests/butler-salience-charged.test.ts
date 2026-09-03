/**
 * M3b 在 **host 这一侧**的门:显著性到底有没有被接上。
 *
 * `personal-memory` 那边的 `check:memory-eviction` 量的是「通电之后逐出会不会更
 * 好」;这里量的是**另一件事**——生产的 6h 链有没有真的把电送过去。两者缺一不可:
 * 只量前者,参数在 host 被吞掉时门照样绿;只量后者,参数传下去但没用也照样绿。
 *
 * 判据是**后果不是形状**:造一个「老而常用 vs 新而没人碰」的库,跑一次真的维护
 * tick,看活下来的是谁。断言「某个字段被传下去了」是形状,换个字段名就骗过去了。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MemoryEntry } from '@gotong/services-sdk'
import { entryBytes } from '@gotong/personal-memory'

import { buildButlerMaintenanceReviewer } from '../src/personal-butler-maintenance.js'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gotong-salience-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function fact(id: string, text: string, writtenDaysAgo: number, used?: { daysAgo: number; count: number }): MemoryEntry {
  const meta: Record<string, unknown> = { importance: 3 }
  if (used) {
    meta['lastRecalledTs'] = NOW - used.daysAgo * DAY
    meta['recallCount'] = used.count
  }
  return { id, kind: 'semantic', text, ts: NOW - writtenDaysAgo * DAY, meta } as unknown as MemoryEntry
}

/** 一个够用的记忆句柄:维护 reviewer 只需要 list / forget / remember。 */
function memoryOf(seed: MemoryEntry[]) {
  let entries = [...seed]
  return {
    handle: {
      async list() {
        return [...entries]
      },
      async recall() {
        return [...entries]
      },
      async remember(e: unknown) {
        const n = { id: `n${entries.length}`, ...(e as object) } as MemoryEntry
        entries.push(n)
        return n
      },
      async forget(id: string) {
        entries = entries.filter((e) => e.id !== id)
      },
      async patchMeta() {},
    },
    ids: () => entries.map((e) => e.id).sort(),
  }
}

describe('生产的 6h 链真的把电送到了', () => {
  it('老而常用的活下来,新而没人碰的被逐 —— 通电前后结论相反', async () => {
    const seed = [
      fact('used-old', '我对花生过敏', 90, { daysAgo: 1, count: 8 }),
      fact('cold-new', '某次会议提过一句天气', 60),
    ]
    const mem = memoryOf(seed)
    // 预算刚好装得下「该留的那条」:必然逐掉一条,问题只是逐哪条。用的是
    // `entryBytes` —— 和执法同一把秤,不自带第二套算术。
    const budgetBytes = entryBytes(seed[0]!)

    const reviewer = buildButlerMaintenanceReviewer({
      summarize: async () => '',
      budgetBytes,
      statusFile: { read: async () => null, write: async () => {} } as never,
    })
    await reviewer({ memory: mem.handle as never, now: NOW } as never)

    // 通电之前,逐出只看重要度与新旧 —— 两条重要度相同,更旧的 used-old 会先走。
    // 通电之后,它被强化了 8 次,反而是最该留的那条。
    expect(mem.ids()).toEqual(['used-old'])
  })

  it('翻篇的死历史先走,哪怕它比活着的那条更新', async () => {
    // 这一条钉的是 host 侧的 `evictExpiredFirst`。没有它,逐出只比显著性:
    // closed 更新(20 天) ⇒ 衰减更少 ⇒ 显著性 1.89 > live 的 1.5 ⇒ 活着的那条
    // 反而先被逐。开了才对。2026-09-02 变异 N5-D 抓到过一次:那时 host 接了这个
    // 开关却没有任何一道门量它,把它改成 false 全仓照样绿。
    const live = fact('live', '我现在在做记忆经济这个项目', 30)
    const closed = {
      ...fact('closed', '我以前在做另一个项目', 20),
      meta: { importance: 3, validTo: NOW - 5 * DAY },
    } as MemoryEntry
    const mem = memoryOf([live, closed])
    const budgetBytes = entryBytes(live)

    const reviewer = buildButlerMaintenanceReviewer({
      summarize: async () => '',
      budgetBytes,
      statusFile: { read: async () => null, write: async () => {} } as never,
    })
    await reviewer({ memory: mem.handle as never, now: NOW } as never)

    expect(mem.ids()).toEqual(['live'])
  })
})
