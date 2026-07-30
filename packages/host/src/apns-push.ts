/**
 * apns-push.ts — SHELL-M6: the native (APNs) push leg for the shell app.
 *
 * iOS only, APNs DIRECT: the operator's own Apple credentials talk straight to
 * Apple — no relay service in between, because a shared push relay would be
 * exactly the central node the charter forbids (same ruling as the rejected
 * central identity anchor). Android/FCM is deferred with the Android shell
 * itself: a leg nothing can exercise rots the day it is written.
 *
 * Config is FILE-FIRST, not env knobs (the 116-knob registry stays frozen —
 * agents.json / agent-card.json precedent): `<space>/apns.json` names the
 * credential (keyId / teamId / bundleId / environment) and points at a .p8
 * key file. Absent ⇒ OFF, byte-identical hub. Malformed JSON or fields ⇒
 * warn + OFF (the opt-in signal itself is broken). Valid config + unusable
 * KEY ⇒ throw at boot — the operator explicitly opted in, and silently
 * disabling would silently stop notifications (web-push key posture).
 *
 * Same low-info discipline as WebPushSender: `push(userId)` takes NO text
 * parameter, so member content structurally cannot ride a notification — the
 * alert is the fixed bilingual TAP_PAYLOAD (one copy, imported). Honesty
 * note: unlike RFC 8291 web push, APNs alert bodies are readable by Apple —
 * acceptable only BECAUSE the payload is content-free by construction; token
 * + timing metadata transit Apple either way (dataLeavesBox disclosure).
 *
 * Native tokens are MORE devices on the SAME tap leg, not a second leg:
 * `composeTapFallback` merges web-push and APNs into the one fallback the IM
 * bridge already folds on `unknown_member` — IM-bound members stay
 * byte-identical, and every subscribed device buzzes (≥1 ok = delivered).
 *
 * Tokens are stored PER USER, not per device credential: `resolveV4Auth`
 * does not surface which aipk_ credential authenticated (extending the
 * identity session face is out of this milestone's blast radius). Revoking a
 * device under 我的→设备 therefore stops its DATA access at once, but its
 * push token lingers until the shell's disconnect flow unregisters it or
 * Apple answers 410/BadDeviceToken (uninstall) and we prune. Documented as
 * an honest boundary, not hidden.
 */

import { connect } from 'node:http2'
import { createPrivateKey, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { es256Sign } from '@gotong/a2a'
import { writeJsonAtomic } from '@gotong/core'
import { assertSafeOwnerId } from '@gotong/services-sdk'

import type { ButlerPushResult } from './butler-reachable.js'
import type { ImLogger } from './im-bridge.js'
import { TAP_PAYLOAD } from './web-push-sender.js'

// ─── Config (file-first; `<space>/apns.json`) ───────────────────────────────

const APNS_CONFIG_FILE = 'apns.json'
const DEFAULT_KEY_FILE = 'apns-key.p8'

export interface ApnsConfig {
  /** Apple push key id (the 10-char id shown next to the .p8 download). */
  keyId: string
  /** Apple Developer team id. Not a secret — it ships inside every app. */
  teamId: string
  /** The app's bundle id — becomes the mandatory `apns-topic` header. */
  bundleId: string
  /**
   * Which APNs endpoint tokens on this hub belong to. A hub serves ONE build
   * channel of the shell: debug builds mint sandbox tokens, TestFlight/App
   * Store builds mint production ones. A token from the other channel gets
   * BadDeviceToken from Apple and is pruned — honest, self-healing.
   */
  environment: 'sandbox' | 'production'
  /** Path to the .p8 key, relative to the space root unless absolute. */
  keyFile: string
}

function readConfigField(o: Record<string, unknown>, key: string, max: number): string | null {
  const v = o[key]
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s.length > 0 && s.length <= max ? s : null
}

/**
 * Read `<space>/apns.json` + its key file. Absent file ⇒ undefined (OFF).
 * Broken opt-in signal ⇒ warn + undefined. Opted in but key unusable ⇒ throw.
 */
export function loadApnsConfig(
  spaceRoot: string,
  logger: ImLogger,
): { config: ApnsConfig; privateKey: KeyObject } | undefined {
  const path = join(spaceRoot, APNS_CONFIG_FILE)
  if (!existsSync(path)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    logger.warn('apns: apns.json is not valid JSON; native push stays OFF', {
      path,
      err: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    logger.warn('apns: apns.json must be an object; native push stays OFF', { path })
    return undefined
  }
  const o = raw as Record<string, unknown>
  const keyId = readConfigField(o, 'keyId', 64)
  const teamId = readConfigField(o, 'teamId', 64)
  const bundleId = readConfigField(o, 'bundleId', 128)
  const environment = o.environment
  if (!keyId || !teamId || !bundleId || (environment !== 'sandbox' && environment !== 'production')) {
    logger.warn(
      'apns: apns.json needs { keyId, teamId, bundleId, environment: "sandbox"|"production" }; native push stays OFF',
      { path },
    )
    return undefined
  }
  const keyFile = readConfigField(o, 'keyFile', 512) ?? DEFAULT_KEY_FILE
  const keyPath = isAbsolute(keyFile) ? keyFile : join(spaceRoot, keyFile)
  // From here on the operator HAS opted in — a broken key throws loudly.
  let privateKey: KeyObject
  try {
    privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'))
  } catch (err) {
    throw new Error(`apns key at ${keyPath} is not a readable private key: ${String(err)}`)
  }
  if (privateKey.asymmetricKeyType !== 'ec') {
    throw new Error(`apns key at ${keyPath} must be an EC (P-256) key, got ${privateKey.asymmetricKeyType}`)
  }
  return { config: { keyId, teamId, bundleId, environment, keyFile }, privateKey }
}

// ─── Provider JWT (Apple's token-based auth; ES256, iat-based lifetime) ─────

/** Apple accepts provider tokens for ~1h and throttles re-mints under 20min. */
const JWT_REFRESH_MS = 45 * 60_000

export interface ApnsJwtOpts {
  keyId: string
  teamId: string
  privateKey: KeyObject
  now?: () => number
}

/** Bare ES256 JWT — header `{alg,kid}`, claims `{iss,iat}` (no aud/exp). */
export function buildApnsJwt(opts: ApnsJwtOpts): string {
  const iat = Math.floor((opts.now ?? Date.now)() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: opts.keyId }), 'utf8').toString('base64url')
  const claims = Buffer.from(JSON.stringify({ iss: opts.teamId, iat }), 'utf8').toString('base64url')
  const input = `${header}.${claims}`
  return `${input}.${es256Sign(opts.privateKey, Buffer.from(input, 'utf8')).toString('base64url')}`
}

// ─── Token store (mirrors WebPushSubscriptionStore's disciplines) ───────────

/** Devices per member — the 6th registration drops the oldest, loudly. */
export const NATIVE_PUSH_MAX_TOKENS = 5

export interface NativePushToken {
  /** APNs device token, lowercase hex. Opaque to us beyond the shape check. */
  token: string
  platform: 'ios'
  createdAt: number
  lastOkAt?: number
}

/** Loud, typed refusal — routes map `code:'invalid'` to a 400. */
export class NativePushStoreError extends Error {
  constructor(
    readonly code: 'invalid',
    message: string,
  ) {
    super(message)
    this.name = 'NativePushStoreError'
  }
}

export interface NativePushStoreOptions {
  /** `<space>/butler/push-native` — per-member token files live here. */
  dir: string
  logger: ImLogger
  now?: () => number
  maxTokens?: number
}

export class NativePushTokenStore {
  private readonly dir: string
  private readonly log: ImLogger
  private readonly now: () => number
  private readonly max: number
  /** Per-userId serialize chain — same-member read-modify-writes never race. */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(opts: NativePushStoreOptions) {
    this.dir = opts.dir
    this.log = opts.logger
    this.now = opts.now ?? Date.now
    this.max = opts.maxTokens ?? NATIVE_PUSH_MAX_TOKENS
  }

  async list(userId: string): Promise<NativePushToken[]> {
    assertSafeOwnerId(userId)
    return this.read(userId)
  }

  /** Validate + upsert one device token; re-registering updates in place. */
  async add(
    userId: string,
    input: unknown,
  ): Promise<{ count: number; replaced: boolean; dropped: number }> {
    assertSafeOwnerId(userId)
    const row = validateNativeToken(input, this.now())
    return this.withLock(userId, async () => {
      const tokens = await this.read(userId)
      const existing = tokens.findIndex((t) => t.token === row.token)
      if (existing >= 0) tokens.splice(existing, 1)
      tokens.push(row)
      const overflow = tokens.length - this.max
      if (overflow > 0) {
        tokens.splice(0, overflow)
        this.log.warn('apns: token cap reached, dropped oldest', {
          userId,
          dropped: overflow,
          max: this.max,
        })
      }
      await this.write(userId, tokens)
      return { count: tokens.length, replaced: existing >= 0, dropped: Math.max(overflow, 0) }
    })
  }

  /** Remove by token — idempotent; serves both unregister and the 410 prune. */
  async remove(userId: string, token: string): Promise<{ removed: boolean }> {
    assertSafeOwnerId(userId)
    const needle = String(token).trim().toLowerCase()
    return this.withLock(userId, async () => {
      const tokens = await this.read(userId)
      const next = tokens.filter((t) => t.token !== needle)
      if (next.length === tokens.length) return { removed: false }
      await this.write(userId, next)
      return { removed: true }
    })
  }

  /** Best-effort `lastOkAt` stamp from the delivery leg — never throws. */
  async markDelivered(userId: string, token: string): Promise<void> {
    try {
      assertSafeOwnerId(userId)
      await this.withLock(userId, async () => {
        const tokens = await this.read(userId)
        const hit = tokens.find((t) => t.token === token)
        if (!hit) return
        hit.lastOkAt = this.now()
        await this.write(userId, tokens)
      })
    } catch (err) {
      this.log.warn('apns: failed to stamp delivery', {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

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
  private async read(userId: string): Promise<NativePushToken[]> {
    let raw: string
    try {
      raw = await readFile(this.pathFor(userId), 'utf8')
    } catch {
      return []
    }
    try {
      const parsed = JSON.parse(raw) as { tokens?: unknown }
      const rows = Array.isArray(parsed?.tokens) ? parsed.tokens : []
      const good: NativePushToken[] = []
      let skipped = 0
      for (const row of rows) {
        const t = parseStoredToken(row)
        if (t) good.push(t)
        else skipped++
      }
      if (skipped > 0) this.log.warn('apns: skipped malformed token entries', { userId, skipped })
      return good
    } catch (err) {
      this.log.warn('apns: token file is not valid JSON, serving none', {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
      return []
    }
  }

  private async write(userId: string, tokens: NativePushToken[]): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    await writeJsonAtomic(this.pathFor(userId), { tokens })
  }
}

/**
 * Validate a shell registration `{ token, platform }`. APNs tokens are
 * documented as opaque, but every real one is hex — pinning the alphabet
 * (16..200 chars, stored lowercase) rejects garbage without guessing length.
 */
export function validateNativeToken(input: unknown, createdAt: number): NativePushToken {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new NativePushStoreError('invalid', 'registration must be an object')
  }
  const o = input as Record<string, unknown>
  if (o.platform !== 'ios') {
    throw new NativePushStoreError('invalid', 'registration.platform must be "ios"')
  }
  const raw = typeof o.token === 'string' ? o.token.trim() : ''
  if (!/^[0-9a-fA-F]{16,200}$/.test(raw)) {
    throw new NativePushStoreError('invalid', 'registration.token must be 16–200 hex chars')
  }
  return { token: raw.toLowerCase(), platform: 'ios', createdAt }
}

/** Stored rows re-validated on read; a hand-edited bad row is skipped. */
function parseStoredToken(v: unknown): NativePushToken | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  try {
    const t = validateNativeToken(o, typeof o.createdAt === 'number' ? o.createdAt : 0)
    return { ...t, ...(typeof o.lastOkAt === 'number' ? { lastOkAt: o.lastOkAt } : {}) }
  } catch {
    return null
  }
}

// ─── Sender (HTTP/2 to APNs; low-info tap only) ─────────────────────────────

const APNS_TIMEOUT_MS = 10_000
/** Aligned with the web-push leg — a day-old tap is still actionable. */
const APNS_TTL_SECONDS = 24 * 3600
const APNS_COLLAPSE_ID = 'gotong-butler-tap'

function apnsOrigin(environment: ApnsConfig['environment']): string {
  return environment === 'production'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com'
}

export interface ApnsSenderOptions {
  config: ApnsConfig
  privateKey: KeyObject
  store: NativePushTokenStore
  logger: ImLogger
  now?: () => number
  /** Test seam: point at a local h2c mock instead of Apple. */
  originOverride?: string
}

export class ApnsSender {
  private readonly cfg: ApnsConfig
  private readonly key: KeyObject
  private readonly store: NativePushTokenStore
  private readonly log: ImLogger
  private readonly now: () => number
  private readonly origin: string
  private jwtCache: { value: string; mintedAt: number } | null = null

  constructor(opts: ApnsSenderOptions) {
    this.cfg = opts.config
    this.key = opts.privateKey
    this.store = opts.store
    this.log = opts.logger
    this.now = opts.now ?? Date.now
    this.origin = opts.originOverride ?? apnsOrigin(opts.config.environment)
  }

  private authJwt(): string {
    const nowMs = this.now()
    if (!this.jwtCache || nowMs - this.jwtCache.mintedAt > JWT_REFRESH_MS) {
      this.jwtCache = {
        value: buildApnsJwt({
          keyId: this.cfg.keyId,
          teamId: this.cfg.teamId,
          privateKey: this.key,
          now: this.now,
        }),
        mintedAt: nowMs,
      }
    }
    return this.jwtCache.value
  }

  /** Deliver one low-info tap to every device the member registered. */
  async push(userId: string): Promise<ButlerPushResult> {
    let tokens: NativePushToken[]
    try {
      tokens = await this.store.list(userId)
    } catch {
      return { delivered: false, reason: 'unknown_member' }
    }
    if (tokens.length === 0) return { delivered: false, reason: 'unknown_member' }

    const body = JSON.stringify({ aps: { alert: TAP_PAYLOAD, sound: 'default' } })
    let delivered = 0
    for (const t of tokens) {
      try {
        const res = await this.send(t.token, body)
        if (res.status === 200) {
          delivered++
          await this.store.markDelivered(userId, t.token)
        } else if (
          res.status === 410 ||
          res.reason === 'Unregistered' ||
          res.reason === 'BadDeviceToken'
        ) {
          // The device dropped this token (uninstall / channel mismatch) — prune.
          await this.store.remove(userId, t.token)
          this.log.info('apns: device token no longer valid, pruned', {
            userId,
            status: res.status,
            reason: res.reason ?? null,
          })
        } else if (res.status === 403) {
          // OUR provider JWT was refused — drop the cache so the next push
          // re-mints instead of replaying a bad token for 45 minutes.
          this.jwtCache = null
          this.log.warn('apns: provider token refused', { userId, reason: res.reason ?? null })
        } else {
          this.log.warn('apns: push refused', { userId, status: res.status, reason: res.reason ?? null })
        }
      } catch (err) {
        this.log.warn('apns: delivery attempt failed', {
          userId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return delivered > 0 ? { delivered: true } : { delivered: false, reason: 'send_failed' }
  }

  /** One HTTP/2 POST /3/device/<token>; session per call (taps are rare). */
  private send(token: string, body: string): Promise<{ status: number; reason?: string }> {
    return new Promise((resolve, reject) => {
      let settled = false
      const session = connect(this.origin)
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        session.close()
        fn()
      }
      const timer = setTimeout(
        () => finish(() => reject(new Error(`apns request timed out after ${APNS_TIMEOUT_MS}ms`))),
        APNS_TIMEOUT_MS,
      )
      session.on('error', (err) => finish(() => reject(err)))
      let req
      try {
        req = session.request({
          ':method': 'POST',
          ':path': `/3/device/${token}`,
          authorization: `bearer ${this.authJwt()}`,
          'apns-topic': this.cfg.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(this.now() / 1000) + APNS_TTL_SECONDS),
          'apns-collapse-id': APNS_COLLAPSE_ID,
          'content-type': 'application/json',
        })
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))))
        return
      }
      let status = 0
      const chunks: Buffer[] = []
      req.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0)
      })
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        let reason: string | undefined
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: unknown }
          if (typeof parsed.reason === 'string') reason = parsed.reason
        } catch {
          // non-JSON body (200s have none) — status alone is enough
        }
        finish(() => resolve({ status, ...(reason ? { reason } : {}) }))
      })
      req.on('error', (err) => finish(() => reject(err)))
      req.end(body)
    })
  }
}

// ─── Tap-leg composition ────────────────────────────────────────────────────

type TapLeg = (userId: string) => Promise<ButlerPushResult>

/**
 * Merge the web-push and APNs legs into the ONE tap fallback the IM bridge
 * folds on `unknown_member`. Both run in parallel — native tokens are more
 * devices, not a precedence chain — and ≥1 delivery counts. Reasons merge
 * honestly: any attempted-but-failed leg yields `send_failed` (the outbox
 * keeps retrying); `unknown_member` only when NO device is registered anywhere.
 */
export function composeTapFallback(a: TapLeg | undefined, b: TapLeg | undefined): TapLeg | undefined {
  if (!a || !b) return a ?? b
  const safe = (leg: TapLeg, userId: string): Promise<ButlerPushResult> =>
    leg(userId).catch(() => ({ delivered: false, reason: 'send_failed' as const }))
  return async (userId) => {
    const [ra, rb] = await Promise.all([safe(a, userId), safe(b, userId)])
    if (ra.delivered || rb.delivered) return { delivered: true }
    if (ra.reason === 'send_failed' || rb.reason === 'send_failed') {
      return { delivered: false, reason: 'send_failed' }
    }
    return { delivered: false, reason: 'unknown_member' }
  }
}

// ─── Assembly (file → service), mirrors buildWebPushService ─────────────────

export interface ApnsPushService {
  /** Duck for the web layer's MeNativePushSurface. */
  surface: {
    count(userId: string): Promise<number>
    add(userId: string, input: unknown): Promise<{ count: number; replaced: boolean }>
    remove(userId: string, token: string): Promise<{ removed: boolean }>
  }
  /** The native half of the tap leg — composed via `composeTapFallback`. */
  fallback: TapLeg
  /** Startup disclosure — ids and endpoint choice, NEVER key bytes. */
  disclosure: string
}

export function buildApnsPushService(
  spaceRoot: string,
  logger: ImLogger,
  opts: { now?: () => number; originOverride?: string } = {},
): ApnsPushService | undefined {
  const loaded = loadApnsConfig(spaceRoot, logger)
  if (!loaded) return undefined
  const store = new NativePushTokenStore({
    dir: join(spaceRoot, 'butler', 'push-native'),
    logger,
    ...(opts.now ? { now: opts.now } : {}),
  })
  const sender = new ApnsSender({
    config: loaded.config,
    privateKey: loaded.privateKey,
    store,
    logger,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.originOverride ? { originOverride: opts.originOverride } : {}),
  })
  return {
    surface: {
      count: async (userId) => (await store.list(userId)).length,
      add: (userId, input) => store.add(userId, input),
      remove: (userId, token) => store.remove(userId, token),
    },
    fallback: (userId) => sender.push(userId),
    disclosure: `apns push enabled: topic=${loaded.config.bundleId} env=${loaded.config.environment} keyId=${loaded.config.keyId} teamId=${loaded.config.teamId}`,
  }
}
