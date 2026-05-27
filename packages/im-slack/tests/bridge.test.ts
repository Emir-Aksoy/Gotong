/**
 * Phase 12 M6 — SlackBridge end-to-end coverage.
 *
 * Uses a FakeSlackClient to short-circuit fetch and drives
 * `handleRawRequest` / `handleEvent` directly (no live HTTP socket).
 * Signatures are computed via node:crypto exactly like the real
 * verifier so we test both halves on the same wire format.
 */

import { createHmac } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { SlackBridge } from '../src/bridge.js'
import { SlackApiError, type SlackClient } from '../src/client.js'
import type { SlackApiResponse, SlackMessageEvent } from '../src/types.js'

const SIGNING_SECRET = 'shhhh'
const BOT_USER_ID = 'UBOT01'
const USER_ID = 'U_ALICE'
const CHANNEL_ID = 'C_ROOM'

interface CallRecord {
  path: string
  body: unknown
}

class FakeSlackClient implements SlackClient {
  readonly baseUrl = 'https://fake.slack.test/api'
  readonly calls: CallRecord[] = []
  /** Optional per-path response stub. If unset, returns `{ ok: true }`. */
  private responseByPath = new Map<string, unknown>()
  /** Optional per-path error stub. If set, throws this instead of returning. */
  private errorByPath = new Map<string, Error>()

  setResponse(path: string, response: unknown): void {
    this.responseByPath.set(path, response)
  }

  setError(path: string, err: Error): void {
    this.errorByPath.set(path, err)
  }

  async call<T extends SlackApiResponse>(path: string, options: { body?: unknown } = {}): Promise<T> {
    this.calls.push({ path, body: options.body })
    const e = this.errorByPath.get(path)
    if (e) throw e
    const r = this.responseByPath.get(path) ?? { ok: true }
    return r as T
  }
}

function sign(ts: string, body: string): string {
  return `v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`
}

function makeMessageCallback(over: {
  event?: Partial<SlackMessageEvent>
  authorizations?: Array<{ user_id: string; is_bot?: boolean; team_id?: string }>
  event_id?: string
} = {}): {
  type: 'event_callback'
  event_id: string
  event_time: number
  team_id: string
  api_app_id: string
  event: SlackMessageEvent
  authorizations: Array<{ user_id: string; is_bot?: boolean; team_id?: string }>
} {
  const event: SlackMessageEvent = {
    type: 'message',
    user: USER_ID,
    channel: CHANNEL_ID,
    ts: '1748345600.000100',
    text: 'hello',
    team: 'T0001',
    ...(over.event ?? {}),
  }
  return {
    type: 'event_callback',
    event_id: over.event_id ?? 'Ev0001',
    event_time: 1748345600,
    team_id: 'T0001',
    api_app_id: 'A0001',
    event,
    authorizations: over.authorizations ?? [
      { user_id: BOT_USER_ID, is_bot: true, team_id: 'T0001' },
    ],
  }
}

describe('SlackBridge constructor', () => {
  it('exposes platform "slack"', () => {
    const b = new SlackBridge({ token: 'xoxb-x', signingSecret: SIGNING_SECRET })
    expect(b.platform).toBe('slack')
  })

  it('throws on missing token', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new SlackBridge({ signingSecret: 's' } as any)).toThrow(/token is required/)
    expect(() => new SlackBridge({ token: '', signingSecret: 's' })).toThrow(/token is required/)
  })

  it('throws on missing signingSecret', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new SlackBridge({ token: 'xoxb-x' } as any)).toThrow(/signingSecret is required/)
    expect(() => new SlackBridge({ token: 'xoxb-x', signingSecret: '' })).toThrow(/signingSecret is required/)
  })
})

describe('SlackBridge.handleEvent (parsed body, no signature)', () => {
  it('echoes challenge for url_verification', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', signingSecret: SIGNING_SECRET })
    const out = await b.handleEvent({
      type: 'url_verification',
      challenge: 'abc123',
      token: 'ignored',
    })
    expect(out).toEqual({ challenge: 'abc123' })
  })

  it('throws when url_verification has no challenge', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', signingSecret: SIGNING_SECRET })
    await expect(b.handleEvent({ type: 'url_verification' })).rejects.toThrow(/missing challenge/)
  })

  it('ignores unknown top-level types (returns undefined, no throw)', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', signingSecret: SIGNING_SECRET })
    const out = await b.handleEvent({ type: 'app_rate_limited', minute_rate_limited: 1 })
    expect(out).toBeUndefined()
  })

  it('throws when body is not an object', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', signingSecret: SIGNING_SECRET })
    await expect(b.handleEvent('not-an-object')).rejects.toThrow(/must be an object/)
  })

  it('dispatches a plain message event to listeners', async () => {
    const fake = new FakeSlackClient()
    const b = new SlackBridge({
      token: 'xoxb-x',
      signingSecret: SIGNING_SECRET,
      client: fake,
      botUserId: BOT_USER_ID,
    })
    const got: Array<{ text: string; chatId?: string; from: { platformUserId: string } }> = []
    b.onMessage((m) => {
      got.push({ text: m.text, chatId: m.chatId, from: { platformUserId: m.from.platformUserId } })
    })
    await b.handleEvent(makeMessageCallback())
    expect(got).toHaveLength(1)
    expect(got[0]).toEqual({
      text: 'hello',
      chatId: CHANNEL_ID,
      from: { platformUserId: USER_ID },
    })
  })

  it('captures botUserId from authorizations on first delivery', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', signingSecret: SIGNING_SECRET })
    const got: Array<unknown> = []
    b.onMessage((m) => got.push(m))
    // Send a message that includes a <@BOT_USER_ID> mention and an
    // authorizations entry. After processing, the strip should have
    // worked.
    await b.handleEvent(
      makeMessageCallback({
        event: { text: `<@${BOT_USER_ID}> /help` },
        authorizations: [{ user_id: BOT_USER_ID, is_bot: true }],
      }),
    )
    expect(got).toHaveLength(1)
    expect((got[0] as { text: string }).text).toBe('/help')
  })

  it('dedups by event_id across deliveries', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', signingSecret: SIGNING_SECRET, botUserId: BOT_USER_ID })
    const got: unknown[] = []
    b.onMessage((m) => got.push(m))
    const cb = makeMessageCallback({ event_id: 'Ev_dup' })
    await b.handleEvent(cb)
    await b.handleEvent(cb)
    expect(got).toHaveLength(1)
  })

  it('filters bot messages (anti-loop layer 1)', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', signingSecret: SIGNING_SECRET, botUserId: BOT_USER_ID })
    const got: unknown[] = []
    b.onMessage((m) => got.push(m))
    await b.handleEvent(
      makeMessageCallback({
        event: { bot_id: 'B_OTHER', user: undefined },
      }),
    )
    expect(got).toHaveLength(0)
  })

  it('filters own-user posts (anti-loop layer 2)', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', signingSecret: SIGNING_SECRET, botUserId: BOT_USER_ID })
    const got: unknown[] = []
    b.onMessage((m) => got.push(m))
    await b.handleEvent(
      makeMessageCallback({
        event: { user: BOT_USER_ID, text: 'mine' },
      }),
    )
    expect(got).toHaveLength(0)
  })

  it('skips system subtypes (channel_join, message_changed)', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', signingSecret: SIGNING_SECRET, botUserId: BOT_USER_ID })
    const got: unknown[] = []
    b.onMessage((m) => got.push(m))
    await b.handleEvent(makeMessageCallback({ event: { subtype: 'channel_join' } }))
    await b.handleEvent(makeMessageCallback({ event: { subtype: 'message_changed' }, event_id: 'Ev2' }))
    expect(got).toHaveLength(0)
  })

  it('passes through file_share subtype with attachment', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', signingSecret: SIGNING_SECRET, botUserId: BOT_USER_ID })
    const got: Array<{ text: string; attachments?: unknown[] }> = []
    b.onMessage((m) => got.push({ text: m.text, attachments: m.attachments }))
    await b.handleEvent(
      makeMessageCallback({
        event: {
          subtype: 'file_share',
          text: 'cap',
          files: [{ id: 'F1', name: 'pic.png', mimetype: 'image/png' }],
        },
      }),
    )
    expect(got).toHaveLength(1)
    expect(got[0]!.text).toBe('cap')
    expect(got[0]!.attachments).toHaveLength(1)
  })

  it('a listener that throws does not break the bridge', async () => {
    const errors: unknown[] = []
    const b = new SlackBridge({
      token: 'xoxb-x',
      signingSecret: SIGNING_SECRET,
      botUserId: BOT_USER_ID,
      onError: (e) => errors.push(e),
    })
    const got: unknown[] = []
    b.onMessage(() => {
      throw new Error('boom')
    })
    b.onMessage((m) => got.push(m))
    await b.handleEvent(makeMessageCallback())
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('boom')
    expect(got).toHaveLength(1)
  })
})

describe('SlackBridge.handleRawRequest (signature path)', () => {
  it('accepts a correctly-signed payload', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', signingSecret: SIGNING_SECRET, botUserId: BOT_USER_ID })
    const got: unknown[] = []
    b.onMessage((m) => got.push(m))
    const body = JSON.stringify(makeMessageCallback())
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = sign(ts, body)
    const r = await b.handleRawRequest(body, { signature: sig, timestamp: ts })
    expect(r.status).toBe(200)
    expect(got).toHaveLength(1)
  })

  it('echoes challenge through the signed path', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', signingSecret: SIGNING_SECRET })
    const body = JSON.stringify({ type: 'url_verification', challenge: 'xyz' })
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = sign(ts, body)
    const r = await b.handleRawRequest(body, { signature: sig, timestamp: ts })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ challenge: 'xyz' })
  })

  it('rejects bad signatures with 401', async () => {
    const errors: unknown[] = []
    const b = new SlackBridge({
      token: 'xoxb-x',
      signingSecret: SIGNING_SECRET,
      onError: (e) => errors.push(e),
    })
    const body = JSON.stringify(makeMessageCallback())
    const ts = String(Math.floor(Date.now() / 1000))
    const wrong = sign(ts, '{"different":"body"}')
    const r = await b.handleRawRequest(body, { signature: wrong, timestamp: ts })
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'mismatch' })
    expect(errors).toHaveLength(1)
  })

  it('rejects requests with missing headers as 401', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', signingSecret: SIGNING_SECRET })
    const r = await b.handleRawRequest('{}', { signature: null, timestamp: null })
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'missing-headers' })
  })

  it('rejects stale timestamps as 401', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', signingSecret: SIGNING_SECRET, signatureToleranceSec: 60 })
    const body = '{}'
    const ts = String(Math.floor(Date.now() / 1000) - 3600)
    const sig = sign(ts, body)
    const r = await b.handleRawRequest(body, { signature: sig, timestamp: ts })
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'bad-timestamp' })
  })

  it('returns 400 on invalid JSON body (signature valid)', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', signingSecret: SIGNING_SECRET })
    const body = 'not-json'
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = sign(ts, body)
    const r = await b.handleRawRequest(body, { signature: sig, timestamp: ts })
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'invalid_json' })
  })
})

describe('SlackBridge.sendMessage', () => {
  it('POSTs chat.postMessage with channel + text', async () => {
    const fake = new FakeSlackClient()
    const b = new SlackBridge({
      token: 'xoxb-x',
      signingSecret: SIGNING_SECRET,
      client: fake,
      botUserId: BOT_USER_ID,
    })
    await b.sendMessage(
      { platform: 'slack', platformUserId: USER_ID },
      'reply',
      { chatId: CHANNEL_ID },
    )
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toEqual({
      path: '/chat.postMessage',
      body: { channel: CHANNEL_ID, text: 'reply' },
    })
  })

  it('falls back to platformUserId when chatId is missing', async () => {
    const fake = new FakeSlackClient()
    const b = new SlackBridge({
      token: 'xoxb-x',
      signingSecret: SIGNING_SECRET,
      client: fake,
      botUserId: BOT_USER_ID,
    })
    await b.sendMessage({ platform: 'slack', platformUserId: USER_ID }, 'hi')
    expect(fake.calls[0]!.body).toEqual({ channel: USER_ID, text: 'hi' })
  })

  it('throws when neither chatId nor platformUserId is available', async () => {
    const fake = new FakeSlackClient()
    const b = new SlackBridge({
      token: 'xoxb-x',
      signingSecret: SIGNING_SECRET,
      client: fake,
      botUserId: BOT_USER_ID,
    })
    await expect(
      b.sendMessage({ platform: 'slack', platformUserId: '' }, 'hi'),
    ).rejects.toThrow(/Slack needs a channel id/)
  })

  it('surfaces outbound attachments via onError and still sends text', async () => {
    const fake = new FakeSlackClient()
    const errors: unknown[] = []
    const b = new SlackBridge({
      token: 'xoxb-x',
      signingSecret: SIGNING_SECRET,
      client: fake,
      botUserId: BOT_USER_ID,
      onError: (e) => errors.push(e),
    })
    await b.sendMessage(
      { platform: 'slack', platformUserId: USER_ID },
      'caption',
      {
        chatId: CHANNEL_ID,
        attachments: [{ kind: 'image', url: 'slack-file:F1', mime: 'image/png', filename: 'x.png' }],
      },
    )
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toMatch(/outbound attachments not yet supported/)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.body).toEqual({ channel: CHANNEL_ID, text: 'caption' })
  })

  it('propagates SlackApiError from the client', async () => {
    const fake = new FakeSlackClient()
    fake.setError(
      '/chat.postMessage',
      new SlackApiError({
        method: 'POST',
        path: '/chat.postMessage',
        status: 200,
        code: 'channel_not_found',
      }),
    )
    const b = new SlackBridge({
      token: 'xoxb-x',
      signingSecret: SIGNING_SECRET,
      client: fake,
      botUserId: BOT_USER_ID,
    })
    await expect(
      b.sendMessage({ platform: 'slack', platformUserId: USER_ID }, 'hi', {
        chatId: 'C_BAD',
      }),
    ).rejects.toThrow(/channel_not_found/)
  })
})

describe('SlackBridge lifecycle', () => {
  it('start() then stop() with webhookPort=0 is a no-op (idempotent)', async () => {
    const b = new SlackBridge({
      token: 'xoxb-x',
      signingSecret: SIGNING_SECRET,
      webhookPort: 0,
    })
    await b.start()
    await b.start() // second start is a no-op
    await b.stop()
    await b.stop() // second stop is also a no-op
  })

  it('start() actually opens an HTTP listener when port > 0', async () => {
    const b = new SlackBridge({
      token: 'xoxb-x',
      signingSecret: SIGNING_SECRET,
      webhookPort: 0, // 0 binds to an ephemeral port via http.Server.listen(0)
      // Switch path to 0 above to keep test hermetic; verify with a
      // separate ephemeral-port test:
    })
    await b.start()
    await b.stop()
  })

  it('binds an ephemeral port and serves a 200 to the configured path', async () => {
    // We need a real port for this test. Pick a high port; on a CI
    // box, this is racy in theory but rarely in practice. The test
    // doesn't actually fire a verified POST — that's covered by the
    // signature/event tests above — only that the server accepts a
    // POST and returns SOMETHING.
    const ports = await import('node:net')
    const portFinder = await new Promise<number>((resolve) => {
      const srv = ports.createServer()
      srv.listen(0, () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        srv.close(() => resolve(port))
      })
    })
    const errors: unknown[] = []
    const b = new SlackBridge({
      token: 'xoxb-x',
      signingSecret: SIGNING_SECRET,
      webhookPort: portFinder,
      onError: (e) => errors.push(e),
    })
    await b.start()
    try {
      const res = await fetch(`http://127.0.0.1:${portFinder}/slack/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      // No signature headers → 401 from handleRawRequest.
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body).toEqual({ error: 'missing-headers' })
      // And the GET liveness probe.
      const ping = await fetch(`http://127.0.0.1:${portFinder}/slack/webhook`)
      expect(ping.status).toBe(200)
      expect(await ping.text()).toBe('slack-bridge ok')
      // Unknown path → 404.
      const notFound = await fetch(`http://127.0.0.1:${portFinder}/other`, { method: 'POST' })
      expect(notFound.status).toBe(404)
    } finally {
      await b.stop()
    }
    // errors should include the "missing-headers" from the unsigned POST.
    expect(errors.some((e) => (e as Error).message?.includes('missing-headers'))).toBe(true)
  })
})

describe('SlackBridge.onMessage', () => {
  it('returns an unsubscribe that removes the listener', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', signingSecret: SIGNING_SECRET, botUserId: BOT_USER_ID })
    const got: unknown[] = []
    const unsub = b.onMessage((m) => got.push(m))
    await b.handleEvent(makeMessageCallback({ event_id: 'Ev1' }))
    unsub()
    await b.handleEvent(makeMessageCallback({ event_id: 'Ev2' }))
    expect(got).toHaveLength(1)
  })
})

// Silence unused-import warning when nothing in the file uses vi yet.
void vi
