/**
 * butler-reachable.ts — F1: the outbound-push FOUNDATION for the resident butler.
 *
 * Inbound IM is reactive: a member DMs the bot, the bot replies on the SAME
 * message (`bridge.sendMessage(msg.from, …, {chatId: msg.chatId})`). But the
 * next milestones need the butler to reach a member OUT of band — with no
 * inbound message in hand:
 *
 *   - S1-M3: "your governed action was approved" pushed back to Feishu after the
 *     owner resolves it in `/me` (minutes later, a different turn);
 *   - S3-M1: a reminder firing when its suspended task resumes;
 *   - S3-M2: a morning brief the heartbeat emits.
 *
 * All three need the same primitive: given an Gotong `userId`, deliver a line of
 * text to wherever that member last talked to us. This module is that primitive.
 *
 * ── How reachability is learned ──────────────────────────────────────────────
 * We don't ask the member "where should I reach you" — we LEARN it. Every inbound
 * message from a BOUND member carries `platform` + `from` + `chatId`; the router
 * records that as this member's route. So the freshest place they talked to us is
 * always where we push. (A member on two platforms → the most recent wins; that's
 * the honest "reach me where I am now".)
 *
 * ── Why persist to disk ──────────────────────────────────────────────────────
 * A reminder set before a restart must still fire after it. An in-memory Map
 * alone loses every route on restart, so the resumed reminder would have nowhere
 * to go. Each route persists to `<dir>/<userId>.json` (decision #2: a file, no
 * identity-schema change) and `load()` rehydrates the Map at boot. The truth is
 * the file; the Map is a warm cache.
 *
 * No-leak: a route is keyed by the member's OWN userId and this module never fans
 * out. That isn't enough on its own — the account behind a route can be unbound or
 * rebound to someone else after we learned it — so every delivery re-checks
 * `isBoundTo` first and treats a stale route as no route.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ImBridge, ImOutboundFile, ImUser } from '@gotong/im-adapter'
import { assertSafeOwnerId } from '@gotong/services-sdk'

import type { ImLogger } from './im-bridge.js'

/** Where a member last talked to us — enough to push a message back to them. */
export interface ReachableRoute {
  platform: string
  platformUserId: string
  displayName?: string | null
  /**
   * Platform chat id of the member's DM with us. Present only together with
   * `chatKind: 'direct'` — the writer (`recordReachable`) never passes a group
   * room id here (GRP: a room must not become a personal push address).
   */
  chatId?: string
  /**
   * GRP — provenance marker for `chatId`: 'direct' = observed on a 1:1 chat.
   * Stamped with every chatId since GRP. `parseRoute` DROPS a persisted chatId
   * whose file lacks this marker: a pre-GRP file may hold a group room id, and
   * pushing there would put personal reminders in front of the whole room.
   * The dropped route falls back to the platformUserId DM and the file
   * self-heals on the member's next direct message.
   */
  chatKind?: 'direct'
  /** When this route was last observed (freshest inbound wins). */
  updatedAt: number
}

export type ButlerPushResult =
  | { delivered: true }
  | {
      delivered: false
      reason: 'unknown_member' | 'no_bridge' | 'send_failed'
      /** outbox 已把这条落盘,之后会补投。调用方按已交出处理,再发一次只会多排一份。 */
      queued?: true
    }

/** 现在能不能把文件发给这个成员。写内容之前先问,免得白写。 */
export type ButlerFileReach =
  | { ok: true }
  | { ok: false; reason: 'unknown_member' | 'no_bridge' | 'unsupported' }

export type ButlerFilePushResult =
  | { delivered: true }
  | { delivered: false; reason: 'unknown_member' | 'no_bridge' | 'unsupported' }
  /** `detail` 是平台返回的错误,比如缺权限;如实转告才能让人去修。 */
  | { delivered: false; reason: 'send_failed'; detail: string }

/** 给成员本人发文件的能力。签名里没有收件人以外的目标,路由只来自可达表。 */
export interface ButlerMemberFiles {
  canPush(userId: string): ButlerFileReach
  push(userId: string, file: ImOutboundFile): Promise<ButlerFilePushResult>
}

export interface ButlerReachableOptions {
  /** `<space>/butler/reachable` — where per-user routes persist. */
  dir: string
  /**
   * Resolve the live bridge for a platform. Closes over `startImBridges`' bridges
   * array (populated after this registry is built), read lazily at push time so a
   * bridge that started after the registry is still found.
   */
  bridgeFor: (platform: string) => ImBridge | undefined
  logger: ImLogger
  /**
   * 这个账号现在还绑在这个成员名下吗。路由只在成员说话时更新,解绑和换绑都碰不到它,
   * 重启后还会从盘上恢复。账号可能已经绑给别人,而消息和文件发出去收不回来,所以每次
   * 投递前都要问。必填:漏接就等于把成员的私事发给账号的新主人。
   */
  isBoundTo: (userId: string, route: ReachableRoute) => boolean
  /** Injectable clock (deterministic tests). Default `Date.now`. */
  now?: () => number
}

/**
 * The reachability registry: an in-memory `userId → route` map, write-through to
 * disk, with a `push(userId, text)` that delivers a line to that member's last
 * chat. Foundation only — F1 exposes it; S1-M3 / S3-M1 / S3-M2 call `push`.
 */
export class ButlerReachableRegistry {
  private readonly routes = new Map<string, ReachableRoute>()
  private readonly dir: string
  private readonly bridgeFor: (platform: string) => ImBridge | undefined
  private readonly log: ImLogger
  private readonly isBoundTo: (userId: string, route: ReachableRoute) => boolean
  private readonly now: () => number
  /** In-flight write-through persists — awaited by `flush()` (graceful shutdown,
   *  and deterministic round-trip tests) so a route is on disk before a restart. */
  private readonly pending = new Set<Promise<void>>()

  constructor(opts: ButlerReachableOptions) {
    this.dir = opts.dir
    this.bridgeFor = opts.bridgeFor
    this.log = opts.logger
    this.isBoundTo = opts.isBoundTo
    this.now = opts.now ?? Date.now
  }

  /**
   * Rehydrate persisted routes into the Map. Best-effort: a missing dir is a
   * fresh hub (no routes yet), and a corrupt / unsafe file is skipped and logged
   * — one bad file must never stop the others (the reminder for member B still
   * delivers even if member A's route file is garbage).
   */
  async load(): Promise<void> {
    let files: string[]
    try {
      files = await readdir(this.dir)
    } catch {
      return // dir doesn't exist yet — no routes to load
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const userId = file.slice(0, -'.json'.length)
      try {
        assertSafeOwnerId(userId) // defence-in-depth: never trust a filename as an id
        const raw = await readFile(join(this.dir, file), 'utf8')
        const route = this.parseRoute(JSON.parse(raw))
        if (route) this.routes.set(userId, route)
      } catch (err) {
        this.log.warn('butler reachable: skipping bad route file', {
          file,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /**
   * Record where a member just talked to us. Called on every inbound message from
   * a bound member, so the route always points at their freshest chat. Write-
   * through is best-effort and DEDUPED — an unchanged route (the common case: a
   * member chatting repeatedly from the same DM) doesn't rewrite the file.
   *
   * Contract: callers only pass `chatId` for DIRECT chats (`recordReachable`
   * omits it for group messages) — the stored route stamps it `chatKind:
   * 'direct'` on that promise.
   */
  record(input: {
    userId: string
    platform: string
    platformUserId: string
    displayName?: string | null
    /** The member's DM chat id — never a group room id (see contract above). */
    chatId?: string
  }): void {
    if (!input.userId) return // unbound / spoof — nothing to key on
    const prev = this.routes.get(input.userId)
    const changed =
      !prev ||
      prev.platform !== input.platform ||
      prev.platformUserId !== input.platformUserId ||
      prev.chatId !== input.chatId ||
      (prev.displayName ?? null) !== (input.displayName ?? null)
    const route: ReachableRoute = {
      platform: input.platform,
      platformUserId: input.platformUserId,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.chatId !== undefined ? { chatId: input.chatId, chatKind: 'direct' as const } : {}),
      updatedAt: this.now(),
    }
    this.routes.set(input.userId, route)
    if (changed) {
      // Track the in-flight write so `flush()` can await it. Best-effort still —
      // a rejected persist is swallowed inside `persist` and never surfaces here.
      const p = this.persist(input.userId, route).finally(() => this.pending.delete(p))
      this.pending.add(p)
    }
  }

  /** Await every in-flight write-through persist. Called on graceful shutdown so a
   *  route just recorded is on disk before the process exits; tests use it to make
   *  the fire-and-forget write deterministic. */
  async flush(): Promise<void> {
    await Promise.all(this.pending)
  }

  /** 记录的路由(undefined = 没说过话或还没加载)。不代表能投递,投递前要核对绑定。 */
  routeFor(userId: string): ReachableRoute | undefined {
    return this.routes.get(userId)
  }

  /** 能投递的路由。账号已经不属于这个成员,或者查不出来,都当没有路由。 */
  private deliverableRoute(userId: string): ReachableRoute | undefined {
    const route = this.routes.get(userId)
    if (!route) return undefined
    try {
      if (this.isBoundTo(userId, route)) return route
      this.log.info('butler reachable: route is no longer bound to this member', {
        userId,
        platform: route.platform,
      })
    } catch (err) {
      this.log.warn('butler reachable: binding lookup failed', {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
    return undefined
  }

  /**
   * Push a line of text to a member's last chat. Returns a typed result so a
   * caller (reminder / approval push-back) can distinguish "member has no chat
   * of their own" from "the bridge is down" from "send threw" — a reminder that can't be
   * delivered should be logged, not lost silently.
   */
  async push(userId: string, text: string): Promise<ButlerPushResult> {
    const route = this.deliverableRoute(userId)
    if (!route) return { delivered: false, reason: 'unknown_member' }
    const bridge = this.bridgeFor(route.platform)
    if (!bridge) return { delivered: false, reason: 'no_bridge' }
    const to: ImUser = {
      platform: route.platform,
      platformUserId: route.platformUserId,
      displayName: route.displayName ?? null,
    }
    try {
      await bridge.sendMessage(to, text, route.chatId !== undefined ? { chatId: route.chatId } : {})
      return { delivered: true }
    } catch (err) {
      this.log.error('butler push failed', {
        userId,
        platform: route.platform,
        err: err instanceof Error ? err.message : String(err),
      })
      return { delivered: false, reason: 'send_failed' }
    }
  }

  /** 能力探测:路由和桥都在,而且这座桥实现了 `sendFile`。 */
  canPushFile(userId: string): ButlerFileReach {
    const route = this.deliverableRoute(userId)
    if (!route) return { ok: false, reason: 'unknown_member' }
    const bridge = this.bridgeFor(route.platform)
    if (!bridge) return { ok: false, reason: 'no_bridge' }
    if (!bridge.sendFile) return { ok: false, reason: 'unsupported' }
    return { ok: true }
  }

  /**
   * 把文件发到成员本人。路由表只记私聊(GRP),所以在群里触发也不会发到群里。
   * 不走 outbox:成员正等着这份文件,失败要当场说,而不是日后悄悄重投。
   */
  async pushFile(userId: string, file: ImOutboundFile): Promise<ButlerFilePushResult> {
    const route = this.deliverableRoute(userId)
    if (!route) return { delivered: false, reason: 'unknown_member' }
    const bridge = this.bridgeFor(route.platform)
    if (!bridge) return { delivered: false, reason: 'no_bridge' }
    if (!bridge.sendFile) return { delivered: false, reason: 'unsupported' }
    const to: ImUser = {
      platform: route.platform,
      platformUserId: route.platformUserId,
      displayName: route.displayName ?? null,
    }
    try {
      await bridge.sendFile(to, file, route.chatId !== undefined ? { chatId: route.chatId } : {})
      return { delivered: true }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.log.error('butler file push failed', { userId, platform: route.platform, err: detail })
      return { delivered: false, reason: 'send_failed', detail: detail.slice(0, 300) }
    }
  }

  /** Write one route file. Best-effort — a persistence fault must not break the
   *  inbound path (the Map still has it; only restart-survival is degraded). */
  private async persist(userId: string, route: ReachableRoute): Promise<void> {
    try {
      assertSafeOwnerId(userId)
      await mkdir(this.dir, { recursive: true })
      await writeFile(join(this.dir, `${userId}.json`), JSON.stringify(route), 'utf8')
    } catch (err) {
      this.log.warn('butler reachable: failed to persist route', {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Validate a parsed JSON blob into a ReachableRoute (null = malformed → skip). */
  private parseRoute(v: unknown): ReachableRoute | null {
    if (typeof v !== 'object' || v === null) return null
    const o = v as Record<string, unknown>
    if (typeof o.platform !== 'string' || typeof o.platformUserId !== 'string') return null
    return {
      platform: o.platform,
      platformUserId: o.platformUserId,
      ...(typeof o.displayName === 'string' || o.displayName === null
        ? { displayName: o.displayName }
        : {}),
      // GRP — trust a persisted chatId only with the 'direct' provenance
      // marker; legacy (pre-GRP) files may hold a group room id (see the
      // ReachableRoute.chatKind doc). Dropping it here means the push falls
      // back to the platformUserId DM — degraded, never leaked.
      ...(typeof o.chatId === 'string' && o.chatKind === 'direct'
        ? { chatId: o.chatId, chatKind: 'direct' as const }
        : {}),
      updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    }
  }
}
