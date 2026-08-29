/**
 * STOR-M2 — 死物清扫与 `.bak-` 轮转的门。
 *
 * 承重面(逐条对 space-sweeper.ts 五边界):
 *  ① 孤儿谓词按 fs-atomic 真相:`.tmp` **后缀** + 24h 年龄门(新鲜 tmp 不动);
 *  ② 视野结构性只有两层(根 + runtime/),`butler/` 里同名死物**不可见**;
 *  ③ 保代数硬不变量:corrupt 保 5 / bak 保 3,族内 ≤ 保留数一个不删,
 *     只剩一代的族碰都不碰;`.bak-` 轮转只在根,runtime/ 里的不转;
 *  ④ 先落账再动手:每删一行台账;台账写不进去 ⇒ **不删**(auditBlocked);
 *  ⑤ 活文件安全网:空间根的真实活文件(identity.sqlite/gotong.env/…)与
 *     `.bak-` **目录**全程零触碰,result 全零含 failed。
 *
 * 组合 thunk (`spaceUpkeepAt`) 的排序也在这里钉:先清扫后丈量,账本反映
 * 清扫后的字节;台账被堵死时清扫跳过但丈量照跑(各自 best-effort)。
 */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  BAK_KEEP,
  CORRUPT_KEEP,
  TMP_ORPHAN_MIN_AGE_MS,
  readSpaceActions,
  spaceUpkeepAt,
  sweepSpaceOnce,
} from '../src/space-sweeper.js'

const NOW = 1_750_000_000_000

const tempDirs: string[] = []

async function makeSpace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gotong-space-sweep-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

/** 写一个文件并把 mtime 钉到指定时刻(谓词只看 mtime)。 */
async function fileAt(path: string, ageMs: number, bytes = 4): Promise<void> {
  await writeFile(path, 'x'.repeat(bytes), 'utf8')
  const when = new Date(NOW - ageMs)
  await utimes(path, when, when)
}

function opts(spaceDir: string, over: Record<string, unknown> = {}) {
  return {
    spaceDir,
    actionsFile: join(spaceDir, 'runtime', 'space-actions.jsonl'),
    now: () => NOW,
    ...over,
  }
}

async function names(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

const DAY = 24 * 60 * 60 * 1000

describe('space-sweeper (STOR-M2)', () => {
  it('deletes only ORPHAN tmp files: .tmp suffix AND older than 24h', async () => {
    const space = await makeSpace()
    await fileAt(join(space, 'agents.json.123.abc.def.tmp'), DAY + 60_000)
    await fileAt(join(space, 'agents.json.456.fff.aaa.tmp'), 5_000) // 活着的原子写
    const res = await sweepSpaceOnce(opts(space))
    expect(res.deletedTmp).toBe(1)
    expect(res.failed).toBe(0)
    const left = await names(space)
    expect(left).toContain('agents.json.456.fff.aaa.tmp')
    expect(left).not.toContain('agents.json.123.abc.def.tmp')
  })

  it('scope is structural: runtime/ is swept, butler/sessions/ is invisible', async () => {
    const space = await makeSpace()
    await mkdir(join(space, 'runtime'), { recursive: true })
    await mkdir(join(space, 'butler', 'sessions'), { recursive: true })
    await fileAt(join(space, 'runtime', 'state.json.1.2.3.tmp'), DAY * 3)
    // 同样的死相,住在视野外——清扫器根本不走到那里。
    await fileAt(join(space, 'butler', 'sessions', 'state.json.1.2.3.tmp'), DAY * 3)
    const res = await sweepSpaceOnce(opts(space))
    expect(res.deletedTmp).toBe(1)
    expect(await names(join(space, 'runtime'))).not.toContain('state.json.1.2.3.tmp')
    expect(await names(join(space, 'butler', 'sessions'))).toContain('state.json.1.2.3.tmp')
  })

  it(`.corrupt-* families keep the newest ${CORRUPT_KEEP}; a family AT the cap is untouched`, async () => {
    const space = await makeSpace()
    // 7 份隔离残骸,mtime 递增(corrupt-7 最新)。
    for (let i = 1; i <= 7; i++) {
      await fileAt(join(space, `tasks.json.corrupt-${i}`), DAY * (10 - i))
    }
    // 恰好 5 份的族:一个不删。
    for (let i = 1; i <= 5; i++) {
      await fileAt(join(space, `prefs.json.corrupt-${i}`), DAY * (10 - i))
    }
    const res = await sweepSpaceOnce(opts(space))
    expect(res.deletedCorrupt).toBe(2)
    const left = await names(space)
    expect(left).not.toContain('tasks.json.corrupt-1')
    expect(left).not.toContain('tasks.json.corrupt-2')
    for (let i = 3; i <= 7; i++) expect(left).toContain(`tasks.json.corrupt-${i}`)
    for (let i = 1; i <= 5; i++) expect(left).toContain(`prefs.json.corrupt-${i}`)
  })

  it(`.bak- families rotate to ${BAK_KEEP} per family; cap-sized and single-generation families untouched`, async () => {
    const space = await makeSpace()
    for (let i = 1; i <= 5; i++) {
      await fileAt(join(space, `agents.json.bak-2026010${i}`), DAY * (10 - i))
    }
    for (let i = 1; i <= 3; i++) {
      await fileAt(join(space, `gotong.env.bak-2026010${i}`), DAY * (10 - i))
    }
    await fileAt(join(space, 'space.json.bak-20260101'), DAY * 30) // 独苗:轮转≠删除
    const res = await sweepSpaceOnce(opts(space))
    expect(res.deletedBak).toBe(2)
    const left = await names(space)
    expect(left).not.toContain('agents.json.bak-20260101')
    expect(left).not.toContain('agents.json.bak-20260102')
    for (let i = 3; i <= 5; i++) expect(left).toContain(`agents.json.bak-2026010${i}`)
    for (let i = 1; i <= 3; i++) expect(left).toContain(`gotong.env.bak-2026010${i}`)
    expect(left).toContain('space.json.bak-20260101')
  })

  it('.bak- rotation applies ONLY at the space root, never inside runtime/', async () => {
    const space = await makeSpace()
    await mkdir(join(space, 'runtime'), { recursive: true })
    for (let i = 1; i <= 5; i++) {
      await fileAt(join(space, 'runtime', `state.json.bak-${i}`), DAY * (10 - i))
    }
    const res = await sweepSpaceOnce(opts(space))
    expect(res.deletedBak).toBe(0)
    for (let i = 1; i <= 5; i++) {
      expect(await names(join(space, 'runtime'))).toContain(`state.json.bak-${i}`)
    }
  })

  it('live-file safety net: real space-root files and .bak- DIRECTORIES are untouched', async () => {
    const space = await makeSpace()
    const live = [
      'identity.sqlite',
      'identity.sqlite-wal',
      'gotong.env',
      'secrets.enc.json',
      'transcript.jsonl',
      'space.json',
      'agents.json',
    ]
    for (const name of live) await fileAt(join(space, name), DAY * 90)
    // `.bak-` 命中但它是目录:files-only 视野结构性跳过。
    await mkdir(join(space, 'data.bak-20260101'), { recursive: true })
    await fileAt(join(space, 'data.bak-20260101', 'inner.txt'), DAY * 90)
    const res = await sweepSpaceOnce(opts(space))
    expect(res).toEqual({
      deletedTmp: 0,
      deletedCorrupt: 0,
      deletedBak: 0,
      failed: 0,
      auditBlocked: 0,
    })
    const left = await names(space)
    for (const name of live) expect(left).toContain(name)
    expect(await names(join(space, 'data.bak-20260101'))).toContain('inner.txt')
  })

  it('writes one audit line per deletion — before the unlink, with class/scope/file/bytes', async () => {
    const space = await makeSpace()
    await mkdir(join(space, 'runtime'), { recursive: true })
    await fileAt(join(space, 'a.json.1.2.3.tmp'), DAY * 2, 17)
    await fileAt(join(space, 'runtime', 'b.json.4.5.6.tmp'), DAY * 2, 9)
    const actionsFile = join(space, 'runtime', 'space-actions.jsonl')
    const res = await sweepSpaceOnce(opts(space, { actionsFile }))
    expect(res.deletedTmp).toBe(2)
    const rows = await readSpaceActions(actionsFile)
    expect(rows.length).toBe(2)
    for (const row of rows) {
      expect(row.kind).toBe('delete')
      expect(row.class).toBe('tmp')
      expect(typeof row.at).toBe('string')
      expect(Number.isNaN(Date.parse(row.at))).toBe(false)
      expect(typeof row.bytes).toBe('number')
      // 台账里只落文件名,绝不落绝对路径。
      expect(String(row.file)).not.toContain('/')
    }
    const files = rows.map((r) => r.file).sort()
    expect(files).toEqual(['a.json.1.2.3.tmp', 'b.json.4.5.6.tmp'])
    const scopes = rows.map((r) => `${String(r.scope)}:${String(r.file)}`).sort()
    expect(scopes).toEqual(['root:a.json.1.2.3.tmp', 'runtime:b.json.4.5.6.tmp'])
  })

  it('LOAD-BEARING: when the audit ledger cannot be written, nothing is deleted', async () => {
    const space = await makeSpace()
    await fileAt(join(space, 'a.json.1.2.3.tmp'), DAY * 2)
    // actionsFile 的父路径是一个**文件**:mkdir/append 都注定失败。
    const blocker = join(space, 'blocker')
    await writeFile(blocker, 'not a dir', 'utf8')
    const res = await sweepSpaceOnce(
      opts(space, { actionsFile: join(blocker, 'space-actions.jsonl') }),
    )
    expect(res.auditBlocked).toBe(1)
    expect(res.deletedTmp).toBe(0)
    expect(await names(space)).toContain('a.json.1.2.3.tmp')
  })

  it('audit ledger trim hysteresis: >300 lines trims to 200; 250 stays 250', async () => {
    const space = await makeSpace()
    await mkdir(join(space, 'runtime'), { recursive: true })
    const actionsFile = join(space, 'runtime', 'space-actions.jsonl')
    const line = (i: number) => JSON.stringify({ at: new Date(NOW).toISOString(), kind: 'delete', i })
    await writeFile(actionsFile, Array.from({ length: 350 }, (_, i) => line(i)).join('\n') + '\n')
    await sweepSpaceOnce(opts(space, { actionsFile }))
    const trimmed = (await readFile(actionsFile, 'utf8')).split('\n').filter((l) => l.trim())
    expect(trimmed.length).toBe(200)
    // 滞回:没超高水位就不重写。
    await writeFile(actionsFile, Array.from({ length: 250 }, (_, i) => line(i)).join('\n') + '\n')
    const before = await stat(actionsFile)
    await sweepSpaceOnce(opts(space, { actionsFile }))
    const kept = (await readFile(actionsFile, 'utf8')).split('\n').filter((l) => l.trim())
    expect(kept.length).toBe(250)
    expect((await stat(actionsFile)).mtimeMs).toBe(before.mtimeMs)
  })

  it('readSpaceActions is a tolerant reader: bad lines skipped, unknown keys carried, newest first', async () => {
    const space = await makeSpace()
    await mkdir(join(space, 'runtime'), { recursive: true })
    const actionsFile = join(space, 'runtime', 'space-actions.jsonl')
    await writeFile(
      actionsFile,
      [
        JSON.stringify({ at: '2026-08-01T00:00:00.000Z', kind: 'delete', file: 'old.tmp' }),
        'not json at all {{{',
        JSON.stringify({ kind: 'delete' }), // 缺 at:跳过
        JSON.stringify({ at: '2026-08-02T00:00:00.000Z', kind: 'delete_failed', why: 'EACCES' }),
      ].join('\n') + '\n',
    )
    const rows = await readSpaceActions(actionsFile)
    expect(rows.length).toBe(2)
    expect(rows[0]?.kind).toBe('delete_failed')
    expect(rows[0]?.why).toBe('EACCES') // 未知键透传
    expect(rows[1]?.file).toBe('old.tmp')
    expect(await readSpaceActions(join(space, 'runtime', 'nope.jsonl'))).toEqual([])
  })

  it('spaceUpkeepAt orders sweep BEFORE census: the ledger reflects post-sweep bytes', async () => {
    const space = await makeSpace()
    await fileAt(join(space, 'big.json.1.2.3.tmp'), DAY * 2, 10_000)
    const upkeep = spaceUpkeepAt(space)
    const row = await upkeep.run()
    expect(row).not.toBeNull()
    // 清扫先行:一万字节的孤儿不在账本里。
    expect(row!.totalBytes).toBeLessThan(10_000)
    expect(await names(space)).not.toContain('big.json.1.2.3.tmp')
    // 台账真落在 runtime/ 下。
    const rows = await readSpaceActions(upkeep.actionsFile)
    expect(rows.length).toBe(1)
    expect(rows[0]?.file).toBe('big.json.1.2.3.tmp')
  })

  it('spaceUpkeepAt: a fully hostile runtime (a FILE) blocks audit+persist but the census still returns', async () => {
    const space = await makeSpace()
    // `runtime` 占位成文件:审计台账与账本落盘都注定失败。
    await writeFile(join(space, 'runtime'), 'squatter', 'utf8')
    await fileAt(join(space, 'a.json.1.2.3.tmp'), DAY * 2)
    const upkeep = spaceUpkeepAt(space)
    const row = await upkeep.run()
    // 账写不进去 ⇒ 不删;丈量照样返回(落盘失败只 warn)。
    expect(row).not.toBeNull()
    expect(await names(space)).toContain('a.json.1.2.3.tmp')
  })

  it('a fresh empty space sweeps to all-zeros without creating anything', async () => {
    const space = await makeSpace()
    const res = await sweepSpaceOnce(opts(space))
    expect(res).toEqual({
      deletedTmp: 0,
      deletedCorrupt: 0,
      deletedBak: 0,
      failed: 0,
      auditBlocked: 0,
    })
    // 零动作 ⇒ 台账文件根本不出现(惰性事实文件)。
    expect(await names(join(space, 'runtime'))).toEqual([])
  })
})
