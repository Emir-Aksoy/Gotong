/**
 * LarkBridge coverage — official long connection
 * (`@larksuiteoapi/node-sdk` WSClient).
 *
 * Strategy: inject a fake `connectionFactory`. The factory captures the
 * `onMessageReceive` callback the bridge wired in `start()`, so a test
 * can `emit()` a synthetic `im.message.receive_v1` event exactly as the
 * real SDK would deliver it over the socket — no real SDK, no network,
 * no port. Dispatch, dedup, mention-strip, and the anti-loop skip are
 * all exercised through that single seam.
 *
 * sendMessage tests use a `FakeLarkClient` that records each call; no
 * fetch involved. The REST send path is unchanged from the webhook era.
 */

import type { ImMessage } from '@gotong/im-adapter'
import { afterEach, describe, expect, it } from 'vitest'

import {
  LarkBridge,
  type LarkConnectionFactory,
  type LarkConnectionFactoryParams,
} from '../src/bridge.js'
import type { LarkCallOptions, LarkClient } from '../src/client.js'
import type { LarkMessageReceiveEvent } from '../src/types.js'

const SENDER_OPEN_ID = 'ou_alice'
const CHAT_ID = 'oc_room1'

class FakeLarkClient implements LarkClient {
  calls: Array<{
    method: string
    path: string
    options?: LarkCallOptions
  }> = []

  async call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options?: LarkCallOptions,
  ): Promise<T> {
    this.calls.push({ method, path, options })
    return { code: 0, msg: 'ok' } as unknown as T
  }

  invalidateToken(): void {
    /* noop */
  }
}

/**
 * A fake long connection. The factory captures the params the bridge
 * hands it (appId/appSecret/onMessageReceive/onError); `emit` feeds an
 * event through the captured callback as the SDK would over the socket.
 */
function fakeConnection(): {
  factory: LarkConnectionFactory
  emit: (event: LarkMessageReceiveEvent) => Promise<void>
  params: () => LarkConnectionFactoryParams | null
  startCount: () => number
  stopCount: () => number
} {
  let captured: LarkConnectionFactoryParams | null = null
  let startCount = 0
  let stopCount = 0
  const factory: LarkConnectionFactory = (params) => {
    captured = params
    return {
      start(): void {
        startCount += 1
      },
      stop(): void {
        stopCount += 1
      },
    }
  }
  return {
    factory,
    emit: async (event) => {
      if (!captured) throw new Error('connection not started — call start() first')
      await captured.onMessageReceive(event)
    },
    params: () => captured,
    startCount: () => startCount,
    stopCount: () => stopCount,
  }
}

/**
 * Build the `im.message.receive_v1` event body the SDK's dispatcher
 * hands the handler — `{ sender, message }`, no webhook envelope.
 */
function buildEvent(
  over: Partial<{
    messageId: string
    message: { content?: string; message_type?: string }
    senderType: 'user' | 'app'
    openId: string | null
  }> = {},
): LarkMessageReceiveEvent {
  return {
    sender: {
      sender_type: over.senderType ?? 'user',
      sender_id:
        over.openId === null
          ? {}
          : { open_id: over.openId ?? SENDER_OPEN_ID, user_id: 'u_x', union_id: 'on_x' },
      tenant_key: 'tk',
    },
    message: {
      message_id: over.messageId ?? 'om_1',
      create_time: '1700000000000',
      chat_id: CHAT_ID,
      chat_type: 'p2p',
      message_type: over.message?.message_type ?? 'text',
      content: over.message?.content ?? JSON.stringify({ text: 'hello bot' }),
    },
  }
}

function makeBridge(opts: {
  factory: LarkConnectionFactory
  client?: LarkClient
  onError?: (e: unknown) => void
  stripBotMentions?: boolean
}): LarkBridge {
  return new LarkBridge({
    appId: 'cli_x',
    appSecret: 's',
    client: opts.client ?? new FakeLarkClient(),
    connectionFactory: opts.factory,
    onError: opts.onError,
    stripBotMentions: opts.stripBotMentions,
  })
}

describe('LarkBridge', () => {
  let bridge: LarkBridge | null = null
  afterEach(async () => {
    if (bridge) {
      await bridge.stop()
      bridge = null
    }
  })

  it('rejects construction without appId / appSecret', () => {
    expect(
      () =>
        new LarkBridge({
          // @ts-expect-error missing appId
          appSecret: 's',
          client: new FakeLarkClient(),
        }),
    ).toThrow(/appId is required/)
    expect(
      () =>
        new LarkBridge({
          appId: 'cli_x',
          // @ts-expect-error missing appSecret
          client: new FakeLarkClient(),
        }),
    ).toThrow(/appSecret is required/)
  })

  it('start() builds the connection with appId/appSecret and starts it; stop() stops it', async () => {
    const conn = fakeConnection()
    bridge = makeBridge({ factory: conn.factory })
    await bridge.start()
    expect(conn.startCount()).toBe(1)
    expect(conn.params()?.appId).toBe('cli_x')
    expect(conn.params()?.appSecret).toBe('s')
    // idempotent start
    await bridge.start()
    expect(conn.startCount()).toBe(1)
    await bridge.stop()
    expect(conn.stopCount()).toBe(1)
    // idempotent stop
    await bridge.stop()
    expect(conn.stopCount()).toBe(1)
    bridge = null
  })

  it('delivers im.message.receive_v1 events as ImMessage', async () => {
    const conn = fakeConnection()
    bridge = makeBridge({ factory: conn.factory })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.start()
    await conn.emit(buildEvent({}))
    expect(received).toHaveLength(1)
    expect(received[0]!.text).toBe('hello bot')
    expect(received[0]!.from.platformUserId).toBe(SENDER_OPEN_ID)
    expect(received[0]!.chatId).toBe(CHAT_ID)
  })

  it('dedups by message_id (long connection may redeliver on reconnect)', async () => {
    const conn = fakeConnection()
    bridge = makeBridge({ factory: conn.factory })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.start()
    const evt = buildEvent({ messageId: 'om_dup' })
    await conn.emit(evt)
    await conn.emit(evt)
    await conn.emit(evt)
    expect(received).toHaveLength(1)
  })

  it('delivers two distinct message_ids', async () => {
    const conn = fakeConnection()
    bridge = makeBridge({ factory: conn.factory })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.start()
    await conn.emit(buildEvent({ messageId: 'om_a' }))
    await conn.emit(buildEvent({ messageId: 'om_b' }))
    expect(received).toHaveLength(2)
  })

  it('skips events from app senders (anti-loop)', async () => {
    const conn = fakeConnection()
    bridge = makeBridge({ factory: conn.factory })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.start()
    await conn.emit(buildEvent({ senderType: 'app' }))
    expect(received).toEqual([])
  })

  it('strips @bot mentions by default', async () => {
    const conn = fakeConnection()
    bridge = makeBridge({ factory: conn.factory })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.start()
    await conn.emit(
      buildEvent({
        message: {
          content: JSON.stringify({ text: '<at user_id="ou_bot">@Bot</at> /help' }),
        },
      }),
    )
    expect(received[0]!.text).toBe('/help')
  })

  it('preserves mentions when stripBotMentions is false', async () => {
    const conn = fakeConnection()
    bridge = makeBridge({ factory: conn.factory, stripBotMentions: false })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.start()
    await conn.emit(
      buildEvent({
        message: { content: JSON.stringify({ text: '<at user_id="ou_bot">@Bot</at> /help' }) },
      }),
    )
    expect(received[0]!.text).toBe('<at user_id="ou_bot">@Bot</at> /help')
  })

  it('listener throw does not stop other listeners', async () => {
    const errors: unknown[] = []
    const conn = fakeConnection()
    bridge = makeBridge({ factory: conn.factory, onError: (e) => errors.push(e) })
    const goodReceived: ImMessage[] = []
    bridge.onMessage(() => {
      throw new Error('listener boom')
    })
    bridge.onMessage((m) => {
      goodReceived.push(m)
    })
    await bridge.start()
    await conn.emit(buildEvent({}))
    expect(goodReceived).toHaveLength(1)
    expect(errors.some((e) => String(e).includes('listener boom'))).toBe(true)
  })

  it('unsubscribe removes the listener', async () => {
    const conn = fakeConnection()
    bridge = makeBridge({ factory: conn.factory })
    const received: ImMessage[] = []
    const unsub = bridge.onMessage((m) => {
      received.push(m)
      if (received.length === 1) unsub()
    })
    await bridge.start()
    await conn.emit(buildEvent({ messageId: 'om_a' }))
    await conn.emit(buildEvent({ messageId: 'om_b' }))
    expect(received).toHaveLength(1)
  })

  // -------- sendMessage (unchanged REST path) --------

  it('sendMessage POSTs to /open-apis/im/v1/messages with chat_id receive type', async () => {
    const client = new FakeLarkClient()
    const conn = fakeConnection()
    bridge = makeBridge({ factory: conn.factory, client })
    await bridge.sendMessage(
      { platform: 'lark', platformUserId: SENDER_OPEN_ID },
      'hello back',
      { chatId: CHAT_ID },
    )
    expect(client.calls).toHaveLength(1)
    const c = client.calls[0]!
    expect(c.method).toBe('POST')
    expect(c.path).toBe('/open-apis/im/v1/messages')
    expect(c.options?.query?.receive_id_type).toBe('chat_id')
    const body = c.options?.body as { receive_id: string; msg_type: string; content: string }
    expect(body.receive_id).toBe(CHAT_ID)
    expect(body.msg_type).toBe('text')
    expect(JSON.parse(body.content)).toEqual({ text: 'hello back' })
  })

  it('sendMessage falls back to platformUserId (open_id) when no chatId', async () => {
    const client = new FakeLarkClient()
    const conn = fakeConnection()
    bridge = makeBridge({ factory: conn.factory, client })
    await bridge.sendMessage({ platform: 'lark', platformUserId: SENDER_OPEN_ID }, 'dm')
    const c = client.calls[0]!
    expect(c.options?.query?.receive_id_type).toBe('open_id')
    const body = c.options?.body as { receive_id: string }
    expect(body.receive_id).toBe(SENDER_OPEN_ID)
  })

  it('sendMessage signals via onError on outbound attachments, still sends text', async () => {
    const client = new FakeLarkClient()
    const errors: unknown[] = []
    const conn = fakeConnection()
    bridge = makeBridge({ factory: conn.factory, client, onError: (e) => errors.push(e) })
    await bridge.sendMessage(
      { platform: 'lark', platformUserId: SENDER_OPEN_ID },
      'caption',
      {
        chatId: CHAT_ID,
        attachments: [{ kind: 'image', url: 'lark-image:img1' }],
      },
    )
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toMatch(/outbound attachments not yet supported/)
    expect(client.calls).toHaveLength(1)
  })

  it('sendMessage throws when neither chatId nor platformUserId is provided', async () => {
    const conn = fakeConnection()
    bridge = makeBridge({ factory: conn.factory })
    await expect(
      bridge.sendMessage(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { platform: 'lark', platformUserId: '' as any },
        'no target',
      ),
    ).rejects.toThrow(/receive_id/)
  })
})
