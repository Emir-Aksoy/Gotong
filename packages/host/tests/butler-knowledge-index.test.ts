/**
 * butler-knowledge-index.test.ts — LIB-M3 索引卡承重门。
 *
 * 三道承重(里程碑表点名):
 *   1. **≤500tk 门**:超预算的 INDEX.md 渲染出的卡在 LIB-M1 同一把尺
 *      (estimateTokens)下 ≤ 预算——"常驻段字节不随知识总量长"的字面保证。
 *   2. **字节不变防腐**:无文件 / 空文件 / 读失败 → null → agent 不注入 →
 *      prompt 字节不变(探针「无信号 = null」同款契约)。
 *   3. **截断诚实**(no silent caps):超预算按行截断必带响亮标记(含 N/M
 *      行数),保留的行必须是完整行(半行 = 假路径),标记本身也在预算内。
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openKnowledgeLibrary, type KnowledgeLibrary } from '@gotong/personal-butler'

import {
  KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS,
  buildButlerKnowledgeIndexCard,
  renderKnowledgeIndexCard,
} from '../src/butler-knowledge-index.js'
import { estimateTokens } from '../src/butler-toolface-report.js'

let parent: string
let dir: string
let library: KnowledgeLibrary

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'gotong-kidx-'))
  dir = join(parent, 'knowledge')
  library = openKnowledgeLibrary({ dir })
})

afterEach(async () => {
  await rm(parent, { recursive: true, force: true })
})

/** 一行代表性索引条目(CJK 为主,~30 字/行)。 */
function indexLine(i: number): string {
  return `- projects/装修-${String(i).padStart(3, '0')}.md — 老家厨房翻新的预算票据与工头交接记录`
}

describe('LIB-M3 索引卡 — 空态与失败姿态(字节不变的另一半)', () => {
  it('无 INDEX.md → null(常态空库,不是错误)', async () => {
    const card = buildButlerKnowledgeIndexCard({ library })
    expect(await card()).toBeNull()
  })

  it('INDEX.md 全空白 → null(空索引不占常驻段一个字节)', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'INDEX.md'), '  \n\t\n', 'utf8')
    const card = buildButlerKnowledgeIndexCard({ library })
    expect(await card()).toBeNull()
  })

  it('读失败(symlink 拒)→ null 降级 + warn 恰好一次(顾问绝不拖垮聊天轮)', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(parent, 'outside.md'), '圈外', 'utf8')
    await symlink(join(parent, 'outside.md'), join(dir, 'INDEX.md'))
    const warns: string[] = []
    const card = buildButlerKnowledgeIndexCard({
      library,
      logger: { warn: (msg) => warns.push(msg) },
    })
    expect(await card()).toBeNull()
    expect(await card()).toBeNull() // 第二轮同样降级
    expect(warns.length).toBe(1) // 只报一次,不刷屏
  })

  it('无文件的 not_found 不算病:零 warn', async () => {
    const warns: string[] = []
    const card = buildButlerKnowledgeIndexCard({ library, logger: { warn: (m) => warns.push(m) } })
    expect(await card()).toBeNull()
    expect(warns).toEqual([])
  })
})

describe('LIB-M3 索引卡 — 正常态与预算门', () => {
  it('预算内:卡 = 头 + 正文逐字,无截断标记,现读现新鲜', async () => {
    await library.write('INDEX.md', '# 我的知识\n- user/家人.md — 家人档案\n- projects/装修.md — 厨房翻新\n')
    const card = buildButlerKnowledgeIndexCard({ library })
    const text = (await card())!
    expect(text).toContain('【知识库索引】')
    expect(text).toContain('- user/家人.md — 家人档案')
    expect(text).toContain('- projects/装修.md — 厨房翻新')
    expect(text).not.toContain('超出注入预算')
    expect(estimateTokens(text)).toBeLessThanOrEqual(KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS)

    // 阿同重写索引 → 下一轮的卡立刻是新字节(新鲜度即文件本身)。
    await library.write('INDEX.md', '# 我的知识(重排)\n- people/妈妈.md — 妈妈的偏好\n')
    const next = (await card())!
    expect(next).toContain('people/妈妈.md')
    expect(next).not.toContain('装修')
  })

  it('≤500tk 承重门:胖索引(远超预算)渲染出的卡仍在预算内,截断行完整', async () => {
    const lines = Array.from({ length: 120 }, (_, i) => indexLine(i)) // ~3600 CJK 字
    await library.write('INDEX.md', lines.join('\n'))
    const rawTokens = estimateTokens(lines.join('\n'))
    expect(rawTokens).toBeGreaterThan(KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS * 5) // fixture 真的胖

    const text = (await buildButlerKnowledgeIndexCard({ library })())!
    expect(estimateTokens(text)).toBeLessThanOrEqual(KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS)
    // 响亮标记:带「前 N/120 行」与指路精简。
    expect(text).toMatch(/只显示前 \d+\/120 行/)
    expect(text).toContain('精简 INDEX.md')
    // 保留的每一行都是源文件的完整行(半行截断 = 假路径,绝不允许)。
    const bodyLines = text.split('\n').slice(1, -1) // 掐头(卡头)去尾(标记)
    const source = new Set(lines)
    for (const l of bodyLines) expect(source.has(l), `截断产出了半行:${l}`).toBe(true)
    expect(bodyLines.length).toBeGreaterThan(5) // 截断保导航,不是整卡丢弃
  })

  it('标记本身也在预算内(会把预算吹爆的封顶不叫封顶)', () => {
    const lines = Array.from({ length: 40 }, (_, i) => indexLine(i))
    const budget = 120 // 头+标记地板 ~70tk,只给一两行的余量
    const text = renderKnowledgeIndexCard(lines.join('\n'), budget)
    expect(estimateTokens(text)).toBeLessThanOrEqual(budget)
    expect(text).toMatch(/只显示前 \d+\/40 行/)
  })

  it('极端:第一行就超余量 → 只出头+标记(前 0/N 行),仍不超预算', () => {
    const fat = '一'.repeat(600) // 单行 600 CJK ≈ 600tk
    const text = renderKnowledgeIndexCard(fat, 200)
    expect(estimateTokens(text)).toBeLessThanOrEqual(200)
    expect(text).toContain('只显示前 0/1 行')
  })

  it('生产预算常量钉死 500(M0 计划的数字,改小改大都该有人看见)', () => {
    expect(KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS).toBe(500)
  })
})
