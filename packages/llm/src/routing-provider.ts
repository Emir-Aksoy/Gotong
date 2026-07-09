/**
 * MR-M1 — RoutingProvider:确定性多 provider 有序降级 + per-candidate 熔断。
 *
 * 为什么在 provider 层做降级:一个 agent 在 spawn 时构造一个 LlmProvider 存进
 * `LlmAgent.provider`,一辈子不重建、交互中途无法换 agent —— 所以「主 provider 挂了
 * 换备用」必须发生在 provider 内部。RoutingProvider 自己也是一个 LlmProvider,包一组
 * 有序候选,对上游(LlmAgent)完全透明。
 *
 * 两条硬规矩(由北极星「热路径零 LLM」+ 流式契约决定,不是可调项):
 *
 * 1. **路由决策全确定性**。选下一个候选靠错误分类({@link classifyLlmError})+ 熔断
 *    计时器 + 候选顺序,零模型调用。「智能」体现在候选排序(便宜/本地打头、强模型
 *    兜底,或同能力并排),不体现在「现场用大模型选路」。
 *
 * 2. **只在吐出第一个 chunk 之前的失败上 failover**。`LlmProvider` 契约:硬失败
 *    (auth/传输/5xx)在迭代器产出任何 chunk 之前抛出 —— 可能同步从 `stream()`
 *    抛(如 MockLlmProvider 的参数校验),也可能从首次 `next()` 抛(async generator
 *    体抛);软失败是流末尾的 `'error'` chunk。一旦某候选产出了第一个 chunk 就锁定它
 *    —— 已经吐给用户的 token 收不回,中途再换 provider = 把半句话接成另半句。故:
 *    首 chunk 前失败 → 记账 + 换下一候选;首 chunk 后的任何错误(`'error'` chunk /
 *    中途抛)原样透传,绝不重试。这也意味着 mid-stream 失败不计入熔断 —— 熔断度量的
 *    是「能不能起流」,起流之后的抖动 failover 也救不了。
 *
 * per-candidate 熔断三态(防止对已知挂掉的 provider 每轮硬敲):
 *   - Closed    正常尝试;窗口内失败达阈值 → 开断
 *   - Open      openUntil 未到 → 直接跳过(快速失败,不发请求)
 *   - Half-Open openUntil 已到 → 放一个探针;成功即关、失败立即重开
 * 阈值/窗口/冷却全是常量(可注入以便测试),不设 env 旋钮。
 *
 * opt-in:装配层(MR-M2)只在成员配了 fallbacks(≥2 候选)时才包 RoutingProvider;
 * 没配 = 返回今天那个单 provider,逐字节不变。本类为自足计,接受 ≥1 候选(单候选
 * 时退化为「带熔断的透传」,failover 永不触发)。
 */

import { classifyLlmError, type LlmErrorKind } from './errors.js'
import type { LlmProvider, LlmRequest, LlmStreamChunk } from './types.js'

/** 一个有序候选:已构造好的 provider + 稳定标签(事件/健康/日志用)。 */
export interface RoutingCandidate {
  provider: LlmProvider
  /** 稳定标签;缺省用 `provider.name`。两个同名 provider 用它区分。 */
  label?: string
}

/** 熔断参数。全常量,不是 env 旋钮。 */
export interface BreakerConfig {
  /** Closed 态下滑动窗口内失败几次就开断。 */
  failureThreshold: number
  /** 计失败的滑动窗口(ms);窗口外的旧失败不计。 */
  windowMs: number
  /** 开断后多久进入 half-open 放探针(ms)。 */
  cooldownMs: number
}

export const DEFAULT_BREAKER: BreakerConfig = {
  failureThreshold: 3,
  windowMs: 60_000,
  cooldownMs: 30_000,
}

/** 路由事件(MR-M3 健康投影消费;M1 只负责发出)。 */
export type RoutingEvent =
  | { type: 'served'; candidate: string; index: number }
  | { type: 'candidate_error'; candidate: string; index: number; errorKind: LlmErrorKind }
  | { type: 'breaker_open'; candidate: string; index: number; openUntil: number }
  | { type: 'breaker_close'; candidate: string; index: number }
  | { type: 'exhausted'; errorKind: LlmErrorKind }

/** 结构化日志的最小面(host 的 pino 式 logger 结构上满足;不引入依赖)。 */
export interface RoutingLogger {
  warn(meta: Record<string, unknown>, msg: string): void
}

export interface RoutingProviderOptions {
  /** 有序候选,≥1。顺序即偏好:先到先用,失败顺次降级。 */
  candidates: RoutingCandidate[]
  /** `provider.name` 覆盖;缺省从候选标签合成 `routing(a→b)`。 */
  name?: string
  /** 熔断参数部分覆盖(其余取 {@link DEFAULT_BREAKER})。 */
  breaker?: Partial<BreakerConfig>
  /** 注入时钟(测试用);缺省 `Date.now`。 */
  now?: () => number
  /** 路由事件回调(best-effort;监听器抛错被吞,绝不打断流)。 */
  onEvent?: (ev: RoutingEvent) => void
  logger?: RoutingLogger
}

/** 全候选都无法起流,且是「全部熔断跳过」这一种时抛出(真失败时抛原始错误)。 */
export class RoutingExhaustedError extends Error {
  readonly candidates: string[]
  constructor(message: string, candidates: string[]) {
    super(message)
    this.name = 'RoutingExhaustedError'
    this.candidates = candidates
  }
}

interface BreakerState {
  /** 窗口内失败时间戳(Closed 态累积)。 */
  failures: number[]
  /** 断路开启至此刻(ms);null = Closed。 */
  openUntil: number | null
}

export class RoutingProvider implements LlmProvider {
  readonly name: string
  private readonly candidates: RoutingCandidate[]
  private readonly cfg: BreakerConfig
  private readonly clock: () => number
  private readonly onEvent?: (ev: RoutingEvent) => void
  private readonly logger?: RoutingLogger
  private readonly breakers: BreakerState[]

  constructor(opts: RoutingProviderOptions) {
    if (!opts.candidates || opts.candidates.length === 0) {
      throw new Error('RoutingProvider requires at least one candidate')
    }
    this.candidates = [...opts.candidates]
    this.cfg = { ...DEFAULT_BREAKER, ...opts.breaker }
    this.clock = opts.now ?? (() => Date.now())
    if (opts.onEvent) this.onEvent = opts.onEvent
    if (opts.logger) this.logger = opts.logger
    this.breakers = this.candidates.map(() => ({ failures: [], openUntil: null }))
    this.name = opts.name ?? `routing(${this.candidates.map((_, i) => this.labelOf(i)).join('→')})`
  }

  private labelOf(i: number): string {
    const c = this.candidates[i]!
    return c.label ?? c.provider.name ?? `candidate-${i}`
  }

  /** i 号候选此刻可试吗?(Closed,或 Open 已过冷却=half-open 探针窗)。 */
  private available(i: number, now: number): boolean {
    const b = this.breakers[i]!
    return b.openUntil === null || now >= b.openUntil
  }

  private recordSuccess(i: number): void {
    const b = this.breakers[i]!
    const wasOpen = b.openUntil !== null
    b.failures = []
    b.openUntil = null
    if (wasOpen) this.emit({ type: 'breaker_close', candidate: this.labelOf(i), index: i })
  }

  private recordFailure(i: number, now: number): void {
    const b = this.breakers[i]!
    if (b.openUntil !== null) {
      // 能走到这里且 openUntil 非空 ⟹ 是 half-open 探针(Open 未到期的在 available()
      // 处已被跳过,不会尝试)—— 探针失败,立即重开。
      b.openUntil = now + this.cfg.cooldownMs
      this.emit({ type: 'breaker_open', candidate: this.labelOf(i), index: i, openUntil: b.openUntil })
      return
    }
    b.failures.push(now)
    b.failures = b.failures.filter((t) => now - t < this.cfg.windowMs)
    if (b.failures.length >= this.cfg.failureThreshold) {
      b.openUntil = now + this.cfg.cooldownMs
      b.failures = []
      this.emit({ type: 'breaker_open', candidate: this.labelOf(i), index: i, openUntil: b.openUntil })
    }
  }

  private emit(ev: RoutingEvent): void {
    if (!this.onEvent) return
    try {
      this.onEvent(ev)
    } catch {
      // best-effort:一个爱抛错的监听器绝不能打断 LLM 流。
    }
  }

  async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamChunk> {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    let lastErr: unknown
    let lastKind: LlmErrorKind = 'unknown'
    for (let i = 0; i < this.candidates.length; i++) {
      if (!this.available(i, this.clock())) continue
      const label = this.labelOf(i)
      let iterator: AsyncIterator<LlmStreamChunk>
      let first: IteratorResult<LlmStreamChunk>
      try {
        // 两种硬失败都在此逮住:stream() 同步抛(参数校验)、首次 next() 抛(generator
        // 体抛)—— 都在产出任何 chunk 之前,可安全换下一候选。
        iterator = this.candidates[i]!.provider.stream(req, signal)[Symbol.asyncIterator]()
        first = await iterator.next()
      } catch (err) {
        if (signal?.aborted) throw err // 主动取消,绝不 failover
        lastErr = err
        lastKind = classifyLlmError(err)
        this.recordFailure(i, this.clock())
        this.emit({ type: 'candidate_error', candidate: label, index: i, errorKind: lastKind })
        this.logger?.warn(
          { candidate: label, index: i, kind: lastKind },
          'routing: candidate failed before first chunk — failing over',
        )
        continue
      }
      // 拿到第一个 chunk = 已起流,锁定此候选;后续任何错误原样透传,不重试。
      this.recordSuccess(i)
      this.emit({ type: 'served', candidate: label, index: i })
      if (!first.done) {
        yield first.value
        // yield* 委托剩余 chunk,并把消费端的 return()/throw()(如中途 abort)正确
        // 转发给底层迭代器做清理。
        const rest: AsyncIterable<LlmStreamChunk> = { [Symbol.asyncIterator]: () => iterator }
        yield* rest
      }
      return
    }
    // 没有候选能起流。
    this.emit({ type: 'exhausted', errorKind: lastKind })
    if (lastErr !== undefined) throw lastErr // 抛原始错误,让下游 classifyLlmError 照常分类播报
    // 一个都没试(全部熔断跳过)—— 快速失败,不硬敲已知挂掉的 provider。
    throw new RoutingExhaustedError(
      'all routing candidates are circuit-open',
      this.candidates.map((_, i) => this.labelOf(i)),
    )
  }
}
