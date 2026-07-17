/**
 * knowledge-library.ts — LIB-M2。阿同的知识「上架区」:`knowledge/` 目录 +
 * 4 个 benign 文件工具(list / read / write / archive)。
 *
 * # 为什么是一个目录树,不是又一个 JSON 台账
 *
 * 记忆管线(MU)的 semantic.jsonl 是**进货区**——自动蒸馏的原子条目,格式归
 * 框架管;本模块是**上架区**——层级由阿同自己编排(目录学不预设,LIB 主旨
 * 就是「自主管理知识文件」),文件本身即状态,file-first 北极星直接适用:
 * 复制目录 = 搬走整座图书馆,`INDEX.md` 是阿同自著的总索引(M3 注入)。
 *
 * # 边界(镜像任务笔记本,TN-M1 同款纪律)
 *
 *   - **host 定位,叶子纯 fs**:host 把 `ownerDir(...)/knowledge` 递进来,
 *     本模块只在这个根下做经过验证的相对路径操作——`..`/绝对路径/隐藏段/
 *     非 .md 一律响亮拒(穿越在字符串层就出不了圈,读侧再拒 symlink)。
 *   - **上限响亮拒,no silent caps**:文件数/单文件字节/总字节三顶 +
 *     路径长度/深度,超了就把上限数字说给模型听,绝不静默截断。
 *   - **tmp+rename**:崩溃永远不留半份文件;归档=改名挪进 `archive/`,
 *     不真删(维护期 prune 是 M4 的事,git 快照旋钮是兜底)。
 *   - **知识 ≠ 授权**:全部 benign——整理自己域内的知识文件与写 tasks.json
 *     同级;知识文件里「读到」的对外动作照旧走 governed 闸,一步不少。
 */

import { lstat, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'

import { ButlerError } from './errors.js'

/** 归档区子目录名(不真删的去处;`archive/…` 可读可列,不可直接写)。 */
export const KNOWLEDGE_ARCHIVE_DIR = 'archive'

/** 总索引文件名(阿同自著;M3 把它注入稳定段)。归档它=自断导航,响亮拒。 */
export const KNOWLEDGE_INDEX_FILE = 'INDEX.md'

/**
 * 三顶 + 路径两限。数字是设计立场不是旋钮(TN 同款):
 * - maxFiles 只数上架区——文件数顶守的是**导航性**,归档不该挤占货架;
 * - maxTotalBytes 数全树(含 archive/)——字节顶守的是**磁盘真实占用**,
 *   归档不减字节,说谎的顶不如没有;
 * - 单文件 32KB ≈ 一万多汉字——知识文件是给下一轮的自己读的,超过这个
 *   体量应该拆篇并用 INDEX.md 串起来,不是塞成一坨。
 */
export const KNOWLEDGE_LIBRARY_LIMITS = {
  maxFiles: 200,
  maxFileBytes: 32 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxPathChars: 120,
  maxDepth: 6,
} as const

export type KnowledgeLibraryLimits = typeof KNOWLEDGE_LIBRARY_LIMITS

export interface KnowledgeFileInfo {
  /** 相对 knowledge/ 的路径(归档件带 `archive/` 前缀)。 */
  path: string
  bytes: number
  archived: boolean
}

export interface KnowledgeListing {
  /** 上架区在前、归档区在后,各自按路径字典序(输出确定性)。 */
  files: KnowledgeFileInfo[]
  activeCount: number
  activeBytes: number
  archivedCount: number
  archivedBytes: number
  /** 树里的非 .md 杂物(含 symlink/崩溃残留 .tmp)——不列出但如实报数。 */
  strayCount: number
}

export interface KnowledgeLibrary {
  list(): Promise<KnowledgeListing>
  read(path: string): Promise<{ path: string; text: string; bytes: number }>
  write(path: string, content: string): Promise<{ path: string; bytes: number; created: boolean }>
  archive(path: string): Promise<{ from: string; to: string }>
}

export interface OpenKnowledgeLibraryOptions {
  /** 知识库根(host: `<ownerDir>/knowledge`)。所有路径都锁在它下面。 */
  dir: string
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }
  /** 测试缝——默认 Date.now(归档重名后缀用)。 */
  now?: () => number
  /** 测试缝——收紧上限用;生产永远走默认常量。 */
  limits?: Partial<KnowledgeLibraryLimits>
}

// ─── 路径验证(穿越在这里就出不了圈) ─────────────────────────────────────────

/** 控制字符/冒号/反斜杠:跨平台文件名雷区,一律拒。 */
// eslint-disable-next-line no-control-regex
const BAD_CHARS_RE = /[\u0000-\u001f\u007f:\\]/

/**
 * 验证并返回规范化的相对路径段。规则(每条都是响亮拒,错误信息说人话):
 * 相对路径、`/` 分段、段非空且不为 `.`/`..`、段不以 `.` 开头(挡隐藏文件
 * 与 `.tmp`/`.git` 污染)、结尾必须 `.md`、总长/深度有顶。
 */
export function validateKnowledgePath(raw: unknown, limits: KnowledgeLibraryLimits): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ButlerError('knowledge_invalid', 'path 要是非空的相对路径(如 user/家人.md)')
  }
  const path = raw.trim()
  if (path.length > limits.maxPathChars) {
    throw new ButlerError(
      'knowledge_invalid',
      `路径太长(${path.length} > ${limits.maxPathChars} 字符)——短一点,层级是给导航用的`,
    )
  }
  if (path.startsWith('/') || BAD_CHARS_RE.test(path)) {
    throw new ButlerError('knowledge_invalid', `路径只能是 knowledge/ 内的相对路径,不含控制字符、冒号或反斜杠(收到「${path}」)`)
  }
  const segments = path.split('/')
  if (segments.length > limits.maxDepth) {
    throw new ButlerError(
      'knowledge_invalid',
      `目录太深(${segments.length} 层 > ${limits.maxDepth})——扁一点,深巷子里的知识没人找得到`,
    )
  }
  for (const seg of segments) {
    if (seg.length === 0 || seg === '.' || seg === '..') {
      throw new ButlerError('knowledge_invalid', `路径段不能为空或为 . / ..(收到「${path}」)`)
    }
    if (seg.startsWith('.')) {
      throw new ButlerError('knowledge_invalid', `路径段不能以 . 开头(收到「${seg}」)——隐藏文件不进知识库`)
    }
  }
  const last = segments[segments.length - 1]!
  if (!last.endsWith('.md') || last.length <= 3) {
    throw new ButlerError('knowledge_invalid', `知识文件是 .md 文本(收到「${last}」)——其他格式不进知识库`)
  }
  return segments
}

// ─── 实现 ────────────────────────────────────────────────────────────────────

interface WalkedFile {
  rel: string
  bytes: number
}

export function openKnowledgeLibrary(opts: OpenKnowledgeLibraryOptions): KnowledgeLibrary {
  const nowMs = opts.now ?? (() => Date.now())
  const limits: KnowledgeLibraryLimits = { ...KNOWLEDGE_LIBRARY_LIMITS, ...opts.limits }
  // 与笔记本同款:单写者(这位成员的管家轮),进程内串行就是全部故事。
  let chain: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn)
    chain = next.catch(() => undefined)
    return next
  }

  /** 递归收集 relDir 下的 .md 文件;symlink 与非 .md 一律算杂物(只报数)。 */
  const walk = async (relDir: string, strays: { count: number }): Promise<WalkedFile[]> => {
    const abs = relDir ? join(opts.dir, relDir) : opts.dir
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      return [] // 目录不存在 = 空库(首次使用),不是错误
    }
    const out: WalkedFile[] = []
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name
      if (e.isSymbolicLink()) {
        strays.count++ // 结构性防出圈:链接不跟、不列、不读
      } else if (e.isDirectory()) {
        out.push(...(await walk(rel, strays)))
      } else if (e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.')) {
        try {
          out.push({ rel, bytes: (await stat(join(opts.dir, rel))).size })
        } catch {
          strays.count++ // 列目录和 stat 之间消失了——按杂物计,不炸整个 list
        }
      } else {
        strays.count++
      }
    }
    return out
  }

  /** 全树一次快照(上架/归档分开),write/archive 的顶都从这份数出。 */
  const snapshot = async () => {
    const strays = { count: 0 }
    const all = await walk('', strays)
    const active = all.filter((f) => !f.rel.startsWith(`${KNOWLEDGE_ARCHIVE_DIR}/`))
    const archived = all.filter((f) => f.rel.startsWith(`${KNOWLEDGE_ARCHIVE_DIR}/`))
    const sum = (xs: WalkedFile[]) => xs.reduce((a, f) => a + f.bytes, 0)
    return {
      active,
      archived,
      activeBytes: sum(active),
      archivedBytes: sum(archived),
      strayCount: strays.count,
    }
  }

  return {
    list: () =>
      enqueue(async () => {
        const s = await snapshot()
        const byPath = (a: WalkedFile, b: WalkedFile) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)
        return {
          files: [
            ...[...s.active].sort(byPath).map((f) => ({ path: f.rel, bytes: f.bytes, archived: false })),
            ...[...s.archived].sort(byPath).map((f) => ({ path: f.rel, bytes: f.bytes, archived: true })),
          ],
          activeCount: s.active.length,
          activeBytes: s.activeBytes,
          archivedCount: s.archived.length,
          archivedBytes: s.archivedBytes,
          strayCount: s.strayCount,
        }
      }),

    read: (path) =>
      enqueue(async () => {
        const segments = validateKnowledgePath(path, limits)
        const rel = segments.join('/')
        const abs = join(opts.dir, ...segments)
        try {
          if ((await lstat(abs)).isSymbolicLink()) {
            throw new ButlerError('knowledge_invalid', `「${rel}」是个链接,不是知识文件——不读`)
          }
        } catch (err) {
          if (err instanceof ButlerError) throw err
          throw new ButlerError('knowledge_not_found', `没有「${rel}」(用 list_knowledge_files 查看现有文件)`)
        }
        const text = await readFile(abs, 'utf8')
        return { path: rel, text, bytes: Buffer.byteLength(text, 'utf8') }
      }),

    write: (path, content) =>
      enqueue(async () => {
        const segments = validateKnowledgePath(path, limits)
        const rel = segments.join('/')
        if (segments[0] === KNOWLEDGE_ARCHIVE_DIR) {
          throw new ButlerError(
            'knowledge_invalid',
            '归档区不直接写——先写上架区,要归档用 archive_knowledge_file',
          )
        }
        if (typeof content !== 'string' || content.trim().length === 0) {
          throw new ButlerError('knowledge_invalid', '内容为空——要弃用一份文件请用 archive_knowledge_file')
        }
        const bytes = Buffer.byteLength(content, 'utf8')
        if (bytes > limits.maxFileBytes) {
          throw new ButlerError(
            'knowledge_limit',
            `单文件上限 ${limits.maxFileBytes} 字节(这份 ${bytes})——拆成多份,用 INDEX.md 把它们串起来`,
          )
        }
        const abs = join(opts.dir, ...segments)
        let existingBytes: number | null = null
        try {
          const st = await lstat(abs)
          if (st.isSymbolicLink()) {
            throw new ButlerError('knowledge_invalid', `「${rel}」是个链接——不覆盖`)
          }
          existingBytes = st.size
        } catch (err) {
          if (err instanceof ButlerError) throw err
          existingBytes = null // 不存在 = 新建
        }
        const s = await snapshot()
        if (existingBytes === null && s.active.length >= limits.maxFiles) {
          throw new ButlerError(
            'knowledge_limit',
            `上架区已有 ${s.active.length} 份(上限 ${limits.maxFiles})——先用 archive_knowledge_file 收掉不再需要的`,
          )
        }
        const totalAfter = s.activeBytes + s.archivedBytes - (existingBytes ?? 0) + bytes
        if (totalAfter > limits.maxTotalBytes) {
          throw new ButlerError(
            'knowledge_limit',
            `知识库总量上限 ${limits.maxTotalBytes} 字节(写入后将达 ${totalAfter},含归档区)——精简正文,或提醒用户清理归档`,
          )
        }
        await mkdir(dirname(abs), { recursive: true })
        const tmp = `${abs}.tmp`
        await writeFile(tmp, content, 'utf8')
        await rename(tmp, abs) // 崩溃永不留半份文件
        return { path: rel, bytes, created: existingBytes === null }
      }),

    archive: (path) =>
      enqueue(async () => {
        const segments = validateKnowledgePath(path, limits)
        const rel = segments.join('/')
        if (rel === KNOWLEDGE_INDEX_FILE) {
          throw new ButlerError('knowledge_invalid', 'INDEX.md 是总索引,不归档——要改就直接重写它')
        }
        if (segments[0] === KNOWLEDGE_ARCHIVE_DIR) {
          throw new ButlerError('knowledge_invalid', `「${rel}」已经在归档区了`)
        }
        const abs = join(opts.dir, ...segments)
        try {
          await lstat(abs)
        } catch {
          throw new ButlerError('knowledge_not_found', `没有「${rel}」(用 list_knowledge_files 查看现有文件)`)
        }
        let destRel = `${KNOWLEDGE_ARCHIVE_DIR}/${rel}`
        let destAbs = join(opts.dir, KNOWLEDGE_ARCHIVE_DIR, ...segments)
        try {
          await lstat(destAbs)
          // 归档区已有同名件:不覆盖历史,加时间戳共存(笔记本隔离名同款)。
          destRel = destRel.replace(/\.md$/, `-${nowMs()}.md`)
          destAbs = join(opts.dir, ...destRel.split('/'))
        } catch {
          // 目标不存在 = 常规路径
        }
        await mkdir(dirname(destAbs), { recursive: true })
        await rename(abs, destAbs)
        return { from: rel, to: destRel }
      }),
  }
}

// ─── The benign toolset ───────────────────────────────────────────────────────

const KB = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)

/**
 * 4 个 benign 知识库工具。benign 是立场:整理**自己域内**的知识文件与编辑
 * 自己的任务清单同级,不碰别人也不出盒;知识文件里记下的对外动作,执行时
 * 照常走各自的 governed 闸(工具描述里把这句话说给模型听)。
 */
export function createKnowledgeLibraryToolset(library: KnowledgeLibrary): LlmAgentToolset {
  const defs: LlmToolDefinition[] = [
    {
      name: 'list_knowledge_files',
      description:
        '列出你的知识库(knowledge/)里的全部文件与大小。知识库是你自己编排层级的长期知识区,与自动记忆互补;INDEX.md 是你自著的总索引。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'read_knowledge_file',
      description:
        '读一份知识文件的全文。路径用 list_knowledge_files 显示的相对路径(归档件带 archive/ 前缀,也能读)。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径,如 user/家人.md 或 archive/旧笔记.md。' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'write_knowledge_file',
      description:
        '新建或整篇覆盖一份知识文件(.md)。层级你自己定(如 user/偏好.md、self/教训.md);写完值得被找到的内容,记得同步更新 INDEX.md(总索引,一行一指针,给下一轮的你导航)。只是整理知识,不执行任何动作;对外动作照常要审批。',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: `相对 knowledge/ 的 .md 路径(≤${KNOWLEDGE_LIBRARY_LIMITS.maxDepth} 层,不写 archive/)。`,
          },
          content: {
            type: 'string',
            description: `整篇 Markdown 正文(≤${KNOWLEDGE_LIBRARY_LIMITS.maxFileBytes} 字节;更大就拆篇)。`,
          },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    {
      name: 'archive_knowledge_file',
      description:
        '把一份知识文件挪进归档区(archive/)——不真删,之后还能读。INDEX.md 不可归档;归档后记得把 INDEX.md 里对应的指针删掉。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要归档的上架区路径,如 projects/装修.md。' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  ]

  const text = (t: string, isError = false): LlmToolCallResult => ({
    content: [{ type: 'text', text: t }],
    ...(isError ? { isError: true } : {}),
  })

  return {
    listTools: () => defs,
    async callTool(name, args): Promise<LlmToolCallResult> {
      try {
        switch (name) {
          case 'list_knowledge_files': {
            const l = await library.list()
            if (l.files.length === 0) {
              return text('知识库是空的。用 write_knowledge_file 建第一份(建议先立 INDEX.md 总索引)。')
            }
            const lines = l.files
              .filter((f) => !f.archived)
              .map((f) => `- ${f.path}(${KB(f.bytes)})`)
            const head = `知识库共 ${l.activeCount} 份(${KB(l.activeBytes)};上限 ${KNOWLEDGE_LIBRARY_LIMITS.maxFiles} 份):`
            const tail: string[] = []
            if (l.archivedCount > 0) tail.push(`归档区另有 ${l.archivedCount} 份(${KB(l.archivedBytes)}),读时带 archive/ 前缀。`)
            if (l.strayCount > 0) tail.push(`(忽略了 ${l.strayCount} 个非 .md 杂项)`)
            return text([head, ...lines, ...tail].join('\n'))
          }
          case 'read_knowledge_file': {
            const r = await library.read(String(args.path ?? ''))
            return text(`「${r.path}」(${KB(r.bytes)}):\n\n${r.text}`)
          }
          case 'write_knowledge_file': {
            const r = await library.write(String(args.path ?? ''), String(args.content ?? ''))
            return text(
              `${r.created ? '已新建' : '已覆盖'}「${r.path}」(${KB(r.bytes)})。` +
                (r.path === KNOWLEDGE_INDEX_FILE ? '' : '若这份知识值得被找到,记得更新 INDEX.md 的指针。'),
            )
          }
          case 'archive_knowledge_file': {
            const r = await library.archive(String(args.path ?? ''))
            return text(`已归档「${r.from}」→「${r.to}」(不真删,还能读)。记得把 INDEX.md 里对应的指针删掉。`)
          }
          default:
            return text(`未知工具 ${name}`, true)
        }
      } catch (err) {
        // 拒绝(上限/坏路径/找不到)以友好错误文本回给模型自行纠正,绝不炸轮。
        return text(err instanceof Error ? err.message : String(err), true)
      }
    },
  }
}
