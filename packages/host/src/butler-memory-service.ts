/**
 * HostButlerMemoryService — Personal Butler M6c. Backs `/api/me/butler/memory`
 * so a member can SEE what their butler remembers about them, FORGET one entry
 * or everything (right to be forgotten / 被遗忘权), and EXPORT the lot (data
 * portability). The privacy view is front-loaded to the UI to reassure users:
 * the butler keeps long-term memory, so the member must be able to inspect and
 * erase it at any time.
 *
 * The no-leak boundary is the per-user memory NAMESPACE, not an access check:
 * every op opens the handle through `openButlerMemory({ rootDir, userId })`,
 * where the userId is the SESSION userId the route forces server-side — never a
 * client-supplied value. `Owner{kind:'user', id:userId}` resolves to
 * `<rootDir>/user/<userId>/`, and `assertSafeOwnerId` blocks traversal, so a
 * member can only ever read / erase their OWN butler's memory. The butler agent
 * (capture + frozen block) and this view open the SAME handle through the same
 * factory, so "what the butler remembers" and "what the member can see / erase"
 * are the exact same bytes — one source of truth.
 *
 * Read-only over the framework: this service needs only a memory rootDir, NOT a
 * registered butler agent. It is safe to wire before the butler agent is folded
 * into main.ts (deferred per design §八) — until something writes through the
 * same per-user handle, the view is simply empty.
 */

import type { Logger } from '@aipehub/core'
import type { MemoryEntry, MemoryHandle } from '@aipehub/services-sdk'
import type { WebServerOptions } from '@aipehub/web'

import { openButlerMemory } from './personal-butler-memory.js'

// Derive the surface contract from the web opts — single source of truth, no
// re-export needed (same pattern as HostMeCredentialsService).
type ButlerMemorySurface = NonNullable<WebServerOptions['butlerMemory']>
type ButlerMemorySnapshot = Awaited<ReturnType<ButlerMemorySurface['read']>>
type ButlerMemoryView = Awaited<ReturnType<ButlerMemorySurface['export']>>[number]

/** How many recent episodic captures the privacy panel shows by default. */
const RECENT_CAPTURE_LIMIT = 30
/** Hard cap on an export payload — large enough for a personal butler, bounded. */
const EXPORT_LIMIT = 1000

export interface HostButlerMemoryServiceOpts {
  /** Memory root dir — the SAME tree the butler agent reads/writes per user. */
  rootDir: string
  logger: Logger
  /** Injectable clock (deterministic tests); forwarded to the memory backend. */
  now?: () => number
}

export class HostButlerMemoryService implements ButlerMemorySurface {
  private readonly rootDir: string
  private readonly logger: Logger
  private readonly now: (() => number) | undefined

  constructor(opts: HostButlerMemoryServiceOpts) {
    this.rootDir = opts.rootDir
    this.logger = opts.logger
    this.now = opts.now
  }

  async read(userId: string): Promise<ButlerMemorySnapshot> {
    const mem = this.open(userId)
    // Semantic = the distilled profile ("what the butler knows about me");
    // episodic = recently captured turns. Both newest-first, content only.
    const [profile, recent] = await Promise.all([
      mem.recall({ kinds: ['semantic'], k: 200 }),
      mem.recall({ kinds: ['episodic'], k: RECENT_CAPTURE_LIMIT }),
    ])
    return { profile: profile.map(projectEntry), recent: recent.map(projectEntry) }
  }

  async export(userId: string): Promise<ButlerMemoryView[]> {
    // Raw list across all kinds for data portability — bounded payload.
    const all = await this.open(userId).list({ limit: EXPORT_LIMIT })
    return all.map(projectEntry)
  }

  async forget(userId: string, id: string): Promise<boolean> {
    const mem = this.open(userId)
    // `forget` is a no-op if the id isn't there; report whether it WAS, without
    // leaking other ids — list this user's own entries and check membership.
    const existed = (await mem.list({ limit: EXPORT_LIMIT })).some((e) => e.id === id)
    await mem.forget(id)
    this.logger.info('member forgot a butler memory', { userId, id, existed })
    return existed
  }

  async forgetAll(userId: string): Promise<void> {
    // Right to be forgotten — clear every kind for this member's butler.
    await this.open(userId).clear()
    this.logger.info('member cleared all butler memory', { userId })
  }

  private open(userId: string): MemoryHandle {
    return openButlerMemory({
      rootDir: this.rootDir,
      userId,
      logger: this.logger,
      ...(this.now ? { now: this.now } : {}),
    })
  }
}

/** Project a stored entry to the member's view — content + when, no internal meta. */
function projectEntry(e: MemoryEntry): ButlerMemoryView {
  return { id: e.id, kind: e.kind, text: e.text, ts: e.ts }
}
