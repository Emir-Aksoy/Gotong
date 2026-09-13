/**
 * space-retention.test.ts — STOR-M3 保留阶梯的承重门。
 *
 * 钉的是四条头注不变量,每条至少一例直接驱动:
 *
 *   1. 策略缺席 = 不删 = 字节不变(连 state 文件都不落)——`buildRetentionLadder`
 *      的 disarm 门在调阶梯**之前**,盘上零字节。
 *   2. 岔口① 硬前置:过期 ≠ 可删,还得「已进最近一次全量备份或 git 快照」
 *      (mtime/updatedAt ≤ 安全网时刻);没进的 skippedNoNet 计数,绝不静默删。
 *   3. 先落账再动手:台账 append 失败 ⇒ blockedAudit + 跳过删除,文件原地留。
 *   4. 读失败方向性:候选读失败折 [] = 安全;identity 读不动是**反方向**——
 *      liveUserIds null 时离场会话整类跳过 + warn(读不动 ≠ 全员离场)。
 *
 * 另钉三类各自的结构性保护:活着的 dossier(非 done/cancelled)静默跳过且
 * **不计 skippedNoNet**(blocked 不是「差一份备份」,是「还没翻篇」);在册成员
 * 的会话窗静默期再长也不碰;`.corrupt-*` 证据文件不进候选。
 *
 * 时钟纪律:直接调 `retentionLadderOnce` 一律注入 `now: () => NOW`;
 * `buildRetentionLadder` 的 thunk 刻意不收 now(生产形状),armed 测试用
 * 真 Date.now() 相对 mtime。
 */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Logger } from '@gotong/core'
import { afterEach, describe, expect, it } from 'vitest'

import type { GitRunner } from '../src/butler-memory-git.js'
import {
  RETENTION_SKIP_CARD_ID,
  RETENTION_SKIP_STALE_MS,
  retentionSkipCard,
} from '../src/personal-butler-patrol.js'
import {
  RETENTION_FILE,
  buildRetentionLadder,
  gitHeadEpochMs,
  loadRetentionPolicy,
  readFullBackupAt,
  readRetentionState,
  retentionLadderOnce,
  writeRetentionPolicy,
  type RetentionPolicy,
} from '../src/space-retention.js'
import { spaceUpkeepAt } from '../src/space-sweeper.js'

const NOW = 1_750_000_000_000
const DAY = 24 * 60 * 60 * 1000

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function makeSpace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gotong-retention-'))
  tempDirs.push(dir)
  return dir
}

/** 与 sweeper 测试的 fileAt 同型,但会先建父目录(阶梯候选都住在深层)。 */
async function fileAt(path: string, ageMs: number, bytes = 4): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'x'.repeat(bytes), 'utf8')
  const when = new Date(NOW - ageMs)
  await utimes(path, when, when)
}

/** thunk 测试专用:thunk 不收 now,mtime 必须相对真实时钟。 */
async function fileAtReal(path: string, ageMs: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'xxxx', 'utf8')
  const when = new Date(Date.now() - ageMs)
  await utimes(path, when, when)
}

async function writeBackupFact(space: string, at: number, tier = 'full'): Promise<void> {
  await mkdir(join(space, 'runtime'), { recursive: true })
  await writeFile(
    join(space, 'runtime', 'last-backup.json'),
    JSON.stringify({
      format: 'gotong.last-backup/v1',
      at,
      tier,
      includesMasterKey: false,
      archive: 'x.tar.gz',
    }),
    'utf8',
  )
}

async function writeDossier(
  space: string,
  uid: string,
  taskId: string,
  status: string,
  updatedAt: number,
  extraFiles: readonly string[] = ['journal.jsonl'],
): Promise<string> {
  const dir = join(space, 'butler', 'longrun', 'user', uid, taskId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'dossier.json'), JSON.stringify({ taskId, status, updatedAt }), 'utf8')
  for (const f of extraFiles) {
    await writeFile(join(dir, f), 'x'.repeat(4), 'utf8')
  }
  return dir
}

function makeLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = []
  const push = (level: string) => (msg: string) => {
    if (level === 'warn') warns.push(msg)
  }
  const logger: Logger = {
    trace: push('trace'),
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    fatal: push('fatal'),
    child() {
      return logger
    },
  }
  return { logger, warns }
}

function gitAt(epochSec: number | null): {
  git: GitRunner
  calls: Array<{ args: readonly string[]; cwd: string }>
} {
  const calls: Array<{ args: readonly string[]; cwd: string }> = []
  const git: GitRunner = async (args, cwd) => {
    calls.push({ args, cwd })
    if (epochSec === null) return { code: 128, stdout: '', stderr: 'not a git repository' }
    return { code: 0, stdout: `${epochSec}\n`, stderr: '' }
  }
  return { git, calls }
}

interface LadderOver {
  liveUserIds?: ReadonlySet<string> | null
  git?: GitRunner
  logger?: Logger
  actionsFile?: string
}

function ladderOpts(space: string, policy: RetentionPolicy, over: LadderOver = {}) {
  return {
    spaceDir: space,
    actionsFile: over.actionsFile ?? join(space, 'runtime', 'space-actions.jsonl'),
    policy,
    liveUserIds: over.liveUserIds === undefined ? new Set<string>() : over.liveUserIds,
    now: () => NOW,
    ...(over.git ? { git: over.git } : {}),
    ...(over.logger ? { logger: over.logger } : {}),
  }
}

async function readActions(space: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(space, 'runtime', 'space-actions.jsonl'), 'utf8').catch(() => '')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

// ---------------------------------------------------------------------------
// loadRetentionPolicy — 缺席静默 null;「读到了但不对」warn + 整份 null
// ---------------------------------------------------------------------------

describe('loadRetentionPolicy', () => {
  it('缺席 ⇒ 静默 null(没配置是常态不是事故,零 warn)', async () => {
    const space = await makeSpace()
    const { logger, warns } = makeLogger()
    expect(await loadRetentionPolicy(space, logger)).toBeNull()
    expect(warns).toHaveLength(0)
  })

  it('读不动(非 ENOENT) ⇒ warn unreadable + null', async () => {
    const space = await makeSpace()
    await mkdir(join(space, RETENTION_FILE))
    const { logger, warns } = makeLogger()
    expect(await loadRetentionPolicy(space, logger)).toBeNull()
    expect(warns).toContain('retention: policy file unreadable, ladder disarmed')
  })

  it('坏 JSON ⇒ warn + null', async () => {
    const space = await makeSpace()
    await writeFile(join(space, RETENTION_FILE), '{nope', 'utf8')
    const { logger, warns } = makeLogger()
    expect(await loadRetentionPolicy(space, logger)).toBeNull()
    expect(warns).toContain('retention: policy file is not valid JSON, ladder disarmed')
  })

  it('数组不是对象 ⇒ warn + null', async () => {
    const space = await makeSpace()
    await writeFile(join(space, RETENTION_FILE), '[]', 'utf8')
    const { logger, warns } = makeLogger()
    expect(await loadRetentionPolicy(space, logger)).toBeNull()
    expect(warns).toContain('retention: policy must be a JSON object, ladder disarmed')
  })

  it('未知键 ⇒ warn + 整份 null(装一半的策略比没有策略更坏)', async () => {
    const space = await makeSpace()
    await writeFile(
      join(space, RETENTION_FILE),
      JSON.stringify({ memory_archive_days: 90, transcript_days: 7 }),
      'utf8',
    )
    const { logger, warns } = makeLogger()
    expect(await loadRetentionPolicy(space, logger)).toBeNull()
    expect(warns).toContain('retention: unknown policy key, ladder disarmed')
  })

  it('坏值(越界/非整数/字符串) ⇒ warn + 整份 null', async () => {
    const space = await makeSpace()
    for (const bad of [29, 3651, 90.5, '90'] as const) {
      await writeFile(join(space, RETENTION_FILE), JSON.stringify({ dossier_days: bad }), 'utf8')
      const { logger, warns } = makeLogger()
      expect(await loadRetentionPolicy(space, logger)).toBeNull()
      expect(warns).toContain('retention: policy value out of range, ladder disarmed')
    }
  })

  it('{} 是合法的零动作策略', async () => {
    const space = await makeSpace()
    await writeFile(join(space, RETENTION_FILE), '{}', 'utf8')
    const { logger, warns } = makeLogger()
    expect(await loadRetentionPolicy(space, logger)).toEqual({})
    expect(warns).toHaveLength(0)
  })

  it('合法策略按值读回', async () => {
    const space = await makeSpace()
    await writeFile(
      join(space, RETENTION_FILE),
      JSON.stringify({ memory_archive_days: 60, departed_session_days: 365 }),
      'utf8',
    )
    expect(await loadRetentionPolicy(space)).toEqual({
      memory_archive_days: 60,
      departed_session_days: 365,
    })
  })
})

// ---------------------------------------------------------------------------
// writeRetentionPolicy — 唯一写咽喉,写前验,拒绝时盘上原样
// ---------------------------------------------------------------------------

describe('writeRetentionPolicy', () => {
  it('设键落盘(pretty + 尾换行)且 load 读得回', async () => {
    const space = await makeSpace()
    const updated = await writeRetentionPolicy(space, () => ({ departed_session_days: 45 }))
    expect(updated).toEqual({ departed_session_days: 45 })
    const raw = await readFile(join(space, RETENTION_FILE), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual({ departed_session_days: 45 })
    expect(await loadRetentionPolicy(space)).toEqual({ departed_session_days: 45 })
  })

  it('mutate 收到盘上现值', async () => {
    const space = await makeSpace()
    await writeRetentionPolicy(space, () => ({ memory_archive_days: 60 }))
    let seen: RetentionPolicy | null = null
    await writeRetentionPolicy(space, (cur) => {
      seen = cur
      return { ...cur, dossier_days: 90 }
    })
    expect(seen).toEqual({ memory_archive_days: 60 })
    expect(await loadRetentionPolicy(space)).toEqual({ memory_archive_days: 60, dossier_days: 90 })
  })

  it('删键(reset 语义)后文件里没有那个键', async () => {
    const space = await makeSpace()
    await writeRetentionPolicy(space, () => ({ memory_archive_days: 60, dossier_days: 90 }))
    await writeRetentionPolicy(space, (cur) => {
      const next: Record<string, number | undefined> = { ...cur }
      delete next.dossier_days
      return next as RetentionPolicy
    })
    const raw = JSON.parse(await readFile(join(space, RETENTION_FILE), 'utf8')) as Record<string, unknown>
    expect(raw).toEqual({ memory_archive_days: 60 })
  })

  it('mutate 产出未知键 ⇒ 拒绝且盘上原样', async () => {
    const space = await makeSpace()
    await writeRetentionPolicy(space, () => ({ memory_archive_days: 60 }))
    await expect(
      writeRetentionPolicy(space, () => ({ nope_days: 30 }) as unknown as RetentionPolicy),
    ).rejects.toThrow(/refusing to write unknown policy key/)
    expect(await loadRetentionPolicy(space)).toEqual({ memory_archive_days: 60 })
  })

  it('mutate 产出坏值 ⇒ 拒绝且盘上原样', async () => {
    const space = await makeSpace()
    await writeRetentionPolicy(space, () => ({ memory_archive_days: 60 }))
    await expect(
      writeRetentionPolicy(space, () => ({ memory_archive_days: 5 })),
    ).rejects.toThrow(/refusing to write invalid value/)
    expect(await loadRetentionPolicy(space)).toEqual({ memory_archive_days: 60 })
  })

  it('盘上是垃圾时 mutate 收到 {}(写路径不被坏档卡死)', async () => {
    const space = await makeSpace()
    await writeFile(join(space, RETENTION_FILE), '{nope', 'utf8')
    let seen: RetentionPolicy | null = null
    await writeRetentionPolicy(space, (cur) => {
      seen = cur
      return { dossier_days: 120 }
    })
    expect(seen).toEqual({})
    expect(await loadRetentionPolicy(space)).toEqual({ dossier_days: 120 })
  })
})

// ---------------------------------------------------------------------------
// readFullBackupAt / gitHeadEpochMs — 两个安全网时刻读者
// ---------------------------------------------------------------------------

describe('readFullBackupAt', () => {
  it('事实文件缺席 ⇒ null', async () => {
    const space = await makeSpace()
    expect(await readFullBackupAt(space)).toBeNull()
  })

  it('子集档(tier=identity)不算安全网 ⇒ null', async () => {
    const space = await makeSpace()
    await writeBackupFact(space, NOW - DAY, 'identity')
    expect(await readFullBackupAt(space)).toBeNull()
  })

  it('全量档读回 at', async () => {
    const space = await makeSpace()
    await writeBackupFact(space, NOW - DAY)
    expect(await readFullBackupAt(space)).toBe(NOW - DAY)
  })
})

describe('gitHeadEpochMs', () => {
  it('HEAD 提交秒 ⇒ 毫秒', async () => {
    const { git } = gitAt(1_700_000_000)
    expect(await gitHeadEpochMs('/anywhere', git)).toBe(1_700_000_000_000)
  })

  it('非零退出(非 git 仓) ⇒ null', async () => {
    const { git } = gitAt(null)
    expect(await gitHeadEpochMs('/anywhere', git)).toBeNull()
  })

  it('runner reject(git 不在机上) ⇒ null', async () => {
    const git: GitRunner = async () => {
      throw new Error('spawn git ENOENT')
    }
    expect(await gitHeadEpochMs('/anywhere', git)).toBeNull()
  })

  it('垃圾 stdout ⇒ null', async () => {
    const git: GitRunner = async () => ({ code: 0, stdout: 'nonsense\n', stderr: '' })
    expect(await gitHeadEpochMs('/anywhere', git)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 类①视野:知识库归档层(git 快照或全量备份都算安全网)
// ---------------------------------------------------------------------------

describe('retentionLadderOnce — memory-archive', () => {
  it('过期且进过 git 快照 ⇒ 删且台账行逐字段对;没过期的邻居不动', async () => {
    const space = await makeSpace()
    const old = join(space, 'butler', 'memory', 'user', 'u1', 'knowledge', 'archive', 'old.md')
    const fresh = join(space, 'butler', 'memory', 'user', 'u1', 'knowledge', 'archive', 'fresh.md')
    await fileAt(old, 100 * DAY)
    await fileAt(fresh, 10 * DAY)
    const { git, calls } = gitAt(Math.floor((NOW - 50 * DAY) / 1000))
    const result = await retentionLadderOnce(ladderOpts(space, { memory_archive_days: 60 }, { git }))
    expect(result).toEqual({ deleted: 1, skippedNoNet: 0, blockedAudit: 0, failed: 0 })
    expect(await exists(old)).toBe(false)
    expect(await exists(fresh)).toBe(true)
    // git 在这个成员自己的记忆树目录里问的 HEAD
    expect(calls[0]?.cwd).toBe(join(space, 'butler', 'memory', 'user', 'u1'))
    const rows = await readActions(space)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      at: new Date(NOW).toISOString(),
      kind: 'delete',
      class: 'retention',
      scope: 'memory-archive',
      file: join('u1', 'knowledge', 'archive', 'old.md'),
      bytes: 4,
    })
  })

  it('岔口①:过期但没进任何安全网 ⇒ skippedNoNet,文件原地留,零台账行', async () => {
    const space = await makeSpace()
    const old = join(space, 'butler', 'memory', 'user', 'u1', 'knowledge', 'archive', 'old.md')
    await fileAt(old, 100 * DAY)
    const { git } = gitAt(null)
    const result = await retentionLadderOnce(ladderOpts(space, { memory_archive_days: 60 }, { git }))
    expect(result).toEqual({ deleted: 0, skippedNoNet: 1, blockedAudit: 0, failed: 0 })
    expect(await exists(old)).toBe(true)
    expect(await readActions(space)).toHaveLength(0)
  })

  it('没有过期候选 ⇒ git 一次都不被调(6h 节律下不白跑子进程)', async () => {
    const space = await makeSpace()
    await fileAt(join(space, 'butler', 'memory', 'user', 'u1', 'knowledge', 'archive', 'a.md'), 10 * DAY)
    const { git, calls } = gitAt(Math.floor(NOW / 1000))
    const result = await retentionLadderOnce(ladderOpts(space, { memory_archive_days: 60 }, { git }))
    expect(result.deleted).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('只有全量备份没有 git ⇒ 备份也是安全网(netAt 取两者较大)', async () => {
    const space = await makeSpace()
    const old = join(space, 'butler', 'memory', 'user', 'u1', 'knowledge', 'archive', 'old.md')
    await fileAt(old, 100 * DAY)
    await writeBackupFact(space, NOW)
    const { git } = gitAt(null)
    const result = await retentionLadderOnce(ladderOpts(space, { memory_archive_days: 60 }, { git }))
    expect(result.deleted).toBe(1)
    expect(await exists(old)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 类②视野:翻篇的长任务档案(判定锚 dossier.json 的 status/updatedAt)
// ---------------------------------------------------------------------------

describe('retentionLadderOnce — longrun', () => {
  it('done + 过期 + 进过备份 ⇒ 整目录清掉,每件一行台账', async () => {
    const space = await makeSpace()
    const dir = await writeDossier(space, 'u1', 't1', 'done', NOW - 120 * DAY)
    await writeBackupFact(space, NOW)
    const result = await retentionLadderOnce(ladderOpts(space, { dossier_days: 90 }))
    expect(result.deleted).toBe(2)
    expect(await exists(dir)).toBe(false)
    const rows = await readActions(space)
    expect(rows.map((r) => r.file).sort()).toEqual([
      join('u1', 't1', 'dossier.json'),
      join('u1', 't1', 'journal.jsonl'),
    ])
    expect(rows.every((r) => r.scope === 'longrun')).toBe(true)
  })

  it('active/blocked 任务档案结构性不进候选:静默跳过且不计 skippedNoNet', async () => {
    const space = await makeSpace()
    const dir = await writeDossier(space, 'u1', 't1', 'active', NOW - 400 * DAY)
    await writeBackupFact(space, NOW)
    const result = await retentionLadderOnce(ladderOpts(space, { dossier_days: 90 }))
    expect(result).toEqual({ deleted: 0, skippedNoNet: 0, blockedAudit: 0, failed: 0 })
    expect(await exists(join(dir, 'dossier.json'))).toBe(true)
  })

  it('done 但 updatedAt 还没过保留期 ⇒ 不碰', async () => {
    const space = await makeSpace()
    const dir = await writeDossier(space, 'u1', 't1', 'done', NOW - 10 * DAY)
    await writeBackupFact(space, NOW)
    const result = await retentionLadderOnce(ladderOpts(space, { dossier_days: 90 }))
    expect(result.deleted).toBe(0)
    expect(await exists(join(dir, 'dossier.json'))).toBe(true)
  })

  it('岔口①:done + 过期但没有全量备份 ⇒ skippedNoNet 按目录计 1(不按文件数)', async () => {
    const space = await makeSpace()
    const dir = await writeDossier(space, 'u1', 't1', 'done', NOW - 120 * DAY)
    const result = await retentionLadderOnce(ladderOpts(space, { dossier_days: 90 }))
    expect(result).toEqual({ deleted: 0, skippedNoNet: 1, blockedAudit: 0, failed: 0 })
    expect(await exists(join(dir, 'dossier.json'))).toBe(true)
    expect(await exists(join(dir, 'journal.jsonl'))).toBe(true)
  })

  it('dossier.json 是坏档 ⇒ 读不出判定就不动(证据原地留)', async () => {
    const space = await makeSpace()
    const dir = join(space, 'butler', 'longrun', 'user', 'u1', 't1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'dossier.json'), '{nope', 'utf8')
    await writeBackupFact(space, NOW)
    const result = await retentionLadderOnce(ladderOpts(space, { dossier_days: 90 }))
    expect(result.deleted).toBe(0)
    expect(await exists(join(dir, 'dossier.json'))).toBe(true)
  })

  it('任务目录里有子目录 ⇒ 文件照删,rmdir 失败吞掉,目录留着无害', async () => {
    const space = await makeSpace()
    const dir = await writeDossier(space, 'u1', 't1', 'done', NOW - 120 * DAY, [])
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'sub', 'keep.txt'), 'x', 'utf8')
    await writeBackupFact(space, NOW)
    const result = await retentionLadderOnce(ladderOpts(space, { dossier_days: 90 }))
    expect(result.deleted).toBe(1)
    expect(await exists(join(dir, 'dossier.json'))).toBe(false)
    expect(await exists(dir)).toBe(true)
    expect(await exists(join(dir, 'sub', 'keep.txt'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 类③视野:离场成员的会话窗(identity 读失败是反方向)
// ---------------------------------------------------------------------------

describe('retentionLadderOnce — sessions', () => {
  it('离场 + 过期 + 进过备份 ⇒ 删,台账 file 是裸文件名(永不落绝对路径)', async () => {
    const space = await makeSpace()
    await fileAt(join(space, 'butler', 'sessions', 'ghost.json'), 60 * DAY)
    await writeBackupFact(space, NOW)
    const result = await retentionLadderOnce(
      ladderOpts(space, { departed_session_days: 30 }, { liveUserIds: new Set(['alice']) }),
    )
    expect(result.deleted).toBe(1)
    const rows = await readActions(space)
    expect(rows[0]?.scope).toBe('sessions')
    expect(rows[0]?.file).toBe('ghost.json')
  })

  it('在册成员的窗静默期再长也不碰', async () => {
    const space = await makeSpace()
    const f = join(space, 'butler', 'sessions', 'alice.json')
    await fileAt(f, 400 * DAY)
    await writeBackupFact(space, NOW)
    const result = await retentionLadderOnce(
      ladderOpts(space, { departed_session_days: 30 }, { liveUserIds: new Set(['alice']) }),
    )
    expect(result.deleted).toBe(0)
    expect(await exists(f)).toBe(true)
  })

  it('.corrupt-* 隔离件是证据不是候选', async () => {
    const space = await makeSpace()
    const f = join(space, 'butler', 'sessions', 'dead.corrupt-99.json')
    await fileAt(f, 400 * DAY)
    await writeBackupFact(space, NOW)
    const result = await retentionLadderOnce(ladderOpts(space, { departed_session_days: 30 }))
    expect(result.deleted).toBe(0)
    expect(await exists(f)).toBe(true)
  })

  it('不变量 4:identity 读不动(liveUserIds null) ⇒ 整类跳过 + warn,备份齐全也不删', async () => {
    const space = await makeSpace()
    const f = join(space, 'butler', 'sessions', 'ghost.json')
    await fileAt(f, 60 * DAY)
    await writeBackupFact(space, NOW)
    const { logger, warns } = makeLogger()
    const result = await retentionLadderOnce(
      ladderOpts(space, { departed_session_days: 30 }, { liveUserIds: null, logger }),
    )
    expect(result.deleted).toBe(0)
    expect(await exists(f)).toBe(true)
    expect(warns).toContain('retention: identity unreadable, departed-session ladder skipped this tick')
  })

  it('文件名是 encodeURIComponent 过的 uid ⇒ 解码后对在册名单', async () => {
    const space = await makeSpace()
    const f = join(space, 'butler', 'sessions', 'a%3Ab.json')
    await fileAt(f, 400 * DAY)
    await writeBackupFact(space, NOW)
    const result = await retentionLadderOnce(
      ladderOpts(space, { departed_session_days: 30 }, { liveUserIds: new Set(['a:b']) }),
    )
    expect(result.deleted).toBe(0)
    expect(await exists(f)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 不变量 3:先落账再动手
// ---------------------------------------------------------------------------

describe('retentionLadderOnce — audit-first', () => {
  it('台账写不进去 ⇒ blockedAudit 计数,一个字节不删,恰好一次响亮 warn', async () => {
    const space = await makeSpace()
    const a = join(space, 'butler', 'sessions', 'ghost1.json')
    const b = join(space, 'butler', 'sessions', 'ghost2.json')
    await fileAt(a, 60 * DAY)
    await fileAt(b, 60 * DAY)
    await writeBackupFact(space, NOW)
    // actionsFile 的父路径是一个普通文件 ⇒ mkdir/append 双双失败
    await writeFile(join(space, 'blocked'), 'not a dir', 'utf8')
    const { logger, warns } = makeLogger()
    const result = await retentionLadderOnce(
      ladderOpts(space, { departed_session_days: 30 }, {
        actionsFile: join(space, 'blocked', 'actions.jsonl'),
        logger,
      }),
    )
    expect(result).toEqual({ deleted: 0, skippedNoNet: 0, blockedAudit: 2, failed: 0 })
    expect(await exists(a)).toBe(true)
    expect(await exists(b)).toBe(true)
    expect(warns.filter((w) => w === 'retention: audit ledger unwritable, deletions skipped')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 状态文件 — 巡检黄牌的唯一数据源
// ---------------------------------------------------------------------------

describe('retention state file', () => {
  it('阶梯跑过就落 runtime/retention-state.json,readRetentionState 逐字段读回', async () => {
    const space = await makeSpace()
    await fileAt(join(space, 'butler', 'sessions', 'ghost.json'), 60 * DAY)
    await writeBackupFact(space, NOW)
    const result = await retentionLadderOnce(ladderOpts(space, { departed_session_days: 30 }))
    expect(await readRetentionState(space)).toEqual({ at: NOW, ...result })
  })

  it('缺席 ⇒ null', async () => {
    const space = await makeSpace()
    expect(await readRetentionState(space)).toBeNull()
  })

  it('坏形状/垃圾 ⇒ null(观察者永不隔离)', async () => {
    const space = await makeSpace()
    await mkdir(join(space, 'runtime'), { recursive: true })
    await writeFile(join(space, 'runtime', 'retention-state.json'), '{"at": 5}', 'utf8')
    expect(await readRetentionState(space)).toBeNull()
    await writeFile(join(space, 'runtime', 'retention-state.json'), 'garbage', 'utf8')
    expect(await readRetentionState(space)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// buildRetentionLadder — disarm 门在阶梯之前(不变量 1)
// ---------------------------------------------------------------------------

describe('buildRetentionLadder', () => {
  it('策略缺席 ⇒ thunk 回 null 且盘上零字节(连 runtime/ 都不出现)', async () => {
    const space = await makeSpace()
    const ladder = buildRetentionLadder({ spaceDir: space })
    expect(await ladder()).toBeNull()
    expect(await readdir(space)).toEqual([])
  })

  it('{} 零键策略 ⇒ 同样 disarmed,零字节', async () => {
    const space = await makeSpace()
    await writeFile(join(space, RETENTION_FILE), '{}', 'utf8')
    const ladder = buildRetentionLadder({ spaceDir: space })
    expect(await ladder()).toBeNull()
    expect((await readdir(space)).sort()).toEqual([RETENTION_FILE])
  })

  it('armed ⇒ 真删 + 状态文件落地(thunk 不收 now,用真实时钟相对 mtime)', async () => {
    const space = await makeSpace()
    await writeFile(join(space, RETENTION_FILE), JSON.stringify({ departed_session_days: 30 }), 'utf8')
    await fileAtReal(join(space, 'butler', 'sessions', 'ghost.json'), 400 * DAY)
    await writeBackupFact(space, Date.now())
    const ladder = buildRetentionLadder({ spaceDir: space, listUserIds: () => [] })
    const result = await ladder()
    expect(result?.deleted).toBe(1)
    expect(await exists(join(space, 'runtime', 'retention-state.json'))).toBe(true)
  })

  it('listUserIds 抛错 ⇒ liveUserIds null ⇒ 会话类跳过 + warn', async () => {
    const space = await makeSpace()
    await writeFile(join(space, RETENTION_FILE), JSON.stringify({ departed_session_days: 30 }), 'utf8')
    const ghost = join(space, 'butler', 'sessions', 'ghost.json')
    await fileAtReal(ghost, 400 * DAY)
    await writeBackupFact(space, Date.now())
    const { logger, warns } = makeLogger()
    const ladder = buildRetentionLadder({
      spaceDir: space,
      listUserIds: () => {
        throw new Error('identity down')
      },
      logger,
    })
    const result = await ladder()
    expect(result?.deleted).toBe(0)
    expect(await exists(ghost)).toBe(true)
    expect(warns).toContain('retention: identity unreadable, departed-session ladder skipped this tick')
  })

  it('每次调用新读策略:set_retention 改完下一轮维护即生效,不必重启', async () => {
    const space = await makeSpace()
    const ladder = buildRetentionLadder({ spaceDir: space, listUserIds: () => [] })
    expect(await ladder()).toBeNull()
    await writeRetentionPolicy(space, () => ({ departed_session_days: 30 }))
    const second = await ladder()
    expect(second).not.toBeNull()
    expect(second?.deleted).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 巡检黄牌 — 岔口① 的「响亮说」那一半
// ---------------------------------------------------------------------------

describe('retentionSkipCard', () => {
  const state = (over: Partial<{ at: number; skippedNoNet: number }> = {}) => ({
    at: over.at ?? NOW - 1000,
    deleted: 0,
    skippedNoNet: over.skippedNoNet ?? 3,
    blockedAudit: 0,
    failed: 0,
  })

  it('台账缺席 ⇒ 不出牌(未知不是坏)', () => {
    expect(retentionSkipCard(null, NOW)).toBeNull()
  })

  it('状态过陈(>48h) ⇒ 不出牌(阶梯没在跑,旧数字不该一直黄着)', () => {
    expect(retentionSkipCard(state({ at: NOW - RETENTION_SKIP_STALE_MS - 1 }), NOW)).toBeNull()
    expect(retentionSkipCard(state({ at: NOW - RETENTION_SKIP_STALE_MS }), NOW)).not.toBeNull()
  })

  it('skippedNoNet 为 0 ⇒ 不出牌', () => {
    expect(retentionSkipCard(state({ skippedNoNet: 0 }), NOW)).toBeNull()
  })

  it('有跳过 ⇒ 黄牌带数字与备份指路', () => {
    const card = retentionSkipCard(state(), NOW)
    expect(card?.id).toBe(RETENTION_SKIP_CARD_ID)
    expect(card?.severity).toBe('yellow')
    expect(card?.label).toBe('过期内容缺备份安全网,暂未清理')
    expect(card?.fact).toContain('3 份')
    expect(card?.fact).toContain('想看备份怎么打')
  })
})

// ---------------------------------------------------------------------------
// 载体 — spaceUpkeepAt extras.ladder:先清扫,后阶梯,末丈量
// ---------------------------------------------------------------------------

describe('spaceUpkeepAt — retention extras', () => {
  it('阶梯排在清扫之后(账本永远反映清扫后的真相),丈量行照常返回', async () => {
    const space = await makeSpace()
    const orphan = join(space, 'stale.tmp')
    await fileAtReal(orphan, 48 * 60 * 60 * 1000)
    const { logger } = makeLogger()
    let orphanAliveAtLadderTime: boolean | null = null
    const upkeep = spaceUpkeepAt(space, logger, {
      ladder: async () => {
        orphanAliveAtLadderTime = await exists(orphan)
      },
    })
    const row = await upkeep.run()
    expect(orphanAliveAtLadderTime).toBe(false)
    expect(row).not.toBeNull()
  })

  it('阶梯抛错 ⇒ warn 一声,丈量不连累', async () => {
    const space = await makeSpace()
    const { logger, warns } = makeLogger()
    const upkeep = spaceUpkeepAt(space, logger, {
      ladder: async () => {
        throw new Error('ladder blew up')
      },
    })
    const row = await upkeep.run()
    expect(row).not.toBeNull()
    expect(warns).toContain('space upkeep: retention ladder failed')
  })

  it('extras 缺席 ⇒ M2 形态照旧(run 返回丈量行)', async () => {
    const space = await makeSpace()
    const { logger } = makeLogger()
    const upkeep = spaceUpkeepAt(space, logger)
    expect(await upkeep.run()).not.toBeNull()
  })
})
