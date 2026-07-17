/**
 * knowledge-librarian.test.ts — LIB-M4 纯核承重门。
 *
 * 里程碑表点名的三道 + fail-soft 家族:
 *   1. **no-op 门槛**:候选不足 → 零模型调用、零盘写(空转 tick 零成本);
 *      已上架(promotedTo)/已关(validTo)不计入门槛(收敛的另一半)。
 *   2. **上架双时态可逆**:shelve 收到 (entry, path, now) 三元组——host 折成
 *      一次 patchMeta(close+出处);写文件**成功之后**才下架(写前退后)。
 *   3. **投影(INDEX)重建**:模型整篇重写优先;动过的文件不管谁写都必须
 *      指得到(机械兜底),幻觉方案(零上架)绝不碰 INDEX。
 *   4. fail-soft:坏 JSON/模型 throw → 零操作;库层响亮拒(坏路径)→ 那条
 *      的事实绝不下架;幻觉 factIds 关不掉任何东西。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { MemoryEntry, MemoryHandle } from '@gotong/services-sdk'

import { openKnowledgeLibrary, type KnowledgeLibrary } from '../src/knowledge-library.js'
import {
  DEFAULT_LIBRARIAN_TRIGGER_FACTS,
  knowledgeLibrarianReviewer,
  parseLibrarianPlan,
  META_PROMOTED_TO,
} from '../src/knowledge-librarian.js'

const NOW = 2_000_000_000_000

/** 一条进货区 ad-hoc 事实(ts 按序号递增,排序确定)。 */
function fact(n: number, text: string, meta: Record<string, unknown> = {}): MemoryEntry {
  return { id: `f${n}`, kind: 'semantic', text, ts: n, meta }
}

/** 纯核只调 ctx.memory.recall——一个只读假 handle 就够。 */
function memOf(entries: MemoryEntry[]): MemoryHandle {
  return { recall: async () => entries } as unknown as MemoryHandle
}

/** 记录式 shelve(host 侧的一次 patchMeta 在纯核测试里就是这张流水)。 */
function shelveRecorder() {
  const calls: Array<{ id: string; path: string; validTo: number }> = []
  return {
    calls,
    shelve: async (e: MemoryEntry, path: string, validTo: number) => {
      calls.push({ id: e.id, path, validTo })
    },
  }
}

/** 记录式 summarize:存每次 {system,user},按序吐回应。 */
function summarizeRecorder(...responses: string[]) {
  const calls: Array<{ system: string; user: string }> = []
  let i = 0
  return {
    calls,
    summarize: async (req: { system: string; user: string }) => {
      calls.push(req)
      return responses[Math.min(i++, responses.length - 1)] ?? ''
    },
  }
}

const twelve = () =>
  Array.from({ length: 12 }, (_, i) => fact(i + 1, `事实第 ${i + 1} 条:老家厨房翻新的细节`))

let parent: string
let dir: string
let library: KnowledgeLibrary

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'gotong-librn-'))
  dir = join(parent, 'knowledge')
  library = openKnowledgeLibrary({ dir })
})

afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

describe('LIB-M4 图书馆员 — no-op 门槛(空转 tick 零成本)', () => {
  it('候选不足 trigger → 零模型调用、零盘写、{}', async () => {
    const s = summarizeRecorder()
    const r = shelveRecorder()
    const reviewer = knowledgeLibrarianReviewer({ library, summarize: s.summarize, shelve: r.shelve })
    const out = await reviewer({
      memory: memOf(twelve().slice(0, DEFAULT_LIBRARIAN_TRIGGER_FACTS - 1)),
      episodic: [],
      now: NOW,
    })
    expect(out).toEqual({})
    expect(s.calls.length).toBe(0)
    expect(r.calls.length).toBe(0)
    expect(existsSync(dir)).toBe(false) // 连 knowledge/ 目录都没被创建
  })

  it('已上架(promotedTo)与已关(validTo)不计入门槛——上架单调收敛', async () => {
    const s = summarizeRecorder()
    const r = shelveRecorder()
    const entries = [
      ...twelve().slice(0, 11), // 11 条合格
      fact(12, '已经搬去书架的', { [META_PROMOTED_TO]: 'ref/旧.md' }),
      fact(13, '已经关掉区间的', { validTo: NOW - 1 }),
    ]
    const reviewer = knowledgeLibrarianReviewer({ library, summarize: s.summarize, shelve: r.shelve })
    expect(await reviewer({ memory: memOf(entries), episodic: [], now: NOW })).toEqual({})
    expect(s.calls.length).toBe(0)
  })
})

describe('LIB-M4 图书馆员 — 上架主路径(写前退后 + INDEX 重写)', () => {
  it('追加进现有文件 + 新建带标题文件;写成才 shelve;INDEX 用模型整篇', async () => {
    await library.write('projects/装修.md', '# 装修\n\n- 旧记录:工头姓陈\n')
    await library.write('INDEX.md', '# 知识库\n- projects/装修.md — 装修台账\n')
    const plan = {
      promotions: [
        { path: 'projects/装修.md', append: '- 预算敲定 1.2 万', factIds: ['f1', 'f2'] },
        { path: 'ref/奶茶清单.md', title: '奶茶清单', append: '- 家人最爱三分糖', factIds: ['f3'] },
      ],
      index: '# 知识库\n- projects/装修.md — 装修台账(预算已定)\n- ref/奶茶清单.md — 家人奶茶偏好\n',
    }
    const s = summarizeRecorder(JSON.stringify(plan))
    const r = shelveRecorder()
    const reviewer = knowledgeLibrarianReviewer({ library, summarize: s.summarize, shelve: r.shelve })
    const out = await reviewer({ memory: memOf(twelve()), episodic: [], now: NOW })

    // prompt 里有候选 id、现有文件清单、现行索引(模型看得见现状才编排得好)。
    expect(s.calls.length).toBe(1)
    expect(s.calls[0]!.user).toContain('- f1: ')
    expect(s.calls[0]!.user).toContain('- projects/装修.md')
    expect(s.calls[0]!.user).toContain('装修台账')

    const reno = readFileSync(join(dir, 'projects/装修.md'), 'utf8')
    expect(reno.startsWith('# 装修')).toBe(true) // 追加不覆盖
    expect(reno).toContain('工头姓陈')
    expect(reno).toContain('- 预算敲定 1.2 万')
    expect(readFileSync(join(dir, 'ref/奶茶清单.md'), 'utf8')).toBe('# 奶茶清单\n\n- 家人最爱三分糖\n')

    // shelve 三元组带 path 出处 + tick 时钟(host 折进一次 patchMeta)。
    expect(r.calls).toEqual([
      { id: 'f1', path: 'projects/装修.md', validTo: NOW },
      { id: 'f2', path: 'projects/装修.md', validTo: NOW },
      { id: 'f3', path: 'ref/奶茶清单.md', validTo: NOW },
    ])
    expect(readFileSync(join(dir, 'INDEX.md'), 'utf8')).toBe(plan.index)
    expect(out.summary).toContain('shelved 3 facts into 2 files')
  })

  it('同一事实被两条 promotion 引用 → 首条赢,次条整条跳过(文件不写)', async () => {
    const plan = {
      promotions: [
        { path: 'a.md', append: '- 内容甲', factIds: ['f1'] },
        { path: 'b.md', append: '- 内容乙', factIds: ['f1'] }, // 只引已搬走的
      ],
    }
    const s = summarizeRecorder(JSON.stringify(plan))
    const r = shelveRecorder()
    const reviewer = knowledgeLibrarianReviewer({ library, summarize: s.summarize, shelve: r.shelve })
    await reviewer({ memory: memOf(twelve()), episodic: [], now: NOW })
    expect(r.calls.map((c) => c.id)).toEqual(['f1'])
    expect(existsSync(join(dir, 'a.md'))).toBe(true)
    expect(existsSync(join(dir, 'b.md'))).toBe(false)
  })
})

describe('LIB-M4 图书馆员 — fail-soft 家族(事实绝不无凭下架)', () => {
  it('模型 throw / 坏 JSON → 零操作零盘写', async () => {
    for (const summarize of [
      async () => {
        throw new Error('model down')
      },
      async () => '抱歉,我觉得都挺好的,不用整理。',
    ]) {
      const r = shelveRecorder()
      const reviewer = knowledgeLibrarianReviewer({ library, summarize, shelve: r.shelve })
      expect(await reviewer({ memory: memOf(twelve()), episodic: [], now: NOW })).toEqual({})
      expect(r.calls.length).toBe(0)
    }
    expect(existsSync(dir)).toBe(false)
  })

  it('库层响亮拒(../ 穿越路径)→ 那条的事实绝不下架,合法条照常', async () => {
    const plan = {
      promotions: [
        { path: '../evil.md', append: '- 越狱内容', factIds: ['f1'] },
        { path: 'ok.md', append: '- 正经内容', factIds: ['f2'] },
      ],
    }
    const s = summarizeRecorder(JSON.stringify(plan))
    const r = shelveRecorder()
    const reviewer = knowledgeLibrarianReviewer({ library, summarize: s.summarize, shelve: r.shelve })
    const out = await reviewer({ memory: memOf(twelve()), episodic: [], now: NOW })

    expect(existsSync(join(parent, 'evil.md'))).toBe(false) // 圈外一个字节都没有
    expect(r.calls.map((c) => c.id)).toEqual(['f2']) // f1 留在记忆里
    expect(readFileSync(join(dir, 'ok.md'), 'utf8')).toContain('正经内容')
    expect(out.summary).toContain('shelved 1 fact')
  })

  it('幻觉 factIds:纯幻觉条整条跳过(连文件都不写);混入的真 id 照常', async () => {
    const plan = {
      promotions: [
        { path: 'ghost.md', append: '- 空中楼阁', factIds: ['no-such-id'] },
        { path: 'mixed.md', append: '- 半真半假', factIds: ['no-such-id', 'f5'] },
      ],
    }
    const s = summarizeRecorder(JSON.stringify(plan))
    const r = shelveRecorder()
    const reviewer = knowledgeLibrarianReviewer({ library, summarize: s.summarize, shelve: r.shelve })
    await reviewer({ memory: memOf(twelve()), episodic: [], now: NOW })
    expect(existsSync(join(dir, 'ghost.md'))).toBe(false)
    expect(r.calls.map((c) => c.id)).toEqual(['f5'])
  })

  it('shelve 本身 throw → 事实仍活跃(下轮再候选),同批其他条不连累', async () => {
    const plan = { promotions: [{ path: 'x.md', append: '- 内容', factIds: ['f1', 'f2'] }] }
    const s = summarizeRecorder(JSON.stringify(plan))
    const shelved: string[] = []
    const reviewer = knowledgeLibrarianReviewer({
      library,
      summarize: s.summarize,
      shelve: async (e) => {
        if (e.id === 'f1') throw new Error('patch failed')
        shelved.push(e.id)
      },
    })
    const out = await reviewer({ memory: memOf(twelve()), episodic: [], now: NOW })
    expect(shelved).toEqual(['f2'])
    expect(out.summary).toContain('shelved 1 fact') // 只报真下架的
  })
})

describe('LIB-M4 图书馆员 — INDEX 兜底(上架过的文件绝不失联)', () => {
  it('模型没给 index → 在现行索引上机械补指针', async () => {
    await library.write('INDEX.md', '# 知识库\n- 旧的.md — 一直在\n')
    const plan = { promotions: [{ path: 'ref/新知识.md', append: '- 内容', factIds: ['f1'] }] }
    const s = summarizeRecorder(JSON.stringify(plan))
    const r = shelveRecorder()
    await knowledgeLibrarianReviewer({ library, summarize: s.summarize, shelve: r.shelve })({
      memory: memOf(twelve()),
      episodic: [],
      now: NOW,
    })
    const idx = readFileSync(join(dir, 'INDEX.md'), 'utf8')
    expect(idx).toContain('- 旧的.md — 一直在') // 原有内容保住
    expect(idx).toContain('- ref/新知识.md — 图书馆员整理上架')
  })

  it('模型 index 漏了动过的文件 → 机械补在模型稿之后', async () => {
    const plan = {
      promotions: [
        { path: 'a.md', append: '- 甲', factIds: ['f1'] },
        { path: 'b.md', append: '- 乙', factIds: ['f2'] },
      ],
      index: '# 知识库\n- a.md — 甲的档案\n', // 漏了 b.md
    }
    const s = summarizeRecorder(JSON.stringify(plan))
    const r = shelveRecorder()
    await knowledgeLibrarianReviewer({ library, summarize: s.summarize, shelve: r.shelve })({
      memory: memOf(twelve()),
      episodic: [],
      now: NOW,
    })
    const idx = readFileSync(join(dir, 'INDEX.md'), 'utf8')
    expect(idx).toContain('- a.md — 甲的档案')
    expect(idx).toContain('- b.md — 图书馆员整理上架')
  })

  it('方案全军覆没(零上架)→ INDEX 一个字节不动(幻觉索引不落盘)', async () => {
    await library.write('INDEX.md', '# 知识库\n- 旧的.md — 原样\n')
    const plan = {
      promotions: [{ path: 'ghost.md', append: '- 空', factIds: ['no-such'] }],
      index: '# 被幻觉重写的索引\n',
    }
    const s = summarizeRecorder(JSON.stringify(plan))
    const r = shelveRecorder()
    await knowledgeLibrarianReviewer({ library, summarize: s.summarize, shelve: r.shelve })({
      memory: memOf(twelve()),
      episodic: [],
      now: NOW,
    })
    expect(readFileSync(join(dir, 'INDEX.md'), 'utf8')).toBe('# 知识库\n- 旧的.md — 原样\n')
  })
})

describe('LIB-M4 图书馆员 — 批量步频(maxBatch 是步频不是丢弃)', () => {
  it('候选超 maxBatch → prompt 只递前 N 条(按 ts),批外 id 关不掉', async () => {
    const entries = Array.from({ length: 14 }, (_, i) => fact(i + 1, `第 ${i + 1} 条`))
    const plan = { promotions: [{ path: 'x.md', append: '- 内容', factIds: ['f6', 'f1'] }] }
    const s = summarizeRecorder(JSON.stringify(plan))
    const r = shelveRecorder()
    await knowledgeLibrarianReviewer({
      library,
      summarize: s.summarize,
      shelve: r.shelve,
      maxBatch: 5,
    })({ memory: memOf(entries), episodic: [], now: NOW })

    const idLines = s.calls[0]!.user.match(/^- f\d+: /gm) ?? []
    expect(idLines.length).toBe(5) // 只有 f1..f5 进了 prompt
    expect(r.calls.map((c) => c.id)).toEqual(['f1']) // f6 在批外 = 幻觉同款挡法
  })
})

describe('LIB-M4 parseLibrarianPlan — 宽容解析', () => {
  it('吃 {"promotions":[...]} / 裸数组 / 前后带散文;坏条目只丢那条', () => {
    const obj = parseLibrarianPlan('好的,方案如下:\n{"promotions":[{"path":"a.md","append":"x","factIds":["f1"]}],"index":"# i"}\n以上。')
    expect(obj!.promotions.length).toBe(1)
    expect(obj!.index).toBe('# i')

    const arr = parseLibrarianPlan('[{"path":"a.md","append":"x","factIds":["f1"]}]')
    expect(arr!.promotions.length).toBe(1)
    expect(arr!.index).toBeUndefined()

    const mixed = parseLibrarianPlan(
      JSON.stringify({
        promotions: [
          { path: '', append: 'x', factIds: ['f1'] }, // 空 path 丢
          { path: 'a.md', append: '  ', factIds: ['f1'] }, // 空正文丢
          { path: 'b.md', append: 'x', factIds: [] }, // 零 id 丢
          { path: 'c.md', append: 'x', factIds: ['f1', 42] }, // 非串 id 滤掉
        ],
      }),
    )
    expect(mixed!.promotions.length).toBe(1)
    expect(mixed!.promotions[0]!.path).toBe('c.md')
    expect(mixed!.promotions[0]!.factIds).toEqual(['f1'])
  })

  it('整体不可用 → null(调用方零操作)', () => {
    expect(parseLibrarianPlan('')).toBeNull()
    expect(parseLibrarianPlan('都挺好,不用整理')).toBeNull()
    expect(parseLibrarianPlan('{"ops":"not-a-plan"}')).toBeNull()
    expect(parseLibrarianPlan('{broken json')).toBeNull()
  })
})
