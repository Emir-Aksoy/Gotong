/**
 * MR-M1 — RoutingProvider 单测。
 *
 * 钉住的不变量:
 *  (1) 首 chunk 前的两种硬失败(stream() 同步抛 / 首次 next() 抛)都触发 failover;
 *  (2) 拿到第一个 chunk 即锁定候选 —— 之后的 'error' chunk / 中途抛原样透传,绝不重试;
 *  (3) 全失败时抛「最后一个原始错误」(保身份),供下游 classifyLlmError 照常分类;
 *  (4) per-candidate 熔断三态:阈值内开断 → 冷却期内快速跳过 → half-open 探针成功即关 /
 *      失败立即重开;全熔断 → RoutingExhaustedError 快速失败;
 *  (5) 主动取消(pre-abort)不碰任何候选;
 *  (6) 路由决策全确定性,监听器抛错不打断流。
 */

import { describe, expect, it } from 'vitest'

import {
  RoutingExhaustedError,
  RoutingProvider,
  type RoutingEvent,
} from '../src/routing-provider.js'
import type {
  LlmProvider,
  LlmRequest,
  LlmStreamChunk,
  LlmStreamTextChunk,
} from '../src/types.js'

/** 一次 stream() 调用的结局。 */
type Outcome =
  | { kind: 'throwSync'; err?: unknown } // 从 stream() 同步抛(参数校验式,如 MockLlmProvider)
  | { kind: 'throwAsync'; err?: unknown } // 从首次 next() 抛(async generator 体抛)
  | { kind: 'chunks'; chunks: LlmStreamChunk[] } // 正常起流并吐 chunk
  | { kind: 'throwMid'; before: LlmStreamChunk[]; err?: unknown } // 吐几个后中途抛

/** 记录每次 stream() 调用的桩 provider;`outcomes` 按调用次序取,耗尽后重复末项。 */
function stub(name: string, outcomes: Outcome[], log?: string[]): LlmProvider {
  let call = 0
  return {
    name,
    stream(_req: LlmRequest, _signal?: AbortSignal): AsyncIterable<LlmStreamChunk> {
      log?.push(name)
      const outcome = outcomes[Math.min(call, outcomes.length - 1)]!
      call++
      if (outcome.kind === 'throwSync') throw outcome.err ?? new Error(`${name}-sync`)
      return (async function* () {
        if (outcome.kind === 'throwAsync') throw outcome.err ?? new Error(`${name}-async`)
        if (outcome.kind === 'chunks') {
          for (const c of outcome.chunks) yield c
          return
        }
        for (const c of outcome.before) yield c
        throw outcome.err ?? new Error(`${name}-mid`)
      })()
    },
  }
}

const okChunks = (text: string): LlmStreamChunk[] => [
  { type: 'text', text },
  { type: 'end', stopReason: 'end_turn' },
]

async function collect(stream: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = []
  for await (const c of stream) out.push(c)
  return out
}

const textOf = (chunks: LlmStreamChunk[]): string =>
  chunks
    .filter((c) => c.type === 'text')
    .map((c) => (c as LlmStreamTextChunk).text)
    .join('')

const REQ: LlmRequest = { messages: [] }

describe('RoutingProvider — 基本透传 + 构造', () => {
  it('单候选:chunk 原样透传,name 从标签合成', async () => {
    const rp = new RoutingProvider({
      candidates: [{ provider: stub('solo', [{ kind: 'chunks', chunks: okChunks('hello') }]) }],
    })
    expect(rp.name).toBe('routing(solo)')
    expect(await collect(rp.stream(REQ))).toEqual(okChunks('hello'))
  })

  it('name 用显式 label 覆盖 provider.name', () => {
    const rp = new RoutingProvider({
      candidates: [
        { provider: stub('anthropic', [{ kind: 'chunks', chunks: [] }]), label: 'claude' },
        { provider: stub('deepseek', [{ kind: 'chunks', chunks: [] }]) },
      ],
    })
    expect(rp.name).toBe('routing(claude→deepseek)')
  })

  it('空候选 → 构造即抛', () => {
    expect(() => new RoutingProvider({ candidates: [] })).toThrow(/at least one/i)
  })

  it('每个候选用自己的 model 覆盖 req.model(含降级后)', async () => {
    const seen: Array<string | undefined> = []
    const rec = (name: string, o: Outcome): LlmProvider => ({
      name,
      stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
        seen.push(req.model)
        if (o.kind === 'throwSync') throw new Error(`${name}-x`)
        return (async function* () {
          if (o.kind === 'chunks') for (const c of o.chunks) yield c
        })()
      },
    })
    const rp = new RoutingProvider({
      candidates: [
        { provider: rec('A', { kind: 'throwSync' }), model: 'model-A' },
        { provider: rec('B', { kind: 'chunks', chunks: okChunks('ok') }), model: 'model-B' },
      ],
    })
    await collect(rp.stream({ messages: [], model: 'orig' }))
    expect(seen).toEqual(['model-A', 'model-B']) // 各自覆盖,不透传 'orig'
  })
})

describe('RoutingProvider — failover(首 chunk 前)', () => {
  it('主候选同步抛 → 降级到下一候选,事件序列 candidate_error→served', async () => {
    const log: string[] = []
    const events: RoutingEvent[] = []
    const rp = new RoutingProvider({
      candidates: [
        { provider: stub('A', [{ kind: 'throwSync' }], log) },
        { provider: stub('B', [{ kind: 'chunks', chunks: okChunks('from-B') }], log) },
      ],
      onEvent: (e) => events.push(e),
    })
    expect(textOf(await collect(rp.stream(REQ)))).toBe('from-B')
    expect(log).toEqual(['A', 'B'])
    expect(events.map((e) => e.type)).toEqual(['candidate_error', 'served'])
  })

  it('主候选 async generator 首 next() 抛 → 同样降级', async () => {
    const log: string[] = []
    const rp = new RoutingProvider({
      candidates: [
        { provider: stub('A', [{ kind: 'throwAsync' }], log) },
        { provider: stub('B', [{ kind: 'chunks', chunks: okChunks('B') }], log) },
      ],
    })
    expect(textOf(await collect(rp.stream(REQ)))).toBe('B')
    expect(log).toEqual(['A', 'B'])
  })

  it('candidate_error 事件带上分类后的 errorKind(429 → rate_limited)', async () => {
    const events: RoutingEvent[] = []
    const rate = Object.assign(new Error('slow down'), { status: 429 })
    const rp = new RoutingProvider({
      candidates: [
        { provider: stub('A', [{ kind: 'throwSync', err: rate }]) },
        { provider: stub('B', [{ kind: 'chunks', chunks: okChunks('ok') }]) },
      ],
      onEvent: (e) => events.push(e),
    })
    await collect(rp.stream(REQ))
    expect(events.find((e) => e.type === 'candidate_error')).toMatchObject({
      candidate: 'A',
      errorKind: 'rate_limited',
    })
  })

  it('全候选失败 → 抛最后一个原始错误(保身份)+ emit exhausted', async () => {
    const events: RoutingEvent[] = []
    const errA = new Error('A down')
    const errB = Object.assign(new Error('B down'), { status: 503 })
    const rp = new RoutingProvider({
      candidates: [
        { provider: stub('A', [{ kind: 'throwSync', err: errA }]) },
        { provider: stub('B', [{ kind: 'throwAsync', err: errB }]) },
      ],
      onEvent: (e) => events.push(e),
    })
    await expect(collect(rp.stream(REQ))).rejects.toBe(errB) // 最后一个,原始身份
    expect(events.find((e) => e.type === 'exhausted')).toMatchObject({ errorKind: 'network' })
  })
})

describe('RoutingProvider — 锁定候选后不重试', () => {
  it('中途 error chunk → 不 failover,已锁定候选的流原样透传', async () => {
    const log: string[] = []
    const rp = new RoutingProvider({
      candidates: [
        {
          provider: stub(
            'A',
            [
              {
                kind: 'chunks',
                chunks: [
                  { type: 'text', text: 'partial' },
                  { type: 'error', code: 'content_filter', message: 'filtered' },
                ],
              },
            ],
            log,
          ),
        },
        { provider: stub('B', [{ kind: 'chunks', chunks: okChunks('B') }], log) },
      ],
    })
    const out = await collect(rp.stream(REQ))
    expect(log).toEqual(['A']) // B 从未被试
    expect(out.map((c) => c.type)).toEqual(['text', 'error']) // A 的流逐 chunk 透传
  })

  it('中途抛 → 原样传播,不重试', async () => {
    const log: string[] = []
    const boom = new Error('mid boom')
    const rp = new RoutingProvider({
      candidates: [
        { provider: stub('A', [{ kind: 'throwMid', before: [{ type: 'text', text: 'half' }], err: boom }], log) },
        { provider: stub('B', [{ kind: 'chunks', chunks: okChunks('B') }], log) },
      ],
    })
    const got: LlmStreamChunk[] = []
    await expect(
      (async () => {
        for await (const c of rp.stream(REQ)) got.push(c)
      })(),
    ).rejects.toBe(boom)
    expect(got.map((c) => c.type)).toEqual(['text']) // 拿到 half 后即抛
    expect(log).toEqual(['A']) // B 未被试
  })
})

describe('RoutingProvider — 熔断三态', () => {
  it('达阈值开断 → 冷却期内直接跳过死候选(stream 都不调)', async () => {
    let clock = 0
    const log: string[] = []
    const events: RoutingEvent[] = []
    const rp = new RoutingProvider({
      candidates: [
        { provider: stub('A', [{ kind: 'throwSync' }], log) },
        { provider: stub('B', [{ kind: 'chunks', chunks: okChunks('hi') }], log) },
      ],
      breaker: { failureThreshold: 2, windowMs: 10_000, cooldownMs: 5_000 },
      now: () => clock,
      onEvent: (e) => events.push(e),
    })
    await collect(rp.stream(REQ)) // A 失败1,B 服务
    await collect(rp.stream(REQ)) // A 失败2 → 开断,B 服务
    expect(events.some((e) => e.type === 'breaker_open' && e.candidate === 'A')).toBe(true)
    log.length = 0
    const out = await collect(rp.stream(REQ)) // 冷却期内:A 被跳过
    expect(log).toEqual(['B']) // A 的 stream() 根本没被调
    expect(textOf(out)).toBe('hi')
  })

  it('冷却后 half-open 探针成功 → 关断,之后优先走回主候选', async () => {
    let clock = 0
    const log: string[] = []
    const events: RoutingEvent[] = []
    const rp = new RoutingProvider({
      candidates: [
        { provider: stub('A', [{ kind: 'throwSync' }, { kind: 'throwSync' }, { kind: 'chunks', chunks: okChunks('A-ok') }], log) },
        { provider: stub('B', [{ kind: 'chunks', chunks: okChunks('B') }], log) },
      ],
      breaker: { failureThreshold: 2, windowMs: 10_000, cooldownMs: 5_000 },
      now: () => clock,
      onEvent: (e) => events.push(e),
    })
    await collect(rp.stream(REQ)) // A 失败1,B
    await collect(rp.stream(REQ)) // A 失败2 → 开断@5000,B
    clock = 6_000 // 过冷却
    log.length = 0
    const out = await collect(rp.stream(REQ)) // A half-open 探针 → 第3结局=成功 → 服务并关断
    expect(log).toEqual(['A']) // 探针走 A,不需要 B
    expect(textOf(out)).toBe('A-ok')
    expect(events.some((e) => e.type === 'breaker_close' && e.candidate === 'A')).toBe(true)
  })

  it('half-open 探针再失败 → 立即重开', async () => {
    let clock = 0
    const log: string[] = []
    const events: RoutingEvent[] = []
    const rp = new RoutingProvider({
      candidates: [
        { provider: stub('A', [{ kind: 'throwSync' }], log) }, // 永远抛
        { provider: stub('B', [{ kind: 'chunks', chunks: okChunks('B') }], log) },
      ],
      breaker: { failureThreshold: 2, windowMs: 10_000, cooldownMs: 5_000 },
      now: () => clock,
      onEvent: (e) => events.push(e),
    })
    await collect(rp.stream(REQ)) // A 失败1
    await collect(rp.stream(REQ)) // A 失败2 → 开断@5000
    const opens1 = events.filter((e) => e.type === 'breaker_open').length
    clock = 6_000 // half-open
    await collect(rp.stream(REQ)) // A 探针失败 → 重开@11000
    expect(events.filter((e) => e.type === 'breaker_open').length).toBe(opens1 + 1)
    log.length = 0
    const out = await collect(rp.stream(REQ)) // clock 仍 6000 < 11000 → A 又被跳过
    expect(log).toEqual(['B'])
    expect(textOf(out)).toBe('B')
  })

  it('全部熔断 → 快速失败抛 RoutingExhaustedError,不硬敲', async () => {
    let clock = 0
    const log: string[] = []
    const rp = new RoutingProvider({
      candidates: [
        { provider: stub('A', [{ kind: 'throwSync' }], log) },
        { provider: stub('B', [{ kind: 'throwSync' }], log) },
      ],
      breaker: { failureThreshold: 1, windowMs: 10_000, cooldownMs: 5_000 },
      now: () => clock,
    })
    await expect(collect(rp.stream(REQ))).rejects.toBeInstanceOf(Error) // 两个都抛 → 抛最后一个
    expect(log).toEqual(['A', 'B']) // 首轮都试过了
    log.length = 0
    await expect(collect(rp.stream(REQ))).rejects.toBeInstanceOf(RoutingExhaustedError)
    expect(log).toEqual([]) // 全熔断:一个都不调
  })
})

describe('RoutingProvider — 取消 + 稳健性', () => {
  it('pre-aborted signal → 抛出且不碰任何候选', async () => {
    const log: string[] = []
    const rp = new RoutingProvider({
      candidates: [{ provider: stub('A', [{ kind: 'chunks', chunks: okChunks('x') }], log) }],
    })
    const ac = new AbortController()
    ac.abort(new Error('cancelled'))
    await expect(collect(rp.stream(REQ, ac.signal))).rejects.toBeInstanceOf(Error)
    expect(log).toEqual([]) // 没起流
  })

  it('onEvent 监听器抛错也绝不打断流', async () => {
    const rp = new RoutingProvider({
      candidates: [
        { provider: stub('A', [{ kind: 'throwSync' }]) },
        { provider: stub('B', [{ kind: 'chunks', chunks: okChunks('B-ok') }]) },
      ],
      onEvent() {
        throw new Error('listener boom')
      },
    })
    expect(textOf(await collect(rp.stream(REQ)))).toBe('B-ok')
  })
})
