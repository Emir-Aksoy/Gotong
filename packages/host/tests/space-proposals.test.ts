/**
 * STOR-M4 空间提案卡。承重的不变量:
 *   1. 判别联合:`applicable: false` 那支结构性没有 `apply` 字段(运行期
 *      hasOwnProperty 断言,不只靠编译器)。
 *   2. 反手抄门:引擎发出的每个 apply 喂**真** `writeRetentionPolicy` 必须
 *      不抛——「提案指向 set_retention 既有参数空间」不是抄一份常量对拍,
 *      是拿执法点本身验(谁改了 RETENTION_KEYS/isValidDays 而提案没跟上,红)。
 *   3. P1 尊重已设键(人定过的档不二次开口);truncated 账本照常提案(下界)。
 *   4. P2 抑制只认「比那一轮更新的全量备份」;没 state 不开口。
 *   5. 报告合同:没接 proposals ⇒ 与 M1 形态逐字节不变;thunk 抛错只丢
 *      这一节绝不连累账本本体。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildButlerSpaceReportToolset,
  renderSpaceReport,
  type SpaceLedgerFile,
} from '../src/space-ledger.js'
import {
  PROPOSE_BUCKET_MIN_BYTES,
  PROPOSED_DAYS,
  proposeStorageActions,
  renderStorageProposals,
  storageProposalsAt,
  type StorageProposal,
} from '../src/space-proposals.js'
import {
  RETENTION_KEYS,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  writeRetentionPolicy,
  type RetentionState,
} from '../src/space-retention.js'

const tmpRoots: string[] = []
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true })
})
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'gotong-space-proposals-'))
  tmpRoots.push(d)
  return d
}

const BIG = PROPOSE_BUCKET_MIN_BYTES + 1
const T0 = 1_700_000_000_000

function ledgerWith(buckets: Record<string, number>, truncated = false): SpaceLedgerFile {
  const categories = Object.entries(buckets).map(([id, bytes]) => ({ id, bytes, entries: 1 }))
  return {
    v: 1,
    at: T0,
    totalBytes: categories.reduce((a, c) => a + c.bytes, 0),
    totalEntries: categories.length,
    truncated,
    categories,
  }
}

const ALL_BIG = ledgerWith({
  'butler/memory': BIG,
  'butler/longrun': BIG,
  'butler/sessions': BIG,
})

function stateWith(over: Partial<RetentionState>): RetentionState {
  return { at: T0, deleted: 0, skippedNoNet: 0, blockedAudit: 0, failed: 0, ...over }
}

const NO_FACTS = { policy: null, state: null, fullBackupAt: null }

describe('proposeStorageActions — P1 保留期建议', () => {
  it('三个桶都过线且策略缺席 ⇒ 三条 applicable 提案,apply 全指 set_retention 合法区间', () => {
    const out = proposeStorageActions({ ledger: ALL_BIG, ...NO_FACTS })
    expect(out.map((p) => p.id)).toEqual(RETENTION_KEYS.map((k) => `retention:${k}`))
    for (const p of out) {
      expect(p.applicable).toBe(true)
      if (!p.applicable) continue
      expect(p.apply.tool).toBe('set_retention')
      expect(p.apply.days).toBe(PROPOSED_DAYS[p.apply.key])
      expect(p.apply.days).toBeGreaterThanOrEqual(RETENTION_MIN_DAYS)
      expect(p.apply.days).toBeLessThanOrEqual(RETENTION_MAX_DAYS)
    }
  })

  it('人已定过的键不二次开口:只沉默那一键,其余照提', () => {
    const out = proposeStorageActions({
      ledger: ALL_BIG,
      policy: { memory_archive_days: 365 },
      state: null,
      fullBackupAt: null,
    })
    expect(out.map((p) => p.id)).toEqual(['retention:dossier_days', 'retention:departed_session_days'])
  })

  it('账本 null ⇒ 零 P1(没有尺不开口)', () => {
    expect(proposeStorageActions({ ledger: null, ...NO_FACTS })).toEqual([])
  })

  it('桶没过线 ⇒ 沉默(阈值是下界,恰好等于阈值也算过线)', () => {
    const under = ledgerWith({ 'butler/memory': PROPOSE_BUCKET_MIN_BYTES - 1 })
    expect(proposeStorageActions({ ledger: under, ...NO_FACTS })).toEqual([])
    const exact = ledgerWith({ 'butler/memory': PROPOSE_BUCKET_MIN_BYTES })
    expect(proposeStorageActions({ ledger: exact, ...NO_FACTS }).map((p) => p.id)).toEqual([
      'retention:memory_archive_days',
    ])
  })

  it('truncated 账本照常提案:截断的数字是下界,过线只会更确定', () => {
    const trunc = ledgerWith({ 'butler/memory': BIG }, true)
    expect(proposeStorageActions({ ledger: trunc, ...NO_FACTS }).map((p) => p.id)).toEqual([
      'retention:memory_archive_days',
    ])
  })
})

describe('proposeStorageActions — P2 备份安全网', () => {
  it('上一轮有 skippedNoNet 且没有更新的全量备份 ⇒ 一条 applicable:false,结构性无 apply', () => {
    const out = proposeStorageActions({
      ledger: null,
      policy: null,
      state: stateWith({ skippedNoNet: 4 }),
      fullBackupAt: null,
    })
    expect(out).toHaveLength(1)
    const p = out[0]!
    expect(p.id).toBe('backup:no-net')
    expect(p.applicable).toBe(false)
    expect(p.title).toContain('4 件')
    expect(Object.prototype.hasOwnProperty.call(p, 'apply')).toBe(false)
    if (!p.applicable) expect(p.howTo).toContain('gotong backup')
  })

  it('那一轮之后跑过全量备份 ⇒ 抑制(刚照 howTo 做完不该还被念叨)', () => {
    const out = proposeStorageActions({
      ledger: null,
      policy: null,
      state: stateWith({ skippedNoNet: 4 }),
      fullBackupAt: T0 + 1,
    })
    expect(out).toEqual([])
  })

  it('备份比那一轮旧 ⇒ 不抑制(旧网兜不住新一轮跳过的东西)', () => {
    const out = proposeStorageActions({
      ledger: null,
      policy: null,
      state: stateWith({ skippedNoNet: 1 }),
      fullBackupAt: T0 - 1,
    })
    expect(out.map((p) => p.id)).toEqual(['backup:no-net'])
  })

  it('state 缺席或 skippedNoNet 为 0 ⇒ 沉默(没有事实不开口)', () => {
    expect(
      proposeStorageActions({ ledger: null, policy: null, state: null, fullBackupAt: null }),
    ).toEqual([])
    expect(
      proposeStorageActions({
        ledger: null,
        policy: null,
        state: stateWith({ skippedNoNet: 0, deleted: 7 }),
        fullBackupAt: null,
      }),
    ).toEqual([])
  })
})

describe('proposeStorageActions — 形状与次序', () => {
  it('反手抄门:发出的每个 apply 喂真 writeRetentionPolicy 必须不抛', async () => {
    const dir = freshDir()
    const out = proposeStorageActions({ ledger: ALL_BIG, ...NO_FACTS })
    expect(out.length).toBeGreaterThan(0)
    for (const p of out) {
      if (!p.applicable) continue
      await expect(
        writeRetentionPolicy(dir, (cur) => ({ ...cur, [p.apply.key]: p.apply.days })),
      ).resolves.toBeTruthy()
    }
  })

  it('P2 排在所有 P1 之前(根因先说),P1 按 RETENTION_KEYS 序', () => {
    const out = proposeStorageActions({
      ledger: ALL_BIG,
      policy: null,
      state: stateWith({ skippedNoNet: 2 }),
      fullBackupAt: null,
    })
    expect(out.map((p) => p.id)).toEqual([
      'backup:no-net',
      ...RETENTION_KEYS.map((k) => `retention:${k}`),
    ])
  })
})

describe('renderStorageProposals', () => {
  it('空清单 ⇒ 空串(报告一个字不多)', () => {
    expect(renderStorageProposals([])).toBe('')
  })

  it('三行块 + N/M 计数;applicable 行教人怎么说、说清批准与 6h 生效;绝不出现「重启」', () => {
    const mixed: StorageProposal[] = proposeStorageActions({
      ledger: ledgerWith({ 'butler/memory': BIG }),
      policy: null,
      state: stateWith({ skippedNoNet: 1 }),
      fullBackupAt: null,
    })
    const text = renderStorageProposals(mixed)
    expect(text).toContain('【空间建议】按固定阈值算出来的 2 条(其中 1 条我能帮你改')
    expect(text).toContain('• 上一轮清理有 1 件翻篇内容')
    expect(text).toContain('→ 跑一次全量备份')
    expect(text).toContain('「知识库归档层」的保留期还没生效')
    expect(text).toContain('我会走 set_retention 送你批准')
    expect(text).toContain('设为 365 天')
    expect(text).toContain('下一轮维护(约 6h 内)')
    expect(text).not.toContain('重启')
    // 每条恰好三行:标题 / detail / 下一步。
    expect(text.split('\n')).toHaveLength(1 + mixed.length * 3)
  })
})

describe('space_report 提案节合同', () => {
  const ROW = ledgerWith({ 'butler/memory': BIG })
  const NOW = T0 + 60_000

  it('接了 thunk ⇒ 节拼在账本尾行之后;空串 ⇒ 不占地方', async () => {
    const withSection = buildButlerSpaceReportToolset({
      ledger: async () => ROW,
      proposals: async () => '【空间建议】测试节',
      now: () => NOW,
    })
    const res = await withSection.callTool('space_report', {})
    expect(res.isError).toBeUndefined()
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain('这份账本只丈量、不删除任何东西。\n\n【空间建议】测试节')

    const empty = buildButlerSpaceReportToolset({
      ledger: async () => ROW,
      proposals: async () => '',
      now: () => NOW,
    })
    const res2 = await empty.callTool('space_report', {})
    expect((res2.content[0] as { text: string }).text).toBe(renderSpaceReport(ROW, NOW))
  })

  it('thunk 抛错 ⇒ 报告本体完好无节,不是错误(建议是派生物账本才承重)', async () => {
    const warns: string[] = []
    const toolset = buildButlerSpaceReportToolset({
      ledger: async () => ROW,
      proposals: async () => {
        throw new Error('boom')
      },
      now: () => NOW,
      logger: { warn: (msg: string) => void warns.push(msg) } as never,
    })
    const res = await toolset.callTool('space_report', {})
    expect(res.isError).toBeUndefined()
    expect((res.content[0] as { text: string }).text).toBe(renderSpaceReport(ROW, NOW))
    expect(warns.some((m) => m.includes('proposals failed'))).toBe(true)
  })

  it('没接 thunk ⇒ 与 M1 形态逐字节不变', async () => {
    const toolset = buildButlerSpaceReportToolset({ ledger: async () => ROW, now: () => NOW })
    const res = await toolset.callTool('space_report', {})
    expect((res.content[0] as { text: string }).text).toBe(renderSpaceReport(ROW, NOW))
  })
})

describe('storageProposalsAt — 真盘装配', () => {
  it('四个事实源从真文件读齐:P2 被更新的全量备份抑制,P1 随策略落盘消失', async () => {
    const dir = freshDir()
    await mkdir(join(dir, 'runtime'), { recursive: true })
    // 上一轮阶梯:2 件没网被跳过。
    await writeFile(
      join(dir, 'runtime', 'retention-state.json'),
      JSON.stringify(stateWith({ skippedNoNet: 2 })),
    )
    const thunk = storageProposalsAt(dir, async () => ledgerWith({ 'butler/longrun': BIG }))

    const first = await thunk()
    expect(first).toContain('backup')
    expect(first).toContain('2 件翻篇内容')
    expect(first).toContain('「长任务翻篇档案」的保留期还没生效')

    // 跑一次(比 state 新的)全量备份 ⇒ P2 消失。
    await writeFile(
      join(dir, 'runtime', 'last-backup.json'),
      JSON.stringify({
        format: 'gotong.last-backup/v1',
        at: T0 + 1,
        tier: 'full',
        includesMasterKey: false,
        archive: 'seed.tar.gz',
      }),
    )
    const second = await thunk()
    expect(second).not.toContain('翻篇内容因为没进备份安全网')
    expect(second).toContain('「长任务翻篇档案」的保留期还没生效')

    // 人定下这一档 ⇒ P1 也消失,整节归空串。
    await writeRetentionPolicy(dir, (cur) => ({ ...cur, dossier_days: 180 }))
    expect(await thunk()).toBe('')
  })

  it('ledger thunk 抛错折 null:不提 P1,P2 照常(读不动一半不连累另一半)', async () => {
    const dir = freshDir()
    await mkdir(join(dir, 'runtime'), { recursive: true })
    await writeFile(
      join(dir, 'runtime', 'retention-state.json'),
      JSON.stringify(stateWith({ skippedNoNet: 1 })),
    )
    const thunk = storageProposalsAt(dir, async () => {
      throw new Error('ledger unreadable')
    })
    const text = await thunk()
    expect(text).toContain('backup')
    expect(text).not.toContain('保留期还没生效')
  })
})
