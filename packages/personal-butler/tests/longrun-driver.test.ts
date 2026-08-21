/**
 * LONG-M2 — 分段执行器 + 接力驱动(PersonalButlerAgent 内的 longRun 驱动面)。
 *
 * 驱动真 agent + 真 dossier store(tmp 盘),只有 provider 是脚本件。钉五类合同:
 *
 *   1. 段生命周期 — 标记任务进驱动通道(不走普通聊天):跑一段 → 台账入账
 *      (token 四维求和 + 活跃墙钟)→ 日志兜底 → 接力自挂起(relay state 只带
 *      taskId,刻意不带 messages——接力 ≠ 重放)。
 *   2. 唤醒段的全部输入 = 盘上档案的确定性渲染(单条 user 消息:任务 ID 行 /
 *      objective / 日志交接 / 纪律),原派发 payload 不再出现。
 *   3. 终态裁决 — complete → done+push;blocked → push 问题;预算耗尽 →
 *      winding_down 标记 → 收尾段提示 → 模型仍不 complete 则强制部分交付。
 *   4. 段中 governed park — 花费先入账(段数不加),批准续跑后段末只记增量;
 *      成员在批准落地前取消 → 批准的动作一步不执行(取消赢过批准)。
 *   5. 崩溃诚实 — 段执行抛错:花费入账 + 失败日志 + push,档案留盘;下次唤醒
 *      的提示带 ⚠ 中断行,干净收尾后清掉。
 *   6. M3 子活通道 — CHILD 标记的任务是段派出去的一回合 turn:花费计入父档案
 *      预算、不进 episodic、不接力不算段;governed park 照常(分解≠授权);
 *      没接驱动器时标记惰性。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SuspendTaskError, isSuspendTaskError, type Task } from '@gotong/core'
import type {
  LlmAgentToolset,
  LlmProvider,
  LlmRequest,
  LlmStreamChunk,
  LlmToolCallResult,
  LlmToolDefinition,
  LlmUsage,
} from '@gotong/llm'
import type { MemoryEntry, MemoryHandle, MemoryKind, MemoryQuery, NewMemoryEntry } from '@gotong/services-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  GovernedActionToolset,
  LONGRUN_CHILD_PAYLOAD_KEY,
  LONGRUN_LIMITS,
  LONGRUN_SEGMENT_PAYLOAD_KEY,
  PersonalButlerAgent,
  longRunRelayState,
  openLongRunDossierStore,
  readButlerGateState,
  readLongRunRelayState,
  type LongRunDossierStore,
} from '../src/index.js'

// ── harness ────────────────────────────────────────────────────────────────

/** 可注入时钟:store 与驱动器共用同一只表,秒数断言才确定。 */
let nowMs = 1_800_000_000_000
const now = () => nowMs

/** 脚本 provider:每次 stream 吐一轮;`onCall` 给测试拨钟用。 */
class ScriptProvider implements LlmProvider {
  readonly name = 'script'
  readonly requests: LlmRequest[] = []
  private i = 0
  constructor(
    private readonly turns: LlmStreamChunk[][],
    private readonly onCall?: () => void,
  ) {}
  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(req)
    this.onCall?.()
    const turn = this.turns[Math.min(this.i, this.turns.length - 1)]!
    this.i++
    for (const c of turn) yield c
  }
}

/** 首次调用即抛的 provider — 模拟段执行崩溃(provider 断供 / 进程级错误)。 */
class ExplodeOnceProvider implements LlmProvider {
  readonly name = 'explode-once'
  readonly requests: LlmRequest[] = []
  private calls = 0
  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(req)
    if (this.calls++ === 0) throw new Error('provider exploded')
    yield { type: 'text', text: '这段跑完了' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

function textTurn(text: string, usage?: LlmUsage): LlmStreamChunk[] {
  const chunks: LlmStreamChunk[] = [{ type: 'text', text }]
  if (usage) chunks.push({ type: 'usage', usage })
  chunks.push({ type: 'end', stopReason: 'end_turn' })
  return chunks
}

function toolTurn(
  call: { id: string; name: string; input: Record<string, unknown> },
  usage?: LlmUsage,
): LlmStreamChunk[] {
  const chunks: LlmStreamChunk[] = [
    { type: 'tool_use', toolUse: { type: 'tool_use', id: call.id, name: call.name, input: call.input } },
  ]
  if (usage) chunks.push({ type: 'usage', usage })
  chunks.push({ type: 'end', stopReason: 'tool_use' })
  return chunks
}

function emptyMemory(): MemoryHandle {
  const entries: MemoryEntry[] = []
  let seq = 0
  return {
    async recall(_q: MemoryQuery): Promise<MemoryEntry[]> {
      return []
    },
    async remember(ne: NewMemoryEntry): Promise<MemoryEntry> {
      seq++
      const e: MemoryEntry = { id: ne.id ?? `m${seq}`, kind: ne.kind, text: ne.text, ts: 1000 + seq }
      entries.push(e)
      return e
    },
    async list(): Promise<MemoryEntry[]> {
      return [...entries]
    },
    async forget(): Promise<void> {},
    async clear(_kind?: MemoryKind): Promise<void> {},
  }
}

/**
 * 段三件的店面级模拟(host 版工具的语义镜像:全部落在同一个 store 上)——
 * 包内测试不 import host;host 工具本体由 host 侧套件盖。`settle_child` 是
 * 测试专用件,模拟「子活在段中途落地」(M3 的回收器将来做同一件事)。
 */
function segmentSimToolset(store: LongRunDossierStore): LlmAgentToolset {
  const schema: LlmToolDefinition['inputSchema'] = { type: 'object', properties: {} }
  return {
    listTools(): LlmToolDefinition[] {
      return [
        { name: 'record_longrun_progress', description: '把本段进展记进档案', inputSchema: schema },
        { name: 'complete_longrun_task', description: '提交完成', inputSchema: schema },
        { name: 'block_longrun_task', description: '标记等成员输入', inputSchema: schema },
        { name: 'settle_child', description: '(测试件)把首个子活标成 ok', inputSchema: schema },
      ]
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
      const id = String(args.task_id ?? '')
      if (name === 'record_longrun_progress') {
        const loaded = await store.load(id)
        const seg = loaded.kind === 'ok' ? loaded.dossier.segments + 1 : 1
        await store.appendJournal(id, {
          seg,
          did: String(args.did ?? ''),
          ...(typeof args.next === 'string' ? { next: args.next } : {}),
        })
        return { content: [{ type: 'text', text: '进展已记入档案。' }] }
      }
      if (name === 'complete_longrun_task') {
        await store.mutate(id, (d) => {
          d.status = 'done'
          d.doneSummary = String(args.summary ?? '')
          d.waitingForChildren = false
        })
        return { content: [{ type: 'text', text: '已标记完成。' }] }
      }
      if (name === 'block_longrun_task') {
        await store.mutate(id, (d) => {
          d.status = 'blocked'
          d.blockedQuestion = String(args.question ?? '')
        })
        return { content: [{ type: 'text', text: '已标记等成员输入。' }] }
      }
      if (name === 'settle_child') {
        await store.mutate(id, (d) => {
          const child = d.children[0]
          if (child) {
            child.status = 'ok'
            child.result = String(args.result ?? '')
            child.at = now()
          }
        })
        return { content: [{ type: 'text', text: '子活已落地。' }] }
      }
      return { content: [{ type: 'text', text: `未知工具 ${name}` }], isError: true }
    },
  }
}

function governedToolset(execLog: string[]): GovernedActionToolset {
  return new GovernedActionToolset({
    tools: [
      {
        name: 'delete_agent',
        description: 'delete a managed agent',
        inputSchema: { type: 'object', properties: { handle: { type: 'string' } } },
      },
    ],
    classify: async () => ({ decision: 'approve', reason: 'destructive' }),
    execute: async (_name: string, args: Record<string, unknown>) => {
      execLog.push(`delete:${String(args.handle)}`)
      return { text: `deleted ${String(args.handle)}` }
    },
  })
}

/** 段任务:payload 带 LONGRUN_SEGMENT_PAYLOAD_KEY 标记(start 工具派发的形状)。 */
const segTask = (id: string, lrTaskId: string): Task => ({
  id,
  from: 'user:alice',
  strategy: { kind: 'explicit', to: 'butler' },
  payload: { [LONGRUN_SEGMENT_PAYLOAD_KEY]: lrTaskId, prompt: `[longrun:${lrTaskId}]` },
})

/** M3 子活任务:payload 带 CHILD 标记(spawn 工具派发的形状,值 = 父任务 id)。 */
const childTask = (id: string, parentId: string, ask: string): Task => ({
  id,
  from: 'user:alice',
  strategy: { kind: 'explicit', to: 'butler' },
  payload: { [LONGRUN_CHILD_PAYLOAD_KEY]: parentId, prompt: ask },
})

async function expectPark(p: Promise<unknown>): Promise<SuspendTaskError> {
  try {
    await p
  } catch (e) {
    if (isSuspendTaskError(e)) return e
    throw e
  }
  throw new Error('expected a park')
}

interface BuildOpts {
  provider: LlmProvider
  store: LongRunDossierStore
  pushes?: string[]
  benign?: LlmAgentToolset
  governed?: GovernedActionToolset
  noDriver?: boolean
}

function buildAgent(opts: BuildOpts): PersonalButlerAgent {
  const pushes = opts.pushes
  return new PersonalButlerAgent({
    id: 'butler',
    provider: opts.provider,
    memory: emptyMemory(),
    system: '人设',
    captureTurns: false,
    ...(opts.benign ? { benign: opts.benign } : {}),
    ...(opts.governed ? { governed: opts.governed } : {}),
    ...(opts.noDriver
      ? {}
      : {
          longRun: {
            store: opts.store,
            now,
            ...(pushes
              ? {
                  push: (text: string) => {
                    pushes.push(text)
                  },
                }
              : {}),
          },
        }),
  })
}

let root: string
let store: LongRunDossierStore

beforeEach(() => {
  nowMs = 1_800_000_000_000
  root = mkdtempSync(join(tmpdir(), 'gotong-longrun-driver-'))
  store = openLongRunDossierStore({ dir: join(root, 'lr'), now })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ── ① 段生命周期:跑一段 → 入账 → 日志兜底 → 接力挂起 ─────────────────────

describe('LONG-M2 驱动器 — 段生命周期与接力', () => {
  it('首段跑完:token 四维 + 活跃秒入账、段数 +1、自动日志兜底、接力挂起只带 taskId', async () => {
    await store.create({ taskId: 'job', userId: 'alice', objective: '整理 2025 年的发票' })
    const provider = new ScriptProvider(
      [
        textTurn('第一段:找到了发票目录', {
          inputTokens: 100,
          outputTokens: 30,
          cacheCreationTokens: 15,
          cacheReadTokens: 5,
        }),
      ],
      () => {
        nowMs += 4_000
      },
    )
    const agent = buildAgent({ provider, store })

    const park = await expectPark(agent.onTask(segTask('t1', 'job')))
    expect(readLongRunRelayState(park.state)).toBe('job')
    expect(park.resumeAt).toBe(nowMs + LONGRUN_LIMITS.relayDelayMs)

    const loaded = await store.load('job')
    expect(loaded.kind).toBe('ok')
    if (loaded.kind !== 'ok') return
    expect(loaded.dossier.segments).toBe(1)
    expect(loaded.dossier.interrupted).toBe(false)
    expect(loaded.dossier.budget.tokensUsed).toBe(150)
    expect(loaded.dossier.budget.timeUsedSec).toBe(4)

    // 模型没调 record_longrun_progress → 机械兜底一行,下一段不空手交接。
    const tail = await store.readJournalTail('job')
    expect(tail).toHaveLength(1)
    expect(tail[0]!.seg).toBe(1)
    expect(tail[0]!.did).toContain('(自动记录)')
    expect(tail[0]!.did).toContain('第一段:找到了发票目录')
  })

  it('模型自己记了进展 → 不再落自动兜底行(段号判重)', async () => {
    await store.create({ taskId: 'job', userId: 'alice', objective: '找供应商' })
    const provider = new ScriptProvider([
      toolTurn({ id: 'c1', name: 'record_longrun_progress', input: { task_id: 'job', did: '查了三家供应商' } }),
      textTurn('本段收工'),
    ])
    const agent = buildAgent({ provider, store, benign: segmentSimToolset(store) })

    await expectPark(agent.onTask(segTask('t1', 'job')))
    const tail = await store.readJournalTail('job')
    expect(tail).toHaveLength(1)
    expect(tail[0]!.did).toBe('查了三家供应商')
  })

  it('唤醒段的全部输入 = 档案渲染:单条 user 消息带任务 ID/日志交接,原 payload 不再出现', async () => {
    await store.create({ taskId: 'job', userId: 'alice', objective: '整理 2025 年的发票' })
    await store.appendJournal('job', { seg: 1, did: '找到了发票目录', next: '按月份分类' })
    await store.mutate('job', (d) => {
      d.segments = 1
    })
    const provider = new ScriptProvider([textTurn('继续')])
    const agent = buildAgent({ provider, store })

    await expectPark(agent.onResume(segTask('t2', 'job'), longRunRelayState('job')))
    const req = provider.requests[0]!
    expect(req.messages).toHaveLength(1)
    expect(req.messages[0]!.role).toBe('user')
    const prompt = req.messages[0]!.content as string
    expect(prompt).toContain('【长期任务 · 第 2 段】')
    expect(prompt).toContain('任务 ID: job(调用长期任务工具时')
    expect(prompt).toContain('整理 2025 年的发票')
    expect(prompt).toContain('- 第1段: 找到了发票目录')
    expect(prompt).toContain('下一步: 按月份分类')
    // 接力 ≠ 重放:派发 payload 的机器占位串不进模型输入。
    expect(prompt).not.toContain('[longrun:')
    // 记忆预热跑过:人设仍在 system(段绕过普通聊天路径,但冻结块/人设照常)。
    expect(req.system).toContain('人设')
  })
})

// ── ② 终态裁决:complete / blocked / 预算耗尽 ─────────────────────────────

describe('LONG-M2 驱动器 — 终态裁决与预算', () => {
  it('complete → done + push 总结,不再挂起', async () => {
    await store.create({ taskId: 'job', userId: 'alice', objective: '归档发票' })
    const pushes: string[] = []
    const provider = new ScriptProvider([
      toolTurn({ id: 'c1', name: 'complete_longrun_task', input: { task_id: 'job', summary: '发票已全部归档' } }),
      textTurn('收工'),
    ])
    const agent = buildAgent({ provider, store, pushes, benign: segmentSimToolset(store) })

    const res = (await agent.onTask(segTask('t1', 'job'))) as { kind: string }
    expect(res.kind).toBe('ok')
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toContain('[长期任务 job] 完成 ✓')
    expect(pushes[0]).toContain('发票已全部归档')
    const loaded = await store.load('job')
    if (loaded.kind !== 'ok') throw new Error('dossier gone')
    expect(loaded.dossier.status).toBe('done')
    expect(loaded.dossier.segments).toBe(1)
  })

  it('blocked → push 要问成员的问题,链就此停', async () => {
    await store.create({ taskId: 'job', userId: 'alice', objective: '订酒店' })
    const pushes: string[] = []
    const provider = new ScriptProvider([
      toolTurn({ id: 'c1', name: 'block_longrun_task', input: { task_id: 'job', question: '预算上限是多少?' } }),
      textTurn('等成员'),
    ])
    const agent = buildAgent({ provider, store, pushes, benign: segmentSimToolset(store) })

    const res = (await agent.onTask(segTask('t1', 'job'))) as { kind: string }
    expect(res.kind).toBe('ok')
    expect(pushes[0]).toContain('需要你的输入才能继续')
    expect(pushes[0]).toContain('预算上限是多少?')
  })

  it('预算耗尽:先标 winding_down 再接力一次;收尾段模型仍不 complete → 强制部分交付', async () => {
    await store.create({ taskId: 'job', userId: 'alice', objective: '爬完全部页面', tokenBudget: 100 })
    const pushes: string[] = []
    const provider = new ScriptProvider([
      textTurn('这段烧了很多 token', { inputTokens: 200, outputTokens: 50 }),
      textTurn('只完成了一半'),
    ])
    const agent = buildAgent({ provider, store, pushes })

    // 段 1:250 token > 100 预算 → wind_down 裁决(标记 + 再接力一次)。
    const park = await expectPark(agent.onTask(segTask('t1', 'job')))
    expect(readLongRunRelayState(park.state)).toBe('job')
    let loaded = await store.load('job')
    if (loaded.kind !== 'ok') throw new Error('dossier gone')
    expect(loaded.dossier.status).toBe('winding_down')

    // 唤醒 = 收尾段:提示词换收尾形态,模型只出文本 → 强制诚实部分交付。
    const res = (await agent.onResume(segTask('t2', 'job'), longRunRelayState('job'))) as { kind: string }
    expect(res.kind).toBe('ok')
    const windPrompt = provider.requests[1]!.messages[0]!.content as string
    expect(windPrompt).toContain('【长期任务 · 收尾段】')
    expect(windPrompt).toContain('超限项: token 预算')

    loaded = await store.load('job')
    if (loaded.kind !== 'ok') throw new Error('dossier gone')
    expect(loaded.dossier.status).toBe('done')
    expect(loaded.dossier.doneSummary).toContain('(预算用尽,自动收尾)')
    expect(loaded.dossier.doneSummary).toContain('只完成了一半')
    expect(pushes.at(-1)).toContain('预算用尽,已收尾(部分交付)')
  })
})

// ── ③ 段中 governed park 与取消赢过批准 ──────────────────────────────────

describe('LONG-M2 驱动器 — 段中治理挂起', () => {
  it('governed park:花费先入账段数不加;批准续跑后段末只记增量再接力', async () => {
    await store.create({ taskId: 'job', userId: 'alice', objective: '清理旧 agent' })
    const exec: string[] = []
    const provider = new ScriptProvider([
      toolTurn({ id: 'c1', name: 'delete_agent', input: { handle: 'mailer' } }, { inputTokens: 80, outputTokens: 20 }),
      textTurn('清完了', { inputTokens: 40, outputTokens: 20 }),
    ])
    const agent = buildAgent({ provider, store, governed: governedToolset(exec) })

    const t = segTask('t1', 'job')
    const gatePark = await expectPark(agent.onTask(t))
    // 段中 park 带的是治理闸状态(对话打包),不是接力状态。
    expect(readLongRunRelayState(gatePark.state)).toBeNull()
    expect(readButlerGateState(gatePark.state)).not.toBeNull()
    let loaded = await store.load('job')
    if (loaded.kind !== 'ok') throw new Error('dossier gone')
    expect(loaded.dossier.segments).toBe(0) // 段没结束,段数不加
    expect(loaded.dossier.budget.tokensUsed).toBe(100) // park 前的花费已入账
    expect(loaded.dossier.interrupted).toBe(true) // 已 arm、未 settle
    expect(exec).toEqual([]) // 批准前零副作用

    // 批准续跑 → 执行动作 → 段末结账(只记第二半,不重复计 park 前那份)→ 接力。
    const relayPark = await expectPark(
      agent.onResume(t, { ...(gatePark.state as object), answer: { approved: true } }),
    )
    expect(readLongRunRelayState(relayPark.state)).toBe('job')
    expect(exec).toEqual(['delete:mailer'])
    loaded = await store.load('job')
    if (loaded.kind !== 'ok') throw new Error('dossier gone')
    expect(loaded.dossier.segments).toBe(1)
    expect(loaded.dossier.budget.tokensUsed).toBe(160)
    expect(loaded.dossier.interrupted).toBe(false)
  })

  it('批准落地前成员取消 → 批准的动作一步不执行(取消赢过批准)', async () => {
    await store.create({ taskId: 'job', userId: 'alice', objective: '清理旧 agent' })
    const exec: string[] = []
    const provider = new ScriptProvider([
      toolTurn({ id: 'c1', name: 'delete_agent', input: { handle: 'mailer' } }),
      textTurn('清完了'),
    ])
    const agent = buildAgent({ provider, store, governed: governedToolset(exec) })

    const t = segTask('t1', 'job')
    const gatePark = await expectPark(agent.onTask(t))
    await store.mutate('job', (d) => {
      d.status = 'cancelled'
    })

    const res = (await agent.onResume(t, { ...(gatePark.state as object), answer: { approved: true } })) as {
      kind: string
      output?: { text?: string }
    }
    expect(res.kind).toBe('ok')
    expect(res.output?.text).toContain('已取消')
    expect(res.output?.text).toContain('批准前任务已收束,这次批准的动作没有执行')
    expect(exec).toEqual([]) // 这条是这个测试存在的理由
  })

  it('接力睡眠中被取消 → 下次唤醒安静收束,零模型调用', async () => {
    await store.create({ taskId: 'job', userId: 'alice', objective: '整理发票' })
    const provider = new ScriptProvider([textTurn('第一段')])
    const agent = buildAgent({ provider, store })

    await expectPark(agent.onTask(segTask('t1', 'job')))
    expect(provider.requests).toHaveLength(1)
    await store.mutate('job', (d) => {
      d.status = 'cancelled'
    })

    const res = (await agent.onResume(segTask('t2', 'job'), longRunRelayState('job'))) as {
      kind: string
      output?: { text?: string }
    }
    expect(res.kind).toBe('ok')
    expect(res.output?.text).toContain('已取消,本段不再执行')
    expect(provider.requests).toHaveLength(1) // 终态守卫在模型调用之前
  })
})

// ── ④ 崩溃诚实 + ⚠ 中断行 ────────────────────────────────────────────────

describe('LONG-M2 驱动器 — 崩溃与中断可见性', () => {
  it('段执行抛错:失败日志 + push + 任务结果 failed;下次唤醒提示带 ⚠,干净收尾后清掉', async () => {
    await store.create({ taskId: 'job', userId: 'alice', objective: '整理发票' })
    const pushes: string[] = []
    const provider = new ExplodeOnceProvider()
    const agent = buildAgent({ provider, store, pushes })

    const failed = (await agent.onTask(segTask('t1', 'job'))) as { kind: string; error?: string }
    expect(failed.kind).toBe('failed')
    expect(String(failed.error)).toContain('provider exploded')
    expect(pushes[0]).toContain('本段执行失败,后台接力就此停止')
    const tail = await store.readJournalTail('job')
    expect(tail[0]!.did).toContain('(段执行失败,接力停止)')
    expect(tail[0]!.did).toContain('provider exploded')
    let loaded = await store.load('job')
    if (loaded.kind !== 'ok') throw new Error('dossier gone')
    expect(loaded.dossier.interrupted).toBe(true) // 已 arm、从未 settle → 崩溃可见
    expect(loaded.dossier.segments).toBe(0)

    // 手动再派一段(重启后的重新开跑):提示词必须把中断说出来。
    await expectPark(agent.onTask(segTask('t2', 'job')))
    const wakePrompt = provider.requests[1]!.messages[0]!.content as string
    expect(wakePrompt).toContain('⚠ 上一段没有正常收尾')
    loaded = await store.load('job')
    if (loaded.kind !== 'ok') throw new Error('dossier gone')
    expect(loaded.dossier.interrupted).toBe(false) // 干净收尾清旗
  })

  it('标记任务但没接驱动器 → 诚实拒绝,零模型调用,档案不动', async () => {
    await store.create({ taskId: 'job', userId: 'alice', objective: '整理发票' })
    const provider = new ScriptProvider([textTurn('不该被调')])
    const agent = buildAgent({ provider, store, noDriver: true })

    const res = (await agent.onTask(segTask('t1', 'job'))) as { kind: string; output?: { text?: string } }
    expect(res.kind).toBe('ok')
    expect(res.output?.text).toContain('没有接长期任务驱动器')
    expect(provider.requests).toHaveLength(0)
    const loaded = await store.load('job')
    if (loaded.kind !== 'ok') throw new Error('dossier gone')
    expect(loaded.dossier.segments).toBe(0)
  })
})

// ── ⑤ 段中途子活落地不被吞(lastRenderSettled 记账) ───────────────────────

describe('LONG-M2 驱动器 — 子结果段末记账', () => {
  it('子活在段中途落地 → 段末只记到渲染时刻快照,下次唤醒仍渲染「新结果」', async () => {
    await store.create({ taskId: 'job', userId: 'alice', objective: '查三地天气' })
    await store.mutate('job', (d) => {
      d.children.push({ id: 'c1', summary: '查吉隆坡天气', status: 'pending' })
      d.nextChildId = 2
    })
    const provider = new ScriptProvider([
      // 段 1:渲染时 c1 还 pending(renderedSettled=0),段中途它落地。
      toolTurn({ id: 's1', name: 'settle_child', input: { task_id: 'job', result: '晴,33 度' } }),
      textTurn('派活出去了'),
      // 段 2(唤醒):读到新结果,正常收段。
      textTurn('消化了子结果'),
    ])
    const agent = buildAgent({ provider, store, benign: segmentSimToolset(store) })

    await expectPark(agent.onTask(segTask('t1', 'job')))
    let loaded = await store.load('job')
    if (loaded.kind !== 'ok') throw new Error('dossier gone')
    // 段末记账吃的是渲染时刻快照(0),不是重数(1)——中途落地的结果保持未读。
    expect(loaded.dossier.childResultsSeen).toBe(0)
    expect(loaded.dossier.lastRenderSettled).toBe(0)

    await expectPark(agent.onResume(segTask('t2', 'job'), longRunRelayState('job')))
    const wakePrompt = provider.requests.at(-1)!.messages[0]!.content as string
    expect(wakePrompt).toContain('查吉隆坡天气')
    expect(wakePrompt).toContain('晴,33 度')
    expect(wakePrompt).toContain('(有 1 条新结果还没消化——先读它们。)')

    loaded = await store.load('job')
    if (loaded.kind !== 'ok') throw new Error('dossier gone')
    // 这次渲染真的把结果给模型看了 → 段末记账推进到 1。
    expect(loaded.dossier.childResultsSeen).toBe(1)
  })
})

// ── ⑥ M3 子活通道:一回合 turn,花费入父账,不是段 ─────────────────────────

describe('LONG-M3 驱动器 — 子活通道', () => {
  it('子活 turn = 普通一回合:回复原样返回;token+活跃秒计入父档案预算;段数不动、零日志、不接力', async () => {
    await store.create({ taskId: 'job', userId: 'alice', objective: '查三地签证' })
    const provider = new ScriptProvider(
      [
        textTurn('吉隆坡签证:免签 30 天', {
          inputTokens: 100,
          outputTokens: 30,
          cacheCreationTokens: 15,
          cacheReadTokens: 5,
        }),
      ],
      () => {
        nowMs += 90_000
      },
    )
    const agent = buildAgent({ provider, store })

    const res = (await agent.onTask(childTask('ct1', 'job', '查吉隆坡的签证政策,给要点'))) as {
      kind: string
      output?: { text?: string }
    }
    expect(res.kind).toBe('ok')
    expect(res.output?.text).toContain('吉隆坡签证')
    // 子活的全部输入 = spawn 写的自包含任务书,不是档案渲染。
    expect(provider.requests[0]!.messages[0]!.content as string).toContain('查吉隆坡的签证政策')

    const loaded = await store.load('job')
    if (loaded.kind !== 'ok') throw new Error('dossier gone')
    expect(loaded.dossier.budget.tokensUsed).toBe(150) // 四维求和入父账(预算一等公民)
    expect(loaded.dossier.budget.timeUsedSec).toBe(90) // 活跃墙钟入父账
    expect(loaded.dossier.segments).toBe(0) // 子活不是段
    expect(await store.readJournalTail('job')).toHaveLength(0) // 不落段日志
  })

  it('子活不进 episodic 记忆(对照:普通聊天在同一台 agent 上照常捕获)', async () => {
    await store.create({ taskId: 'job', userId: 'alice', objective: '查签证' })
    const mem = emptyMemory()
    const provider = new ScriptProvider([textTurn('好的,记住了'), textTurn('子活跑完了')])
    const agent = new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory: mem,
      system: '人设',
      captureTurns: true,
      longRun: { store, now },
    })

    // 对照腿:先证捕获路径活着,否则「子活零捕获」可能空洞地真。
    await agent.onTask({
      id: 'n1',
      from: 'user:alice',
      strategy: { kind: 'explicit', to: 'butler' },
      payload: { prompt: '你好' },
    })
    const afterChat = (await mem.list()).length
    expect(afterChat).toBeGreaterThan(0)

    // 子活腿:同一台 agent、同一份记忆——列表长度一字不动。
    await agent.onTask(childTask('ct1', 'job', '查吉隆坡签证'))
    expect((await mem.list()).length).toBe(afterChat)
  })

  it('子活里 governed park:park 前花费先入父账;批准续跑走子活通道重计增量,动作照执行', async () => {
    await store.create({ taskId: 'job', userId: 'alice', objective: '清理旧 agent' })
    const exec: string[] = []
    const provider = new ScriptProvider([
      toolTurn({ id: 'c1', name: 'delete_agent', input: { handle: 'mailer' } }, { inputTokens: 80, outputTokens: 20 }),
      textTurn('删完了', { inputTokens: 40, outputTokens: 20 }),
    ])
    const agent = buildAgent({ provider, store, governed: governedToolset(exec) })

    const t = childTask('ct1', 'job', '把 mailer 这个旧 agent 清掉')
    const gatePark = await expectPark(agent.onTask(t))
    expect(readLongRunRelayState(gatePark.state)).toBeNull() // 子活不接力
    expect(readButlerGateState(gatePark.state)).not.toBeNull()
    let loaded = await store.load('job')
    if (loaded.kind !== 'ok') throw new Error('dossier gone')
    expect(loaded.dossier.budget.tokensUsed).toBe(100) // park 前的花费已入父账
    expect(loaded.dossier.segments).toBe(0)
    expect(loaded.dossier.interrupted).toBe(false) // 段的中断标记从不被子活碰
    expect(exec).toEqual([]) // 批准前零副作用

    const res = (await agent.onResume(t, { ...(gatePark.state as object), answer: { approved: true } })) as {
      kind: string
      output?: { text?: string }
    }
    expect(res.kind).toBe('ok')
    expect(res.output?.text).toContain('删完了')
    expect(exec).toEqual(['delete:mailer'])
    loaded = await store.load('job')
    if (loaded.kind !== 'ok') throw new Error('dossier gone')
    expect(loaded.dossier.budget.tokensUsed).toBe(160) // 两半相加,不重复计
  })

  it('没接驱动器 → 子活标记惰性当普通聊天;垃圾 resume 状态 → 从任务书重跑而非普通聊天恢复', async () => {
    // 没接驱动器:标记不劫持(对照段任务的诚实拒绝——子活自包含,无档可拒)。
    const p1 = new ScriptProvider([textTurn('普通回复')])
    const inert = buildAgent({ provider: p1, store, noDriver: true })
    const r1 = (await inert.onTask(childTask('ct1', 'job', '查签证'))) as {
      kind: string
      output?: { text?: string }
    }
    expect(r1.kind).toBe('ok')
    expect(r1.output?.text).toContain('普通回复')

    // 垃圾 resume 状态(既非接力也非治理闸)→ 子活通道从 payload 任务书重跑。
    await store.create({ taskId: 'job', userId: 'alice', objective: '查签证' })
    const p2 = new ScriptProvider([textTurn('重跑的回答')])
    const agent = buildAgent({ provider: p2, store })
    const r2 = (await agent.onResume(childTask('ct2', 'job', '重新查吉隆坡签证'), 'garbage-state')) as {
      kind: string
      output?: { text?: string }
    }
    expect(r2.kind).toBe('ok')
    expect(r2.output?.text).toContain('重跑的回答')
    expect(p2.requests[0]!.messages[0]!.content as string).toContain('重新查吉隆坡签证')
  })
})
