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
 *   ⑤ 轮数够用:工厂造的管家真能跑完 >8 轮的事务 —— 两层脸让「查目录」也
 *      占一轮,LlmAgent 的通用默认 8 是按单层脸切的,不抬就会在正常事务
 *      中途 abort。守的是构造点那行 maxToolRounds 不被删、不被挪到
 *      `...rest` 之前。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Hub, Logger, ParticipantId, Task } from '@gotong/core'
import type { LlmProvider, LlmRequest, LlmStreamChunk, LlmToolDefinition } from '@gotong/llm'
import { BUTLER_MAX_TOOL_ROUNDS } from '@gotong/personal-butler'

import { buildButlerFactory, type ButlerFactoryRefs } from '../src/personal-butler-factory.js'
import {
  BUTLER_DIRECTORY_BENIGN,
  BUTLER_FIRST_CLASS_BENIGN,
} from '../src/butler-tool-tiers.js'
import { estimateTokens } from '../src/butler-toolface-report.js'
import { IM_APPROVABLE_TOOLS } from '../src/personal-butler-escalation.js'

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
    memberPush: undefined, // push 是投递增强非注册条件 — 面测试无需它
    peerRoster: stub(),
    llmRoster: stub(),
    schedules: stub(),
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

/**
 * HANDS-M2 四态:'armed'(默认,最大脸)/ 'off'(dep 在但未装 = 监狱缺席或 hands.json
 * 缺席)/ 'absent'(老 main.ts 根本不传)/ 'no-role'(手装上了,但**这个成员**不在
 * `allowRoles` 里 —— 手是 hub 级的,「谁有手」是每个人各自的答案)。
 */
type HandsMode = 'armed' | 'off' | 'absent' | 'no-role'

function buildButler(provider: LlmProvider, root: string, singleTier?: boolean, handsMode: HandsMode = 'armed') {
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
    // HANDS-M3c — 最大脸必须带配置写面,set_hub_config 才在(读写全是假件,不碰盘)。
    configOps: {
      privileged: () => true,
      knobs: async () => [],
      set: async () => ({ lines: [] }),
      // 只被脱敏用;这条脸测试不跑 execute,值是什么不影响任何断言。
      spaceDir: '/fake/space',
    },
    members: { users: () => [], membershipRole: () => null },
    // STOR-M3 — 最大脸必须带保留策略 ops,set_retention 才在(全假件不碰盘;
    // key 是 3 键闭集 enum、值有界、零自由文本——参数空间封闭正是它能上 IM 名单的理由)。
    retentionOps: {
      privileged: () => true,
      current: async () => null,
      write: async () => ({}),
    },
    // HEAL-M1 — 最大脸必须带自愈台账切片,restart_history 才在(surface 缺席由工具自答「未接入」)。
    selfHeal: () => undefined,
    // STOR-M1 — 最大脸必须带账本路径,space_report 才在。文件不存在 = 读者答
    // null = 工具如实「还没量过」——工具在不在只看路径接没接,不看账本写没写。
    spaceLedgerFile: join(root, 'runtime', 'space-ledger.json'),
    // HANDS-M2 — 最大脸必须带 armed 的手,五个 hands_* governed 工具才在;
    // 构造零副作用(工作区懒建),这里的宿主目录不会被真碰。
    ...(handsMode === 'armed' || handsMode === 'no-role'
      ? {
          hands: {
            host: {
              spaceRoot: root,
              handsRoot: join(root, 'butler', 'hands'),
              kind: 'sandbox-exec' as const,
              config: {
                maxRunSec: 120,
                maxOutputBytes: 32 * 1024,
                maxWorkspaceBytes: 512 * 1024 * 1024,
                allowRoles: ['owner', 'admin'],
              },
              // 「谁有手」——工具面按 spawn 那一刻的答案决定发不发这五件。
              allowed: () => handsMode === 'armed',
              logger: silentLogger,
            },
            status: { armed: true as const, kind: 'sandbox-exec' as const },
          },
        }
      : handsMode === 'off'
        ? { hands: { status: { armed: false as const, reason: '监狱缺席:test' } } }
        : {}),
    // SDUI-M4 — 最大脸必须带面板店面,get_my_panel / set_panel_layout 才在。
    panel: {
      panel: async () => ({ schemaVersion: 1, config: {}, source: 'default' as const }),
      listLibrary: async () => [],
      setPanel: async () => ({}),
      applyLibrary: async () => ({}),
      resetPanel: async () => undefined,
      restoreSnapshot: async () => ({}),
      listContent: async () => [],
      readContent: async () => null,
      writeContent: async () => undefined,
    },
  })
  return factory(
    {
      id: 'atong' as ParticipantId,
      provider,
      capabilities: ['chat'],
      system: '你是这位成员的管家。',
    },
    undefined,
    // DUO-M2 — 全开姿态:配了 escalateTo 才有 escalate_to_expert,最大脸必须配。
    { escalateTo: 'expert-x' },
  )
}

const GOVERNED_TOOLS = [
  'create_agent',
  'edit_agent',
  'delete_agent',
  'edit_workflow',
  'create_workflow',
  'ask_peer',
  'pack_backup',
  // HANDS-M2 手 A 五件:governed 一等(服务端 classify 定档),永不进目录层。
  'hands_run',
  'hands_write',
  'hands_read',
  'hands_list',
  'hands_rm',
  // HANDS-M3c — 基础设置写(tier 2 每次 park);参数空间封闭 ⇒ 在 IM 可批名单上。
  'set_hub_config',
  // STOR-M3 — 内容保留策略写(每次 park);与 set_hub_config 同款封闭参数空间
  // (key 是 3 键闭集 enum,值有界 30-3650,零自由文本)⇒ 同在 IM 可批名单上。
  'set_retention',
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

  it('HANDS-M2 缺席字节不变:hands dep 不传 / 未 armed → 脸上零 hands_* 名字,其余脸不变', async () => {
    const HANDS = GOVERNED_TOOLS.filter((n) => n.startsWith('hands_'))
    expect(HANDS).toHaveLength(5)
    const faces: string[][] = []
    // 'no-role' 与前两态给模型看的脸**必须一样**:手装在 hub 上,但这个成员没有。
    // 发五件永远拒绝他的工具既费 schema token,读起来也像个 bug。
    for (const mode of ['absent', 'off', 'no-role'] as const) {
      const provider = new TierScriptProvider([])
      const butler = buildButler(provider, root, undefined, mode)
      const r = await butler.onTask(task(`t-${mode}`, `u-${mode}`, '你好。'))
      expect((r as { kind: string }).kind).toBe('ok')
      const face = provider.faces[0]!.map((t) => t.name)
      for (const name of HANDS) expect(face, mode).not.toContain(name)
      faces.push(face.slice().sort())
    }
    // 老 main.ts(不传)、未装、装了但这人没手 —— 三种姿态的脸逐字节一样。
    expect(faces[0]).toEqual(faces[1])
    expect(faces[0]).toEqual(faces[2])
    // 且 = armed 脸减去恰好那五件(手不装不多不少)。
    const armed = new TierScriptProvider([])
    await buildButler(armed, root).onTask(task('t-armed', 'u-armed', '你好。'))
    const armedFace = armed.faces[0]!.map((t) => t.name).filter((n) => !n.startsWith('hands_')).sort()
    expect(faces[0]).toEqual(armedFace)
  })

  it('HANDS-M2 「手」那行是说给这个人听的:装着但没开给他 ⇒ my_status 说实话,不许一个兑现不了的承诺', async () => {
    const mine = new TierScriptProvider([{ name: 'my_status', input: {} }])
    await buildButler(mine, root, true, 'no-role').onTask(task('t-mine', 'u-mine', '你还好吗?'))
    const said = mine.toolResults.join('')
    expect(said).toContain('手装着,但没开给你')
    expect(said).toContain('owner/admin')
    // 「已装,工作区里写/读/跑」是有手的人才看得到的那句。
    expect(said).not.toContain('工作区里写/读/跑')
    // 对照:有手的人看到的就是那句。
    const his = new TierScriptProvider([{ name: 'my_status', input: {} }])
    await buildButler(his, root, true, 'armed').onTask(task('t-his', 'u-his', '你还好吗?'))
    expect(his.toolResults.join('')).toContain('工作区里写/读/跑')
  })

  it('IMA 名单双向核对:每个 governed 工具恰好落在「IM 可批」或「网页 only」一侧', async () => {
    // Codex 九轮 H1 —— `imApprovable` 原本是**排除法**(不是 ask_peer、名字没有
    // `__` 就放行),那条纪律管住了新的写入方、管不住新的工具族:HANDS-M2 一次挂
    // 上五件 `hands_*`,一个字没改就全落进了「手机可批」一侧。
    //
    // 这道门要的是**表态**:新增一个 governed 工具,它必须出现在下面两张名单之一,
    // 否则这里红。名单不是「文档说了什么」,是从真工厂拼出来的脸上量的。
    const WEB_ONLY_TOOLS = [
      'ask_peer', // 跨 hub 出网
      'pack_backup', // 身份档含 hub 签名钥 = 凭证级
      'hands_run', // 五件手部动作:一行 IM 读不全(argv/stdin 远超 80 码点预算)
      'hands_write',
      'hands_read',
      'hands_list',
      'hands_rm',
    ] as const

    const provider = new TierScriptProvider([])
    await buildButler(provider, root).onTask(task('t-ima', 'u-ima', '你好。'))
    const face = new Set(provider.faces[0]!.map((t) => t.name))

    // ① 名单里的名字都真的在脸上(死条目 / 拼错 → 红)。
    for (const name of IM_APPROVABLE_TOOLS) {
      expect(face.has(name), `${name} 在 IM 可批名单上,却不在真实工具面上`).toBe(true)
    }
    for (const name of WEB_ONLY_TOOLS) {
      expect(face.has(name), `${name} 在网页 only 名单上,却不在真实工具面上`).toBe(true)
    }
    // ② benign 工具不得混进 IM 名单(名单只对 governed 动作有意义)。
    for (const name of IM_APPROVABLE_TOOLS) {
      expect(GOVERNED_TOOLS as readonly string[], `${name} 不是 governed 工具`).toContain(name)
    }
    // ③ 每个 governed 工具恰好被表态一次:并集覆盖全集、交集为空。
    const imSide = [...IM_APPROVABLE_TOOLS].sort()
    const webSide = [...WEB_ONLY_TOOLS].sort()
    expect(imSide.filter((n) => webSide.includes(n))).toEqual([])
    expect([...imSide, ...webSide].sort()).toEqual([...GOVERNED_TOOLS].sort())
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

describe('⑤ 轮数够用 — 工厂造的管家跑得完深事务', () => {
  /**
   * 12 轮长度按最坏情况取:两层脸下一趟像样的差事(查目录 → 取日历 → 读知识
   * 文件 → 起草 → 再查一处 → 改)轻松过 8,而撞顶不是优雅降级 —— 整个差事
   * 当场 abort,什么都不交付。全用 `list_tool_directory`(纯渲染、幂等、无
   * 副作用)凑轮数:这里要证的是轮数预算,不是某个工具的行为。
   */
  const DEEP_PLAN = Array.from({ length: 12 }, () => ({ name: 'list_tool_directory', input: {} }))

  it('12 轮事务跑到底,不在半路 abort', async () => {
    const provider = new TierScriptProvider(DEEP_PLAN)
    const r = await buildButler(provider, root).onTask(task('t7', 'u7', '办件复杂的事。'))

    expect((r as { kind: string }).kind).toBe('ok')
    // 撞顶的症状是回复正文变成 `[butler: aborted after N tool-use rounds]`。
    expect(JSON.stringify(r)).not.toContain('aborted after')
    // 12 个工具轮 + 1 个收尾轮 = 13 次 provider 调用:计划一条没被砍。
    expect(provider.faces.length).toBe(13)
  })

  it('上限本身还在(不是拆了保险丝)', async () => {
    // 远超上限的计划仍必须被拦下 —— 抬高 ≠ 取消。
    const provider = new TierScriptProvider(
      Array.from({ length: BUTLER_MAX_TOOL_ROUNDS + 5 }, () => ({
        name: 'list_tool_directory',
        input: {},
      })),
    )
    const r = await buildButler(provider, join(root, 'c')).onTask(task('t8', 'u8', '死循环。'))

    expect(JSON.stringify(r)).toContain(`aborted after ${BUTLER_MAX_TOOL_ROUNDS} tool-use rounds`)
  })
})
