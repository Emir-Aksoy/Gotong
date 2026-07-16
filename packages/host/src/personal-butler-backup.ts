/**
 * personal-butler-backup.ts — AFR-M7 阿同恢复层。
 *
 * AFR-C 的立场是零中央节点:恢复兜底 = **用户自持**分档档案(AFR-M6),阿同
 * 只做三件事——看(`backup_status` 只读事实)、提(陈旧提醒 sweeper)、打包
 * (`pack_backup`,批准后才动手)。知识 ≠ 授权(边界④):打包是**凭证级**动作
 * ——身份档里是 hub 的签名私钥,谁拿到谁能冒签名片——所以两道闸都在服务端:
 *
 *   - classify:非 owner/admin 直接 refuse(镜像 steward operator-only 姿态)。
 *     普通成员打包 hub 签名钥 = 提权,连 /me 收件箱都不该进;
 *   - 批准后 execute 再核一遍(park→批准之间角色可能被降,批准补不回资格)。
 *
 * 数据源 = CLI backup 成功后落的 `runtime/last-backup.json` 事实(谁跑的备份
 * 都算数:命令行打的档也让 backup_status 如实报)。打包本体**直接调
 * `@gotong/cli` 的 `backup()`**(host 本就依赖 cli;同一份代码,不 shell-out
 * 不复制),档案落 `<space>/backups/`——staging 排除规则已把这个目录挡在归档
 * 外(backup-core.isBackupOutputPath),档案永不套档案。
 *
 * 诚实边界(宁少列也核准):「上次备份之后新增了什么」只报 **peers**(行有
 * createdAt);managed agent spec 没有创建时间戳,数不出「新增几个」就不数,
 * 绝不编一个基线。
 *
 * 陈旧提醒镜像 TN-M2:6h 常量节律、纯时间戳分诊零 LLM(边界①)、只写自己的
 * 事实文件 `backup-nudges.json`、**送达才记标记**;同意面镜像 CARE-M3 巡检
 * (开了运行播报的成员才收),再叠 owner/admin 过滤——提醒只发给能按下打包的
 * 人。文案尾带 AFR-M5 面包屑指 backup 卡(成员回一句卡标题即拿完整修法)。
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { backup, parseLastBackupFact, LAST_BACKUP_FACT_NAME, type LastBackupFact } from '@gotong/cli'
import type { Logger } from '@gotong/core'
import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'
import { GovernedActionToolset } from '@gotong/personal-butler'
import { ownerDir } from '@gotong/service-memory-file'

import { guideBreadcrumb } from './personal-butler-guide.js'
import type { ButlerBriefPush } from './personal-butler-proactive.js'
import { readButlerRunBroadcastConfig } from './personal-butler-run-broadcast.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** 阿同能打的两档(AFR-M6 子集档)。全量/搬家档(含主钥)只走 CLI + 人手。 */
export type ButlerBackupSubsetTier = 'identity' | 'relations'

/** status / pack / 提醒共用的一份 ops——owner/admin 判定钉在这,服务端权威。 */
export interface ButlerBackupOps {
  /** 上次备份事实(null = 从未 / 记录读不出——都如实报「没有记录」)。 */
  lastBackup(): LastBackupFact | null
  /** 某时刻之后新增的互联关系条数(非密计数,只作陈旧度参照)。 */
  newPeersSince(ts: number): number
  /** owner/admin 才能打包(身份档含 hub 签名钥 = 凭证级)。 */
  privileged(userId: string): boolean
  /** 真打包:调 CLI backup() 落 `<space>/backups/`,返回出码 + 输出行。 */
  pack(tier: ButlerBackupSubsetTier): Promise<{ code: number; lines: string[] }>
}

export interface ButlerBackupOpsDeps {
  spaceRoot: string
  /** identity 窄切片:成员角色(null/undefined = 无 membership)。 */
  membershipRole: (userId: string) => string | null | undefined
  /** identity 窄切片:全部 peer 行的 createdAt(epoch ms;非密)。 */
  peerCreatedTimes: () => number[]
  /** 注入缝(测试用):默认 = `@gotong/cli` 的真 backup()。 */
  runBackup?: (
    args: readonly string[],
    io: { out: (l: string) => void; err: (l: string) => void },
  ) => Promise<number>
  logger?: Pick<Logger, 'warn'>
}

export function buildButlerBackupOps(deps: ButlerBackupOpsDeps): ButlerBackupOps {
  const factFile = join(deps.spaceRoot, ...LAST_BACKUP_FACT_NAME.split('/'))
  const runBackup = deps.runBackup ?? ((args: readonly string[], io: { out: (l: string) => void; err: (l: string) => void }) => backup(args, io))
  return {
    lastBackup() {
      try {
        return parseLastBackupFact(readFileSync(factFile, 'utf8'))
      } catch {
        return null // 文件不存在 = 从未备份(或事实丢了)——诚实报「没有记录」
      }
    },
    newPeersSince(ts) {
      try {
        return deps.peerCreatedTimes().filter((t) => Number.isFinite(t) && t > ts).length
      } catch (err) {
        deps.logger?.warn('butler backup: peer count failed', { err })
        return 0
      }
    },
    privileged(userId) {
      const role = deps.membershipRole(userId)
      return role === 'owner' || role === 'admin'
    },
    async pack(tier) {
      const lines: string[] = []
      const io = {
        out: (l: string) => {
          lines.push(l)
        },
        err: (l: string) => {
          lines.push(l)
        },
      }
      const code = await runBackup(
        [deps.spaceRoot, join(deps.spaceRoot, 'backups'), `--tier=${tier}`],
        io,
      )
      return { code, lines }
    },
  }
}

// ─── benign backup_status ────────────────────────────────────────────────────

const STATUS_TOOL: LlmToolDefinition = {
  name: 'backup_status',
  description:
    '看这台 hub 的备份状态:上次什么时候打过备份、什么档位、之后又新增了几条互联关系。成员问「备份过没有」「多久没备份了」时用它。想真打一份,用 pack_backup(仅 owner/admin,批准后才执行)。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

/** 备份陈旧阈值:14 天没备份(或从未)才算陈旧——status 提示与提醒共用。 */
export const BACKUP_STALE_AFTER_MS = 14 * DAY_MS

function tierLabel(tier: LastBackupFact['tier']): string {
  if (tier === 'identity') return '身份档'
  if (tier === 'relations') return '身份+关系档'
  return '全空间档'
}

/** 纯投影渲染(零 LLM 决策):事实 + 计数 → 中文状态卡。导出给测试直打。 */
export function renderBackupStatus(
  ops: Pick<ButlerBackupOps, 'lastBackup' | 'newPeersSince'>,
  now: number,
): string {
  const fact = ops.lastBackup()
  if (!fact) {
    return [
      '这台 hub 还没有备份记录(从未打过,或记录不在了)。',
      '建议至少打一份身份档——很小,含签名钥,恢复后互联对端仍认得你;全量/搬家档走命令行。',
      guideBreadcrumb('backup', '想看完整做法'),
    ].join('\n')
  }
  const days = Math.max(0, Math.floor((now - fact.at) / DAY_MS))
  const lines = [
    `上次备份:${new Date(fact.at).toISOString().slice(0, 10)}(${days} 天前)`,
    `档位:${tierLabel(fact.tier)}${fact.includesMasterKey ? '(含主钥——档案即凭证,收好)' : ''};档案:${fact.archive}`,
  ]
  const newPeers = ops.newPeersSince(fact.at)
  if (newPeers > 0) lines.push(`之后新增了 ${newPeers} 条互联关系。`)
  if (fact.tier === 'identity' && newPeers > 0) {
    lines.push('注:身份档本就不含互联关系;想把关系也带上,打一份身份+关系档。')
  }
  if (now - fact.at >= BACKUP_STALE_AFTER_MS) {
    lines.push(`已超过 ${Math.floor(BACKUP_STALE_AFTER_MS / DAY_MS)} 天,建议再打一份。${guideBreadcrumb('backup', '想看完整做法')}`)
  }
  return lines.join('\n')
}

export interface ButlerBackupStatusDeps {
  ops: Pick<ButlerBackupOps, 'lastBackup' | 'newPeersSince'>
  now?: () => number
  logger?: Pick<Logger, 'warn'>
}

class ButlerBackupStatusToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerBackupStatusDeps) {}

  listTools(): LlmToolDefinition[] {
    return [STATUS_TOOL]
  }

  async callTool(name: string): Promise<LlmToolCallResult> {
    if (name !== STATUS_TOOL.name) {
      return { content: [{ type: 'text', text: `未知工具:${name}` }], isError: true }
    }
    try {
      const text = renderBackupStatus(this.deps.ops, (this.deps.now ?? Date.now)())
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      this.deps.logger?.warn('butler backup: status render failed', { err })
      return { content: [{ type: 'text', text: '暂时读不到备份状态,稍后再试。' }], isError: true }
    }
  }
}

/** benign 只读备份状态。org-level 事实同 list_peers:全员可读,读不出密。 */
export function buildButlerBackupStatusToolset(deps: ButlerBackupStatusDeps): LlmAgentToolset {
  return new ButlerBackupStatusToolset(deps)
}

// ─── governed pack_backup ────────────────────────────────────────────────────

function parseTier(v: unknown): ButlerBackupSubsetTier | null {
  return v === 'identity' || v === 'relations' ? v : null
}

function tail(lines: readonly string[], n: number): string {
  return lines.slice(-n).join('\n')
}

const PACK_REFUSE_ROLE = '打包备份档案只对 owner/admin 开放(身份档里是这台 hub 的签名私钥)。'

export interface ButlerBackupPackDeps {
  /** 这位成员——owner/admin 判定按它查(服务端权威,绝不信模型自报)。 */
  userId: string
  ops: Pick<ButlerBackupOps, 'privileged' | 'pack'>
  logger?: Pick<Logger, 'warn'>
}

/**
 * governed 打包闸。verdict 永远 approve(镜像 BF-M7:IM 管家没有预览面,
 * /me 收件箱就是 review-before-execute),owner/admin 之外 classify 直接
 * refuse——风险裁决在 park 之前的服务端权威点,不浪费成员一次审批。
 */
export function buildButlerBackupPackToolset(deps: ButlerBackupPackDeps): GovernedActionToolset {
  const { userId, ops } = deps
  return new GovernedActionToolset({
    tools: [
      {
        name: 'pack_backup',
        description:
          '把这台 hub 打包一份备份档案,落在服务器空间的 backups/ 目录:identity=身份档(签名钥+公开名片,很小);relations=再加互联关系非密投影(peer 令牌在金库,绝不随档)。会先送 /me 收件箱等你批准。全量档/搬家档(含主钥)不在这里——用命令行 gotong backup。仅 owner/admin 可用。',
        inputSchema: {
          type: 'object',
          properties: {
            tier: {
              type: 'string',
              enum: ['identity', 'relations'],
              description: 'identity=身份档 / relations=身份+关系档',
            },
          },
          required: ['tier'],
          additionalProperties: false,
        },
        defaultVerdict: {
          decision: 'approve',
          reason: '会在服务器上打包一份备份档案(身份档含 hub 签名钥)——先请你确认',
        },
      },
    ],
    classify: (_name, args) => {
      if (!ops.privileged(userId)) {
        return { decision: 'refuse', reason: PACK_REFUSE_ROLE }
      }
      if (parseTier(args.tier) === null) {
        return {
          decision: 'refuse',
          reason: 'tier 只能是 identity 或 relations;全量/搬家档走命令行 gotong backup。',
        }
      }
      return {
        decision: 'approve',
        reason: '会在服务器上打包一份备份档案(身份档含 hub 签名钥)——先请你确认',
      }
    },
    describe: (_name, args) =>
      parseTier(args.tier) === 'relations' ? '打包一份「身份+关系」备份档案' : '打包一份「身份」备份档案',
    execute: async (_name, args) => {
      const tier = parseTier(args.tier)
      if (tier === null) {
        return { text: 'tier 只能是 identity 或 relations,没有执行。', isError: true }
      }
      // belt-and-suspenders:park→批准之间角色可能被降;批准补不回资格。
      if (!ops.privileged(userId)) {
        return { text: `你现在不是 owner/admin,没有执行。${PACK_REFUSE_ROLE}`, isError: true }
      }
      let out: { code: number; lines: string[] }
      try {
        out = await ops.pack(tier)
      } catch (err) {
        deps.logger?.warn('butler backup: pack threw', { err })
        return { text: '打包失败(执行异常),没有产出档案。', isError: true }
      }
      if (out.code !== 0) {
        return { text: `打包失败(exit ${out.code}):\n${tail(out.lines, 6)}`, isError: true }
      }
      return {
        text: `打包完成(${tier === 'relations' ? '身份+关系档' : '身份档'})。\n${tail(out.lines, 8)}\n档案在服务器空间的 backups/ 目录下——记得下载一份自己收好,用户自持才是恢复兜底。`,
      }
    },
  })
}

// ─── 陈旧提醒 sweeper(镜像 TN-M2)────────────────────────────────────────────

/** 节律 6h——陈旧阈值是 14 天,更密的轮询买不到任何东西(每 tick 零 LLM)。 */
export const BUTLER_BACKUP_NUDGE_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 每人提醒冷却 14 天:最多两周一句,绝不刷屏。 */
export const BACKUP_NUDGE_COOLDOWN_MS = 14 * DAY_MS

const MARKS_FILE = 'backup-nudges.json'

/** sweeper 自己的事实文件——唯一写者是本 sweep(intent/fact 分文件纪律)。 */
interface BackupNudgeMarksFile {
  v: 1
  nudgedAt: number | null
}

/** 纯时间戳分诊(零 LLM):陈旧(或从未备份)且过了冷却才 due。 */
export function triageBackupNudge(i: {
  fact: LastBackupFact | null
  lastNudgeAt: number | null
  now: number
  staleAfterMs?: number
  cooldownMs?: number
}): { due: boolean; stale: boolean; cooled: boolean; daysSince: number | null } {
  const staleAfter = i.staleAfterMs ?? BACKUP_STALE_AFTER_MS
  const cooldown = i.cooldownMs ?? BACKUP_NUDGE_COOLDOWN_MS
  const daysSince = i.fact ? Math.max(0, Math.floor((i.now - i.fact.at) / DAY_MS)) : null
  const stale = i.fact === null || i.now - i.fact.at >= staleAfter
  const cooled = i.lastNudgeAt === null || i.now - i.lastNudgeAt >= cooldown
  return { due: stale && cooled, stale, cooled, daysSince }
}

/**
 * 提醒文案:现状 + 建议 + AFR-M5 面包屑。「打一份身份档备份」是给成员复述的
 * 自然话(M5 纪律:指针绝不出现原始工具名——成员下一轮回这句,模型自己会
 * 对到打包工具)。
 */
export function formatBackupNudgeMessage(daysSince: number | null, newPeers: number): string {
  const state =
    daysSince === null ? '这台 hub 还没打过备份' : `这台 hub 已经 ${daysSince} 天没打备份了`
  const delta = newPeers > 0 ? `,期间新增了 ${newPeers} 条互联关系` : ''
  return `${state}${delta}。建议打一份身份档(很小,可离线收藏)——跟我说「打一份身份档备份」,我会先送你批准。${guideBreadcrumb('backup', '想看完整做法')}`
}

/** 一个成员 tick 的结果——给日志 + 测试看。 */
export type BackupNudgeTickOutcome =
  | { nudged: true }
  | { nudged: false; reason: 'no-consent' | 'not-privileged' | 'fresh' | 'cooldown' | 'delivery-failed' }

export interface ButlerBackupNudgeSweeperOptions {
  /** butler memory root(`<space>/butler/memory`)——同 factory 那份。 */
  rootDir: string
  ops: Pick<ButlerBackupOps, 'lastBackup' | 'newPeersSince' | 'privileged'>
  /** F1 pushToMember,lazy 读(桥在 arm 之后才起)。 */
  push: ButlerBriefPush
  logger: Logger
  /** 节律;默认 {@link BUTLER_BACKUP_NUDGE_INTERVAL_MS}(6h)。 */
  intervalMs?: number
  /** 注入时钟(确定性测试)。默认 `Date.now`。 */
  now?: () => number
}

/**
 * 备份陈旧提醒。备份是 hub 级事实,但标记按人记(送达谁才记谁),同意面
 * 镜像巡检:开了运行播报的成员才考虑,再叠 owner/admin——只提醒能按下
 * 打包的人,普通成员既没资格打包也不该被这件事打扰。
 */
export class ButlerBackupNudgeSweeper {
  private readonly rootDir: string
  private readonly ops: ButlerBackupNudgeSweeperOptions['ops']
  private readonly push: ButlerBriefPush
  private readonly log: Logger
  private readonly intervalMs: number
  private readonly now: () => number

  private timer?: ReturnType<typeof setInterval>
  private running = false

  constructor(opts: ButlerBackupNudgeSweeperOptions) {
    this.rootDir = opts.rootDir
    this.ops = opts.ops
    this.push = opts.push
    this.log = opts.logger
    this.intervalMs = opts.intervalMs ?? BUTLER_BACKUP_NUDGE_INTERVAL_MS
    this.now = opts.now ?? Date.now
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.intervalMs)
    this.timer.unref?.()
    this.log.info('butler backup-nudge sweep armed', { intervalMs: this.intervalMs, rootDir: this.rootDir })
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 一轮扫全部成员命名空间。重入护栏 + best-effort。 */
  async runOnce(): Promise<void> {
    if (this.running) {
      this.log.debug('butler backup-nudge: previous tick still running, skipping')
      return
    }
    this.running = true
    try {
      const userIds = await this.listUserIds()
      let nudged = 0
      for (const userId of userIds) {
        try {
          const outcome = await this.runOnceForMember(userId)
          if (outcome.nudged) nudged++
        } catch (err) {
          this.log.warn('butler backup-nudge: member tick failed', {
            userId,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (nudged > 0) this.log.info('butler backup-nudge: sweep complete', { members: userIds.length, nudged })
    } finally {
      this.running = false
    }
  }

  /** 一个成员 tick:同意面 → 资格 → 纯分诊 → 推送 → **送达才记标记**。 */
  async runOnceForMember(userId: string): Promise<BackupNudgeTickOutcome> {
    const consent = await readButlerRunBroadcastConfig(this.rootDir, userId)
    if (!consent?.enabled) return { nudged: false, reason: 'no-consent' }
    if (!this.ops.privileged(userId)) return { nudged: false, reason: 'not-privileged' }

    const dir = ownerDir(this.rootDir, { kind: 'user', id: userId })
    const fact = this.ops.lastBackup()
    const marks = await this.readMarks(dir)
    const t = triageBackupNudge({ fact, lastNudgeAt: marks.nudgedAt, now: this.now() })
    if (!t.due) return { nudged: false, reason: t.stale ? 'cooldown' : 'fresh' }

    const newPeers = fact ? this.ops.newPeersSince(fact.at) : 0
    const text = formatBackupNudgeMessage(t.daysSince, newPeers)

    let delivered = false
    let reason: string | undefined
    try {
      const res = await this.push(userId, text)
      if (res && typeof res === 'object') {
        delivered = res.delivered === true
        reason = res.reason
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err)
    }
    if (!delivered) {
      // 不记标记——桥可能在修,下 tick 重试;备份若期间打了,分诊自然消。
      this.log.warn('butler backup-nudge: composed but not delivered', { userId, reason })
      return { nudged: false, reason: 'delivery-failed' }
    }
    await this.writeMarks(dir, { v: 1, nudgedAt: this.now() })
    this.log.info('butler backup-nudge: nudged', { userId })
    return { nudged: true }
  }

  /** 读自己的事实文件。缺/坏 → 全新标记——最坏多提醒一次,且唯一写者是本 sweep。 */
  private async readMarks(dir: string): Promise<BackupNudgeMarksFile> {
    try {
      const raw = await readFile(join(dir, MARKS_FILE), 'utf8')
      const parsed = JSON.parse(raw) as Partial<BackupNudgeMarksFile>
      if (parsed.v === 1 && (parsed.nudgedAt === null || (typeof parsed.nudgedAt === 'number' && Number.isFinite(parsed.nudgedAt)))) {
        return { v: 1, nudgedAt: parsed.nudgedAt ?? null }
      }
    } catch {
      // fall through — fresh
    }
    return { v: 1, nudgedAt: null }
  }

  private async writeMarks(dir: string, marks: BackupNudgeMarksFile): Promise<void> {
    await mkdir(dir, { recursive: true })
    const file = join(dir, MARKS_FILE)
    const tmp = `${file}.tmp`
    await writeFile(tmp, `${JSON.stringify(marks, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  }

  /** 成员命名空间(`<rootDir>/user/*`,目录名 = 原样 userId)——同 TN-M2。 */
  private async listUserIds(): Promise<string[]> {
    try {
      const entries = await readdir(join(this.rootDir, 'user'), { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return []
    }
  }
}
