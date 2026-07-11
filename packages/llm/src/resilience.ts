/**
 * NA-M2 — 调用韧性两纯核:看门狗(挂死检测)+ 瞬态单次重试。
 *
 * 为什么需要(体检证据见 docs/zh/NA-NATIVE-ADAPTATION.md):两个 SDK provider 都
 * 支持 AbortSignal,但装配层从没传过 —— 一条挂死或涓滴的流会把成员的轮无限期卡住;
 * RoutingProvider 只救「首 chunk 前抛错」,救不了「不抛错光挂着」。没配 fallbacks 的
 * 单 provider 用户撞一次 429/5xx 抖动,消息直接失败。
 *
 * 与 RoutingProvider 的分工(装配层负责,见 local-agent-pool.buildRoutedProvider):
 *   - 看门狗包**每个叶子** provider —— 含路由的每个候选:挂死被折算成该候选的
 *     timeout 失败,failover 因此能接手。
 *   - 瞬态重试只包**无 fallbacks 的单 provider 形态** —— 有候选链时,候选间
 *     failover 就是重试故事,不叠两层(双倍延迟)。
 *
 * 两条纪律(与 RoutingProvider 同源,非可调项):
 *   1. 全确定性:判类靠 {@link classifyLlmError},阈值/次数全常量,零模型调用。
 *   2. 首 chunk 锁定:吐过 chunk 一律不重试(token 收不回);看门狗在首 chunk 后
 *      只负责「间隙挂死」检测,超时如实抛错,绝不静默换路。
 *
 * 看门狗的双保险:超时同时 ①对内层 provider abort(守约的 SDK 会掐掉 HTTP 调用)
 * ②Promise.race 弹出等待(不守约、无视 signal 的 provider 也困不住我们)。
 */

import { classifyLlmError, type LlmErrorKind } from './errors.js'
import type { LlmProvider, LlmRequest, LlmStreamChunk } from './types.js'

/** 看门狗参数。全常量,不是 env 旋钮;抓「挂死」不是延迟 SLO,故意宽。 */
export interface WatchdogConfig {
  /** 首个 chunk 必须在此毫秒数内到达(thinking 流的思考增量也算 chunk)。 */
  firstChunkMs: number
  /** 起流后相邻两个 chunk 的最大静默间隙(ms)。 */
  gapMs: number
}

export const DEFAULT_WATCHDOG: WatchdogConfig = {
  firstChunkMs: 120_000,
  gapMs: 120_000,
}

/**
 * 看门狗超时错误。`name` 里带 "Timeout" —— {@link classifyLlmError} 的
 * `/timeout/i.test(name)` 判据据此把它归入 'timeout':CARE 播报文案、MR 熔断
 * 记账、重试判类全都无需认识这个类。
 */
export class LlmCallTimeoutError extends Error {
  readonly phase: 'first_chunk' | 'gap'
  readonly timeoutMs: number
  constructor(phase: 'first_chunk' | 'gap', timeoutMs: number) {
    super(
      phase === 'first_chunk'
        ? `llm call timed out: no first chunk within ${timeoutMs}ms`
        : `llm call timed out: stream silent for ${timeoutMs}ms mid-response`,
    )
    this.name = 'LlmCallTimeoutError'
    this.phase = phase
    this.timeoutMs = timeoutMs
  }
}

export interface WatchdogOptions {
  /** 部分覆盖(其余取 {@link DEFAULT_WATCHDOG});测试用小值,生产走默认。 */
  config?: Partial<WatchdogConfig>
}

/**
 * 包一层挂死看门狗。正常流零干预逐 chunk 透传;超时 → abort 内层 + 抛
 * {@link LlmCallTimeoutError}。调用方自己的 signal 照常生效(主动取消抛
 * 调用方的 reason,不会被误报成超时)。
 */
export function withCallWatchdog(inner: LlmProvider, opts: WatchdogOptions = {}): LlmProvider {
  const cfg: WatchdogConfig = { ...DEFAULT_WATCHDOG, ...opts.config }
  return {
    name: inner.name,
    async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamChunk> {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      const ac = new AbortController()
      const onOuterAbort = () => ac.abort(signal?.reason ?? new Error('aborted'))
      signal?.addEventListener('abort', onOuterAbort, { once: true })
      let timedOut: LlmCallTimeoutError | null = null
      /**
       * 把一次 `iterator.next()` 和一只表赛跑。表响时:记下超时错误、abort 内层
       * (双保险之一),race 立刻弹出(双保险之二 —— 无视 signal 的 provider 也
       * 困不住)。race 对两个 promise 都挂了 handler,晚到的 next() 拒绝不会成为
       * unhandled rejection。
       */
      const nextWithDeadline = async (
        it: AsyncIterator<LlmStreamChunk>,
        ms: number,
        phase: 'first_chunk' | 'gap',
      ): Promise<IteratorResult<LlmStreamChunk>> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const guard = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const err = new LlmCallTimeoutError(phase, ms)
            timedOut = err
            ac.abort(err)
            reject(err)
          }, ms)
          // 悬着的看门狗绝不能拖住进程退出(Node Timeout 才有 unref;类型面宽容)。
          ;(timer as { unref?: () => void }).unref?.()
        })
        try {
          return await Promise.race([it.next(), guard])
        } finally {
          clearTimeout(timer)
        }
      }
      let iterator: AsyncIterator<LlmStreamChunk> | undefined
      try {
        iterator = inner.stream(req, ac.signal)[Symbol.asyncIterator]()
        let first = true
        while (true) {
          let res: IteratorResult<LlmStreamChunk>
          try {
            res = await nextWithDeadline(iterator, first ? cfg.firstChunkMs : cfg.gapMs, first ? 'first_chunk' : 'gap')
          } catch (err) {
            // 内层因我们的 abort 抛出的任何“余波”错误都折叠回真正的病因 ——
            // 看门狗超时;调用方主动取消则原样透传调用方的 reason。
            if (timedOut !== null) throw timedOut
            throw err
          }
          if (timedOut !== null) throw timedOut // 内层吞了 abort 还照常返回 → 不装没事
          if (res.done) return
          first = false
          yield res.value
        }
      } finally {
        signal?.removeEventListener('abort', onOuterAbort)
        if (timedOut !== null && iterator !== undefined) {
          // best-effort 让内层 generator 走自己的清理;它已被 abort,失败无所谓。
          try {
            void iterator.return?.()
          } catch {
            /* 内层已死 */
          }
        }
      }
    },
  }
}

/** 值得原地再试一次的错误类别:网络抖动 / 超时 / 限流。quota(要充值)、
 * auth(要换 key)、model_not_found(要改配置)、unknown(不装懂)都不算。 */
export const TRANSIENT_KINDS: ReadonlySet<LlmErrorKind> = new Set([
  'network',
  'timeout',
  'rate_limited',
])

/** 重试参数。全常量,不是 env 旋钮。 */
export const DEFAULT_RETRY = {
  /** 首 chunk 前的瞬态失败最多原地再试几次。 */
  retries: 1,
  /** 两次尝试之间的固定退避(ms)。 */
  backoffMs: 2_000,
} as const

export interface TransientRetryOptions {
  retries?: number
  backoffMs?: number
  /** 注入睡眠(测试免等真 2s);缺省真 setTimeout。 */
  sleep?: (ms: number) => Promise<void>
  /** 重试事件回调(best-effort,抛错被吞)。 */
  onRetry?: (info: { attempt: number; errorKind: LlmErrorKind }) => void
}

/**
 * 包一层瞬态单次重试:**只在首 chunk 之前**、只对 {@link TRANSIENT_KINDS}、
 * 同一个 provider 原地重来(候选间的换路是 RoutingProvider 的事)。吐过
 * chunk 的失败原样透传 —— 与 MR「首-chunk-前 failover」同一条纪律。
 */
export function withTransientRetry(
  inner: LlmProvider,
  opts: TransientRetryOptions = {},
): LlmProvider {
  const retries = opts.retries ?? DEFAULT_RETRY.retries
  const backoffMs = opts.backoffMs ?? DEFAULT_RETRY.backoffMs
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  return {
    name: inner.name,
    async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamChunk> {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      for (let attempt = 0; ; attempt++) {
        let iterator: AsyncIterator<LlmStreamChunk>
        let first: IteratorResult<LlmStreamChunk>
        try {
          // 两种硬失败都在此逮住:stream() 同步抛、首次 next() 抛 —— 都在产出
          // 任何 chunk 之前,重试安全(语义同 RoutingProvider 的 failover 窗口)。
          iterator = inner.stream(req, signal)[Symbol.asyncIterator]()
          first = await iterator.next()
        } catch (err) {
          if (signal?.aborted) throw err // 主动取消,绝不重试
          const kind = classifyLlmError(err)
          if (attempt >= retries || !TRANSIENT_KINDS.has(kind)) throw err
          try {
            opts.onRetry?.({ attempt: attempt + 1, errorKind: kind })
          } catch {
            /* best-effort */
          }
          await sleep(backoffMs)
          continue
        }
        // 起流即锁定:后续错误(包括 'error' chunk / 中途抛)原样透传。
        if (!first.done) {
          yield first.value
          const rest: AsyncIterable<LlmStreamChunk> = { [Symbol.asyncIterator]: () => iterator }
          yield* rest
        }
        return
      }
    },
  }
}
