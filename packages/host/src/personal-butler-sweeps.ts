/**
 * personal-butler-sweeps.ts — assembly helper that arms the butler's
 * background delivery sweeps in one call (all behind the LIFE push gate):
 *
 *   S3-M2 proactive daily brief  — {@link ButlerProactiveSweeper} + brief composer
 *   BE-M5 run-result broadcast   — {@link ButlerRunBroadcastSweeper}
 *
 * Both deliver via the F1 `pushToMember`, which main.ts assigns only after the
 * IM bridges start (~500 lines below the arming site) — so the `push` option
 * is a LAZY closure and the first tick lands one interval in, well after the
 * bridges are up. Gate semantics stay with the caller: a sweep whose `on` flag
 * is false (butler off / env opt-out) or whose dep is unwired (run surface) is
 * simply never constructed. Even armed, each sweep does nothing until a member
 * opts in (`set_daily_brief` / `set_run_broadcast` — DEFAULT-OFF per member).
 *
 * Exists as a module (not inline in main.ts) for the GUARD-M2 line budget: the
 * two wiring blocks + their shutdown stops were ~50 assembly lines whose only
 * content was passing refs through. The per-sweep design stories live in the
 * sweeper modules themselves.
 */

import { dirname, join } from 'node:path'

import type { Logger } from '@gotong/core'
import type { LlmAgentToolset } from '@gotong/llm'

import type { AdminHealthSurface } from './admin-health.js'
import { ButlerLifeSweeper } from './butler-life.js'
import { ButlerPushGate } from './butler-push-gate.js'
import { ButlerBackupNudgeSweeper, type ButlerBackupOps } from './personal-butler-backup.js'
import type { ButlerRunSurface } from './personal-butler-observe.js'
import { ButlerPatrolSweeper } from './personal-butler-patrol.js'
import {
  ButlerProactiveSweeper,
  buildButlerBriefComposer,
  type ButlerBriefProviderBuilder,
  type ButlerBriefPush,
} from './personal-butler-proactive.js'
import { ButlerRunBroadcastSweeper } from './personal-butler-run-broadcast.js'
import { ButlerTaskNudgeSweeper } from './personal-butler-task-nudge.js'
import type { SelfHealEntry } from './self-heal-log.js'

export interface ButlerSweepsOptions {
  /** Butler memory root (`<space>/butler/memory`) — namespaces + opt-in files. */
  memoryRoot: string
  /** The F1 `pushToMember`, read lazily (the bridges start after arming). */
  push: ButlerBriefPush
  logger: Logger
  /** S3-M2 daily brief: gate, cadence, fresh-per-compose provider builder; B2 —
   *  optional resolver for the butler's read-only connectors (weather/calendar/
   *  news) so an opted-in member's brief can enrich. Absent ⇒ enrichment never runs. */
  proactive: {
    on: boolean
    intervalMs: number
    buildProvider: ButlerBriefProviderBuilder
    mcpReadTools?: () => Promise<LlmAgentToolset | null>
    /** 晨报写面板卡小刀 — 内容-only 面板工具面(见 ButlerBriefComposerOptions)。 */
    panelContentTools?: (userId: string) => LlmAgentToolset | null
  }
  /** BE-M5 run broadcast: gate, cadence, the BE-M1 runs projection (undefined = unwired ⇒ off). */
  runBroadcast: { on: boolean; intervalMs: number; runs: ButlerRunSurface | undefined }
  /**
   * CARE-M3 patrol: gate, cadence, state file, LAZY health surface (main.ts
   * builds adminHealth after arming — the getter resolves by first tick).
   * Optional so pre-CARE-M3 call sites / tests stay byte-identical.
   */
  patrol?: {
    on: boolean
    intervalMs: number
    stateFile: string
    health: () => AdminHealthSurface | undefined
    /** CARE-M6 — 断供状态文件;给了它,巡检持续断供超阈值会升级一张红牌。 */
    outageFile?: string
    /** HEAL-M4 — 自愈台账读者(SelfHealLog.recent);给了它,看门狗重启/
     *  非正常停止会被事后播报(首见基线不倒灌)。缺省 ⇒ 不读不播。 */
    selfHealRecent?: () => Promise<SelfHealEntry[]>
    /** M-HEALTH — 记忆维护台账(`butler/memory-health.json`,由维护扫描自己写)。
     *  给了它,连续出错 / 长时间没跑成会出一张黄牌。缺省 ⇒ 不读不出牌。 */
    memoryHealthFile?: string
    /** STOR-M3 — 空间根;给了它,巡检读 `runtime/retention-state.json`,阶梯因缺
     *  备份安全网跳过删除会出一张黄牌。缺省 ⇒ 不读不出牌。 */
    retentionSpaceDir?: string
  }
  /**
   * TN-M2 stalled-task nudge: gate only (cadence is a constant — the stall
   * threshold is days, so there's nothing to tune). Optional so pre-TN call
   * sites / tests stay byte-identical.
   */
  taskNudge?: { on: boolean; intervalMs?: number }
  /** AFR-M7 — 备份陈旧提醒(镜像 TN-M2;同意面同巡检=开了播报才收,再叠
   *  owner/admin 过滤——只提醒能按下打包的人)。缺省 ⇒ 不构造。 */
  backupNudge?: { on: boolean; ops: Pick<ButlerBackupOps, 'lastBackup' | 'newPeersSince' | 'privileged'>; intervalMs?: number }
  /** LIFE — 生活档案扫描(签到/提醒/周回顾;零模型)。成员没有 `life/registry.json`
   *  就什么都不做。缺省 ⇒ 不构造。 */
  life?: { on: boolean; intervalMs?: number }
}

export interface ButlerSweepsHandle {
  /** Stop whichever sweeps were armed. Safe to call once at shutdown. */
  stop(): void
}

export function armButlerSweeps(callerOpts: ButlerSweepsOptions): ButlerSweepsHandle {
  // LIFE — 下面每个扫描器的推送都是**主动**推送,一律过免打扰闸(22:00–07:00 暂存到
  // 早上合并发出)与每日上限。成员在等的回音(提醒/审批回推/转派结果/长任务通知)
  // 不走这里,也就不受闸。设计见 butler-push-gate.ts。
  const gate = new ButlerPushGate({
    dir: join(dirname(callerOpts.memoryRoot), 'push-gate'),
    push: callerOpts.push,
    logger: callerOpts.logger,
  })
  gate.start()
  const opts: ButlerSweepsOptions = { ...callerOpts, push: gate.push }
  let proactive: ButlerProactiveSweeper | undefined
  if (opts.proactive.on) {
    proactive = new ButlerProactiveSweeper({
      rootDir: opts.memoryRoot,
      composeBrief: buildButlerBriefComposer({
        rootDir: opts.memoryRoot,
        buildProvider: opts.proactive.buildProvider,
        logger: opts.logger,
        ...(opts.proactive.mcpReadTools ? { mcpReadTools: opts.proactive.mcpReadTools } : {}),
        ...(opts.proactive.panelContentTools ? { panelContentTools: opts.proactive.panelContentTools } : {}),
      }),
      push: opts.push,
      logger: opts.logger,
      intervalMs: opts.proactive.intervalMs,
    })
    proactive.start()
  }
  let runBroadcast: ButlerRunBroadcastSweeper | undefined
  if (opts.runBroadcast.on && opts.runBroadcast.runs) {
    runBroadcast = new ButlerRunBroadcastSweeper({
      rootDir: opts.memoryRoot,
      runs: opts.runBroadcast.runs,
      // 成员订阅的运行结果:只守免打扰,不占每日上限(见 butler-push-gate.ts)。
      push: (userId, text) => gate.push(userId, text, { capExempt: true }),
      logger: opts.logger,
      intervalMs: opts.runBroadcast.intervalMs,
    })
    runBroadcast.start()
  }
  let taskNudge: ButlerTaskNudgeSweeper | undefined
  if (opts.taskNudge?.on) {
    taskNudge = new ButlerTaskNudgeSweeper({
      rootDir: opts.memoryRoot,
      push: opts.push,
      logger: opts.logger,
      ...(opts.taskNudge.intervalMs !== undefined ? { intervalMs: opts.taskNudge.intervalMs } : {}),
    })
    taskNudge.start()
  }
  let backupNudge: ButlerBackupNudgeSweeper | undefined
  if (opts.backupNudge?.on) {
    backupNudge = new ButlerBackupNudgeSweeper({
      rootDir: opts.memoryRoot,
      ops: opts.backupNudge.ops,
      push: opts.push,
      logger: opts.logger,
      ...(opts.backupNudge.intervalMs !== undefined ? { intervalMs: opts.backupNudge.intervalMs } : {}),
    })
    backupNudge.start()
  }
  let patrol: ButlerPatrolSweeper | undefined
  if (opts.patrol?.on) {
    patrol = new ButlerPatrolSweeper({
      stateFile: opts.patrol.stateFile,
      memoryRoot: opts.memoryRoot,
      health: opts.patrol.health,
      push: opts.push,
      logger: opts.logger,
      intervalMs: opts.patrol.intervalMs,
      ...(opts.patrol.outageFile ? { outageFile: opts.patrol.outageFile } : {}),
      ...(opts.patrol.selfHealRecent ? { selfHealRecent: opts.patrol.selfHealRecent } : {}),
      ...(opts.patrol.memoryHealthFile ? { memoryHealthFile: opts.patrol.memoryHealthFile } : {}),
      ...(opts.patrol.retentionSpaceDir ? { retentionSpaceDir: opts.patrol.retentionSpaceDir } : {}),
    })
    patrol.start()
  }
  let life: ButlerLifeSweeper | undefined
  if (opts.life?.on) {
    life = new ButlerLifeSweeper({
      memoryRoot: opts.memoryRoot,
      push: opts.push,
      memberClock: (ms) => gate.memberClock(ms),
      logger: opts.logger,
      ...(opts.life.intervalMs !== undefined ? { intervalMs: opts.life.intervalMs } : {}),
    })
    life.start()
  }
  return {
    stop() {
      gate.stop()
      life?.stop()
      proactive?.stop()
      runBroadcast?.stop()
      taskNudge?.stop()
      backupNudge?.stop()
      patrol?.stop()
    },
  }
}
