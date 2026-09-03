/**
 * 记忆经济 M3d 的门:知识库货架降温。
 *
 * 四组,顺序即论证:
 *
 *   ① **纯核**:选谁归档是纯函数,三道保护(INDEX.md / 保护期 / 已归档)各配用例。
 *   ② **后果**:货架撞顶之后 `write` 是抛 `knowledge_limit` 的;跑一次维护,**同一个
 *      `write` 就成功了**。这是这一刀唯一值得断言的东西——不是「归档函数被调用了」。
 *   ③ **闸门**:压力不到第 ③ 级一份都不动。
 *   ④ **诚实**:归档**不减字节**、**不删文件**。两条都不是修辞,是断言。
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_PROTECT_RECENT_FILES,
  knowledgeCoolingReviewer,
  restingActiveCount,
  selectForArchive,
} from '../src/knowledge-cooling.js'
import {
  KNOWLEDGE_INDEX_FILE,
  KNOWLEDGE_LIBRARY_LIMITS,
  openKnowledgeLibrary,
  type KnowledgeFileInfo,
  type KnowledgeLibrary,
} from '../src/knowledge-library.js'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
const SRC = readFileSync(
  fileURLToPath(new URL('../src/knowledge-cooling.ts', import.meta.url)),
  'utf8',
)

/** 收紧到 20 份货架,好让一个用例里写得出「满」这个状态。字节顶保持宽松。 */
const LIMITS = { ...KNOWLEDGE_LIBRARY_LIMITS, maxFiles: 20 }

function info(path: string, daysAgo: number, opts: { bytes?: number; archived?: boolean } = {}): KnowledgeFileInfo {
  return {
    path,
    bytes: opts.bytes ?? 100,
    archived: opts.archived ?? false,
    mtimeMs: NOW - daysAgo * DAY,
  }
}

describe('① 纯核:选谁归档', () => {
  /** 20 份上架件,越靠后越旧。 */
  const shelf = Array.from({ length: 20 }, (_, i) => info(`f${String(i).padStart(2, '0')}.md`, i + 1))

  it('最久没维护的在前', () => {
    const sel = selectForArchive(shelf, { limits: LIMITS, targetActive: 16 })
    expect([...sel.archive]).toEqual(['f19.md', 'f18.md', 'f17.md', 'f16.md'])
  })

  it('保护期挡住最近写过的那几份', () => {
    const sel = selectForArchive(shelf, { limits: LIMITS, targetActive: 0 })
    expect(sel.skipped.recent).toBe(DEFAULT_PROTECT_RECENT_FILES)
    // 最新的 8 份(f00..f07)一份都不在名单里。
    for (let i = 0; i < DEFAULT_PROTECT_RECENT_FILES; i += 1) {
      expect(sel.archive).not.toContain(`f${String(i).padStart(2, '0')}.md`)
    }
  })

  it('INDEX.md 永不归档 —— 归档它等于自断导航', () => {
    // 让它成为全场最旧的一份:一个不看名字的实现会第一个挑中它。
    const sel = selectForArchive([...shelf, info(KNOWLEDGE_INDEX_FILE, 9999)], {
      limits: LIMITS,
      targetActive: 0,
    })
    expect(sel.skipped.index).toBe(1)
    expect(sel.archive).not.toContain(KNOWLEDGE_INDEX_FILE)
  })

  it('归档区里的不再归档,也不占货架保护名额', () => {
    const withArchived = [...shelf, info('archive/old.md', 9999, { archived: true })]
    const sel = selectForArchive(withArchived, { limits: LIMITS, targetActive: 16 })
    expect(sel.skipped.archived).toBe(1)
    expect(sel.archive).not.toContain('archive/old.md')
    // 货架压力只数上架区:多一份归档件不该把压力算高。
    expect(sel.shelfPressure).toBe(20 / LIMITS.maxFiles)
  })

  it('目标之下一份都不动,每 tick 硬顶咬得住', () => {
    expect(selectForArchive(shelf, { limits: LIMITS, targetActive: 20 }).archive).toEqual([])
    expect(selectForArchive(shelf, { limits: LIMITS, targetActive: 25 }).archive).toEqual([])
    expect(
      selectForArchive(shelf, { limits: LIMITS, targetActive: 0, protectRecent: 0, maxPerTick: 3 })
        .archive.length,
    ).toBe(3)
  })

  it('字节压力数**全树**(含归档区)—— 归档不减字节,顶不许说谎', () => {
    const sel = selectForArchive(
      [...shelf, info('archive/old.md', 9999, { bytes: 5_000, archived: true })],
      { limits: LIMITS, targetActive: 16 },
    )
    // 20 × 100 + 5000 = 7000。只数上架区会得到 2000 —— 那就是在替归档区遮丑。
    expect(sel.bytePressure).toBe(7_000 / LIMITS.maxTotalBytes)
  })

  it('停靠点落在降级线**之下**,阶梯才走得下来', () => {
    // 停在降级线上(0.85 × 20 = 17)的话,rungFor 守的是 >=,下一 tick 仍判第 ③ 级,
    // 于是永远挂着「降温」却一份都不动。少一份才真的落回第 ② 级。
    expect(restingActiveCount(20, 0.85)).toBe(16)
    expect(16 / 20).toBeLessThan(0.85)
  })
})

describe('② 后果:从「写不进去」到「写得进去」', () => {
  let dir: string
  let lib: KnowledgeLibrary

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gotong-kb-cool-'))
    lib = openKnowledgeLibrary({ dir, limits: { maxFiles: LIMITS.maxFiles }, now: () => NOW })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** 把货架写满,并按序号拉开 mtime(越大越旧)。 */
  const fill = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i += 1) {
      const rel = `f${String(i).padStart(2, '0')}.md`
      await lib.write(rel, `第 ${i} 份知识文件的正文。`)
      const t = new Date(NOW - (i + 1) * DAY)
      await utimes(join(dir, rel), t, t)
    }
  }

  it('撞顶时 write 抛 knowledge_limit;跑一次维护之后,同一个 write 成功', async () => {
    await fill(LIMITS.maxFiles)

    // 先证明这个「撞顶」是真的,不是我假设的。
    await expect(lib.write('新的一份.md', '内容')).rejects.toThrow(/上限 20/)

    const out = await knowledgeCoolingReviewer({
      library: lib,
      limits: LIMITS,
    })({ memory: null as never, episodic: [], now: NOW })
    expect(out.summary).toMatch(/知识库降温:归档 4 份/)

    // 同一句话,这次写得进去。
    const w = await lib.write('新的一份.md', '内容')
    expect(w.created).toBe(true)

    const after = await lib.list()
    expect(after.activeCount).toBe(17) // 20 − 4 归档 + 1 新写
    expect(after.archivedCount).toBe(4)
  })

  it('归档的正是最久没维护的那 4 份,保护期里的一份没动', async () => {
    await fill(LIMITS.maxFiles)
    await knowledgeCoolingReviewer({ library: lib, limits: LIMITS })({
      memory: null as never,
      episodic: [],
      now: NOW,
    })
    const l = await lib.list()
    expect(l.files.filter((f) => f.archived).map((f) => f.path).sort()).toEqual([
      'archive/f16.md',
      'archive/f17.md',
      'archive/f18.md',
      'archive/f19.md',
    ])
  })

  it('单份归档失败只跳过它,整趟照走', async () => {
    await fill(LIMITS.maxFiles)
    const flaky: KnowledgeLibrary = {
      ...lib,
      archive: async (p) => {
        if (p === 'f19.md') throw new Error('boom')
        return lib.archive(p)
      },
    }
    const out = await knowledgeCoolingReviewer({ library: flaky, limits: LIMITS })({
      memory: null as never,
      episodic: [],
      now: NOW,
    })
    expect(out.summary).toMatch(/归档 3 份/)
    expect((await lib.list()).activeCount).toBe(17)
  })
})

describe('③ 闸门:压力不到第 ③ 级一份都不动', () => {
  let dir: string
  let lib: KnowledgeLibrary

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gotong-kb-gate-'))
    lib = openKnowledgeLibrary({ dir, limits: { maxFiles: LIMITS.maxFiles }, now: () => NOW })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('17/20 = 85% ⇒ 第 ② 级 ⇒ 空闲,树一个字节不变', async () => {
    for (let i = 0; i < 17; i += 1) await lib.write(`f${i}.md`, `第 ${i} 份`)
    const before = JSON.stringify(await lib.list())
    const out = await knowledgeCoolingReviewer({ library: lib, limits: LIMITS })({
      memory: null as never,
      episodic: [],
      now: NOW,
    })
    expect(out).toEqual({})
    expect(JSON.stringify(await lib.list())).toBe(before)
  })

  it('滞回:升上去之后,85% 仍留在第 ③ 级;冷启动的同一个压力则空闲', async () => {
    for (let i = 0; i < 17; i += 1) await lib.write(`f${String(i).padStart(2, '0')}.md`, `第 ${i} 份`)

    // (a) 冷启动:priorRung = 0 ⇒ 按升级线判 ⇒ 第 ② 级 ⇒ 一份不动。
    const cold = knowledgeCoolingReviewer({ library: lib, limits: LIMITS })
    expect(await cold({ memory: null as never, episodic: [], now: NOW })).toEqual({})
    expect((await lib.list()).activeCount).toBe(17)

    // (b) 同一个闭包先被顶到第 ③ 级(把货架写满),再回到 85% ⇒ 滞回让它继续动手。
    const warm = knowledgeCoolingReviewer({ library: lib, limits: LIMITS })
    for (let i = 17; i < 20; i += 1) await lib.write(`f${String(i).padStart(2, '0')}.md`, `第 ${i} 份`)
    expect((await warm({ memory: null as never, episodic: [], now: NOW })).summary).toMatch(/降温/)
    expect((await lib.list()).activeCount).toBe(16) // 已经降到停靠点

    // 再写一份回到 17/20 = 85%:落在滞回带里,warm 仍判第 ③ 级 ⇒ 归档 1 份。
    await lib.write('again.md', '再写一份')
    expect((await warm({ memory: null as never, episodic: [], now: NOW })).summary).toMatch(/归档 1 份/)
    expect((await lib.list()).activeCount).toBe(16)
  })

  it('该动手但一份都没归成 ⇒ 仍然报空闲,不发一条「归档 0 份」的噪声', async () => {
    for (let i = 0; i < 20; i += 1) await lib.write(`f${String(i).padStart(2, '0')}.md`, `第 ${i} 份`)
    const out = await knowledgeCoolingReviewer({ library: lib, limits: LIMITS, maxPerTick: 0 })({
      memory: null as never,
      episodic: [],
      now: NOW,
    })
    expect(out).toEqual({})
  })

  it('18/20 = 90% ⇒ 第 ③ 级 ⇒ 动手', async () => {
    for (let i = 0; i < 18; i += 1) await lib.write(`f${String(i).padStart(2, '0')}.md`, `第 ${i} 份`)
    const out = await knowledgeCoolingReviewer({ library: lib, limits: LIMITS })({
      memory: null as never,
      episodic: [],
      now: NOW,
    })
    expect(out.summary).toMatch(/知识库降温/)
    expect((await lib.list()).activeCount).toBe(16)
  })
})

describe('④ 诚实:归档不减字节,也不删文件', () => {
  let dir: string
  let lib: KnowledgeLibrary

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gotong-kb-honest-'))
    lib = openKnowledgeLibrary({ dir, limits: { maxFiles: LIMITS.maxFiles }, now: () => NOW })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('全树字节数一个不少 —— 所以字节顶只报不动,不是偷懒', async () => {
    for (let i = 0; i < 20; i += 1) await lib.write(`f${String(i).padStart(2, '0')}.md`, `第 ${i} 份知识`)
    const before = await lib.list()
    const beforeTotal = before.activeBytes + before.archivedBytes

    await knowledgeCoolingReviewer({ library: lib, limits: LIMITS })({
      memory: null as never,
      episodic: [],
      now: NOW,
    })
    const after = await lib.list()
    expect(after.activeBytes + after.archivedBytes).toBe(beforeTotal)
    expect(after.files.length).toBe(before.files.length) // 一份都没消失
  })

  it('字节压力高时点名说出真正能减字节的那个策略键', async () => {
    // 两份**各自独立**的满货架:第一趟归完档压力就掉到第 ② 级了,同一个库跑第二趟
    // 只会得到空闲,那样量的是「安静」不是「不多话」。
    const fresh = async (): Promise<{ lib: KnowledgeLibrary; dir: string; total: number }> => {
      const d = await mkdtemp(join(tmpdir(), 'gotong-kb-bytes-'))
      const l = openKnowledgeLibrary({ dir: d, limits: { maxFiles: LIMITS.maxFiles }, now: () => NOW })
      for (let i = 0; i < 20; i += 1) await l.write(`f${String(i).padStart(2, '0')}.md`, `第 ${i} 份知识`)
      return { lib: l, dir: d, total: (await l.list()).activeBytes }
    }

    // (a) 字节顶收紧到刚好越过提醒线 ⇒ summary 里必须出现那个键名。只说「需要人来
    //     清」等于把成员留在原地——真正能减字节的是 STOR-M3 保留阶梯的
    //     memory_archive_days,它剪的恰好就是这一步刚挪进去的 archive/。
    const a = await fresh()
    try {
      const tight = await knowledgeCoolingReviewer({
        library: a.lib,
        limits: { ...LIMITS, maxTotalBytes: Math.ceil(a.total / 0.9) },
      })({ memory: null as never, episodic: [], now: NOW })
      expect(tight.summary).toMatch(/memory_archive_days/)
    } finally {
      await rm(a.dir, { recursive: true, force: true })
    }

    // (b) 字节宽裕 ⇒ 照常报归档,但一个字都不多说。
    const b = await fresh()
    try {
      const roomy = await knowledgeCoolingReviewer({ library: b.lib, limits: LIMITS })({
        memory: null as never,
        episodic: [],
        now: NOW,
      })
      expect(roomy.summary).toMatch(/知识库降温/)
      expect(roomy.summary).not.toMatch(/memory_archive_days/)
    } finally {
      await rm(b.dir, { recursive: true, force: true })
    }
  })

  it('归档后原文照样读得到,只是多了个 archive/ 前缀', async () => {
    for (let i = 0; i < 20; i += 1) {
      const rel = `f${String(i).padStart(2, '0')}.md`
      await lib.write(rel, `第 ${i} 份的正文`)
      const t = new Date(NOW - (i + 1) * DAY)
      await utimes(join(dir, rel), t, t)
    }
    await knowledgeCoolingReviewer({ library: lib, limits: LIMITS })({
      memory: null as never,
      episodic: [],
      now: NOW,
    })
    const r = await lib.read('archive/f19.md')
    expect(r.text).toBe('第 19 份的正文')
  })

  it('模块正文里没有一行 unlink / rm —— 归档就是 rename', () => {
    // 掐掉顶注(顶注里会提到这些词),只看正文。同 M3c 那条红线断言。
    const body = SRC.split('*/').slice(1).join('*/')
    expect(body).not.toMatch(/\bunlink\b|\brm\s+-|\brmdir\b/)
  })
})

// 用一个真的写者制造「非 .md 杂物」的场景,证明它既不被列出也不被归档。
describe('杂物不参与', () => {
  it('非 .md 文件只报数,不进货架也不被归档', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gotong-kb-stray-'))
    try {
      const lib = openKnowledgeLibrary({ dir, limits: { maxFiles: LIMITS.maxFiles }, now: () => NOW })
      for (let i = 0; i < 18; i += 1) await lib.write(`f${String(i).padStart(2, '0')}.md`, `第 ${i} 份`)
      await writeFile(join(dir, '杂物.txt'), 'not markdown', 'utf8')
      await knowledgeCoolingReviewer({ library: lib, limits: LIMITS })({
        memory: null as never,
        episodic: [],
        now: NOW,
      })
      const l = await lib.list()
      expect(l.strayCount).toBe(1)
      expect(l.files.some((f) => f.path.includes('杂物'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
