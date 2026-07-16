/**
 * AFR-M3 防腐门 — 真 `buildButlerFactory` 拼两种脸,与 butler-tool-tiers.ts
 * 名单双向核对(镜像 env-registry 门:加工具不登记就红)。
 *
 * 四道断言:
 *   ① 两层脸 = 一等名单 + list_tool_directory/use_tool;目录名单一个不上脸;
 *      governed 6 + memory 5 全在一等(边界②风险面不折叠)。
 *   ② 目录 ∪ 一等 = 全集:单层逃生阀脸上的 benign 名字集合 ≡ 名单两表之并
 *      (新增 benign 工具漏登记 → 集合不等 → 红);目录渲染真含全部长尾名。
 *   ③ 指路不指空:留在脸上的每个工具(两把门自身除外)schema 序列化里不得
 *      出现任何目录工具名 —— 一等描述点名目录工具 = 模型直调必空。
 *   ④ 能力不减端到端:目录里的 set_reply_language 经 use_tool 真执行,
 *      偏好文件真落盘;B1 能力清单仍是平铺全集(目录化不改「能干什么」)。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Hub, Logger, ParticipantId, Task } from '@gotong/core'
import type { LlmProvider, LlmRequest, LlmStreamChunk, LlmToolDefinition } from '@gotong/llm'

import { buildButlerFactory, type ButlerFactoryRefs } from '../src/personal-butler-factory.js'
import {
  BUTLER_DIRECTORY_BENIGN,
  BUTLER_FIRST_CLASS_BENIGN,
} from '../src/butler-tool-tiers.js'
import { estimateTokens } from '../src/butler-toolface-report.js'

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silentLogger
  },
}

/** 上下文型 cast:builder 构造只存引用,listTools 全静态,面测试永不真调 surface。 */
function stub<T>(v: unknown = {}): T {
  return v as T
}

/** 全部 surface 都「接了」的 refs — 逼出最大 butler 自有工具面。 */
function fullRefs(): ButlerFactoryRefs {
  return {
    governedAgents: stub(),
    workflowEditor: stub(),
    workflowCreate: stub(),
    workflows: stub(),
    observeRuns: stub(),
    observeAgents: stub(),
    observeUsage: stub(),
    diagnoseOwned: stub(),
    diagnoseAdapt: stub(),
    askRoster: stub(),
    peerRoster: stub(),
    llmRoster: stub(),
    // 探针专用(不产工具);stub 空对象会在任务期被真调,置 undefined 免误炸。
    pendingInbox: undefined,
    wizard: stub(),
    providerBuilder: async () => null,
    memoryView: stub(),
  }
}

/**
 * 计划驱动的脚本 provider:每次调用先记录工具面与消息,再按队列吐 tool_use;
 * 队列空则收尾。tool_result 的正文通过 messages 序列化捕获(目录渲染断言用)。
 */
class TierScriptProvider implements LlmProvider {
  readonly name = 'tier-gate-script'
  readonly faces: LlmToolDefinition[][] = []
  readonly toolResults: string[] = []
  messagesDump = ''

  constructor(private readonly plan: Array<{ name: string; input: Record<string, unknown> }>) {}

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.faces.push([...(req.tools ?? [])])
    this.messagesDump += JSON.stringify(req.messages)
    for (const m of req.messages) {
      if (!Array.isArray(m.content)) continue
      for (const b of m.content) {
        if ((b as { type?: string }).type === 'tool_result') {
          this.toolResults.push(JSON.stringify((b as { content?: unknown }).content))
        }
      }
    }
    const next = this.plan.shift()
    if (next) {
      yield {
        type: 'tool_use',
        toolUse: { type: 'tool_use', id: `call-${this.plan.length}`, name: next.name, input: next.input },
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }
    yield { type: 'text', text: '好的。' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

const task = (id: string, userId: string, payload: string): Task => ({
  id: id as Task['id'],
  from: `user:${userId}` as Task['from'],
  strategy: { kind: 'explicit', to: 'atong' as ParticipantId },
  payload,
  origin: { orgId: 'local', userId },
  createdAt: 1,
})

// AFR-M7 — 恢复层 ops 假件:listTools 全静态,面测试只看名字不真打包。
const fakeBackupOps = {
  lastBackup: () => null,
  newPeersSince: () => 0,
  privileged: () => true,
  pack: async () => ({ code: 0, lines: [] }),
}

function buildButler(provider: LlmProvider, root: string, singleTier?: boolean) {
  const factory = buildButlerFactory({
    hub: stub<Hub>({ dispatch: async () => ({ kind: 'ok' }) }),
    logger: silentLogger,
    memoryRoot: join(root, 'memory'),
    governedOn: true,
    maintenanceOn: true,
    proactiveOn: true,
    runBroadcastOn: true,
    refs: fullRefs,
    onboarding: {
      stateFile: join(root, 'onboarding-state.json'),
      health: () => undefined,
      keyCheck: () => undefined,
      lang: 'zh',
    },
    ...(singleTier === undefined ? {} : { singleTierToolFace: singleTier }),
    backupOps: fakeBackupOps,
  })
  return factory({
    id: 'atong' as ParticipantId,
    provider,
    capabilities: ['chat'],
    system: '你是这位成员的管家。',
  })
}

const GOVERNED_TOOLS = [
  'create_agent',
  'edit_agent',
  'delete_agent',
  'edit_workflow',
  'create_workflow',
  'ask_peer',
  'pack_backup',
] as const
const MEMORY_TOOLS = ['remember', 'remember_procedure', 'refine_procedure', 'recall', 'forget'] as const

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gotong-tool-tiers-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('AFR-M3 — 工具面分层名单防腐门(真工厂)', () => {
  it('两层脸:一等名单全在 + 两把门在 + 目录名单零上脸 + governed/memory 全一等', async () => {
    const provider = new TierScriptProvider([
      { name: 'list_tool_directory', input: {} },
      { name: 'use_tool', input: { name: 'set_reply_language', args: { language: '中文' } } },
    ])
    const butler = buildButler(provider, root)
    const r = await butler.onTask(task('t1', 'u1', '看看你有什么工具。'))
    expect((r as { kind: string }).kind).toBe('ok')

    const face = provider.faces[0]!.map((t) => t.name)
    for (const name of BUTLER_FIRST_CLASS_BENIGN) expect(face).toContain(name)
    for (const name of GOVERNED_TOOLS) expect(face).toContain(name)
    for (const name of MEMORY_TOOLS) expect(face).toContain(name)
    expect(face).toContain('list_tool_directory')
    expect(face).toContain('use_tool')
    for (const name of BUTLER_DIRECTORY_BENIGN) expect(face).not.toContain(name)

    // 目录 ∪ 一等 = 全集(端到端半边):目录渲染真列出每个长尾名 + 总数如实。
    expect(provider.messagesDump).toContain(`工具目录(共 ${BUTLER_DIRECTORY_BENIGN.length} 个`)
    for (const name of BUTLER_DIRECTORY_BENIGN) expect(provider.messagesDump).toContain(name)

    // 能力不减端到端:目录里的 set_reply_language 经 use_tool 真执行、真落盘。
    const files = readdirSync(root, { recursive: true }) as string[]
    expect(files.some((f) => String(f).endsWith('reply-language.json'))).toBe(true)
  })

  it('单层逃生阀:全集直接上脸,无两把门;benign 名字集合 ≡ 名单之并(登记门)', async () => {
    const provider = new TierScriptProvider([])
    const butler = buildButler(provider, root, true)
    const r = await butler.onTask(task('t2', 'u2', '你好。'))
    expect((r as { kind: string }).kind).toBe('ok')

    const face = provider.faces[0]!.map((t) => t.name)
    expect(face).not.toContain('list_tool_directory')
    expect(face).not.toContain('use_tool')

    // 登记门:脸上扣掉 governed/memory 后的 benign 名字 ≡ 一等 ∪ 目录(双向)。
    // 往任何 builder 新增 benign 工具而不在 butler-tool-tiers.ts 登记 → 这里红。
    const nonBenign = new Set<string>([...GOVERNED_TOOLS, ...MEMORY_TOOLS])
    const faceBenign = new Set(face.filter((n) => !nonBenign.has(n)))
    const registry = new Set<string>([...BUTLER_FIRST_CLASS_BENIGN, ...BUTLER_DIRECTORY_BENIGN])
    expect([...faceBenign].sort()).toEqual([...registry].sort())
  })

  it('指路不指空:留在脸上的工具 schema 不得点名任何目录工具(两把门除外)', async () => {
    const provider = new TierScriptProvider([])
    const butler = buildButler(provider, root)
    await butler.onTask(task('t3', 'u3', '你好。'))

    const doors = new Set(['list_tool_directory', 'use_tool'])
    for (const def of provider.faces[0]!) {
      if (doors.has(def.name)) continue
      const wire = JSON.stringify(def)
      for (const name of BUTLER_DIRECTORY_BENIGN) {
        expect(wire, `${def.name} 的 schema 点名了目录工具 ${name}(模型会直调落空:要么把 ${name} 提回一等,要么改写这句指路)`).not.toContain(name)
      }
    }
  })

  it('B1 能力清单两层/单层逐字节一致:目录化不改「能干什么」', async () => {
    // B1 是策展话术目录(按信号工具挑条目,不印原始名)—— 最强的门是两种脸下
    // 渲染逐字节相同:能力清单从 benignFlat(拆层前全集)派生,与目录化无关。
    const two = new TierScriptProvider([{ name: 'list_my_capabilities', input: {} }])
    const r1 = await buildButler(two, root).onTask(task('t4', 'u4', '你能帮我做什么?'))
    expect((r1 as { kind: string }).kind).toBe('ok')
    const single = new TierScriptProvider([{ name: 'list_my_capabilities', input: {} }])
    const r2 = await buildButler(single, join(root, 'b1'), true).onTask(
      task('t4b', 'u4', '你能帮我做什么?'),
    )
    expect((r2 as { kind: string }).kind).toBe('ok')
    expect(two.toolResults[0]).toBeDefined()
    expect(two.toolResults[0]).toBe(single.toolResults[0])
    // 目录侧能力(set_daily_brief 的信号条目)仍在清单里 —— 防「两边都丢」假阳性。
    expect(two.toolResults[0]).toContain('简报')
  })

  it('账本:两层 vs 单层的 schema token 前后对比(M1 同一把尺)', async () => {
    const two = new TierScriptProvider([])
    await buildButler(two, root).onTask(task('t5', 'u5', '你好。'))
    const single = new TierScriptProvider([])
    await buildButler(single, join(root, 'b'), true).onTask(task('t6', 'u6', '你好。'))

    const tokens = (defs: LlmToolDefinition[]) =>
      defs.reduce(
        (sum, t) =>
          sum +
          estimateTokens(
            JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema }),
          ),
        0,
      )
    const before = tokens(single.faces[0]!)
    const after = tokens(two.faces[0]!)
    expect(after).toBeLessThan(before)
    // eslint-disable-next-line no-console
    console.log(
      `[AFR-M3] 每轮工具面 schema:单层 ${single.faces[0]!.length} 工具 ~${before}tk → 两层 ${two.faces[0]!.length} 工具 ~${after}tk(省 ~${before - after}tk,-${Math.round(((before - after) / before) * 100)}%)`,
    )
  })
})
