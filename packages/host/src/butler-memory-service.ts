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
import {
  formOf,
  importanceOf,
  isActive,
  isProcedure,
  lastRecalledOf,
  levelOf,
  linksOf,
  recallCountOf,
  stepsOf,
  tierOf,
  validFromOf,
  validToOf,
} from '@aipehub/personal-memory'
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
    // One `now` per call so each entry's bitemporal `active` flag is consistent.
    const now = this.clock()
    return {
      profile: profile.map((e) => projectEntry(e, now)),
      recent: recent.map((e) => projectEntry(e, now)),
    }
  }

  async export(userId: string): Promise<ButlerMemoryView[]> {
    // Raw list across all kinds for data portability — bounded payload.
    const all = await this.open(userId).list({ limit: EXPORT_LIMIT })
    const now = this.clock()
    return all.map((e) => projectEntry(e, now))
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

  /** The wall clock (injectable for deterministic tests) — used to flag each
   *  bitemporal fact as active / closed AT the moment of the read. */
  private clock(): number {
    return (this.now ?? Date.now)()
  }
}

/**
 * Project a stored entry to the member's view — content + when + tiering tags
 * (decision ③) + long-term memory tags (E/F/G/D). Everything is read from `meta`
 * via the SAME accessors the memory engine itself uses, so the panel shows
 * exactly how the butler organizes a fact: which cluster, how important, what it
 * links to, how often it's recalled, whether it's a how-to, and whether it's
 * still in effect. All long-term fields are optional and only attached when the
 * entry actually carries them, so a plain fact projects exactly as before.
 *
 * `now` is passed in (resolved once per read/export) so the bitemporal `active`
 * flag is consistent across the whole snapshot.
 */
function projectEntry(e: MemoryEntry, now: number): ButlerMemoryView {
  const tier = tierOf(e, '')
  const level = levelOf(e)
  const links = linksOf(e)
  const recallCount = recallCountOf(e)
  const lastRecalled = lastRecalledOf(e)
  const validFrom = validFromOf(e)
  const validTo = validToOf(e)
  const hasValidity = validFrom !== undefined || validTo !== undefined
  return {
    id: e.id,
    kind: e.kind,
    text: e.text,
    ts: e.ts,
    ...(tier ? { tier } : {}),
    ...(level ? { level } : {}),
    importance: importanceOf(e),
    // E — associative links (only when the butler cross-linked it).
    ...(links.length > 0 ? { links } : {}),
    // F — recall salience (count omitted at 0 = never recalled).
    ...(recallCount > 0 ? { recallCount } : {}),
    ...(lastRecalled !== undefined ? { lastRecalled } : {}),
    // G — a remembered how-to.
    ...(isProcedure(e) ? { form: formOf(e), steps: stepsOf(e) } : {}),
    // D — validity interval; `active` only for bitemporal facts so a legacy
    // "always true" fact shows no validity badge.
    ...(validFrom !== undefined ? { validFrom } : {}),
    ...(validTo !== undefined ? { validTo } : {}),
    ...(hasValidity ? { active: isActive(e, now) } : {}),
  }
}
