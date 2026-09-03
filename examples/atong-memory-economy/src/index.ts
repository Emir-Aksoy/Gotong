/**
 * 记忆经济 capstone —— 「一万轮之后,记忆还是那个记忆」。
 *
 * 记忆经济这条 track 有一句可证伪的话:**大小常量有界、跨店一次召回、用则存不用则忘**。
 * 这个 demo 端到端地证它,全程用 M1~M4 **真的导出的代码**(一行都不重写),用它们自己
 * 立的尺量。三幕:
 *
 *   第一幕 —— 万轮不膨胀。一万轮合成对话,六成是复述(常驻管家在 IM 上的真实形态)。
 *             两条路跑同一份剧本:**今天**(裸 `remember` + 只看重要度与新旧的逐出)
 *             对 **记忆经济**(M4 写侧新颖门 + M3b 通了电的显著性)。
 *             注意一件要说清楚的事:**「字节 ≤ 预算」两条路都成立** —— 那是
 *             `enforceBudget` 早就有的功劳,不是 M4 的。M4 挣到的是另外三个数:
 *             写入放大、逐出量,以及最要紧的**召回名额里有几件不同的事**。
 *
 *   第二幕 —— 洪水过后,跨店召回不掉。拿第一幕**真的剩在盘上的那些条目**当干扰项,
 *             灌进一个七店俱全的成员空间,用 M1 的整合尺(`scoreIntegration`)量:
 *             跨店召回的分数不许掉。
 *
 *   第三幕 —— 用则存不用则忘。两条一模一样重要、一模一样新的事实,一条被召回五次
 *             (走真的 `reinforcedMeta`),一条从没被碰过;两个月之后预算只装得下一条。
 *             活下来的必须是被用过的那条。
 *
 * 北极星:本 demo 全程框架跑了 **0 个模型**。新颖门、记忆账、显著性、逐出全是纯函数;
 * 唯一会调模型的 6h 蒸馏链在这里根本没上场。凭证零、固定钟、可复现。
 *
 *   pnpm demo:memory-economy      # 每一项都成立才退 0,否则退 1
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_REINFORCE_WEIGHT,
  DEFAULT_SALIENCE_HALF_LIFE_MS,
  effectiveSalience,
  enforceBudget,
  entryBytes,
  mutualCoverage,
  readLedger,
  reinforcedMeta,
  rememberNovel,
  type LedgerRung,
} from '@gotong/personal-memory'
import {
  formatIntegrationResult,
  netRecall,
  openIntegrationSpace,
  scoreIntegration,
  type IntegrationCase,
  type IntegrationSpaceSeed,
} from '@gotong/personal-butler'
import type {
  MemoryEntry,
  MemoryHandle,
  MemoryKind,
  MemoryQuery,
  NewMemoryEntry,
} from '@gotong/services-sdk'

/** 固定钟(2023-11)。每一个 ts 都由它派生,所以每一个数字都可复现。 */
const T0 = 1_700_000_000_000
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

const failures: string[] = []
function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(label)
}

// ───────────────────────────────────────────────────────────────────────────
// 一个最小的 MemoryHandle。语义照抄文件后端(新到旧、按 kind 过滤、meta 浅合并),
// 因为这个 demo 要量的是**策略**的差别,不是某个后端的实现细节。
// ───────────────────────────────────────────────────────────────────────────

interface DemoMemory extends MemoryHandle {
  /** 收窄成必有 —— 本 demo 的句柄总是能改 meta(第三幕的强化、M4 的折叠都靠它)。 */
  patchMeta: NonNullable<MemoryHandle['patchMeta']>
  readonly all: readonly MemoryEntry[]
  readonly writes: number
}

function makeMemory(clock: () => number): DemoMemory {
  const rows: MemoryEntry[] = []
  let seq = 0
  let writes = 0
  return {
    get all() {
      return rows
    },
    get writes() {
      return writes
    },
    async recall(q: MemoryQuery): Promise<MemoryEntry[]> {
      const kinds = q.kinds
      const text = q.text?.toLowerCase()
      return rows
        .filter((r) => !kinds || kinds.includes(r.kind))
        .filter((r) => !text || r.text.toLowerCase().includes(text))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, q.k ?? 20)
    },
    async remember(ne: NewMemoryEntry): Promise<MemoryEntry> {
      writes += 1
      const row: MemoryEntry = {
        id: ne.id ?? `e${++seq}`,
        kind: ne.kind,
        text: ne.text,
        ts: clock(),
        ...(ne.meta !== undefined ? { meta: ne.meta } : {}),
      }
      rows.push(row)
      return row
    },
    async list(o: { kind?: MemoryKind; limit?: number } = {}): Promise<MemoryEntry[]> {
      return rows
        .filter((r) => !o.kind || r.kind === o.kind)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, o.limit ?? 100)
    },
    async forget(id: string): Promise<void> {
      const i = rows.findIndex((r) => r.id === id)
      if (i >= 0) rows.splice(i, 1)
    },
    async clear(): Promise<void> {
      rows.length = 0
    },
    async patchMeta(id: string, patch: Record<string, unknown>): Promise<boolean> {
      const i = rows.findIndex((r) => r.id === id)
      if (i < 0) return false
      rows[i] = { ...rows[i]!, meta: { ...(rows[i]!.meta ?? {}), ...patch } }
      return true
    },
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 第一幕 —— 万轮不膨胀
// ───────────────────────────────────────────────────────────────────────────

const TURNS = 10_000
/** 复述占比。常驻管家在 IM 上的真实形态:大半的轮次是同一件事又问一遍。 */
const RESTATE_RATE = 0.6
/** 预算刻意收紧到装不下全部话题 —— 一个装得下一切的预算量不出经济学。 */
const BUDGET_ENTRIES = 25
/** 每多少轮跑一次维护(生产里是 6h 一 tick)。 */
const MAINTAIN_EVERY = 200

/** 四十件互不相干的事。第三列是管家的回答 —— 它一起被写进条目,这很要紧(见 M4)。 */
const TOPICS: readonly (readonly [string, string])[] = [
  ['明天下午的会议改到几点了?', '改到明天下午 4 点,在三号会议室。'],
  ['上个月的打车发票报销到哪一步了?', '财务上周五已经打款,到账要 3 个工作日。'],
  ['孩子下学期的学费什么时候交?', '缴费窗口是 8 月 15 到 8 月 30,可以网银转。'],
  ['那台服务器磁盘还剩多少?', '根分区剩 12 GB,日志目录占了 40 GB,建议先清日志。'],
  ['吉隆坡这周末天气怎么样?', '周六多云 31 度,周日有雷阵雨,下午出门带伞。'],
  ['帮我订一张周五飞槟城的机票。', '最早的是周五上午 7 点 40 的 MH1054,经济舱还有位。'],
  ['家里的宽带续费了吗?', '还没,套餐 9 月 3 日到期,续一年是 1188 令吉。'],
  ['妈妈的体检报告出来了吗?', '出来了,血脂偏高,医生建议三个月后复查。'],
  ['公司年会定在哪一天?', '定在 12 月 18 日周五晚上,地点是双子塔那家酒店。'],
  ['我的护照什么时候过期?', '2027 年 4 月 9 日过期,现在续还来得及。'],
  ['冰箱里的牛奶还有几盒?', '还有两盒,最早的那盒后天到期。'],
  ['房贷这个月扣了多少?', '扣了 3240 令吉,其中利息 1120。'],
  ['狗的疫苗该打第几针了?', '第三针,兽医说这个月底之前打完。'],
  ['上周那份合同律师看完了吗?', '看完了,第 7 条的赔偿上限他建议改成两倍年费。'],
  ['车子该保养了吗?', '里程到 9800 公里了,一万公里要换机油。'],
  ['信用卡账单出了吗?', '出了,本期 4266 令吉,最后还款日 9 月 12。'],
  ['小区停车位涨价了吗?', '从下个月起每月 120 令吉,涨了 20。'],
  ['那本书图书馆有吗?', '总馆有两本在架,分馆的被借走了。'],
  ['团队下季度的招聘名额批了吗?', '批了两个,一个后端一个设计。'],
  ['我上次说的那个域名注册了吗?', '注册了,续费到 2027 年 6 月。'],
  ['周三的瑜伽课改时间了吗?', '改到晚上 8 点,教室换到二楼。'],
  ['电费这个月为什么这么高?', '空调用了 380 度,比上月多了一倍。'],
  ['爸爸生日礼物买了吗?', '还没,你上次说想买那副降噪耳机。'],
  ['公司报销系统能用了吗?', '能用了,昨晚升级完,旧的单据要重新提交。'],
  ['那个客户的合同签了吗?', '签了,首付 30% 已经到账。'],
  ['家里的净水器滤芯该换了吗?', '前置该换了,已经用了 11 个月。'],
  ['下周出差的酒店订了吗?', '订了,新加坡那家,含早,三晚。'],
  ['我的驾照分还剩多少?', '还剩 8 分,上次超速扣了 4 分。'],
  ['孩子的家长会是哪天?', '9 月 20 日下午两点,在三年级二班教室。'],
  ['那批货到港了吗?', '到港了,清关预计还要两天。'],
  ['公司的年假我还剩几天?', '还剩 6 天,年底清零。'],
  ['电影票还有余票吗?', '周六晚场只剩前三排了。'],
  ['厨房水龙头修好了吗?', '师傅换了阀芯,已经不滴水了。'],
  ['那个基金今年跌了多少?', '年内跌了 12%,你的持仓浮亏 3400。'],
  ['牙医预约排到什么时候?', '排到 10 月 8 日上午 10 点。'],
  ['公司门禁卡补办要多久?', '要三个工作日,先去前台登记。'],
  ['姐姐的航班几点落地?', '晚上 11 点 20 落地,我提前一小时叫你。'],
  ['楼下超市几点关门?', '平日十点,周末十一点。'],
  ['我的博客备案通过了吗?', '通过了,备案号已经发到你邮箱。'],
  ['那台旧手机还能回收吗?', '能,官方估价 220 令吉,要清空数据。'],
]

/** 复述的两种形态:原样再问一遍,以及换个说法。 */
const turnText = (i: number, reworded: boolean): string => {
  const [q, a] = TOPICS[i]!
  return reworded ? `User: ${q.replace(/[??]$/, '')}\nButler: ${a}` : `User: ${q}\nButler: ${a}`
}

/** 确定性 PRNG(mulberry32)。固定种子 ⇒ 同一份剧本,两条路跑的是同一件事。 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface RunStat {
  readonly writes: number
  readonly onDisk: number
  readonly bytes: number
  readonly distinctOnDisk: number
  readonly distinctInWindow: number
  /** 维护 tick 里有几成开到了第 ④ 级(压力顶格)—— M3a 的记忆账读出来的。 */
  readonly topRungShare: number
  /** 一万轮里一共被逐出多少条。维护有多吃力,这个数比档位诚实。 */
  readonly evicted: number
}

/** 跑一万轮。`economy` = 接上 M4 新颖门 + M3b 显著性;否则就是今天。 */
async function runScript(
  economy: boolean,
  budgetBytes: number,
): Promise<{ readonly stat: RunStat; readonly rows: readonly MemoryEntry[] }> {
  const rand = rng(20260902)
  let clock = T0
  const memory = makeMemory(() => clock)
  let recent = 0
  let priorRung: LedgerRung = 0
  let ticks = 0
  let topRungTicks = 0
  let evicted = 0

  /** 一次维护 tick:先由记忆账读压力定档(M3a),再执法(M3b 的显著性通不通电见 `economy`)。 */
  const tick = async (): Promise<void> => {
    const rows = await memory.list({ limit: 100_000 })
    const usedBytes = rows.reduce((a, r) => a + entryBytes(r), 0)
    const reading = readLedger([{ store: 'memory', usedBytes, budgetBytes }], priorRung)
    priorRung = reading.rung
    ticks += 1
    if (reading.rung === 4) topRungTicks += 1
    evicted += await maintain(memory, clock, budgetBytes, economy)
  }

  for (let turn = 0; turn < TURNS; turn++) {
    clock = T0 + turn * MINUTE
    const restate = turn > 0 && rand() < RESTATE_RATE
    const topic = restate ? recent : Math.floor(rand() * TOPICS.length)
    recent = topic
    const entry: NewMemoryEntry = {
      kind: 'episodic',
      text: turnText(topic, restate && rand() < 0.5),
      meta: { turn: true, topic },
    }
    if (economy) await rememberNovel(entry, { memory, now: () => clock })
    else await memory.remember(entry)

    if ((turn + 1) % MAINTAIN_EVERY === 0) await tick()
  }
  await tick()

  const rows = await memory.list({ limit: 100_000 })
  const topicOf = (r: MemoryEntry): number => (r.meta as { topic?: number }).topic ?? -1
  const window = rows.slice(0, 20)
  return {
    stat: {
      writes: memory.writes,
      onDisk: rows.length,
      bytes: rows.reduce((s, r) => s + entryBytes(r), 0),
      distinctOnDisk: new Set(rows.map(topicOf)).size,
      distinctInWindow: new Set(window.map(topicOf)).size,
      topRungShare: ticks === 0 ? 0 : topRungTicks / ticks,
      evicted,
    },
    rows,
  }
}

/** 一次维护 tick。两条路的差别只在**显著性通没通电** —— 逐出执法是同一处。 */
async function maintain(
  memory: MemoryHandle,
  now: number,
  budgetBytes: number,
  economy: boolean,
): Promise<number> {
  const r = await enforceBudget({
    memory,
    budgetBytes,
    now: () => now,
    ...(economy
      ? {
          salience: {
            halfLifeMs: DEFAULT_SALIENCE_HALF_LIFE_MS,
            reinforceWeight: DEFAULT_REINFORCE_WEIGHT,
          },
          evictExpiredFirst: true,
        }
      : {}),
  })
  return r?.evicted ?? 0
}

async function act1(): Promise<{
  readonly today: readonly MemoryEntry[]
  readonly economy: readonly MemoryEntry[]
}> {
  console.log('\n═══ 第一幕 —— 一万轮之后,盘上还剩什么 ═══\n')

  // 夹具先自证:四十个话题两两之间都不是近重复,否则「不同话题存活数」这把尺本身就是坏的。
  let worst = 0
  for (let i = 0; i < TOPICS.length; i++) {
    for (let j = 0; j < i; j++) worst = Math.max(worst, mutualCoverage(turnText(i, false), turnText(j, false)))
  }
  check(`四十个话题两两都不近重复(最高双向覆盖 ${worst.toFixed(3)} < 0.8)`, worst < 0.8)

  const budgetBytes = Array.from({ length: BUDGET_ENTRIES }, (_, i) =>
    entryBytes({ id: 'x', kind: 'episodic', text: turnText(i, false), ts: T0, meta: { turn: true, topic: i } }),
  ).reduce((a, b) => a + b, 0)
  console.log(
    `  剧本:${TURNS.toLocaleString()} 轮,${TOPICS.length} 件事,${Math.round(RESTATE_RATE * 100)}% 是复述;` +
      `预算 ${budgetBytes} 字节(约 ${BUDGET_ENTRIES} 条),每 ${MAINTAIN_EVERY} 轮维护一次\n`,
  )

  const { stat: today, rows: todayRows } = await runScript(false, budgetBytes)
  const { stat: economy, rows: economyRows } = await runScript(true, budgetBytes)
  const row = (label: string, s: RunStat): string =>
    `  ${label.padEnd(10)} 写入 ${String(s.writes).padStart(6)} 次 · 盘上 ${String(s.onDisk).padStart(3)} 条 / ` +
    `${String(s.bytes).padStart(5)} 字节(每条 ${String(Math.round(s.bytes / s.onDisk)).padStart(3)}) · ` +
    `不同的事 ${String(s.distinctOnDisk).padStart(2)}/${TOPICS.length} · ` +
    `每条携带 ${(s.distinctOnDisk / s.onDisk).toFixed(2)} 件事 · 召回 20 格里 ${s.distinctInWindow} 件 · ` +
    `一路逐出 ${String(s.evicted).padStart(5)} 条`
  console.log(row('今天', today))
  console.log(row('记忆经济', economy))
  console.log('')

  // ① 不变量。两条路都成立 —— 这是 `enforceBudget` 早就有的功劳,如实说,不算在 M4 头上。
  check(`不变量:字节 ≤ 预算(今天 ${today.bytes} / 经济 ${economy.bytes} ≤ ${budgetBytes})`,
    today.bytes <= budgetBytes && economy.bytes <= budgetBytes)
  check('不变量:一万轮之后条数仍是常量级(两条路都 ≤ 预算条数 + 1)',
    today.onDisk <= BUDGET_ENTRIES + 1 && economy.onDisk <= BUDGET_ENTRIES + 1)

  // ② M4 真正挣到的。注意「条数」这一栏经济反而**更少**(13 对 25)——折叠会让存活的
  // 条目变胖(多带强化计数与边),同样的字节预算装下的条数就少。这不是退步:M4 的字节账
  // 早就量过,折叠付一次性常量、省每次复述的线性项。要看的是下面这两个密度数。
  check(`写入放大:今天写 ${today.writes} 次,经济只写 ${economy.writes} 次(${(today.writes / economy.writes).toFixed(1)} 倍)`,
    economy.writes < today.writes / 4)
  check(`盘上零重复:经济的 ${economy.onDisk} 条正好是 ${economy.distinctOnDisk} 件不同的事`,
    economy.distinctOnDisk === economy.onDisk)
  check(`今天做不到:${today.onDisk} 条里只有 ${today.distinctOnDisk} 件不同的事(其余是复述在占位)`,
    today.distinctOnDisk < today.onDisk)
  check(`同样的字节,装下的不同的事更多(${today.distinctOnDisk} → ${economy.distinctOnDisk} 件)`,
    economy.distinctOnDisk > today.distinctOnDisk)
  check(`召回名额不再被复述占着(20 格里 ${today.distinctInWindow} → ${economy.distinctInWindow} 件不同的事)`,
    economy.distinctInWindow > today.distinctInWindow)
  check(`维护不用再一路扔东西(逐出 ${today.evicted} → ${economy.evicted} 条)`, economy.evicted < today.evicted / 4)

  // M3a 的记忆账如实说:它在这个剧本里**分不出两条路** —— 两边都常年第 ④ 级
  // (见下面那行数字)。原因不是账坏了,是它读的东西不一样:账读的是「这一 tick 攒了
  // 多少压力」,而 200 轮攒下的写入对 25 条的预算来说谁都超得远。M4 减的是**写入次数**,
  // 不是「两次维护之间会不会超预算」。所以这里只报,不当成一项成绩。
  console.log(
    `  记忆账:第 ④ 级 tick 占比 今天 ${(today.topRungShare * 100).toFixed(0)}% / 经济 ` +
      `${(economy.topRungShare * 100).toFixed(0)}% —— 这个剧本下两条路都常年顶格,账分不出高下(见注释)`,
  )

  // 第二幕拿**两条路真的剩在盘上的**条目各灌一次 —— 不是另编一批噪声。
  return { today: todayRows, economy: economyRows }
}

// ───────────────────────────────────────────────────────────────────────────
// 第二幕 —— 洪水过后,跨店召回不掉
// ───────────────────────────────────────────────────────────────────────────

/** 一个七店俱全的成员空间。小,但每一件事都**横跨两个店** —— 单店召回必然答错。 */
function spaceSeed(extra: readonly MemoryEntry[]): IntegrationSpaceSeed {
  const m = (id: string, text: string, day: number): MemoryEntry => ({
    id,
    kind: 'semantic',
    text,
    ts: T0 - day * DAY,
  })
  return {
    entries: [
      m('m-penang', '用户全家打算年底搬到槟城', 30),
      m('m-peanut', '用户对花生过敏,严重时会气喘', 60),
      m('m-weight-goal', '用户的目标体重是 72 公斤', 45),
      ...extra,
    ],
    knowledge: [
      {
        path: 'INDEX.md',
        markdown: ['# 索引', '', '- [[appliances/coffee-machine]] 咖啡机保养', '- [[garden/tomato]] 番茄种植'].join('\n'),
      },
      {
        path: 'appliances/coffee-machine.md',
        markdown: ['# 咖啡机', '', '出水变慢多半是水垢。用柠檬酸泡冲煮头二十分钟,再冲三遍清水。'].join('\n'),
      },
      {
        path: 'garden/tomato.md',
        markdown: ['# 番茄', '', '开花之后每两周施一次薄肥。'].join('\n'),
      },
    ],
    tasks: [
      { title: '订槟城的搬家公司', steps: ['比三家报价', '确认日期'], close: true },
      { title: '给咖啡机除垢', steps: ['买柠檬酸', '泡冲煮头'] },
    ],
    session: [
      { role: 'user', text: '搬家的事我想赶在孩子开学前办完' },
      { role: 'assistant', text: '好的,那要在 12 月中之前搞定。' },
    ],
    dossiers: [
      {
        taskId: 'weight-track',
        objective: '把体重降到目标',
        journal: [{ did: '记录本周体重', facts: ['本周 78 公斤'] }, { did: '记录下周体重', facts: ['下周 77 公斤'] }],
      },
    ],
  }
}

const CASES: readonly IntegrationCase[] = [
  {
    name: 'move-penang',
    category: 'cross-store',
    query: { text: '搬到槟城这件事进展如何' },
    gold: ['memory:m-penang', 'task:tn-1', 'session:u-demo#0'],
    why: '记忆里有意图、任务本里有已收尾的执行、会话窗里有时间约束——三个店各知道一半。',
  },
  {
    name: 'coffee-repair',
    category: 'cross-store',
    query: { text: '咖啡机出水慢要怎么处理' },
    gold: ['knowledge:appliances/coffee-machine.md', 'task:tn-2'],
    why: '办法在知识库、正在做的事在任务本。只到 memory 的召回一个都够不着。',
  },
  {
    name: 'weight-trend',
    category: 'cross-store',
    query: { text: '我的体重最近怎么变化的' },
    gold: ['dossier:weight-track#1', 'dossier:weight-track#2', 'memory:m-weight-goal'],
    why: '趋势在长任务档案里,目标在记忆里。',
  },
  {
    name: 'peanut-allergy',
    category: 'single-store',
    query: { text: '我对什么过敏' },
    gold: ['memory:m-peanut'],
    why: '单店对照组:洪水最容易冲垮的就是这种只靠 memory 的问题。',
  },
]

async function act2(survivors: {
  readonly today: readonly MemoryEntry[]
  readonly economy: readonly MemoryEntry[]
}): Promise<void> {
  console.log('\n═══ 第二幕 —— 一万轮沉淀下来的东西,会不会挤掉跨店召回 ═══\n')
  console.log('  两条路各自剩下的都灌一次。说清楚:经济那一边的干扰项之所以少,正是因为')
  console.log('  第一幕把复述折掉了 —— 所以这一幕量的不是「谁的噪声多」,而是**同一个问题**')
  console.log('  在两种沉淀物底下还答不答得对。\n')
  const root = await mkdtemp(join(tmpdir(), 'gotong-mem-econ-'))
  try {
    const open = async (extra: readonly MemoryEntry[], dir: string) =>
      openIntegrationSpace({
        dir: join(root, dir),
        userId: 'u-demo',
        now: () => T0,
        seed: spaceSeed(extra),
      })

    // `netRecall(space)` 先绑定空间、再交出工厂 —— 直接把 `netRecall` 当工厂传会拿到
    // 一个函数而不是命中列表(第一次就这么写,当场 `rankedIds.slice is not a function`)。
    const run = async (extra: readonly MemoryEntry[], dir: string, label: string) => {
      const space = await open(extra, dir)
      const r = await scoreIntegration(netRecall(space), space, CASES)
      console.log(formatIntegrationResult(label, r))
      return r
    }
    const clean = await run([], 'clean', '干净空间(3 条记忆,无沉淀)')
    const underToday = await run(survivors.today, 'today', `今天沉淀的 ${survivors.today.length} 条底下`)
    const underEconomy = await run(survivors.economy, 'economy', `记忆经济沉淀的 ${survivors.economy.length} 条底下`)
    console.log('')

    const pct = (x: number): string => `${(x * 100).toFixed(1)}%`
    type R = typeof clean
    const cs = (r: R) => r.byCategory['cross-store']!
    const ss = (r: R) => r.byCategory['single-store']!

    check('干净空间本身有分(不是拿两个零分在比)', cs(clean).recallAtK > 0)
    check(`跨店召回:干净 ${pct(cs(clean).recallAtK)} → 经济沉淀底下 ${pct(cs(underEconomy).recallAtK)}(不降)`,
      cs(underEconomy).recallAtK >= cs(clean).recallAtK)
    check(`单店对照:干净 ${pct(ss(clean).recallAtK)} → 经济沉淀底下 ${pct(ss(underEconomy).recallAtK)}(不降)`,
      ss(underEconomy).recallAtK >= ss(clean).recallAtK)
    // 阳性对照,也是这整个 capstone 的正题:**今天的沉淀真的会伤人**。25 条里 15 条是
    // 复述,它们把「我对什么过敏」那条唯一的金标挤出了前五 —— 召回从 100% 掉到 0%。
    // 没有这一条,「经济不降」可能只是因为这份夹具压根伤不到。
    check(`今天的沉淀把单店那一问彻底埋掉(单店召回 ${pct(ss(clean).recallAtK)} → ${pct(ss(underToday).recallAtK)})`,
      ss(underToday).recallAtK < ss(clean).recallAtK)
    check(`经济的沉淀没有(总召回 今天 ${pct(underToday.recallAtK)} / 经济 ${pct(underEconomy.recallAtK)})`,
      underEconomy.recallAtK > underToday.recallAtK)

    // 排名如实说,不许拿「召回不降」当「毫发无损」讲:沉淀确实把单店那一例从第 1 挤到
    // 了第 2。召回守住了,排名有升有降 —— 这就是「不下降」这句话能撑住的准确范围。
    const mrrRow = (label: string, r: R): string =>
      `  ${label.padEnd(16)} 跨店 MRR ${cs(r).mrr.toFixed(3)} · 单店 MRR ${ss(r).mrr.toFixed(3)}`
    console.log(mrrRow('干净', clean))
    console.log(mrrRow('今天沉淀底下', underToday))
    console.log(mrrRow('经济沉淀底下', underEconomy))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 第三幕 —— 用则存不用则忘
// ───────────────────────────────────────────────────────────────────────────

async function act3(): Promise<void> {
  console.log('\n═══ 第三幕 —— 两条一样重要的事实,两个月后只留得下一条 ═══\n')
  let clock = T0
  const memory = makeMemory(() => clock)

  const used = await memory.remember({ kind: 'semantic', text: '用户的常用寄件地址是槟城乔治市海墘街 12 号' })
  const unused = await memory.remember({ kind: 'semantic', text: '用户的备用寄件地址是吉隆坡孟沙南区 8 号' })

  // 头十天里被召回五次 —— 走真的 `reinforcedMeta`,不是手写 meta。
  for (let i = 1; i <= 5; i++) {
    clock = T0 + i * 2 * DAY
    const cur = (await memory.list({ limit: 100 })).find((e) => e.id === used.id)!
    await memory.patchMeta(cur.id, reinforcedMeta(cur, clock))
  }

  const now = T0 + 60 * DAY
  const salience = { halfLifeMs: DEFAULT_SALIENCE_HALF_LIFE_MS, reinforceWeight: DEFAULT_REINFORCE_WEIGHT }
  const rows = await memory.list({ limit: 100 })
  const score = (id: string): number => effectiveSalience(rows.find((e) => e.id === id)!, now, salience)
  console.log(`  半衰期 ${Math.round(DEFAULT_SALIENCE_HALF_LIFE_MS / DAY)} 天 · 强化权重 ${DEFAULT_REINFORCE_WEIGHT}`)
  console.log(`  被召回 5 次的那条  显著性 ${score(used.id).toFixed(3)}`)
  console.log(`  从没被碰过的那条    显著性 ${score(unused.id).toFixed(3)}`)
  console.log('')

  // 预算只装得下一条(取两条里更胖的那条 —— 强化过的那条 meta 更大)。
  const budgetBytes = Math.max(...rows.map(entryBytes))
  await enforceBudget({ memory, budgetBytes, now: () => now, salience, evictExpiredFirst: true })
  const left = (await memory.list({ limit: 100 })).map((e) => e.id)

  check('两条事实一开始一样重要、一样新(差别只有用没用过)', rows.every((r) => r.ts === T0))
  check('被召回过的那条还在', left.includes(used.id))
  check('从没被碰过的那条凉下去了', !left.includes(unused.id))
}

async function main(): Promise<void> {
  console.log('记忆经济 capstone —— 万轮不膨胀 / 跨店召回 / 用则存不用则忘')
  const survivors = await act1()
  await act2(survivors)
  await act3()

  console.log('\n═══ 收尾账本 —— 五项里程碑各归其位 ═══\n')
  console.log('  M1 尺子   : scoreIntegration(跨店 recall@k / MRR)—— 第二幕就是拿它量的。')
  console.log('  M2 网     : buildMemoryNet + crossStoreRecall —— 第二幕一次召回走遍七个店。')
  console.log('  M3 账     : readLedger 四级阶梯(第一幕每个 tick 先读压力定档)+ 通了电的 effectiveSalience\n              (第一幕的逐出、第三幕的存亡)。')
  console.log('  M4 门     : rememberNovel —— 第一幕把一万轮压成两千次写入,盘上零重复。')
  console.log('  M5 本篇   : 三件事合在一份剧本上,退出码就是判据。')
  console.log('\n  北极星:全程框架跑了 0 个模型。新颖门、记忆账、显著性、逐出、跨店扩散全是纯函数;')
  console.log('  唯一会调模型的 6h 蒸馏链在这里根本没上场。固定钟、零凭证、可复现。\n')

  if (failures.length > 0) {
    console.error(`✗ 记忆经济 capstone 失败:${failures.length} 项未通过`)
    for (const f of failures) console.error(`    · ${f}`)
    process.exit(1)
  }
  console.log('✓ 记忆经济 capstone 全数通过:万轮不膨胀 · 跨店召回不掉 · 用则存不用则忘。')
}

main().catch((err) => {
  console.error('记忆经济 capstone 崩溃:', err)
  process.exit(1)
})
