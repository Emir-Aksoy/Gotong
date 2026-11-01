/**
 * personal-butler-documents.ts — 阿同的 `write_document` 工具。
 *
 * 阿同交结构化内容,服务端确定性生成 PPT / Word,发到成员本人的飞书私聊。不执行
 * 模型写的代码,不碰 HANDS。
 *
 * ── 为什么是 benign ──
 * schema 里没有收件人,路由只来自可达表,而可达表只记成员本人的私聊(GRP);发送前
 * 还核对这个账号现在是否仍绑在成员名下(`ButlerReachableRegistry`)。所以只能
 * 发给成员自己,和阿同回一句话没有区别,不走审批。
 *
 * ── 为什么分批 ──
 * 三十页内容塞进一次工具调用,容易撞模型单次输出上限或上游断流。分批后每一步都小,
 * 草稿落盘,重启不丢。一次成稿和分批写走同一个工具,模型不用学两套。
 *
 * ── 失败不撒谎 ──
 * 只有桥确认发出后才说「已发送」。生成或发送失败时草稿保留,原样告诉模型可以重试;
 * 发送成功后只留一个「已发送」标记,再次 finish 不会重发。
 *
 * ── 不留文件 ──
 * 成品只在内存里走一遍,发完丢弃。草稿正文也在发送成功后删除,成员的内容不在盘上
 * 多留一份。
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'
import { ownerDir } from '@gotong/service-memory-file'

import { planSlides } from './butler-document-layout.js'
import { DocumentRenderError, renderDocumentInWorker } from './butler-document-runner.js'
import {
  DOCUMENT_LIMITS,
  documentBlockCount,
  documentFilename,
  documentWarnings,
  parseDocumentMeta,
  parseDocumentMetaPatch,
  parseDocumentSections,
  type DocumentSpec,
} from './butler-document-spec.js'
import type { ButlerFileReach, ButlerMemberFiles } from './butler-reachable.js'

const MAX_OPEN_DRAFTS = 5
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DRAFT_ID = /^d_[0-9a-f]{16}$/
const TOP_LEVEL_KEYS = new Set(['draft_id', 'format', 'title', 'subtitle', 'theme', 'sections', 'finish'])

const stringArray = { type: 'array', items: { type: 'string' } }

export const WRITE_DOCUMENT_TOOL: LlmToolDefinition = {
  name: 'write_document',
  description:
    '生成 PPT 或 Word 文件,发到成员本人的飞书私聊。内容少就一次传完并带 finish:true;内容多就分批:先建草稿,再用返回的 draft_id 追加 sections,最后 finish:true。只给内容和数据,排版由系统处理。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      draft_id: { type: 'string', description: '续写已有草稿;不传则新建' },
      format: { type: 'string', enum: ['pptx', 'docx'], description: '新建时必填' },
      title: { type: 'string', description: '新建时必填' },
      subtitle: { type: 'string' },
      theme: { type: 'string', enum: ['business', 'warm', 'dark'] },
      sections: {
        type: 'array',
        description: '本次追加的章节。PPT 里只有 heading 的章节是过渡页',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            heading: { type: 'string' },
            level: { type: 'integer', minimum: 1, maximum: 3 },
            paragraphs: stringArray,
            bullets: stringArray,
            table: {
              type: 'object',
              additionalProperties: false,
              properties: { headers: stringArray, rows: { type: 'array', items: stringArray } },
              required: ['headers', 'rows'],
            },
            chart: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: ['bar', 'line', 'pie'] },
                title: { type: 'string' },
                labels: stringArray,
                series: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } },
                    required: ['name', 'values'],
                  },
                },
              },
              required: ['type', 'labels', 'series'],
            },
            notes: { type: 'string', description: '演讲者备注' },
          },
        },
      },
      finish: { type: 'boolean', description: 'true = 生成并发送' },
    },
  },
}

interface DraftFile extends DocumentSpec {
  id: string
  createdAt: number
}

/** 标题也是成员的内容,这里只记发没发过。 */
interface SentMarker {
  id: string
  sentAt: number
}

export interface ButlerDocumentDeps {
  userId: string
  /** `<space>/butler/documents`。 */
  root: string
  /** 现读:桥可能比工具实例晚启动。缺席 = 这台 hub 没接聊天平台。 */
  files: () => ButlerMemberFiles | undefined
  /** 测试缝;默认走子进程。 */
  render?: (spec: DocumentSpec) => Promise<Uint8Array>
  now?: () => number
  logger?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void
    error: (msg: string, meta?: Record<string, unknown>) => void
  }
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] }
}

const refuse = (t: string): LlmToolCallResult => text(t, true)

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(value), 'utf8')
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT'

const specOf = (draft: DraftFile): DocumentSpec => ({
  format: draft.format,
  title: draft.title,
  ...(draft.subtitle !== undefined ? { subtitle: draft.subtitle } : {}),
  theme: draft.theme,
  sections: draft.sections,
})

function reachRefusal(reach: Exclude<ButlerFileReach, { ok: true }>): string {
  switch (reach.reason) {
    case 'unknown_member':
      return '发不了文件:成员还没绑定飞书。先绑定,再在飞书私聊阿同说一句话,之后才能生成。'
    case 'no_bridge':
      return '发不了文件:飞书连接现在不可用,需要管理员检查。'
    case 'unsupported':
      return '发不了文件:成员绑定的聊天平台还不支持收文件,目前只支持飞书。'
  }
}

// 同一成员的调用串行:并发追加会丢内容,并发 finish 会发两次。锁挂在模块上,
// 因为工具实例可能被重建,而文件是同一批。
const userLocks = new Map<string, Promise<unknown>>()

function withUserLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (userLocks.get(key) ?? Promise.resolve()).then(fn, fn)
  const settled = run.catch(() => undefined).finally(() => {
    if (userLocks.get(key) === settled) userLocks.delete(key)
  })
  userLocks.set(key, settled)
  return run
}

export function buildButlerDocumentToolset(deps: ButlerDocumentDeps): LlmAgentToolset {
  const dir = ownerDir(deps.root, { kind: 'user', id: deps.userId })
  const now = deps.now ?? Date.now
  const render = deps.render ?? ((spec: DocumentSpec) => renderDocumentInWorker(spec))

  const draftPath = (id: string): string => join(dir, `${id}.json`)
  const sentPath = (id: string): string => join(dir, `${id}.sent.json`)

  const reach = (): ButlerFileReach => {
    const files = deps.files()
    return files ? files.canPush(deps.userId) : { ok: false, reason: 'no_bridge' }
  }

  /** 清掉过期文件,返回还在的未完成草稿(按修改时间从旧到新)。 */
  async function sweep(): Promise<Array<{ id: string; mtimeMs: number }>> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (err) {
      if (isMissing(err)) return []
      throw err
    }
    const open: Array<{ id: string; mtimeMs: number }> = []
    for (const name of names) {
      const path = join(dir, name)
      const info = await stat(path).catch(() => null)
      if (!info) continue
      if (now() - info.mtimeMs > DRAFT_TTL_MS) {
        await rm(path, { force: true }).catch(() => undefined)
        continue
      }
      if (name.endsWith('.json') && !name.endsWith('.sent.json')) {
        open.push({ id: name.slice(0, -'.json'.length), mtimeMs: info.mtimeMs })
      }
    }
    return open.sort((a, b) => a.mtimeMs - b.mtimeMs)
  }

  /** 给新草稿腾位置;返回被清掉的草稿的说明。 */
  async function makeRoom(open: Array<{ id: string }>): Promise<string[]> {
    const notes: string[] = []
    for (const { id } of open.slice(0, Math.max(0, open.length - MAX_OPEN_DRAFTS + 1))) {
      const title = await readFile(draftPath(id), 'utf8')
        .then((raw) => (JSON.parse(raw) as DraftFile).title)
        .catch(() => id)
      await rm(draftPath(id), { force: true })
      notes.push(`未完成草稿超过 ${MAX_OPEN_DRAFTS} 份,已清掉最旧的《${title}》。`)
    }
    return notes
  }

  async function readSent(id: string): Promise<SentMarker | null> {
    try {
      return JSON.parse(await readFile(sentPath(id), 'utf8')) as SentMarker
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
  }

  async function finish(draft: DraftFile, notes: string[]): Promise<LlmToolCallResult> {
    // 失败时也要带上 notes:这一步之前可能已经清掉了一份旧草稿,不能不告诉成员。
    const fail = (message: string): LlmToolCallResult => refuse([message, ...notes].join('\n'))
    if (draft.sections.length === 0) return fail(`草稿 ${draft.id} 还没有内容,先传 sections 再 finish。`)
    const retry = `草稿 ${draft.id} 还在,可以只传 draft_id 和 finish:true 重试,不用重传内容。`
    const available = reach()
    if (!available.ok) return fail(`${reachRefusal(available)}文件没有发出去。${retry}`)

    const spec = specOf(draft)
    let bytes: Uint8Array
    try {
      bytes = await render(spec)
    } catch (err) {
      const why = err instanceof DocumentRenderError ? err.message : String((err as Error)?.message ?? err)
      const detail = err instanceof DocumentRenderError ? err.detail : undefined
      deps.logger?.error('butler document render failed', { userId: deps.userId, err: why, ...(detail ? { detail } : {}) })
      return fail(`生成失败:${why}。文件没有发出去。${retry}`)
    }

    const fileName = documentFilename(draft.title, draft.format)
    // 上面已经确认过可达;这里再取一次,生成期间桥可能被停掉。
    const files = deps.files()
    const result = files
      ? await files.push(deps.userId, { bytes, filename: fileName })
      : ({ delivered: false, reason: 'no_bridge' } as const)
    if (!result.delivered) {
      const why = result.reason === 'send_failed' ? `发送失败:${result.detail}。` : reachRefusal({ ok: false, reason: result.reason })
      return fail(`${why}文件没有发出去,不要告诉成员已发送。${retry}`)
    }

    // 文件已经到成员手里。下面任何一步失败都不能改口说没发,只能少一层防重发。
    try {
      await writeAtomic(sentPath(draft.id), { id: draft.id, sentAt: now() } satisfies SentMarker)
    } catch (err) {
      deps.logger?.warn('butler document: failed to write sent marker', {
        userId: deps.userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
    await rm(draftPath(draft.id), { force: true }).catch((err: unknown) => {
      deps.logger?.warn('butler document: failed to drop sent draft', {
        userId: deps.userId,
        err: err instanceof Error ? err.message : String(err),
      })
    })

    const size = draft.format === 'pptx' ? `共 ${planSlides(spec).length} 页` : `共 ${draft.sections.length} 节`
    return text(
      [
        `已把《${fileName}》发到成员本人的飞书私聊,${size}。在群里触发也只发私聊,请提醒成员去私聊查看。`,
        ...documentWarnings(spec),
        ...notes,
        '草稿内容已清除,要改就新建一份。',
      ].join('\n'),
    )
  }

  async function call(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    for (const key of Object.keys(args)) {
      if (!TOP_LEVEL_KEYS.has(key)) return refuse(`不认识的参数「${key}」;可用参数:${[...TOP_LEVEL_KEYS].join(' / ')}`)
    }
    const wantsFinish = args.finish === true || args.finish === 'true'
    const open = await sweep()
    const notes: string[] = []

    const creating = args.draft_id === undefined || args.draft_id === null
    let draft: DraftFile
    if (!creating) {
      const id = args.draft_id
      // 这是唯一由模型决定的路径片段,格式不对直接拒绝,不做清洗。
      if (typeof id !== 'string' || !DRAFT_ID.test(id)) return refuse('draft_id 格式不对,用工具返回的原值。')
      const sent = await readSent(id)
      if (sent) {
        if (args.sections !== undefined && args.sections !== null) {
          return refuse('这份文档已经发送过,内容已清除。要改就新建一份。')
        }
        return text('这份文档之前已经发到成员的飞书私聊,这次没有重复发送。')
      }
      let raw: string
      try {
        raw = await readFile(draftPath(id), 'utf8')
      } catch (err) {
        if (isMissing(err)) return refuse(`草稿 ${id} 不存在,可能已过期。需要新建一份。`)
        throw err
      }
      draft = JSON.parse(raw) as DraftFile
      if (args.format !== undefined && args.format !== null && args.format !== draft.format) {
        return refuse(`草稿 ${id} 的格式是 ${draft.format},不能改。要换格式就新建一份。`)
      }
      const patch = parseDocumentMetaPatch(args)
      // 模型可能以为只是标题没改成,不重传这批章节就丢了。
      if (!patch.ok) return refuse(`${patch.error}。这次的内容没有保存,改好后把这批再传一遍。`)
      draft = { ...draft, ...patch.value }
    } else {
      // 没有通道就别让模型白写内容。续写不查:可能只是暂时断线。
      const available = reach()
      if (!available.ok) return refuse(reachRefusal(available))
      const meta = parseDocumentMeta(args)
      if (!meta.ok) return refuse(meta.error)
      draft = { ...meta.value, id: `d_${randomBytes(8).toString('hex')}`, sections: [], createdAt: now() }
    }

    if (args.sections !== undefined && args.sections !== null) {
      const parsed = parseDocumentSections(args.sections)
      if (!parsed.ok) return refuse(`${parsed.error}。这次的内容没有保存。`)
      // 模型重试时常把上一批原样再传一遍,直接追加会让内容出现两次。
      const incoming = JSON.stringify(parsed.value)
      const tail = JSON.stringify(draft.sections.slice(-parsed.value.length))
      if (parsed.value.length > 0 && incoming === tail) {
        notes.push('这批 sections 和草稿末尾完全相同,按重试处理,没有重复追加。')
      } else {
        const sections = [...draft.sections, ...parsed.value]
        if (sections.length > DOCUMENT_LIMITS.maxSections) {
          return refuse(`章节太多(${sections.length} > ${DOCUMENT_LIMITS.maxSections}),这批没有保存。可以拆成两份文档。`)
        }
        draft = { ...draft, sections }
      }
    }

    if (Buffer.byteLength(JSON.stringify(draft), 'utf8') > DOCUMENT_LIMITS.maxDraftBytes) {
      return refuse(`内容太多,超过 ${DOCUMENT_LIMITS.maxDraftBytes / 1024 / 1024}MB 上限,这批没有保存。可以拆成两份文档。`)
    }
    const blocks = documentBlockCount(draft.sections)
    if (blocks > DOCUMENT_LIMITS.maxContentBlocks) {
      return refuse(`段落、要点和表格单元格一共 ${blocks} 个(段内每行算一个),超过 ${DOCUMENT_LIMITS.maxContentBlocks} 个上限,这批没有保存。可以精简内容或拆成两份文档。`)
    }
    const slides = draft.format === 'pptx' ? planSlides(specOf(draft)).length : 0
    if (slides > DOCUMENT_LIMITS.maxSlides) {
      return refuse(`拆页后有 ${slides} 页,超过 ${DOCUMENT_LIMITS.maxSlides} 页上限,这批没有保存。可以精简内容或拆成两份。`)
    }

    // 所有检查都过了才腾位置:被拒的请求不能让成员丢一份旧草稿。
    if (creating) notes.push(...(await makeRoom(open)))
    await mkdir(dir, { recursive: true })
    await writeAtomic(draftPath(draft.id), draft)

    if (wantsFinish) return finish(draft, notes)
    const size = draft.format === 'pptx' ? `${draft.sections.length} 节,约 ${slides} 页` : `${draft.sections.length} 节`
    return text(
      [`草稿 ${draft.id} 已保存,现在 ${size}。继续追加传 draft_id 和 sections,写完传 draft_id 和 finish:true。`, ...notes].join('\n'),
    )
  }

  return {
    listTools: () => [WRITE_DOCUMENT_TOOL],
    async callTool(name, args) {
      if (name !== WRITE_DOCUMENT_TOOL.name) return refuse(`unknown tool ${name}`)
      try {
        return await withUserLock(dir, () => call(args))
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        deps.logger?.error('butler document tool failed', { userId: deps.userId, err: why })
        return refuse(`文档工具出错:${why}。文件没有发出去。`)
      }
    },
  }
}
