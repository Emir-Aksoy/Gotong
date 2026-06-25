/**
 * peer-summary-alert-delivery — v5 Stream F day-3: the pure edge-trigger differ
 * + multi-channel dispatcher for control-plane alerts.
 *
 * Stream F evaluated rules point-in-time and could only SHOW live breaches in
 * the admin UI. Day-3 delivered them to `'webhook'` channels; the multi-channel
 * pass adds `'im'` and `'email'`. This module is the pure middle: given the
 * CURRENT breaches and the CURRENTLY-OPEN firings, it computes which breaches
 * are NEW (open a firing + notify once) and which open firings have CLEARED
 * (resolve + optionally notify), then POSTs a counts-only payload to each
 * enabled channel.
 *
 * IM delivery is a STATELESS platform-send: rather than standing up a stateful
 * ImBridge connection, `buildDeliveryRequest` re-encodes each platform's minimal
 * "post a text line" contract (url + body shape) and reuses the same injectable
 * fetch. Incoming-webhook platforms (slack/discord/lark) carry their token in
 * the url; telegram is a bot-API call whose token (read from env, never
 * persisted) goes in the path and whose chat id is `target`. Email POSTs a
 * generic `{to,subject,text}` JSON to an HTTP email API.
 *
 * Everything here is pure or injectable: `diffAlertFirings` is a deterministic
 * set difference, `buildDeliveryRequest`/`renderAlertText` are pure, and
 * `deliverToChannel` takes an injectable `fetchImpl` (the windmill-participant
 * pattern) so the whole path unit-tests without a socket. No identity I/O lives
 * here — M4 wires this to the stores. Best-effort by construction: a delivery
 * failure resolves to a result, never a throw, so one dead channel can't break
 * the sweep or block the next firing.
 *
 * Counts-only / no-leak is STRUCTURAL: every channel's body is built only from
 * the `AlertWebhookPayload` (itself derived only from a `PeerSummaryAlertFiring`
 * — numbers, a comparator, a metric KEY, a source id, and the rule's own
 * label), never an agent id, a task id, a model name, or any underlying peer
 * row. The im/email TEXT is rendered from those same counts-only fields.
 */

import type {
  PeerSummaryAlertChannel,
  PeerSummaryAlertFiring,
} from '@aipehub/identity'

import type { PeerSummaryAlertBreach } from './peer-summary-alerts.js'

// ---------------------------------------------------------------------------
// edge-trigger differ
// ---------------------------------------------------------------------------

/** Correlation key for a (rule, source) pair. NUL can't appear in either part. */
function firingKey(ruleId: string, source: string): string {
  return `${ruleId}\u0000${source}`
}

export interface AlertFiringDiff {
  /** Current breaches with NO open firing yet → open a firing + notify once. */
  toOpen: PeerSummaryAlertBreach[]
  /** Open firings whose (ruleId, source) is no longer breaching → resolve. */
  toResolve: PeerSummaryAlertFiring[]
}

/**
 * Edge-trigger: turn the point-in-time breach set into state TRANSITIONS
 * against the currently-open firings. A breach already covered by an open
 * firing is stable (neither list) — that is what makes the dispatcher notify
 * ONCE per breach rather than every evaluation. The evaluator yields at most
 * one breach per (rule, source), so `toOpen` never contains a duplicate that
 * would collide on the open-firing unique index.
 */
export function diffAlertFirings(
  breaches: PeerSummaryAlertBreach[],
  openFirings: PeerSummaryAlertFiring[],
): AlertFiringDiff {
  const openByKey = new Map<string, PeerSummaryAlertFiring>()
  for (const f of openFirings) openByKey.set(firingKey(f.ruleId, f.source), f)

  const breachKeys = new Set<string>()
  const toOpen: PeerSummaryAlertBreach[] = []
  for (const b of breaches) {
    const k = firingKey(b.ruleId, b.source)
    breachKeys.add(k)
    if (!openByKey.has(k)) toOpen.push(b)
  }

  const toResolve: PeerSummaryAlertFiring[] = []
  for (const f of openFirings) {
    if (!breachKeys.has(firingKey(f.ruleId, f.source))) toResolve.push(f)
  }

  return { toOpen, toResolve }
}

// ---------------------------------------------------------------------------
// webhook payload (counts-only)
// ---------------------------------------------------------------------------

export type AlertDeliveryEvent = 'opened' | 'resolved'

/** The wire shape a webhook receives. Every field is a count / id / threshold. */
export interface AlertWebhookPayload {
  /** Schema tag so a receiver can branch on version. */
  type: 'aipehub.peer_summary_alert/v1'
  event: AlertDeliveryEvent
  firingId: number
  ruleId: string
  /** `'local'` or a peer id — never the `'*'` wildcard. */
  source: string
  /** A PeerSummary metric KEY (e.g. `health.suspendedTasks`), not data. */
  metric: string
  comparator: string
  threshold: number
  value: number
  label: string | null
  openedAt: number
  resolvedAt: number | null
}

/** Build the counts-only payload from a firing. No data beyond the firing. */
export function renderWebhookPayload(
  firing: PeerSummaryAlertFiring,
  event: AlertDeliveryEvent,
): AlertWebhookPayload {
  return {
    type: 'aipehub.peer_summary_alert/v1',
    event,
    firingId: firing.id,
    ruleId: firing.ruleId,
    source: firing.source,
    metric: firing.metric,
    comparator: firing.comparator,
    threshold: firing.threshold,
    value: firing.value,
    label: firing.label,
    openedAt: firing.openedAt,
    resolvedAt: firing.resolvedAt,
  }
}

// ---------------------------------------------------------------------------
// counts-only text + per-kind/platform request builder (pure)
// ---------------------------------------------------------------------------

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' }

/**
 * A one-line human-readable alert for im/email destinations. Built ONLY from the
 * counts-only payload (metric KEY, comparator, threshold, observed value, source
 * id, and the rule's own label) — never any underlying peer row.
 */
export function renderAlertText(payload: AlertWebhookPayload): string {
  const verb = payload.event === 'opened' ? 'firing' : 'resolved'
  const who = payload.label ? `${payload.label} (${payload.ruleId})` : payload.ruleId
  return (
    `[aipehub] alert ${verb}: ${who} — ` +
    `${payload.metric} ${payload.comparator} ${payload.threshold} ` +
    `(observed ${payload.value}) on source ${payload.source}`
  )
}

/** The HTTP request a channel maps to — kind/platform decides url + body shape. */
export interface DeliveryRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/**
 * Pure: turn a channel + payload (+ the resolved secret, if any) into the HTTP
 * request to POST. Returns null for an unsupported or under-configured channel
 * (unknown platform, telegram/email without a target) so the caller fails
 * best-effort rather than sending garbage. Counts-only by construction — both
 * the JSON body and the rendered text derive solely from the payload.
 */
export function buildDeliveryRequest(
  channel: PeerSummaryAlertChannel,
  payload: AlertWebhookPayload,
  secret: string | null,
): DeliveryRequest | null {
  switch (channel.kind) {
    case 'webhook': {
      const headers = { ...JSON_HEADERS }
      if (secret) headers.authorization = secret
      return { url: channel.url, headers, body: JSON.stringify(payload) }
    }
    case 'im':
      return buildImRequest(channel, renderAlertText(payload), secret)
    case 'email':
      return buildEmailRequest(channel, payload, secret)
    default:
      return null
  }
}

/**
 * Stateless platform-send: re-encode each platform's minimal "post a text"
 * contract over the injectable fetch — NO stateful bridge connection. slack/
 * discord/lark are incoming-webhook posts (the token lives in `url`); telegram
 * is a bot-API call whose token (secret, from env) goes in the path and whose
 * chat id is `target`.
 *
 * SECURITY: the bot token / webhook secret rides in the request URL — this is
 * inherent to both the Telegram Bot API path scheme (`/bot<token>/sendMessage`)
 * and incoming-webhook URLs, not a choice we can avoid. It is read from env
 * per-send and never persisted (the channel row stores only the env-var *name*,
 * never the value), but a URL-logging forward proxy sitting between this host
 * and the platform would capture it. Don't route alert delivery through such a
 * proxy, or scrub the path in its access logs if you must.
 */
function buildImRequest(
  channel: PeerSummaryAlertChannel,
  text: string,
  secret: string | null,
): DeliveryRequest | null {
  switch (channel.platform) {
    case 'telegram': {
      if (!channel.target) return null // bot-API needs a chat id
      const base = channel.url.replace(/\/+$/, '')
      return {
        url: `${base}/bot${secret ?? ''}/sendMessage`,
        headers: { ...JSON_HEADERS },
        body: JSON.stringify({ chat_id: channel.target, text }),
      }
    }
    case 'slack':
      return { url: channel.url, headers: { ...JSON_HEADERS }, body: JSON.stringify({ text }) }
    case 'discord':
      return { url: channel.url, headers: { ...JSON_HEADERS }, body: JSON.stringify({ content: text }) }
    case 'lark':
      return {
        url: channel.url,
        headers: { ...JSON_HEADERS },
        body: JSON.stringify({ msg_type: 'text', content: { text } }),
      }
    default:
      return null
  }
}

/**
 * Email via a generic HTTP email API: POST `{to,subject,text}` to the operator's
 * endpoint (`url`), recipient in `target`, an optional API key via `headerEnv`.
 * Point it at a provider's send endpoint or a thin shim.
 */
function buildEmailRequest(
  channel: PeerSummaryAlertChannel,
  payload: AlertWebhookPayload,
  secret: string | null,
): DeliveryRequest | null {
  if (!channel.target) return null // recipient required
  const headers = { ...JSON_HEADERS }
  if (secret) headers.authorization = secret
  const subject = `[aipehub] alert ${payload.event}: ${payload.metric}`
  return {
    url: channel.url,
    headers,
    body: JSON.stringify({ to: channel.target, subject, text: renderAlertText(payload) }),
  }
}

// ---------------------------------------------------------------------------
// delivery (injectable fetch, best-effort)
// ---------------------------------------------------------------------------

/** Injectable fetch — mirrors windmill-participant so tests pass a fake. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number }>

/**
 * Best-effort retry with exponential backoff. `maxAttempts:1` (the default) is
 * a single shot — existing behavior. Only a FAILED attempt (transport error,
 * timeout, non-2xx) is retried; an under-configured channel returns immediately.
 */
export interface RetryOptions {
  /** Total attempts including the first. Default 1 (no retry). */
  maxAttempts?: number
  /** First backoff in ms; doubles each retry. Default 500. */
  baseDelayMs?: number
  /** Cap on a single backoff. Default 10s. */
  maxDelayMs?: number
  /** Injectable sleep so tests don't wait real time. */
  sleepImpl?: (ms: number) => Promise<void>
}

/**
 * A short in-memory window that suppresses an IDENTICAL (channel, firing, event)
 * delivery repeated within `windowMs`. The PRIMARY once-guarantee is the firing
 * lifecycle (unique open-firing index + edge-trigger differ); this is a SECONDARY
 * net against a double-send from overlapping manual+sweep invocations. Per
 * process, not persisted.
 */
export interface DeliveryDeduper {
  recentlySent(key: string, nowMs: number): boolean
  markSent(key: string, nowMs: number): void
}

/** Correlation key for a single notification. NUL can't appear in id/event. */
export function deliveryDedupKey(channelId: string, firingId: number, event: AlertDeliveryEvent): string {
  return `${channelId}\u0000${firingId}\u0000${event}`
}

/** In-memory deduper. `windowMs<=0` disables it (every send passes). */
export function createDeliveryDeduper(
  windowMs: number,
): DeliveryDeduper & { prune(nowMs: number): void; size(): number } {
  const seen = new Map<string, number>()
  return {
    recentlySent(key, nowMs) {
      const t = seen.get(key)
      return t !== undefined && nowMs - t < windowMs
    },
    markSent(key, nowMs) {
      seen.set(key, nowMs)
    },
    prune(nowMs) {
      for (const [k, t] of seen) if (nowMs - t >= windowMs) seen.delete(k)
    },
    size() {
      return seen.size
    },
  }
}

export interface DeliverOptions {
  /** Defaults to the global `fetch`. */
  fetchImpl?: FetchLike
  /** Abandon a hung POST after this many ms (default 10s). Best-effort. */
  timeoutMs?: number
  /** Env source for `headerEnv` lookups; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Best-effort retry/backoff (default: single attempt). */
  retry?: RetryOptions
  /** Dedup window (used by `deliverToEnabledChannels` only). */
  deduper?: DeliveryDeduper
  /** Clock for the deduper; defaults to `Date.now()`. */
  nowMs?: number
}

export interface AlertDeliveryResult {
  channelId: string
  ok: boolean
  status?: number
  error?: string
  /** True when the dedup window suppressed this send (no POST was made). */
  skipped?: boolean
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_BASE_MS = 500
const DEFAULT_RETRY_MAX_DELAY_MS = 10_000

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Exponential backoff for the delay AFTER a failed `attempt` (1-indexed). */
function backoffDelay(baseMs: number, maxMs: number, attempt: number): number {
  return Math.min(maxMs, baseMs * 2 ** (attempt - 1))
}

/** Stop waiting on `p` after `ms` (the underlying request may still finish). */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`alert delivery timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Deliver one payload to one channel. NEVER throws — a transport error, a
 * non-2xx status, a timeout, or an under-configured channel all resolve to a
 * result with `ok:false`. An optional `headerEnv` names an env var whose value
 * is read HERE (never persisted) and becomes the `Authorization` header
 * (webhook/email) or the bot token in a telegram path; an unset var still POSTs.
 */
export async function deliverToChannel(
  channel: PeerSummaryAlertChannel,
  payload: AlertWebhookPayload,
  opts: DeliverOptions = {},
): Promise<AlertDeliveryResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis as { fetch: FetchLike }).fetch
  const env = opts.env ?? process.env
  const secret = channel.headerEnv ? (env[channel.headerEnv] ?? null) : null

  const req = buildDeliveryRequest(channel, payload, secret)
  if (!req) {
    return {
      channelId: channel.id,
      ok: false,
      error: `cannot build delivery for channel ${channel.id} (kind=${channel.kind} platform=${channel.platform ?? '-'}); check target/recipient`,
    }
  }

  const maxAttempts = Math.max(1, opts.retry?.maxAttempts ?? 1)
  const baseDelayMs = opts.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_MS
  const maxDelayMs = opts.retry?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS
  const sleepImpl = opts.retry?.sleepImpl ?? defaultSleep
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let last: AlertDeliveryResult = { channelId: channel.id, ok: false }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await attemptDelivery(channel.id, fetchImpl, req, timeoutMs)
    if (last.ok) return last
    if (attempt < maxAttempts) await sleepImpl(backoffDelay(baseDelayMs, maxDelayMs, attempt))
  }
  return last
}

/** One POST attempt → a result. NEVER throws (transport/timeout → ok:false). */
async function attemptDelivery(
  channelId: string,
  fetchImpl: FetchLike,
  req: DeliveryRequest,
  timeoutMs: number,
): Promise<AlertDeliveryResult> {
  try {
    const res = await withTimeout(
      fetchImpl(req.url, { method: 'POST', headers: req.headers, body: req.body }),
      timeoutMs,
    )
    return { channelId, ok: res.ok, status: res.status }
  } catch (err) {
    return { channelId, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Deliver `payload` to every ENABLED channel concurrently. Disabled channels
 * are skipped (not an error). Best-effort: returns one result per enabled
 * channel; a single failure never rejects the batch.
 *
 * When a `deduper` is supplied, an identical (channel, firingId, event) already
 * SENT within the window is suppressed (returns `skipped:true`, no POST). Only a
 * successful send is recorded, so a failed one stays free to retry on a later
 * pass.
 */
export async function deliverToEnabledChannels(
  channels: PeerSummaryAlertChannel[],
  payload: AlertWebhookPayload,
  opts: DeliverOptions = {},
): Promise<AlertDeliveryResult[]> {
  const enabled = channels.filter((c) => c.enabled)
  const deduper = opts.deduper
  const nowMs = opts.nowMs ?? Date.now()
  return Promise.all(
    enabled.map(async (c) => {
      const key = deliveryDedupKey(c.id, payload.firingId, payload.event)
      if (deduper?.recentlySent(key, nowMs)) {
        return { channelId: c.id, ok: true, skipped: true }
      }
      const res = await deliverToChannel(c, payload, opts)
      if (deduper && res.ok && !res.skipped) deduper.markSent(key, nowMs)
      return res
    }),
  )
}
