import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LlmAgentToolset, LlmToolCallResult } from '@gotong/llm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DOCUMENT_LIMITS, documentBlockCount, type DocumentSection, type DocumentSpec } from '../src/butler-document-spec.js'
import type { ButlerFilePushResult, ButlerFileReach, ButlerMemberFiles } from '../src/butler-reachable.js'
import { buildButlerDocumentToolset, WRITE_DOCUMENT_TOOL } from '../src/personal-butler-documents.js'
import { estimateTokens } from '../src/butler-toolface-report.js'

const DAY = 24 * 60 * 60 * 1000

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gotong-doc-tool-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

interface Harness {
  tool: LlmAgentToolset
  sent: Array<{ userId: string; filename: string; bytes: Uint8Array }>
  rendered: DocumentSpec[]
  files: FakeFiles
  setRender(fn: (spec: DocumentSpec) => Promise<Uint8Array>): void
}

class FakeFiles implements ButlerMemberFiles {
  reach: ButlerFileReach = { ok: true }
  nextPush: ButlerFilePushResult | null = null
  sent: Array<{ userId: string; filename: string; bytes: Uint8Array }> = []
  canPush(): ButlerFileReach {
    return this.reach
  }
  async push(userId: string, file: { bytes: Buffer | Uint8Array; filename: string }): Promise<ButlerFilePushResult> {
    if (this.nextPush) {
      const out = this.nextPush
      this.nextPush = null
      return out
    }
    this.sent.push({ userId, filename: file.filename, bytes: file.bytes })
    return { delivered: true }
  }
}

function harness(userId = 'alice', opts: { files?: FakeFiles | null; now?: () => number } = {}): Harness {
  const files = opts.files === undefined ? new FakeFiles() : opts.files
  const rendered: DocumentSpec[] = []
  let render = async (spec: DocumentSpec): Promise<Uint8Array> => {
    rendered.push(spec)
    return new Uint8Array([0x50, 0x4b, 3, 4])
  }
  const tool = buildButlerDocumentToolset({
    userId,
    root,
    files: () => files ?? undefined,
    render: (spec) => render(spec),
    ...(opts.now ? { now: opts.now } : {}),
  })
  return {
    tool,
    get sent() {
      return files?.sent ?? []
    },
    rendered,
    files: files as FakeFiles,
    setRender: (fn) => {
      render = fn
    },
  }
}

const call = (h: Harness, args: Record<string, unknown>): Promise<LlmToolCallResult> => h.tool.callTool('write_document', args) as Promise<LlmToolCallResult>
const textOf = (r: LlmToolCallResult): string => r.content.map((c) => ('text' in c ? c.text : '')).join('')
const draftIdOf = (r: LlmToolCallResult): string => {
  const id = textOf(r).match(/d_[0-9a-f]{16}/)?.[0]
  if (!id) throw new Error(`no draft id in: ${textOf(r)}`)
  return id
}
const userDir = (userId = 'alice'): string => join(root, 'user', userId)
const NEW = { format: 'pptx', title: '季度复盘' }
const SECTION = { heading: '一', bullets: ['二'] }

describe('write_document 一次成稿', () => {
  it('一次调用生成并发送,结果说明发到私聊', async () => {
    const h = harness()
    const r = await call(h, { ...NEW, sections: [SECTION], finish: true })
    expect(r.isError).toBeUndefined()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({ userId: 'alice', filename: '季度复盘.pptx' })
    expect(textOf(r)).toContain('飞书私聊')
    expect(textOf(r)).toContain('在群里触发也只发私聊')
    expect(h.rendered[0]).toEqual({ format: 'pptx', title: '季度复盘', theme: 'business', sections: [SECTION] })
  })

  it('Word 里的图表如实说明', async () => {
    const h = harness()
    const chart = { type: 'bar', labels: ['a'], series: [{ name: 's', values: [1] }] }
    const r = await call(h, { format: 'docx', title: '报告', sections: [{ chart }], finish: true })
    expect(h.sent[0]?.filename).toBe('报告.docx')
    expect(textOf(r)).toContain('已转成数据表格')
  })

  it('字符串形式的 finish 也算,弱模型常这么传', async () => {
    const h = harness()
    await call(h, { ...NEW, sections: [SECTION], finish: 'true' })
    expect(h.sent).toHaveLength(1)
  })
})

describe('write_document 分批续写(验收 3)', () => {
  it('新建 → 追加 → 完成,重建工具实例后草稿不丢', async () => {
    const h1 = harness()
    const created = await call(h1, { ...NEW, subtitle: '副标题', theme: 'warm' })
    const id = draftIdOf(created)
    expect(h1.sent).toHaveLength(0)

    await call(h1, { draft_id: id, sections: [{ heading: '第一章' }] })

    // 模拟重启:新的工具实例,没有任何内存状态。
    const h2 = harness()
    const appended = await call(h2, { draft_id: id, sections: [{ heading: '第二章', bullets: ['要点'] }] })
    expect(textOf(appended)).toContain('2 节')

    const done = await call(h2, { draft_id: id, finish: true })
    expect(done.isError).toBeUndefined()
    expect(h2.rendered[0]).toEqual({
      format: 'pptx',
      title: '季度复盘',
      subtitle: '副标题',
      theme: 'warm',
      sections: [{ heading: '第一章' }, { heading: '第二章', bullets: ['要点'] }],
    })
    expect(h2.sent).toHaveLength(1)
  })

  it('续写可以改标题和主题,不能改格式', async () => {
    const h = harness()
    const id = draftIdOf(await call(h, NEW))
    await call(h, { draft_id: id, title: '新标题', theme: 'dark' })
    const bad = await call(h, { draft_id: id, format: 'docx' })
    expect(bad.isError).toBe(true)
    await call(h, { draft_id: id, sections: [SECTION], finish: true })
    expect(h.rendered[0]).toMatchObject({ title: '新标题', theme: 'dark', format: 'pptx' })
  })

  it('同一批 sections 重传不会让内容出现两次', async () => {
    const h = harness()
    const id = draftIdOf(await call(h, NEW))
    await call(h, { draft_id: id, sections: [{ heading: '甲' }] })
    const retried = await call(h, { draft_id: id, sections: [{ heading: '甲' }] })
    expect(textOf(retried)).toContain('没有重复追加')
    await call(h, { draft_id: id, sections: [{ heading: '乙' }], finish: true })
    expect(h.rendered[0]?.sections.map((s) => s.heading)).toEqual(['甲', '乙'])
  })

  it('并发追加不丢内容,并发 finish 只发一次', async () => {
    const h = harness()
    const id = draftIdOf(await call(h, NEW))
    await Promise.all(Array.from({ length: 8 }, (_, i) => call(h, { draft_id: id, sections: [{ heading: `节 ${i}` }] })))
    const results = await Promise.all([call(h, { draft_id: id, finish: true }), call(h, { draft_id: id, finish: true })])
    expect(h.sent).toHaveLength(1)
    expect(h.rendered[0]?.sections).toHaveLength(8)
    expect(results.every((r) => r.isError === undefined)).toBe(true)
  })

  it('没有内容不能 finish', async () => {
    const h = harness()
    const r = await call(h, { ...NEW, finish: true })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('还没有内容')
    expect(h.sent).toHaveLength(0)
  })
})

describe('write_document 只到本人(验收 6)', () => {
  it('schema 没有任何收件人字段', () => {
    const keys = JSON.stringify(WRITE_DOCUMENT_TOOL.inputSchema)
    for (const banned of ['to', 'recipient', 'receiver', 'chat', 'user', 'target', 'email', 'open_id', 'receive_id']) {
      expect(keys).not.toMatch(new RegExp(`"${banned}[a-z_]*":`, 'i'))
    }
    expect(Object.keys((WRITE_DOCUMENT_TOOL.inputSchema as { properties: object }).properties).sort()).toEqual(
      ['draft_id', 'finish', 'format', 'sections', 'subtitle', 'theme', 'title'].sort(),
    )
  })

  it('模型硬塞收件人字段被拒,不会被忽略后发出去', async () => {
    const h = harness()
    const r = await call(h, { ...NEW, sections: [SECTION], finish: true, to: 'ou_someone_else' })
    expect(r.isError).toBe(true)
    expect(h.sent).toHaveLength(0)
  })

  it('成员之间草稿隔离', async () => {
    const alice = harness('alice')
    const id = draftIdOf(await call(alice, { ...NEW, sections: [SECTION] }))
    const bob = harness('bob')
    const r = await call(bob, { draft_id: id, finish: true })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('不存在')
    expect(bob.sent).toHaveLength(0)
    // bob 的调用没有碰到 alice 的草稿。
    const done = await call(alice, { draft_id: id, finish: true })
    expect(done.isError).toBeUndefined()
    expect(alice.sent[0]?.userId).toBe('alice')
  })

  it.each([
    '../../etc/passwd',
    '../bob/d_0123456789abcdef',
    'd_0123456789abcdef/../../x',
    'd_0123456789abcdef.sent',
    'd_0123456789ABCDEF',
    'd_',
    '',
    '.',
    '..',
    'd_0123456789abcdef\u0000',
    42,
    {},
  ])('draft_id 路径穿越被拒:%j', async (draftId) => {
    const secret = join(root, 'secret.json')
    writeFileSync(secret, '{"title":"秘密"}')
    const h = harness()
    const r = await call(h, { draft_id: draftId, finish: true })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('draft_id')
    expect(textOf(r)).not.toContain('秘密')
    expect(h.sent).toHaveLength(0)
  })

  it('不安全的 userId 构造时就拒绝', () => {
    expect(() => buildButlerDocumentToolset({ userId: '../evil', root, files: () => undefined })).toThrow()
  })

  it('盘上文件名不含成员内容', async () => {
    const h = harness()
    await call(h, { format: 'pptx', title: '机密项目名', sections: [SECTION] })
    const names = readdirSync(userDir())
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^d_[0-9a-f]{16}\.json$/)
  })
})

describe('write_document 失败不撒谎(验收 7)', () => {
  it.each([
    ['unknown_member', '还没绑定飞书'],
    ['no_bridge', '连接现在不可用'],
    ['unsupported', '不支持收文件'],
  ] as const)('%s:第一次调用就说明,不让模型白写', async (reason, phrase) => {
    const h = harness()
    h.files.reach = { ok: false, reason }
    const r = await call(h, { ...NEW, sections: [SECTION] })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain(phrase)
    expect(textOf(r)).not.toContain('已发')
    expect(existsSync(userDir())).toBe(false)
  })

  it('没有接聊天平台时也如实说', async () => {
    const h = harness('alice', { files: null })
    const r = await call(h, { ...NEW, sections: [SECTION], finish: true })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('连接现在不可用')
  })

  it('续写中途断线:内容照存,finish 时才报错,恢复后可重试', async () => {
    const h = harness()
    const id = draftIdOf(await call(h, NEW))
    h.files.reach = { ok: false, reason: 'no_bridge' }
    const appended = await call(h, { draft_id: id, sections: [SECTION] })
    expect(appended.isError).toBeUndefined()
    const failed = await call(h, { draft_id: id, finish: true })
    expect(failed.isError).toBe(true)
    expect(textOf(failed)).toContain('没有发出去')
    expect(h.rendered).toHaveLength(0)
    h.files.reach = { ok: true }
    expect((await call(h, { draft_id: id, finish: true })).isError).toBeUndefined()
    expect(h.sent).toHaveLength(1)
  })

  it('上传失败:如实报告平台错误,草稿保留,重试成功', async () => {
    const h = harness()
    h.files.nextPush = { delivered: false, reason: 'send_failed', detail: 'code=99991672 缺少 im:resource 权限' }
    const failed = await call(h, { ...NEW, sections: [SECTION], finish: true })
    expect(failed.isError).toBe(true)
    expect(textOf(failed)).toContain('im:resource')
    expect(textOf(failed)).toContain('不要告诉成员已发送')
    const id = draftIdOf(failed)
    expect(h.sent).toHaveLength(0)

    const retried = await call(h, { draft_id: id, finish: true })
    expect(retried.isError).toBeUndefined()
    expect(h.sent).toHaveLength(1)
  })

  it('发送过程中路由丢失也如实报告', async () => {
    const h = harness()
    h.files.nextPush = { delivered: false, reason: 'unknown_member' }
    const failed = await call(h, { ...NEW, sections: [SECTION], finish: true })
    expect(failed.isError).toBe(true)
    expect(textOf(failed)).toContain('没有发出去')
  })

  it('生成失败:如实报告,草稿保留,可重试', async () => {
    const h = harness()
    h.setRender(async () => {
      throw new Error('堆内存不足')
    })
    const failed = await call(h, { ...NEW, sections: [SECTION], finish: true })
    expect(failed.isError).toBe(true)
    expect(textOf(failed)).toContain('堆内存不足')
    expect(h.sent).toHaveLength(0)
    const id = draftIdOf(failed)
    h.setRender(async () => new Uint8Array([1]))
    expect((await call(h, { draft_id: id, finish: true })).isError).toBeUndefined()
    expect(h.sent).toHaveLength(1)
  })

  it('成功后再次 finish 不重复发送', async () => {
    const h = harness()
    const id = draftIdOf(await call(h, { ...NEW, sections: [SECTION] }))
    await call(h, { draft_id: id, finish: true })
    const again = await call(h, { draft_id: id, finish: true })
    expect(again.isError).toBeUndefined()
    expect(textOf(again)).toContain('没有重复发送')
    expect(h.sent).toHaveLength(1)
    // 重启后也一样。
    const h2 = harness()
    await call(h2, { draft_id: id, finish: true })
    expect(h2.sent).toHaveLength(0)
  })

  it('段内换行也算内容块,超限在保存时就拒绝', async () => {
    const h = harness()
    const half = DOCUMENT_LIMITS.maxContentBlocks / 2
    const paragraph = Array<string>(half).fill('字').join('\n')
    const r = await call(h, { format: 'docx', title: 't', sections: [{ paragraphs: [paragraph, paragraph, '再多一行'] }] })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain(`${DOCUMENT_LIMITS.maxContentBlocks + 1} 个`)
    expect(textOf(r)).toContain('段内每行算一个')
    expect(h.rendered).toHaveLength(0)
    expect(existsSync(userDir()) ? readdirSync(userDir()) : []).toEqual([])
  })

  it('续写时 format 传 null 等于没传,title 不是文字就拒绝', async () => {
    const h = harness()
    const id = draftIdOf(await call(h, { ...NEW, sections: [SECTION] }))
    expect((await call(h, { draft_id: id, format: null })).isError).toBeUndefined()
    const bad = await call(h, { draft_id: id, title: { text: '新标题' } })
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toContain('title')
    const carrying = await call(h, { draft_id: id, title: false, sections: [{ heading: '这批' }] })
    expect(carrying.isError).toBe(true)
    expect(textOf(carrying)).toContain('没有保存')
    expect(readFileSync(join(userDir(), `${id}.json`), 'utf8')).not.toContain('这批')
    await call(h, { draft_id: id, title: 2024, finish: true })
    expect(h.rendered[0]).toMatchObject({ title: '2024' })
  })

  it('schema 每一层都不收未知字段,也不用数字枚举', () => {
    const items = (WRITE_DOCUMENT_TOOL.inputSchema as { properties: { sections: { items: { properties: Record<string, any> } } } })
      .properties.sections.items
    const { table, chart, level } = items.properties
    expect(table.additionalProperties).toBe(false)
    expect(chart.additionalProperties).toBe(false)
    expect(chart.properties.series.items.additionalProperties).toBe(false)
    expect(level).toEqual({ type: 'integer', minimum: 1, maximum: 3 })
  })

  it('发送成功后正文从盘上清除,只留标记', async () => {
    const h = harness()
    const id = draftIdOf(await call(h, { format: 'pptx', title: '私人内容', sections: [{ heading: '身体状况' }] }))
    await call(h, { draft_id: id, finish: true })
    expect(readdirSync(userDir())).toEqual([`${id}.sent.json`])
    const marker = readFileSync(join(userDir(), `${id}.sent.json`), 'utf8')
    expect(marker).not.toContain('身体状况')
    expect(marker).not.toContain('私人内容')
  })

  it('发送后不能再往已发送的草稿里追加', async () => {
    const h = harness()
    const id = draftIdOf(await call(h, { ...NEW, sections: [SECTION] }))
    await call(h, { draft_id: id, finish: true })
    const r = await call(h, { draft_id: id, sections: [SECTION] })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('已经发送过')
  })
})

describe('write_document 上限与清理(验收 11)', () => {
  it('参数和内容错误都明确拒绝,且不保存', async () => {
    const h = harness()
    expect((await call(h, { title: '没格式' })).isError).toBe(true)
    expect((await call(h, { format: 'pdf', title: 't' })).isError).toBe(true)
    expect((await call(h, { format: 'pptx' })).isError).toBe(true)
    const bad = await call(h, { ...NEW, sections: [{ heading: '好' }, { body: '放错字段' }] })
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toContain('body')
    expect(textOf(bad)).toContain('没有保存')
    const unknown = await call(h, { ...NEW, content: '放错参数' })
    expect(unknown.isError).toBe(true)
    expect(existsSync(userDir())).toBe(false)
  })

  it('章节总数超限拒绝,已有内容不动', async () => {
    const h = harness()
    const id = draftIdOf(await call(h, { format: 'docx', title: 't' }))
    await call(h, { draft_id: id, sections: Array(DOCUMENT_LIMITS.maxSections).fill({ heading: 'x' }) })
    const r = await call(h, { draft_id: id, sections: [{ heading: '多一节' }] })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('章节太多')
    const draft = JSON.parse(readFileSync(join(userDir(), `${id}.json`), 'utf8')) as DocumentSpec
    expect(draft.sections).toHaveLength(DOCUMENT_LIMITS.maxSections)
  })

  it('PPT 拆页后超过页数上限拒绝,不静默截断', async () => {
    const h = harness()
    const heavy = { heading: '长', paragraphs: Array(50).fill('字'.repeat(1000)) }
    const r = await call(h, { ...NEW, sections: Array(3).fill(heavy) })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/拆页后有 \d+ 页/)
    expect(existsSync(userDir())).toBe(false)
  })

  it('草稿大小超限拒绝', async () => {
    const h = harness()
    const big = { paragraphs: Array(DOCUMENT_LIMITS.maxItemsPerList).fill('字'.repeat(DOCUMENT_LIMITS.maxTextChars)) }
    const r = await call(h, { format: 'docx', title: 't', sections: [big] })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('上限')
  })

  it('内容块超限拒绝:字节远低于上限也一样,已有内容不动', async () => {
    const h = harness()
    const table = (rows: number) => ({
      table: { headers: Array(10).fill('列'), rows: Array.from({ length: rows }, () => Array(10).fill('x')) },
    })
    const full = [table(300), table(300), table(197)]
    expect(documentBlockCount(full as DocumentSection[])).toBe(DOCUMENT_LIMITS.maxContentBlocks)
    expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThan(DOCUMENT_LIMITS.maxDraftBytes / 2)

    const id = draftIdOf(await call(h, { format: 'docx', title: 't', sections: full }))
    const r = await call(h, { draft_id: id, sections: [{ paragraphs: ['多一段'] }] })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('没有保存')
    expect(textOf(r)).toContain(String(DOCUMENT_LIMITS.maxContentBlocks))
    const draft = JSON.parse(readFileSync(join(userDir(), `${id}.json`), 'utf8')) as DocumentSpec
    expect(draft.sections).toHaveLength(3)
  })

  it('未完成草稿超过 5 份时清掉最旧的并明说', async () => {
    let t = 1_000_000_000_000
    const h = harness('alice', { now: () => t })
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const id = draftIdOf(await call(h, { format: 'pptx', title: `草稿 ${i}` }))
      ids.push(id)
      // 用文件 mtime 判新旧,测试里把它钉成确定的顺序。
      const when = new Date(t + i * 1000)
      utimesSync(join(userDir(), `${id}.json`), when, when)
    }
    t += 10_000
    const r = await call(h, { format: 'pptx', title: '第六份' })
    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toContain('《草稿 0》')
    const names = readdirSync(userDir())
    expect(names.filter((n) => n.endsWith('.json'))).toHaveLength(5)
    expect(names).not.toContain(`${ids[0]}.json`)
    expect(names).toContain(`${ids[1]}.json`)
  })

  it('新建请求被拒时不清旧草稿', async () => {
    const h = harness()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(draftIdOf(await call(h, { format: 'pptx', title: `草稿 ${i}` })))
    for (const bad of [
      { format: 'pptx', title: '坏内容', sections: [{ unknown_field: 1 }] },
      { format: 'pptx', title: '太多', sections: Array(3).fill({ heading: '长', paragraphs: Array(50).fill('字'.repeat(1000)) }) },
    ]) {
      expect((await call(h, bad)).isError).toBe(true)
      expect(readdirSync(userDir()).filter((n) => n.endsWith('.json')).sort()).toEqual(ids.map((id) => `${id}.json`).sort())
    }
  })

  it('清掉旧草稿后生成失败,也要告诉成员清掉了哪份', async () => {
    let t = 1_000_000_000_000
    const h = harness('alice', { now: () => t })
    for (let i = 0; i < 5; i++) {
      const id = draftIdOf(await call(h, { format: 'pptx', title: `草稿 ${i}` }))
      const when = new Date(t + i * 1000)
      utimesSync(join(userDir(), `${id}.json`), when, when)
    }
    t += 10_000
    h.setRender(async () => {
      throw new Error('渲染坏了')
    })
    const r = await call(h, { format: 'pptx', title: '第六份', sections: [SECTION], finish: true })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('没有发出去')
    expect(textOf(r)).toContain('《草稿 0》')
  })

  it('已发送的标记不占未完成名额', async () => {
    const h = harness()
    for (let i = 0; i < 6; i++) await call(h, { ...NEW, title: `份 ${i}`, sections: [SECTION], finish: true })
    const r = await call(h, NEW)
    expect(textOf(r)).not.toContain('已清掉')
    expect(h.sent).toHaveLength(6)
  })

  it('超过 7 天的草稿和标记在下次调用时清掉', async () => {
    let t = Date.now()
    const h = harness('alice', { now: () => t })
    const draft = draftIdOf(await call(h, NEW))
    const sent = draftIdOf(await call(h, { ...NEW, title: '已发' }))
    await call(h, { draft_id: sent, sections: [SECTION], finish: true })
    expect(readdirSync(userDir()).sort()).toEqual([`${draft}.json`, `${sent}.sent.json`].sort())

    t += 7 * DAY + 60_000
    await call(h, NEW)
    const left = readdirSync(userDir())
    expect(left).not.toContain(`${draft}.json`)
    expect(left).not.toContain(`${sent}.sent.json`)
    const expired = await call(h, { draft_id: draft, finish: true })
    expect(textOf(expired)).toContain('不存在')
  })

  it('6 天的草稿不会被清,修改会刷新期限', async () => {
    const h = harness()
    const id = draftIdOf(await call(h, NEW))
    const path = join(userDir(), `${id}.json`)
    const sixDaysAgo = new Date(Date.now() - 6 * DAY)
    utimesSync(path, sixDaysAgo, sixDaysAgo)
    // 每次调用都会扫一遍过期草稿。
    await call(h, { ...NEW, title: '别的' })
    expect(existsSync(path)).toBe(true)
    expect((await call(h, { draft_id: id, sections: [SECTION] })).isError).toBeUndefined()
    expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(60_000)
  })

  it('写一半留下的临时文件不算草稿,过期后清掉', async () => {
    let t = Date.now()
    const h = harness('alice', { now: () => t })
    mkdirSync(userDir(), { recursive: true })
    const tmp = join(userDir(), 'd_0123456789abcdef.json.abcd1234.tmp')
    writeFileSync(tmp, '{')
    await call(h, NEW)
    expect(existsSync(tmp)).toBe(true)
    t += 8 * DAY
    await call(h, NEW)
    expect(existsSync(tmp)).toBe(false)
  })

  it('损坏的草稿如实报错,不当成发送成功', async () => {
    const h = harness()
    mkdirSync(userDir(), { recursive: true })
    const id = 'd_0123456789abcdef'
    writeFileSync(join(userDir(), `${id}.json`), '{not json')
    const r = await call(h, { draft_id: id, finish: true })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('没有发出去')
    expect(h.sent).toHaveLength(0)
  })
})

describe('write_document 工具面成本(验收 14)', () => {
  it('schema 估算不超过 600 tokens', () => {
    const wire = JSON.stringify({
      name: WRITE_DOCUMENT_TOOL.name,
      description: WRITE_DOCUMENT_TOOL.description,
      input_schema: WRITE_DOCUMENT_TOOL.inputSchema,
    })
    const tokens = estimateTokens(wire)
    console.info(`write_document schema 估算 ${tokens} tokens`)
    expect(tokens).toBeLessThanOrEqual(600)
  })

  it('未知工具名被拒', async () => {
    const h = harness()
    const r = (await h.tool.callTool('other', {})) as LlmToolCallResult
    expect(r.isError).toBe(true)
  })
})
