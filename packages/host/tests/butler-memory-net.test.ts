/**
 * 记忆网供给方的门(M2c)。
 *
 * 这一层唯一的职责是**决定什么时候花那笔钱**(把四个店整个读一遍),所以门量的
 * 就是花钱的次数和花不出去时的姿态:
 *
 *   ① TTL 内不重建、过期后重建 —— 网是派生视图,落后几十秒的代价有界(那条记忆
 *      仍在冻结块和 recall 工具里),每轮重建的代价却是每条消息读一遍知识库。
 *   ② 并发合流:一阵消息风暴共享**一次**重建。
 *   ③ 建网失败时**旧网继续用**(它只是旧不是错),从没建成过才返 null。
 *   ④ 只接得到的那几个面照接,接不到的不编 —— 缺一个店只少那个店的召回。
 */

import { describe, expect, it } from 'vitest'
import type { MemoryEntry } from '@gotong/services-sdk'

import { buildButlerMemoryNetProvider } from '../src/personal-butler-memory-net.js'

const T0 = 1_700_000_000_000

function entry(id: string, text: string): MemoryEntry {
  return { id, kind: 'semantic', text, ts: T0, meta: {} } as unknown as MemoryEntry
}

/** 一个只会数自己被叫了几次的记忆面。 */
function countingIndex(entries: MemoryEntry[]): { allEntries: () => Promise<MemoryEntry[]>; calls: () => number } {
  let n = 0
  return {
    allEntries: async () => {
      n += 1
      return entries
    },
    calls: () => n,
  }
}

describe('① TTL', () => {
  it('TTL 内复用同一张网,过期后重建', async () => {
    const idx = countingIndex([entry('m1', '我对花生过敏')])
    let clock = T0
    const net = buildButlerMemoryNetProvider({
      userId: 'u',
      recallIndex: idx,
      ttlMs: 1000,
      now: () => clock,
    })

    const a = await net()
    const b = await net()
    expect(idx.calls()).toBe(1)
    expect(b).toBe(a) // 同一个对象,不只是同样的内容

    clock = T0 + 999
    await net()
    expect(idx.calls()).toBe(1)

    clock = T0 + 1000
    const c = await net()
    expect(idx.calls()).toBe(2)
    expect(c).not.toBe(a)
  })

  it('ttlMs=0 ⇒ 每次都重建(退化成没有缓存)', async () => {
    const idx = countingIndex([entry('m1', '我对花生过敏')])
    const net = buildButlerMemoryNetProvider({ userId: 'u', recallIndex: idx, ttlMs: 0, now: () => T0 })
    await net()
    await net()
    expect(idx.calls()).toBe(2)
  })
})

describe('② 并发合流', () => {
  it('同时来的多轮共享一次重建', async () => {
    let n = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const net = buildButlerMemoryNetProvider({
      userId: 'u',
      recallIndex: {
        allEntries: async () => {
          n += 1
          await gate
          return [entry('m1', '我对花生过敏')]
        },
      },
      now: () => T0,
    })

    const all = Promise.all([net(), net(), net(), net()])
    release()
    const nets = await all
    expect(n).toBe(1)
    for (const x of nets) expect(x).toBe(nets[0])
  })
})

describe('③ 失败姿态', () => {
  it('从没建成过 ⇒ null,并记一条 warn', async () => {
    const warns: string[] = []
    const net = buildButlerMemoryNetProvider({
      userId: 'u',
      recallIndex: {
        allEntries: async () => {
          throw new Error('盘炸了')
        },
      },
      now: () => T0,
      logger: { warn: (m: string) => warns.push(m) } as never,
    })
    expect(await net()).toBeNull()
    expect(warns).toHaveLength(1)
  })

  it('建过一次之后再失败 ⇒ 旧网继续用,不退化成静默', async () => {
    let boom = false
    let clock = T0
    const net = buildButlerMemoryNetProvider({
      userId: 'u',
      recallIndex: {
        allEntries: async () => {
          if (boom) throw new Error('盘炸了')
          return [entry('m1', '我对花生过敏')]
        },
      },
      ttlMs: 10,
      now: () => clock,
      logger: { warn: () => {} } as never,
    })

    const first = await net()
    expect(first?.nodes).toHaveLength(1)

    boom = true
    clock = T0 + 100
    const second = await net()
    // 旧网只是旧,不是错 —— 返 null 会让管家在一次读盘抖动里当场失忆。
    expect(second).toBe(first)
  })
})

describe('④ 只接得到的面', () => {
  it('只给记忆面 ⇒ 网里只有 memory: 节点,别的店不凭空出现', async () => {
    const net = await buildButlerMemoryNetProvider({
      userId: 'u',
      recallIndex: countingIndex([entry('m1', '我对花生过敏'), entry('m2', '我住槟城')]),
      now: () => T0,
    })()
    expect(net!.nodes.map((n) => n.id).sort()).toEqual(['memory:m1', 'memory:m2'])
  })

  it('档案面在但列出来是空的 ⇒ 不炸,也不多长出节点', async () => {
    const net = await buildButlerMemoryNetProvider({
      userId: 'u',
      recallIndex: countingIndex([entry('m1', '我对花生过敏')]),
      dossiers: {
        list: async () => [],
        load: async () => ({ kind: 'missing' }),
        readJournalTail: async () => [],
      } as never,
      now: () => T0,
    })()
    expect(net!.nodes).toHaveLength(1)
  })

  it('档案条数封顶:列出 50 份只取前 maxDossiers 份', async () => {
    const loaded: string[] = []
    const net = await buildButlerMemoryNetProvider({
      userId: 'u',
      recallIndex: countingIndex([]),
      dossiers: {
        list: async () =>
          Array.from({ length: 50 }, (_, i) => ({
            taskId: `t${i}`,
            status: 'running',
            objective: `目标 ${i}`,
            segments: 1,
            updatedAt: T0,
          })),
        load: async (id: string) => {
          loaded.push(id)
          return { kind: 'ok', dossier: { objective: `目标 ${id}` } }
        },
        readJournalTail: async () => [],
      } as never,
      maxDossiers: 3,
      now: () => T0,
    })()
    expect(loaded).toEqual(['t0', 't1', 't2'])
    expect(net!.nodes).toHaveLength(3)
  })
})
