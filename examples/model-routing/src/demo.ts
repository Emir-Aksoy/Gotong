/**
 * model-routing — 主模型挂了,管家不断线.
 *
 * 模型路由 track(MR)的 capstone。北极星第 1 层「我的 AI 桌面」要能实际帮人做事,
 * 就不能厂商一抖对话就断。这条路(确定性多 provider 降级 + 熔断 + per-provider 健康)
 * 已整条落地:M1 RoutingProvider 纯核 → M2 opt-in fallbacks 配置 + 装配缝 → M3 健康
 * 投影上体检面板。每一环各有单测;缺的是把它们串成一个故事的图 —— 就是这个 demo。
 *
 * 全程确定性、零网络、零 API key。底下是真的框架件:
 *   - 真 @gotong/llm `RoutingProvider`:有序候选 + 首-chunk-前 failover + 三态熔断,
 *     注入时钟 + onEvent 都是生产件。
 *   - 真 @gotong/host `RoutingHealthTracker`:体检面板读的那份 per-provider 健康投影,
 *     喂给它的 onEvent 就是面板 `snap.routing` 的来源。
 * 唯一被 stub 的是两个 provider(一个会抖的主、一个稳的备)—— 连它们都只是吐 chunk /
 * 抛错的小桩,薄到不可能和真 provider 跑偏。
 *
 * 一条共享时钟同时驱动熔断计时和健康投影的时间窗,故每一步都可复现。
 *
 * 这个 demo 端到端证的事:
 *
 *   [1] failover 续跑:主 provider 在吐出第一个 token **之前**抛错(网络挂),
 *       RoutingProvider 顺次降级到备用 —— 答案照样到,调用方完全无感.
 *   [2] 连续失败 → 熔断:同一主 provider 三次失败(阈值)后 per-candidate 断路器
 *       打开,第 4 次调用**快速跳过**死掉的主(不再浪费一次尝试),直奔备用.
 *   [3] 健康投影:同一串路由事件喂进 MR-M3 tracker,snapshot() 吐的正是体检面板
 *       `snap.routing` 的行 —— 你看得见**哪个** provider 在抖(病名 + 状态),
 *       而不只是二元「大脑挂没挂」.
 *   [4] 恢复:主 provider 自愈,冷却期过后 half-open 探针成功,断路器关闭,路由
 *       弹回主 —— 连一次、永续、恢复即回归.
 *
 * 三条不可破边界在这里都看得见:
 *   ① 热路径零 LLM:选下一候选 / 开断路器全靠 classifyLlmError + 计时器 + 候选顺序,
 *      零模型调用。「智能」在候选排序(便宜/本地打头、强模型兜底),不在现场用大模型选路.
 *   ② opt-in 字节不变:不声明 fallbacks 就是今天的单 provider,逐字节一致;这个 demo
 *      是显式声明了候选链才有的行为.
 *   ③ 内核零改动:RoutingProvider 在 @gotong/llm 平级包(只依赖同包 errors/types),
 *      Hub 不认识 fallbacks 字段;健康投影在 host 层,core/workflow/protocol 零改动.
 *
 * Run:  pnpm demo:model-routing
 */

import { RoutingProvider, type RoutingEvent } from '@gotong/llm'
import type { LlmProvider, LlmRequest, LlmStreamChunk, LlmStreamTextChunk } from '@gotong/llm'
import { RoutingHealthTracker } from '@gotong/host/routing-health'

// ── tiny stub providers ─────────────────────────────────────────────────────

/** A single text answer as a stream (real providers yield exactly this shape). */
function okStream(text: string): AsyncIterable<LlmStreamChunk> {
  return (async function* () {
    yield { type: 'text', text } satisfies LlmStreamChunk
    yield { type: 'end', stopReason: 'end_turn' } satisfies LlmStreamChunk
  })()
}

/** A network-class failure that `classifyLlmError` reads as `'network'`. */
function networkError(): Error {
  return Object.assign(new Error('primary provider unreachable'), { code: 'ECONNREFUSED' })
}

// The flaky PRIMARY: throws BEFORE its first chunk while `healthy` is false —
// exactly the pre-first-chunk hard failure the RoutingProvider fails over on.
let primaryHealthy = false
const primary: LlmProvider = {
  name: 'anthropic',
  stream(_req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    if (!primaryHealthy) throw networkError()
    return okStream('主模型 Claude:你好,我在。')
  },
}
// The steady BACKUP: always answers.
const backup: LlmProvider = {
  name: 'openai-compatible:deepseek',
  stream(_req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    return okStream('备用模型 DeepSeek:你好,我顶上了。')
  },
}

// ── one shared clock drives both the breaker and the health time-window ──────
const clock = { t: 0 }
const events: RoutingEvent[] = []
const tracker = new RoutingHealthTracker({ now: () => clock.t })
const router = new RoutingProvider({
  candidates: [
    { provider: primary, label: 'anthropic' },
    { provider: backup, label: 'openai-compatible:deepseek' },
  ],
  now: () => clock.t,
  onEvent: (ev) => {
    events.push(ev)
    // This is the EXACT wiring LocalAgentPool does — the tracker the panel reads.
    tracker.record('butler', ev)
  },
})

const REQ: LlmRequest = { messages: [{ role: 'user', content: '你好' }] }

/** Drain a routing stream to its concatenated text (what the LlmAgent would see). */
async function ask(): Promise<string> {
  const chunks: LlmStreamChunk[] = []
  for await (const c of router.stream(REQ)) chunks.push(c)
  return chunks
    .filter((c): c is LlmStreamTextChunk => c.type === 'text')
    .map((c) => c.text)
    .join('')
}

async function main(): Promise<void> {
  console.log('\n模型路由 capstone — 主模型挂了,管家不断线')
  console.log('（真 RoutingProvider + 真 RoutingHealthTracker;只有两个 provider 是桩，零网络零 key）')

  // [1] ── failover 续跑 ─────────────────────────────────────────────────────
  section('[1] failover:主 provider 首-token-前挂 → 降级到备用,答案照到')
  const a1 = await ask()
  console.log(`  管家答:「${a1}」`)
  assert(a1.includes('备用模型'), '主挂了,答案由备用 provider 给出(调用方无感)')
  assert(
    events.some((e) => e.type === 'candidate_error' && e.index === 0 && e.errorKind === 'network'),
    '路由事件里记了一条:候选 0(主)网络失败',
  )
  assert(events.some((e) => e.type === 'served' && e.index === 1), '候选 1(备)成功接管')
  {
    const rows = tracker.snapshot()
    assert(rows.length === 1 && rows[0]!.index === 0 && rows[0]!.state === 'degraded', '健康投影:主候选 = degraded(近期失败,已 failover)')
  }

  // [2] ── 连续失败 → 熔断 ───────────────────────────────────────────────────
  section('[2] 熔断:主连续失败到阈值 → 断路器打开 → 第 4 次调用快速跳过死掉的主')
  await ask() // 2nd primary failure
  await ask() // 3rd primary failure → breaker opens
  const errsBefore = events.filter((e) => e.type === 'candidate_error' && e.index === 0).length
  assert(errsBefore === 3, `主候选累计 3 次首-chunk-前失败(达到熔断阈值),实际 ${errsBefore}`)
  assert(events.some((e) => e.type === 'breaker_open' && e.index === 0), '断路器对主候选打开(breaker_open)')
  const a4 = await ask() // 4th call — primary is now SKIPPED (open), no new error
  console.log(`  第 4 次仍答:「${a4}」`)
  const errsAfter = events.filter((e) => e.type === 'candidate_error' && e.index === 0).length
  assert(errsAfter === 3, `第 4 次调用快速跳过主(断路器开),没再多产生失败:仍是 ${errsAfter} 次`)
  assert(a4.includes('备用模型'), '第 4 次直奔备用,答案照到')

  // [3] ── 健康投影上面板 ─────────────────────────────────────────────────────
  section('[3] 健康投影:体检面板 snap.routing 读的正是这份 per-provider 健康')
  {
    const rows = tracker.snapshot()
    for (const r of rows) {
      console.log(`  · 智能体「${r.agentId}」候选「${r.candidate}」(#${r.index}) — ${r.state}${r.errorKind ? `,${r.errorKind}` : ''}`)
    }
    assert(rows.length === 1, '当前有 1 条降级候选')
    assert(rows[0]!.state === 'open' && rows[0]!.errorKind === 'network', '主候选 = open(熔断中,病名 network)—— 面板黄条:已切备用,服务未断')
    console.log('  （面板把它渲染成黄条:agent 靠备用仍工作,不是红色「大脑挂了」）')
  }

  // [4] ── 恢复 ──────────────────────────────────────────────────────────────
  section('[4] 恢复:主自愈 + 冷却期过 → half-open 探针成功 → 断路器关 → 弹回主')
  primaryHealthy = true
  clock.t = 30_001 // 冷却期(默认 30s)已过 → 下一次请求会探一次主
  const a5 = await ask()
  console.log(`  管家答:「${a5}」`)
  assert(a5.includes('主模型'), '主已恢复:half-open 探针成功,路由弹回主 provider')
  assert(events.some((e) => e.type === 'breaker_close' && e.index === 0), '断路器关闭(breaker_close)')
  assert(tracker.snapshot().length === 0, '健康投影清空:一切恢复正常,面板不再有黄条')

  // ── 三条不可破边界 ─────────────────────────────────────────────────────────
  section('三条不可破边界')
  console.log('  ① 热路径零 LLM:选路 / 开断路器全靠 classifyLlmError + 计时器 + 候选顺序,零模型调用.')
  console.log('  ② opt-in 字节不变:不声明 fallbacks = 今天的单 provider 逐字节一致;降级是显式声明候选链才有.')
  console.log('  ③ 内核零改动:RoutingProvider 在 @gotong/llm 平级包,健康投影在 host 层,core/workflow/protocol 未动.')

  section('done')
  console.log('  主模型挂了 → 秒切备用 → 连续失败即熔断快速跳过 → 面板看得见哪个在抖 → 主一恢复就弹回.\n')
  process.exit(0)
}

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`)
  console.log(`  ✓ ${label}`)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
