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

import type { Logger } from '@aipehub/core'

import type { ButlerRunSurface } from './personal-butler-observe.js'
import {
  ButlerProactiveSweeper,
  buildButlerBriefComposer,
  type ButlerBriefProviderBuilder,
  type ButlerBriefPush,
} from './personal-butler-proactive.js'
import { ButlerRunBroadcastSweeper } from './personal-butler-run-broadcast.js'

export interface ButlerSweepsOptions {
  /** Butler memory root (`<space>/butler/memory`) — namespaces + opt-in files. */
  memoryRoot: string
  /** The F1 `pushToMember`, read lazily (the bridges start after arming). */
  push: ButlerBriefPush
  logger: Logger
  /** S3-M2 daily brief: gate, cadence, fresh-per-compose provider builder. */
  proactive: { on: boolean; intervalMs: number; buildProvider: ButlerBriefProviderBuilder }
  /** BE-M5 run broadcast: gate, cadence, the BE-M1 runs projection (undefined = unwired ⇒ off). */
  runBroadcast: { on: boolean; intervalMs: number; runs: ButlerRunSurface | undefined }
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
  return {
    stop() {
      proactive?.stop()
      runBroadcast?.stop()
    },
  }
}
