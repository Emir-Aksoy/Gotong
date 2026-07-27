/**
 * web-push-store.ts — PUSH-M2: per-member Web Push subscription store.
 *
 * A subscription is "another reachable route" — a browser the member said
 * "wake me here" in. Same family discipline as butler-reachable/butler-outbox:
 * flat `<space>/butler/push/<userId>.json`, `assertSafeOwnerId` before any
 * path assembly, a per-user promise chain so read-modify-write never
 * interleaves. Unlike a reachable route (relearned on the member's next
 * message), a torn subscription file strands every device until the member
 * re-opts-in browser by browser — so writes go through `writeJsonAtomic`.
 *
 * This class is also the ONE validator choke point (validatePanelConfig
 * precedent): every write path funnels through `validateSubscription`, so a
 * subscription that reaches disk is always https, non-local, and
 * cryptographically usable. The SSRF stance is structural: the hub will POST
 * to whatever endpoint is stored here, so `localhost`/`*.localhost` and ALL
 * IP literals (v4 and v6) are refused outright — real push services
 * (FCM / Mozilla / Apple / WNS / self-hosted UnifiedPush gateways) are always
 * named hosts, and a range-list of private CIDRs would only rot. Residual
 * (documented in WEB-PUSH.md): names that RESOLVE to private space — the DNS
 * rebinding class — are out of v1 scope.
 *
 * Reader discipline mirrors the panel store: `list` never quarantines a bad
 * file (warn + [], evidence left in place); malformed ENTRIES inside an
 * otherwise-valid file are skipped individually.
 */

import { readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { writeJsonAtomic } from '@gotong/core'
import { assertSafeOwnerId } from '@gotong/services-sdk'

import type { ImLogger } from './im-bridge.js'

/** Devices per member — the 6th subscription drops the oldest, loudly. */
export const WEBPUSH_MAX_SUBSCRIPTIONS = 5
/** Push-service URLs are long but bounded; anything past this is not one. */
export const WEBPUSH_MAX_ENDPOINT_CHARS = 2048
const MAX_UA_CHARS = 80

export interface WebPushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
  /** Browser self-description, display only (control-stripped, bounded). */
  ua?: string
  createdAt: number
  /** Stamped by the delivery leg on a 2xx from the push service. */
  lastOkAt?: number
}

/** Loud, typed refusal — routes map `code:'invalid'` to a 400. */
export class WebPushStoreError extends Error {
  constructor(
    readonly code: 'invalid',
    message: string,
  ) {
    super(message)
    this.name = 'WebPushStoreError'
  }
}

export interface WebPushStoreOptions {
  /** `<space>/butler/push` — per-member subscription files live here. */
  dir: string
  logger: ImLogger
  /** Injected clock (deterministic tests); defaults to Date.now. */
  now?: () => number
  maxSubscriptions?: number
}

export class WebPushSubscriptionStore {
  private readonly dir: string
  private readonly log: ImLogger
  private readonly now: () => number
  private readonly max: number
  /** Per-userId serialize chain — same-member read-modify-writes never race. */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(opts: WebPushStoreOptions) {
    this.dir = opts.dir
    this.log = opts.logger
    this.now = opts.now ?? Date.now
    this.max = opts.maxSubscriptions ?? WEBPUSH_MAX_SUBSCRIPTIONS
  }

  /** All of the member's subscriptions, oldest first. */
  async list(userId: string): Promise<WebPushSubscription[]> {
    assertSafeOwnerId(userId)
    return this.read(userId)
  }

  /**
   * Validate + upsert one browser subscription (`PushSubscription.toJSON()`
   * shape). Same endpoint re-subscribing updates in place; a new device past
   * the cap drops the oldest with a warn (no silent caps).
   */
  async add(
    userId: string,
    input: unknown,
  ): Promise<{ count: number; replaced: boolean; dropped: number }> {
    assertSafeOwnerId(userId)
    const sub = validateSubscription(input, this.now())
    return this.withLock(userId, async () => {
      const subs = await this.read(userId)
      const existing = subs.findIndex((s) => s.endpoint === sub.endpoint)
      if (existing >= 0) subs.splice(existing, 1)
      subs.push(sub)
      const overflow = subs.length - this.max
      if (overflow > 0) {
        subs.splice(0, overflow)
        this.log.warn('web-push: subscription cap reached, dropped oldest', {
          userId,
          dropped: overflow,
          max: this.max,
        })
      }
      await this.write(userId, subs)
      return { count: subs.length, replaced: existing >= 0, dropped: Math.max(overflow, 0) }
    })
  }

  /**
   * Remove by endpoint — idempotent. Serves both the member's explicit
   * unsubscribe and the delivery leg's 404/410 self-heal prune.
   */
  async remove(userId: string, endpoint: string): Promise<{ removed: boolean }> {
    assertSafeOwnerId(userId)
    return this.withLock(userId, async () => {
      const subs = await this.read(userId)
      const next = subs.filter((s) => s.endpoint !== endpoint)
      if (next.length === subs.length) return { removed: false }
      await this.write(userId, next)
      return { removed: true }
    })
  }

  /** Best-effort `lastOkAt` stamp from the delivery leg — never throws. */
  async markDelivered(userId: string, endpoint: string): Promise<void> {
    try {
      assertSafeOwnerId(userId)
      await this.withLock(userId, async () => {
        const subs = await this.read(userId)
        const hit = subs.find((s) => s.endpoint === endpoint)
        if (!hit) return
        hit.lastOkAt = this.now()
        await this.write(userId, subs)
      })
    } catch (err) {
      this.log.warn('web-push: failed to stamp delivery', {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private pathFor(userId: string): string {
    return join(this.dir, `${userId}.json`)
  }

  private withLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(userId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.locks.set(
      userId,
      next.catch(() => undefined),
    )
    return next
  }

  /** Reader never quarantines: bad file → warn + [], evidence left in place. */
  private async read(userId: string): Promise<WebPushSubscription[]> {
    let raw: string
    try {
      raw = await readFile(this.pathFor(userId), 'utf8')
    } catch {
      return []
    }
    try {
      const parsed = JSON.parse(raw) as { subs?: unknown }
      const rows = Array.isArray(parsed?.subs) ? parsed.subs : []
      const good: WebPushSubscription[] = []
      let skipped = 0
      for (const row of rows) {
        const sub = parseStoredSubscription(row)
        if (sub) good.push(sub)
        else skipped++
      }
      if (skipped > 0) {
        this.log.warn('web-push: skipped malformed subscription entries', { userId, skipped })
      }
      return good
    } catch (err) {
      this.log.warn('web-push: subscription file is not valid JSON, serving none', {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
      return []
    }
  }

  private async write(userId: string, subs: WebPushSubscription[]): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    await writeJsonAtomic(this.pathFor(userId), { subs })
  }
}

// ─── The validator choke point ───────────────────────────────────────────────

/** Validate a `PushSubscription.toJSON()` blob; throws WebPushStoreError. */
export function validateSubscription(input: unknown, createdAt: number): WebPushSubscription {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new WebPushStoreError('invalid', 'subscription must be an object')
  }
  const o = input as Record<string, unknown>
  const endpoint = o.endpoint
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new WebPushStoreError('invalid', 'subscription.endpoint must be a string')
  }
  if (endpoint.length > WEBPUSH_MAX_ENDPOINT_CHARS) {
    throw new WebPushStoreError(
      'invalid',
      `subscription.endpoint exceeds ${WEBPUSH_MAX_ENDPOINT_CHARS} chars`,
    )
  }
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new WebPushStoreError('invalid', 'subscription.endpoint is not a valid URL')
  }
  if (url.protocol !== 'https:') {
    throw new WebPushStoreError('invalid', 'subscription.endpoint must be https')
  }
  if (isLocalOrLiteralHost(url.hostname)) {
    throw new WebPushStoreError(
      'invalid',
      'subscription.endpoint must be a named public host (no localhost / IP literals)',
    )
  }
  const keys = o.keys
  if (typeof keys !== 'object' || keys === null) {
    throw new WebPushStoreError('invalid', 'subscription.keys must be an object')
  }
  const { p256dh, auth } = keys as Record<string, unknown>
  if (typeof p256dh !== 'string' || !isP256Point(p256dh)) {
    throw new WebPushStoreError(
      'invalid',
      'subscription.keys.p256dh must be a base64url 65-byte uncompressed P-256 point',
    )
  }
  if (typeof auth !== 'string' || b64urlLen(auth) !== 16) {
    throw new WebPushStoreError('invalid', 'subscription.keys.auth must be 16 base64url bytes')
  }
  const ua = typeof o.ua === 'string' ? cleanUa(o.ua) : undefined
  return {
    endpoint,
    keys: { p256dh, auth },
    ...(ua ? { ua } : {}),
    createdAt,
  }
}

/**
 * The hub POSTs to stored endpoints, so what may be stored IS the SSRF
 * boundary: refuse localhost names and every IP literal. `URL.hostname`
 * keeps `[...]` around IPv6, and any bare hostname containing `:` can only
 * be a v6 literal too.
 */
function isLocalOrLiteralHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.includes(':') || host.startsWith('[')) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true
  return false
}

function b64urlLen(s: string): number {
  try {
    return Buffer.from(s, 'base64url').length
  } catch {
    return -1
  }
}

function isP256Point(s: string): boolean {
  const buf = Buffer.from(s, 'base64url')
  return buf.length === 65 && buf[0] === 0x04
}

/** Display-only hygiene (GRP speaker-label posture): strip C0/DEL, bound. */
function cleanUa(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0)!
    if (code < 0x20 || code === 0x7f) continue
    out += ch
    if (out.length >= MAX_UA_CHARS) break
  }
  const trimmed = out.trim()
  return trimmed.length > 0 ? trimmed : ''
}

/** Stored rows re-validated on read; a hand-edited bad row is skipped. */
function parseStoredSubscription(v: unknown): WebPushSubscription | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  try {
    const sub = validateSubscription(o, typeof o.createdAt === 'number' ? o.createdAt : 0)
    return {
      ...sub,
      ...(typeof o.lastOkAt === 'number' ? { lastOkAt: o.lastOkAt } : {}),
    }
  } catch {
    return null
  }
}
