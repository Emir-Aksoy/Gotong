/**
 * web-push-sender.ts — PUSH-M3: the Web Push delivery leg + env assembly.
 *
 * Sends the low-info TAP: a fixed, content-free notification payload
 * (「有新消息,点开查看」). The member's actual message text never rides a
 * push — it was already recorded into the SESS session window by
 * `deliverToMember` before delivery, so tapping the notification and opening
 * /me shows it. The discipline is structural: `push(userId)` takes no text
 * parameter, so no future call site can leak content into a notification.
 *
 * Payloads are RFC 8291-encrypted per subscription (the push service relays
 * bytes it cannot read); requests carry RFC 8292 VAPID auth. Delivery is
 * multi-device: every stored subscription is tried, ≥1 acceptance counts as
 * delivered. 404/410 from the push service = that browser dropped the
 * subscription → pruned from the store (self-heal); other failures warn and
 * count toward `send_failed` so the outbox keeps retrying.
 *
 * `buildWebPushService` is the ONE assembly point (mirrors butlerVoiceFromEnv):
 * `GOTONG_WEBPUSH=<mailto:|https:>` is both the opt-in switch and the RFC 8292
 * `sub` claim. Unset ⇒ undefined ⇒ byte-identical hub. A malformed value warns
 * once and stays OFF (fail-closed). A corrupt key FILE, however, throws at
 * boot — same posture as the agent-card signing key: silently re-keying would
 * strand every browser subscription, silently disabling would silently stop
 * notifications; a loud boot failure gets fixed today.
 */

import { join } from 'node:path'

import type { ButlerPushResult } from './butler-reachable.js'
import type { ImLogger } from './im-bridge.js'
import {
  buildVapidAuthorization,
  encryptWebPushPayload,
  loadOrCreateWebPushKey,
  pushAudienceOf,
  type WebPushKey,
} from './web-push-protocol.js'
import { WebPushSubscriptionStore } from './web-push-store.js'

const PUSH_TIMEOUT_MS = 10_000
/** Aligned with the outbox message TTL — a day-old tap is still actionable
 *  for a web-only member (the message itself is waiting in /me). */
const PUSH_TTL_SECONDS = 24 * 3600
/**
 * Fixed v1 tap copy (bilingual, content-free). The push service cannot read
 * it (RFC 8291), but the LOCK SCREEN can — same shoulder-surfing surface the
 * IMA web-only discipline protects, hence no member content ever.
 * Exported for the SHELL-M6 APNs leg — one copy, two legs (a second copy
 * would drift, the i18n lesson).
 */
export const TAP_PAYLOAD = { title: '阿同 · Gotong', body: '有新消息,点开查看 · New message' }

export interface WebPushSenderOptions {
  key: WebPushKey
  /** RFC 8292 `sub` claim — the GOTONG_WEBPUSH knob value. */
  subject: string
  store: WebPushSubscriptionStore
  logger: ImLogger
  /** Test seam; production uses global fetch. */
  fetchImpl?: typeof fetch
  now?: () => number
}

export class WebPushSender {
  private readonly key: WebPushKey
  private readonly subject: string
  private readonly store: WebPushSubscriptionStore
  private readonly log: ImLogger
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(opts: WebPushSenderOptions) {
    this.key = opts.key
    this.subject = opts.subject
    this.store = opts.store
    this.log = opts.logger
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.now = opts.now ?? Date.now
  }

  /** Deliver one low-info tap to every device the member subscribed. */
  async push(userId: string): Promise<ButlerPushResult> {
    let subs
    try {
      subs = await this.store.list(userId)
    } catch {
      return { delivered: false, reason: 'unknown_member' }
    }
    if (subs.length === 0) return { delivered: false, reason: 'unknown_member' }

    const payload = Buffer.from(JSON.stringify(TAP_PAYLOAD), 'utf8')
    // One VAPID JWT per push-service origin, shared across same-origin devices.
    const authByAud = new Map<string, string>()
    let delivered = 0
    for (const sub of subs) {
      try {
        const aud = pushAudienceOf(sub.endpoint)
        let auth = authByAud.get(aud)
        if (!auth) {
          auth = buildVapidAuthorization({
            audience: aud,
            subject: this.subject,
            privateKey: this.key.privateKey,
            applicationServerKey: this.key.applicationServerKey,
            now: this.now,
          })
          authByAud.set(aud, auth)
        }
        const body = encryptWebPushPayload(
          Buffer.from(sub.keys.p256dh, 'base64url'),
          Buffer.from(sub.keys.auth, 'base64url'),
          payload,
        )
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), PUSH_TIMEOUT_MS)
        let res: Response
        try {
          res = await this.fetchImpl(sub.endpoint, {
            method: 'POST',
            headers: {
              authorization: auth,
              'content-encoding': 'aes128gcm',
              'content-type': 'application/octet-stream',
              ttl: String(PUSH_TTL_SECONDS),
              urgency: 'normal',
              // Collapse queued taps at the push service: a member offline for
              // a day gets ONE wake-up, not a backlog of identical ones.
              topic: 'gotong-butler-tap',
            },
            body: new Uint8Array(body),
            signal: abort.signal,
          })
        } finally {
          clearTimeout(timer)
        }
        if (res.ok) {
          delivered++
          await this.store.markDelivered(userId, sub.endpoint)
        } else if (res.status === 404 || res.status === 410) {
          // The browser dropped this subscription — prune, self-heal.
          await this.store.remove(userId, sub.endpoint)
          this.log.info('web-push: subscription expired at the push service, pruned', {
            userId,
            status: res.status,
          })
        } else {
          this.log.warn('web-push: push service refused', { userId, status: res.status })
        }
      } catch (err) {
        this.log.warn('web-push: delivery attempt failed', {
          userId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return delivered > 0 ? { delivered: true } : { delivered: false, reason: 'send_failed' }
  }
}

// ─── Assembly (knob → service), mirrors butlerVoiceFromEnv ──────────────────

export interface WebPushService {
  /** Duck for the web layer's MeWebPushSurface. */
  surface: {
    publicKey(): string
    count(userId: string): Promise<number>
    add(userId: string, input: unknown): Promise<{ count: number; replaced: boolean }>
    remove(userId: string, endpoint: string): Promise<{ removed: boolean }>
  }
  /** The B1 fallback leg handed to the IM bridge wiring (low-info by shape). */
  fallback: (userId: string) => Promise<ButlerPushResult>
  /** Startup disclosure — subject + public key, NEVER the private key. */
  disclosure: string
}

export function buildWebPushService(
  spaceRoot: string,
  logger: ImLogger,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): WebPushService | undefined {
  const subject = env.GOTONG_WEBPUSH?.trim()
  if (!subject) return undefined
  if (!subject.startsWith('mailto:') && !subject.startsWith('https://')) {
    logger.warn(
      'GOTONG_WEBPUSH must be a mailto:/https: contact (it becomes the RFC 8292 sub claim); web push stays OFF',
      { value: subject },
    )
    return undefined
  }
  const key = loadOrCreateWebPushKey(join(spaceRoot, 'webpush-vapid.key'))
  const store = new WebPushSubscriptionStore({ dir: join(spaceRoot, 'butler', 'push'), logger })
  const sender = new WebPushSender({
    key,
    subject,
    store,
    logger,
    ...(fetchImpl ? { fetchImpl } : {}),
  })
  return {
    surface: {
      publicKey: () => key.applicationServerKey,
      count: async (userId) => (await store.list(userId)).length,
      add: (userId, input) => store.add(userId, input),
      remove: (userId, endpoint) => store.remove(userId, endpoint),
    },
    fallback: (userId) => sender.push(userId),
    disclosure: `web push enabled (RFC 8291/8292): sub=${subject} key=${key.applicationServerKey}`,
  }
}
