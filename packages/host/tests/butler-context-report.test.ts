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

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Task } from '@gotong/core'
import {
  ButlerSessionWindow,
  SESSION_MAX_TURNS,
  SESSION_TURN_MAX_CHARS,
  buildButlerClockProbe,
  buildButlerSessionHintProbe,
  composeContextProbes,
  openKnowledgeLibrary,
  openTaskNotebook,
  type ButlerContextProbe,
} from '@gotong/personal-butler'
import { DEFAULT_TIERS, renderClusteredFrozenBlock } from '@gotong/personal-memory'
import type { MemoryEntry } from '@gotong/services-sdk'

import type { AdminHealthSurface, HealthSnapshot } from '../src/admin-health.js'
import {
  HISTORY_SOURCE_MARKERS,
  INLINE_PROBE_MARKERS,
  STABLE_CARD_REGISTRY,
  VOLATILE_PROBE_REGISTRY,
  measureContextFace,
  renderContextReport,
  type ContextCardEntry,
  type ContextReport,
} from '../src/butler-context-report.js'
import {
  KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS,
  buildButlerKnowledgeIndexCard,
} from '../src/butler-knowledge-index.js'
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
// SESS 带窗任务壳:session-hint 探针只认 `payload.history` 非空数组 —— 与
// LlmAgent.buildRequest 判「这轮带窗」用同一个形状测试,所以点火条件必须
// 用真带窗的任务复现,不能借上面两个无 payload 的壳。
const windowedTask = {
  id: 'task-im-windowed',
  from: 'im:telegram:10086',
  title: 'im:telegram',
  payload: {
    prompt: '查一下',
    history: [
      { role: 'user', content: '帮我看看下周去怡保的机票' },
      { role: 'assistant', content: '查到三班,要我整理周三那班的详情吗?' },
    ],
  },
} as unknown as Task

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
let indexSample: string // LIB-M3 索引卡样本(真 builder 真库)
let indexTruncated: string // LIB-M3 索引卡截断顶(胖索引 → ≤500tk)
let report: ContextReport
let emptyProbes: ButlerContextProbe[] // 空态探针组(compose 胶水断言用)
let historyRows: ContextCardEntry[] // SESS 会话窗填充曲线(空窗/典型/满态)

/**
 * 量 SESS 会话窗的三个刻度 —— 真 `ButlerSessionWindow` 真读写。
 *
 * 为什么不手造样张:`history()` 的产物经过三道真规则(同角色相邻合并、
 * **尾部 user 丢弃**、`SESSION_MAX_TURNS` 截断),手抄的数组量的是我以为的
 * 形状,不是模型真收到的字节。满态刻度尤其:喂满 `SESSION_TURN_MAX_CHARS`
 * 的长文再看剩下几条,那才是最坏情况的真上界。
 *
 * 「一条消息」在 wire 上不止正文——role 字段、分隔结构都要钱。这里按每条
 * 加 4 token 的保守常量计入,报告如实标出来,免得账算得比实际乐观。
 */
const PER_MESSAGE_OVERHEAD_TOKENS = 4

async function measureSessionWindow(rootDir: string): Promise<ContextCardEntry[]> {
  const render = (msgs: readonly { role: string; content: string }[]) =>
    msgs.map((m) => `${m.role}: ${m.content}`).join('\n')

  // 空窗:成员发来的第一条消息,窗里什么都没有 ⇒ 零字节。
  const emptyWin = new ButlerSessionWindow({ rootDir: join(rootDir, 'empty'), now: () => NOW })
  const emptyHistory = await emptyWin.history('member-emir')

  // 典型:三个来回的日常对话(问 → 答 → 追问 → 答 → 再问 → 答)。
  const typicalWin = new ButlerSessionWindow({ rootDir: join(rootDir, 'typical'), now: () => NOW })
  const TYPICAL: [string, string][] = [
    ['user', '帮我看看下周去怡保的机票'],
    ['assistant', '查到三班:周二早 08:15(RM 89)、周三下午 14:40(RM 76)、周五晚 19:20(RM 112)。要我把周三那班的详情整理给你吗?'],
    ['user', '要'],
    ['assistant', '周三 14:40 出发、15:35 抵达,亚航 AK5312,RM 76 含 7kg 手提行李。托运另加 RM 40。要现在订吗?'],
    ['user', '先别订,等我问过我妈'],
    ['assistant', '好,我记下了:怡保机票待定,等你问过妈妈再说。要我周一提醒你一次吗?'],
  ]
  for (const [role, text] of TYPICAL) {
    await typicalWin.append('member-emir', role as 'user' | 'assistant', text)
  }
  const typicalHistory = await typicalWin.history('member-emir')

  // 满态:每条都顶到 SESSION_TURN_MAX_CHARS,条数顶到 SESSION_MAX_TURNS。
  // 这是设计上界,不是注水数 —— 量的就是「最坏情况这段要多少钱」。
  const fullWin = new ButlerSessionWindow({ rootDir: join(rootDir, 'full'), now: () => NOW })
  const wall = '装'.repeat(SESSION_TURN_MAX_CHARS + 200) // 超发 200 字,证明单条裁剪咬住
  for (let i = 0; i < SESSION_MAX_TURNS + 6; i++) {
    // 超发 6 条,顺带证明条数截断也咬住(而不是靠我数着喂)。
    await fullWin.append('member-emir', i % 2 === 0 ? 'user' : 'assistant', wall)
  }
  // 派发时刻的真实形状:SESS 是**先读窗、后记当前句**(beginTurn 的渲染
  // 快照取自记录之前;split 回落形态也是 history() 在 append 之前)。所以
  // 模型看到的窗尾恒为上一轮的 assistant 回复,一条不丢 —— 上界就是
  // SESSION_MAX_TURNS 整。尾部 user 丢弃规则只在「上一句没得到回复」的
  // 残窗里点火(派发失败/回复未落),那不是满态基线该量的形状。
  const fullHistory = await fullWin.history('member-emir')

  const row = (state: string, msgs: readonly { role: string; content: string }[]): ContextCardEntry => ({
    segment: 'history',
    card: 'session-window',
    state,
    // 每条的结构性开销折成等价字符补进文本：尺子按 4 个非 CJK 字符 ≈ 1 token
    // 折算,所以每条补 4×4 个空格才真计入 4 token(裸控制字节永不进源文件)。
    text: render(msgs) + ' '.repeat(msgs.length * PER_MESSAGE_OVERHEAD_TOKENS * 4),
  })

  return [
    row(`空窗(0 条)`, emptyHistory),
    row(`典型(${typicalHistory.length} 条)`, typicalHistory),
    row(`满态(${fullHistory.length} 条)`, fullHistory),
  ]
}

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

  const sessionHint = buildButlerSessionHintProbe() // 带窗轮(windowedTask)才点火

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
    'session-hint': (await sessionHint(windowedTask))!,
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
    sessionHint, // webTask 无 payload.history → 不带窗的轮零注入
    buildButlerPendingProbe({ userId: 'member-emir', pending: () => ({ listPending: async () => [] }) }),
    buildButlerHubSenseProbe({ stateFile: join(dir, 'empty', 'patrol-state.json') }),
    buildButlerOnboardingProbe({ stateFile: emptyOnboardingState, health: () => undefined }),
    async () => emptyNotebook.digest(),
  ]

  // ── stable 段样本 + 度量 ────────────────────────────────────────────────
  frozenEmpty = renderClusteredFrozenBlock([], FROZEN_OPTS)
  frozenFull = renderClusteredFrozenBlock(fullMemoryEntries(), FROZEN_OPTS)

  // LIB-M3 索引卡:真 builder 走真库(空库=null 在专门的门测试里防腐,这里
  // 量样本态与截断顶——「常驻段字节不随知识总量长」的两个刻度)。
  const kbSample = openKnowledgeLibrary({ dir: join(dir, 'full', 'knowledge') })
  await kbSample.write(
    'INDEX.md',
    [
      '# 我的知识',
      '- user/家人.md — 家人档案(妈妈在怡保,弟弟在新加坡)',
      '- user/偏好.md — 饮食与作息偏好',
      '- projects/装修.md — 老家厨房翻新(预算/工头/节点)',
      '- projects/hub-运维.md — 家庭 hub 的排查笔记',
      '- people/陈师傅.md — 装修工头联系与交接',
      '- archive/ — 完结项目的历史档案',
    ].join('\n'),
  )
  indexSample = (await buildButlerKnowledgeIndexCard({ library: kbSample })())!

  const kbFat = openKnowledgeLibrary({ dir: join(dir, 'fat', 'knowledge') })
  await kbFat.write(
    'INDEX.md',
    Array.from(
      { length: 120 },
      (_, i) => `- projects/装修-${String(i).padStart(3, '0')}.md — 老家厨房翻新的预算票据与交接记录`,
    ).join('\n'),
  )
  indexTruncated = (await buildButlerKnowledgeIndexCard({ library: kbFat })())!

  // ── history 段(SESS 会话窗)三个刻度 ─────────────────────────────────────
  // 真 ButlerSessionWindow 真读写:填充曲线必须来自真 append/history 的裁剪与
  // 合并规则(尾部 user 丢弃、同角色合并、SESSION_MAX_TURNS 截断),手抄样张
  // 量不到这些。三刻度 = 空窗(首条消息) / 典型(3 来回) / 满态(常量上界)。
  historyRows = await measureSessionWindow(join(dir, 'sessions'))

  const entries: ContextCardEntry[] = [
    { segment: 'stable', card: 'persona', state: '样本', text: PERSONA_SAMPLE },
    { segment: 'stable', card: 'frozen-block', state: '空记忆', text: frozenEmpty },
    { segment: 'stable', card: 'frozen-block', state: '预算饱和', text: frozenFull },
    { segment: 'stable', card: 'knowledge-index', state: '样本(7 行)', text: indexSample },
    { segment: 'stable', card: 'knowledge-index', state: '截断顶(120 行)', text: indexTruncated },
    ...Object.entries(volatileFull).map(([card, text]): ContextCardEntry => {
      return { segment: 'volatile', card, state: card === 'clock' ? '恒在' : '满态', text }
    }),
    ...historyRows,
  ]
  report = measureContextFace(entries)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('LIB-M1 上下文段级基线', () => {
  it('满态:九张探针卡全部由真 builder 真点火(fixture 防腐)', () => {
    const expected = [...Object.keys(VOLATILE_PROBE_REGISTRY), ...Object.keys(INLINE_PROBE_MARKERS)]
    expect(Object.keys(volatileFull).sort()).toEqual([...expected].sort())
    for (const [card, text] of Object.entries(volatileFull)) {
      expect(text, `探针 ${card} 的满态 fixture 没点火 —— fixture 烂了,基线量不得`).toBeTruthy()
      expect(text.length).toBeGreaterThan(10)
    }
    // 抽查内容锚点:量的确实是那张卡,不是错位文本。
    expect(volatileFull['source']).toContain('Telegram')
    expect(volatileFull['session-hint']).toContain('recall')
    expect(volatileFull['pending']).toContain('4')
    expect(volatileFull['hub-sense']).toContain('空间目录写不进')
    expect(volatileFull['notebook-digest']).toContain('机票')
  })

  it('空态:除时钟外八探针全 null,compose 胶水零开销', async () => {
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
    // These historical procedure fixtures have no evidence; never imply a pass.
    expect(frozenFull).not.toContain('Things I know how to do')
    expect(frozenEmpty).toContain('_(no memories yet)_')
  })

  it('LIB-M3 索引卡:样本真点火,截断顶 ≤500tk(常驻段不随知识总量长)', () => {
    expect(indexSample).toContain('【知识库索引】')
    expect(indexSample).toContain('user/家人.md')
    expect(indexSample).not.toContain('超出注入预算')
    const truncatedRow = report.rows.find(
      (r) => r.card === 'knowledge-index' && r.state.includes('截断'),
    )!
    expect(truncatedRow.estTokens).toBeLessThanOrEqual(KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS)
    expect(indexTruncated).toContain('只显示前')
  })

  it('度量:行数=5 stable + 9 volatile + 3 history,段小计与行和一致', () => {
    expect(report.rows.length).toBe(17)
    const vol = report.segments.find((s) => s.segment === 'volatile')!
    const sta = report.segments.find((s) => s.segment === 'stable')!
    const his = report.segments.find((s) => s.segment === 'history')!
    expect(vol.cards).toBe(9)
    expect(sta.cards).toBe(5)
    expect(his.cards).toBe(3)
    const sum = (rows: readonly { estTokens: number }[]) => rows.reduce((a, r) => a + r.estTokens, 0)
    expect(vol.estTokens).toBe(sum(report.rows.filter((r) => r.segment === 'volatile')))
    expect(sta.estTokens).toBe(sum(report.rows.filter((r) => r.segment === 'stable')))
    expect(his.estTokens).toBe(sum(report.rows.filter((r) => r.segment === 'history')))
    expect(report.totalEstTokens).toBe(vol.estTokens + sta.estTokens + his.estTokens)
    // 空窗行按设计就是 0(见下面那道门),其余每行都必须真有字 —— fixture 烂了立刻红。
    for (const r of report.rows) {
      if (r.state.startsWith('空窗')) continue
      expect(r.estTokens, `行 ${r.card}/${r.state} 量到 0 —— fixture 没点火`).toBeGreaterThan(0)
    }
  })

  it('history 段:空窗零字节 / 典型 6 条如实 / 满态被常量咬住', () => {
    const [empty, typical, full] = report.rows.filter((r) => r.segment === 'history')

    // 空窗 = 首条消息的姿态:窗里没东西就一个字节都不注 —— 与 volatile 探针
    // 「无信号=null=prompt 字节不变」同一条契约,这里对 messages 数组成立。
    expect(empty!.chars).toBe(0)
    expect(empty!.estTokens).toBe(0)

    // 典型:喂了 6 条(3 来回),尾条是 assistant 所以一条不丢 —— 若哪天
    // 合并/丢弃规则改了,这个数会动,报告的「典型」刻度也就不再是那个意思。
    expect(typical!.state).toContain('(6 条)')

    // 满态:派发是先读窗后记当前句,窗尾恒为上轮 assistant,一条不丢 ⇒
    // 送到模型的真上界就是 SESSION_MAX_TURNS 整条。
    // 数字从真常量推,常量一改这里就红 —— 逼人重新看一眼最坏情况的账。
    expect(full!.state).toContain(`(${SESSION_MAX_TURNS} 条)`)
    const bodyOnly = SESSION_MAX_TURNS * SESSION_TURN_MAX_CHARS
    // 正文顶到每条上限(裁剪真的咬住,不是我少喂了字);另计 role 前缀与结构开销。
    expect(full!.chars).toBeGreaterThanOrEqual(bodyOnly)
    expect(full!.chars).toBeLessThan(bodyOnly * 1.05)
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
    // LIB-M3 stable 段同款纪律:Card builder 调用点 ≡ 注册表,注入点唯一。
    const cardCalls = new Set([...src.matchAll(/\b(buildButler\w+Card)\s*\(/g)].map((m) => m[1]!))
    expect(cardCalls).toEqual(new Set(Object.values(STABLE_CARD_REGISTRY)))
    expect(src.match(/stableContext:/g)?.length ?? 0).toBe(1)
  })

  it('tripwire:history 段注入点 ≡ 注册表(会话窗多长一张嘴不登记就红)', async () => {
    // 会话窗不在构造路径(factory)上而在派发路径上,所以钉的是消费
    // `ButlerSessionWindow.history()` 的源文件与标记。
    for (const [file, marker] of Object.entries(HISTORY_SOURCE_MARKERS)) {
      const src = await readFile(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8')
      expect(src, `${file} 的会话窗读取点标记消失 —— 改了写法请同步 HISTORY_SOURCE_MARKERS`).toMatch(
        marker,
      )
    }
    // 全 host 源码里读会话窗的地方必须恰好等于登记数:多一处 = 多一张嘴,
    // 报告里的填充曲线就不再覆盖全部注入,基线会悄悄失真。
    const hostSrcDir = fileURLToPath(new URL('../src/', import.meta.url))
    const files = (await readdir(hostSrcDir)).filter((f) => f.endsWith('.ts'))
    let readers = 0
    for (const f of files) {
      const src = await readFile(join(hostSrcDir, f), 'utf8')
      readers += src.match(/sessions[!?]?\.history\(/g)?.length ?? 0
    }
    expect(readers).toBe(Object.keys(HISTORY_SOURCE_MARKERS).length)
  })

  it('报告:打印段级基线(pnpm report:atong-context 的输出)', () => {
    const clockRow = report.rows.find((r) => r.card === 'clock')!
    const vol = report.segments.find((s) => s.segment === 'volatile')!
    const personaRow = report.rows.find((r) => r.card === 'persona')!
    const frozenRows = report.rows.filter((r) => r.card === 'frozen-block')
    const indexRows = report.rows.filter((r) => r.card === 'knowledge-index')
    const his = report.rows.filter((r) => r.segment === 'history')
    const rendered = renderContextReport(report, [
      '---- 场景 ----',
      `每轮必付底价(volatile 仅时钟): ~${clockRow.estTokens} tokens`,
      `volatile 满配(九探针齐发): ~${vol.estTokens} tokens`,
      `stable 段(人设样本+冻结块): 空记忆 ~${personaRow.estTokens + frozenRows[0]!.estTokens} → 预算饱和 ~${personaRow.estTokens + frozenRows[1]!.estTokens} tokens`,
      `stable 增量(LIB-M3 索引卡): 样本 ~${indexRows[0]!.estTokens} → 截断顶 ~${indexRows[1]!.estTokens} tokens(预算 ${KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS})`,
      `history 段(SESS 会话窗): 空窗 ${his[0]!.estTokens} → 典型 ~${his[1]!.estTokens} → 满态 ~${his[2]!.estTokens} tokens(窗留 ${SESSION_MAX_TURNS} 条 × ${SESSION_TURN_MAX_CHARS} 字,派发先读窗后记当前句、尾条是上轮 assistant 一条不丢 ⇒ 送模型上界 ${SESSION_MAX_TURNS} 条)`,
      `→ 每轮上下文合计:典型对话 ~${personaRow.estTokens + frozenRows[1]!.estTokens + indexRows[0]!.estTokens + vol.estTokens + his[1]!.estTokens} → 最坏 ~${personaRow.estTokens + frozenRows[1]!.estTokens + indexRows[1]!.estTokens + vol.estTokens + his[2]!.estTokens} tokens(不含工具面)`,
    ])
    expect(rendered).toContain('合计')
    expect(rendered).toContain('每轮必付底价')
    expect(rendered).toContain('cache_control')
    expect(rendered).toContain('会话窗')
    console.log(`\n${rendered}\n`)
  })
})
