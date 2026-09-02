/**
 * memory-sheet-probe.ts — 把跨店召回折成一张**记忆单**，贴到提示词的易变尾巴上（记忆经济 M2c）。
 *
 * # 这一刀补的是哪一段
 *
 * M2b 让「一次调用走遍五个面」在尺子上成立（`recall@5 27.8% → 100%`），但那把
 * 尺子是**离线**量的：生产的管家一轮对话里，除了记忆冻结块之外，谁也没把知识库、
 * 任务本、长任务档案里的那句话递到模型眼前。这个探针就是那最后一段路。
 *
 * # 骑既有的缝，不新开缝
 *
 * 走 CARE-M4 的 `contextProbe`（易变尾巴），和时钟 / 语言 / 待办 / 会话提示同一条
 * 队。**不是** `stableContext`：记忆单是随**这一问**变的（问什么召回什么），而
 * `stableContext` 那条缝的整个价值在于「状态不变 ⇒ 字节不变 ⇒ 缓存命中」，把一个
 * 每轮都不同的东西塞进去等于每轮打碎前缀缓存。
 *
 * 由此，冻结块与人设**逐字节不动**：它们仍是请求的前缀，记忆单只加在尾巴上。
 *
 * # 三条纪律
 *
 *   - **不出主意，只递材料**。探针是顾问：抛异常一律吞掉变 `null`（与时钟 / 待办
 *     同一条姿态），一次建网失败不该把正常聊天带下水。
 *   - **没料就一个字节都不加**。查不到 ⇒ `null` ⇒ 提示词与没接这个探针时逐字节
 *     相同。这不是省钱，是可证伪：任何一次「多出来的字节」都必须能指回一条召回。
 *   - **每行带出处**。渲染交给 `renderNetSheet`（`[日期 店名] 正文`）。一行模型
 *     追不回出处的字，它就会当成自己的信念；记忆单唯一新增的负担就是「这句话是
 *     哪儿来的」。
 *
 * # 建网的钱谁出
 *
 * 探针**不建网**，它只 `await` 调用方给的 `net()`。生产里建一次网要把五个店整个
 * 读一遍——那是每 tick 一次的派生，不是每轮一次；缓存与失效归调用方（host 那边
 * 有现成的 watermark 纪律）。这里只规定接口：`net()` 返回 `null` ⇒ 探针静默。
 */

import type { Task } from '@gotong/core'
import { DEFAULT_SHEET_BYTES, DEFAULT_SHEET_LINES } from '@gotong/personal-memory'

import { crossStoreRecall, renderNetSheet, type MemoryNet } from './memory-net.js'
import type { ButlerContextProbe } from './task-notebook.js'

/** 记忆单在提示词里的抬头。每行的出处由 `renderNetSheet` 自己带。 */
export const MEMORY_SHEET_HEADER =
  '【记忆单】下面是按这一问从你的记忆、知识库、任务本、长任务档案里联想到的片段,' +
  '每行方括号里是日期与出处。它们是**线索不是结论**:要引用就按出处去核,' +
  '核不到就如实说记不清,不要凭印象编。'

/** 一张记忆单最多放几条。比 `crossStoreRecall` 的默认宽一点没有意义——尾巴越长,
 *  真正相关的那条越容易被稀释。 */
export const DEFAULT_SHEET_K = 6

export interface MemorySheetProbeOptions {
  /**
   * 取当前的网。**每轮调用**,由调用方决定是重建还是复用缓存。
   * 返回 `null`(还没建好 / 空空间 / 调用方主动关掉)⇒ 探针静默。
   */
  readonly net: () => Promise<MemoryNet | null>
  /** 放几条。默认 {@link DEFAULT_SHEET_K}。 */
  readonly k?: number
  /** 字节上限,透传给渲染。默认 {@link DEFAULT_SHEET_BYTES}。 */
  readonly maxBytes?: number
  /** 行数上限,透传给渲染。默认 {@link DEFAULT_SHEET_LINES}。 */
  readonly maxLines?: number
  /** 时钟。给了就按双时态过滤:翻篇的既不被激活也不能当桥。 */
  readonly now?: () => number
  readonly logger?: { warn(msg: string, meta?: Record<string, unknown>): void }
}

/**
 * 从任务里取出这一问的文本。
 *
 * 认的三种形状**照抄** `LlmAgent.buildRequest` 的 payload→消息翻译:裸字符串、
 * `payload.prompt`、`payload.messages` 的最后一条 user。这里不能自创一套读法——
 * 探针读到的问题和模型看到的问题一旦不是同一句,记忆单就在答另一道题。
 *
 * 取不到就返回空串,上层据此静默:**没有问题就没有记忆单**,凭空召回等于往每轮
 * 里灌噪声。
 */
function queryOf(task: Task): string {
  const payload = task.payload
  if (typeof payload === 'string') return payload.trim()
  if (payload === null || typeof payload !== 'object') return ''

  const prompt = (payload as { prompt?: unknown }).prompt
  if (typeof prompt === 'string' && prompt.trim()) return prompt.trim()

  const messages = (payload as { messages?: unknown }).messages
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i] as { role?: unknown; content?: unknown } | undefined
      if (m?.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
        return m.content.trim()
      }
    }
  }
  return ''
}

/**
 * 建一个把跨店召回折成记忆单的 `contextProbe`。
 *
 * 顺序:取问题 → 取网 → `crossStoreRecall` → `renderNetSheet` → 加抬头。
 * 任何一步空手或出错都返回 `null`(提示词字节不变)。
 */
export function buildMemorySheetProbe(opts: MemorySheetProbeOptions): ButlerContextProbe {
  const k = Math.max(1, Math.floor(opts.k ?? DEFAULT_SHEET_K))
  const maxBytes = Math.max(1, Math.floor(opts.maxBytes ?? DEFAULT_SHEET_BYTES))
  const maxLines = Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_SHEET_LINES))

  return async (task: Task): Promise<string | null> => {
    try {
      const query = queryOf(task)
      if (!query) return null

      const net = await opts.net()
      if (!net || net.nodes.length === 0) return null

      const ids = await crossStoreRecall(net, query, {
        k,
        ...(opts.now ? { now: opts.now() } : {}),
      })
      if (ids.length === 0) return null

      const sheet = renderNetSheet(net, ids, { maxBytes, maxLines })
      // 预算被抬头之外的东西吃光时 `sheet` 会是空串 —— 那就还是「没料」,
      // 不要只贴一个抬头下去:一行内容都没有的抬头是纯噪声。
      if (!sheet) return null

      return `${MEMORY_SHEET_HEADER}\n${sheet}`
    } catch (err) {
      // 顾问姿态:建网/读盘失败一律吞掉,正常聊天照走。
      opts.logger?.warn('memory sheet probe failed, injecting nothing', {
        err: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }
}
