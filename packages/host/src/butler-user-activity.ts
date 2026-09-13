import { FileButlerUserIsolation } from './butler-user-isolation.js'

export type ButlerUserActivityErrorCode = 'BUTLER_USER_QUIESCED' | 'BUTLER_USER_RETIRE_FAILED' | 'BUTLER_USER_ISOLATION_FAILED'

export interface ButlerUserIsolation {
  assertOpen(userId: string): Promise<void>
  close(userId: string): Promise<void>
}

/** Fixed diagnostics only: never retain user content, paths, state, or cause. */
export class ButlerUserActivityError extends Error {
  constructor(readonly code: ButlerUserActivityErrorCode) {
    super(code === 'BUTLER_USER_QUIESCED'
      ? 'Butler user is quiesced.'
      : code === 'BUTLER_USER_ISOLATION_FAILED'
        ? 'Butler user isolation could not be persisted; retry isolation.'
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
 * The host shares one registry per memory root. An optional durable barrier
 * protects restarted admissions, not other processes' already-running work.
 * No reopen; writers outside registered entry points still need coordination.
 */
export class ButlerUserActivity {
  private readonly users = new Map<string, UserActivity>()

  constructor(private readonly isolation?: ButlerUserIsolation) {}

  private async checkOpen(userId: string, user: UserActivity): Promise<void> {
    try {
      await this.isolation!.assertOpen(userId)
    } catch {
      user.closed = true
    }
    if (user.closed) throw new ButlerUserActivityError('BUTLER_USER_QUIESCED')
  }

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
      // Admission IO itself is tracked: closure cannot overtake a pending check
      // and then let its callback start after resources have been retired.
      if (this.isolation) await this.checkOpen(userId, user)
      if (user.closed) throw new ButlerUserActivityError('BUTLER_USER_QUIESCED')
      const result = await work()
      if (this.isolation) await this.checkOpen(userId, user)
      if (user.closed) throw new ButlerUserActivityError('BUTLER_USER_QUIESCED')
      return result
    } catch (error) {
      if (this.isolation && !user.closed) await this.checkOpen(userId, user)
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

  /** Destructive disk maintenance needs a real barrier bound to the same configured root. */
  async quiesceMemoryRoot(rootDir: string, userId: string): Promise<void> {
    if (!(this.isolation instanceof FileButlerUserIsolation) || !this.isolation.isForRoot(rootDir)) {
      throw new ButlerUserActivityError('BUTLER_USER_ISOLATION_FAILED')
    }
    await this.quiesce(userId)
    // quiesce can return its cached success. Re-establish durability on every
    // disk-cleanup attempt, even after a previous cleanup or sync failure.
    await this.isolation.close(userId)
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
      try {
        await this.isolation?.close(userId)
      } catch {
        throw new ButlerUserActivityError('BUTLER_USER_ISOLATION_FAILED')
      }
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
