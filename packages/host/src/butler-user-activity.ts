export type ButlerUserActivityErrorCode = 'BUTLER_USER_QUIESCED' | 'BUTLER_USER_RETIRE_FAILED'

/** Fixed diagnostics only: never retain user content, paths, state, or cause. */
export class ButlerUserActivityError extends Error {
  constructor(readonly code: ButlerUserActivityErrorCode) {
    super(code === 'BUTLER_USER_QUIESCED'
      ? 'Butler user is quiesced.'
      : 'Butler user retirement failed; retry retirement.')
    this.name = 'ButlerUserActivityError'
  }
}

type RetireCallback = () => void | Promise<void>
interface UserActivity {
  closed: boolean
  active: Set<Promise<void>>
  resources: Set<RetireCallback>
  finalizers: Set<RetireCallback>
  retirement: Promise<void> | null
}

/**
 * Process/instance-local only. The host must share this object for a memory root.
 * No disk barrier or reopen: a future durable coordinator must cover restarts
 * and writers outside these registered entry points before correcting files.
 */
export class ButlerUserActivity {
  private readonly users = new Map<string, UserActivity>()

  private user(userId: string): UserActivity {
    let user = this.users.get(userId)
    if (!user) {
      user = { closed: false, active: new Set(), resources: new Set(), finalizers: new Set(), retirement: null }
      this.users.set(userId, user)
    }
    return user
  }

  async run<T>(userId: string, work: () => T | Promise<T>): Promise<T> {
    const user = this.user(userId)
    if (user.closed) throw new ButlerUserActivityError('BUTLER_USER_QUIESCED')
    // A separate, always-fulfilled latch tracks real completion, not the public
    // result (which may reject, suspend, or be discarded after closure).
    let release!: () => void
    const settled = new Promise<void>(resolve => { release = resolve })
    user.active.add(settled)
    try {
      const result = await work()
      if (user.closed) throw new ButlerUserActivityError('BUTLER_USER_QUIESCED')
      return result
    } catch (error) {
      if (user.closed) throw new ButlerUserActivityError('BUTLER_USER_QUIESCED')
      throw error
    } finally {
      user.active.delete(settled)
      release()
    }
  }

  /** Returns true only when removed before quiescence takes ownership. */
  register(userId: string, retire: RetireCallback): () => boolean {
    const user = this.user(userId)
    if (user.closed) throw new ButlerUserActivityError('BUTLER_USER_QUIESCED')
    user.resources.add(retire)
    return () => !user.closed && user.resources.delete(retire)
  }

  /** Shared-cache cleanup runs only after every resource has retired successfully. */
  registerFinalizer(userId: string, cleanup: RetireCallback): () => boolean {
    const user = this.user(userId)
    if (user.closed) throw new ButlerUserActivityError('BUTLER_USER_QUIESCED')
    user.finalizers.add(cleanup)
    return () => !user.closed && user.finalizers.delete(cleanup)
  }

  /**
   * Call from the future host coordinator OUTSIDE this user's registered work.
   * Neither work, resource callbacks nor finalizers may await their own quiesce promise:
   * that would self-deadlock. There is deliberately no reentrancy framework.
   * Hung work stays closed and pending; cancellation is not proof of completion.
   */
  quiesce(userId: string): Promise<void> {
    const user = this.user(userId)
    user.closed = true
    if (user.retirement) return user.retirement
    const active = [...user.active]
    user.retirement = Promise.resolve().then(async () => {
      await Promise.all(active)
      // A failed shutdown may recreate shared caches when retried. Finalizers
      // must remain untouched until ALL resources succeed, regardless of order.
      for (const callbacks of [user.resources, user.finalizers]) {
        let failed = false
        // Same-owner cache paths require serial cleanup in both phases.
        for (const retire of callbacks) {
          try {
            await retire()
            callbacks.delete(retire)
          } catch {
            failed = true
          }
        }
        if (failed) throw new ButlerUserActivityError('BUTLER_USER_RETIRE_FAILED')
      }
    }).catch((error: unknown) => {
      user.retirement = null
      throw error
    })
    return user.retirement
  }
}
