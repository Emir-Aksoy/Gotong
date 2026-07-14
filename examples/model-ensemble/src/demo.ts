/**
 * model-ensemble — 同时问多个模型,再综合成一份.
 *
 * LSA track(LLM 自省与多模型自治)的 capstone,给整条 track 封顶。用户诉求最后一句
 * 「可以同时使用多个 llm,再根据结果综合一下使用」就是这一件。前面几环各就各位:
 *   M1 `list_my_llms` —— 阿同看得见自己有哪些模型候选链(自省)。
 *   M2 web search    —— 通用联网搜索连接器(工具面变宽)。
 *   M3 `discover_llm_providers` —— 阿同发现并建议免费 / 低价 provider,人注册录入 key。
 *   M4(这里)     —— 人把几家的 key 都配好之后,阿同能**同时**问它们,再综合成一份。
 *
 * 全程确定性、零网络、零 API key。底下是真的框架件:真 @gotong/llm `EnsembleProvider`
 * (RoutingProvider 的兄弟件)。唯一被 stub 的是几个成员 provider —— 薄到只吐 chunk /
 * 抛错,不可能和真 provider 跑偏。三家成员就借用 M3 目录里那三家免费的:
 * OpenRouter / Groq / Cerebras。
 *
 * ── routing vs ensemble(一句话讲清区别)──────────────────────────────────────
 *   RoutingProvider 是**顺序**的:首选挂了才换下一个,同一时刻只有一个模型在跑(省钱 / 容错)。
 *   EnsembleProvider 是**并行**的:同一个请求同时发给全部 N 个成员,收齐 N 份草稿再综合成
 *   一份(拿延迟 + N 倍成本换答案质量)。两者都实现 `LlmProvider`,对上游完全透明。
 *
 * 这个 demo 端到端证的事:
 *
 *   [1] 并行 fan-out + concat:同一问题同时发给 3 个模型,3 份草稿各带标签全在输出里
 *       —— 事件流证明**三个都真跑了**(routing 只会跑一个).
 *   [2] synthesize:综合器**收到全部 3 份草稿 + 原问题**,折成一份更好的最终答案
 *       —— 是真综合,不是挑一份透传.
 *   [3] usage 聚合:成本诚实记成 N 份之和(+ 综合器那一次)—— 多花的钱一分不藏.
 *   [4] 部分失败存活:一个成员抛错被丢弃,其余照常综合,整轮不崩.
 *   [5] tool_use 不可综合:领头成员若想调工具,整轮原样透传它 —— 两个工具调用没法「取平均」.
 *
 * 四条不可破边界(LSA track)在这里都看得见:
 *   ① 热路径零 LLM 决策:开不开 ensemble 是装配层 opt-in 配置(像 routing 的 fallbacks);
 *      fan-out 本身确定性(永远发全部 N 个),没有模型在现场决定发给谁.
 *   ② opt-in 字节不变:不配 ensemble = 根本不包这个 provider,与今天逐字节一致.
 *   ③ 数据离盒 opt-in:同一 prompt 发给 N 个厂商 = 更多出网,成员由装配者亲手编排.
 *   ④ 内核零改动:EnsembleProvider 在 @gotong/llm 平级包,core/workflow/protocol 未动.
 *
 * Run:  pnpm demo:model-ensemble
 */

import { EnsembleProvider, drainStream } from '@gotong/llm'
import type {
  EnsembleEvent,
  LlmProvider,
  LlmRequest,
  LlmStreamChunk,
  LlmToolUseBlock,
  LlmUsage,
} from '@gotong/llm'

// ── tiny stub providers ─────────────────────────────────────────────────────

/** 一份文本答案作为流(真 provider 就吐这个形状);可选带 usage。 */
function okStream(text: string, usage?: LlmUsage): AsyncIterable<LlmStreamChunk> {
  return (async function* () {
    yield { type: 'text', text } satisfies LlmStreamChunk
    if (usage) yield { type: 'usage', usage } satisfies LlmStreamChunk
    yield { type: 'end', stopReason: 'end_turn' } satisfies LlmStreamChunk
  })()
}

/** 固定文本成员。 */
function textProvider(name: string, text: string, usage?: LlmUsage): LlmProvider {
  return { name, stream: () => okStream(text, usage) }
}

/** 首-chunk-前就抛的网络失败(classifyLlmError 读成 'network')。 */
function failingProvider(name: string): LlmProvider {
  return {
    name,
    stream(): AsyncIterable<LlmStreamChunk> {
      throw Object.assign(new Error(`${name} unreachable`), { code: 'ECONNREFUSED' })
    },
  }
}

/** 想调工具的成员(领头它就整轮透传;工具调用不可综合)。 */
function toolProvider(name: string, toolUse: LlmToolUseBlock): LlmProvider {
  return {
    name,
    stream: () =>
      (async function* () {
        yield { type: 'tool_use', toolUse } satisfies LlmStreamChunk
        yield { type: 'end', stopReason: 'tool_use' } satisfies LlmStreamChunk
      })(),
  }
}

/** 记录 provider:留下它收到的 request(用于证综合器看到了全部草稿)。 */
function recordingProvider(name: string, text: string): { provider: LlmProvider; reqs: LlmRequest[] } {
  const reqs: LlmRequest[] = []
  const provider: LlmProvider = {
    name,
    stream(req: LlmRequest) {
      reqs.push(req)
      return okStream(text)
    },
  }
  return { provider, reqs }
}

// 一个问题,贯穿全程(阿同替主人问的)。
const QUESTION = '帮我把「gotong-royong」这个词的意思和用法讲清楚。'
const REQ: LlmRequest = { messages: [{ role: 'user', content: QUESTION }] }

/** 收集一次 ensemble 跑的事件(生产件真在用的 onEvent 面)。 */
function collectEvents(): { events: EnsembleEvent[]; onEvent: (ev: EnsembleEvent) => void } {
  const events: EnsembleEvent[] = []
  return { events, onEvent: (ev) => events.push(ev) }
}

async function main(): Promise<void> {
  console.log('\nLSA capstone — 同时问多个模型,再综合成一份')
  console.log('（真 EnsembleProvider;只有几个成员 provider 是桩，零网络零 key）')
  console.log('（三家成员就借 M3 目录里那三家免费的:OpenRouter / Groq / Cerebras）')

  // [1] ── 并行 fan-out + concat ──────────────────────────────────────────────
  section('[1] 并行 fan-out:同一问题同时发给 3 个模型,三份草稿都在(routing 只会跑一个)')
  {
    const { events, onEvent } = collectEvents()
    const ens = new EnsembleProvider({
      members: [
        { provider: textProvider('openrouter', '草稿·OpenRouter:互助共担的社区协作。'), label: 'OpenRouter' },
        { provider: textProvider('groq', '草稿·Groq:马来 / 印尼语,邻里合力做事。'), label: 'Groq' },
        { provider: textProvider('cerebras', '草稿·Cerebras:也写作 gotong royong。'), label: 'Cerebras' },
      ],
      strategy: { kind: 'concat' },
      onEvent,
    })
    const res = await drainStream(ens.stream(REQ))
    console.log(`  合并输出(concat):\n${indent(res.text)}`)
    assert(res.text.includes('【OpenRouter】') && res.text.includes('【Groq】') && res.text.includes('【Cerebras】'), '三份草稿都在,各带标签(不是只留一份)')
    // 钉死并行:三个成员各发一条 member_done —— routing 只会有一个成功候选。
    const dones = events.filter((e) => e.type === 'member_done').length
    assert(dones === 3, `事件流证明三个成员都真跑了:member_done ×${dones}(routing 只会 ×1)`)
    assert(events.some((e) => e.type === 'combined' && e.strategy === 'concat' && e.members === 3), '一条 combined(concat, 3 成员)事件')
  }

  // [2] ── synthesize:综合器收到全部草稿 ──────────────────────────────────────
  section('[2] synthesize:综合器拿到全部 3 份草稿 + 原问题,折成一份更好的最终答案')
  {
    const synth = recordingProvider('synth', '最终答案:gotong-royong 是马来 / 印尼语,指邻里互助、合力共担的社区协作精神。')
    const ens = new EnsembleProvider({
      members: [
        { provider: textProvider('openrouter', '互助共担的社区协作。'), label: 'OpenRouter' },
        { provider: textProvider('groq', '马来 / 印尼语,邻里合力做事。'), label: 'Groq' },
        { provider: textProvider('cerebras', '也写作 gotong royong。'), label: 'Cerebras' },
      ],
      strategy: { kind: 'synthesize', synthesizer: synth.provider },
    })
    const res = await drainStream(ens.stream(REQ))
    console.log(`  综合后:\n${indent(res.text)}`)
    assert(res.text.startsWith('最终答案:'), '输出是综合器产出的最终答案(真综合,不是拼接)')
    assert(synth.reqs.length === 1, '综合器被调了恰好一次')
    const seen = synth.reqs[0]!.messages[0]!.content as string
    assert(seen.includes(QUESTION), '综合器看到了原问题')
    assert(seen.includes('互助共担') && seen.includes('邻里合力') && seen.includes('gotong royong'), '综合器看到了全部三份草稿(证明它是综合而非透传一份)')
  }

  // [3] ── usage 聚合(成本 ×N,一分不藏)─────────────────────────────────────
  section('[3] usage 聚合:三家各花一点 + 综合器,诚实记成总和(多花的钱不藏)')
  {
    const u = (i: number, o: number): LlmUsage => ({ inputTokens: i, outputTokens: o })
    const ens = new EnsembleProvider({
      members: [
        { provider: textProvider('openrouter', '答一', u(100, 10)), label: 'OpenRouter' },
        { provider: textProvider('groq', '答二', u(100, 20)), label: 'Groq' },
        { provider: textProvider('cerebras', '答三', u(100, 30)), label: 'Cerebras' },
      ],
      strategy: { kind: 'concat' },
    })
    const res = await drainStream(ens.stream(REQ))
    console.log(`  聚合 usage:input=${res.usage?.inputTokens}, output=${res.usage?.outputTokens}`)
    assert(res.usage?.inputTokens === 300, '输入 token = 100×3 = 300(三家之和)')
    assert(res.usage?.outputTokens === 60, '输出 token = 10+20+30 = 60(三家之和,不是任一家单独的)')
  }

  // [4] ── 部分失败存活 ───────────────────────────────────────────────────────
  section('[4] 部分失败存活:一个成员抛错被丢弃,其余照常综合,整轮不崩')
  {
    const { events, onEvent } = collectEvents()
    const ens = new EnsembleProvider({
      members: [
        { provider: textProvider('openrouter', '存活草稿甲'), label: 'OpenRouter' },
        { provider: failingProvider('groq'), label: 'Groq' }, // 这家挂了
        { provider: textProvider('cerebras', '存活草稿丙'), label: 'Cerebras' },
      ],
      strategy: { kind: 'concat' },
      onEvent,
    })
    const res = await drainStream(ens.stream(REQ))
    console.log(`  合并输出(挂了一个):\n${indent(res.text)}`)
    assert(res.text.includes('存活草稿甲') && res.text.includes('存活草稿丙'), '两个存活成员的草稿都在')
    assert(!res.text.includes('【Groq】'), '挂掉的 Groq 什么都没贡献(没有它的标签块)')
    assert(res.stopReason === 'end_turn', '整轮正常收尾,没崩、没 error 状态')
    const failed = events.filter((e) => e.type === 'member_failed')
    assert(failed.length === 1 && failed[0]!.errorKind === 'network', '事件如实记了一条 member_failed(Groq, network)')
  }

  // [5] ── tool_use 不可综合 → 透传 ───────────────────────────────────────────
  section('[5] tool_use 不可综合:领头成员想调工具 → 整轮原样透传它(工具调用没法取平均)')
  {
    const { events, onEvent } = collectEvents()
    const toolUse: LlmToolUseBlock = { type: 'tool_use', id: 't1', name: 'web_search', input: { q: 'gotong royong' } }
    const synth = recordingProvider('synth', '不该跑到')
    const ens = new EnsembleProvider({
      members: [
        { provider: toolProvider('openrouter', toolUse), label: 'OpenRouter' }, // 领头想调工具
        { provider: textProvider('groq', '一份文本草稿'), label: 'Groq' },
      ],
      strategy: { kind: 'synthesize', synthesizer: synth.provider },
      onEvent,
    })
    const res = await drainStream(ens.stream(REQ))
    console.log(`  透传结果:stopReason=${res.stopReason}, 工具=${res.toolUses?.[0]?.name}`)
    assert(res.stopReason === 'tool_use' && res.toolUses?.length === 1, '领头的工具调用原样透传出来')
    assert(res.toolUses![0]!.name === 'web_search', '就是它要调的那个工具(web_search)')
    assert(synth.reqs.length === 0, '综合器一次都没被调(选工具的轮次不综合)')
    assert(events.some((e) => e.type === 'passthrough'), '一条 passthrough 事件如实记录了这次透传')
  }

  // ── 四条不可破边界 ─────────────────────────────────────────────────────────
  section('四条不可破边界')
  console.log('  ① 热路径零 LLM 决策:开不开 ensemble 是装配层 opt-in 配置;fan-out 确定性(永远发全部 N 个).')
  console.log('  ② opt-in 字节不变:不配 ensemble = 根本不包这个 provider,与今天逐字节一致.')
  console.log('  ③ 数据离盒 opt-in:同一 prompt 发给 N 个厂商 = 更多出网,成员由装配者亲手编排.')
  console.log('  ④ 内核零改动:EnsembleProvider 在 @gotong/llm 平级包,core/workflow/protocol 未动.')

  section('done')
  console.log('  同时问 3 个模型 → 三份草稿并回 → 综合成一份更好的 → 成本诚实 ×N → 挂一个照跑 → 要调工具就透传.\n')
  process.exit(0)
}

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`)
  console.log(`  ✓ ${label}`)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
