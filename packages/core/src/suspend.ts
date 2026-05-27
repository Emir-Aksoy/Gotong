/**
 * Phase 11 M1 — Suspend/Resume control-flow primitive.
 *
 * A participant signals "park me, wake me later" by throwing
 * `SuspendTaskError` from inside `onTask` / `onResume`. The scheduler
 * (Phase 11 M2/M3) recognises the throw, persists the carried state,
 * and re-dispatches the same task to the same participant after
 * `resumeAt` — but routed through `onResume(task, state)` instead of
 * `onTask(task)`.
 *
 * This is **not** an error in the failure sense. It rides the throw
 * channel because that's the only way for nested user code to bubble
 * an exit-with-data signal out of an async call stack without changing
 * every return type. `AgentParticipant.onTask` deliberately *re-throws*
 * it past the catch-all so the scheduler frame above can detect it.
 *
 * Until Phase 11 M3 lands the resume sweep, throwing this still routes
 * through whatever `Scheduler.runOne` does today — i.e. it will be
 * converted to a `failed` `TaskResult`. M1 only puts the surface in
 * place so agent code can be written against it.
 */
export class SuspendTaskError extends Error {
  /** Unix epoch ms. The earliest moment the resume sweep may re-dispatch. */
  readonly resumeAt: number

  /**
   * Opaque agent-defined payload. The scheduler persists it as-is (JSON
   * stringify) and hands it back on resume. Keep it small and JSON-safe;
   * working memory (full LLM conversation) gets its own auto-persist
   * path in M4 and shouldn't ride this field.
   */
  readonly state: unknown

  constructor(opts: { resumeAt: number; state?: unknown }) {
    super(`SuspendTaskError: resume at ${new Date(opts.resumeAt).toISOString()}`)
    this.name = 'SuspendTaskError'
    this.resumeAt = opts.resumeAt
    this.state = opts.state
  }
}

/**
 * Type guard. Plain `instanceof` works too, but importing this helper
 * avoids cross-package class-identity pitfalls (different bundles can
 * end up with separate copies of the constructor).
 */
export function isSuspendTaskError(e: unknown): e is SuspendTaskError {
  if (e instanceof SuspendTaskError) return true
  // Cross-realm fallback — some bundlers / vitest setups produce a
  // distinct constructor identity. Match by name + carried fields.
  if (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'SuspendTaskError' &&
    typeof (e as { resumeAt?: unknown }).resumeAt === 'number'
  ) {
    return true
  }
  return false
}
