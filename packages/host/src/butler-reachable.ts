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
 * All three need the same primitive: given an AipeHub `userId`, deliver a line of
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
 * No-leak by construction: a route is keyed by the member's OWN userId and only
 * ever pushed to that member's own last chat — this module never fans out.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ImBridge, ImUser } from '@aipehub/im-adapter'
import { assertSafeOwnerId } from '@aipehub/services-sdk'

import type { ImLogger } from './im-bridge.js'

/** Where a member last talked to us — enough to push a message back to them. */
export interface ReachableRoute {
  platform: string
  platformUserId: string
  displayName?: string | null
  /** Platform chat / room id (DM vs group). Absent when the bridge didn't surface one. */
  chatId?: string
  /** When this route was last observed (freshest inbound wins). */
  updatedAt: number
}

export type ButlerPushResult =
  | { delivered: true }
  | { delivered: false; reason: 'unknown_member' | 'no_bridge' | 'send_failed' }

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
  private readonly now: () => number
  /** In-flight write-through persists — awaited by `flush()` (graceful shutdown,
   *  and deterministic round-trip tests) so a route is on disk before a restart. */
  private readonly pending = new Set<Promise<void>>()

  constructor(opts: ButlerReachableOptions) {
    this.dir = opts.dir
    this.bridgeFor = opts.bridgeFor
    this.log = opts.logger
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
   */
  record(input: {
    userId: string
    platform: string
    platformUserId: string
    displayName?: string | null
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
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
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

  /** The current route for a member (undefined = never reached / not loaded). */
  routeFor(userId: string): ReachableRoute | undefined {
    return this.routes.get(userId)
  }

  /**
   * Push a line of text to a member's last chat. Returns a typed result so a
   * caller (reminder / approval push-back) can distinguish "member never bound a
   * chat" from "the bridge is down" from "send threw" — a reminder that can't be
   * delivered should be logged, not lost silently.
   */
  async push(userId: string, text: string): Promise<ButlerPushResult> {
    const route = this.routes.get(userId)
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
      ...(typeof o.chatId === 'string' ? { chatId: o.chatId } : {}),
      updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    }
  }
}
