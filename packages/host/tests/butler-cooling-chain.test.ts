/**
 * M3c 在 **host 这一侧**的门:降温在 6h 链上的**位置**。
 *
 * `personal-memory` 的 `check:memory-eviction` 量的是「先降温再执法会不会更好」——
 * 那把尺子自己组装流水线,所以它对生产的接线顺序**一无所知**。这里量的正是那一段:
 *
 *   降温只盖 `validTo`,一个字节都不回收。被它翻篇的事实要等 `tieredReviewer` 末尾
 *   那次 `enforceBudget` 才真的走。所以顺序反过来 —— 降温排在 tiered **之后** ——
 *   这一 tick 翻的篇要等下一 tick(6 小时后)才有人收,「降温」退化成纯粹的延迟,
 *   而这一 tick 的回收照旧落在近期流水账头上。
 *
 * 判据是**后果不是形状**:跑一次真的维护 tick,看活下来的是谁。断言
 * 「composeReviewers 的第一个参数是 coolingReviewer」是形状,重构一下就骗过去了。
 */

import { describe, expect, it } from 'vitest'
import type { MemoryEntry } from '@gotong/services-sdk'
import { entryBytes } from '@gotong/personal-memory'

import { buildButlerMaintenanceReviewer } from '../src/personal-butler-maintenance.js'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function log(i: number): MemoryEntry {
  return {
    id: `log-${String(i).padStart(2, '0')}`,
    kind: 'episodic',
    text: `第 ${i} 天的对话记录:讨论了这一段要怎么收口,以及下一步该量什么。`,
    ts: NOW - i * DAY,
    meta: { importance: 3 },
  } as unknown as MemoryEntry
}

function fact(id: string, text: string, daysAgo: number): MemoryEntry {
  return {
    id,
    kind: 'semantic',
    text,
    ts: NOW - daysAgo * DAY,
    meta: { importance: 3 },
  } as unknown as MemoryEntry
}

/**
 * 够用的记忆句柄。两点是刻意的:
 *
 *   - `patchMeta` **真的浅合并**并返回 `true`。M3b 那道门里它是个空壳(降温在那边
 *     因此恒等于不存在),这边要量的就是它写下去之后发生了什么。
 *   - `recall({kinds:['episodic']})` 返回空。蒸馏那一段看的是 `recall` 的 episodic
 *     积压,这里不想让它掺和进来;`list` 仍返回全部,所以降温与执法看得见整个库。
 *     隔离的是**别的 pass**,不是被测的那一段。
 */
function memoryOf(seed: readonly MemoryEntry[]) {
  let entries = [...seed]
  return {
    handle: {
      async list() {
        return [...entries]
      },
      async recall(q: { kinds?: string[] } = {}) {
        if (q.kinds?.includes('episodic')) return []
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
      async patchMeta(id: string, patch: Record<string, unknown>) {
        const i = entries.findIndex((e) => e.id === id)
        if (i < 0) return false
        entries[i] = { ...entries[i]!, meta: { ...(entries[i]!.meta ?? {}), ...patch } }
        return true
      },
    },
    ids: () => entries.map((e) => e.id).sort(),
  }
}

describe('降温排在 6h 链的**最前面**', () => {
  it('冷事实在同一个 tick 就被回收,近期流水一条不少', async () => {
    // 12 条流水:`enforceBudget` 的 protectRecentEpisodic 默认护住最新 8 条,
    // 剩 4 条裸露 —— 没有降温时,被吃掉的就是它们。
    const logs = Array.from({ length: 12 }, (_, i) => log(i + 1))
    // 8 条近期事实占满降温自己的保护期,冷事实才够得着。
    const fresh = Array.from({ length: 8 }, (_, i) => fact(`fresh-${i}`, `最近记下的第 ${i} 条`, 10 + i))
    const cold = fact('cold', '很久以前记下的一条,之后再没被翻出来过。', 200)

    const mem = memoryOf([...logs, ...fresh, cold])
    // 预算 = 该留的那些的字节和 ⇒ 必然逐掉「冷事实那么多字节」,问题只是逐谁。
    const budgetBytes = [...logs, ...fresh].reduce((s, e) => s + entryBytes(e), 0)

    const reviewer = buildButlerMaintenanceReviewer({
      summarize: async () => '',
      budgetBytes,
      statusFile: { read: async () => null, write: async () => {} } as never,
    })
    await reviewer({ memory: mem.handle as never, now: NOW } as never)

    // 降温在链头 ⇒ cold 这一 tick 就被翻篇 + 回收,流水一条不少。
    // 降温挪到链尾 ⇒ 执法先跑,吃掉最旧的几条流水,cold 只是被盖了个 validTo 还赖着。
    expect(mem.ids()).toEqual([...logs, ...fresh].map((e) => e.id).sort())
  })
})
