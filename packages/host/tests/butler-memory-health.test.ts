/**
 * M-HEALTH 承重门 — 「后台维护整整两周全线失败,而外面一点动静都没有」。
 *
 * 病根不是某一行写错了,是三件各自正确的事合起来撒了谎:`composeReviewers`
 * 把抛错的 pass 折成一句 `review error: …` 摘要(对的,一个坏 pass 不该饿死
 * 其余的),`maintainOne` 把摘要交上去,sweeper 的 `if (summary) active++` 于是
 * 把「一句道歉」读成「干了活」,最后落一行 `level:"info"` `sweep complete`。
 *
 * 所以这道门的承重断言不是「台账写对了」,是**那条 warn 真的会出现,而那条
 * info 真的不会**——把 bug 本身钉在原地:真 tmp 命名空间、真 40 条 episodic、
 * 一个 `stream()` 一定抛的 provider,走生产那条 `runOnce()`。
 *
 * 四组:
 *   A 纯折叠(`foldMaintenanceSweep`)—— 高水位 / 连败计数 / 样本上限;
 *   B 台账读写 —— 缺席与损坏都收敛成 **未知(null)**,写盘失败永不抛;
 *   C 巡检牌(`memoryMaintenanceCard`)—— **台账缺席 ⇒ 不出牌**(承重:未知不是坏);
 *   D 扫描三分 e2e —— 上面那条 warn / info 的真身;
 *   E `my_status` 的记忆行 —— 缺席那半句字节不变,连败/停摆才多说一句。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@gotong/core'
import type { LlmProvider, LlmStreamChunk } from '@gotong/llm'
import type { MemoryHandle } from '@gotong/services-sdk'

import {
  MEMORY_FAILED_SWEEPS_THRESHOLD,
  MEMORY_STALE_MS,
  foldMaintenanceSweep,
  readButlerMemoryHealth,
  recordMaintenanceSweep,
  type ButlerMemoryHealth,
} from '../src/butler-memory-health.js'
import { ButlerMaintenanceSweeper } from '../src/personal-butler-maintenance.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import {
  MEMORY_MAINTENANCE_CARD_ID,
  memoryMaintenanceCard,
} from '../src/personal-butler-patrol.js'
import { renderSelfStatus } from '../src/personal-butler-self-status.js'

const HOUR = 60 * 60 * 1000
const NOW = 1_800_000_000_000

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

/** 记下每条日志行,给 D 组断言「哪条出现了、哪条没有」。 */
interface LogLine { level: string; msg: string; meta?: Record<string, unknown> }
function capturingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = []
  const push = (level: string) => (msg: string, meta?: Record<string, unknown>) => {
    lines.push(meta === undefined ? { level, msg } : { level, msg, meta })
  }
  const logger: Logger = {
    trace: push('trace'), debug: push('debug'), info: push('info'),
    warn: push('warn'), error: push('error'), fatal: push('fatal'),
    child() { return logger },
  }
  return { logger, lines }
}

/** 一份健康的台账基线,各组按需覆写。 */
function health(over: Partial<ButlerMemoryHealth> = {}): ButlerMemoryHealth {
  return {
    v: 1,
    checkedAt: NOW,
    members: 2,
    active: 2,
    failed: 0,
    lastOkAt: NOW,
    consecutiveFailedSweeps: 0,
    lastErrors: [],
    ...over,
  }
}

/** 往一个成员的管家命名空间里种 `count` 条 episodic(40 条越过 32 的触发线)。 */
async function seedEpisodic(rootDir: string, userId: string, count: number): Promise<void> {
  let clock = 1000
  const mem: MemoryHandle = openButlerMemory({
    rootDir, userId, logger: silentLogger, now: () => clock++,
  })
  for (let i = 0; i < count; i++) {
    await mem.remember({ kind: 'episodic', text: `主人在聊第 ${i} 件事：奶茶店的事情`, meta: { importance: 2 } })
  }
}

/** 一个 `stream()` 必抛的 provider —— 生产上「MiMo 挂了」的那一趟。 */
const boomProvider: LlmProvider = {
  name: 'boom',
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<LlmStreamChunk> {
    throw new Error('MiMo 502 upstream')
  },
}

// ---------------------------------------------------------------------------
// A — 纯折叠
// ---------------------------------------------------------------------------

describe('M-HEALTH A — foldMaintenanceSweep(纯函数)', () => {
  it('干净一轮:连败归零、lastOkAt 落在这一刻、错误样本清空', () => {
    const prev = health({ consecutiveFailedSweeps: 5, lastErrors: ['old boom'], lastOkAt: NOW - 9 * HOUR })
    const next = foldMaintenanceSweep(prev, { at: NOW, members: 3, active: 2, failed: 0, errors: [] })
    expect(next.consecutiveFailedSweeps).toBe(0)
    expect(next.lastOkAt).toBe(NOW)
    expect(next.lastErrors).toEqual([])
    expect(next.members).toBe(3)
    expect(next.active).toBe(2)
  })

  it('从没成功过的失败一轮:lastOkAt 缺席(不许凭空造一个成功时刻)', () => {
    const next = foldMaintenanceSweep(null, { at: NOW, members: 1, active: 0, failed: 1, errors: ['boom'] })
    expect(next.lastOkAt).toBeUndefined()
    expect(next.consecutiveFailedSweeps).toBe(1)
    expect(next.lastErrors).toEqual(['boom'])
  })

  it('承重 — 失败一轮把上一次的 lastOkAt 原样抬过去(高水位)', () => {
    // 「多久没成功过」这个问题只在失败的时候才有人问;失败那一轮把答案丢掉,
    // 恰好是在最需要它的时刻失去它。
    const prev = health({ lastOkAt: NOW - 50 * HOUR, consecutiveFailedSweeps: 1 })
    const next = foldMaintenanceSweep(prev, { at: NOW, members: 1, active: 0, failed: 1, errors: ['x'] })
    expect(next.lastOkAt).toBe(NOW - 50 * HOUR)
    expect(next.consecutiveFailedSweeps).toBe(2)
  })

  it('样本至多 3 条、各截 200 字,空白折成一行', () => {
    const long = `${'あ'.repeat(400)}`
    const next = foldMaintenanceSweep(null, {
      at: NOW, members: 5, active: 0, failed: 5,
      errors: ['a\n\n  b', long, 'c', 'd', 'e'],
    })
    expect(next.lastErrors).toHaveLength(3)
    expect(next.lastErrors[0]).toBe('a b')
    expect(next.lastErrors[1]!.length).toBe(201) // 200 + 省略号
    expect(next.lastErrors[1]!.endsWith('…')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// B — 台账读写
// ---------------------------------------------------------------------------

describe('M-HEALTH B — 台账读写(读者永不抛)', () => {
  let root: string
  let file: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-mem-health-'))
    file = join(root, 'butler', 'memory-health.json')
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('不存在 ⇒ null(未知,不是健康也不是坏)', async () => {
    expect(await readButlerMemoryHealth(file)).toBeNull()
  })

  it('损坏 / 形状不对 ⇒ null,不抛', async () => {
    await recordMaintenanceSweep(file, { at: NOW, members: 1, active: 1, failed: 0, errors: [] })
    await writeFile(file, 'not json {{{', 'utf8')
    expect(await readButlerMemoryHealth(file)).toBeNull()
    await writeFile(file, JSON.stringify({ v: 2, checkedAt: NOW }), 'utf8')
    expect(await readButlerMemoryHealth(file)).toBeNull()
  })

  it('round-trip:目录自动建,连败跨轮累加,干净一轮归零', async () => {
    const a = await recordMaintenanceSweep(file, { at: NOW, members: 1, active: 0, failed: 1, errors: ['boom1'] })
    expect(a.consecutiveFailedSweeps).toBe(1)
    const b = await recordMaintenanceSweep(file, { at: NOW + HOUR, members: 1, active: 0, failed: 1, errors: ['boom2'] })
    expect(b.consecutiveFailedSweeps).toBe(2)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(b) // 盘上就是它
    const c = await recordMaintenanceSweep(file, { at: NOW + 2 * HOUR, members: 1, active: 1, failed: 0, errors: [] })
    expect(c.consecutiveFailedSweeps).toBe(0)
    expect(c.lastOkAt).toBe(NOW + 2 * HOUR)
    expect(await readButlerMemoryHealth(file)).toEqual(c)
  })

  it('写不进去只 warn,绝不抛(账是派生物,不能连累维护本身)', async () => {
    // 拿一个普通文件当目录用 ⇒ mkdir 必 ENOTDIR。
    const blocker = join(root, 'blocker')
    await writeFile(blocker, 'x', 'utf8')
    const { logger, lines } = capturingLogger()
    const out = await recordMaintenanceSweep(
      join(blocker, 'nested', 'memory-health.json'),
      { at: NOW, members: 1, active: 1, failed: 0, errors: [] },
      logger,
    )
    expect(out.checkedAt).toBe(NOW) // 仍算出了这一轮的结论
    expect(lines.some((l) => l.level === 'warn' && l.msg.includes('health ledger write failed'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// C — 巡检牌
// ---------------------------------------------------------------------------

describe('M-HEALTH C — memoryMaintenanceCard', () => {
  it('承重 — 台账缺席 ⇒ 不出牌(未知不是坏)', () => {
    // 一台还没扫过第一轮、或压根没接台账的 hub 不该自称有病。
    expect(memoryMaintenanceCard(null, NOW)).toBeNull()
  })

  it('健康 ⇒ 不出牌', () => {
    expect(memoryMaintenanceCard(health(), NOW)).toBeNull()
  })

  it('只错一轮 ⇒ 还不出牌(门槛是 2,跨过单次抖动)', () => {
    expect(MEMORY_FAILED_SWEEPS_THRESHOLD).toBe(2)
    const h = health({ failed: 1, active: 0, consecutiveFailedSweeps: 1, lastErrors: ['boom'] })
    expect(memoryMaintenanceCard(h, NOW)).toBeNull()
  })

  it('连错到门槛 ⇒ 黄牌,带稳定 id 与一条错误样本', () => {
    const h = health({
      failed: 2, active: 0,
      consecutiveFailedSweeps: MEMORY_FAILED_SWEEPS_THRESHOLD,
      lastErrors: ['review error: MiMo 502 upstream'],
    })
    const card = memoryMaintenanceCard(h, NOW)
    expect(card).not.toBeNull()
    expect(card!.id).toBe(MEMORY_MAINTENANCE_CARD_ID)
    expect(card!.severity).toBe('yellow')
    expect(card!.fact).toContain('连续 2 轮维护出错')
    expect(card!.fact).toContain('MiMo 502 upstream')
  })

  it('从没失败但很久没跑成 ⇒ 停摆牌(sweeper 自己没转起来的形态)', () => {
    // 这一支才抓得住「压根不产生新失败记录」的那种死法。
    const h = health({ lastOkAt: NOW - MEMORY_STALE_MS - HOUR, consecutiveFailedSweeps: 0 })
    const card = memoryMaintenanceCard(h, NOW)
    expect(card).not.toBeNull()
    expect(card!.severity).toBe('yellow')
    expect(card!.fact).toContain('没有成功跑过一轮维护')
  })

  it('刚过一轮 6h 还没到停摆线 ⇒ 不出牌', () => {
    expect(memoryMaintenanceCard(health({ lastOkAt: NOW - 7 * HOUR }), NOW)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// D — 扫描三分(bug 本身)
// ---------------------------------------------------------------------------

describe('M-HEALTH D — 扫描三分:抛错的 pass 不算 active', () => {
  let root: string
  let memRoot: string
  let healthFile: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-mem-health-sweep-'))
    memRoot = join(root, 'butler', 'memory')
    healthFile = join(root, 'butler', 'memory-health.json')
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('承重 — provider 抛 ⇒ warn 出现、info「sweep complete」不出现、台账记 failed', async () => {
    await seedEpisodic(memRoot, 'alice', 40)
    const { logger, lines } = capturingLogger()
    await new ButlerMaintenanceSweeper({
      rootDir: memRoot,
      buildProvider: async () => boomProvider,
      logger,
      now: () => NOW,
      healthFile,
    }).runOnce()

    // 这两条就是那两周里本该出现 / 本不该出现的东西。
    const warned = lines.find((l) => l.level === 'warn' && l.msg === 'butler maintenance: sweep completed with failures')
    expect(warned).toBeDefined()
    expect(warned!.meta).toMatchObject({ members: 1, active: 0, failed: 1 })
    expect(lines.some((l) => l.msg === 'butler maintenance: sweep complete')).toBe(false)

    const rec = await readButlerMemoryHealth(healthFile)
    expect(rec).not.toBeNull()
    expect(rec!.failed).toBe(1)
    expect(rec!.active).toBe(0)
    expect(rec!.lastOkAt).toBeUndefined()
    expect(rec!.consecutiveFailedSweeps).toBe(1)
    expect(rec!.lastErrors.join(' ')).toContain('MiMo 502 upstream')

    // 连着两轮就够出牌了 —— 这才是从「日志里有一行」到「人被告知」的那一段。
    await new ButlerMaintenanceSweeper({
      rootDir: memRoot, buildProvider: async () => boomProvider,
      logger: silentLogger, now: () => NOW + 6 * HOUR, healthFile,
    }).runOnce()
    const card = memoryMaintenanceCard(await readButlerMemoryHealth(healthFile), NOW + 6 * HOUR)
    expect(card?.id).toBe(MEMORY_MAINTENANCE_CARD_ID)
  })

  it('没有 provider 的那一趟什么都不写(没配 key 的 hub 不该第一天就自称有病)', async () => {
    await seedEpisodic(memRoot, 'alice', 40)
    await new ButlerMaintenanceSweeper({
      rootDir: memRoot, buildProvider: async () => null,
      logger: silentLogger, now: () => NOW, healthFile,
    }).runOnce()
    expect(await readButlerMemoryHealth(healthFile)).toBeNull()
  })

  it('不给 healthFile ⇒ 一个字节都不落(pre-M-HEALTH 调用点不变)', async () => {
    await seedEpisodic(memRoot, 'alice', 40)
    await new ButlerMaintenanceSweeper({
      rootDir: memRoot, buildProvider: async () => boomProvider,
      logger: silentLogger, now: () => NOW,
    }).runOnce()
    expect(await readButlerMemoryHealth(healthFile)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// E — my_status 的记忆行
// ---------------------------------------------------------------------------

describe('M-HEALTH E — my_status 记忆行说真话', () => {
  const memReader = {
    read: async () => ({ profile: [{ text: 'a' }], recent: [], lastDream: { firedAt: NOW - 2 * HOUR, promoted: 1, pruned: 0 } }),
  }

  it('台账未接 ⇒ 那半句一个字不加', async () => {
    const out = await renderSelfStatus({ userId: 'u1', memory: memReader, now: () => NOW })
    expect(out).toContain('- 记忆:长期 1 条,近期 0 条;上次蒸馏 2 小时前(提升 1 条,封存 0 条)\n')
  })

  it('台账健康 ⇒ 同样不加(每轮报一句「维护正常」是噪音)', async () => {
    const out = await renderSelfStatus({
      userId: 'u1', memory: memReader, memoryHealth: async () => health(), now: () => NOW,
    })
    expect(out).not.toContain('⚠️ 后台维护')
  })

  it('连败 ⇒ 记忆行多一句「长期记忆正停在旧样子」', async () => {
    const out = await renderSelfStatus({
      userId: 'u1', memory: memReader, now: () => NOW,
      memoryHealth: async () => health({ consecutiveFailedSweeps: 3, failed: 1, active: 0 }),
    })
    expect(out).toContain('⚠️ 后台维护连续 3 轮出错,长期记忆正停在旧样子')
  })

  it('停摆 ⇒ 记忆行多一句「看着是停了」', async () => {
    const out = await renderSelfStatus({
      userId: 'u1', memory: memReader, now: () => NOW,
      memoryHealth: async () => health({ lastOkAt: NOW - MEMORY_STALE_MS - HOUR }),
    })
    expect(out).toContain('⚠️ 后台维护上次跑成还是')
    expect(out).toContain('看着是停了')
  })

  it('台账读挂了只 warn,自检卡照出(读者永不连累整张卡)', async () => {
    const { logger, lines } = capturingLogger()
    const out = await renderSelfStatus({
      userId: 'u1', memory: memReader, now: () => NOW, logger,
      memoryHealth: async () => { throw new Error('disk on fire') },
    })
    expect(out).toContain('- 记忆:长期 1 条')
    expect(out).not.toContain('⚠️ 后台维护')
    expect(lines.some((l) => l.level === 'warn')).toBe(true)
  })
})
