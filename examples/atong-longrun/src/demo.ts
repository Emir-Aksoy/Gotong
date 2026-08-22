/**
 * LONG-M6 capstone — 阿同长任务执行链,零 key 零网络,全程自断言。
 *
 * 这个 demo 把 LONG track 的四件承重事实各自隔离成一幕,用**真件**证明:
 *   - 真 `openLongRunDossierStore`(盘上档案 + 追加不重写的 journal)
 *   - 真 `PersonalButlerAgent` + `longRun` 驱动器(段循环 / 接力挂起 / 段末零 LLM 裁决)
 *   - 真 host 工具面 `buildButlerLongRunSegmentToolset` / `buildButlerLongRunControlToolset`
 *   - 真 M4b 工种槽(compactor 写交接摘要、synthesizer 跑收尾段)
 *
 * 唯一的假件是「hub」和「模型」:
 *   - `MiniHub` 只做真 hub 在这条链上会做的三件事——把派发放到下一个 tick 跑、
 *     把 `SuspendTaskError` 折成一条 park 记录、到点用 `onResume(task, state)` 叫醒。
 *   - `AmnesiacModel` 是**故意失忆**的模型(TN-M3 先例):每次调用都只从请求字节做决定,
 *     实例上没有任何跨调用的记忆字段。它能跑完一项分段任务,唯一的原因就是盘上档案
 *     被确定性渲染成了每段的那一条 user 消息——这正是 LONG-M1/M2 要证的事。
 *
 * 四幕:
 *   ① 失忆接力——接待轮 → start_longrun_task → 段 1 → 接力挂起 → 段 2 冷启动,
 *      每段首轮恰好一条 user 消息、不带上一段的对话;压缩者槽写的交接块出现在下一段提示里,
 *      其花费与段花费同一次记账;park 睡眠的墙钟刻意不计费。
 *   ② kill-restart——接力 park 记录经 JSON 往返(小到不含任何 messages),丢掉整套 store+agent,
 *      用同一目录冷启动一套新的,接着段 3 跑;段 4 模型抛错 → 链诚实停下(failed + ⚠ 旗 + 日志行),
 *      人工重新派发一段 → 提示带 ⚠ 中断行 → 旗清 → 跑完。
 *   ③ 预算耗尽——token 预算 200,段 1 就花 300 → winding_down → 收尾段落在 synthesizer 槽的
 *      模型上 → 模型不 complete 也**强制诚实部分交付**(doneSummary 带「预算用尽,自动收尾」前缀)。
 *   ④ 分解-回收——段 1 派三个子活(行先落盘派发在后,在派发回调里取证),两个在同一管家的
 *      子活通道跑完、花费入父账,一个「管家不在线」→ no_participant 黑洞收成事实行;
 *      下一段提示列出【子活】三行 + 「有 3 条新结果还没消化」,模型消化后收口。
 *
 * 跑法:`pnpm demo:atong-longrun`(exit 0 = 全部断言通过)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isSuspendTaskError, type Task, type TaskResult } from '@gotong/core'
import type { LlmAgentToolset, LlmMessage, LlmProvider, LlmRequest, LlmStreamChunk } from '@gotong/llm'
import type { MemoryEntry, MemoryHandle, NewMemoryEntry } from '@gotong/services-sdk'
import {
  LONGRUN_CHILD_PAYLOAD_KEY,
  LONGRUN_COMPACTOR_SYSTEM,
  LONGRUN_LIMITS,
  LONGRUN_SEGMENT_PAYLOAD_KEY,
  LONGRUN_TOOL_NAMES,
  PersonalButlerAgent,
  openLongRunDossierStore,
  readLongRunChildMarker,
  readLongRunRelayState,
  type LongRunDossier,
  type LongRunDossierStore,
  type LongRunSlotName,
  type LongRunSlotResolution,
} from '@gotong/personal-butler'
import { buildButlerLongRunControlToolset, buildButlerLongRunSegmentToolset } from '@gotong/host/butler-longrun'

// ─── 断言账本 ────────────────────────────────────────────────────────────────

let failures = 0
let passes = 0
function assert(cond: unknown, label: string): void {
  if (cond) {
    passes++
    console.log(`  ✓ ${label}`)
  } else {
    failures++
    console.log(`  ✗ ${label}`)
  }
}

// ─── 注入时钟 ────────────────────────────────────────────────────────────────
// 驱动器与档案核一个 Date.now() 都不读(M1 零时钟断言),时间全从这只表来。
// 只有两件事拨表:模型调用(每次 +3s,代表真实的「活跃墙钟」)和接力到点(跳到 resumeAt)。
// 于是「park 睡眠不计费」可以被精确地量出来,而不是靠说。

let nowMs = 1_800_000_000_000
const now = (): number => nowMs
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const CALL_SECONDS = 3
const USAGE = { inputTokens: 100, outputTokens: 30, cacheCreationTokens: 15, cacheReadTokens: 5 }
const CALL_TOKENS = 150 // 四维求和,驱动器就是这么记账的
const COMPACTOR_USAGE = { inputTokens: 40, outputTokens: 10 }
const COMPACTOR_TOKENS = 50

const USER = 'user:alice'
const BUTLER = 'butler'
const PERSONA = '你是阿同,一个有界治理的个人管家。'
const silentLog = { warn: () => {}, error: () => {} }

// ─── 故意失忆的模型 ──────────────────────────────────────────────────────────
//
// 实例上只有两个字段:`name` 和 `calls`(取证日志,策略永不读它)以及一个 act-② 用的
// 崩溃开关。策略函数 `decide(req)` 是纯函数:同一份请求字节永远得到同一个动作。
// 它看得懂三种请求:
//   - 成员的建档指令(固定语法 `长期任务 <id> | <目标> | <步;步;步> [| 预算 <n>]`)→ start_longrun_task
//   - 接力/收尾提示(【长期任务 · 第 N 段】/【长期任务 · 收尾段】)→ 照档案里的计划做一步
//   - 子活问句(查某城气温)→ 查一张固定表答一句

const TEMPS: Record<string, string> = { 吉隆坡: '33 度', 新山: '31 度', 槟城: '30 度' }

class AmnesiacModel implements LlmProvider {
  readonly name: string
  readonly calls: LlmRequest[] = []
  /** act ②:下一次调用抛错(演示编排用的开关,不是模型记忆)。 */
  explodeNext = false

  constructor(name: string) {
    this.name = name
  }

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.calls.push(req)
    nowMs += CALL_SECONDS * 1000
    if (this.explodeNext) {
      this.explodeNext = false
      throw new Error('provider exploded')
    }
    for (const chunk of decide(req)) yield chunk
  }
}

function textOf(msg: LlmMessage | undefined): string {
  if (!msg) return ''
  if (typeof msg.content === 'string') return msg.content
  return msg.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join(String.fromCharCode(0x0a))
}

/** 上一条消息若是 tool_result,回它对应的工具名(在同一请求里按 id 找)。 */
function lastToolResultName(req: LlmRequest): string | null {
  const last = req.messages[req.messages.length - 1]
  if (!last || typeof last.content === 'string') return null
  const tr = last.content.find((b) => b.type === 'tool_result')
  if (!tr || tr.type !== 'tool_result') return null
  for (const m of req.messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue
    for (const b of m.content) {
      if (b.type === 'tool_use' && b.id === tr.toolUseId) return b.name
    }
  }
  return null
}

function countToolUses(req: LlmRequest, name: string): number {
  let n = 0
  for (const m of req.messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue
    for (const b of m.content) if (b.type === 'tool_use' && b.name === name) n++
  }
  return n
}

function say(text: string): LlmStreamChunk[] {
  return [
    { type: 'text', text },
    { type: 'usage', usage: USAGE },
    { type: 'end', stopReason: 'end_turn' },
  ]
}

function call(req: LlmRequest, name: string, input: Record<string, unknown>): LlmStreamChunk[] {
  // tool_use id 从请求形状推出来(每轮消息数 +2),不靠任何计数器——失忆要失得干净。
  return [
    { type: 'tool_use', toolUse: { type: 'tool_use', id: `tu-${req.messages.length}`, name, input } },
    { type: 'usage', usage: USAGE },
    { type: 'end', stopReason: 'tool_use' },
  ]
}

interface PlanItem {
  text: string
  done: boolean
}

function decide(req: LlmRequest): LlmStreamChunk[] {
  const finished = lastToolResultName(req)
  if (finished && finished !== LONGRUN_TOOL_NAMES.spawn) {
    return say(finished === 'start_longrun_task' ? '已安排:这项会在后台分段推进,完成或需要你决定时我再说。' : '本段到此。')
  }
  // 本轮的「题面」是第一条 user 消息(唤醒提示 / 成员原话 / 子活问句);
  // 后面的消息只是本轮自己的工具往返,策略从不在那里找题面。
  const prompt = textOf(req.messages[0])
  if (prompt.includes('【长期任务 · 收尾段】')) {
    return say('收尾:已完成的部分如日志所记;未完成项如实留待下次。')
  }
  if (prompt.includes('【长期任务 ·')) return segmentPolicy(req, prompt)
  const order = /长期任务 ([a-z0-9_-]+) \| ([^|]+?) \| ([^|]+?)(?: \| 预算 (\d+))?\s*$/m.exec(prompt)
  if (order) {
    const args: Record<string, unknown> = {
      task_id: order[1],
      objective: (order[2] ?? '').trim(),
      plan: (order[3] ?? '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean),
    }
    if (order[4]) args.token_budget = Number(order[4])
    return call(req, 'start_longrun_task', args)
  }
  const city = Object.keys(TEMPS).find((c) => prompt.includes(c))
  if (city) return say(`${city} 今天 ${TEMPS[city]}`)
  return say('(没听懂这条消息)')
}

function segmentPolicy(req: LlmRequest, prompt: string): LlmStreamChunk[] {
  const taskId = /任务 ID: ([a-z0-9_-]+)/.exec(prompt)?.[1] ?? 'unknown'
  const plan: PlanItem[] = [...prompt.matchAll(/^- \[( |x)\] (.+)$/gm)].map((m) => ({ text: m[2] ?? '', done: m[1] === 'x' }))
  const open = plan.filter((p) => !p.done)
  const markDone = (item: PlanItem): PlanItem[] => plan.map((p) => ({ text: p.text, done: p.done || p.text === item.text }))
  if (open.length === 0) {
    return call(req, LONGRUN_TOOL_NAMES.complete, {
      task_id: taskId,
      summary: `已完成:${plan.map((p) => p.text).join(';')}`,
    })
  }
  const item = open[0] as PlanItem
  if (item.text.startsWith('派:')) {
    const cities = item.text.slice(2).split(',')
    if (prompt.includes('条新结果还没消化')) {
      const facts = [...prompt.matchAll(/^- \[(c\d+)\] (.+?) — (✓|✗)(?: (.+))?$/gm)].map(
        (m) => `${m[1]} ${m[3]} ${m[4] ?? ''}`.trim(),
      )
      return call(req, LONGRUN_TOOL_NAMES.progress, {
        task_id: taskId,
        did: `子活回收:${facts.join(';')}`,
        facts,
        next: '全部步骤完成,下一段收尾',
        plan: markDone(item),
      })
    }
    const spawned = countToolUses(req, LONGRUN_TOOL_NAMES.spawn)
    if (spawned < cities.length) {
      return call(req, LONGRUN_TOOL_NAMES.spawn, { task_id: taskId, ask: `查 ${cities[spawned]} 今天气温` })
    }
    return call(req, LONGRUN_TOOL_NAMES.progress, {
      task_id: taskId,
      did: `派出 ${cities.length} 个子活查气温`,
      next: '等子活结果回到档案再汇总',
      plan,
    })
  }
  return call(req, LONGRUN_TOOL_NAMES.progress, {
    task_id: taskId,
    did: `完成:${item.text}`,
    facts: [`${item.text} 已汇总`],
    next: open[1] ? `接着做 ${open[1].text}` : '全部步骤完成,下一段收尾',
    plan: markDone(item),
  })
}

// ─── 压缩者槽(M4b):一个只会写交接摘要的「强模型」 ────────────────────────────

class HandoverWriter implements LlmProvider {
  readonly name = 'compactor-strong'
  readonly calls: LlmRequest[] = []
  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.calls.push(req)
    const done = /已完成 (\d+) 段/.exec(textOf(req.messages[req.messages.length - 1]))?.[1] ?? '?'
    yield { type: 'text', text: `交接:档案显示已完成 ${done} 段;下一步做计划里第一个未勾项。` }
    yield { type: 'usage', usage: COMPACTOR_USAGE }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

// ─── 惰性记忆 ────────────────────────────────────────────────────────────────

function inertMemory(): MemoryHandle {
  return {
    recall: async () => [],
    remember: async (ne: NewMemoryEntry): Promise<MemoryEntry> => ({ id: 'x', kind: ne.kind, text: ne.text, ts: 0 }),
    list: async () => [],
    forget: async () => {},
    clear: async () => {},
  }
}

// ─── MiniHub:真 hub 在这条链上做的三件事 ─────────────────────────────────────

interface Park {
  task: Task
  state: unknown
  resumeAt: number
}

interface DispatchInput {
  from: string
  origin: { orgId: string; userId: string }
  strategy: { kind: 'explicit'; to: string }
  payload: unknown
  title: string
}

class MiniHub {
  agent!: PersonalButlerAgent
  readonly parks: Park[] = []
  readonly results: TaskResult[] = []
  /** 子活派发那一刻父档案的样子(M3「行先落盘派发在后」的取证点)。 */
  readonly childSeen: Array<{ status: string; waiting: boolean }> = []
  /** 问到这座城的子活当「管家不在线」处理(no_participant)。 */
  offlineCity: string | null = null
  /** 幕 ④:扣住子活派发直到 releaseChildren(),把「等子活」那条零 LLM 再挂路径逼出来。 */
  holdChildren = false
  private readonly held: Array<() => void> = []
  private readonly inflight = new Set<Promise<unknown>>()
  private seq = 0

  constructor(private readonly store: LongRunDossierStore) {}

  async dispatch(input: DispatchInput): Promise<TaskResult> {
    const task: Task = {
      id: `t${++this.seq}`,
      from: input.from,
      origin: input.origin,
      strategy: input.strategy,
      payload: input.payload,
      title: input.title,
      createdAt: now(),
    }
    const parent = readLongRunChildMarker(input.payload)
    if (parent) {
      const r = await this.store.load(parent)
      const row = r.kind === 'ok' ? r.dossier.children[r.dossier.children.length - 1] : undefined
      this.childSeen.push({ status: row?.status ?? 'missing', waiting: r.kind === 'ok' && r.dossier.waitingForChildren })
      if (this.holdChildren) await new Promise<void>((r) => this.held.push(r))
      const ask = String((input.payload as { prompt?: unknown }).prompt ?? '')
      if (this.offlineCity && ask.includes(this.offlineCity)) {
        return { kind: 'no_participant', taskId: task.id, reason: 'butler offline (demo)', ts: now() }
      }
    }
    return this.run(task, (t) => this.agent.onTask(t))
  }

  releaseChildren(): void {
    this.holdChildren = false
    for (const r of this.held.splice(0)) r()
  }

  /** 到点叫醒最早的那条 park(把表拨到 resumeAt = 真 sweep 的「到点」语义)。 */
  relay(): Promise<TaskResult> {
    this.parks.sort((a, b) => a.resumeAt - b.resumeAt)
    const park = this.parks.shift()
    if (!park) throw new Error('relay(): nothing parked')
    nowMs = Math.max(nowMs, park.resumeAt)
    return this.run(park.task, (t) => this.agent.onResume(t, park.state))
  }

  private run(task: Task, fn: (t: Task) => Promise<TaskResult>): Promise<TaskResult> {
    const p = (async (): Promise<TaskResult> => {
      await tick() // 真 hub 从不在调用方的栈帧里跑任务
      try {
        const r = await fn(task)
        this.results.push(r)
        return r
      } catch (err) {
        if (isSuspendTaskError(err)) {
          this.parks.push({ task, state: err.state, resumeAt: err.resumeAt })
          const r: TaskResult = { kind: 'suspended', taskId: task.id, by: BUTLER, resumeAt: err.resumeAt, ts: now() }
          this.results.push(r)
          return r
        }
        throw err
      }
    })()
    this.inflight.add(p)
    p.finally(() => this.inflight.delete(p)).catch(() => {})
    return p
  }

  async drain(): Promise<void> {
    for (;;) {
      if (this.inflight.size > 0) {
        await Promise.allSettled([...this.inflight])
        continue
      }
      await tick()
      if (this.inflight.size === 0) return
    }
  }
}

// ─── 一次「进程启动」:真 store + 真工具面 + 真管家 ──────────────────────────

const pushes: string[] = []

interface Node {
  store: LongRunDossierStore
  hub: MiniHub
  agent: PersonalButlerAgent
  brain: AmnesiacModel
  control: LlmAgentToolset
}

function boot(dir: string, brain: AmnesiacModel, slots: Partial<Record<LongRunSlotName, LongRunSlotResolution>> = {}): Node {
  const store = openLongRunDossierStore({ dir, now })
  const hub = new MiniHub(store)
  const segment = buildButlerLongRunSegmentToolset({ userId: USER, butlerId: BUTLER, store, hub, now, logger: silentLog })
  const control = buildButlerLongRunControlToolset({
    userId: USER,
    butlerId: BUTLER,
    store,
    hub,
    push: (_userId, text) => {
      pushes.push(String(text))
    },
    logger: silentLog,
  })
  const agent = new PersonalButlerAgent({
    id: BUTLER,
    provider: brain,
    memory: inertMemory(),
    system: PERSONA,
    captureTurns: false,
    benign: [control, segment],
    longRun: {
      store,
      now,
      push: (text) => {
        pushes.push(text)
      },
      slotProvider: async (slot) => slots[slot] ?? null,
      logger: silentLog,
    },
  })
  hub.agent = agent
  return { store, hub, agent, brain, control }
}

function memberSays(hub: MiniHub, text: string): Promise<TaskResult> {
  return hub.dispatch({
    from: USER,
    origin: { orgId: 'local', userId: USER },
    strategy: { kind: 'explicit', to: BUTLER },
    payload: { prompt: text },
    title: '成员消息',
  })
}

async function dossierOf(store: LongRunDossierStore, taskId: string): Promise<LongRunDossier> {
  const r = await store.load(taskId)
  if (r.kind !== 'ok') throw new Error(`dossier ${taskId}: ${r.kind}`)
  return r.dossier
}

async function until(pred: () => Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    if (await pred()) return
    await tick()
  }
  throw new Error(`timeout waiting for: ${label}`)
}

function firstRoundPrompt(brain: AmnesiacModel, fromIndex: number): { req: LlmRequest | undefined; text: string } {
  const req = brain.calls[fromIndex]
  return { req, text: req ? textOf(req.messages[req.messages.length - 1]) : '' }
}

function toolResultText(req: LlmRequest | undefined): string {
  const last = req?.messages[req.messages.length - 1]
  if (!last || typeof last.content === 'string') return ''
  const tr = last.content.find((b) => b.type === 'tool_result')
  if (!tr || tr.type !== 'tool_result') return ''
  return typeof tr.content === 'string' ? tr.content : tr.content.map((b) => b.text).join('')
}

// ─── 主线 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'atong-longrun-'))
  const dir = join(root, 'longrun', 'alice')
  try {
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n━━ 幕 ① 失忆接力:接待 → 建档 → 段 1 → 接力挂起 → 段 2 冷启动 ━━')
    const brain1 = new AmnesiacModel('brain-1')
    const compactor = new HandoverWriter()
    const n1 = boot(dir, brain1, { compactor: { provider: compactor, model: 'compactor-strong' } })

    const receipt = await memberSays(n1.hub, '长期任务 invoices | 整理 2025 年四个季度的发票 | Q1;Q2;Q3;Q4')
    assert(receipt.kind === 'ok', '接待轮正常结束(建档是 benign 动作,不 park)')
    assert(
      brain1.calls[0]?.tools?.some((t) => t.name === 'start_longrun_task') === true,
      '接待模型的工具面里有 start_longrun_task(真 host 控制工具面)',
    )
    assert(toolResultText(brain1.calls[1]).includes('长期任务「invoices」已建档并在后台启动'), '工具回执:已建档并在后台启动')

    await n1.hub.drain() // 段 1 在后台跑到第一次接力挂起
    const after1 = await dossierOf(n1.store, 'invoices')
    assert(after1.status === 'active' && after1.segments === 1, '段 1 跑完:status=active, segments=1')
    assert(after1.plan.map((p) => p.done).join(',') === 'true,false,false,false', '计划整份更新:Q1 勾上,其余未勾')
    const journal1 = await n1.store.readJournalTail('invoices')
    assert(journal1.length === 1 && journal1[0]?.did.includes('完成:Q1'), 'journal 第 1 行 = 段 1 做了什么')
    assert(n1.hub.parks.length === 1, '段末裁决 = 接力:任务挂起等下一段')
    const park1 = n1.hub.parks[0] as Park
    assert(readLongRunRelayState(park1.state) === 'invoices', 'park 状态只是一枚接力标记 {longrunRelay:{taskId}}')
    assert(!JSON.stringify(park1.state).includes('messages'), '接力挂起刻意不打包 messages(接力 ≠ 重放)')
    assert(park1.resumeAt - nowMs === LONGRUN_LIMITS.relayDelayMs, `resumeAt = now + ${LONGRUN_LIMITS.relayDelayMs}ms(注入时钟,零 Date.now)`)

    // 压缩者槽:段末写交接,花费与段花费同一次记账
    assert(compactor.calls.length === 1, '压缩者在段 1 末被调了恰好一次(只在接力类裁决上)')
    const c0 = compactor.calls[0]
    assert(c0?.model === 'compactor-strong' && c0.system === LONGRUN_COMPACTOR_SYSTEM, '压缩者请求:槽的模型名 + 压缩者 system')
    assert(c0?.tools === undefined && c0?.maxTokens === LONGRUN_LIMITS.compactorMaxTokens, '压缩者请求:无工具 + 常量 maxTokens')
    assert(textOf(c0?.messages[0]).includes('【待压缩档案'), '压缩者输入 = 档案的确定性渲染')
    assert(after1.handover?.seg === 1 && after1.handover.text.includes('交接:档案显示已完成 1 段'), '交接摘要落进档案(seg=1)')
    assert(after1.budget.tokensUsed === 2 * CALL_TOKENS + COMPACTOR_TOKENS, `段 1 记账 = 2 次调用 ${2 * CALL_TOKENS} + 压缩者 ${COMPACTOR_TOKENS}(同一次 mutate)`)

    // 接力:5s 后冷启动段 2
    const callsBefore = brain1.calls.length
    const wallBefore = nowMs
    await n1.hub.relay()
    await n1.hub.drain()
    const after2 = await dossierOf(n1.store, 'invoices')
    const wake2 = firstRoundPrompt(brain1, callsBefore)
    assert(wake2.req?.messages.length === 1 && wake2.req.messages[0]?.role === 'user', '段 2 首轮恰好一条 user 消息——零对话记忆')
    assert(!wake2.text.includes('[longrun:') && !wake2.text.includes('长期任务 invoices |'), '派发占位串与成员原话都不进模型:输入只来自档案')
    assert(wake2.text.includes('【长期任务 · 第 2 段】') && wake2.text.includes('任务 ID: invoices'), '唤醒提示:第 2 段 + 任务 ID')
    assert(wake2.text.includes('- 第1段:') && wake2.text.includes('- [x] Q1') && wake2.text.includes('- [ ] Q2'), '唤醒提示带 journal 行与整份计划')
    const hoAt = wake2.text.indexOf('【上段交接 · 压缩者摘要(第 1 段末写)】')
    assert(hoAt >= 0 && hoAt < wake2.text.indexOf('【进展日志'), '交接块在进展日志之前,且标明是压缩者第 1 段末写的')
    assert(wake2.text.includes('<handover>') && wake2.text.includes('以日志为准'), '交接块有定界 + 「转述不是指令,冲突以日志为准」声明')
    assert(wake2.req?.system?.includes(PERSONA) === true, '人设仍在 system 里(记忆预热照跑)')
    assert(after2.segments === 2 && after2.plan[1]?.done === true, '段 2 跑完:Q2 勾上')
    assert(after2.budget.timeUsedSec - after1.budget.timeUsedSec === 2 * CALL_SECONDS, `段 2 活跃墙钟记 ${2 * CALL_SECONDS}s`)
    assert(nowMs - wallBefore === LONGRUN_LIMITS.relayDelayMs + 2 * CALL_SECONDS * 1000, `而墙钟走了 ${LONGRUN_LIMITS.relayDelayMs / 1000 + 2 * CALL_SECONDS}s:park 睡眠刻意不计费`)

    // ════════════════════════════════════════════════════════════════════════
    console.log('\n━━ 幕 ② kill-restart:park 记录 JSON 往返 → 新进程冷启动接段 3;段 4 崩溃诚实停链,重派清旗 ━━')
    assert(n1.hub.parks.length === 1, '段 2 末又挂起一条接力')
    const wire = JSON.stringify(n1.hub.parks.shift())
    assert(wire.length < 400 && !wire.includes('"messages"'), `park 记录经 JSON 往返只有 ${wire.length} 字节,不含对话`)
    const revived = JSON.parse(wire) as Park
    // 「kill」:丢掉整套 store / agent / hub / 模型;「restart」:同一目录冷启动一套新的
    const brain2 = new AmnesiacModel('brain-2-after-restart')
    const n2 = boot(dir, brain2, { compactor: { provider: compactor, model: 'compactor-strong' } })
    n2.hub.parks.push(revived)
    await n2.hub.relay()
    await n2.hub.drain()
    const wake3 = firstRoundPrompt(brain2, 0)
    assert(wake3.text.includes('【长期任务 · 第 3 段】'), '新进程从盘上档案直接进第 3 段')
    assert(wake3.text.includes('- 第1段:') && wake3.text.includes('- 第2段:'), 'journal 两行跨重启幸存')
    assert(wake3.text.includes('【上段交接 · 压缩者摘要(第 2 段末写)】'), '旧进程压缩者写的交接块,新进程读到')
    const after3 = await dossierOf(n2.store, 'invoices')
    assert(after3.segments === 3 && after3.plan[2]?.done === true && after3.handover?.seg === 3, '段 3 跑完:Q3 勾上,段 3 末又写了新交接')

    // 段 4:模型抛错 → 链诚实停下
    brain2.explodeNext = true
    const pushesBefore = pushes.length
    const crashed = await n2.hub.relay()
    await n2.hub.drain()
    assert(crashed.kind === 'failed' && crashed.error.includes('provider exploded'), '段执行抛错 → 任务结果 failed(不是 reject,也不是假挂起)')
    assert(n2.hub.parks.length === 0, '崩溃后不再自动接力(不做自动重试=不做过度设计)')
    const afterCrash = await dossierOf(n2.store, 'invoices')
    assert(afterCrash.interrupted === true && afterCrash.segments === 3 && afterCrash.status === 'active', '档案留盘:interrupted=true,段数不涨,仍 active(僵档如实)')
    const jCrash = await n2.store.readJournalTail('invoices')
    assert(jCrash[jCrash.length - 1]?.did.includes('(段执行失败,接力停止)'), 'journal 落失败行')
    assert(pushes.slice(pushesBefore).some((t) => t.includes('本段执行失败,后台接力就此停止')), '成员收到诚实推送:接力就此停止')

    // 人工重新派发一段(v1 出路):提示带 ⚠ 中断行,干净收尾才清旗
    const c2 = brain2.calls.length
    await n2.hub.dispatch({
      from: USER,
      origin: { orgId: 'local', userId: USER },
      strategy: { kind: 'explicit', to: BUTLER },
      payload: { [LONGRUN_SEGMENT_PAYLOAD_KEY]: 'invoices', prompt: '[longrun:invoices]' },
      title: '重新派发',
    })
    await n2.hub.drain()
    assert(firstRoundPrompt(brain2, c2).text.includes('⚠ 上一段没有正常收尾'), '重派后的唤醒提示带 ⚠ 中断行')
    const after4 = await dossierOf(n2.store, 'invoices')
    assert(after4.interrupted === false && after4.segments === 4 && after4.plan[3]?.done === true, '段 4 干净收尾:旗清,Q4 勾上')
    await n2.hub.relay() // 段 5:计划全勾 → complete
    await n2.hub.drain()
    const doneInv = await dossierOf(n2.store, 'invoices')
    assert(doneInv.status === 'done' && doneInv.doneSummary?.includes('已完成:Q1;Q2;Q3;Q4') === true, '段 5 模型标 complete → done + 总结')
    assert(pushes.some((t) => t.includes('[长期任务 invoices] 完成 ✓')), '完成推送送到成员')
    assert(n2.hub.parks.length === 0, '终态后链自然收束,无新挂起')

    // ════════════════════════════════════════════════════════════════════════
    console.log('\n━━ 幕 ③ 预算耗尽:token 预算 200 → winding_down → synthesizer 槽跑收尾段 → 诚实部分交付 ━━')
    const synth = new AmnesiacModel('synth-strong')
    const brain3 = new AmnesiacModel('brain-3')
    const n3 = boot(dir, brain3, { synthesizer: { provider: synth, model: 'strong' } })
    await memberSays(n3.hub, '长期任务 audit | 审计三份合同 | 合同A;合同B;合同C | 预算 200')
    await n3.hub.drain()
    const a1 = await dossierOf(n3.store, 'audit')
    assert(a1.budget.tokenBudget === 200 && a1.budget.tokensUsed === 2 * CALL_TOKENS, '预算 200 入档,段 1 就花了 300')
    assert(a1.status === 'winding_down' && a1.segments === 1, '段末裁决:预算耗尽 → 先标 winding_down,再接力一次')
    assert(n3.hub.parks.length === 1, '收尾段作为一次接力挂起')
    const b3 = brain3.calls.length
    await n3.hub.relay()
    await n3.hub.drain()
    assert(synth.calls.length === 1 && synth.calls[0]?.model === 'strong', '收尾段落在 synthesizer 槽的 provider 上,model=槽里的名字')
    assert(brain3.calls.length === b3, '主链模型在收尾段零调用(工种派档)')
    const wind = textOf(synth.calls[0]?.messages[0])
    assert(wind.includes('【长期任务 · 收尾段】') && wind.includes('超限项: token 预算'), '收尾提示:点名超限项 = token 预算')
    const aDone = await dossierOf(n3.store, 'audit')
    assert(aDone.status === 'done' && aDone.doneSummary?.startsWith('(预算用尽,自动收尾)') === true, '模型只说话不 complete → 强制诚实部分交付')
    assert(aDone.doneSummary?.includes('收尾:已完成的部分如日志所记') === true, '部分交付的正文 = 收尾段模型的话')
    assert(aDone.plan.filter((p) => p.done).length === 1, '档案如实:三步只做完一步')
    assert(pushes.some((t) => t.includes('预算用尽,已收尾(部分交付)')), '成员收到「预算用尽,已收尾(部分交付)」')
    assert(n3.hub.parks.length === 0, '收尾后无新挂起')

    // ════════════════════════════════════════════════════════════════════════
    console.log('\n━━ 幕 ④ 分解-回收:派三个子活(行先落盘) → 两个跑完入父账 + 一个不在线黑洞收口 → 下一段读新结果 ━━')
    const brain4 = new AmnesiacModel('brain-4')
    const n4 = boot(dir, brain4)
    n4.hub.offlineCity = '槟城'
    n4.hub.holdChildren = true // 先把三个子活扣住:逼出「等子活」那条零 LLM 的路
    await memberSays(n4.hub, '长期任务 weather | 查三地今天气温 | 派:吉隆坡,新山,槟城')
    await n4.hub.drain()
    assert(n4.hub.childSeen.length === 3, '三个子活各派发一次(spawn 是一等工具,接力提示逐字点名它)')
    assert(n4.hub.childSeen.every((s) => s.status === 'pending' && s.waiting), '派发回调那一刻:父档案已有 pending 行 + waitingForChildren=true(行先落盘派发在后)')
    assert(brain4.calls.some((r) => toolResultText(r).includes('子活「c1」已派出')), 'spawn 回执:子活「c1」已派出')
    const w1 = await dossierOf(n4.store, 'weather')
    assert(w1.children.length === 3 && w1.nextChildId === 4 && w1.children.every((c) => c.status === 'pending'), '三条 pending 子活行,childId 由 mutate 分配到 c3')
    assert(w1.segments === 1 && w1.budget.tokensUsed === 5 * CALL_TOKENS, `段 1 = 3 次 spawn + 1 次 progress + 1 次收尾文本 = ${5 * CALL_TOKENS}`)
    const wait1 = (n4.hub.parks[0]?.resumeAt ?? 0) - nowMs
    assert(n4.hub.parks.length === 1 && wait1 === LONGRUN_LIMITS.waitBaseDelayMs, `段末裁决 = 等子活:挂 ${LONGRUN_LIMITS.waitBaseDelayMs / 1000}s,不是 5s 接力`)

    // 到点醒来两次,子活都还没回:零模型调用,直接再挂,退避翻倍
    const b4a = brain4.calls.length
    await n4.hub.relay()
    await n4.hub.drain()
    const wait2 = (n4.hub.parks[0]?.resumeAt ?? 0) - nowMs
    await n4.hub.relay()
    await n4.hub.drain()
    const wait3 = (n4.hub.parks[0]?.resumeAt ?? 0) - nowMs
    assert(brain4.calls.length === b4a, '两次唤醒预检:没新结果 → 零模型调用')
    assert(n4.hub.parks.length === 1 && wait2 === LONGRUN_LIMITS.waitBaseDelayMs && wait3 === 2 * LONGRUN_LIMITS.waitBaseDelayMs, `再挂且指数退避(${wait2 / 1000}s → ${wait3 / 1000}s)`)
    assert((await dossierOf(n4.store, 'weather')).waitStreak === 2, 'waitStreak 字段级 +1 两次(不整份回写陈旧快照)')

    // 放行子活:两个在子活通道跑完(花费入父账),一个「管家不在线」→ 黑洞收成事实行
    n4.hub.releaseChildren()
    await n4.hub.drain()
    await until(async () => (await dossierOf(n4.store, 'weather')).children.every((c) => c.status !== 'pending'), 'children settled')
    const w2 = await dossierOf(n4.store, 'weather')
    const rows = Object.fromEntries(w2.children.map((c) => [c.id, c]))
    assert(rows.c1?.status === 'ok' && rows.c1.result === '吉隆坡 今天 33 度', 'c1:子活通道跑完,结果由驱动器代码从 TaskResult 写进事实行')
    assert(rows.c2?.status === 'ok' && rows.c2.result === '新山 今天 31 度', 'c2 同样')
    assert(rows.c3?.status === 'failed' && rows.c3.result === '管家不在线,子活没有执行。', 'c3:no_participant 黑洞收成事实行(不是静默丢)')
    assert(w2.segments === 1 && w2.waitingForChildren === true && w2.childResultsSeen === 0, '子活不算段;settle 不碰等待旗;段末只记渲染时刻快照(0)')
    assert(w2.budget.tokensUsed === (5 + 2) * CALL_TOKENS, `子活花费入父账:${5 * CALL_TOKENS} + 2 × ${CALL_TOKENS} = ${(5 + 2) * CALL_TOKENS}`)

    // 再到点:有 3 条新结果 → 跑段,提示列出【子活】
    const b4b = brain4.calls.length
    await n4.hub.relay()
    await n4.hub.drain()
    const wakeW = firstRoundPrompt(brain4, b4b).text
    assert(wakeW.includes('【子活】') && wakeW.includes('- [c1]') && wakeW.includes('✓ 吉隆坡 今天 33 度'), '下一段提示列出【子活】与结果')
    assert(wakeW.includes('✗ 管家不在线,子活没有执行。'), '黑洞那行如实印出')
    assert(wakeW.includes('(有 3 条新结果还没消化——先读它们。)'), '新结果提示 = settled − seen = 3')
    const w3 = await dossierOf(n4.store, 'weather')
    assert(w3.childResultsSeen === 3 && w3.segments === 2 && w3.plan[0]?.done === true && w3.waitStreak === 0, '段 2 消化结果:seen 记到渲染快照 3,步骤勾上,waitStreak 归零')
    await n4.hub.relay() // 段 3:计划全勾 → complete
    await n4.hub.drain()
    const wDone = await dossierOf(n4.store, 'weather')
    assert(wDone.status === 'done' && wDone.doneSummary?.includes('已完成:派:') === true, '段 3 complete → done')
    const jW = await n4.store.readJournalTail('weather')
    assert(jW.some((e) => e.did.includes('子活回收:') && e.did.includes('c3 ✗')), 'journal 里子活回收行记下了 c3 的失败')

    // ════════════════════════════════════════════════════════════════════════
    console.log('\n━━ 收官:目录面 list_longrun_tasks 读到三份档案 ━━')
    const listed = await n4.control.callTool('list_longrun_tasks', {})
    const listedText = String((listed.content[0] as { text?: unknown } | undefined)?.text ?? '')
    assert(
      listedText.includes('「invoices」已完成') && listedText.includes('「audit」已完成') && listedText.includes('「weather」已完成'),
      '三份档案全在盘上:invoices / audit / weather 均已完成',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  console.log(`\n━━ 结果:${failures === 0 ? `全部 ${passes} 条断言通过 ✓` : `${failures} 条断言失败 ✗(通过 ${passes})`} ━━`)
  if (failures > 0) process.exit(1)
}

// 零 LLM 零网络:挂死的派发不会有任何 timer 撑着进程,没有这两行会静默 exit 0。
process.exitCode = 1
const watchdog = setTimeout(() => {
  console.error('demo hung: no result within 60s')
  process.exit(1)
}, 60_000)

main()
  .then(() => {
    clearTimeout(watchdog)
    process.exitCode = 0
  })
  .catch((err) => {
    console.error('demo crashed:', err)
    process.exit(1)
  })
