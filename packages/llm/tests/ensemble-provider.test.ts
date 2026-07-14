/**
 * LSA-M4 — EnsembleProvider 单测。
 *
 * 钉死两件事:
 *  1. **并行 fan-out**(与 RoutingProvider 顺序降级的本质区别):ensemble 调用**全部**
 *     成员,routing 只调到第一个成功的。计数 provider 证明这点。
 *  2. **真综合而非透传单份**:synthesize 策略下,综合器**收到全部 N 份草稿**并产出综合结果;
 *     concat 策略下 N 份都在输出里。
 * 外加:usage 聚合(成本 ×N)、部分失败存活、全失败抛错、tool_use 不可综合→透传、abort。
 */

import { describe, expect, it } from 'vitest'

import {
  EnsembleExhaustedError,
  EnsembleProvider,
  MockLlmProvider,
  drainStream,
  sumUsage,
  type LlmProvider,
  type LlmRequest,
  type LlmStreamChunk,
  type LlmToolUseBlock,
} from '../src/index.js'

/** 固定文本 provider。 */
function textProvider(name: string, text: string): LlmProvider {
  return {
    name,
    async *stream(): AsyncIterable<LlmStreamChunk> {
      yield { type: 'text', text }
      yield { type: 'end', stopReason: 'end_turn' }
    },
  }
}

/** 计数 provider:每次 stream() 被消费就 +1(证明 fan-out 真的调了它)。 */
function countingProvider(name: string, text: string, counter: { n: number }): LlmProvider {
  return {
    name,
    async *stream(): AsyncIterable<LlmStreamChunk> {
      counter.n++
      yield { type: 'text', text }
      yield { type: 'end', stopReason: 'end_turn' }
    },
  }
}

/** 记录 provider:留下它收到的 request(用于证综合器看到了全部草稿)。 */
function recordingProvider(name: string, text: string): { provider: LlmProvider; reqs: LlmRequest[] } {
  const reqs: LlmRequest[] = []
  const provider: LlmProvider = {
    name,
    async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
      reqs.push(req)
      yield { type: 'text', text }
      yield { type: 'end', stopReason: 'end_turn' }
    },
  }
  return { provider, reqs }
}

const ask = (q: string): LlmRequest => ({ messages: [{ role: 'user', content: q }] })

describe('EnsembleProvider (LSA-M4)', () => {
  it('concat: fans out to every member and labels all drafts in the output', async () => {
    const ens = new EnsembleProvider({
      members: [
        { provider: textProvider('a', '答案甲'), label: '甲' },
        { provider: textProvider('b', '答案乙'), label: '乙' },
        { provider: textProvider('c', '答案丙'), label: '丙' },
      ],
      strategy: { kind: 'concat' },
    })
    const res = await drainStream(ens.stream(ask('问点啥')))
    // 三份都在,各带标签 —— 不是只留一份。
    expect(res.text).toContain('【甲】')
    expect(res.text).toContain('答案甲')
    expect(res.text).toContain('答案乙')
    expect(res.text).toContain('答案丙')
    expect(res.stopReason).toBe('end_turn')
  })

  it('PARALLEL fan-out: calls ALL members (unlike routing, which stops at the first)', async () => {
    const counter = { n: 0 }
    const ens = new EnsembleProvider({
      members: [
        { provider: countingProvider('a', 'x', counter) },
        { provider: countingProvider('b', 'y', counter) },
        { provider: countingProvider('c', 'z', counter) },
      ],
      strategy: { kind: 'concat' },
    })
    await drainStream(ens.stream(ask('q')))
    // The nailing assertion: ensemble ran all 3 (routing would have run 1).
    expect(counter.n).toBe(3)
  })

  it('synthesize: the synthesizer receives ALL drafts and its output is returned', async () => {
    const synth = recordingProvider('synth', '综合后的最终答案')
    const ens = new EnsembleProvider({
      members: [
        { provider: textProvider('a', '草稿一内容'), label: '甲' },
        { provider: textProvider('b', '草稿二内容'), label: '乙' },
      ],
      strategy: { kind: 'synthesize', synthesizer: synth.provider },
    })
    const res = await drainStream(ens.stream(ask('原始问题')))
    // Output is the synthesizer's text (真综合,不是拼接).
    expect(res.text).toBe('综合后的最终答案')
    // The synthesizer saw the question + BOTH drafts (proves it combined, not passed one through).
    expect(synth.reqs).toHaveLength(1)
    const seen = synth.reqs[0]!.messages[0]!.content as string
    expect(seen).toContain('原始问题')
    expect(seen).toContain('草稿一内容')
    expect(seen).toContain('草稿二内容')
  })

  it('aggregates usage across all members (honest cost ×N)', async () => {
    // Mock reply 'aaaa' (4 chars) → outputTokens = ceil(4/4) = 1 per member.
    const ens = new EnsembleProvider({
      members: [
        { provider: new MockLlmProvider({ reply: 'aaaa', name: 'a' }) },
        { provider: new MockLlmProvider({ reply: 'aaaa', name: 'b' }) },
        { provider: new MockLlmProvider({ reply: 'aaaa', name: 'c' }) },
      ],
      strategy: { kind: 'concat' },
    })
    const res = await drainStream(ens.stream(ask('q')))
    expect(res.usage).toBeDefined()
    // 3 members × 1 output token each = 3 (summed, not one).
    expect(res.usage!.outputTokens).toBe(3)
    expect(res.usage!.inputTokens).toBeGreaterThan(0)
  })

  it('drops a failing member and proceeds with the survivors', async () => {
    const ens = new EnsembleProvider({
      members: [
        { provider: textProvider('a', '存活甲'), label: '甲' },
        { provider: new MockLlmProvider({ reply: '', throwError: 'boom', name: 'b' }), label: '乙' },
        { provider: textProvider('c', '存活丙'), label: '丙' },
      ],
      strategy: { kind: 'concat' },
    })
    const res = await drainStream(ens.stream(ask('q')))
    expect(res.text).toContain('存活甲')
    expect(res.text).toContain('存活丙')
    // The failed member contributes nothing — no crash, no error stopReason.
    expect(res.text).not.toContain('乙')
    expect(res.stopReason).toBe('end_turn')
  })

  it('throws EnsembleExhaustedError when every member fails', async () => {
    const ens = new EnsembleProvider({
      members: [
        { provider: new MockLlmProvider({ reply: '', throwError: 'boom1', name: 'a' }) },
        { provider: new MockLlmProvider({ reply: '', throwError: 'boom2', name: 'b' }) },
      ],
      strategy: { kind: 'concat' },
    })
    await expect(drainStream(ens.stream(ask('q')))).rejects.toBeInstanceOf(EnsembleExhaustedError)
  })

  it('tool_use is NOT synthesizable: the lead member is passed through verbatim', async () => {
    const toolUse: LlmToolUseBlock = { type: 'tool_use', id: 't1', name: 'do_thing', input: { x: 1 } }
    const synth = recordingProvider('synth', 'SHOULD-NOT-RUN')
    const ens = new EnsembleProvider({
      members: [
        // Lead wants a tool → whole turn defers to it (can't merge tool calls).
        { provider: new MockLlmProvider({ reply: '', script: [{ kind: 'tool_use', toolUses: [toolUse] }], name: 'a' }), label: '甲' },
        { provider: textProvider('b', '一份文本草稿'), label: '乙' },
      ],
      strategy: { kind: 'synthesize', synthesizer: synth.provider },
    })
    const res = await drainStream(ens.stream(ask('q')))
    // The tool call survives verbatim…
    expect(res.stopReason).toBe('tool_use')
    expect(res.toolUses).toHaveLength(1)
    expect(res.toolUses![0]!.name).toBe('do_thing')
    // …and the synthesizer was never invoked (a tool-picking turn isn't combined).
    expect(synth.reqs).toHaveLength(0)
  })

  it('falls back to concat when the synthesizer returns nothing (fail-soft)', async () => {
    const emptySynth = new MockLlmProvider({ reply: '', name: 'synth' })
    const ens = new EnsembleProvider({
      members: [
        { provider: textProvider('a', '草稿甲'), label: '甲' },
        { provider: textProvider('b', '草稿乙'), label: '乙' },
      ],
      strategy: { kind: 'synthesize', synthesizer: emptySynth },
    })
    const res = await drainStream(ens.stream(ask('q')))
    // Empty synthesis → deterministic concat of the drafts, never an empty answer.
    expect(res.text).toContain('草稿甲')
    expect(res.text).toContain('草稿乙')
  })

  it('throws on a pre-aborted signal', async () => {
    const ens = new EnsembleProvider({
      members: [{ provider: textProvider('a', 'x') }],
      strategy: { kind: 'concat' },
    })
    const ac = new AbortController()
    ac.abort()
    await expect(drainStream(ens.stream(ask('q'), ac.signal))).rejects.toBeTruthy()
  })

  it('requires at least one member', () => {
    expect(() => new EnsembleProvider({ members: [], strategy: { kind: 'concat' } })).toThrow()
  })
})

describe('sumUsage', () => {
  it('returns undefined when every part is undefined', () => {
    expect(sumUsage([undefined, undefined])).toBeUndefined()
  })

  it('sums input/output and cache tokens across parts', () => {
    const out = sumUsage([
      { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
      { inputTokens: 20, outputTokens: 7, cacheCreationTokens: 3 },
      undefined,
    ])
    expect(out).toEqual({
      inputTokens: 30,
      outputTokens: 12,
      cacheCreationTokens: 3,
      cacheReadTokens: 2,
    })
  })

  it('omits cache fields when they sum to zero', () => {
    const out = sumUsage([{ inputTokens: 1, outputTokens: 1 }])
    expect(out).toEqual({ inputTokens: 1, outputTokens: 1 })
    expect(out).not.toHaveProperty('cacheReadTokens')
  })
})
