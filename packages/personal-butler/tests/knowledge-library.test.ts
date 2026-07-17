/**
 * knowledge-library.test.ts — LIB-M2 纯核单测。
 *
 * 四类承重(里程碑表点名的门):穿越拒(坏路径一律响亮拒且圈外零字节)/
 * 上限响亮拒(三顶各证一次,错误信息带数字)/ tmp+rename(写完无残留)/
 * 归档不丢(挪进 archive/ 后还能读,重名加时间戳共存)。外加杂物如实报数
 * 与工具面 4 件的错误软化(拒绝回文本,绝不炸轮)。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ButlerError } from '../src/errors.js'
import {
  KNOWLEDGE_LIBRARY_LIMITS,
  createKnowledgeLibraryToolset,
  openKnowledgeLibrary,
  validateKnowledgePath,
  type KnowledgeLibrary,
} from '../src/knowledge-library.js'

let parent: string
let dir: string

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'gotong-knowledge-'))
  dir = join(parent, 'knowledge')
})

afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

const openLib = (extra?: Parameters<typeof openKnowledgeLibrary>[0]['limits']): KnowledgeLibrary =>
  openKnowledgeLibrary({ dir, ...(extra ? { limits: extra } : {}) })

async function expectButlerError(p: Promise<unknown>, code: string, contains?: string): Promise<void> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(ButlerError)
    expect((err as ButlerError).code).toBe(code)
    if (contains) expect((err as ButlerError).message).toContain(contains)
    return
  }
  expect.unreachable(`应当抛 ${code},却成功了`)
}

describe('knowledge library 纯核', () => {
  it('写→读→列 round-trip,覆盖不算新建,写完无 .tmp 残留', async () => {
    const lib = openLib()
    const w1 = await lib.write('INDEX.md', '# 索引\n- user/家人.md — 家人档案\n')
    expect(w1.created).toBe(true)
    const w2 = await lib.write('user/家人.md', '妈妈住怡保,只用微信。\n')
    expect(w2.created).toBe(true)

    const r = await lib.read('user/家人.md')
    expect(r.text).toBe('妈妈住怡保,只用微信。\n')
    expect(r.bytes).toBe(w2.bytes)

    const w3 = await lib.write('user/家人.md', '妈妈住怡保,只用微信;弟弟在新加坡。\n')
    expect(w3.created).toBe(false)

    const l = await lib.list()
    expect(l.activeCount).toBe(2)
    expect(l.files.map((f) => f.path)).toEqual(['INDEX.md', 'user/家人.md']) // 路径字典序
    expect(l.archivedCount).toBe(0)
    expect(l.strayCount).toBe(0)
    // tmp+rename:目录里绝无 *.tmp 残留
    expect(readdirSync(join(dir, 'user')).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('穿越拒:坏路径一律 knowledge_invalid,且圈外零字节', async () => {
    const lib = openLib()
    const bad = [
      '../escape.md',
      'a/../escape.md',
      '/etc/passwd.md',
      'a//b.md',
      './x.md',
      '.hidden.md',
      'a/.git/x.md',
      'x.txt',
      'x.md.tmp',
      'a:b.md',
      'a\\b.md',
      'ab.md',
      '.md',
      '',
    ]
    for (const p of bad) {
      await expectButlerError(lib.write(p, '内容'), 'knowledge_invalid')
      await expectButlerError(lib.read(p), 'knowledge_invalid')
    }
    // 圈外零字节:父目录里除 knowledge/ 外什么都没长出来
    expect(readdirSync(parent)).toEqual(existsSync(dir) ? ['knowledge'] : [])
    expect(existsSync(join(parent, 'escape.md'))).toBe(false)
  })

  it('路径长度/深度顶:响亮拒且报数字', async () => {
    const lib = openLib({ maxPathChars: 20, maxDepth: 3 })
    await expectButlerError(lib.write('a/b/c/d.md', 'x'), 'knowledge_invalid', '目录太深')
    await expectButlerError(lib.write(`${'长'.repeat(21)}.md`, 'x'), 'knowledge_invalid', '路径太长')
  })

  it('三顶上限响亮拒:单文件字节/文件数/总字节,错误信息带上限数字', async () => {
    const lib = openLib({ maxFiles: 3, maxFileBytes: 100, maxTotalBytes: 250 })
    // 单文件顶
    await expectButlerError(lib.write('big.md', 'x'.repeat(101)), 'knowledge_limit', '单文件上限 100')
    // 文件数顶:3 份满,第 4 份拒;覆盖既有不受影响
    await lib.write('a.md', 'x'.repeat(80))
    await lib.write('b.md', 'x'.repeat(80))
    await lib.write('c.md', 'x'.repeat(80))
    await expectButlerError(lib.write('d.md', 'x'), 'knowledge_limit', '上限 3')
    await expect(lib.write('a.md', 'y'.repeat(80))).resolves.toMatchObject({ created: false })
    // 总字节顶:库存 240,c.md 从 80 字节改写成 95 → 总量 255 > 250 → 拒
    await expectButlerError(lib.write('c.md', 'x'.repeat(95)), 'knowledge_limit', '总量上限 250')
  })

  it('归档:挪进 archive/ 不真删还能读;INDEX.md 拒;重名加时间戳共存', async () => {
    const lib = openKnowledgeLibrary({ dir, now: () => 1234567 })
    await lib.write('INDEX.md', '# 索引\n')
    await lib.write('projects/装修.md', '预算 3 万令吉。\n')

    const a1 = await lib.archive('projects/装修.md')
    expect(a1).toEqual({ from: 'projects/装修.md', to: 'archive/projects/装修.md' })
    expect((await lib.read('archive/projects/装修.md')).text).toBe('预算 3 万令吉。\n')

    const l = await lib.list()
    expect(l.activeCount).toBe(1) // 只剩 INDEX.md
    expect(l.archivedCount).toBe(1)
    expect(l.files.find((f) => f.archived)?.path).toBe('archive/projects/装修.md')

    // 同名新文件再归档 → 不覆盖历史,时间戳共存
    await lib.write('projects/装修.md', '二期:换橱柜。\n')
    const a2 = await lib.archive('projects/装修.md')
    expect(a2.to).toBe('archive/projects/装修-1234567.md')
    expect((await lib.read('archive/projects/装修-1234567.md')).text).toBe('二期:换橱柜。\n')

    await expectButlerError(lib.archive('INDEX.md'), 'knowledge_invalid', '不归档')
    await expectButlerError(lib.archive('archive/projects/装修.md'), 'knowledge_invalid', '已经在归档区')
    await expectButlerError(lib.archive('projects/不存在.md'), 'knowledge_not_found')
    // 归档区不直接写
    await expectButlerError(lib.write('archive/新.md', 'x'), 'knowledge_invalid', '归档区不直接写')
  })

  it('杂物如实报数不上列表;symlink 不列不读', async () => {
    const lib = openLib()
    await lib.write('a.md', '内容 A')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'stray.txt'), 'not md')
    writeFileSync(join(dir, '.DS_Store'), 'junk')
    writeFileSync(join(parent, 'outside.md'), '圈外文件')
    symlinkSync(join(parent, 'outside.md'), join(dir, 'link.md'))

    const l = await lib.list()
    expect(l.files.map((f) => f.path)).toEqual(['a.md'])
    expect(l.strayCount).toBe(3) // stray.txt + .DS_Store + link.md
    await expectButlerError(lib.read('link.md'), 'knowledge_invalid', '链接')
    // 覆盖 symlink 也拒 —— 写穿链接会改到圈外
    await expectButlerError(lib.write('link.md', 'x'), 'knowledge_invalid', '链接')
  })

  it('读不存在的文件:knowledge_not_found 并指路 list', async () => {
    const lib = openLib()
    await expectButlerError(lib.read('user/没有.md'), 'knowledge_not_found', 'list_knowledge_files')
  })

  it('并发写不同路径:promise 链串行,两份都完好', async () => {
    const lib = openLib()
    await Promise.all([lib.write('x.md', 'X 的内容'), lib.write('y.md', 'Y 的内容')])
    expect((await lib.read('x.md')).text).toBe('X 的内容')
    expect((await lib.read('y.md')).text).toBe('Y 的内容')
  })
})

describe('knowledge library 工具面', () => {
  it('4 个工具定义齐全,写/列/读/归档全链路走 callTool', async () => {
    const toolset = createKnowledgeLibraryToolset(openKnowledgeLibrary({ dir, now: () => 42 }))
    expect(toolset.listTools().map((t) => t.name)).toEqual([
      'list_knowledge_files',
      'read_knowledge_file',
      'write_knowledge_file',
      'archive_knowledge_file',
    ])

    const empty = await toolset.callTool('list_knowledge_files', {})
    expect(empty.content[0]!.text).toContain('知识库是空的')

    const w = await toolset.callTool('write_knowledge_file', {
      path: 'user/偏好.md',
      content: '珍珠奶茶;下午三点后不喝咖啡。',
    })
    expect(w.isError).toBeUndefined()
    expect(w.content[0]!.text).toContain('已新建「user/偏好.md」')
    expect(w.content[0]!.text).toContain('INDEX.md') // filing 纪律:提醒更新索引

    // 写 INDEX.md 本身不再自我提醒
    const wi = await toolset.callTool('write_knowledge_file', { path: 'INDEX.md', content: '# 索引\n' })
    expect(wi.content[0]!.text).not.toContain('记得更新')

    const l = await toolset.callTool('list_knowledge_files', {})
    expect(l.content[0]!.text).toContain('user/偏好.md')
    expect(l.content[0]!.text).toContain('共 2 份')

    const r = await toolset.callTool('read_knowledge_file', { path: 'user/偏好.md' })
    expect(r.content[0]!.text).toContain('珍珠奶茶')

    const a = await toolset.callTool('archive_knowledge_file', { path: 'user/偏好.md' })
    expect(a.content[0]!.text).toContain('已归档「user/偏好.md」→「archive/user/偏好.md」')

    const l2 = await toolset.callTool('list_knowledge_files', {})
    expect(l2.content[0]!.text).toContain('归档区另有 1 份')
  })

  it('拒绝走文本不炸轮:坏路径/超限/未知工具都是 isError 文本', async () => {
    const toolset = createKnowledgeLibraryToolset(
      openKnowledgeLibrary({ dir, limits: { maxFileBytes: 10 } }),
    )
    const bad = await toolset.callTool('write_knowledge_file', { path: '../逃.md', content: 'x' })
    expect(bad.isError).toBe(true)
    expect(bad.content[0]!.text).toContain('路径')

    const big = await toolset.callTool('write_knowledge_file', {
      path: 'a.md',
      content: 'x'.repeat(11),
    })
    expect(big.isError).toBe(true)
    expect(big.content[0]!.text).toContain('单文件上限 10')

    const unknown = await toolset.callTool('nope', {})
    expect(unknown.isError).toBe(true)
  })

  it('生产上限常量没被悄悄改小(设计立场钉死)', () => {
    expect(KNOWLEDGE_LIBRARY_LIMITS.maxFiles).toBeGreaterThanOrEqual(100)
    expect(KNOWLEDGE_LIBRARY_LIMITS.maxFileBytes).toBeGreaterThanOrEqual(16 * 1024)
    expect(KNOWLEDGE_LIBRARY_LIMITS.maxTotalBytes).toBeGreaterThanOrEqual(1024 * 1024)
    // 验证器拿默认常量正常放行一个典型路径
    expect(validateKnowledgePath('user/家人.md', KNOWLEDGE_LIBRARY_LIMITS)).toEqual(['user', '家人.md'])
  })
})
