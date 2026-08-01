/**
 * self-heal-log.ts — HEAL track:自愈台账(file-first)。
 *
 * 用户诉求「定时自检 + 自检失败重启 + 能查看之前失败的日志」拆成三块:
 * 重启腿在 deploy 层(`deploy/gotong-watchdog.mjs`,外部 systemd timer 探
 * /healthz,连败才 systemctl restart——重启只治「死和卡」,红黄牌那类
 * 「重启治不了的病」归巡检/CARE 管);本模块是 hub 侧的另外两块:
 *
 *   - **台账**:`<space>/runtime/self-heal-log.jsonl` 追加式 JSONL,两个
 *     写入方——看门狗写「因何重启 + 当时的 journal 尾巴」,hub 开机写
 *     「上次是不是干净退出 + 停机多久」。两写入方天然错峰(看门狗只在
 *     hub 死/卡时落笔),唯一交叠窗是开机剪枝对上看门狗补一笔,窗口极小
 *     且丢的那行描述的正是刚发生的这次重启(开机行本身还在),如实接受。
 *   - **开机分类**:干净退出在 shutdown 信号顶端落 stop 标记(sync 原子
 *     写);开机时「标记在=clean(消费掉),标记不在但心跳在=unclean(崩溃/
 *     强杀/断电),都不在=none(首跑)」。消费式标记结构性消灭「陈旧标记把
 *     后来的崩溃误判成干净」。心跳每 60s 原子刷新,停机时长 = 开机时刻 −
 *     最后心跳(±一个心跳节律的诚实误差)。
 *
 * 读者两个:体检面板(admin-health.selfHeal)与阿同 benign 工具
 * restart_history(personal-butler-hub-sense)。读者永不抛:坏行跳过、
 * 无文件=空。零旋钮——台账/心跳是惰性事实文件,看门狗装不装是 deploy
 * 层的事(装=开,不装=只有开机记录,依然有用:崩溃史照样留痕)。
 */

import { appendFile, mkdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { writeFileAtomic, writeJsonAtomic, writeJsonAtomicSync } from '@gotong/core'
import type { Logger } from '@gotong/core'

export const SELF_HEAL_LOG_FILE = 'self-heal-log.jsonl'
export const SELF_HEAL_HEARTBEAT_FILE = 'self-heal-heartbeat.json'
export const SELF_HEAL_STOP_MARKER_FILE = 'self-heal-stop.json'

/** 心跳节律。常量非旋钮(CARE-M5 同惯例);它同时是停机时长的误差界。 */
export const SELF_HEAL_HEARTBEAT_MS = 60_000

/** 剪枝滞回:超过 HIGH 才剪到 KEEP,避免每次开机都重写文件。 */
const PRUNE_HIGH = 300
const PRUNE_KEEP = 200

/** 台账行的宽容形状:只钉 at/kind 两个字段,其余透传(看门狗行带
 * fails/journalTail 等,hub 不校验它们——读者按需渲染,未知键无害)。 */
export interface SelfHealEntry {
  at: string
  kind: string
  [key: string]: unknown
}

export interface SelfHealBootRecord extends SelfHealEntry {
  kind: 'boot'
  /** clean=上次收到停止信号干净退出;unclean=疑似崩溃/强杀/断电;none=首跑。 */
  prev: 'clean' | 'unclean' | 'none'
  /** 停机时长(开机 − 停止标记/最后心跳),none 时缺席。 */
  downMs?: number
}

export interface SelfHealLogDeps {
  /** `<space>/runtime` — 与 llm-outage.json / last-backup.json 同一目录族。 */
  runtimeDir: string
  now?: () => number
  logger?: Pick<Logger, 'warn'>
}

export interface SelfHealLog {
  /** 开机分类落账完成(main.ts 不 await 也无妨——读者对半成品文件天然宽容)。 */
  ready: Promise<SelfHealBootRecord | null>
  /** shutdown 信号顶端调用(sync 原子写):即使后续 drain 卡死被 SIGKILL,
   * 「曾被要求停」这个事实已经落盘,下次开机不会误判成崩溃。 */
  markCleanStop(): void
  /** 停心跳计时器(shutdown 收尾)。 */
  stop(): void
  /** 最近 N 条,新的在前。永不抛:无文件/坏行 → 跳过/空数组。 */
  recent(limit?: number): Promise<SelfHealEntry[]>
}

function parseJsonFile(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 台账文本 → 合法行数组(坏行/空行静默跳过——读者永不隔离,证据原地留)。 */
export function parseSelfHealLines(text: string): SelfHealEntry[] {
  const out: SelfHealEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const v = parseJsonFile(line)
    if (v && typeof v.at === 'string' && typeof v.kind === 'string') out.push(v as SelfHealEntry)
  }
  return out
}

export function startSelfHealLog(deps: SelfHealLogDeps): SelfHealLog {
  const now = deps.now ?? Date.now
  const logFile = join(deps.runtimeDir, SELF_HEAL_LOG_FILE)
  const heartbeatFile = join(deps.runtimeDir, SELF_HEAL_HEARTBEAT_FILE)
  const stopMarkerFile = join(deps.runtimeDir, SELF_HEAL_STOP_MARKER_FILE)
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false

  const writeHeartbeat = async () => {
    try {
      await writeJsonAtomic(heartbeatFile, { at: now() })
    } catch (err) {
      deps.logger?.warn('self-heal: heartbeat write failed', { err })
    }
  }

  const boot = async (): Promise<SelfHealBootRecord | null> => {
    try {
      await mkdir(deps.runtimeDir, { recursive: true })
      // 分类:停止标记优先(消费式),否则看心跳,都没有=首跑。
      let prev: SelfHealBootRecord['prev'] = 'none'
      let lastAliveAt: number | null = null
      const marker = parseJsonFile(await readFile(stopMarkerFile, 'utf8').catch(() => ''))
      if (marker && typeof marker.at === 'number') {
        prev = 'clean'
        lastAliveAt = marker.at
        await unlink(stopMarkerFile).catch(() => {})
      } else {
        const hb = parseJsonFile(await readFile(heartbeatFile, 'utf8').catch(() => ''))
        if (hb && typeof hb.at === 'number') {
          prev = 'unclean'
          lastAliveAt = hb.at
        }
      }
      const at = now()
      const record: SelfHealBootRecord = {
        at: new Date(at).toISOString(),
        kind: 'boot',
        prev,
        ...(lastAliveAt !== null ? { downMs: Math.max(0, at - lastAliveAt) } : {}),
      }
      await appendFile(logFile, JSON.stringify(record) + '\n', 'utf8')
      // 剪枝(滞回):开机时唯一的重写点,保尾部含刚写的开机行。
      const entries = parseSelfHealLines(await readFile(logFile, 'utf8').catch(() => ''))
      if (entries.length > PRUNE_HIGH) {
        const keep = entries.slice(-PRUNE_KEEP)
        await writeFileAtomic(logFile, keep.map((e) => JSON.stringify(e)).join('\n') + '\n')
      }
      await writeHeartbeat()
      if (!stopped) {
        timer = setInterval(() => { void writeHeartbeat() }, SELF_HEAL_HEARTBEAT_MS)
        timer.unref?.()
      }
      return record
    } catch (err) {
      deps.logger?.warn('self-heal: boot record failed — ledger disabled this run', { err })
      return null
    }
  }

  return {
    ready: boot(),
    markCleanStop() {
      try {
        writeJsonAtomicSync(stopMarkerFile, { at: now() })
      } catch (err) {
        deps.logger?.warn('self-heal: stop marker write failed', { err })
      }
    },
    stop() {
      stopped = true
      if (timer) { clearInterval(timer); timer = undefined }
    },
    async recent(limit = 20): Promise<SelfHealEntry[]> {
      try {
        const entries = parseSelfHealLines(await readFile(logFile, 'utf8'))
        return entries.slice(-Math.max(1, limit)).reverse()
      } catch {
        return []
      }
    },
  }
}
