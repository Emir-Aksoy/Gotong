/**
 * v5 Stream F day-3 + multi-channel — pure edge-trigger differ + multi-channel
 * dispatcher (peer-summary-alert-delivery).
 *
 * Coverage:
 *   - diffAlertFirings: open new breaches, resolve cleared firings, leave stable
 *   - renderWebhookPayload: shape + counts-only (no leak surface) + opened/resolved
 *   - renderAlertText / buildDeliveryRequest: per-kind/platform pure builders
 *   - deliverToChannel: POSTs via injected fetch; headerEnv → Authorization;
 *     missing env var still POSTs; transport error / non-2xx never throw
 *   - deliverToChannel retry/backoff: retries a failed attempt with injected
 *     sleep; default single-shot; under-configured channel never retries
 *   - createDeliveryDeduper / deliveryDedupKey: in-memory window suppression
 *   - deliverToEnabledChannels: disabled channels skipped; dedup window skips
 *     an identical (channel, firing, event); a failed send stays free to retry
 */

import type { PeerSummaryAlertChannel, PeerSummaryAlertFiring } from '@gotong/identity'
import { describe, expect, it } from 'vitest'

import type { PeerSummaryAlertBreach } from '../src/peer-summary-alerts.js'
import {
  buildDeliveryRequest,
  createDeliveryDeduper,
  deliverToChannel,
  deliverToEnabledChannels,
  deliveryDedupKey,
  diffAlertFirings,
  renderAlertText,
  renderWebhookPayload,
  type FetchLike,
} from '../src/peer-summary-alert-delivery.js'

function breach(over: Partial<PeerSummaryAlertBreach> = {}): PeerSummaryAlertBreach {
  return {
    ruleId: 'asr_1',
    source: 'local',
    metric: 'health.suspendedTasks',
    comparator: 'gt',
    threshold: 5,
    value: 9,
    label: null,
    ...over,
  }
}

function firing(over: Partial<PeerSummaryAlertFiring> = {}): PeerSummaryAlertFiring {
  return {
    id: 1,
    ruleId: 'asr_1',
    source: 'local',
    metric: 'health.suspendedTasks',
    comparator: 'gt',
    threshold: 5,
    value: 9,
    label: null,
    openedAt: 1000,
    resolvedAt: null,
    ...over,
  }
}

function channel(over: Partial<PeerSummaryAlertChannel> = {}): PeerSummaryAlertChannel {
  return {
    id: 'psac_1',
    kind: 'webhook',
    url: 'https://hooks.example.com/x',
    headerEnv: null,
    platform: null,
    target: null,
    enabled: true,
    label: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

/** A fake fetch that records every call and returns a canned response. */
function fakeFetch(resp: { ok: boolean; status: number } = { ok: true, status: 200 }) {
  const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = []
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return resp
  }
  return { fn, calls }
}

/**
 * A fake fetch that walks a programmed sequence of outcomes (a response or a
 * thrown Error) — drives retry tests deterministically. After the sequence is
 * exhausted it repeats the last outcome.
 */
function sequenceFetch(results: Array<{ ok: boolean; status: number } | Error>) {
  const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = []
  let i = 0
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const r = results[Math.min(i, results.length - 1)]
    i++
    if (r instanceof Error) throw r
    return r
  }
  return { fn, calls }
}

/** Injectable sleep that records the requested delays instead of waiting. */
function recordSleeps() {
  const delays: number[] = []
  const sleepImpl = async (ms: number): Promise<void> => {
    delays.push(ms)
  }
  return { delays, sleepImpl }
}

describe('diffAlertFirings (edge-trigger)', () => {
  it('opens new breaches that have no open firing', () => {
    const d = diffAlertFirings([breach({ source: 'a' }), breach({ source: 'b' })], [])
    expect(d.toOpen.map((b) => b.source)).toEqual(['a', 'b'])
    expect(d.toResolve).toHaveLength(0)
  })

  it('leaves a breach that already has an open firing (stable — notify once)', () => {
    const d = diffAlertFirings([breach({ source: 'a' })], [firing({ source: 'a' })])
    expect(d.toOpen).toHaveLength(0)
    expect(d.toResolve).toHaveLength(0)
  })

  it('resolves an open firing whose breach has cleared', () => {
    const d = diffAlertFirings([], [firing({ id: 7, source: 'a' })])
    expect(d.toOpen).toHaveLength(0)
    expect(d.toResolve.map((f) => f.id)).toEqual([7])
  })

  it('handles a mixed round (one stable, one cleared, one new)', () => {
    const breaches = [breach({ ruleId: 'r1', source: 'a' }), breach({ ruleId: 'r3', source: 'c' })]
    const open = [
      firing({ id: 1, ruleId: 'r1', source: 'a' }), // still breaching → stable
      firing({ id: 2, ruleId: 'r2', source: 'b' }), // no longer breaching → resolve
    ]
    const d = diffAlertFirings(breaches, open)
    expect(d.toOpen.map((b) => `${b.ruleId}/${b.source}`)).toEqual(['r3/c'])
    expect(d.toResolve.map((f) => f.id)).toEqual([2])
  })

  it('keys by BOTH ruleId and source (same source, different rule are distinct)', () => {
    const d = diffAlertFirings([breach({ ruleId: 'r1', source: 'a' })], [firing({ ruleId: 'r2', source: 'a' })])
    expect(d.toOpen.map((b) => b.ruleId)).toEqual(['r1']) // r1/a is new
    expect(d.toResolve.map((f) => f.ruleId)).toEqual(['r2']) // r2/a cleared
  })
})

describe('renderWebhookPayload (counts-only)', () => {
  it('builds the opened payload from a firing', () => {
    const p = renderWebhookPayload(firing({ id: 42, label: 'too many parked' }), 'opened')
    expect(p).toEqual({
      type: 'gotong.peer_summary_alert/v1',
      event: 'opened',
      firingId: 42,
      ruleId: 'asr_1',
      source: 'local',
      metric: 'health.suspendedTasks',
      comparator: 'gt',
      threshold: 5,
      value: 9,
      label: 'too many parked',
      openedAt: 1000,
      resolvedAt: null,
    })
  })

  it('passes resolvedAt for a resolved event', () => {
    const p = renderWebhookPayload(firing({ resolvedAt: 2000 }), 'resolved')
    expect(p.event).toBe('resolved')
    expect(p.resolvedAt).toBe(2000)
  })

  it('exposes no leak surface — only counts / ids / threshold / own label', () => {
    const p = renderWebhookPayload(firing(), 'opened')
    expect(Object.keys(p).sort()).toEqual(
      [
        'comparator',
        'event',
        'firingId',
        'label',
        'metric',
        'openedAt',
        'resolvedAt',
        'ruleId',
        'source',
        'threshold',
        'type',
        'value',
      ].sort(),
    )
  })
})

describe('deliverToChannel (injectable fetch, best-effort)', () => {
  const payload = renderWebhookPayload(firing(), 'opened')

  it('POSTs the JSON payload and reports ok + status', async () => {
    const { fn, calls } = fakeFetch({ ok: true, status: 200 })
    const res = await deliverToChannel(channel(), payload, { fetchImpl: fn })
    expect(res).toEqual({ channelId: 'psac_1', ok: true, status: 200 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://hooks.example.com/x')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.headers?.['content-type']).toBe('application/json')
    expect(JSON.parse(calls[0].init!.body!)).toEqual(payload)
  })

  it('injects Authorization from headerEnv when the env var is set', async () => {
    const { fn, calls } = fakeFetch()
    await deliverToChannel(channel({ headerEnv: 'MY_TOKEN' }), payload, {
      fetchImpl: fn,
      env: { MY_TOKEN: 'Bearer sek' },
    })
    expect(calls[0].init?.headers?.authorization).toBe('Bearer sek')
  })

  it('still POSTs when headerEnv is set but the env var is missing (no auth header)', async () => {
    const { fn, calls } = fakeFetch()
    const res = await deliverToChannel(channel({ headerEnv: 'MISSING' }), payload, { fetchImpl: fn, env: {} })
    expect(res.ok).toBe(true)
    expect(calls[0].init?.headers?.authorization).toBeUndefined()
  })

  it('never throws on a transport error — resolves ok:false with the message', async () => {
    const fn: FetchLike = async () => {
      throw new Error('ECONNREFUSED')
    }
    const res = await deliverToChannel(channel(), payload, { fetchImpl: fn })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('ECONNREFUSED')
  })

  it('reports a non-2xx response as ok:false with the status', async () => {
    const { fn } = fakeFetch({ ok: false, status: 500 })
    const res = await deliverToChannel(channel(), payload, { fetchImpl: fn })
    expect(res).toEqual({ channelId: 'psac_1', ok: false, status: 500 })
  })

  it('telegram reads the bot token from env into the path and POSTs {chat_id,text}', async () => {
    const { fn, calls } = fakeFetch()
    const res = await deliverToChannel(
      channel({ kind: 'im', platform: 'telegram', url: 'https://api.telegram.org', target: '-100', headerEnv: 'TG' }),
      payload,
      { fetchImpl: fn, env: { TG: '12345:secret' } },
    )
    expect(res.ok).toBe(true)
    expect(calls[0].url).toBe('https://api.telegram.org/bot12345:secret/sendMessage')
    expect(JSON.parse(calls[0].init!.body!).chat_id).toBe('-100')
    // the token is path-only, never an Authorization header
    expect(calls[0].init?.headers?.authorization).toBeUndefined()
  })

  it('email reads the API key from env into Authorization and POSTs to the endpoint', async () => {
    const { fn, calls } = fakeFetch()
    await deliverToChannel(
      channel({ kind: 'email', url: 'https://api.mailer.example/send', target: 'ops@example.com', headerEnv: 'MAIL' }),
      payload,
      { fetchImpl: fn, env: { MAIL: 'Bearer key' } },
    )
    expect(calls[0].url).toBe('https://api.mailer.example/send')
    expect(calls[0].init?.headers?.authorization).toBe('Bearer key')
    expect(JSON.parse(calls[0].init!.body!).to).toBe('ops@example.com')
  })

  it('an under-configured channel never POSTs — resolves ok:false (best-effort)', async () => {
    const { fn, calls } = fakeFetch()
    const res = await deliverToChannel(
      channel({ kind: 'email', url: 'https://api.mailer.example/send', target: null }),
      payload,
      { fetchImpl: fn },
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('cannot build delivery')
    expect(calls).toHaveLength(0)
  })
})

describe('deliverToChannel retry/backoff (best-effort)', () => {
  const payload = renderWebhookPayload(firing(), 'opened')

  it('retries a failed attempt and reports the eventual success (with doubling backoff)', async () => {
    const { fn, calls } = sequenceFetch([new Error('boom'), new Error('boom'), { ok: true, status: 200 }])
    const { delays, sleepImpl } = recordSleeps()
    const res = await deliverToChannel(channel(), payload, {
      fetchImpl: fn,
      retry: { maxAttempts: 3, baseDelayMs: 100, sleepImpl },
    })
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(3)
    expect(delays).toEqual([100, 200]) // backoff after attempts 1 and 2, none after the success
  })

  it('gives up after maxAttempts and returns the last failure', async () => {
    const { fn, calls } = sequenceFetch([{ ok: false, status: 500 }])
    const { delays, sleepImpl } = recordSleeps()
    const res = await deliverToChannel(channel(), payload, {
      fetchImpl: fn,
      retry: { maxAttempts: 2, baseDelayMs: 50, sleepImpl },
    })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(500)
    expect(calls).toHaveLength(2)
    expect(delays).toEqual([50]) // one backoff between the two attempts
  })

  it('caps a single backoff at maxDelayMs', async () => {
    const { fn } = sequenceFetch([new Error('x'), new Error('x'), new Error('x')])
    const { delays, sleepImpl } = recordSleeps()
    await deliverToChannel(channel(), payload, {
      fetchImpl: fn,
      retry: { maxAttempts: 3, baseDelayMs: 8_000, maxDelayMs: 10_000, sleepImpl },
    })
    expect(delays).toEqual([8_000, 10_000]) // 8000, then 16000 clamped to 10000
  })

  it('default (no retry opts) is a single attempt', async () => {
    const { fn, calls } = sequenceFetch([new Error('boom')])
    const res = await deliverToChannel(channel(), payload, { fetchImpl: fn })
    expect(res.ok).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('an under-configured channel returns immediately — no POST, no retry, no sleep', async () => {
    const { fn, calls } = fakeFetch()
    const { delays, sleepImpl } = recordSleeps()
    const res = await deliverToChannel(channel({ kind: 'email', target: null }), payload, {
      fetchImpl: fn,
      retry: { maxAttempts: 3, sleepImpl },
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('cannot build delivery')
    expect(calls).toHaveLength(0)
    expect(delays).toEqual([])
  })
})

describe('createDeliveryDeduper / deliveryDedupKey (in-memory window)', () => {
  it('suppresses an identical key within the window, allows it once the window elapses', () => {
    const d = createDeliveryDeduper(1_000)
    const k = deliveryDedupKey('psac_1', 42, 'opened')
    expect(d.recentlySent(k, 0)).toBe(false) // never sent
    d.markSent(k, 0)
    expect(d.recentlySent(k, 500)).toBe(true) // within window
    expect(d.recentlySent(k, 1_000)).toBe(false) // window elapsed (age >= window)
    expect(d.recentlySent(k, 1_500)).toBe(false)
  })

  it('windowMs<=0 disables it (every send passes)', () => {
    const d = createDeliveryDeduper(0)
    const k = deliveryDedupKey('psac_1', 42, 'opened')
    d.markSent(k, 0)
    expect(d.recentlySent(k, 0)).toBe(false)
  })

  it('deliveryDedupKey distinguishes channel, firing, and event', () => {
    expect(deliveryDedupKey('a', 1, 'opened')).not.toBe(deliveryDedupKey('a', 1, 'resolved'))
    expect(deliveryDedupKey('a', 1, 'opened')).not.toBe(deliveryDedupKey('a', 2, 'opened'))
    expect(deliveryDedupKey('a', 1, 'opened')).not.toBe(deliveryDedupKey('b', 1, 'opened'))
  })

  it('prune drops entries past the window; size reflects the live set', () => {
    const d = createDeliveryDeduper(1_000)
    d.markSent('k1', 0)
    d.markSent('k2', 500)
    expect(d.size()).toBe(2)
    d.prune(1_000) // k1 (age 1000 >= window) drops; k2 (age 500) stays
    expect(d.size()).toBe(1)
  })
})

describe('renderAlertText (counts-only)', () => {
  it('renders a firing line from counts-only fields (label + ruleId)', () => {
    const text = renderAlertText(renderWebhookPayload(firing({ label: 'too many parked' }), 'opened'))
    expect(text).toBe(
      '[gotong] alert firing: too many parked (asr_1) — health.suspendedTasks gt 5 (observed 9) on source local',
    )
  })

  it('uses the ruleId alone when there is no label, and says resolved for a resolved event', () => {
    const text = renderAlertText(renderWebhookPayload(firing({ resolvedAt: 2000 }), 'resolved'))
    expect(text).toBe('[gotong] alert resolved: asr_1 — health.suspendedTasks gt 5 (observed 9) on source local')
  })
})

describe('buildDeliveryRequest (per-kind/platform, pure)', () => {
  const payload = renderWebhookPayload(firing({ label: 'parked' }), 'opened')
  const text =
    '[gotong] alert firing: parked (asr_1) — health.suspendedTasks gt 5 (observed 9) on source local'

  it('webhook → JSON payload body, Authorization from the secret', () => {
    const req = buildDeliveryRequest(channel({ kind: 'webhook' }), payload, 'Bearer t')
    expect(req?.url).toBe('https://hooks.example.com/x')
    expect(req?.headers.authorization).toBe('Bearer t')
    expect(JSON.parse(req!.body)).toEqual(payload)
  })

  it('im/telegram → bot token in the path, {chat_id,text} body (token never a header)', () => {
    const req = buildDeliveryRequest(
      channel({ kind: 'im', platform: 'telegram', url: 'https://api.telegram.org', target: '-100' }),
      payload,
      '12345:secret',
    )
    expect(req?.url).toBe('https://api.telegram.org/bot12345:secret/sendMessage')
    expect(JSON.parse(req!.body)).toEqual({ chat_id: '-100', text })
    expect(req?.headers.authorization).toBeUndefined()
  })

  it('im/telegram without a target → null (best-effort skip)', () => {
    const req = buildDeliveryRequest(
      channel({ kind: 'im', platform: 'telegram', url: 'https://api.telegram.org', target: null }),
      payload,
      'tok',
    )
    expect(req).toBeNull()
  })

  it('im/slack → incoming-webhook {text} body at the channel url', () => {
    const req = buildDeliveryRequest(
      channel({ kind: 'im', platform: 'slack', url: 'https://hooks.slack.com/services/T/B/x' }),
      payload,
      null,
    )
    expect(req?.url).toBe('https://hooks.slack.com/services/T/B/x')
    expect(JSON.parse(req!.body)).toEqual({ text })
  })

  it('im/discord → {content} body', () => {
    const req = buildDeliveryRequest(
      channel({ kind: 'im', platform: 'discord', url: 'https://discord.com/api/webhooks/x' }),
      payload,
      null,
    )
    expect(JSON.parse(req!.body)).toEqual({ content: text })
  })

  it('im/lark → {msg_type,content:{text}} body', () => {
    const req = buildDeliveryRequest(
      channel({ kind: 'im', platform: 'lark', url: 'https://open.larksuite.com/x' }),
      payload,
      null,
    )
    expect(JSON.parse(req!.body)).toEqual({ msg_type: 'text', content: { text } })
  })

  it('email → {to,subject,text} body + Authorization from the secret', () => {
    const req = buildDeliveryRequest(
      channel({ kind: 'email', url: 'https://api.mailer.example/send', target: 'ops@example.com' }),
      payload,
      'Bearer key',
    )
    expect(req?.url).toBe('https://api.mailer.example/send')
    expect(req?.headers.authorization).toBe('Bearer key')
    expect(JSON.parse(req!.body)).toEqual({
      to: 'ops@example.com',
      subject: '[gotong] alert opened: health.suspendedTasks',
      text,
    })
  })

  it('email without a recipient → null', () => {
    const req = buildDeliveryRequest(
      channel({ kind: 'email', url: 'https://api.mailer.example/send', target: null }),
      payload,
      'k',
    )
    expect(req).toBeNull()
  })
})

describe('deliverToEnabledChannels', () => {
  it('delivers only to enabled channels', async () => {
    const { fn, calls } = fakeFetch()
    const payload = renderWebhookPayload(firing(), 'opened')
    const results = await deliverToEnabledChannels(
      [
        channel({ id: 'a', url: 'https://a.example/x', enabled: true }),
        channel({ id: 'b', url: 'https://b.example/x', enabled: false }),
        channel({ id: 'c', url: 'https://c.example/x', enabled: true }),
      ],
      payload,
      { fetchImpl: fn },
    )
    expect(results.map((r) => r.channelId).sort()).toEqual(['a', 'c'])
    expect(calls.map((c) => c.url).sort()).toEqual(['https://a.example/x', 'https://c.example/x'])
  })

  it('skips an identical (channel, firing, event) already sent within the window — no second POST', async () => {
    const { fn, calls } = fakeFetch()
    const payload = renderWebhookPayload(firing({ id: 42 }), 'opened')
    const deduper = createDeliveryDeduper(60_000)
    // first pass: delivers and records
    const r1 = await deliverToEnabledChannels([channel({ id: 'a' })], payload, { fetchImpl: fn, deduper, nowMs: 1_000 })
    expect(r1[0].ok).toBe(true)
    expect(r1[0].skipped).toBeUndefined()
    expect(calls).toHaveLength(1)
    // second pass within the window: suppressed (skipped:true, no new POST)
    const r2 = await deliverToEnabledChannels([channel({ id: 'a' })], payload, { fetchImpl: fn, deduper, nowMs: 2_000 })
    expect(r2[0].ok).toBe(true)
    expect(r2[0].skipped).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('a FAILED send is not recorded — a later pass is free to retry it', async () => {
    const payload = renderWebhookPayload(firing({ id: 7 }), 'opened')
    const deduper = createDeliveryDeduper(60_000)
    const failing = fakeFetch({ ok: false, status: 500 })
    const r1 = await deliverToEnabledChannels([channel({ id: 'a' })], payload, {
      fetchImpl: failing.fn,
      deduper,
      nowMs: 1_000,
    })
    expect(r1[0].ok).toBe(false)
    // the failure wasn't recorded → a later pass delivers (not skipped)
    const ok = fakeFetch({ ok: true, status: 200 })
    const r2 = await deliverToEnabledChannels([channel({ id: 'a' })], payload, {
      fetchImpl: ok.fn,
      deduper,
      nowMs: 2_000,
    })
    expect(r2[0].skipped).toBeUndefined()
    expect(r2[0].ok).toBe(true)
    expect(ok.calls).toHaveLength(1)
  })
})
