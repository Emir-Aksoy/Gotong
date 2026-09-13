/**
 * HostButlerMemoryService — Personal Butler M6c. Backs `/api/me/butler/memory`
 * so a member can inspect current butler memory, forget entries and the existing
 * derived projections, and export a bounded payload. This is not a complete
 * hard-delete of Git history, sessions, or other copies.
 *
 * The namespace boundary is per user:
 * every op opens the handle through `openButlerMemory({ rootDir, userId })`,
 * where the userId is the SESSION userId the route forces server-side — never a
 * client-supplied value. `Owner{kind:'user', id:userId}` resolves to
 * `<rootDir>/user/<userId>/`, and `assertSafeOwnerId` blocks traversal, so a
 * member can only ever read / erase their OWN butler's memory. The butler agent
 * and this view open separate handles onto the same per-user files.
 *
 * Every complete public operation joins user activity, including projections.
 * Standalone services check durable isolation; cross-entry drain requires the
 * host's shared registry. User caches retire only after admitted work settles.
 */

import type { Logger } from '@gotong/core'
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
} from '@gotong/personal-memory'
import type { MemoryEntry, MemoryHandle } from '@gotong/services-sdk'
import type { WebServerOptions } from '@gotong/web'

import { openButlerObsidianProjector, projectButlerMemoryVault } from './butler-obsidian.js'
import { ButlerUserActivity } from './butler-user-activity.js'
import { FileButlerUserIsolation } from './butler-user-isolation.js'
import { openButlerDreamDiary, type ButlerDreamDiary } from './personal-butler-dreams.js'
import { openButlerMemory } from './personal-butler-memory.js'
import { openButlerSkillFile, type ButlerSkillFile } from './personal-butler-skills.js'
import { openButlerStatusFile, type ButlerStatusFile } from './personal-butler-status.js'

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
  /** Share with other entry points to drain their work together for this root. */
  userActivity?: ButlerUserActivity
}

export class HostButlerMemoryService implements ButlerMemorySurface {
  private readonly rootDir: string
  private readonly logger: Logger
  private readonly now: (() => number) | undefined
  private readonly userActivity: ButlerUserActivity
  private readonly registeredUsers = new Set<string>()
  /**
   * Reuse per-user handles until retirement. Backend owner-scoped coordination
   * also covers separate handles; this cache is not the write-serialization
   * boundary. rootDir and `now` are fixed, so userId is a complete cache key.
   */
  private readonly handles = new Map<string, MemoryHandle>()
  /** Per-user dream diary (DREAMS.md) — read for the "上次复盘" line, removed on forget-all. */
  private readonly diaries = new Map<string, ButlerDreamDiary>()
  /** Per-user master skill index (SKILL.md) — a derived projection, removed on forget-all. */
  private readonly skillFiles = new Map<string, ButlerSkillFile>()
  /** Per-user maintenance status (STATUS.md) — read for the "上次维护" line, removed on forget-all. */
  private readonly statusFiles = new Map<string, ButlerStatusFile>()

  constructor(opts: HostButlerMemoryServiceOpts) {
    this.rootDir = opts.rootDir
    this.logger = opts.logger
    this.now = opts.now
    this.userActivity = opts.userActivity ?? new ButlerUserActivity(new FileButlerUserIsolation(opts.rootDir))
  }

  async read(userId: string): Promise<ButlerMemorySnapshot> {
    return this.run(userId, () => this.readUnguarded(userId))
  }

  async export(userId: string): Promise<ButlerMemoryView[]> {
    return this.run(userId, () => this.exportUnguarded(userId))
  }

  async forget(userId: string, id: string): Promise<boolean> {
    return this.run(userId, () => this.forgetUnguarded(userId, id))
  }

  async forgetAll(userId: string): Promise<void> {
    return this.run(userId, () => this.forgetAllUnguarded(userId))
  }

  private run<T>(userId: string, work: () => Promise<T>): Promise<T> {
    return this.userActivity.run(userId, () => {
      if (!this.registeredUsers.has(userId)) {
        this.userActivity.register(userId, () => {
          this.handles.delete(userId)
          this.diaries.delete(userId)
          this.skillFiles.delete(userId)
          this.statusFiles.delete(userId)
          this.registeredUsers.delete(userId)
        })
        this.registeredUsers.add(userId)
      }
      return work()
    })
  }

  private async readUnguarded(userId: string): Promise<ButlerMemorySnapshot> {
    const mem = this.open(userId)
    // Semantic = the distilled profile ("what the butler knows about me");
    // episodic = recently captured turns. Both newest-first, content only.
    // The dream diary's latest sweep rides along — read-only "上次复盘" reassurance;
    // the 6h maintenance status (MR4) rides along too — "上次维护" liveness.
    // A rejected branch must not let drain overtake other reads. Defer each
    // invocation too, so a synchronous throw cannot abandon an earlier branch.
    const [profile, recent, lastDream, lastStatus] = await Promise.allSettled([
      Promise.resolve().then(() => mem.recall({ kinds: ['semantic'], k: 200 })),
      Promise.resolve().then(() => mem.recall({ kinds: ['episodic'], k: RECENT_CAPTURE_LIMIT })),
      Promise.resolve().then(() => this.diary(userId).readLatest()),
      Promise.resolve().then(() => this.statusFile(userId).read()),
    ])
    if (profile.status === 'rejected') throw profile.reason
    if (recent.status === 'rejected') throw recent.reason
    if (lastDream.status === 'rejected') throw lastDream.reason
    if (lastStatus.status === 'rejected') throw lastStatus.reason
    // One `now` per call so each entry's bitemporal `active` flag is consistent.
    const now = this.clock()
    return {
      profile: profile.value.map((e) => projectEntry(e, now)),
      recent: recent.value.map((e) => projectEntry(e, now)),
      ...(lastDream.value ? { lastDream: lastDream.value } : {}),
      ...(lastStatus.value ? { lastStatus: lastStatus.value } : {}),
    }
  }

  private async exportUnguarded(userId: string): Promise<ButlerMemoryView[]> {
    // Raw list across all kinds for data portability — bounded payload.
    const all = await this.open(userId).list({ limit: EXPORT_LIMIT })
    const now = this.clock()
    return all.map((e) => projectEntry(e, now))
  }

  private async forgetUnguarded(userId: string, id: string): Promise<boolean> {
    const mem = this.open(userId)
    // `forget` is a no-op if the id isn't there; report whether it WAS, without
    // leaking other ids — list this user's own entries and check membership.
    const existed = (await mem.list({ limit: EXPORT_LIMIT })).some((e) => e.id === id)
    await mem.forget(id)
    this.logger.info('member forgot a butler memory', { userId, id, existed })
    // HANDS-M5 补课(Codex 轮 C H2):md 投影是这份 jsonl 的派生物,忘掉一条而不
    // 重投,那条事实还会在成员的 vault 里摆着,一摆最多 6 小时 —— 而「忘掉」这个
    // 动作的全部意义就是「别再让我看见它」。`forgetAll` 从第一版起就连投影一起
    // 清,单条却漏了;两条路对「忘掉」的定义必须一致。
    // 投影失败只 warn(函数内部已吞):真相已经改了,一次派生物写不出不该把一次
    // 成功的遗忘报成失败 —— 与写路径末尾同姿态。
    if (existed) {
      await projectButlerMemoryVault({
        rootDir: this.rootDir,
        userId,
        logger: this.logger,
        now: this.clock(),
      })
    }
    return existed
  }

  private async forgetAllUnguarded(userId: string): Promise<void> {
    // Clear every configured kind for this member's butler AND the existing
    // derived files (§八: forget-all also wipes the per-user dream diary, the
    // master skill index AND the maintenance status — all rebuildable projections
    // of the now-empty jsonl).
    await this.open(userId).clear()
    await this.diary(userId).remove()
    await this.skillFile(userId).remove()
    await this.statusFile(userId).remove()
    // HANDS-M5 — 记忆的 md 投影同罪:留着它,一份被要求忘掉的事实还会在 vault 里
    // 摆着,而且看起来像现状。tasks.md 不在此列——那是笔记本的投影,不是记忆的。
    await openButlerObsidianProjector({
      rootDir: this.rootDir,
      userId,
      logger: this.logger,
    }).removeMemoryProjections()
    this.logger.info('member cleared all butler memory', { userId })
  }

  private open(userId: string): MemoryHandle {
    const cached = this.handles.get(userId)
    if (cached) return cached
    const handle = openButlerMemory({
      rootDir: this.rootDir,
      userId,
      logger: this.logger,
      ...(this.now ? { now: this.now } : {}),
    })
    this.handles.set(userId, handle)
    return handle
  }

  private diary(userId: string): ButlerDreamDiary {
    const cached = this.diaries.get(userId)
    if (cached) return cached
    const diary = openButlerDreamDiary({ rootDir: this.rootDir, userId, logger: this.logger })
    this.diaries.set(userId, diary)
    return diary
  }

  private skillFile(userId: string): ButlerSkillFile {
    const cached = this.skillFiles.get(userId)
    if (cached) return cached
    const file = openButlerSkillFile({ rootDir: this.rootDir, userId, logger: this.logger })
    this.skillFiles.set(userId, file)
    return file
  }

  private statusFile(userId: string): ButlerStatusFile {
    const cached = this.statusFiles.get(userId)
    if (cached) return cached
    const file = openButlerStatusFile({ rootDir: this.rootDir, userId, logger: this.logger })
    this.statusFiles.set(userId, file)
    return file
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
