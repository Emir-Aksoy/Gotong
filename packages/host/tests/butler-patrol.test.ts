/**
 * CARE-M3 — 主动巡检验收门(计划逐条):
 *
 *   1. 注入时钟 E2E:制造黄牌(拔 IM token 配置 ⇒ 体检 imBridges=[])→
 *      恰一次播报(事实一句 + 「回『为什么』我展开」);
 *   2. 不修 → 下轮不重播(状态文件边沿 dedup,含跨重启);
 *   3. 修复 → 恢复播报恰一次;
 *   4. 全程 mock LLM 计数 = 0 —— 结构性成立:巡检 sweeper 的构造参数里
 *      根本没有 provider 位(类型层保证);测试里再放一个哨兵计数器,
 *      全程无人能碰它;
 *   5. 只有开了运行播报的成员收到(骑 BE-M5 同意面,零新旋钮)。
 *
 * 另附纯函数核单测:牌面推导(imBridges 缺席=不知道≠零通道)、diff
 * 边沿、状态损坏当空、文案模板(溢出帽)。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@gotong/core'

import type { AdminHealthSurface, HealthSnapshot } from '../src/admin-health.js'
import {
  ButlerPatrolSweeper,
  OUTAGE_CARD_ID,
  OUTAGE_ESCALATION_MS,
  derivePatrolCards,
  diffPatrolCards,
  outageEscalationCard,
  patrolAppearMessage,
  patrolRecoverMessage,
} from '../src/personal-butler-patrol.js'
import { writeButlerRunBroadcastConfig } from '../src/personal-butler-run-broadcast.js'

const silentLogger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }

/** 全绿快照打底;用例按需拨坏单项。 */
function greenSnapshot(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    agents: [],
    agentsMissingKey: 0,
    managedCount: 0,
    onlineCount: 0,
    mcpServers: [],
    mcpUnwired: 0,
    spaceWritable: true,
    spacePath: '/space',
    checkedAt: '2026-07-06T00:00:00.000Z',
    ...over,
  }
}

describe('CARE-M3 纯函数核 — derivePatrolCards', () => {
  it('全绿 → 零牌;各病灶各出一张,红先黄后', () => {
    expect(derivePatrolCards(greenSnapshot())).toEqual([])

    const cards = derivePatrolCards(
      greenSnapshot({
        spaceWritable: false,
        agents: [
          { id: 'writer', provider: 'anthropic', missingKey: true, online: false },
          { id: 'ok-agent', provider: 'openai', missingKey: false, online: true },
        ],
        imBridges: [],
        mcpServers: [
          { name: 'calendar', wired: false },
          { name: 'notes', wired: true },
        ],
        connectorSlots: [{ pack: 'morning-brief', id: 'calendar', optional: true, filled: false }],
      }),
    )
    expect(cards.map((c) => c.id)).toEqual([
      'space:unwritable',
      'agent-key:writer',
      'connector:morning-brief/calendar',
      'im:none',
      'mcp-unwired:calendar',
    ])
    expect(cards[0]!.severity).toBe('red')
    expect(cards.slice(1).every((c) => c.severity === 'yellow')).toBe(true)
  })

  it('imBridges 缺席 = 诚实的「不知道」,不发牌;空数组才是零通道', () => {
    expect(derivePatrolCards(greenSnapshot()).some((c) => c.id === 'im:none')).toBe(false)
    expect(derivePatrolCards(greenSnapshot({ imBridges: [] })).map((c) => c.id)).toEqual(['im:none'])
    expect(
      derivePatrolCards(greenSnapshot({ imBridges: [{ platform: 'telegram' }] })).some((c) => c.id === 'im:none'),
    ).toBe(false)
  })

  it('diff:新牌 / 恢复 / 不变', () => {
    const prev = {
      'im:none': { severity: 'yellow' as const, label: 'IM 通道全无', since: 1 },
      'agent-key:w': { severity: 'yellow' as const, label: 'Agent「w」缺 API key', since: 1 },
    }
    const current = derivePatrolCards(greenSnapshot({ imBridges: [] }))
    const { appeared, recovered } = diffPatrolCards(prev, current)
    expect(appeared).toEqual([]) // im:none 还在,不是新牌
    expect(recovered.map((c) => c.label)).toEqual(['Agent「w」缺 API key'])
  })

  it('文案模板:红黄标记 + 溢出帽 + 「为什么」尾巴', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      id: `agent-key:a${i}`,
      severity: 'yellow' as const,
      label: `Agent「a${i}」缺 API key`,
      fact: `Agent「a${i}」的 key 解析不到。`,
    }))
    const msg = patrolAppearMessage(many)
    expect(msg).toContain('⚠️ 巡检发现新问题:')
    expect(msg).toContain('🟡 Agent「a0」的 key 解析不到。')
    expect(msg).toContain('还有 2 项')
    expect(msg).toContain('回「为什么」我展开细讲。')
    expect(patrolRecoverMessage([{ severity: 'yellow', label: 'IM 通道全无', since: 1 }])).toBe(
      '✅ 巡检:「IM 通道全无」已恢复。',
    )
  })

  it('diff 的 recovered 带 id(CARE-M6 恢复静默按 id 过滤,不靠 label)', () => {
    const prev = { 'llm:outage': { severity: 'red' as const, label: '管家大脑持续断供', since: 1 } }
    const { recovered } = diffPatrolCards(prev, [])
    expect(recovered).toEqual([{ id: 'llm:outage', severity: 'red', label: '管家大脑持续断供', since: 1 }])
  })
})

describe('CARE-M6 纯函数核 — outageEscalationCard', () => {
  const T0 = 1_000_000

  it('无断供 → null', () => {
    expect(outageEscalationCard(null, T0, OUTAGE_ESCALATION_MS)).toBe(null)
  })

  it('断供但没到阈值 → null(不抢 CARE-M2 的即时「坏了」)', () => {
    const outage = { kind: 'network' as const, since: T0 - 10 * 60_000, announced: true } // 断了 10 分钟
    expect(outageEscalationCard(outage, T0, OUTAGE_ESCALATION_MS)).toBe(null)
  })

  it('持续超阈值 → 红牌,带分钟数 + 病名(CARE-M1 翻译表)+ 稳定 id', () => {
    const outage = { kind: 'auth' as const, since: T0 - 31 * 60_000, announced: true }
    const card = outageEscalationCard(outage, T0, OUTAGE_ESCALATION_MS)
    expect(card).not.toBe(null)
    expect(card!.id).toBe(OUTAGE_CARD_ID)
    expect(card!.severity).toBe('red')
    expect(card!.fact).toContain('31 分钟')
    expect(card!.fact).toContain('API key') // auth 病名走翻译表
    expect(card!.fact).toContain('命令面') // 断供期间命令仍可用
  })

  it('since 在未来(时钟偏移/损坏)→ downMs 负 → null,不出牌', () => {
    const outage = { kind: 'timeout' as const, since: T0 + 5 * 60_000, announced: true }
    expect(outageEscalationCard(outage, T0, OUTAGE_ESCALATION_MS)).toBe(null)
  })
})

describe('CARE-M3 E2E — 注入时钟 + 边沿播报 + 同意面', () => {
  let dir: string
  let memoryRoot: string
  let stateFile: string
  let pushes: Array<{ userId: string; text: string }>
  let snapshot: HealthSnapshot
  let snapshotCalls: number
  let health: AdminHealthSurface
  // 哨兵:任何 LLM 调用都会 ++。巡检构造参数里没有 provider 位,结构上
  // 没人能碰它——测试尾部断 0,即计划的「全程 mock LLM 计数 = 0」。
  let llmCalls: number

  const makeSweeper = (now: () => number): ButlerPatrolSweeper =>
    new ButlerPatrolSweeper({
      stateFile,
      memoryRoot,
      health: () => health,
      push: async (userId, text) => {
        pushes.push({ userId, text })
        return { delivered: true }
      },
      logger: silentLogger,
      now,
    })

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gotong-patrol-'))
    memoryRoot = join(dir, 'butler', 'memory')
    stateFile = join(dir, 'butler', 'patrol-state.json')
    pushes = []
    llmCalls = 0
    snapshotCalls = 0
    snapshot = greenSnapshot({ imBridges: [{ platform: 'telegram' }] })
    health = {
      snapshot: async () => {
        snapshotCalls++
        return snapshot
      },
    }
    // 同意面:alice 开了运行播报(骑同一份),bob 明确关,carol 从未配置。
    await writeButlerRunBroadcastConfig(memoryRoot, 'alice', { enabled: true, announcedMax: 0 })
    await writeButlerRunBroadcastConfig(memoryRoot, 'bob', { enabled: false, announcedMax: 0 })
    mkdirSync(join(memoryRoot, 'user', 'carol'), { recursive: true })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('黄牌出现播一次;不修不重播(含跨重启);修复恢复播一次;只有同意的成员收到;零 LLM', async () => {
    let clock = 1_000
    const sweeper = makeSweeper(() => clock)

    // ⓪ 全绿起步:一轮巡检,无边沿,无播报。
    await sweeper.runOnce()
    expect(pushes).toEqual([])

    // ① 拔 IM token 配置 ⇒ 体检 imBridges 变空 ⇒ 黄牌边沿,恰一次播报。
    clock = 2_000
    snapshot = greenSnapshot({ imBridges: [] })
    await sweeper.runOnce()
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.userId).toBe('alice') // bob 关了、carol 没配置——同意面
    expect(pushes[0]!.text).toContain('巡检发现新问题')
    expect(pushes[0]!.text).toContain('IM 通道一个都没挂')
    expect(pushes[0]!.text).toContain('回「为什么」我展开细讲')
    expect(existsSync(stateFile)).toBe(true)

    // ② 不修 → 下轮不重播。
    clock = 3_000
    await sweeper.runOnce()
    expect(pushes).toHaveLength(1)

    // ③ 跨重启 dedup:新 sweeper 实例,同一状态文件。
    const rebooted = makeSweeper(() => 4_000)
    await rebooted.runOnce()
    expect(pushes).toHaveLength(1)

    // ④ 修复(IM 桥回来了)→ 恢复播报恰一次,状态里牌清掉。
    snapshot = greenSnapshot({ imBridges: [{ platform: 'telegram' }] })
    await rebooted.runOnce()
    expect(pushes).toHaveLength(2)
    expect(pushes[1]!.userId).toBe('alice')
    expect(pushes[1]!.text).toContain('「IM 通道全无」已恢复')
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ cards: {} })

    // ⑤ 继续全绿 → 不重复报平安。
    await rebooted.runOnce()
    expect(pushes).toHaveLength(2)

    // ⑥ 零 LLM:哨兵计数器全程没人碰(结构性——sweeper 没有 provider 位);
    //    每轮恰好一次体检快照读(⓪→⑤共 6 次 runOnce)。
    expect(llmCalls).toBe(0)
    expect(snapshotCalls).toBe(6)
  })

  it('多张牌同轮出现合并成一条消息;since 保持首次发现时间', async () => {
    let clock = 10_000
    const sweeper = makeSweeper(() => clock)
    snapshot = greenSnapshot({
      imBridges: [],
      agents: [{ id: 'writer', provider: 'anthropic', missingKey: true, online: false }],
    })
    await sweeper.runOnce()
    expect(pushes).toHaveLength(1) // 两张牌一条消息(涓流不是连环炮)
    expect(pushes[0]!.text).toContain('IM 通道')
    expect(pushes[0]!.text).toContain('Agent「writer」')

    const state1 = JSON.parse(readFileSync(stateFile, 'utf8')) as { cards: Record<string, { since: number }> }
    expect(state1.cards['im:none']!.since).toBe(10_000)

    clock = 20_000
    await sweeper.runOnce() // 牌面没变——since 不动
    const state2 = JSON.parse(readFileSync(stateFile, 'utf8')) as { cards: Record<string, { since: number }> }
    expect(state2.cards['im:none']!.since).toBe(10_000)
  })

  it('状态文件损坏当空:重报一次而不是崩', async () => {
    mkdirSync(join(dir, 'butler'), { recursive: true })
    writeFileSync(stateFile, 'not json at all', 'utf8')
    snapshot = greenSnapshot({ imBridges: [] })
    const sweeper = makeSweeper(() => 5_000)
    await sweeper.runOnce()
    expect(pushes).toHaveLength(1) // 当空 ⇒ 视作新牌,宁重不漏
  })

  it('体检自己 throw:状态不动、无播报、不崩,下轮恢复正常', async () => {
    const sweeper = makeSweeper(() => 6_000)
    snapshot = greenSnapshot({ imBridges: [] })
    await sweeper.runOnce()
    expect(pushes).toHaveLength(1)

    health = {
      snapshot: async () => {
        throw new Error('health probe exploded')
      },
    }
    await sweeper.runOnce() // 不算牌面变化
    expect(pushes).toHaveLength(1)

    health = { snapshot: async () => greenSnapshot({ imBridges: [{ platform: 'telegram' }] }) }
    await sweeper.runOnce()
    expect(pushes).toHaveLength(2) // 恢复边沿照常
    expect(pushes[1]!.text).toContain('已恢复')
  })

  it('没人同意 → 边沿照记账(状态前进),但一条不发', async () => {
    rmSync(join(memoryRoot, 'user', 'alice'), { recursive: true, force: true })
    snapshot = greenSnapshot({ imBridges: [] })
    const sweeper = makeSweeper(() => 7_000)
    await sweeper.runOnce()
    expect(pushes).toEqual([])
    // fire=attempt:状态已经记下这张牌,以后有人开播报也不会翻旧账重播。
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { cards: Record<string, unknown> }
    expect(Object.keys(state.cards)).toEqual(['im:none'])
  })
})

describe('CARE-M6 E2E — 长断供升级卡(巡检读断供文件,恢复静默)', () => {
  let dir: string
  let memoryRoot: string
  let stateFile: string
  let outageFile: string
  let pushes: Array<{ userId: string; text: string }>
  let snapshot: HealthSnapshot
  let health: AdminHealthSurface

  const makeSweeper = (now: () => number): ButlerPatrolSweeper =>
    new ButlerPatrolSweeper({
      stateFile,
      memoryRoot,
      health: () => health,
      push: async (userId, text) => {
        pushes.push({ userId, text })
        return { delivered: true }
      },
      logger: silentLogger,
      now,
      outageFile,
      // 阈值走默认(30 分钟);用注入时钟把「已断供多久」拨过/拨不过它。
    })

  /** 写断供状态文件(CARE-M2 的形状);删它 = provider 恢复(onProviderSuccess 清盘)。 */
  const writeOutage = (kind: string, since: number): void => {
    mkdirSync(dirname(outageFile), { recursive: true })
    writeFileSync(outageFile, JSON.stringify({ kind, since, announced: true }), 'utf8')
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gotong-patrol-outage-'))
    memoryRoot = join(dir, 'butler', 'memory')
    stateFile = join(dir, 'butler', 'patrol-state.json')
    outageFile = join(dir, 'runtime', 'llm-outage.json')
    pushes = []
    // 全绿 health(IM 桥在场)——隔离出断供牌,不与 health 牌混。
    snapshot = greenSnapshot({ imBridges: [{ platform: 'telegram' }] })
    health = { snapshot: async () => snapshot }
    await writeButlerRunBroadcastConfig(memoryRoot, 'alice', { enabled: true, announcedMax: 0 })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('阈值内不升级;超阈值升级红牌播一次;不修不重播;文件清掉后恢复静默', async () => {
    const T0 = 1_000_000

    // ① 刚断供(阈值内)→ 不升级:不抢 CARE-M2 那声即时「坏了」。
    writeOutage('network', T0)
    await makeSweeper(() => T0 + 10 * 60_000).runOnce() // 才 10 分钟
    expect(pushes).toEqual([])

    // ② 持续超阈值 → 升级红牌,恰一次,发给同意的 alice。
    await makeSweeper(() => T0 + 31 * 60_000).runOnce()
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.userId).toBe('alice')
    expect(pushes[0]!.text).toContain('巡检发现新问题')
    expect(pushes[0]!.text).toContain('🔴')
    expect(pushes[0]!.text).toContain('断供约 31 分钟')

    // ③ 还没好 → 下轮不重播(边沿 dedup)。
    await makeSweeper(() => T0 + 45 * 60_000).runOnce()
    expect(pushes).toHaveLength(1)

    // ④ provider 恢复(断供文件被 onProviderSuccess 清)→ 巡检恢复**静默**:
    //    「✅ 恢复了」交给 CARE-M2/M5,巡检不重复;状态里的升级牌照常清掉。
    rmSync(outageFile, { force: true })
    await makeSweeper(() => T0 + 46 * 60_000).runOnce()
    expect(pushes).toHaveLength(1) // 没有第二条——恢复静默
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { cards: Record<string, unknown> }
    expect(OUTAGE_CARD_ID in state.cards).toBe(false) // 牌已清,bookkeeping 照常
  })

  it('升级红牌与 health 黄牌同轮 → 合并一条消息', async () => {
    const T0 = 2_000_000
    writeOutage('quota', T0)
    snapshot = greenSnapshot({ imBridges: [] }) // 顺手拨出一张 im:none 黄牌
    await makeSweeper(() => T0 + 40 * 60_000).runOnce()
    expect(pushes).toHaveLength(1) // 一条消息,涓流不连环炮
    expect(pushes[0]!.text).toContain('断供') // 红牌
    expect(pushes[0]!.text).toContain('IM 通道') // 黄牌
  })

  it('断供文件不存在 → 无断供牌(与不接 outageFile 的 CARE-M3 字节一致)', async () => {
    const T0 = 3_000_000
    // 不写 outageFile。
    await makeSweeper(() => T0).runOnce()
    expect(pushes).toEqual([])
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { cards: Record<string, unknown> }
    expect(state.cards).toEqual({})
  })
})
