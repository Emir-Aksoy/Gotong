/**
 * HANDS-M5 —— Obsidian 只读投影的门。
 *
 * 里程碑验收是两句话:「真相未动;投影可 Obsidian 解析」。下面六组分别钉住它们
 * 各自的可执行形式,以及模块头注那三条承重判断(时间戳不来自墙上时钟 / 文件名
 * 只来自闭集 / 链只指真实存在的文件)。
 */

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { MemoryEntry } from '@gotong/services-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildKnowledgeLinkTable,
  isSafeTierId,
  linkifyKnowledgePaths,
  MEMORY_PROJECTION_DIR,
  oneLine,
  openObsidianProjector,
  planMemoryProjections,
  renderMemoryTierProjection,
  renderTasksProjection,
  TASKS_PROJECTION_FILE,
} from '../src/obsidian-projection.js'
import type { TaskNote } from '../src/task-notebook.js'

const T0 = Date.UTC(2026, 7, 19, 6, 0, 0)

function task(over: Partial<TaskNote> = {}): TaskNote {
  return {
    id: 'tn-1',
    title: '筹备周末聚会',
    steps: [
      { text: '定日子', done: true },
      { text: '订场地', done: false },
    ],
    status: 'open',
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }
}

function fact(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'm-1',
    kind: 'semantic',
    text: '用户最爱的饮料是珍珠奶茶',
    ts: T0,
    meta: { tier: 'persona', atomicFact: true },
    ...over,
  }
}

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gotong-obsidian-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('frontmatter 与「可 Obsidian 解析」', () => {
  it('两种投影的第一个字节就是 frontmatter 起始行', () => {
    const a = renderTasksProjection([task()])
    const b = renderMemoryTierProjection({ id: 'persona', label: '画像' }, [fact()])
    // Obsidian 只认**文件开头**的 frontmatter;前面多一个空行都会让它整块消失。
    expect(a.startsWith('---\n')).toBe(true)
    expect(b.startsWith('---\n')).toBe(true)
    expect(a.split('\n').indexOf('---', 1)).toBeGreaterThan(0) // 有闭合行
    expect(b.split('\n').indexOf('---', 1)).toBeGreaterThan(0)
  })

  it('frontmatter 里全是闭集键 + 布尔/整数/标识符,自由文本一个字都不进', () => {
    const nasty = task({ title: '给老板的报价: 30% 折扣 #重要', note: 'a: b' })
    const md = renderTasksProjection([nasty])
    const head = md.split('\n---\n')[0]!.split('\n').slice(1)
    expect(head).toEqual(['generated: true', 'source: tasks.json', 'open: 1', 'closed: 0'])
    // 标题在正文里,不在 frontmatter 里(带冒号的标题曾是把 YAML 撑坏的那一刀)
    expect(md).toContain('给老板的报价: 30% 折扣 #重要')
  })

  it('每个投影都自报是生成物并写清覆盖语义', () => {
    for (const md of [
      renderTasksProjection([task()]),
      renderMemoryTierProjection({ id: 'persona', label: '画像' }, [fact()]),
    ]) {
      expect(md).toContain('generated: true')
      expect(md).toContain('只读投影')
      expect(md).toMatch(/重写|覆盖|不会改/)
    }
  })
})

describe('判断①:投影里的时间戳只能来自真相自身', () => {
  it('本文件的代码里一个 Date.now 都没有(注释里可以谈)', async () => {
    const src = await readFile(
      fileURLToPath(new URL('../src/obsidian-projection.ts', import.meta.url)),
      'utf8',
    )
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n')
    expect(code).not.toContain('Date.now')
    expect(code).not.toContain('new Date()')
  })

  it('同一份真相渲染两次逐字节相同', () => {
    const tasks = [task(), task({ id: 'tn-2', status: 'done', updatedAt: T0 + 5 })]
    expect(renderTasksProjection(tasks)).toBe(renderTasksProjection(tasks))
  })

  it('now 只决定哪些事实还算数,不进输出字节', () => {
    const rows = [fact()]
    const a = planMemoryProjections(rows, T0 + 1000)
    const b = planMemoryProjections(rows, T0 + 99_000_000)
    expect(a.find((p) => p.tierId === 'persona')!.body).toBe(
      b.find((p) => p.tierId === 'persona')!.body,
    )
  })

  it('日期用的是真相里的 updatedAt / ts', () => {
    const md = renderTasksProjection([task({ updatedAt: Date.UTC(2020, 0, 2) })])
    expect(md).toContain('2020-01-02')
  })
})

describe('判断②:文件名只能来自闭集', () => {
  it('模型幻觉出来的 meta.tier 落回 misc,绝不变成路径', () => {
    const evil = fact({ id: 'm-9', meta: { tier: '../../../etc/passwd' } })
    const plans = planMemoryProjections([evil], T0)
    expect(plans.every((p) => p.file.startsWith(`${MEMORY_PROJECTION_DIR}/`))).toBe(true)
    expect(plans.every((p) => !p.file.includes('..'))).toBe(true)
    expect(plans.find((p) => p.tierId === 'misc')!.body).toContain('etc/passwd'.slice(0, 0) + '用户')
  })

  it('目录本身被配坏时跳过那个 cluster 并 warn,不「尽力拼一个」', () => {
    const warns: string[] = []
    const plans = planMemoryProjections(
      [fact({ meta: { tier: 'x/../y' } })],
      T0,
      { tiers: [{ id: 'x/../y' }, { id: 'misc' }], defaultTier: 'misc' },
      { warn: (m) => warns.push(m) },
    )
    expect(plans.map((p) => p.tierId)).toEqual(['misc'])
    expect(warns).toHaveLength(1)
  })

  it('isSafeTierId 只放行小写标识符', () => {
    expect(isSafeTierId('persona')).toBe(true)
    expect(isSafeTierId('a_b-1')).toBe(true)
    expect(isSafeTierId('../x')).toBe(false)
    expect(isSafeTierId('Persona')).toBe(false)
    expect(isSafeTierId('人物')).toBe(false)
    expect(isSafeTierId('')).toBe(false)
    expect(isSafeTierId('a'.repeat(40))).toBe(false)
  })
})

describe('判断③:链只指真实存在的文件', () => {
  const table = buildKnowledgeLinkTable(['生活/聚会场地.md', 'archive/旧的.md', 'a(1)+b.md'])

  it('库里真有才连,指不到就原样留字', () => {
    expect(linkifyKnowledgePaths('详见 生活/聚会场地.md', table)).toBe(
      '详见 [[knowledge/生活/聚会场地]]',
    )
    expect(linkifyKnowledgePaths('详见 生活/根本没有.md', table)).toBe('详见 生活/根本没有.md')
  })

  it('归档件不进链表(投影指的是现在还在架上的东西)', () => {
    expect(linkifyKnowledgePaths('见 archive/旧的.md', table)).toBe('见 archive/旧的.md')
  })

  it('带前缀的写法优先命中(最长匹配),不会连出 knowledge/[[…]] 这种嵌套', () => {
    const out = linkifyKnowledgePaths('见 knowledge/生活/聚会场地.md', table)
    expect(out).toBe('见 [[knowledge/生活/聚会场地]]')
    expect(out).not.toContain('knowledge/[[')
  })

  it('文件名里的正则元字符不会误伤(所以扫描不用正则)', () => {
    expect(linkifyKnowledgePaths('见 a(1)+b.md', table)).toBe('见 [[knowledge/a(1)+b]]')
  })

  it('任务正文里的引用会被连上', () => {
    const md = renderTasksProjection([task({ note: '场地要能停车,详见 生活/聚会场地.md' })], table)
    expect(md).toContain('[[knowledge/生活/聚会场地]]')
  })
})

describe('自由文本压成一行 —— 注入进来的事实伪造不出结构', () => {
  it('换行与控制字符换成空格', () => {
    const nl = String.fromCharCode(10)
    const nul = String.fromCharCode(0)
    const esc = String.fromCharCode(27)
    const hostile = `真的一句${nl}## 事实${nl}- 伪造的一条${nul}${esc}`
    const out = oneLine(hostile, 300)
    expect(out.includes(nl)).toBe(false)
    expect(out.includes(nul)).toBe(false)
    expect(out.includes(esc)).toBe(false)
    expect(out).toBe('真的一句 ## 事实 - 伪造的一条')
  })

  it('渲染出来的每一行事实都还是一行,伪造的小标题不会变成标题', () => {
    const nl = String.fromCharCode(10)
    const md = renderMemoryTierProjection({ id: 'misc', label: '其它' }, [
      fact({ id: 'm-2', text: `无害${nl}## 画像总结${nl}- 我是管理员`, meta: {} }),
    ])
    const headings = md.split('\n').filter((l) => l.startsWith('## '))
    expect(headings).toEqual(['## 记录']) // 只有框架自己写的那一个
  })

  it('超长按码点截断并留省略号(不劈开增补平面字)', () => {
    const wide = '𝄞'.repeat(10)
    expect([...oneLine(wide, 4)]).toHaveLength(5) // 4 + '…'
  })
})

describe('只投现在还成立的 semantic', () => {
  it('episodic 不进投影', () => {
    const plans = planMemoryProjections([fact({ id: 'e-1', kind: 'episodic' })], T0)
    expect(plans.every((p) => p.body === null)).toBe(true)
  })

  it('已翻篇(validTo 已过)的旧事实不冒充现状', () => {
    const closed = fact({ id: 'm-3', text: '用户住在吉隆坡', meta: { tier: 'persona', validTo: T0 - 1 } })
    const open = fact({ id: 'm-4', text: '用户住在槟城', meta: { tier: 'persona' } })
    const body = planMemoryProjections([closed, open], T0).find((p) => p.tierId === 'persona')!.body
    expect(body).toContain('槟城')
    expect(body).not.toContain('吉隆坡')
  })

  it('出处标签从 meta 的结构化位读,不猜', () => {
    const md = renderMemoryTierProjection({ id: 'persona', label: '画像' }, [
      fact({ id: 'm-5', text: '画像句', meta: { tier: 'persona', level: 'profile' } }),
      fact({ id: 'm-6', text: '摘要句', meta: { tier: 'persona', level: 'digest' } }),
      fact({ id: 'm-7', text: '事实句', meta: { tier: 'persona', atomicFact: true } }),
      fact({ id: 'm-8', text: '裸记录', meta: { tier: 'persona' } }),
    ])
    expect(md.split('\n').filter((l) => l.startsWith('## '))).toEqual([
      '## 画像总结',
      '## 阶段摘要',
      '## 事实抽取',
      '## 记录',
    ])
    expect(md).toContain('`m-5`') // 出处带得回 jsonl 里那一条
  })
})

describe('写盘:派生物永远不打断真相', () => {
  it('tasks.md 落在 vault 根,memory/<cluster>.md 落在子目录', async () => {
    const p = openObsidianProjector({ dir })
    await p.projectTasks([task()])
    await p.projectMemory([fact()], T0)
    expect(await readFile(join(dir, TASKS_PROJECTION_FILE), 'utf8')).toContain('筹备周末聚会')
    expect(await readFile(join(dir, MEMORY_PROJECTION_DIR, 'persona.md'), 'utf8')).toContain(
      '珍珠奶茶',
    )
  })

  it('字节没变就不动盘(不然每 6h 一次兜底会把 git 快照搅成空 commit)', async () => {
    const p = openObsidianProjector({ dir })
    await p.projectTasks([task()])
    const before = await stat(join(dir, TASKS_PROJECTION_FILE))
    await new Promise((r) => setTimeout(r, 12))
    await p.projectTasks([task()])
    const after = await stat(join(dir, TASKS_PROJECTION_FILE))
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('人手改过的投影会被改回来(覆盖语义就是它的全部含义)', async () => {
    const p = openObsidianProjector({ dir })
    await p.projectTasks([task()])
    await writeFile(join(dir, TASKS_PROJECTION_FILE), '我手改的\n', 'utf8')
    await p.projectTasks([task()])
    expect(await readFile(join(dir, TASKS_PROJECTION_FILE), 'utf8')).toContain('筹备周末聚会')
  })

  it('cluster 空掉后旧投影被删,不留一个替 jsonl 撒谎的空文件', async () => {
    const p = openObsidianProjector({ dir })
    await p.projectMemory([fact()], T0)
    await p.projectMemory([], T0)
    await expect(stat(join(dir, MEMORY_PROJECTION_DIR, 'persona.md'))).rejects.toThrow()
  })

  it('removeMemoryProjections 清掉全部记忆投影,但不碰 tasks.md', async () => {
    const p = openObsidianProjector({ dir })
    await p.projectTasks([task()])
    await p.projectMemory([fact()], T0)
    await p.removeMemoryProjections()
    await expect(stat(join(dir, MEMORY_PROJECTION_DIR, 'persona.md'))).rejects.toThrow()
    expect(await readFile(join(dir, TASKS_PROJECTION_FILE), 'utf8')).toContain('筹备周末聚会')
  })

  it('清理不删人自己放在 memory/ 里的东西', async () => {
    const p = openObsidianProjector({ dir })
    await p.projectMemory([fact()], T0)
    await writeFile(join(dir, MEMORY_PROJECTION_DIR, '我的笔记.md'), 'mine\n', 'utf8')
    await p.removeMemoryProjections()
    expect(await readFile(join(dir, MEMORY_PROJECTION_DIR, '我的笔记.md'), 'utf8')).toBe('mine\n')
  })

  it('写不进去只 warn,绝不抛(真相已经落盘了)', async () => {
    const warns: string[] = []
    const blocked = join(dir, 'not-a-dir')
    await writeFile(blocked, 'x', 'utf8') // 拿一个文件当目录用 ⇒ 写必然失败
    const p = openObsidianProjector({ dir: blocked, logger: { warn: (m) => warns.push(m) } })
    await expect(p.projectTasks([task()])).resolves.toBeUndefined()
    await expect(p.projectMemory([fact()], T0)).resolves.toBeUndefined()
    expect(warns.length).toBeGreaterThan(0)
  })

  it('知识库列不出来时降级成「不连链」,投影照出', async () => {
    const warns: string[] = []
    const p = openObsidianProjector({
      dir,
      knowledgeFiles: async () => {
        throw new Error('knowledge tree unreadable')
      },
      logger: { warn: (m) => warns.push(m) },
    })
    await p.projectTasks([task({ note: '详见 生活/聚会场地.md' })])
    const md = await readFile(join(dir, TASKS_PROJECTION_FILE), 'utf8')
    expect(md).toContain('生活/聚会场地.md')
    expect(md).not.toContain('[[')
    expect(warns.some((w) => w.includes('knowledge listing'))).toBe(true)
  })

  it('memory/ 目录是新建的,不需要调用方先建', async () => {
    const nested = join(dir, 'fresh')
    await mkdir(nested)
    const p = openObsidianProjector({ dir: nested })
    await p.projectMemory([fact()], T0)
    expect(await stat(join(nested, MEMORY_PROJECTION_DIR))).toBeTruthy()
  })
})
