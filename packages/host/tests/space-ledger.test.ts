/**
 * STOR-M1 承重门 — 空间账本(丈量 / 读者 / 渲染 / 工具)。
 *
 * Pins the five contracts that keep the census honest:
 *
 *   1. bucketing — transcript.jsonl + transcript-archive/ merge; identity.sqlite
 *      prefix family; butler/ expands ONE level (subdirs become butler/<sub>,
 *      loose files stay `butler`); `.bak-` family folds to `bak`; other top
 *      dirs keep their name; root loose files → `other`; top-level symlinks
 *      are skipped entirely;
 *   2. 读不动 ≠ 零 (EFF-M3) — unreadable space root → null + warn, NEVER a row
 *      of zeros; write failure still returns the measured row (边界④);
 *   3. no silent caps — the shared entry budget marks `truncated`, and every
 *      renderer prints the lower-bound disclosure instead of posing as full;
 *   4. tolerant reader — missing / corrupt / wrong-shape ledger files all read
 *      as null (unknown), never as data;
 *   5. render honesty — null is a NON-error answer; the trailer says 只丈量不
 *      删除 and points at NO tool that does not exist yet (HANDS-M3b 判例:
 *      set_retention lands in M3, so no text here may name it).
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { Logger } from '@gotong/core'

import {
  buildButlerSpaceReportToolset,
  fmtBytes,
  measureSpaceLedger,
  readSpaceLedger,
  renderSpaceReport,
  spaceLedgerAt,
  spaceSummaryLine,
  type SpaceLedgerFile,
} from '../src/space-ledger.js'

const HOUR = 3_600_000
const NOW = 1_800_000_000_000

function capturingLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = []
  const push = (level: string) => (msg: string) => {
    if (level === 'warn') warns.push(msg)
  }
  const logger: Logger = {
    trace: push('trace'), debug: push('debug'), info: push('info'),
    warn: push('warn'), error: push('error'), fatal: push('fatal'),
    child() { return logger },
  }
  return { logger, warns }
}

const tmpRoots: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'space-ledger-'))
  tmpRoots.push(d)
  return d
}
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 一棵覆盖全部分桶规则的 space 树(字节数手排,断言全按它算)。 */
function seedSpace(space: string): void {
  const w = (rel: string, bytes: number): void => {
    writeFileSync(join(space, rel), 'x'.repeat(bytes))
  }
  w('transcript.jsonl', 100)
  mkdirSync(join(space, 'transcript-archive'))
  w('transcript-archive/a.jsonl', 200)
  w('transcript-archive/b.jsonl', 50)
  w('identity.sqlite', 300)
  w('identity.sqlite-wal', 10)
  mkdirSync(join(space, 'butler', 'memory'), { recursive: true })
  mkdirSync(join(space, 'butler', 'longrun'))
  w('butler/memory/m1.json', 40)
  w('butler/memory/m2.json', 60)
  w('butler/longrun/d1.json', 500)
  w('butler/loose.txt', 7)
  mkdirSync(join(space, 'runtime'))
  w('runtime/x.log', 25)
  w('agents.json.bak-20260828-1', 90)
  mkdirSync(join(space, 'data.bak-roll'))
  w('data.bak-roll/old.json', 10)
  w('space.json', 5)
  // 顶层符号链接:指向的空间不归这本账管——不进任何桶、不计条目。
  symlinkSync(join(space, 'transcript.jsonl'), join(space, 'link'))
}

describe('STOR-M1 — measureSpaceLedger(分桶 + 落盘)', () => {
  it('buckets every rule from the header table; symlink skipped; ledger written and round-trips', async () => {
    const root = tmpRoot()
    const space = join(root, 'space')
    mkdirSync(space)
    seedSpace(space)
    const ledgerFile = join(root, 'out', 'ledger.json')

    const row = await measureSpaceLedger({ spaceDir: space, ledgerFile, now: () => NOW })
    expect(row).not.toBeNull()
    expect(row!.v).toBe(1)
    expect(row!.at).toBe(NOW)
    expect(row!.truncated).toBe(false)
    // bytes 降序,并列(bak=100 vs butler/memory=100)按 id 升序——渲染确定性。
    expect(row!.categories).toEqual([
      { id: 'butler/longrun', bytes: 500, entries: 1 },
      { id: 'transcript', bytes: 350, entries: 3 }, // 根文件 + archive 两件合桶
      { id: 'identity', bytes: 310, entries: 2 }, // .sqlite + -wal 前缀族
      { id: 'bak', bytes: 100, entries: 2 }, // 根 .bak- 文件 + .bak- 目录合族
      { id: 'butler/memory', bytes: 100, entries: 2 },
      { id: 'runtime', bytes: 25, entries: 1 },
      { id: 'butler', bytes: 7, entries: 1 }, // butler 散文件不进子桶
      { id: 'other', bytes: 5, entries: 1 }, // 根部散文件
    ])
    expect(row!.totalBytes).toBe(1397)
    expect(row!.totalEntries).toBe(13) // symlink 被跳过:多一条这里就对不上

    // 落盘的就是返回的这份,且能过 readSpaceLedger 的形状门。
    const back = await readSpaceLedger(ledgerFile)
    expect(back).toEqual(row)
  })

  it('读不动 ≠ 零: unreadable root → null + warn, and NO ledger file appears', async () => {
    const root = tmpRoot()
    const { logger, warns } = capturingLogger()
    const ledgerFile = join(root, 'ledger.json')
    const row = await measureSpaceLedger({
      spaceDir: join(root, 'nope'),
      ledgerFile,
      logger,
    })
    expect(row).toBeNull()
    expect(warns.some((w) => w.includes('space root unreadable'))).toBe(true)
    expect(existsSync(ledgerFile)).toBe(false)
  })

  it('shared entry budget: exhaustion marks truncated and totals are exact lower bounds', async () => {
    // 根部散文件路径(addFile 消耗预算):5 件配预算 3 → 恰记 3 条。
    const flat = join(tmpRoot(), 'space')
    mkdirSync(flat)
    for (let i = 0; i < 5; i++) writeFileSync(join(flat, `f${i}.txt`), 'ab')
    const a = await measureSpaceLedger({
      spaceDir: flat,
      ledgerFile: join(flat, 'runtime', 'ledger.json'),
      maxEntries: 3,
    })
    expect(a!.truncated).toBe(true)
    expect(a!.totalEntries).toBe(3)
    expect(a!.totalBytes).toBe(6)

    // 子树路径(measureSubtree 消耗同一份预算):5 件配预算 2 → 恰记 2 条。
    const deep = join(tmpRoot(), 'space')
    mkdirSync(join(deep, 'logs'), { recursive: true })
    for (let i = 0; i < 5; i++) writeFileSync(join(deep, 'logs', `f${i}.txt`), 'ab')
    const b = await measureSpaceLedger({
      spaceDir: deep,
      ledgerFile: join(deep, 'runtime', 'ledger.json'),
      maxEntries: 2,
    })
    expect(b!.truncated).toBe(true)
    expect(b!.totalEntries).toBe(2)
  })

  it('边界④: write failure warns but still returns the measured row', async () => {
    const root = tmpRoot()
    const space = join(root, 'space')
    mkdirSync(space)
    writeFileSync(join(space, 'a.txt'), 'abc')
    // 拿一个普通文件当路径中段:mkdir(dirname) 必 ENOTDIR。
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'not a dir')
    const { logger, warns } = capturingLogger()
    const row = await measureSpaceLedger({
      spaceDir: space,
      ledgerFile: join(blocker, 'deep', 'ledger.json'),
      logger,
    })
    expect(row).not.toBeNull()
    expect(row!.totalBytes).toBe(3)
    expect(warns.some((w) => w.includes('write failed'))).toBe(true)
  })
})

describe('STOR-M1 — readSpaceLedger(宽容读者:未知一律 null)', () => {
  it('missing / corrupt / wrong-shape all read as null — never as data', async () => {
    const root = tmpRoot()
    const file = join(root, 'ledger.json')
    expect(await readSpaceLedger(file)).toBeNull() // 不存在

    writeFileSync(file, 'not json{')
    expect(await readSpaceLedger(file)).toBeNull() // 损坏

    const valid: SpaceLedgerFile = {
      v: 1, at: NOW, totalBytes: 1, totalEntries: 1, truncated: false,
      categories: [{ id: 'other', bytes: 1, entries: 1 }],
    }
    const badShapes: unknown[] = [
      { ...valid, v: 2 }, // 版本不对
      { ...valid, at: 'yesterday' }, // 字段类型不对
      { ...valid, totalBytes: Number.NaN }, // 非有限数
      (() => { const { truncated: _t, ...rest } = valid; return rest })(), // 缺字段
      { ...valid, categories: [{ id: 'x', bytes: '9', entries: 1 }] }, // 类目坏
    ]
    for (const shape of badShapes) {
      writeFileSync(file, JSON.stringify(shape))
      expect(await readSpaceLedger(file)).toBeNull()
    }

    writeFileSync(file, JSON.stringify(valid))
    expect(await readSpaceLedger(file)).toEqual(valid)
  })
})

describe('STOR-M1 — 格式化与渲染', () => {
  it('fmtBytes: honest zero for non-finite/negative; unit ladder with fixed decimals', () => {
    expect(fmtBytes(Number.NaN)).toBe('0 B')
    expect(fmtBytes(-5)).toBe('0 B')
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(1023)).toBe('1023 B')
    expect(fmtBytes(2048)).toBe('2.0 KB')
    expect(fmtBytes(5_000_000)).toBe('4.8 MB')
    expect(fmtBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
  })

  function row(over: Partial<SpaceLedgerFile> = {}): SpaceLedgerFile {
    return {
      v: 1,
      at: NOW - 2 * HOUR,
      totalBytes: 5_000_000,
      totalEntries: 321,
      truncated: false,
      categories: [
        { id: 'transcript', bytes: 3_000_000, entries: 12 },
        { id: 'other', bytes: 2_097_152, entries: 309 },
      ],
      ...over,
    }
  }

  it('renderSpaceReport(null) is an honest NON-error answer', () => {
    expect(renderSpaceReport(null, NOW)).toBe(
      '还没有丈量记录。空间账本随 6 小时维护节律更新,开机也会先量一次——稍后再问我一次。',
    )
  })

  it('renderSpaceReport(row): header + totals + per-category lines + fixed trailer', () => {
    expect(renderSpaceReport(row(), NOW)).toBe(
      [
        'hub 空间账本(丈量于 2 小时前):',
        '总占用 4.8 MB,共 321 个条目。',
        '- transcript:2.9 MB(12 条)',
        '- other:2.0 MB(309 条)',
        '这份账本只丈量、不删除任何东西。',
      ].join('\n'),
    )
  })

  it('no silent caps: >12 categories fold into a counted overflow line; truncated discloses lower bound', () => {
    const many = row({
      categories: Array.from({ length: 14 }, (_, i) => ({
        id: `c${String(i).padStart(2, '0')}`, bytes: 1400 - i, entries: 1,
      })),
    })
    const out = renderSpaceReport(many, NOW)
    expect(out).toContain('- c11:')
    expect(out).not.toContain('- c12:')
    expect(out).toContain('(还有 2 个更小的类目未列出。)')

    const cut = renderSpaceReport(row({ truncated: true }), NOW)
    expect(cut).toContain('(条目数超过丈量上限,以上数字是下界,不是全量。)')
  })

  it('HANDS-M3b: report text names NO not-yet-existing tool (set_retention lands in M3)', () => {
    for (const out of [renderSpaceReport(null, NOW), renderSpaceReport(row({ truncated: true }), NOW)]) {
      expect(out).not.toContain('set_retention')
    }
  })

  it('spaceSummaryLine: top category + truncation flag + relative age; empty categories degrade', () => {
    expect(spaceSummaryLine(row(), NOW)).toBe('总 4.8 MB,最大类目 transcript(2.9 MB);丈量于 2 小时前')
    expect(spaceSummaryLine(row({ truncated: true }), NOW)).toBe(
      '总 4.8 MB,最大类目 transcript(2.9 MB),丈量被截断(数字是下界);丈量于 2 小时前',
    )
    expect(spaceSummaryLine(row({ totalBytes: 0, categories: [], at: NOW - 30_000 }), NOW)).toBe(
      '总 0 B;丈量于 刚刚',
    )
  })
})

describe('STOR-M1 — buildButlerSpaceReportToolset(工具姿态)', () => {
  const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
    r.content.map((c) => c.text ?? '').join('\n')

  it('lists exactly space_report; description says read-only and names no future tool', () => {
    const tools = buildButlerSpaceReportToolset({ ledger: async () => null }).listTools()
    expect(tools.map((t) => t.name)).toEqual(['space_report'])
    expect(tools[0]!.description).toContain('只读账本')
    expect(tools[0]!.description).not.toContain('set_retention')
  })

  it('null ledger → the honest 还没量过 answer, NOT an error', async () => {
    const r = await buildButlerSpaceReportToolset({ ledger: async () => null })
      .callTool('space_report', {})
    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toContain('还没有丈量记录')
  })

  it('real row → the full report with the measure-only trailer', async () => {
    const r = await buildButlerSpaceReportToolset({
      ledger: async () => ({
        v: 1, at: NOW - HOUR, totalBytes: 100, totalEntries: 2, truncated: false,
        categories: [{ id: 'other', bytes: 100, entries: 2 }],
      }),
      now: () => NOW,
    }).callTool('space_report', {})
    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toContain('hub 空间账本(丈量于 1 小时前):')
    expect(textOf(r)).toContain('这份账本只丈量、不删除任何东西。')
  })

  it('unknown tool name → typed refusal; ledger throw → isError + warn', async () => {
    const bad = await buildButlerSpaceReportToolset({ ledger: async () => null })
      .callTool('rm_rf', {})
    expect(bad.isError).toBe(true)

    const { logger, warns } = capturingLogger()
    const boom = await buildButlerSpaceReportToolset({
      ledger: async () => { throw new Error('disk') },
      logger,
    }).callTool('space_report', {})
    expect(boom.isError).toBe(true)
    expect(textOf(boom)).toContain('暂时读不到空间账本')
    expect(warns.some((w) => w.includes('ledger read failed'))).toBe(true)
  })
})

describe('STOR-M1 — spaceLedgerAt(装配便利)', () => {
  it('pins the runtime/space-ledger.json path; read is null before measure, equal after', async () => {
    const space = tmpRoot()
    writeFileSync(join(space, 'a.txt'), 'hello')
    const at = spaceLedgerAt(space)
    expect(at.ledgerFile).toBe(join(space, 'runtime', 'space-ledger.json'))

    expect(await at.read()).toBeNull() // 还没量过=未知,不是空

    const measured = await at.measure()
    expect(measured).not.toBeNull()
    expect(measured!.totalBytes).toBe(5)
    expect(await at.read()).toEqual(measured)
  })
})
