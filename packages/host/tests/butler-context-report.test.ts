/**
 * butler-context-report.test.ts — LIB-M1 立尺报告 + 注入点 tripwire。
 *
 * 度量姿态(与 AFR-M1 工具面报告同款纪律):
 *   - **卡片文本来自真 builder 真点火**,不是手抄样张——每张满态卡都断言
 *     non-null(fixture 烂了立刻红,量出来的永远是当前实现的字节)。
 *   - **tripwire**:factory `composeContextProbes(...)` 里的 builder 调用点
 *     正则扫源,必须与 VOLATILE_PROBE_REGISTRY 集合相等——工厂加探针不登记
 *     就红,报告永不无声漏量。内联探针(notebook digest)用源码标记钉住。
 *   - stable 段的人设/冻结块是**代表性样本**(人设由成员配置、记忆因人而异),
 *     报告里如实标「样本」;冻结块满态断言 4000 字预算真的咬住(量的是设计
 *     上限,不是注水数)。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Task } from '@gotong/core'
import {
  buildButlerClockProbe,
  composeContextProbes,
  openTaskNotebook,
  type ButlerContextProbe,
} from '@gotong/personal-butler'
import { DEFAULT_TIERS, renderClusteredFrozenBlock } from '@gotong/personal-memory'
import type { MemoryEntry } from '@gotong/services-sdk'

import type { AdminHealthSurface, HealthSnapshot } from '../src/admin-health.js'
import {
  INLINE_PROBE_MARKERS,
  VOLATILE_PROBE_REGISTRY,
  measureContextFace,
  renderContextReport,
  type ContextCardEntry,
  type ContextReport,
} from '../src/butler-context-report.js'
import { buildButlerHubSenseProbe } from '../src/personal-butler-hub-sense.js'
import { buildButlerLanguageProbe, writeReplyLanguage } from '../src/personal-butler-language.js'
import { buildButlerLastSeenProbe, writeLastSeen } from '../src/personal-butler-last-seen.js'
import {
  buildButlerOnboardingProbe,
  writeOnboardingState,
} from '../src/personal-butler-onboarding.js'
import { buildButlerPendingProbe, type ButlerPendingItem } from '../src/personal-butler-pending.js'
import { buildButlerSourceProbe } from '../src/personal-butler-source.js'

// 注入时钟:2026-07-16 晚 21:30(+08)。所有相对时间 fixture 都从它算。
const NOW = Date.parse('2026-07-16T21:30:00+08:00')
const HOUR = 3_600_000
const DAY = 24 * HOUR

// 探针只读 from/title,其余字段不入戏 —— 最小任务壳即可。
const imTask = { id: 'task-im', from: 'im:telegram:10086', title: 'im:telegram' } as unknown as Task
const webTask = { id: 'task-web', from: 'user:emir', title: '快速聊天' } as unknown as Task

/** 人设样本 —— 实际人设由成员自配,这里给一份代表性字数的参照(报告如实标「样本」)。 */
const PERSONA_SAMPLE = [
  '你是阿同(Atong),这个家庭 hub 的常驻管家。',
  '性格:可靠、话少、先给结论;中文为主,成员用哪种语言你就用哪种。',
  '职责:帮成员盯事项、跑工作流、接 IM 消息、管理连接器;任何要花钱、对外发消息、改配置的动作,先摆清事实,等成员点头再走审批闸,绝不先斩后奏。',
  '风格:聊天窗里保持简短口语,不甩 Markdown 墙;拿不准就问,不编造。',
  '你有长期记忆(下方冻结块)与每轮系统注入的状态卡;把它们当背景,不当成员的原话复述。',
].join('\n')

function fact(
  i: number,
  tier: string,
  importance: number,
  text: string,
  extra: Record<string, unknown> = {},
  ageDays = i,
): MemoryEntry {
  return {
    id: `mem-${String(i).padStart(3, '0')}`,
    kind: 'semantic',
    text,
    meta: { tier, importance, ...extra },
    ts: NOW - ageDays * DAY,
  }
}

/** 满态记忆 fixture:12 条手写事实(含 2 条程序) + 24 条流水备忘,总量刻意
 *  超过 4000 字预算 —— 量的是冻结块的设计上限(预算咬住才是真基线)。 */
function fullMemoryEntries(): MemoryEntry[] {
  const entries: MemoryEntry[] = [
    fact(1, 'persona', 5, '用户是马来西亚华人,家在雪兰莪,中文为主偶用英语;称呼直接叫名字,不喜欢客套。', {
      links: ['mem-002', 'mem-010'],
    }),
    fact(2, 'persona', 5, '用户最爱的饮料是珍珠奶茶,下午三点后不喝咖啡(影响睡眠)。', { links: ['mem-001'] }),
    fact(3, 'persona', 4, '用户工作日晚上十点后才有空处理家务事,重要事项别安排在白天推送。'),
    fact(4, 'people', 4, '用户的妈妈住怡保,每周日晚全家视频;她只用微信,不看邮件。'),
    fact(5, 'people', 3, '弟弟在新加坡工作,汇款提醒每月 25 号,用的是 Wise。'),
    fact(6, 'commitments', 5, '答应用户:任何要花钱或对外发消息的动作,先摆事实再等确认,绝不先斩后奏。'),
    fact(7, 'commitments', 4, '每周五晚提醒用户备份手机相册到家里的 NAS。'),
    fact(8, 'projects', 4, '家庭 hub 在腾讯云上跑,飞书是主要聊天通道;出问题先看巡检牌面再动手。', {
      links: ['mem-010'],
    }),
    fact(9, 'projects', 3, '用户在装修老家厨房,预算 3 万令吉,工头是陈师傅(电话在通讯录)。'),
    fact(10, 'misc', 2, '家里的净水器滤芯是 3M 的,上次更换在 2026 年 5 月。'),
    fact(11, 'persona', 3, '给爸妈订机票的流程', {
      form: 'procedure',
      steps: ['查航司官网价格', '对比 Trip.com', '跟爸妈确认日期', '下单后把行程发到家庭群'],
    }),
    fact(12, 'projects', 3, 'hub 出问题时的排查流程', {
      form: 'procedure',
      steps: ['先跑 hub 体检', '看巡检红牌', '按病名查修复指引', '修完复查一遍'],
    }),
  ]
  for (let i = 0; i < 24; i++) {
    entries.push(
      fact(
        13 + i,
        i % 2 === 0 ? 'projects' : 'misc',
        2,
        `装修与家务备忘第 ${i + 1} 周:与陈师傅核对了瓦工、水电、橱柜三班的交接时间点,款项按完工节点分三期支付,票据照片已归档到家庭相册的「装修」目录;另外确认了周末大扫除的分工、净水器滤芯与空调滤网的更换周期,并把下周要复查的防水打压与地暖验收记进了待办,提醒设在周五晚上九点。`,
        {},
        30 + i,
      ),
    )
  }
  return entries
}

const FROZEN_OPTS = {
  label: '阿同',
  showLinks: true,
  showProcedures: true,
  activeOnly: true,
  now: NOW,
  config: DEFAULT_TIERS,
} as const

let dir: string
let volatileFull: Record<string, string> // 卡名 → 满态真点火文本
let clockText: string
let frozenEmpty: string
let frozenFull: string
let report: ContextReport
let emptyProbes: ButlerContextProbe[] // 空态探针组(compose 胶水断言用)

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gotong-ctx-report-'))

  // ── 满态 fixture:每张卡按各自的点火条件真实产出 ────────────────────────
  const clock = buildButlerClockProbe({ now: () => NOW, timeZone: 'Asia/Shanghai', locale: 'zh-CN' })
  clockText = (await clock(imTask))!

  const lastSeenFile = join(dir, 'full', 'last-seen.json')
  await writeLastSeen(lastSeenFile, NOW - 26 * HOUR) // 26h 前聊过 → 超 3h 门 → 点火
  const lastSeen: ButlerContextProbe = buildButlerLastSeenProbe({
    file: lastSeenFile,
    now: () => NOW,
    timeZone: 'Asia/Shanghai',
  })

  const languageFile = join(dir, 'full', 'reply-language.json')
  await writeReplyLanguage(languageFile, '中文(简体)')
  const language: ButlerContextProbe = buildButlerLanguageProbe({ file: languageFile })

  const source = buildButlerSourceProbe() // imTask 的 from 就是点火条件

  const pendingItems: ButlerPendingItem[] = [
    { kind: 'approval', title: '给妈妈发生日提醒到家庭群', prompt: '内容已拟好,等你确认后发出。' },
    { kind: 'approval', title: '续订净水器滤芯(¥189)', prompt: '下单前需要你点头。' },
    { kind: 'choice', title: '晨报时间改到 7:30 还是 8:00', prompt: '二选一。' },
    { kind: 'approval', title: '把装修合同转发给弟弟', prompt: '对外发送,等确认。' },
  ]
  const pending: ButlerContextProbe = buildButlerPendingProbe({
    userId: 'member-emir',
    pending: () => ({ listPending: async () => pendingItems }),
  })

  const patrolFile = join(dir, 'full', 'patrol-state.json')
  await writeFile(
    patrolFile,
    JSON.stringify({
      cards: {
        space_unwritable: { severity: 'red', label: '空间目录写不进', since: NOW - 2 * HOUR },
        'agent_missing_key:helper': { severity: 'yellow', label: 'Agent「家庭帮手」缺 API key', since: NOW - HOUR },
        'mcp_unwired:tavily': { severity: 'yellow', label: 'MCP「tavily-web-search」未接线', since: NOW - HOUR },
        llm_outage_escalation: { severity: 'yellow', label: 'LLM 断供超过 30 分钟', since: NOW - HOUR },
      },
    }),
    'utf8',
  ) // 刚写完 → mtime 新鲜 → 过 30min 门
  const hubSense: ButlerContextProbe = buildButlerHubSenseProbe({ stateFile: patrolFile })

  const snap: HealthSnapshot = {
    agents: [],
    agentsMissingKey: 2,
    managedCount: 2,
    onlineCount: 0,
    mcpServers: [],
    mcpUnwired: 0,
    spaceWritable: true,
    spacePath: join(dir, 'space'),
    workflowCount: 0,
    imBridges: [],
  }
  const healthSurface: AdminHealthSurface = { snapshot: async () => snap }
  const onboarding: ButlerContextProbe = buildButlerOnboardingProbe({
    stateFile: join(dir, 'full', 'onboarding-state.json'), // 不存在 = 没完成 → 三缺口全亮
    health: () => healthSurface,
  })

  const notebook = openTaskNotebook({ file: join(dir, 'full', 'tasks.json'), now: () => NOW })
  await notebook.openNote({
    title: '给爸妈订春节回怡保的机票',
    steps: ['查三家航司价格', '跟爸妈确认日期', '下单并转发行程'],
  })
  await notebook.openNote({ title: '整理家庭相册去重', steps: ['扫描重复照片', '挑选保留版本'] })
  await notebook.openNote({ title: '续订家里的净水器滤芯', steps: ['查上次更换日期', '比价下单'] })

  volatileFull = {
    clock: clockText,
    'last-seen': (await lastSeen(imTask))!,
    language: (await language(imTask))!,
    source: (await source(imTask))!,
    pending: (await pending(imTask))!,
    'hub-sense': (await hubSense(imTask))!,
    onboarding: (await onboarding(imTask))!,
    'notebook-digest': (await notebook.digest())!,
  }

  // ── 空态 fixture:除时钟外每个探针都该沉默(prompt 字节不变的另一半) ──────
  const emptyOnboardingState = join(dir, 'empty', 'onboarding-state.json')
  await writeOnboardingState(emptyOnboardingState, {
    done: true,
    reason: 'declined',
    at: new Date(NOW).toISOString(),
  })
  const emptyNotebook = openTaskNotebook({ file: join(dir, 'empty', 'tasks.json'), now: () => NOW })
  emptyProbes = [
    clock,
    buildButlerLastSeenProbe({ file: join(dir, 'empty', 'last-seen.json'), now: () => NOW }), // 首次接触
    buildButlerLanguageProbe({ file: join(dir, 'empty', 'reply-language.json') }),
    source, // webTask 无 im: 前缀
    buildButlerPendingProbe({ userId: 'member-emir', pending: () => ({ listPending: async () => [] }) }),
    buildButlerHubSenseProbe({ stateFile: join(dir, 'empty', 'patrol-state.json') }),
    buildButlerOnboardingProbe({ stateFile: emptyOnboardingState, health: () => undefined }),
    async () => emptyNotebook.digest(),
  ]

  // ── stable 段样本 + 度量 ────────────────────────────────────────────────
  frozenEmpty = renderClusteredFrozenBlock([], FROZEN_OPTS)
  frozenFull = renderClusteredFrozenBlock(fullMemoryEntries(), FROZEN_OPTS)

  const entries: ContextCardEntry[] = [
    { segment: 'stable', card: 'persona', state: '样本', text: PERSONA_SAMPLE },
    { segment: 'stable', card: 'frozen-block', state: '空记忆', text: frozenEmpty },
    { segment: 'stable', card: 'frozen-block', state: '预算饱和', text: frozenFull },
    ...Object.entries(volatileFull).map(([card, text]): ContextCardEntry => {
      return { segment: 'volatile', card, state: card === 'clock' ? '恒在' : '满态', text }
    }),
  ]
  report = measureContextFace(entries)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('LIB-M1 上下文段级基线', () => {
  it('满态:八张探针卡全部由真 builder 真点火(fixture 防腐)', () => {
    const expected = [...Object.keys(VOLATILE_PROBE_REGISTRY), ...Object.keys(INLINE_PROBE_MARKERS)]
    expect(Object.keys(volatileFull).sort()).toEqual([...expected].sort())
    for (const [card, text] of Object.entries(volatileFull)) {
      expect(text, `探针 ${card} 的满态 fixture 没点火 —— fixture 烂了,基线量不得`).toBeTruthy()
      expect(text.length).toBeGreaterThan(10)
    }
    // 抽查内容锚点:量的确实是那张卡,不是错位文本。
    expect(volatileFull['source']).toContain('Telegram')
    expect(volatileFull['pending']).toContain('4')
    expect(volatileFull['hub-sense']).toContain('空间目录写不进')
    expect(volatileFull['notebook-digest']).toContain('机票')
  })

  it('空态:除时钟外七探针全 null,compose 胶水零开销', async () => {
    const results = await Promise.all(emptyProbes.map((p) => p(webTask)))
    expect(results[0]).toBe(clockText) // 时钟恒在 —— 知道「现在」是助手底线
    for (let i = 1; i < results.length; i++) {
      expect(results[i], `空态探针 #${i} 该沉默却注了字 —— 无信号≠null 会拖垮缓存经济学`).toBeNull()
    }
    // compose 后 = 时钟卡原文:胶水(join)在单卡时零附加字节。
    const composed = await composeContextProbes(...emptyProbes)(webTask)
    expect(composed).toBe(clockText)
  })

  it('冻结块满态:4000 字预算真的咬住(量的是设计上限,不是注水数)', () => {
    expect(frozenFull).toContain('omitted to fit the memory budget')
    expect(frozenFull.length).toBeGreaterThan(3500)
    expect(frozenFull).toContain('Things I know how to do') // 程序区在样本里有代表
    expect(frozenEmpty).toContain('_(no memories yet)_')
  })

  it('度量:行数=3 stable + 8 volatile,段小计与行和一致', () => {
    expect(report.rows.length).toBe(11)
    const vol = report.segments.find((s) => s.segment === 'volatile')!
    const sta = report.segments.find((s) => s.segment === 'stable')!
    expect(vol.cards).toBe(8)
    expect(sta.cards).toBe(3)
    const sum = (rows: readonly { estTokens: number }[]) => rows.reduce((a, r) => a + r.estTokens, 0)
    expect(vol.estTokens).toBe(sum(report.rows.filter((r) => r.segment === 'volatile')))
    expect(sta.estTokens).toBe(sum(report.rows.filter((r) => r.segment === 'stable')))
    expect(report.totalEstTokens).toBe(vol.estTokens + sta.estTokens)
    for (const r of report.rows) expect(r.estTokens).toBeGreaterThan(0)
  })

  it('tripwire:factory 探针注入点 ≡ 注册表(加探针不登记就红)', async () => {
    const factoryPath = fileURLToPath(new URL('../src/personal-butler-factory.ts', import.meta.url))
    const src = await readFile(factoryPath, 'utf8')
    // builder 形态:调用点正则(import 行无「(」不会误中)。
    const called = new Set([...src.matchAll(/\b(buildButler\w+Probe)\s*\(/g)].map((m) => m[1]!))
    expect(called).toEqual(new Set(Object.values(VOLATILE_PROBE_REGISTRY)))
    // 内联形态:各自的源码标记必须还在(新内联探针必须同步登记 INLINE_PROBE_MARKERS)。
    for (const [card, marker] of Object.entries(INLINE_PROBE_MARKERS)) {
      expect(src, `内联探针 ${card} 的源码标记消失 —— 改了写法请同步注册表`).toMatch(marker)
    }
    // 注入点只有一个:第二个 composeContextProbes 调用点意味着有第二张嘴,报告会漏。
    expect(src.match(/composeContextProbes\(/g)?.length ?? 0).toBe(1)
  })

  it('报告:打印段级基线(pnpm report:atong-context 的输出)', () => {
    const clockRow = report.rows.find((r) => r.card === 'clock')!
    const vol = report.segments.find((s) => s.segment === 'volatile')!
    const personaRow = report.rows.find((r) => r.card === 'persona')!
    const frozenRows = report.rows.filter((r) => r.card === 'frozen-block')
    const rendered = renderContextReport(report, [
      '---- 场景 ----',
      `每轮必付底价(volatile 仅时钟): ~${clockRow.estTokens} tokens`,
      `volatile 满配(八探针齐发): ~${vol.estTokens} tokens`,
      `stable 段(人设样本+冻结块): 空记忆 ~${personaRow.estTokens + frozenRows[0]!.estTokens} → 预算饱和 ~${personaRow.estTokens + frozenRows[1]!.estTokens} tokens`,
    ])
    expect(rendered).toContain('合计')
    expect(rendered).toContain('每轮必付底价')
    expect(rendered).toContain('cache_control')
    console.log(`\n${rendered}\n`)
  })
})
