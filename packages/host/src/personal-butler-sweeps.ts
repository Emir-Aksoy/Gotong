/**
 * personal-butler-sweeps.ts — assembly helper that arms the butler's two
 * background delivery sweeps in one call:
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

import type { Logger } from '@gotong/core'
import type { LlmAgentToolset } from '@gotong/llm'

import type { AdminHealthSurface } from './admin-health.js'
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
  }
  /**
   * TN-M2 stalled-task nudge: gate only (cadence is a constant — the stall
   * threshold is days, so there's nothing to tune). Optional so pre-TN call
   * sites / tests stay byte-identical.
   */
  taskNudge?: { on: boolean; intervalMs?: number }
}

export interface ButlerSweepsHandle {
  /** Stop whichever sweeps were armed. Safe to call once at shutdown. */
  stop(): void
}

export function armButlerSweeps(opts: ButlerSweepsOptions): ButlerSweepsHandle {
  let proactive: ButlerProactiveSweeper | undefined
  if (opts.proactive.on) {
    proactive = new ButlerProactiveSweeper({
      rootDir: opts.memoryRoot,
      composeBrief: buildButlerBriefComposer({
        rootDir: opts.memoryRoot,
        buildProvider: opts.proactive.buildProvider,
        logger: opts.logger,
        ...(opts.proactive.mcpReadTools ? { mcpReadTools: opts.proactive.mcpReadTools } : {}),
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
      push: opts.push,
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
    })
    patrol.start()
  }
  return {
    stop() {
      proactive?.stop()
      runBroadcast?.stop()
      taskNudge?.stop()
      patrol?.stop()
    },
  }
}
