/**
 * QqBridge end-to-end (official webhook) — hermetic.
 *
 * Drives `handleRawRequest` / `handleEvent` directly (webhookPort: 0, so
 * no real HTTP listener) with an injected FakeQqClient. Ed25519
 * signatures are composed with Node's own `sign` over the SAME secret the
 * bridge derives its keypair from, so the op:13 handshake and op:0 verify
 * are exercised for real without any network.
 */

import { sign as nodeSign, verify as nodeVerify } from 'node:crypto'

import type { ImMessage, ImUser } from '@gotong/im-adapter'
import { describe, expect, it } from 'vitest'

import { QqBridge } from '../src/bridge.js'
import type { QqClient } from '../src/client.js'
import { deriveQqKeyPair } from '../src/qq-crypto.js'
import { QQ_OP_DISPATCH, QQ_OP_VALIDATION, type QqWebhookPayload } from '../src/types.js'

const SECRET = 'bridge-secret'
const APP_ID = 'APPID'

interface SendCall {
  method: 'group' | 'c2c' | 'channel' | 'dm'
  id: string
  body: Record<string, unknown>
}

/** A QqClient that records every send instead of hitting the network. */
function fakeClient(): { client: QqClient; sends: SendCall[] } {
  const sends: SendCall[] = []
  const client: QqClient = {
    getAccessToken: () => Promise.resolve('tok'),
    sendGroupMessage: (id, body) => {
      sends.push({ method: 'group', id, body: body as Record<string, unknown> })
      return Promise.resolve({})
    },
    sendC2CMessage: (id, body) => {
      sends.push({ method: 'c2c', id, body: body as Record<string, unknown> })
      return Promise.resolve({})
    },
    sendChannelMessage: (id, body) => {
      sends.push({ method: 'channel', id, body: body as Record<string, unknown> })
      return Promise.resolve({})
    },
    sendGuildDirectMessage: (id, body) => {
      sends.push({ method: 'dm', id, body: body as Record<string, unknown> })
      return Promise.resolve({})
    },
    invalidateToken: () => {},
  }
  return { client, sends }
}

function makeBridge() {
  const { client, sends } = fakeClient()
  const errors: unknown[] = []
  const bridge = new QqBridge({
    appId: APP_ID,
    secret: SECRET,
    client,
    webhookPort: 0, // host-driven; no HTTP listener
    onError: (e) => errors.push(e),
  })
  const received: ImMessage[] = []
  bridge.onMessage((m) => {
    received.push(m)
  })
  return { bridge, sends, received, errors }
}

/** Sign an op:0 event exactly as QQ would: Ed25519 over `timestamp + rawBody`. */
function signEvent(rawBody: string, timestamp: string): string {
  const { privateKey } = deriveQqKeyPair(SECRET)
  return nodeSign(null, Buffer.from(timestamp + rawBody, 'utf8'), privateKey).toString('hex')
}

function groupEvent(id: string, content: string, msgId: string): QqWebhookPayload {
  return {
    op: QQ_OP_DISPATCH,
    id,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: msgId,
      content,
      group_openid: 'G1',
      author: { id: 'raw', union_openid: 'U1' },
    },
  }
}

const SENDER: ImUser = { platform: 'qq', platformUserId: 'U1' }

describe('constructor', () => {
  it('requires appId and secret', () => {
    // @ts-expect-error missing appId
    expect(() => new QqBridge({ secret: SECRET })).toThrow(/appId/)
    // @ts-expect-error missing secret
    expect(() => new QqBridge({ appId: APP_ID })).toThrow(/secret/)
  })
})

describe('op:13 callback validation handshake', () => {
  it('signs event_ts + plain_token verifiably with the derived public key', async () => {
    const { bridge } = makeBridge()
    const payload = {
      op: QQ_OP_VALIDATION,
      d: { plain_token: 'CHAL', event_ts: '1700000000' },
    }
    const result = await bridge.handleRawRequest(JSON.stringify(payload), {})
    expect(result.status).toBe(200)
    const body = result.body as { plain_token: string; signature: string }
    expect(body.plain_token).toBe('CHAL')

    const { publicKey } = deriveQqKeyPair(SECRET)
    const ok = nodeVerify(
      null,
      Buffer.from('1700000000' + 'CHAL', 'utf8'),
      publicKey,
      Buffer.from(body.signature, 'hex'),
    )
    expect(ok).toBe(true)
  })

  it('rejects a malformed validation payload with 400', async () => {
    const { bridge } = makeBridge()
    const result = await bridge.handleRawRequest(
      JSON.stringify({ op: QQ_OP_VALIDATION, d: { plain_token: 'only' } }),
      {},
    )
    expect(result.status).toBe(400)
  })
})

describe('op:0 event signature verification', () => {
  it('accepts a correctly-signed event and delivers the mapped message', async () => {
    const { bridge, received } = makeBridge()
    const rawBody = JSON.stringify(groupEvent('EV1', '/help', 'MSG1'))
    const timestamp = '1700000000'
    const signature = signEvent(rawBody, timestamp)

    const result = await bridge.handleRawRequest(rawBody, { signature, timestamp })
    expect(result.status).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0]!.chatId).toBe('group:G1')
    expect(received[0]!.text).toBe('/help')
    expect(received[0]!.from.platformUserId).toBe('U1')
  })

  it('rejects a tampered body with 401 and does not deliver', async () => {
    const { bridge, received, errors } = makeBridge()
    const rawBody = JSON.stringify(groupEvent('EV1', '/help', 'MSG1'))
    const timestamp = '1700000000'
    const signature = signEvent(rawBody, timestamp)

    // Forge a different body under the original signature.
    const forged = rawBody.replace('/help', '/danger')
    const result = await bridge.handleRawRequest(forged, { signature, timestamp })
    expect(result.status).toBe(401)
    expect(received).toHaveLength(0)
    expect(errors.length).toBeGreaterThan(0)
  })

  it('acks an unknown op without delivering', async () => {
    const { bridge, received } = makeBridge()
    const result = await bridge.handleRawRequest(JSON.stringify({ op: 99 }), {})
    expect(result.status).toBe(200)
    expect(received).toHaveLength(0)
  })

  it('returns 400 on invalid JSON', async () => {
    const { bridge } = makeBridge()
    const result = await bridge.handleRawRequest('not json', {})
    expect(result.status).toBe(400)
  })
})

describe('handleEvent — mapping + dedup', () => {
  it('maps a group @bot and a C2C event', async () => {
    const { bridge, received } = makeBridge()
    await bridge.handleEvent(groupEvent('EV1', '/help', 'MSG1'))
    await bridge.handleEvent({
      op: QQ_OP_DISPATCH,
      id: 'EV2',
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'MSG2', content: 'hi', author: { union_openid: 'U1', user_openid: 'C2C_U' } },
    })
    expect(received.map((m) => m.chatId)).toEqual(['group:G1', 'c2c:C2C_U'])
  })

  it('dedups a redelivered event id', async () => {
    const { bridge, received } = makeBridge()
    const ev = groupEvent('EV1', '/help', 'MSG1')
    await bridge.handleEvent(ev)
    await bridge.handleEvent(ev) // QQ retried on a slow ack
    expect(received).toHaveLength(1)
  })
})

describe('sendMessage — passive reply', () => {
  it('replies to a group, carrying msg_id and an incrementing msg_seq', async () => {
    const { bridge, sends } = makeBridge()
    // Receiving a message records the reply handle.
    await bridge.handleEvent(groupEvent('EV1', '/help', 'MSG1'))

    await bridge.sendMessage(SENDER, 'first', { chatId: 'group:G1' })
    await bridge.sendMessage(SENDER, 'second', { chatId: 'group:G1' })

    expect(sends).toHaveLength(2)
    expect(sends[0]).toEqual({
      method: 'group',
      id: 'G1',
      body: { content: 'first', msg_id: 'MSG1', msg_seq: 1 },
    })
    // seq increments so QQ doesn't reject a duplicate.
    expect(sends[1]!.body.msg_seq).toBe(2)
  })

  it('routes a C2C reply to /v2/users via the client', async () => {
    const { bridge, sends } = makeBridge()
    await bridge.handleEvent({
      op: QQ_OP_DISPATCH,
      id: 'EV1',
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'MSG9', content: 'hi', author: { union_openid: 'U1', user_openid: 'C2C_U' } },
    })
    await bridge.sendMessage(SENDER, 'pong', { chatId: 'c2c:C2C_U' })
    expect(sends[0]).toMatchObject({ method: 'c2c', id: 'C2C_U' })
    expect(sends[0]!.body).toEqual({ content: 'pong', msg_id: 'MSG9', msg_seq: 1 })
  })

  it('honest-fails when asked to push to a chat with no inbound message', async () => {
    const { bridge, sends } = makeBridge()
    // No prior inbound for this chat → proactive push, which QQ discontinued.
    await expect(
      bridge.sendMessage(SENDER, 'unsolicited', { chatId: 'group:NEVER_SEEN' }),
    ).rejects.toThrow(/PASSIVE|proactive/i)
    expect(sends).toHaveLength(0)
  })

  it('throws when chatId is missing', async () => {
    const { bridge } = makeBridge()
    await expect(bridge.sendMessage(SENDER, 'x')).rejects.toThrow(/chatId is required/)
  })

  it('throws on a malformed chatId', async () => {
    const { bridge } = makeBridge()
    await expect(
      bridge.sendMessage(SENDER, 'x', { chatId: 'bogus:1' }),
    ).rejects.toThrow(/malformed chatId/)
  })
})
