/**
 * LSA-M4 — EnsembleProvider:并行多模型 + 综合。RoutingProvider 的兄弟件。
 *
 * RoutingProvider 是**顺序**的:首选挂了才换下一个(省钱 / 容错,同一时刻只有一个
 * 模型在跑)。EnsembleProvider 是**并行**的:把同一个请求同时发给 N 个成员,收齐 N 份
 * 草稿后按策略综合成一份——这是用户诉求⑤「同时用多个 llm 再综合」。两者都实现
 * `LlmProvider`,对上游(LlmAgent)完全透明,区别只在内部:routing 选一个,ensemble
 * 用全部。
 *
 * ── 为什么 ensemble 天然是「缓冲式」而非真流式 ───────────────────────────────
 * 综合必须等所有草稿到齐才能动手,所以 `stream()` 内部把每个成员的流 drain 成完整
 * response,综合完再把最终文本作为 chunk 吐出去。它拿延迟换质量——这正是 opt-in 的
 * 意义(默认不开;开了就是为了更好的答案,不在乎多花时间和 N 倍成本)。
 *
 * ── tool_use 不可综合(正确性红线)─────────────────────────────────────────
 * 「综合」只对**文本答案**成立。若成员想调工具(stopReason==='tool_use'),两个不同的
 * 工具调用没法「取平均」——把它们揉一起就是垃圾。所以:第一个存活成员若要调工具,
 * ensemble 把它的 response 原样透传(passthrough),绝不综合。故在工具循环里,选工具的
 * 轮次退化为「跟第一个成员走」,只有最终纯文本答案那轮才真 fan-out + 综合。
 *
 * ── 四条边界(LSA track)────────────────────────────────────────────────────
 * 1. 热路径零 LLM 决策:开不开 ensemble 是**装配层 opt-in 配置**(像 routing 的
 *    fallbacks);fan-out 本身确定性(永远发全部 N 个),没有模型在现场决定发给谁。
 *    综合器调模型是 agent 层行为(这个 provider 内部),不是框架 hub 跑 LLM。
 * 2. opt-in 字节不变:装配层不配 ensemble = 根本不包这个 provider,与今天逐字节一致。
 * 3. 数据离盒 opt-in:同一 prompt 发给 N 个成员(可能 N 个厂商)= 更多出网,成员由
 *    装配者亲手编排,故按构造 opt-in + 披露。
 * 4. 内核零改动:本类在 `packages/llm`(RoutingProvider 平级),core/workflow/protocol
 *    零触碰;成本 / 阈值全无 env 旋钮。
 */

import { classifyLlmError, type LlmErrorKind } from './errors.js'
import {
  drainStream,
  type LlmContentBlock,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmStopReason,
  type LlmStreamChunk,
  type LlmTextBlock,
  type LlmUsage,
} from './types.js'

/** 一个成员:已构造好的 provider + 稳定标签 + 可选模型覆盖(镜像 RoutingCandidate)。 */
export interface EnsembleMember {
  provider: LlmProvider
  /** 稳定标签(事件 / 日志 / concat 分隔用);缺省用 `provider.name`。 */
  label?: string
  /** 该成员的模型 id;设了就覆盖 `req.model`(不同 vendor 认不同模型名)。 */
  model?: string
}

/**
 * 综合策略:
 * - `concat` —— 确定性拼接:把 N 份草稿按标签拼一起,零额外 LLM 调用(可测、免费)。
 * - `synthesize` —— 让一个综合器模型把 N 份草稿综合成一份最终答案(+1 次调用)。
 */
export type EnsembleStrategy =
  | { kind: 'concat' }
  | {
      kind: 'synthesize'
      /** 综合器 provider(可与某成员同一个,也可另配一个便宜 / 强的)。 */
      synthesizer: LlmProvider
      /** 综合器模型 id 覆盖。 */
      model?: string
      /** 综合指令(system);缺省用内置的中文综合指令。 */
      instruction?: string
    }

/** ensemble 事件(可选监听;监听器抛错被吞,绝不打断)。 */
export type EnsembleEvent =
  | { type: 'member_done'; label: string; index: number; stopReason: LlmStopReason }
  | { type: 'member_failed'; label: string; index: number; errorKind: LlmErrorKind }
  | { type: 'passthrough'; label: string; index: number }
  | { type: 'combined'; strategy: 'concat' | 'synthesize'; members: number }
  | { type: 'exhausted' }

export interface EnsembleLogger {
  warn(meta: Record<string, unknown>, msg: string): void
}

export interface EnsembleProviderOptions {
  /** 成员,≥1。同一请求并行发给全部(单成员时退化为透传 + 无谓综合)。 */
  members: EnsembleMember[]
  /** 综合策略。 */
  strategy: EnsembleStrategy
  /** `provider.name` 覆盖;缺省从成员标签合成 `ensemble(a+b)`。 */
  name?: string
  onEvent?: (ev: EnsembleEvent) => void
  logger?: EnsembleLogger
}

/** 所有成员都没能产出可用答案时抛出。 */
export class EnsembleExhaustedError extends Error {
  readonly members: string[]
  constructor(message: string, members: string[]) {
    super(message)
    this.name = 'EnsembleExhaustedError'
    this.members = members
  }
}

/** 内置综合指令(strategy.instruction 缺省)。 */
const DEFAULT_SYNTH_INSTRUCTION =
  '你是回答综合器。下面是同一个问题、来自多个不同模型的候选回答草稿。请综合它们各自的优点、' +
  '剔除错误与重复,产出一份更准确、更完整的最终回答。只输出最终回答本身,不要提到「草稿」「模型」' +
  '或综合过程。'

interface MemberOk {
  ok: true
  index: number
  label: string
  res: LlmResponse
}
interface MemberBad {
  ok: false
  index: number
  label: string
  errorKind: LlmErrorKind
}
type MemberOutcome = MemberOk | MemberBad

export class EnsembleProvider implements LlmProvider {
  readonly name: string
  private readonly members: EnsembleMember[]
  private readonly strategy: EnsembleStrategy
  private readonly onEvent?: (ev: EnsembleEvent) => void
  private readonly logger?: EnsembleLogger

  constructor(opts: EnsembleProviderOptions) {
    if (!opts.members || opts.members.length === 0) {
      throw new Error('EnsembleProvider requires at least one member')
    }
    this.members = [...opts.members]
    this.strategy = opts.strategy
    if (opts.onEvent) this.onEvent = opts.onEvent
    if (opts.logger) this.logger = opts.logger
    this.name = opts.name ?? `ensemble(${this.members.map((_, i) => this.labelOf(i)).join('+')})`
  }

  private labelOf(i: number): string {
    const m = this.members[i]!
    return m.label ?? m.provider.name ?? `member-${i}`
  }

  private emit(ev: EnsembleEvent): void {
    if (!this.onEvent) return
    try {
      this.onEvent(ev)
    } catch {
      // best-effort:一个爱抛错的监听器绝不能打断 LLM 流。
    }
  }

  /** 跑一个成员到完整 response;硬失败(抛)在此逮住,永不 reject。 */
  private async runMember(i: number, req: LlmRequest, signal?: AbortSignal): Promise<MemberOutcome> {
    const m = this.members[i]!
    const label = this.labelOf(i)
    const creq = m.model ? { ...req, model: m.model } : req
    try {
      const res = await drainStream(m.provider.stream(creq, signal))
      // 软失败('error' chunk)也算这个成员没交货 —— 综合要的是好草稿。
      if (res.stopReason === 'error') {
        this.emit({ type: 'member_failed', label, index: i, errorKind: 'unknown' })
        return { ok: false, index: i, label, errorKind: 'unknown' }
      }
      this.emit({ type: 'member_done', label, index: i, stopReason: res.stopReason })
      return { ok: true, index: i, label, res }
    } catch (err) {
      if (signal?.aborted) throw err // 主动取消:一路抛出,不当成「成员失败」吞掉
      const errorKind = classifyLlmError(err)
      this.emit({ type: 'member_failed', label, index: i, errorKind })
      this.logger?.warn({ member: label, index: i, kind: errorKind }, 'ensemble: member failed')
      return { ok: false, index: i, label, errorKind }
    }
  }

  async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamChunk> {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    // 并行 fan-out:全部成员同时跑(这是与 routing 顺序降级的本质区别)。
    const outcomes = await Promise.all(this.members.map((_, i) => this.runMember(i, req, signal)))
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')

    const survivors = outcomes.filter((o): o is MemberOk => {
      if (!o.ok) return false
      // 有话说(文本)或想调工具(tool_use)才算交了货;两者皆空的空转成员丢弃。
      return o.res.text.length > 0 || (o.res.toolUses?.length ?? 0) > 0
    })

    if (survivors.length === 0) {
      this.emit({ type: 'exhausted' })
      throw new EnsembleExhaustedError(
        'no ensemble member produced a usable answer',
        this.members.map((_, i) => this.labelOf(i)),
      )
    }

    // 正确性红线:第一个存活成员若想调工具,整轮原样透传它的 response —— 工具调用不可综合。
    const lead = survivors[0]!
    if ((lead.res.toolUses?.length ?? 0) > 0) {
      this.emit({ type: 'passthrough', label: lead.label, index: lead.index })
      yield* this.emitResponse(lead.res)
      return
    }

    // 全是文本草稿 → 按策略综合。
    if (this.strategy.kind === 'synthesize') {
      const synth = await this.synthesize(req, survivors, this.strategy, signal)
      const usage = sumUsage([...survivors.map((s) => s.res.usage), synth.usage])
      this.emit({ type: 'combined', strategy: 'synthesize', members: survivors.length })
      yield* this.emitText(synth.text, usage)
      return
    }

    // concat:确定性拼接,零额外 LLM。
    const combined = survivors
      .map((s) => `【${s.label}】\n${s.res.text.trim()}`)
      .join('\n\n')
    const usage = sumUsage(survivors.map((s) => s.res.usage))
    this.emit({ type: 'combined', strategy: 'concat', members: survivors.length })
    yield* this.emitText(combined, usage)
  }

  /**
   * 让综合器把 N 份草稿综合成一份;返回 { 最终文本, 综合器 usage }。返回 usage(而非
   * 存实例字段)让 stream() 并发调用时不互相串。
   */
  private async synthesize(
    req: LlmRequest,
    survivors: MemberOk[],
    strat: Extract<EnsembleStrategy, { kind: 'synthesize' }>,
    signal?: AbortSignal,
  ): Promise<{ text: string; usage: LlmUsage | undefined }> {
    const question = lastUserText(req.messages)
    const drafts = survivors
      .map((s, n) => `候选回答 ${n + 1}(${s.label}):\n${s.res.text.trim()}`)
      .join('\n\n')
    const userText =
      (question ? `问题:\n${question}\n\n` : '') + `以下是 ${survivors.length} 份候选回答:\n\n${drafts}`
    const synthReq: LlmRequest = {
      system: strat.instruction ?? DEFAULT_SYNTH_INSTRUCTION,
      messages: [{ role: 'user', content: userText }],
      ...(strat.model ? { model: strat.model } : {}),
    }
    const res = await drainStream(strat.synthesizer.stream(synthReq, signal))
    // 综合器软失败 / 空产出:退回确定性拼接,绝不让综合失败连累整轮(fail-soft)。
    if (res.stopReason === 'error' || res.text.trim().length === 0) {
      this.logger?.warn({ stopReason: res.stopReason }, 'ensemble: synthesizer empty — falling back to concat')
      const fallback = survivors.map((s) => `【${s.label}】\n${s.res.text.trim()}`).join('\n\n')
      return { text: fallback, usage: res.usage }
    }
    return { text: res.text, usage: res.usage }
  }

  /** 把最终文本 + 聚合 usage 作为 chunk 吐出(text → usage → end)。 */
  private *emitText(text: string, usage: LlmUsage | undefined): Iterable<LlmStreamChunk> {
    if (text.length > 0) yield { type: 'text', text }
    if (usage) yield { type: 'usage', usage }
    yield { type: 'end', stopReason: 'end_turn' }
  }

  /** 原样重放一个成员的 response(passthrough:含 tool_use)。 */
  private *emitResponse(res: LlmResponse): Iterable<LlmStreamChunk> {
    if (res.text.length > 0) yield { type: 'text', text: res.text }
    for (const tu of res.toolUses ?? []) yield { type: 'tool_use', toolUse: tu }
    if (res.usage) yield { type: 'usage', usage: res.usage }
    yield { type: 'end', stopReason: res.stopReason }
  }
}

/** 扁平化 message content 成纯文本(string 直接返回;blocks 取 text 块拼接)。 */
function flattenText(content: string | LlmContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is LlmTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

/** 取最后一条 user 消息的文本(综合器需要知道原问题)。 */
function lastUserText(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user') return flattenText(m.content)
  }
  return ''
}

/** 聚合 usage(诚实成本记账:成本 ×N + 综合器)。全 undefined ⇒ undefined。 */
export function sumUsage(parts: Array<LlmUsage | undefined>): LlmUsage | undefined {
  const present = parts.filter((u): u is LlmUsage => u !== undefined)
  if (present.length === 0) return undefined
  const out: LlmUsage = { inputTokens: 0, outputTokens: 0 }
  let cacheCreation = 0
  let cacheRead = 0
  for (const u of present) {
    out.inputTokens += u.inputTokens
    out.outputTokens += u.outputTokens
    cacheCreation += u.cacheCreationTokens ?? 0
    cacheRead += u.cacheReadTokens ?? 0
  }
  if (cacheCreation > 0) out.cacheCreationTokens = cacheCreation
  if (cacheRead > 0) out.cacheReadTokens = cacheRead
  return out
}
