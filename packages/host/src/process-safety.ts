/**
 * process-safety.ts — a last-resort net for background promise rejections.
 *
 * The host runs several fire-and-forget timers (butler sweeps, outbox flush,
 * token refresh). Each guards its own tick, but a future one that forgets to
 * would surface as an `unhandledRejection` — which, since Node 15, terminates
 * the process by DEFAULT. For a long-running hub that is the wrong default: a
 * best-effort 6h maintenance tick must never take the whole host down. This
 * logs such rejections and keeps serving.
 *
 * `uncaughtException` is deliberately LEFT to Node's default: a synchronous
 * throw with no catch can leave state undefined, so a genuinely broken process
 * should still exit and let its supervisor (systemd) restart it clean. We only
 * soften the background-rejection case the audit found.
 */

/** Just the sink this needs — avoids a heavy logger import in a leaf. */
export interface ProcessSafetyLogger {
  error(msg: string, meta?: Record<string, unknown>): void
}

let installed = false

/** The pure handler (extracted so it can be unit-tested without global state). */
export function unhandledRejectionHandler(log: ProcessSafetyLogger): (reason: unknown) => void {
  return (reason) => {
    log.error('unhandledRejection kept alive — a background task rejected without a catch', {
      err: reason instanceof Error ? reason.message : String(reason),
      ...(reason instanceof Error && reason.stack ? { stack: reason.stack } : {}),
    })
  }
}

/**
 * Install a global `unhandledRejection` logger. Idempotent — safe if called
 * more than once (only the first install wins).
 */
export function installProcessSafetyNet(log: ProcessSafetyLogger): void {
  if (installed) return
  installed = true
  process.on('unhandledRejection', unhandledRejectionHandler(log))
}
