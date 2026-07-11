import { describe, expect, it, vi } from 'vitest'

import { classifyLlmError } from '../src/errors.js'
import {
  LlmCallTimeoutError,
  TRANSIENT_KINDS,
  withCallWatchdog,
  withTransientRetry,
} from '../src/resilience.js'
import { RoutingProvider } from '../src/routing-provider.js'
import type { LlmProvider, LlmStreamChunk } from '../src/types.js'

/** 收集整条流(测试端最常用姿势)。 */
async function collect(stream: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = []
  for await (const c of stream) out.push(c)
  return out
}

const text = (t: string): LlmStreamChunk => ({ type: 'text', text: t })
const END: LlmStreamChunk = { type: 'end', stopReason: 'end_turn' }

/** 永不产出、也永不理会 signal 的挂死 provider(最恶劣形态)。 */
function hangingProvider(onSignal?: (s: AbortSignal | undefined) => void): LlmProvider {
  return {
    name: 'hanging',
    async *stream(_req, signal) {
      onSignal?.(signal)
      await new Promise(() => {
        /* 永远悬着 */
      })
      yield END // 永不到达
    },
  }
}

/** 正常 provider:按序吐 chunks 后收尾。 */
function okProvider(chunks: LlmStreamChunk[], name = 'ok'): LlmProvider {
  return {
    name,
    async *stream() {
      for (const c of chunks) yield c
    },
  }
}

describe('withCallWatchdog(NA-M2)', () => {
  it('首 chunk 超时:抛 LlmCallTimeoutError(first_chunk) 且对内层 abort', async () => {
    let seen: AbortSignal | undefined
    const wrapped = withCallWatchdog(
      hangingProvider((s) => {
        seen = s
      }),
      { config: { firstChunkMs: 15 } },
    )
    await expect(collect(wrapped.stream({ messages: [] }))).rejects.toMatchObject({
      name: 'LlmCallTimeoutError',
      phase: 'first_chunk',
      timeoutMs: 15,
    })
    // 双保险之一:内层拿到的 signal 已被 abort(守约 SDK 会掐掉 HTTP)。
    expect(seen?.aborted).toBe(true)
  })

  it('间隙超时:首 chunk 正常送达后流静默 → 抛 phase=gap', async () => {
    const provider: LlmProvider = {
      name: 'trickle-then-hang',
      async *stream() {
        yield text('部分')
        await new Promise(() => {
          /* mid-stream 挂死 */
        })
      },
    }
    const wrapped = withCallWatchdog(provider, { config: { firstChunkMs: 1000, gapMs: 15 } })
    const it2 = wrapped.stream({ messages: [] })[Symbol.asyncIterator]()
    const first = await it2.next()
    expect(first.value).toEqual(text('部分'))
    await expect(it2.next()).rejects.toMatchObject({ name: 'LlmCallTimeoutError', phase: 'gap' })
  })

  it('正常流零干预:chunk 逐个透传,name 保留', async () => {
    const chunks = [text('a'), text('b'), END]
    const wrapped = withCallWatchdog(okProvider(chunks, 'anthropic'))
    expect(wrapped.name).toBe('anthropic')
    expect(await collect(wrapped.stream({ messages: [] }))).toEqual(chunks)
  })

  it('调用方主动取消:抛调用方的 reason,绝不误报成超时', async () => {
    const ac = new AbortController()
    const reason = new Error('user cancelled')
    const provider: LlmProvider = {
      name: 'abort-aware',
      async *stream(_req, signal) {
        // 守约 provider:signal abort 时以 reason 拒绝(SDK 语义)。
        await new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        yield END
      },
    }
    const wrapped = withCallWatchdog(provider, { config: { firstChunkMs: 5_000 } })
    const pending = collect(wrapped.stream({ messages: [] }, ac.signal))
    ac.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  it('无视 signal 的 provider 也困不住(Promise.race 双保险)', async () => {
    // hangingProvider 从不监听 signal —— 只有 race 能把我们弹出来。
    const wrapped = withCallWatchdog(hangingProvider(), { config: { firstChunkMs: 15 } })
    await expect(collect(wrapped.stream({ messages: [] }))).rejects.toBeInstanceOf(
      LlmCallTimeoutError,
    )
  })

  it('看门狗超时错误被 classifyLlmError 归入 timeout(播报/熔断/重试全免认识它)', () => {
    expect(classifyLlmError(new LlmCallTimeoutError('first_chunk', 120_000))).toBe('timeout')
    expect(classifyLlmError(new LlmCallTimeoutError('gap', 120_000))).toBe('timeout')
    expect(TRANSIENT_KINDS.has('timeout')).toBe(true)
  })
})

describe('withTransientRetry(NA-M2)', () => {
  const transientErr = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })

  it('瞬态失败原地重试一次后成功;退避走注入 sleep', async () => {
    let calls = 0
    const provider: LlmProvider = {
      name: 'flaky',
      async *stream() {
        calls++
        if (calls === 1) throw transientErr()
        yield text('好了')
        yield END
      },
    }
    const sleep = vi.fn(async () => {})
    const onRetry = vi.fn()
    const wrapped = withTransientRetry(provider, { sleep, onRetry })
    expect(await collect(wrapped.stream({ messages: [] }))).toEqual([text('好了'), END])
    expect(calls).toBe(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(2_000)
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, errorKind: 'network' })
  })

  it('非瞬态(auth)直接抛,零重试零退避', async () => {
    let calls = 0
    const provider: LlmProvider = {
      name: 'bad-key',
      async *stream() {
        calls++
        throw Object.assign(new Error('invalid api key'), { status: 401 })
        yield END // unreachable — 让 TS 认这是 generator
      },
    }
    const sleep = vi.fn(async () => {})
    const wrapped = withTransientRetry(provider, { sleep })
    await expect(collect(wrapped.stream({ messages: [] }))).rejects.toThrow('invalid api key')
    expect(calls).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('重试额度耗尽:第二次的原始错误原样抛出', async () => {
    let calls = 0
    const provider: LlmProvider = {
      name: 'down',
      async *stream() {
        calls++
        throw Object.assign(new Error(`attempt ${calls} failed`), { code: 'ECONNREFUSED' })
        yield END
      },
    }
    const wrapped = withTransientRetry(provider, { sleep: async () => {} })
    await expect(collect(wrapped.stream({ messages: [] }))).rejects.toThrow('attempt 2 failed')
    expect(calls).toBe(2)
  })

  it('吐过 chunk 的失败原样透传,绝不重试(token 收不回)', async () => {
    let calls = 0
    const provider: LlmProvider = {
      name: 'mid-stream-die',
      async *stream() {
        calls++
        yield text('前半句')
        throw transientErr()
      },
    }
    const wrapped = withTransientRetry(provider, { sleep: async () => {} })
    const out: LlmStreamChunk[] = []
    await expect(
      (async () => {
        for await (const c of wrapped.stream({ messages: [] })) out.push(c)
      })(),
    ).rejects.toThrow('socket hang up')
    expect(out).toEqual([text('前半句')])
    expect(calls).toBe(1)
  })

  it('调用方已取消:直接抛,不消耗重试', async () => {
    const ac = new AbortController()
    ac.abort(new Error('cancelled'))
    let calls = 0
    const provider: LlmProvider = {
      name: 'never-called',
      async *stream() {
        calls++
        yield END
      },
    }
    const wrapped = withTransientRetry(provider, { sleep: async () => {} })
    await expect(collect(wrapped.stream({ messages: [] }, ac.signal))).rejects.toThrow('cancelled')
    expect(calls).toBe(0)
  })
})

describe('组合形态(装配缝的两种栈)', () => {
  it('单 provider 栈 retry(watchdog(p)):挂死 → 超时判瞬态 → 原地重试 → 第二次成功', async () => {
    let calls = 0
    const provider: LlmProvider = {
      name: 'hang-once',
      async *stream() {
        calls++
        if (calls === 1) {
          await new Promise(() => {
            /* 第一次挂死 */
          })
        }
        yield text('第二次通了')
        yield END
      },
    }
    const wrapped = withTransientRetry(
      withCallWatchdog(provider, { config: { firstChunkMs: 15 } }),
      { sleep: async () => {} },
    )
    expect(await collect(wrapped.stream({ messages: [] }))).toEqual([text('第二次通了'), END])
    expect(calls).toBe(2)
  })

  it('路由栈 Routing(watchdog(候选)…):主候选挂死 → 折算 timeout → failover 到备用', async () => {
    const events: string[] = []
    const routed = new RoutingProvider({
      candidates: [
        { provider: withCallWatchdog(hangingProvider(), { config: { firstChunkMs: 15 } }), label: 'primary' },
        { provider: okProvider([text('备用顶上'), END], 'fallback'), label: 'fallback' },
      ],
      onEvent: (ev) => {
        if (ev.type === 'candidate_error') events.push(`${ev.candidate}:${ev.errorKind}`)
        if (ev.type === 'served') events.push(`served:${ev.candidate}`)
      },
    })
    expect(await collect(routed.stream({ messages: [] }))).toEqual([text('备用顶上'), END])
    // 挂死以 timeout 病名进入熔断记账 —— 这正是「看门狗包每个叶子」的意义。
    expect(events).toEqual(['primary:timeout', 'served:fallback'])
  })
})
