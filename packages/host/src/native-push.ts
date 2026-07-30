/**
 * native-push.ts — SHELL-M6/M6A: the shared native-push core (per-member token
 * store + tap-leg composition), the FCM (Android) delivery leg, and the one
 * assembly point that raises whichever legs `<space>/apns.json` /
 * `<space>/fcm.json` opt into. The APNs-specific half (config, provider JWT,
 * HTTP/2 sender) stays in apns-push.ts; this file imports it.
 *
 * FCM is DIRECT the same way APNs is: the operator's own Firebase service
 * account talks straight to Google — no relay in between (charter: no central
 * nodes). Mainland-China devices without Google services simply never obtain a
 * token; the shell degrades honestly to polling (fork A1 unchanged).
 *
 * Config is FILE-FIRST, not env knobs (the 116-knob registry stays frozen):
 * `<space>/fcm.json` is the service-account JSON downloaded from the Firebase
 * console, dropped VERBATIM — no wrapper format to hand-author. Absent ⇒ OFF,
 * byte-identical hub. Malformed / missing fields ⇒ warn + OFF (the opt-in
 * signal itself is broken). Fields present but private_key unusable ⇒ throw at
 * boot — the operator explicitly opted in, and silently disabling would
 * silently stop notifications (same posture as apns.json / web-push keys).
 *
 * One store serves both platforms: a member's file holds ios AND android rows,
 * and registration only accepts platforms with a configured sender (a token no
 * leg can ever serve must not be accepted). Reads keep validating BOTH shapes
 * — if a config file bounces, stored rows of the paused platform stay on disk
 * as evidence and resume when the leg returns.
 *
 * Low-info discipline unchanged: both legs send the fixed TAP_PAYLOAD and
 * `push(userId)` takes no text. FCM notification bodies are readable by Google
 * (as APNs bodies are by Apple) — acceptable only because the payload is
 * content-free by construction; token + timing metadata transit Google either
 * way (dataLeavesBox disclosure).
 */

import { createSign, createPrivateKey, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeJsonAtomic } from '@gotong/core'
import { assertSafeOwnerId } from '@gotong/services-sdk'

import { ApnsSender, loadApnsConfig } from './apns-push.js'
import type { ButlerPushResult } from './butler-reachable.js'
import type { ImLogger } from './im-bridge.js'
import { TAP_PAYLOAD } from './web-push-sender.js'

// ─── Token store (shared by both legs; mirrors WebPushSubscriptionStore) ────

export type NativePushPlatform = 'ios' | 'android'
export const NATIVE_PUSH_PLATFORMS: readonly NativePushPlatform[] = ['ios', 'android']

/** Devices per member — the 6th registration drops the oldest, loudly. */
export const NATIVE_PUSH_MAX_TOKENS = 5

export interface NativePushToken {
  /** ios: APNs token, lowercase hex. android: FCM token, case-sensitive verbatim. */
  token: string
  platform: NativePushPlatform
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
  /** Platforms with a configured sender — the only ones `add` accepts. */
  allowedPlatforms?: readonly NativePushPlatform[]
}

export class NativePushTokenStore {
  private readonly dir: string
  private readonly log: ImLogger
  private readonly now: () => number
  private readonly max: number
  private readonly allowed: readonly NativePushPlatform[]
  /** Per-userId serialize chain — same-member read-modify-writes never race. */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(opts: NativePushStoreOptions) {
    this.dir = opts.dir
    this.log = opts.logger
    this.now = opts.now ?? Date.now
    this.max = opts.maxTokens ?? NATIVE_PUSH_MAX_TOKENS
    this.allowed = opts.allowedPlatforms ?? NATIVE_PUSH_PLATFORMS
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
    const row = validateNativeToken(input, this.now(), this.allowed)
    return this.withLock(userId, async () => {
      const tokens = await this.read(userId)
      const existing = tokens.findIndex((t) => t.token === row.token)
      if (existing >= 0) tokens.splice(existing, 1)
      tokens.push(row)
      const overflow = tokens.length - this.max
      if (overflow > 0) {
        tokens.splice(0, overflow)
        this.log.warn('native-push: token cap reached, dropped oldest', {
          userId,
          dropped: overflow,
          max: this.max,
        })
      }
      await this.write(userId, tokens)
      return { count: tokens.length, replaced: existing >= 0, dropped: Math.max(overflow, 0) }
    })
  }

  /** Remove by token — idempotent; serves both unregister and the stale prune. */
  async remove(userId: string, token: string): Promise<{ removed: boolean }> {
    assertSafeOwnerId(userId)
    const raw = String(token).trim()
    const folded = raw.toLowerCase()
    return this.withLock(userId, async () => {
      const tokens = await this.read(userId)
      // ios rows are stored lowercased, android rows verbatim — match both honestly.
      const next = tokens.filter((t) => t.token !== raw && !(t.platform === 'ios' && t.token === folded))
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
      this.log.warn('native-push: failed to stamp delivery', {
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
      if (skipped > 0) this.log.warn('native-push: skipped malformed token entries', { userId, skipped })
      return good
    } catch (err) {
      this.log.warn('native-push: token file is not valid JSON, serving none', {
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
 * Validate a shell registration `{ token, platform }` per platform: APNs
 * tokens are hex (16..200 chars, stored lowercase); FCM registration tokens
 * are case-SENSITIVE base64url-ish with ':' separators (32..512 chars, stored
 * verbatim — folding case would corrupt them). `allowed` gates registration to
 * platforms a configured sender can actually serve.
 */
export function validateNativeToken(
  input: unknown,
  createdAt: number,
  allowed: readonly NativePushPlatform[] = NATIVE_PUSH_PLATFORMS,
): NativePushToken {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new NativePushStoreError('invalid', 'registration must be an object')
  }
  const o = input as Record<string, unknown>
  const platform = o.platform
  if (platform !== 'ios' && platform !== 'android') {
    throw new NativePushStoreError('invalid', 'registration.platform must be "ios" or "android"')
  }
  if (!allowed.includes(platform)) {
    throw new NativePushStoreError(
      'invalid',
      `this hub has no push leg for "${platform}" (serves: ${allowed.join(', ') || 'none'})`,
    )
  }
  const raw = typeof o.token === 'string' ? o.token.trim() : ''
  if (platform === 'ios') {
    if (!/^[0-9a-fA-F]{16,200}$/.test(raw)) {
      throw new NativePushStoreError('invalid', 'registration.token must be 16–200 hex chars for ios')
    }
    return { token: raw.toLowerCase(), platform, createdAt }
  }
  if (!/^[0-9A-Za-z_:.-]{32,512}$/.test(raw)) {
    throw new NativePushStoreError('invalid', 'registration.token must be 32–512 token chars for android')
  }
  return { token: raw, platform, createdAt }
}

/**
 * Stored rows re-validated on read; a hand-edited bad row is skipped. Reads
 * accept BOTH platforms regardless of which legs are currently configured —
 * a bounced config file must not destroy member registrations.
 */
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

// ─── FCM config (file-first; `<space>/fcm.json` = the service-account JSON) ─

const FCM_CONFIG_FILE = 'fcm.json'
const FCM_DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

export interface FcmConfig {
  projectId: string
  /** Service-account identity. Not a secret — it names, never authenticates. */
  clientEmail: string
  /** OAuth2 token endpoint from the JSON (Google's, unless self-hosted mocks). */
  tokenUri: string
  /** Optional `kid` for the assertion header. */
  privateKeyId?: string
}

function readConfigField(o: Record<string, unknown>, key: string, max: number): string | null {
  const v = o[key]
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s.length > 0 && s.length <= max ? s : null
}

/**
 * Read `<space>/fcm.json`. Absent ⇒ undefined (OFF). Not a service-account
 * JSON / fields missing ⇒ warn + undefined. private_key present but unusable
 * ⇒ throw (the operator opted in; silent OFF would lie).
 */
export function loadFcmConfig(
  spaceRoot: string,
  logger: ImLogger,
): { config: FcmConfig; privateKey: KeyObject } | undefined {
  const path = join(spaceRoot, FCM_CONFIG_FILE)
  if (!existsSync(path)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    logger.warn('fcm: fcm.json is not valid JSON; native push (android) stays OFF', {
      path,
      err: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    logger.warn('fcm: fcm.json must be an object; native push (android) stays OFF', { path })
    return undefined
  }
  const o = raw as Record<string, unknown>
  const projectId = readConfigField(o, 'project_id', 128)
  const clientEmail = readConfigField(o, 'client_email', 256)
  const privateKeyPem = typeof o.private_key === 'string' ? o.private_key : ''
  if (o.type !== 'service_account' || !projectId || !clientEmail || !privateKeyPem) {
    logger.warn(
      'fcm: fcm.json must be the Firebase service-account JSON (type/project_id/client_email/private_key); native push (android) stays OFF',
      { path },
    )
    return undefined
  }
  // From here on the operator HAS opted in — a broken key throws loudly.
  let privateKey: KeyObject
  try {
    privateKey = createPrivateKey(privateKeyPem)
  } catch (err) {
    throw new Error(`fcm.json private_key is not a readable private key: ${String(err)}`)
  }
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new Error(`fcm.json private_key must be an RSA key, got ${privateKey.asymmetricKeyType}`)
  }
  const privateKeyId = readConfigField(o, 'private_key_id', 128)
  const tokenUri = readConfigField(o, 'token_uri', 512) ?? FCM_DEFAULT_TOKEN_URI
  return {
    config: {
      projectId,
      clientEmail,
      tokenUri,
      ...(privateKeyId ? { privateKeyId } : {}),
    },
    privateKey,
  }
}

// ─── Google OAuth2 service-account assertion (RS256 JWT-bearer grant) ───────

export interface GoogleAssertionOpts {
  clientEmail: string
  tokenUri: string
  privateKey: KeyObject
  privateKeyId?: string
  now?: () => number
}

/** RS256 JWT `{iss, scope, aud, iat, exp:+1h}` — the JWT-bearer grant body. */
export function buildGoogleAssertion(opts: GoogleAssertionOpts): string {
  const iat = Math.floor((opts.now ?? Date.now)() / 1000)
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(opts.privateKeyId ? { kid: opts.privateKeyId } : {}) }),
    'utf8',
  ).toString('base64url')
  const claims = Buffer.from(
    JSON.stringify({ iss: opts.clientEmail, scope: FCM_SCOPE, aud: opts.tokenUri, iat, exp: iat + 3600 }),
    'utf8',
  ).toString('base64url')
  const input = `${header}.${claims}`
  const sig = createSign('RSA-SHA256').update(input).sign(opts.privateKey).toString('base64url')
  return `${input}.${sig}`
}

// ─── FCM sender (HTTP v1 API; low-info tap only) ────────────────────────────

const FCM_TIMEOUT_MS = 10_000
/** Aligned with the APNs/web legs — a day-old tap is still actionable. */
const FCM_TTL_SECONDS = 24 * 3600
const FCM_COLLAPSE_KEY = 'gotong-butler-tap'
const FCM_DEFAULT_ENDPOINT = 'https://fcm.googleapis.com'
/** Google access tokens live 3600s; re-mint on the APNs cadence. */
const ACCESS_TOKEN_REFRESH_MS = 45 * 60_000

export interface FcmSenderOptions {
  config: FcmConfig
  privateKey: KeyObject
  store: NativePushTokenStore
  logger: ImLogger
  now?: () => number
  /** Test seams: point at local HTTP mocks instead of Google. */
  endpointOverride?: string
  tokenEndpointOverride?: string
}

export class FcmSender {
  private readonly cfg: FcmConfig
  private readonly key: KeyObject
  private readonly store: NativePushTokenStore
  private readonly log: ImLogger
  private readonly now: () => number
  private readonly endpoint: string
  private readonly tokenEndpoint: string
  private tokenCache: { value: string; mintedAt: number } | null = null

  constructor(opts: FcmSenderOptions) {
    this.cfg = opts.config
    this.key = opts.privateKey
    this.store = opts.store
    this.log = opts.logger
    this.now = opts.now ?? Date.now
    this.endpoint = opts.endpointOverride ?? FCM_DEFAULT_ENDPOINT
    this.tokenEndpoint = opts.tokenEndpointOverride ?? opts.config.tokenUri
  }

  private async accessToken(): Promise<string> {
    const nowMs = this.now()
    if (this.tokenCache && nowMs - this.tokenCache.mintedAt <= ACCESS_TOKEN_REFRESH_MS) {
      return this.tokenCache.value
    }
    const assertion = buildGoogleAssertion({
      clientEmail: this.cfg.clientEmail,
      tokenUri: this.cfg.tokenUri,
      privateKey: this.key,
      ...(this.cfg.privateKeyId ? { privateKeyId: this.cfg.privateKeyId } : {}),
      now: this.now,
    })
    const res = await fetch(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`fcm oauth token endpoint answered ${res.status}`)
    const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null
    if (!body || typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new Error('fcm oauth response had no access_token')
    }
    this.tokenCache = { value: body.access_token, mintedAt: nowMs }
    return body.access_token
  }

  /** Deliver one low-info tap to every ANDROID device the member registered. */
  async push(userId: string): Promise<ButlerPushResult> {
    let tokens: NativePushToken[]
    try {
      tokens = (await this.store.list(userId)).filter((t) => t.platform === 'android')
    } catch {
      return { delivered: false, reason: 'unknown_member' }
    }
    if (tokens.length === 0) return { delivered: false, reason: 'unknown_member' }

    let delivered = 0
    for (const t of tokens) {
      try {
        const res = await this.send(t.token)
        if (res.ok) {
          delivered++
          await this.store.markDelivered(userId, t.token)
        } else if (res.unregistered) {
          // The token is dead (uninstall) or belongs to another Firebase
          // project (SENDER_ID_MISMATCH = channel mismatch) — prune.
          await this.store.remove(userId, t.token)
          this.log.info('fcm: device token no longer valid, pruned', {
            userId,
            status: res.status,
            code: res.code ?? null,
          })
        } else if (res.status === 401) {
          // OUR access token was refused — drop the cache so the next push
          // re-mints instead of replaying a bad token for 45 minutes.
          this.tokenCache = null
          this.log.warn('fcm: access token refused', { userId, code: res.code ?? null })
        } else {
          this.log.warn('fcm: push refused', { userId, status: res.status, code: res.code ?? null })
        }
      } catch (err) {
        this.log.warn('fcm: delivery attempt failed', {
          userId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return delivered > 0 ? { delivered: true } : { delivered: false, reason: 'send_failed' }
  }

  /** One POST /v1/projects/<id>/messages:send with the fixed low-info tap. */
  private async send(
    token: string,
  ): Promise<{ ok: boolean; status: number; unregistered: boolean; code?: string }> {
    const auth = await this.accessToken()
    const res = await fetch(`${this.endpoint}/v1/projects/${this.cfg.projectId}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: TAP_PAYLOAD.title, body: TAP_PAYLOAD.body },
          android: { ttl: `${FCM_TTL_SECONDS}s`, collapseKey: FCM_COLLAPSE_KEY },
        },
      }),
      signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
    })
    if (res.ok) return { ok: true, status: res.status, unregistered: false }
    let code: string | undefined
    try {
      const parsed = (await res.json()) as { error?: { status?: unknown; details?: unknown } }
      const err = parsed?.error
      if (err && typeof err === 'object') {
        const status = (err as Record<string, unknown>).status
        if (typeof status === 'string') code = status
        const details = (err as Record<string, unknown>).details
        for (const d of Array.isArray(details) ? details : []) {
          const ec = (d as Record<string, unknown> | null)?.errorCode
          if (typeof ec === 'string') code = ec
        }
      }
    } catch {
      // non-JSON body — status alone is enough
    }
    const unregistered = res.status === 404 || code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH'
    return { ok: false, status: res.status, unregistered, ...(code ? { code } : {}) }
  }
}

// ─── Tap-leg composition ────────────────────────────────────────────────────

type TapLeg = (userId: string) => Promise<ButlerPushResult>

/**
 * Merge two tap legs into ONE. Both run in parallel — more devices, not a
 * precedence chain — and ≥1 delivery counts. Reasons merge honestly: any
 * attempted-but-failed leg yields `send_failed` (the outbox keeps retrying);
 * `unknown_member` only when NO device is registered anywhere. Associative, so
 * the same combinator merges apns+fcm into the native leg AND native+web into
 * the fallback the IM bridge folds on `unknown_member`.
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

// ─── Assembly (files → service), mirrors buildWebPushService ────────────────

export interface NativePushService {
  /** Duck for the web layer's MeNativePushSurface. */
  surface: {
    count(userId: string): Promise<number>
    add(userId: string, input: unknown): Promise<{ count: number; replaced: boolean }>
    remove(userId: string, token: string): Promise<{ removed: boolean }>
    /** Which platforms this hub can actually serve — the shell gates its button on this. */
    platforms(): NativePushPlatform[]
  }
  /** The native half of the tap leg — apns+fcm already composed. */
  fallback: TapLeg
  /** Startup disclosures (one per leg) — ids and endpoints, NEVER key bytes. */
  disclosures: string[]
}

export function buildNativePushService(
  spaceRoot: string,
  logger: ImLogger,
  opts: {
    now?: () => number
    apnsOriginOverride?: string
    fcmEndpointOverride?: string
    fcmTokenEndpointOverride?: string
  } = {},
): NativePushService | undefined {
  const apns = loadApnsConfig(spaceRoot, logger)
  const fcm = loadFcmConfig(spaceRoot, logger)
  if (!apns && !fcm) return undefined
  const platforms: NativePushPlatform[] = [
    ...(apns ? (['ios'] as const) : []),
    ...(fcm ? (['android'] as const) : []),
  ]
  const store = new NativePushTokenStore({
    dir: join(spaceRoot, 'butler', 'push-native'),
    logger,
    allowedPlatforms: platforms,
    ...(opts.now ? { now: opts.now } : {}),
  })
  const apnsSender = apns
    ? new ApnsSender({
        config: apns.config,
        privateKey: apns.privateKey,
        store,
        logger,
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.apnsOriginOverride ? { originOverride: opts.apnsOriginOverride } : {}),
      })
    : undefined
  const fcmSender = fcm
    ? new FcmSender({
        config: fcm.config,
        privateKey: fcm.privateKey,
        store,
        logger,
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.fcmEndpointOverride ? { endpointOverride: opts.fcmEndpointOverride } : {}),
        ...(opts.fcmTokenEndpointOverride ? { tokenEndpointOverride: opts.fcmTokenEndpointOverride } : {}),
      })
    : undefined
  const fallback = composeTapFallback(
    apnsSender ? (u: string) => apnsSender.push(u) : undefined,
    fcmSender ? (u: string) => fcmSender.push(u) : undefined,
  )!
  return {
    surface: {
      count: async (userId) => (await store.list(userId)).length,
      add: (userId, input) => store.add(userId, input),
      remove: (userId, token) => store.remove(userId, token),
      platforms: () => [...platforms],
    },
    fallback,
    disclosures: [
      ...(apns
        ? [
            `apns push enabled: topic=${apns.config.bundleId} env=${apns.config.environment} keyId=${apns.config.keyId} teamId=${apns.config.teamId}`,
          ]
        : []),
      ...(fcm ? [`fcm push enabled: project=${fcm.config.projectId} clientEmail=${fcm.config.clientEmail}`] : []),
    ],
  }
}
