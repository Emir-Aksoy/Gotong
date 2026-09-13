/**
 * STOR-M3 成员内容保留阶梯(类③):策略人定一次(retention.json + set_retention),
 * 执行自动跑(骑 spaceUpkeepAt 的 ladder 缝,零新定时器)。
 *
 * 四条承重不变量:
 *   1. **策略缺席 = 不删 = 字节不变**。retention.json 不存在/坏形状/未知键 ⇒
 *      整份不装(半开的剪刀比没有剪刀更坏),阶梯 thunk 直接返回,盘上零字节写入
 *      (连 state 文件都不落——没武装的剪刀不该留任何痕迹)。
 *   2. **岔口①硬前置**:每一条成员内容删除,先确认「已进最近一次备份或 git 快照」
 *      (文件 mtime ≤ 安全网时刻)。网缺席/陈旧 ⇒ skippedNoNet++,巡检黄牌响亮说,
 *      **绝不静默删**。生产 backups/ 0 份 ⇒ 初期恒跳过,是特性不是缺陷。
 *   3. **先落账再动手**(与 space-sweeper 共用 makeAuditAppender):账写不进去就
 *      不删;unlink 非 ENOENT 失败补 delete_failed 行;ENOENT 当已删。
 *   4. **读失败的方向性**:找候选的读(列目录/递归走树)失败折 [] = 安全(读不动
 *      ⇒ 什么都不删);identity 读失败是**反方向**(读成「全员离场」= 全删)⇒
 *      liveUserIds 为 null 时离场会话类整类跳过 + warn。
 *
 * 三类阶梯对象(全部只认「翻篇的」,活跃内容结构性不产生候选):
 *   - memory-archive: <space>/butler/memory/user/<uid>/knowledge/archive/**
 *     (LIB 归档层=挪走不真删的那一层;活书架 knowledge/ 本体不进视野)
 *   - longrun: <space>/butler/longrun/user/<uid>/<taskId>/(dossier status done|cancelled
 *     才算翻篇;blocked/active 结构性保护——那是还在等人的活)
 *   - sessions: <space>/butler/sessions/<uid>.json(仅**离场**成员=不在 identity
 *     名册里的;在册成员的窗静默期再长也不碰——SESS 60min 自然开新对话,旧窗无害)
 */

import { mkdir, readFile, readdir, lstat, rmdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic, type Logger } from '@gotong/core'
import { parseLastBackupFact, LAST_BACKUP_FACT_NAME } from '@gotong/cli'
import { ownerDir } from '@gotong/service-memory-file'
import { execFileGitRunner, type GitRunner } from './butler-memory-git.js'
import { makeAuditAppender, SPACE_ACTIONS_FILE, type SpaceActionEntry } from './space-sweeper.js'
import { ButlerUserActivity } from './butler-user-activity.js'
import { FileButlerUserIsolation } from './butler-user-isolation.js'
import { butlerLongRunRoot } from './butler-space-dirs.js'

// ---------------------------------------------------------------------------
// 策略文件(file-first,岔口② 拍板不走 env——旋钮 114 冻结零新增)
// ---------------------------------------------------------------------------

/** 策略文件名,落空间根(hands.json 同族)。 */
export const RETENTION_FILE = 'retention.json'

/**
 * 策略键闭集:JSON 文件键 ≡ set_retention 参数枚举值,一个名字两处用,零映射层。
 * 加新键 = 改这一个数组(loader 未知键拒 + 工具 enum + 设置卡全跟着走)。
 */
export const RETENTION_KEYS = ['memory_archive_days', 'dossier_days', 'departed_session_days'] as const

export type RetentionKey = (typeof RETENTION_KEYS)[number]

/** 天数下限=读者感知保护线(EFF-M3 30 天窗读 inbox/escalate,删了它读的窗=把「被删」读成「没发生」)。 */
export const RETENTION_MIN_DAYS = 30
/** 天数上限:十年。再往上就是「永不删」,那用「不设这个键」表达。 */
export const RETENTION_MAX_DAYS = 3650

export interface RetentionPolicy {
  readonly memory_archive_days?: number
  readonly dossier_days?: number
  readonly departed_session_days?: number
}

function isValidDays(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= RETENTION_MIN_DAYS && v <= RETENTION_MAX_DAYS
}

/**
 * 读策略。缺席=静默 null(没配置是常态不是事故);其余每一种「读到了但不对」都
 * warn + **整份 null**——一份带未知键/坏值的策略文件,装一半会让人以为「我配的
 * 那几条在生效」而实际哪几条在跑没人说得清。`{}` 是合法的零动作策略。
 */
export async function loadRetentionPolicy(
  spaceDir: string,
  logger?: Pick<Logger, 'warn'>,
): Promise<RetentionPolicy | null> {
  const file = join(spaceDir, RETENTION_FILE)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return null
    logger?.warn('retention: policy file unreadable, ladder disarmed', {
      file: RETENTION_FILE,
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logger?.warn('retention: policy file is not valid JSON, ladder disarmed', { file: RETENTION_FILE })
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger?.warn('retention: policy must be a JSON object, ladder disarmed', { file: RETENTION_FILE })
    return null
  }
  const obj = parsed as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!(RETENTION_KEYS as readonly string[]).includes(key)) {
      logger?.warn('retention: unknown policy key, ladder disarmed', {
        file: RETENTION_FILE,
        key,
        allowed: RETENTION_KEYS.join(','),
      })
      return null
    }
  }
  const out: Record<string, number> = {}
  for (const key of RETENTION_KEYS) {
    const v = obj[key]
    if (v === undefined) continue
    if (!isValidDays(v)) {
      logger?.warn('retention: policy value out of range, ladder disarmed', {
        file: RETENTION_FILE,
        key,
        min: RETENTION_MIN_DAYS,
        max: RETENTION_MAX_DAYS,
      })
      return null
    }
    out[key] = v
  }
  return out as RetentionPolicy
}

/** per-spaceDir 写链:两个并发 set_retention 不许交错读改写。 */
const writeChains = new Map<string, Promise<unknown>>()

/**
 * 改策略(读-改-写,原子落盘)。当前文件坏 ⇒ 从 `{}` 起步(策略不是证据——人正在
 * 表达新意图,旧的坏文件已由 loader 自己 warn 过)。**mutate 产出先验后写**:写出
 * 一份 loader 会整份拒的策略 = 剪刀静默死掉,响亮抛错好过那个。
 */
export async function writeRetentionPolicy(
  spaceDir: string,
  mutate: (current: RetentionPolicy) => RetentionPolicy,
  logger?: Pick<Logger, 'warn'>,
): Promise<RetentionPolicy> {
  const prev = writeChains.get(spaceDir) ?? Promise.resolve()
  const task = prev.then(async () => {
    const current = (await loadRetentionPolicy(spaceDir, logger)) ?? {}
    const next = mutate(current)
    const updated: Record<string, number> = {}
    for (const [k, v] of Object.entries(next)) {
      if (!(RETENTION_KEYS as readonly string[]).includes(k)) {
        throw new Error(`retention: refusing to write unknown policy key: ${k}`)
      }
      if (!isValidDays(v)) {
        throw new Error(`retention: refusing to write invalid value: ${k}=${String(v)}`)
      }
      updated[k] = v
    }
    await writeFileAtomic(join(spaceDir, RETENTION_FILE), JSON.stringify(updated, null, 2) + '\n')
    return updated as RetentionPolicy
  })
  writeChains.set(
    spaceDir,
    task.catch(() => undefined),
  )
  return task
}

// ---------------------------------------------------------------------------
// 岔口① 安全网时刻
// ---------------------------------------------------------------------------

/**
 * 最近一次**全量**备份的时刻(epoch ms)。事实文件缺/坏/子集档 ⇒ null——子集档
 * (identity/relations)盖不住成员内容,而事实文件只记最近一次:被子集档覆写 =
 * 「最近一次备份」诚实地不再兜底成员内容,网如实撤回。
 */
export async function readFullBackupAt(spaceDir: string): Promise<number | null> {
  let raw: string
  try {
    raw = await readFile(join(spaceDir, LAST_BACKUP_FACT_NAME), 'utf8')
  } catch {
    return null
  }
  const fact = parseLastBackupFact(raw)
  if (!fact || fact.tier !== 'full') return null
  return Number.isFinite(fact.at) ? fact.at : null
}

/**
 * 目录所在 git 仓最新 commit 的时刻(epoch ms)。没仓/没 commit/git 不在 ⇒ null。
 * (MU-M5 记忆树快照是 per-user `.git`,knowledge/archive 在它下面。)
 */
export async function gitHeadEpochMs(dir: string, git: GitRunner): Promise<number | null> {
  try {
    const res = await git(['log', '-1', '--format=%ct'], dir)
    if (res.code !== 0) return null
    const sec = Number.parseInt(res.stdout.trim(), 10)
    return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 只读候选采集(读失败一律折「没有候选」——方向性:读不动 ⇒ 什么都不删)
// ---------------------------------------------------------------------------

async function listDirNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

interface CandidateFile {
  /** 台账用的相对标签(永不落绝对路径)。 */
  readonly label: string
  readonly path: string
  readonly mtimeMs: number
  readonly size: number
}

/** 一层文件(符号链接既不是 isFile 也不进递归——两个分支都接不住它=结构性跳过)。 */
async function listFilesShallow(dir: string, labelPrefix: string): Promise<CandidateFile[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: CandidateFile[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    const p = join(dir, e.name)
    try {
      const st = await lstat(p)
      if (!st.isFile()) continue
      out.push({ label: labelPrefix ? join(labelPrefix, e.name) : e.name, path: p, mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      // 与并发写者赛跑输了 ⇒ 不是候选
    }
  }
  return out
}

const ARCHIVE_WALK_MAX_DEPTH = 8

/** 递归收归档层文件(深度封顶防敌意深树;只收文件,空目录留着=v1 诚实简化)。 */
async function collectArchiveFiles(dir: string, labelPrefix: string, depth: number): Promise<CandidateFile[]> {
  if (depth > ARCHIVE_WALK_MAX_DEPTH) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: CandidateFile[] = []
  for (const e of entries) {
    const p = join(dir, e.name)
    const label = labelPrefix ? join(labelPrefix, e.name) : e.name
    if (e.isDirectory()) {
      out.push(...(await collectArchiveFiles(p, label, depth + 1)))
    } else if (e.isFile()) {
      try {
        const st = await lstat(p)
        if (st.isFile()) out.push({ label, path: p, mtimeMs: st.mtimeMs, size: st.size })
      } catch {
        // 赛跑输了 ⇒ 不是候选
      }
    }
  }
  return out
}

/**
 * 窄读 dossier 的翻篇裁决:{closed, updatedAtMs} 或 null(读不出=不是候选)。
 * **刻意不走 openLongRunDossierStore**——那个 loader 遇坏档会改名隔离,而一个会
 * 给写者的文件改名的读者不是读者(OBS-M2 判例);这里只要两个字段,坏档=null。
 */
async function readDossierVerdict(file: string): Promise<{ closed: boolean; updatedAtMs: number } | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  const status = obj['status']
  if (typeof status !== 'string') return null
  const closed = status === 'done' || status === 'cancelled'
  const rawAt = obj['updatedAt']
  let updatedAtMs: number
  if (typeof rawAt === 'number') updatedAtMs = rawAt
  else if (typeof rawAt === 'string') updatedAtMs = Date.parse(rawAt)
  else return null
  if (!Number.isFinite(updatedAtMs)) return null
  return { closed, updatedAtMs }
}

// ---------------------------------------------------------------------------
// 阶梯一轮
// ---------------------------------------------------------------------------

export interface RetentionLadderResult {
  readonly deleted: number
  /** 过期但没进安全网被跳过的删除单元数(dossier 目录=1 个单元,归档/会话文件各=1)。 */
  readonly skippedNoNet: number
  readonly blockedAudit: number
  /** Delete failures plus user/category operations refused or interrupted by isolation. */
  readonly failed: number
}

export interface RetentionLadderOptions {
  readonly userActivity?: ButlerUserActivity
  readonly spaceDir: string
  readonly actionsFile: string
  readonly policy: RetentionPolicy
  /** null = identity 读不动 ⇒ 离场会话类整类跳过(读不动 ≠ 全员离场)。 */
  readonly liveUserIds: ReadonlySet<string> | null
  readonly git?: GitRunner
  readonly logger?: Pick<Logger, 'warn'>
  readonly now?: () => number
}

/** 状态文件名(runtime/ 下,巡检黄牌的唯一数据源;只在阶梯真跑过时才存在)。 */
export const RETENTION_STATE_FILE = 'retention-state.json'

export interface RetentionState {
  readonly at: number
  readonly deleted: number
  readonly skippedNoNet: number
  readonly blockedAudit: number
  readonly failed: number
}

/** 宽容读状态:缺/坏/形状不对 ⇒ null(观察者永不隔离)。 */
export async function readRetentionState(spaceDir: string): Promise<RetentionState | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(spaceDir, 'runtime', RETENTION_STATE_FILE), 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  const nums = ['at', 'deleted', 'skippedNoNet', 'blockedAudit', 'failed'] as const
  for (const k of nums) {
    if (typeof obj[k] !== 'number' || !Number.isFinite(obj[k] as number)) return null
  }
  return {
    at: obj.at as number,
    deleted: obj.deleted as number,
    skippedNoNet: obj.skippedNoNet as number,
    blockedAudit: obj.blockedAudit as number,
    failed: obj.failed as number,
  }
}

/**
 * 跑一轮成员内容阶梯。每类各自按策略键武装(键缺席=该类零动作);全程永不抛。
 */
export async function retentionLadderOnce(opts: RetentionLadderOptions): Promise<RetentionLadderResult> {
  const memoryRoot = join(opts.spaceDir, 'butler', 'memory')
  const activity = opts.userActivity ?? new ButlerUserActivity(new FileButlerUserIsolation(memoryRoot))
  const now = opts.now ? opts.now() : Date.now()
  const git = opts.git ?? execFileGitRunner
  const appendAudit = makeAuditAppender(opts.actionsFile, opts.logger, 'retention')
  const fullBackupAt = await readFullBackupAt(opts.spaceDir)

  let deleted = 0
  let skippedNoNet = 0
  let blockedAudit = 0
  let failed = 0

  const forUser = async (uid: string, work: () => Promise<void>): Promise<void> => {
    try {
      await activity.run(uid, work)
    } catch {
      failed++
      opts.logger?.warn('retention: user operation blocked or failed')
    }
  }

  /** 边界③ 执法件:账落下才 unlink;ENOENT=已删;其余失败补 delete_failed 行。 */
  const deleteWithLedger = async (scope: string, file: CandidateFile): Promise<boolean> => {
    const row: SpaceActionEntry = {
      at: new Date(now).toISOString(),
      kind: 'delete',
      class: 'retention',
      scope,
      file: file.label,
      bytes: file.size,
    }
    if (!(await appendAudit(row))) {
      blockedAudit++
      return false
    }
    try {
      await unlink(file.path)
      deleted++
      return true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        deleted++
        return true
      }
      failed++
      await appendAudit({ ...row, kind: 'delete_failed' })
      return false
    }
  }

  // --- 类 1: 记忆归档层(网 = max(全量备份, per-user git 快照)) ---
  const archiveDays = opts.policy.memory_archive_days
  if (archiveDays !== undefined) {
    const cutoff = now - archiveDays * 86_400_000
    const memRoot = join(opts.spaceDir, 'butler', 'memory', 'user')
    for (const uid of await listDirNames(memRoot)) {
      await forUser(uid, async () => {
        const userDir = join(memRoot, uid)
        const archiveDir = join(userDir, 'knowledge', 'archive')
        const files = await collectArchiveFiles(archiveDir, join(uid, 'knowledge', 'archive'), 0)
        const expired = files.filter((f) => f.mtimeMs < cutoff)
        if (expired.length === 0) return
        const gitAt = await gitHeadEpochMs(userDir, git)
        const netAt = Math.max(fullBackupAt ?? Number.NEGATIVE_INFINITY, gitAt ?? Number.NEGATIVE_INFINITY)
        for (const f of expired) {
          if (!(f.mtimeMs <= netAt)) {
            skippedNoNet++
            continue
          }
          await deleteWithLedger('memory-archive', f)
        }
      })
    }
  }

  // --- 类 2: 翻篇长任务档案(done|cancelled;网 = 全量备份) ---
  const dossierDays = opts.policy.dossier_days
  if (dossierDays !== undefined) {
    const cutoff = now - dossierDays * 86_400_000
    const longrunRoot = butlerLongRunRoot(memoryRoot)
    for (const uid of await listDirNames(join(longrunRoot, 'user'))) {
      await forUser(uid, async () => {
        const userDir = ownerDir(longrunRoot, { kind: 'user', id: uid })
        for (const taskId of await listDirNames(userDir)) {
          const taskDir = join(userDir, taskId)
          const verdict = await readDossierVerdict(join(taskDir, 'dossier.json'))
          if (!verdict || !verdict.closed || !(verdict.updatedAtMs < cutoff)) continue
          if (fullBackupAt === null || !(verdict.updatedAtMs <= fullBackupAt)) {
            skippedNoNet++
            continue
          }
          const files = await listFilesShallow(taskDir, join(uid, taskId))
          let allGone = true
          for (const f of files) {
            if (!(await deleteWithLedger('longrun', f))) allGone = false
          }
          if (allGone) {
            try {
              await rmdir(taskDir)
            } catch {
              // 目录非空(有子目录/新文件)=留着,无害
            }
          }
        }
      })
    }
  }

  // --- 类 3: 离场成员的会话窗(网 = 全量备份;identity 读不动 ⇒ 整类跳过) ---
  const sessionDays = opts.policy.departed_session_days
  if (sessionDays !== undefined) {
    if (opts.liveUserIds === null) {
      opts.logger?.warn('retention: identity unreadable, departed-session ladder skipped this tick')
    } else {
      const cutoff = now - sessionDays * 86_400_000
      const sessionsDir = join(opts.spaceDir, 'butler', 'sessions')
      for (const f of await listFilesShallow(sessionsDir, '')) {
        if (!f.label.endsWith('.json') || f.label.includes('.corrupt-')) continue
        let uid: string
        try {
          uid = decodeURIComponent(f.label.slice(0, -'.json'.length))
        } catch {
          continue
        }
        if (opts.liveUserIds.has(uid)) continue
        await forUser(uid, async () => {
          if (!(f.mtimeMs < cutoff)) return
          if (fullBackupAt === null || !(f.mtimeMs <= fullBackupAt)) {
            skippedNoNet++
            return
          }
          await deleteWithLedger('sessions', f)
        })
      }
    }
  }

  const result: RetentionLadderResult = { deleted, skippedNoNet, blockedAudit, failed }
  try {
    const stateFile = join(opts.spaceDir, 'runtime', RETENTION_STATE_FILE)
    await mkdir(dirname(stateFile), { recursive: true })
    await writeFileAtomic(stateFile, JSON.stringify({ at: now, ...result }, null, 2) + '\n')
  } catch (err) {
    opts.logger?.warn('retention: state file write failed', {
      err: err instanceof Error ? err.message : String(err),
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// 装配:阶梯 thunk(spaceUpkeepAt extras.ladder 的形状)
// ---------------------------------------------------------------------------

export interface RetentionLadderDeps {
  readonly userActivity?: ButlerUserActivity
  readonly spaceDir: string
  /** 在册成员 id 清单;抛错 ⇒ 离场会话类跳过(读不动 ≠ 全员离场)。 */
  readonly listUserIds?: () => string[]
  readonly git?: GitRunner
  readonly logger?: Pick<Logger, 'warn'>
}

/**
 * 造阶梯 thunk:每次调用**新读**策略(set_retention 改完下一轮维护即生效,
 * 不必重启);策略缺席/零键 ⇒ 直接返回,盘上零字节(不变量 1)。
 */
export function buildRetentionLadder(deps: RetentionLadderDeps): () => Promise<RetentionLadderResult | null> {
  const actionsFile = join(deps.spaceDir, 'runtime', SPACE_ACTIONS_FILE)
  const userActivity = deps.userActivity ?? new ButlerUserActivity(new FileButlerUserIsolation(join(deps.spaceDir, 'butler', 'memory')))
  return async () => {
    const policy = await loadRetentionPolicy(deps.spaceDir, deps.logger)
    if (!policy || !RETENTION_KEYS.some((k) => policy[k] !== undefined)) return null
    let liveUserIds: ReadonlySet<string> | null = null
    if (deps.listUserIds) {
      try {
        liveUserIds = new Set(deps.listUserIds())
      } catch {
        liveUserIds = null
      }
    }
    return retentionLadderOnce({
      userActivity,
      spaceDir: deps.spaceDir,
      actionsFile,
      policy,
      liveUserIds,
      git: deps.git,
      logger: deps.logger,
    })
  }
}
