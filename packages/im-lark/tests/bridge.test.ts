/**
 * Phase 12 M4 — LarkBridge coverage.
 *
 * Two strategies:
 *   - Most paths drive `handleEvent(body)` directly with synthesized
 *     envelopes. No HTTP listener spun up, no port allocation —
 *     fast, deterministic, no flake.
 *   - One pair of HTTP tests verifies the listener correctly routes
 *     into handleEvent (200 ack on a valid event, 401 on bad token,
 *     200 challenge echo on url_verification).
 *
 * sendMessage tests use a `FakeLarkClient` that records each call;
 * no fetch involved.
 */

import type { ImMessage } from '@aipehub/im-adapter'
import { afterEach, describe, expect, it } from 'vitest'

import { LarkBridge } from '../src/bridge.js'
import type { LarkCallOptions, LarkClient } from '../src/client.js'
import type {
  LarkEventEnvelope,
  LarkMessageReceiveEvent,
  LarkUrlVerification,
} from '../src/types.js'

const TOKEN = 'verif-token-123'
const SENDER_OPEN_ID = 'ou_alice'
const CHAT_ID = 'oc_room1'

class FakeLarkClient implements LarkClient {
  calls: Array<{
    method: string
    path: string
    options?: LarkCallOptions
  }> = []
  /** Optional handler that builds the response for each call. */
  handler?: (
    method: string,
    path: string,
    options?: LarkCallOptions,
  ) => unknown | Promise<unknown>
  /** When set, throws on the matching call. */
  errors: Array<{ method: string; pathPrefix: string; err: unknown }> = []

  async call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options?: LarkCallOptions,
  ): Promise<T> {
    this.calls.push({ method, path, options })
    if (
      this.errors.length > 0 &&
      this.errors[0]!.method === method &&
      path.startsWith(this.errors[0]!.pathPrefix)
    ) {
      throw this.errors.shift()!.err
    }
    if (this.handler) return (await this.handler(method, path, options)) as T
    return { code: 0, msg: 'ok' } as unknown as T
  }

  invalidateToken(): void {
    /* noop */
  }
}

function buildEvent(over: Partial<{
  eventId: string
  eventType: string
  token: string
  message: { content?: string; message_type?: string }
  senderType: 'user' | 'app'
  openId: string | null
}> = {}): LarkEventEnvelope<LarkMessageReceiveEvent> {
  return {
    schema: '2.0',
    header: {
      event_id: over.eventId ?? 'evt-1',
      token: over.token ?? TOKEN,
      create_time: '1700000000000',
      event_type: over.eventType ?? 'im.message.receive_v1',
      tenant_key: 'tk',
      app_id: 'cli_x',
    },
    event: {
      sender: {
        sender_type: over.senderType ?? 'user',
        sender_id:
          over.openId === null
            ? {}
            : { open_id: over.openId ?? SENDER_OPEN_ID, user_id: 'u_x', union_id: 'on_x' },
        tenant_key: 'tk',
      },
      message: {
        message_id: 'om_1',
        create_time: '1700000000000',
        chat_id: CHAT_ID,
        chat_type: 'p2p',
        message_type: over.message?.message_type ?? 'text',
        content: over.message?.content ?? JSON.stringify({ text: 'hello bot' }),
      },
    },
  }
}

describe('LarkBridge', () => {
  let bridge: LarkBridge | null = null
  afterEach(async () => {
    if (bridge) {
      await bridge.stop()
      bridge = null
    }
  })

  it('rejects construction without verificationToken', () => {
    expect(
      () =>
        new LarkBridge({
          appId: 'cli_x',
          appSecret: 's',
          verificationToken: '',
          client: new FakeLarkClient(),
          webhookPort: 0,
        }),
    ).toThrow(/verificationToken is required/)
  })

  it('echoes the challenge on url_verification', async () => {
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: 0,
    })
    const verify: LarkUrlVerification = {
      type: 'url_verification',
      challenge: 'chal-xyz',
      token: TOKEN,
    }
    const result = await bridge.handleEvent(verify)
    expect(result).toEqual({ challenge: 'chal-xyz' })
  })

  it('rejects url_verification with mismatched token', async () => {
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: 0,
    })
    await expect(
      bridge.handleEvent({
        type: 'url_verification',
        challenge: 'x',
        token: 'wrong',
      }),
    ).rejects.toThrow(/token mismatch/)
  })

  it('rejects event envelope with mismatched header.token', async () => {
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: 0,
    })
    await expect(bridge.handleEvent(buildEvent({ token: 'wrong' }))).rejects.toThrow(
      /token mismatch/,
    )
  })

  it('rejects non-Schema-2.0 events', async () => {
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: 0,
    })
    await expect(
      bridge.handleEvent({ schema: '1.0', header: {}, event: {} }),
    ).rejects.toThrow(/Schema 2.0/)
  })

  it('delivers im.message.receive_v1 events as ImMessage', async () => {
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: 0,
    })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.handleEvent(buildEvent({}))
    expect(received).toHaveLength(1)
    expect(received[0]!.text).toBe('hello bot')
    expect(received[0]!.from.platformUserId).toBe(SENDER_OPEN_ID)
    expect(received[0]!.chatId).toBe(CHAT_ID)
  })

  it('dedups by event_id', async () => {
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: 0,
    })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    const evt = buildEvent({ eventId: 'dup-1' })
    await bridge.handleEvent(evt)
    await bridge.handleEvent(evt)
    await bridge.handleEvent(evt)
    expect(received).toHaveLength(1)
  })

  it('skips events from app senders (anti-loop)', async () => {
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: 0,
    })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.handleEvent(buildEvent({ senderType: 'app' }))
    expect(received).toEqual([])
  })

  it('silently acks unknown event types (no dispatch, no throw)', async () => {
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: 0,
    })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.handleEvent(
      buildEvent({ eventType: 'im.chat.updated_v1' }),
    )
    expect(received).toEqual([])
  })

  it('strips @bot mentions by default', async () => {
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: 0,
    })
    const received: ImMessage[] = []
    bridge.onMessage((m) => {
      received.push(m)
    })
    await bridge.handleEvent(
      buildEvent({
        message: {
          content: JSON.stringify({
            text: '<at user_id="ou_bot">@Bot</at> /help',
          }),
        },
      }),
    )
    expect(received[0]!.text).toBe('/help')
  })

  it('listener throw does not stop other listeners', async () => {
    const errors: unknown[] = []
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: 0,
      onError: (e) => errors.push(e),
    })
    const goodReceived: ImMessage[] = []
    bridge.onMessage(() => {
      throw new Error('listener boom')
    })
    bridge.onMessage((m) => {
      goodReceived.push(m)
    })
    await bridge.handleEvent(buildEvent({}))
    expect(goodReceived).toHaveLength(1)
    expect(errors.some((e) => String(e).includes('listener boom'))).toBe(true)
  })

  it('unsubscribe removes the listener', async () => {
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: 0,
    })
    const received: ImMessage[] = []
    const unsub = bridge.onMessage((m) => {
      received.push(m)
      if (received.length === 1) unsub()
    })
    await bridge.handleEvent(buildEvent({ eventId: 'a' }))
    await bridge.handleEvent(buildEvent({ eventId: 'b' }))
    expect(received).toHaveLength(1)
  })

  // -------- sendMessage --------

  it('sendMessage POSTs to /open-apis/im/v1/messages with chat_id receive type', async () => {
    const client = new FakeLarkClient()
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client,
      webhookPort: 0,
    })
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
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client,
      webhookPort: 0,
    })
    await bridge.sendMessage(
      { platform: 'lark', platformUserId: SENDER_OPEN_ID },
      'dm',
    )
    const c = client.calls[0]!
    expect(c.options?.query?.receive_id_type).toBe('open_id')
    const body = c.options?.body as { receive_id: string }
    expect(body.receive_id).toBe(SENDER_OPEN_ID)
  })

  it('sendMessage signals via onError on outbound attachments, still sends text', async () => {
    const client = new FakeLarkClient()
    const errors: unknown[] = []
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client,
      webhookPort: 0,
      onError: (e) => errors.push(e),
    })
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
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: 0,
    })
    await expect(
      bridge.sendMessage(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { platform: 'lark', platformUserId: '' as any },
        'no target',
      ),
    ).rejects.toThrow(/receive_id/)
  })

  // -------- start / stop --------

  it('start and stop are idempotent (no HTTP server)', async () => {
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: 0,
    })
    await bridge.start()
    await bridge.start()
    await bridge.stop()
    await bridge.stop()
  })

  // -------- HTTP listener wire-up --------

  it('HTTP listener routes valid event → 200 ack + dispatches', async () => {
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: 0, // ephemeral; we'll bind in a moment
    })
    // Use a more dynamic approach: 0 disables the listener, so flip
    // it via direct construction with a fresh port.
    await bridge.stop()
    bridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: 0,
    })
    // Actually for the HTTP test, we want a real port. Construct
    // one bridge for that explicit purpose.
    await bridge.stop()
    bridge = null

    const httpBridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: await pickEphemeralPort(),
      webhookHost: '127.0.0.1',
    })
    const received: ImMessage[] = []
    httpBridge.onMessage((m) => {
      received.push(m)
    })
    await httpBridge.start()
    try {
      const port = getBoundPort(httpBridge)
      const resp = await fetch(`http://127.0.0.1:${port}/lark/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildEvent({})),
      })
      expect(resp.status).toBe(200)
      expect(received).toHaveLength(1)
    } finally {
      await httpBridge.stop()
    }
  })

  it('HTTP listener responds 200 with challenge on url_verification', async () => {
    const httpBridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: await pickEphemeralPort(),
      webhookHost: '127.0.0.1',
    })
    await httpBridge.start()
    try {
      const port = getBoundPort(httpBridge)
      const resp = await fetch(`http://127.0.0.1:${port}/lark/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'url_verification',
          challenge: 'echo-me',
          token: TOKEN,
        }),
      })
      expect(resp.status).toBe(200)
      const body = (await resp.json()) as { challenge?: string }
      expect(body.challenge).toBe('echo-me')
    } finally {
      await httpBridge.stop()
    }
  })

  it('HTTP listener responds 401 when verification token is wrong', async () => {
    const errors: unknown[] = []
    const httpBridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: await pickEphemeralPort(),
      webhookHost: '127.0.0.1',
      onError: (e) => errors.push(e),
    })
    await httpBridge.start()
    try {
      const port = getBoundPort(httpBridge)
      const resp = await fetch(`http://127.0.0.1:${port}/lark/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildEvent({ token: 'wrong' })),
      })
      expect(resp.status).toBe(401)
      expect(errors.some((e) => String(e).includes('token mismatch'))).toBe(true)
    } finally {
      await httpBridge.stop()
    }
  })

  it('HTTP listener health check (GET) returns 200', async () => {
    const httpBridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: await pickEphemeralPort(),
      webhookHost: '127.0.0.1',
    })
    await httpBridge.start()
    try {
      const port = getBoundPort(httpBridge)
      const resp = await fetch(`http://127.0.0.1:${port}/anything`)
      expect(resp.status).toBe(200)
      const text = await resp.text()
      expect(text).toContain('lark-bridge ok')
    } finally {
      await httpBridge.stop()
    }
  })

  it('HTTP listener returns 404 for non-matching POST paths', async () => {
    const httpBridge = new LarkBridge({
      appId: 'cli_x',
      appSecret: 's',
      verificationToken: TOKEN,
      client: new FakeLarkClient(),
      webhookPort: await pickEphemeralPort(),
      webhookHost: '127.0.0.1',
    })
    await httpBridge.start()
    try {
      const port = getBoundPort(httpBridge)
      const resp = await fetch(`http://127.0.0.1:${port}/wrong/path`, {
        method: 'POST',
        body: '{}',
      })
      expect(resp.status).toBe(404)
    } finally {
      await httpBridge.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Allocate an ephemeral port by briefly binding a server. Returns
 * the OS-assigned port number. Avoids hardcoding port numbers that
 * could collide with other test workers.
 */
async function pickEphemeralPort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, () => {
      const addr = srv.address()
      srv.close(() => {
        if (typeof addr === 'object' && addr !== null) resolve(addr.port)
        else reject(new Error('could not allocate ephemeral port'))
      })
    })
  })
}

/** Pull the actual listening port out of a LarkBridge — we set port
 *  via constructor option, so just return that. (If we'd asked the OS
 *  for port 0, we'd need to dig into the internal server.) */
function getBoundPort(bridge: LarkBridge): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (bridge as any).webhookPort as number
}
