/**
 * knowledge-librarian.ts — LIB-M4。图书馆员:6h 维护链里的第五个自门控
 * reviewer,把进货区(semantic.jsonl 的 ad-hoc 事实)里**主题类**的知识
 * 「上架」进 knowledge/ 文件树,并重写 INDEX.md 总索引。
 *
 * # 为什么要上架
 *
 * 进货区的每条活跃事实都进冻结块=**每轮都付**;上架区的文件只在被读时付,
 * M3 索引卡(≤500tk)负责导航。图书馆员做的就是把「项目/参考/清单」类
 * 知识从每轮必付的段搬到按需付费的段——常驻上下文不随知识总量增长的
 * 承重动作。核心身份/现行偏好类事实**留在记忆里**(prompt 规则钉死)。
 *
 * # 纪律(与 reconcile.ts 同款,逐条对齐)
 *
 *   - **自门控零浪费**:可上架候选(活跃 ad-hoc、未上架)不足 trigger →
 *     直接 `{}`,一次模型调用都不花。收敛:上架即关区间,候选集只降。
 *   - **fail-soft**:模型响应坏/空 → 零操作;单条 promotion 失败(路径被
 *     库层响亮拒/超顶)→ 只跳那条,它的事实**绝不下架**;INDEX 写失败 →
 *     跳过,下一 tick 或阿同自己补。reviewer 永不 throw 拖垮同 tick 蒸馏。
 *   - **写前退后(write-before-shelve)**:先把正文写进文件,写成了才关
 *     记忆区间——崩溃留重影(文件+记忆双在),永不留失踪。
 *   - **双时态可逆**:下架=CLOSE 区间 + `meta.promotedTo` 记出处(host 把
 *     两者折进**一次** patchMeta),绝不 forget;读侧 activeOnly 自动不再
 *     浮出,翻案=清掉 validTo 即回。
 *   - **幻觉免疫**:factIds 只认递进来的候选批(byId 查表),模型编不出
 *     能关掉的 id;INDEX 兜底机械补指针,上架过的文件绝不失联。
 *   - **批量步频非丢弃**:一次最多 maxBatch 条进 prompt——不是砍掉,是
 *     留给下一个 6h tick(no silent caps:顶住的是步频,不是总量)。
 */

import type { MemoryEntry } from '@gotong/services-sdk'
import {
  isActive,
  isClusterProfile,
  isDigest,
  isProfile,
  type MemoryReviewer,
  type MemorySummarizer,
  type ReviewContext,
  type ReviewOutcome,
} from '@gotong/personal-memory'

import { KNOWLEDGE_INDEX_FILE, type KnowledgeLibrary } from './knowledge-library.js'

/** 出处标记:上架时 host 折进 close 的同一次 patchMeta。有它=永不再候选。 */
export const META_PROMOTED_TO = 'promotedTo'

/** 每 pass 拉取的 semantic 窗口(recall 硬顶同值,reconcile 同款)。 */
export const LIBRARIAN_RECALL_WINDOW = 200

/** 可上架候选达到这个数才花一次模型调用(低于=空转 tick 零成本)。 */
export const DEFAULT_LIBRARIAN_TRIGGER_FACTS = 12

/** 单 tick 最多递给模型的候选数——步频顶,余量下个 6h tick 接着来。 */
export const DEFAULT_LIBRARIAN_MAX_BATCH = 40

/** 一条上架决定(模型输出)。 */
export interface LibrarianPromotion {
  /** knowledge/ 内的相对 .md 路径(库层 validateKnowledgePath 把关)。 */
  readonly path: string
  /** 新文件的标题(现有文件追加时省略)。 */
  readonly title?: string
  /** 要追加进该文件的 Markdown 正文(自包含,事实写全)。 */
  readonly append: string
  /** 被这段正文完整覆盖、可以下架的记忆事实 id(只认候选批内的)。 */
  readonly factIds: readonly string[]
}

/** 模型的整份上架方案。 */
export interface LibrarianPlan {
  readonly promotions: readonly LibrarianPromotion[]
  /** 重写后的完整 INDEX.md(缺省时机械兜底补指针)。 */
  readonly index?: string
}

/**
 * 上架写者:host 用一次 patchMeta 同时 CLOSE 区间(validTo)+ 记出处
 * (promotedTo)——单补丁无中间态,崩溃不会留下「关了却不知去向」的事实。
 */
export type KnowledgeShelver = (
  entry: MemoryEntry,
  path: string,
  validTo: number,
) => Promise<void>

export interface KnowledgeLibrarianOptions {
  library: KnowledgeLibrary
  /** 上架判断的模型调用(6h 后台,轮内热路径永远零 LLM)。 */
  summarize: MemorySummarizer
  /** 见 {@link KnowledgeShelver}。 */
  shelve: KnowledgeShelver
  /** 触发门槛,默认 {@link DEFAULT_LIBRARIAN_TRIGGER_FACTS}。 */
  triggerFacts?: number
  /** 单 tick 候选上限,默认 {@link DEFAULT_LIBRARIAN_MAX_BATCH}。 */
  maxBatch?: number
  /** 覆盖 system prompt(测试/调优)。 */
  system?: string
}

/** 已上架过的事实(带出处标记)永不再进候选——上架是单程闸,防反复搬家。 */
export function isPromoted(e: MemoryEntry): boolean {
  return typeof e.meta?.[META_PROMOTED_TO] === 'string'
}

export const DEFAULT_LIBRARIAN_SYSTEM = `You are a personal butler's LIBRARIAN performing SHELVING.

The butler keeps knowledge in two places:
- MEMORY: auto-distilled facts (each with an id) injected into EVERY conversation turn — expensive, keep it small and identity-core.
- LIBRARY: a knowledge/ directory of .md files the butler reads on demand via tools — cheap and roomy, for topical material. INDEX.md is its table of contents (injected each turn, so keep it lean).

Given the MEMORY facts eligible for shelving, the current LIBRARY file list and the current INDEX.md, decide which facts belong on the shelf instead of in every-turn memory.

SHELVE: topical reference material — project details, lists, procedures, past-event records, background knowledge.
KEEP IN MEMORY (do NOT emit): core identity, live preferences, active commitments — anything the butler should know without looking it up.

Output ONLY a JSON object, no prose:
{"promotions":[{"path":"projects/kitchen.md","title":"厨房翻新","append":"- ...","factIds":["id1","id2"]}],"index":"# 知识库\\n- projects/kitchen.md — 厨房翻新的预算与进度"}

Rules:
- path: a relative .md path under knowledge/ (e.g. "projects/装修.md"), forward slashes, no "..", no leading dots, never under "archive/". PREFER appending to an existing LIBRARY file over creating a near-duplicate new one.
- append: the markdown to APPEND to that file. Write each fact out FULLY and self-contained, in the user's own language — a shelved fact is retired from every-turn memory, so the file text is its only home.
- factIds: ONLY ids from the MEMORY facts list. NEVER invent an id. Only include a fact if your append text fully captures it.
- title: heading for a NEW file; omit when appending to an existing one.
- index: the COMPLETE new INDEX.md — one pointer line per shelf file ("- path — one-line summary"), covering at least every file you touched.
- Nothing worth shelving → {"promotions":[]}.`

/**
 * 构造图书馆员 reviewer。每个 6h tick:自门控 → 一次模型调用拿方案 →
 * 逐条写文件(写成才下架)→ 保证 INDEX 指得到每个动过的文件。
 */
export function knowledgeLibrarianReviewer(opts: KnowledgeLibrarianOptions): MemoryReviewer {
  const trigger = opts.triggerFacts ?? DEFAULT_LIBRARIAN_TRIGGER_FACTS
  const maxBatch = opts.maxBatch ?? DEFAULT_LIBRARIAN_MAX_BATCH
  const system = opts.system ?? DEFAULT_LIBRARIAN_SYSTEM

  return async (ctx: ReviewContext): Promise<ReviewOutcome> => {
    // ① 自门控:活跃 ad-hoc 且未上架的事实不足 → 零 LLM 零写。已关事实
    //   (含上架下架的)被 isActive 滤掉,所以候选集随上架单调收敛。
    const all = await ctx.memory.recall({ kinds: ['semantic'], k: LIBRARIAN_RECALL_WINDOW })
    const eligible = all
      .filter(
        (e) =>
          isActive(e, ctx.now) &&
          !isDigest(e) &&
          !isClusterProfile(e) &&
          !isProfile(e) &&
          !isPromoted(e),
      )
      .sort((a, b) => a.ts - b.ts)
    if (eligible.length < trigger) return {}
    const batch = eligible.slice(0, maxBatch)

    // ② 图书馆现状(清单+现行索引)喂给模型;读失败按空处理,不拦这轮。
    let files: string[] = []
    try {
      files = (await opts.library.list()).files.filter((f) => !f.archived).map((f) => f.path)
    } catch {
      files = []
    }
    let index = ''
    try {
      index = (await opts.library.read(KNOWLEDGE_INDEX_FILE)).text
    } catch {
      index = '' // 还没建索引 = 常态空库
    }

    // ③ 单遍模型调用;坏/空响应 = 零操作(reconcile 的 noModel 同款姿态)。
    let raw = ''
    try {
      raw = (await opts.summarize({ system, user: buildLibrarianPrompt(batch, files, index) })).trim()
    } catch {
      raw = ''
    }
    const plan = parseLibrarianPlan(raw)
    if (plan === null) return {}

    // ④ 逐条上架:写文件成功才下架;单条失败只跳那条。
    const byId = new Map(batch.map((e) => [e.id, e]))
    const shelvedIds = new Set<string>() // 一条事实只下架一次(首个引用赢)
    const touchedPaths = new Set<string>()
    let factsShelved = 0
    for (const p of plan.promotions) {
      const facts = p.factIds
        .map((id) => byId.get(id))
        .filter((e): e is MemoryEntry => !!e && !shelvedIds.has(e.id))
      if (facts.length === 0) continue // 全是幻觉 id / 已被前条搬走 → 碰都不碰盘
      try {
        let existing = ''
        try {
          existing = (await opts.library.read(p.path)).text
        } catch {
          existing = '' // 不存在 = 新建
        }
        const chunk = p.append.trim()
        const body = existing
          ? `${existing.replace(/\n+$/, '')}\n\n${chunk}\n`
          : `${p.title ? `# ${p.title.trim()}\n\n` : ''}${chunk}\n`
        await opts.library.write(p.path, body)
      } catch {
        continue // 库层响亮拒(坏路径/超顶)→ 整条跳过,事实留在记忆里
      }
      touchedPaths.add(p.path)
      for (const f of facts) {
        try {
          await opts.shelve(f, p.path, ctx.now) // 文件已落盘,才关记忆区间
          shelvedIds.add(f.id)
          factsShelved++
        } catch {
          // 单条 shelve 失败:事实还活跃、无出处标记 → 下 tick 重新候选,
          // 文件里已有正文 = 重影而非失踪(写前退后的代价与承诺)。
        }
      }
    }
    if (factsShelved === 0) return {}

    // ⑤ 索引:优先模型的整篇重写;不管谁写,动过的文件必须指得到
    //   (机械兜底补指针)。索引写失败 fail-soft——文件都在,导航下轮补。
    try {
      let next = plan.index?.trim() ? `${plan.index.trim()}\n` : ''
      if (!next) next = index // 模型没给 → 在现行索引上机械补
      const missing = [...touchedPaths].filter((path) => !next.includes(path))
      if (missing.length > 0) {
        const pointers = missing.map((path) => `- ${path} — 图书馆员整理上架(待补一句摘要)`)
        next = `${next.replace(/\n+$/, '')}${next.trim() ? '\n' : ''}${pointers.join('\n')}\n`
      }
      if (next.trim()) await opts.library.write(KNOWLEDGE_INDEX_FILE, next)
    } catch {
      // 超顶/竞写等 —— 指针缺口由下一 tick 的 missing 检查或阿同自己补
    }

    return {
      summary: `librarian: shelved ${factsShelved} fact${factsShelved === 1 ? '' : 's'} into ${touchedPaths.size} file${touchedPaths.size === 1 ? '' : 's'}`,
    }
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function buildLibrarianPrompt(
  batch: ReadonlyArray<MemoryEntry>,
  files: ReadonlyArray<string>,
  index: string,
): string {
  const parts: string[] = ['[MEMORY facts eligible for shelving — "id: text"]']
  for (const e of batch) {
    parts.push(`- ${e.id}: ${e.text.replace(/\s*\n\s*/g, ' ').trim()}`)
  }
  parts.push('', '[LIBRARY files]')
  if (files.length === 0) parts.push('(none yet)')
  for (const f of files) parts.push(`- ${f}`)
  parts.push('', '[Current INDEX.md]')
  parts.push(index.trim() ? index.trim() : '(none yet)')
  parts.push('', 'Output the JSON plan now.')
  return parts.join('\n')
}

/**
 * 宽容解析(parseReconcileOps 同款):吃 {"promotions":[...]} 或裸数组、
 * 首括号定位、逐条字段校验;整体不可用 → null(调用方零操作),条目坏 →
 * 只丢那条。
 */
export function parseLibrarianPlan(raw: string): LibrarianPlan | null {
  if (!raw) return null
  const objStart = raw.indexOf('{')
  const arrStart = raw.indexOf('[')
  const useArray = arrStart >= 0 && (objStart < 0 || arrStart < objStart)
  let jsonText: string | null = null
  if (useArray) {
    const arrEnd = raw.lastIndexOf(']')
    if (arrEnd > arrStart) jsonText = raw.slice(arrStart, arrEnd + 1)
  } else if (objStart >= 0) {
    const end = raw.lastIndexOf('}')
    if (end > objStart) jsonText = raw.slice(objStart, end + 1)
  }
  if (!jsonText) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  const obj = parsed as { promotions?: unknown; index?: unknown } | unknown[] | null
  const list = Array.isArray(obj)
    ? obj
    : Array.isArray((obj as { promotions?: unknown } | null)?.promotions)
      ? ((obj as { promotions: unknown[] }).promotions)
      : null
  if (!list) return null

  const promotions: LibrarianPromotion[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const v = item as { path?: unknown; title?: unknown; append?: unknown; factIds?: unknown }
    if (typeof v.path !== 'string' || !v.path.trim()) continue
    if (typeof v.append !== 'string' || !v.append.trim()) continue
    if (!Array.isArray(v.factIds)) continue
    const factIds = v.factIds.filter((id): id is string => typeof id === 'string' && !!id)
    if (factIds.length === 0) continue
    promotions.push({
      path: v.path.trim(),
      ...(typeof v.title === 'string' && v.title.trim() ? { title: v.title } : {}),
      append: v.append,
      factIds,
    })
  }
  const index =
    !Array.isArray(obj) && typeof (obj as { index?: unknown }).index === 'string'
      ? ((obj as { index: string }).index)
      : undefined
  return { promotions, ...(index !== undefined ? { index } : {}) }
}
