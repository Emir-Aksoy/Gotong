/**
 * `LifecycleSweeper` — periodic janitor that hard-deletes expired
 * trash entries.
 *
 * Started by `main.ts` after `bootstrapServices` succeeds; stopped
 * during graceful shutdown. The actual work is delegated to
 * `HubServices.sweepExpiredTrash()` so the sweeper here is just
 * cron-like plumbing.
 *
 * Why a separate object instead of a setInterval inside main.ts:
 *   - we need a `stop()` that's `await`-able from the shutdown
 *     handler — Node's `clearTimeout` doesn't wait for an in-flight
 *     callback, so a naked setTimeout could keep deleting after we
 *     thought the host had drained.
 *   - tests can construct a sweeper with a tiny interval and a
 *     `runOnce` shortcut without going through the timer at all.
 *
 * Default interval is 1 hour: cheap (a few stat()s on small dirs)
 * and means a 30-day-old trash entry lingers at most one extra hour
 * before purge. Tunable via constructor.
 */

import { createLogger, type Logger } from '@aipehub/core'

import type { HubServices } from './hub-services.js'

export interface LifecycleSweeperOpts {
  services: HubServices
  /** Tick interval in ms. Default 1 hour. Minimum 5 seconds. */
  intervalMs?: number
  /** Injected clock for tests. Default `Date.now`. */
  now?: () => number
  logger?: Logger
}

export class LifecycleSweeper {
  private readonly services: HubServices
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly logger: Logger
  private timer: NodeJS.Timeout | null = null
  /**
   * Tracks the in-flight tick so `stop()` waits for the current
   * sweep to finish rather than just clearing the timer. Important
   * during shutdown — we don't want to cut a hardDelete mid-rename.
   */
  private inflight: Promise<unknown> | null = null
  private stopped = false

  constructor(opts: LifecycleSweeperOpts) {
    this.services = opts.services
    this.intervalMs = Math.max(5_000, opts.intervalMs ?? 60 * 60 * 1000)
    this.now = opts.now ?? (() => Date.now())
    this.logger = opts.logger ?? createLogger('services-sweeper')
  }

  /**
   * Start ticking. The first sweep happens immediately on the next
   * event-loop turn so a freshly-booted host that already has
   * expired trash from a previous run drains right away. Idempotent
   * — calling start() twice is a no-op.
   */
  start(): void {
    if (this.timer || this.stopped) return
    // Kick off immediately, then schedule the recurring tick.
    queueMicrotask(() => {
      if (!this.stopped) void this.tick()
    })
    this.timer = setInterval(() => {
      if (!this.stopped) void this.tick()
    }, this.intervalMs)
    // Unref so the sweeper doesn't keep the process alive on its own.
    // Production hosts have the web/ws listeners keeping them up; the
    // sweeper is supplemental.
    this.timer.unref?.()
    this.logger.debug('services sweeper started', { intervalMs: this.intervalMs })
  }

  /**
   * Stop the periodic tick. Awaits any in-flight sweep so callers
   * (typically the SIGTERM handler) can be sure no hardDelete races
   * with the shutdown of the underlying plugins.
   */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.inflight) {
      try { await this.inflight } catch { /* logged in tick */ }
    }
  }

  /**
   * Run one sweep right now. Exposed for tests and admin "purge now"
   * buttons. No-op if the sweeper has been stopped.
   */
  async runOnce(): Promise<{ scanned: number; purged: number }> {
    if (this.stopped) return { scanned: 0, purged: 0 }
    return this.services.sweepExpiredTrash(this.now())
  }

  private async tick(): Promise<void> {
    const p = this.services.sweepExpiredTrash(this.now())
    this.inflight = p
    try {
      const out = await p
      if (out.purged > 0) {
        this.logger.info('services sweep purged expired trash', out)
      } else {
        this.logger.debug('services sweep — no expired trash', out)
      }
    } catch (err) {
      this.logger.error('services sweep failed', { err })
    } finally {
      if (this.inflight === p) this.inflight = null
    }
  }
}
