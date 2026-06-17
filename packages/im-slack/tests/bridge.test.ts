/**
 * SlackBridge coverage — official Socket Mode transport.
 *
 * Two seams are exercised:
 *
 *   1. `handleEvent(payload)` directly — the `payload` of a Socket Mode
 *      `events_api` envelope IS a standard `event_callback` body, so the
 *      dispatch / dedup / anti-loop / mention-strip logic is tested by
 *      handing event_callback bodies straight in. No socket needed.
 *   2. A fake `socketFactory` — captures the params the bridge wires in
 *      `start()` (appToken / onEvent / onError) so a test can `emit()` a
 *      payload through `onEvent` exactly as the real socket would, and
 *      assert start/stop drive the connection.
 *
 * sendMessage uses a `FakeSlackClient` that records each call; no fetch.
 * The Web API send path is unchanged from the webhook era.
 */

import { describe, expect, it } from 'vitest'

import {
  SlackBridge,
  type SlackSocketFactory,
  type SlackSocketFactoryParams,
} from '../src/bridge.js'
import { SlackApiError, type SlackClient } from '../src/client.js'
import type { SlackSocketMode } from '../src/socket-mode.js'
import type { SlackApiResponse, SlackMessageEvent } from '../src/types.js'

const APP_TOKEN = 'xapp-test'
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
  private responseByPath = new Map<string, unknown>()
  private errorByPath = new Map<string, Error>()

  setError(path: string, err: Error): void {
    this.errorByPath.set(path, err)
  }

  async call<T extends SlackApiResponse>(
    path: string,
    options: { body?: unknown } = {},
  ): Promise<T> {
    this.calls.push({ path, body: options.body })
    const e = this.errorByPath.get(path)
    if (e) throw e
    const r = this.responseByPath.get(path) ?? { ok: true }
    return r as T
  }
}

/**
 * A fake Socket Mode connection. The factory captures the params the
 * bridge hands it; `emitEvent` feeds a payload through the captured
 * `onEvent` callback exactly as the real socket would over the wire.
 */
function fakeSocket(): {
  factory: SlackSocketFactory
  emitEvent: (payload: unknown) => Promise<void>
  params: () => SlackSocketFactoryParams | null
  startCount: () => number
  stopCount: () => number
} {
  let captured: SlackSocketFactoryParams | null = null
  let startCount = 0
  let stopCount = 0
  const factory: SlackSocketFactory = (params) => {
    captured = params
    const conn: SlackSocketMode = {
      get state() {
        return 'open'
      },
      async start(): Promise<void> {
        startCount += 1
      },
      async stop(): Promise<void> {
        stopCount += 1
      },
    }
    return conn
  }
  return {
    factory,
    emitEvent: async (payload) => {
      if (!captured) throw new Error('socket not started — call start() first')
      await captured.onEvent(payload)
    },
    params: () => captured,
    startCount: () => startCount,
    stopCount: () => stopCount,
  }
}

/**
 * Build the `event_callback` body Socket Mode delivers as the `payload`
 * of an `events_api` envelope.
 */
function makeMessageCallback(
  over: {
    event?: Partial<SlackMessageEvent>
    authorizations?: Array<{ user_id: string; is_bot?: boolean; team_id?: string }>
    event_id?: string
  } = {},
): {
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
    const b = new SlackBridge({ token: 'xoxb-x', appToken: APP_TOKEN })
    expect(b.platform).toBe('slack')
  })

  it('throws on missing token', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new SlackBridge({ appToken: APP_TOKEN } as any)).toThrow(/token is required/)
    expect(() => new SlackBridge({ token: '', appToken: APP_TOKEN })).toThrow(/token is required/)
  })

  it('throws on missing appToken', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new SlackBridge({ token: 'xoxb-x' } as any)).toThrow(/appToken is required/)
    expect(() => new SlackBridge({ token: 'xoxb-x', appToken: '' })).toThrow(/appToken is required/)
  })
})

describe('SlackBridge.handleEvent (events_api payload)', () => {
  it('ignores non-event_callback payloads (no dispatch, no throw)', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', appToken: APP_TOKEN })
    const got: unknown[] = []
    b.onMessage((m) => got.push(m))
    await b.handleEvent({ type: 'app_rate_limited', minute_rate_limited: 1 })
    expect(got).toHaveLength(0)
  })

  it('reports via onError on a non-object payload (does not throw, no dispatch)', async () => {
    const errors: unknown[] = []
    const b = new SlackBridge({
      token: 'xoxb-x',
      appToken: APP_TOKEN,
      onError: (e) => errors.push(e),
    })
    const got: unknown[] = []
    b.onMessage((m) => got.push(m))
    await b.handleEvent('not-an-object')
    expect(got).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toMatch(/must be an object/)
  })

  it('dispatches a plain message event to listeners', async () => {
    const fake = new FakeSlackClient()
    const b = new SlackBridge({
      token: 'xoxb-x',
      appToken: APP_TOKEN,
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
    const b = new SlackBridge({ token: 'xoxb-x', appToken: APP_TOKEN })
    const got: Array<unknown> = []
    b.onMessage((m) => got.push(m))
    // A message that mentions <@BOT_USER_ID> plus an authorizations
    // entry. After processing, the strip should have fired.
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
    const b = new SlackBridge({ token: 'xoxb-x', appToken: APP_TOKEN, botUserId: BOT_USER_ID })
    const got: unknown[] = []
    b.onMessage((m) => got.push(m))
    const cb = makeMessageCallback({ event_id: 'Ev_dup' })
    await b.handleEvent(cb)
    await b.handleEvent(cb)
    expect(got).toHaveLength(1)
  })

  it('filters bot messages (anti-loop layer 1)', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', appToken: APP_TOKEN, botUserId: BOT_USER_ID })
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
    const b = new SlackBridge({ token: 'xoxb-x', appToken: APP_TOKEN, botUserId: BOT_USER_ID })
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
    const b = new SlackBridge({ token: 'xoxb-x', appToken: APP_TOKEN, botUserId: BOT_USER_ID })
    const got: unknown[] = []
    b.onMessage((m) => got.push(m))
    await b.handleEvent(makeMessageCallback({ event: { subtype: 'channel_join' } }))
    await b.handleEvent(makeMessageCallback({ event: { subtype: 'message_changed' }, event_id: 'Ev2' }))
    expect(got).toHaveLength(0)
  })

  it('passes through file_share subtype with attachment', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', appToken: APP_TOKEN, botUserId: BOT_USER_ID })
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
      appToken: APP_TOKEN,
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

describe('SlackBridge socket wiring (start/stop + emit through onEvent)', () => {
  it('start() builds the socket with the appToken and starts it; stop() stops it', async () => {
    const sock = fakeSocket()
    const b = new SlackBridge({
      token: 'xoxb-x',
      appToken: APP_TOKEN,
      socketFactory: sock.factory,
    })
    await b.start()
    expect(sock.startCount()).toBe(1)
    expect(sock.params()?.appToken).toBe(APP_TOKEN)
    // idempotent start
    await b.start()
    expect(sock.startCount()).toBe(1)
    await b.stop()
    expect(sock.stopCount()).toBe(1)
    // idempotent stop
    await b.stop()
    expect(sock.stopCount()).toBe(1)
  })

  it('an events_api payload emitted through the socket dispatches as ImMessage', async () => {
    const sock = fakeSocket()
    const b = new SlackBridge({
      token: 'xoxb-x',
      appToken: APP_TOKEN,
      botUserId: BOT_USER_ID,
      socketFactory: sock.factory,
    })
    const got: Array<{ text: string; chatId?: string }> = []
    b.onMessage((m) => got.push({ text: m.text, chatId: m.chatId }))
    await b.start()
    await sock.emitEvent(makeMessageCallback())
    expect(got).toEqual([{ text: 'hello', chatId: CHANNEL_ID }])
  })
})

describe('SlackBridge.sendMessage', () => {
  it('POSTs chat.postMessage with channel + text', async () => {
    const fake = new FakeSlackClient()
    const b = new SlackBridge({
      token: 'xoxb-x',
      appToken: APP_TOKEN,
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
      appToken: APP_TOKEN,
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
      appToken: APP_TOKEN,
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
      appToken: APP_TOKEN,
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
      appToken: APP_TOKEN,
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

describe('SlackBridge.onMessage', () => {
  it('returns an unsubscribe that removes the listener', async () => {
    const b = new SlackBridge({ token: 'xoxb-x', appToken: APP_TOKEN, botUserId: BOT_USER_ID })
    const got: unknown[] = []
    const unsub = b.onMessage((m) => got.push(m))
    await b.handleEvent(makeMessageCallback({ event_id: 'Ev1' }))
    unsub()
    await b.handleEvent(makeMessageCallback({ event_id: 'Ev2' }))
    expect(got).toHaveLength(1)
  })
})
