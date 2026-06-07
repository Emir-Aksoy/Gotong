/**
 * v5 Stream F day-3 — pure edge-trigger differ + webhook dispatcher
 * (peer-summary-alert-delivery).
 *
 * Coverage:
 *   - diffAlertFirings: open new breaches, resolve cleared firings, leave stable
 *   - renderWebhookPayload: shape + counts-only (no leak surface) + opened/resolved
 *   - deliverToChannel: POSTs via injected fetch; headerEnv → Authorization;
 *     missing env var still POSTs; transport error / non-2xx never throw
 *   - deliverToEnabledChannels: disabled channels are skipped
 */

import type { PeerSummaryAlertChannel, PeerSummaryAlertFiring } from '@aipehub/identity'
import { describe, expect, it } from 'vitest'

import type { PeerSummaryAlertBreach } from '../src/peer-summary-alerts.js'
import {
  buildDeliveryRequest,
  deliverToChannel,
  deliverToEnabledChannels,
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
      type: 'aipehub.peer_summary_alert/v1',
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

describe('renderAlertText (counts-only)', () => {
  it('renders a firing line from counts-only fields (label + ruleId)', () => {
    const text = renderAlertText(renderWebhookPayload(firing({ label: 'too many parked' }), 'opened'))
    expect(text).toBe(
      '[aipehub] alert firing: too many parked (asr_1) — health.suspendedTasks gt 5 (observed 9) on source local',
    )
  })

  it('uses the ruleId alone when there is no label, and says resolved for a resolved event', () => {
    const text = renderAlertText(renderWebhookPayload(firing({ resolvedAt: 2000 }), 'resolved'))
    expect(text).toBe('[aipehub] alert resolved: asr_1 — health.suspendedTasks gt 5 (observed 9) on source local')
  })
})

describe('buildDeliveryRequest (per-kind/platform, pure)', () => {
  const payload = renderWebhookPayload(firing({ label: 'parked' }), 'opened')
  const text =
    '[aipehub] alert firing: parked (asr_1) — health.suspendedTasks gt 5 (observed 9) on source local'

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
      subject: '[aipehub] alert opened: health.suspendedTasks',
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
})
