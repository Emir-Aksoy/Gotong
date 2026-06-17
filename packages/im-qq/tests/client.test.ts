/**
 * QQ official Bot API client — token cache + REST send shapes.
 *
 * Hermetic: a fake `fetch` records every call and returns scripted
 * `Response`s. No real AppID / secret, no network.
 */

import { describe, expect, it } from 'vitest'

import { createQqClient, QqApiError } from '../src/client.js'

interface Call {
  url: string
  init: RequestInit
}

/** A recording fetch driven by a per-URL handler. */
function makeFetch(handler: (url: string, init: RequestInit) => Response): {
  fetchImpl: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const i = (init ?? {}) as RequestInit
    calls.push({ url: String(url), init: i })
    return handler(String(url), i)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function tokenResponse(token = 'TOK1', expiresIn: number | string = 7200): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function jsonBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

const BASE_OPTS = { appId: 'APPID', clientSecret: 'SECRET' }

describe('createQqClient — construction', () => {
  it('requires appId and clientSecret', () => {
    // @ts-expect-error missing appId
    expect(() => createQqClient({ clientSecret: 'x' })).toThrow(/appId/)
    // @ts-expect-error missing clientSecret
    expect(() => createQqClient({ appId: 'x' })).toThrow(/clientSecret/)
  })
})

describe('app access token cache', () => {
  it('mints once and serves the cached token on the next call', async () => {
    let tokenPosts = 0
    const { fetchImpl, calls } = makeFetch((url) => {
      if (url.endsWith('/app/getAppAccessToken')) {
        tokenPosts += 1
        return tokenResponse('TOK1')
      }
      return new Response('{}', { status: 200 })
    })
    let clock = 1000
    const client = createQqClient({ ...BASE_OPTS, fetchImpl, now: () => clock })

    expect(await client.getAccessToken()).toBe('TOK1')
    clock += 5000 // still well within TTL (7200s − 120s margin)
    expect(await client.getAccessToken()).toBe('TOK1')
    expect(tokenPosts).toBe(1)

    // The token POST goes to the token host with appId + clientSecret.
    const tokenCall = calls.find((c) => c.url.endsWith('/app/getAppAccessToken'))!
    expect(tokenCall.url).toBe('https://bots.qq.com/app/getAppAccessToken')
    expect(jsonBody(tokenCall.init)).toEqual({ appId: 'APPID', clientSecret: 'SECRET' })
  })

  it('coalesces concurrent refreshes into a single auth POST', async () => {
    let tokenPosts = 0
    const { fetchImpl } = makeFetch((url) => {
      if (url.endsWith('/app/getAppAccessToken')) {
        tokenPosts += 1
        return tokenResponse('TOK1')
      }
      return new Response('{}', { status: 200 })
    })
    const client = createQqClient({ ...BASE_OPTS, fetchImpl })

    const [a, b, c] = await Promise.all([
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
    ])
    expect([a, b, c]).toEqual(['TOK1', 'TOK1', 'TOK1'])
    expect(tokenPosts).toBe(1)
  })

  it('re-mints once the cached token has expired', async () => {
    let n = 0
    const { fetchImpl } = makeFetch((url) => {
      if (url.endsWith('/app/getAppAccessToken')) {
        n += 1
        return tokenResponse(`TOK${n}`, 7200)
      }
      return new Response('{}', { status: 200 })
    })
    let clock = 1000
    const client = createQqClient({ ...BASE_OPTS, fetchImpl, now: () => clock })

    expect(await client.getAccessToken()).toBe('TOK1')
    // Advance past expiry: TTL 7200s − 120s margin = 7_080_000 ms.
    clock += 7_080_001
    expect(await client.getAccessToken()).toBe('TOK2')
    expect(n).toBe(2)
  })

  it('re-mints after invalidateToken()', async () => {
    let n = 0
    const { fetchImpl } = makeFetch((url) => {
      if (url.endsWith('/app/getAppAccessToken')) {
        n += 1
        return tokenResponse(`TOK${n}`)
      }
      return new Response('{}', { status: 200 })
    })
    const client = createQqClient({ ...BASE_OPTS, fetchImpl })
    expect(await client.getAccessToken()).toBe('TOK1')
    client.invalidateToken()
    expect(await client.getAccessToken()).toBe('TOK2')
    expect(n).toBe(2)
  })

  it('coerces a numeric-string expires_in', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.endsWith('/app/getAppAccessToken')) return tokenResponse('TOK1', '7200')
      return new Response('{}', { status: 200 })
    })
    let clock = 1000
    const client = createQqClient({ ...BASE_OPTS, fetchImpl, now: () => clock })
    expect(await client.getAccessToken()).toBe('TOK1')
    clock += 5000
    // Cache still valid → no throw, same token (would re-mint if ttl parsed to 0).
    expect(await client.getAccessToken()).toBe('TOK1')
  })

  it('throws QqApiError when the token mint fails', async () => {
    const { fetchImpl } = makeFetch(() =>
      new Response(JSON.stringify({ code: 100007, message: 'appid invalid' }), { status: 401 }),
    )
    const client = createQqClient({ ...BASE_OPTS, fetchImpl })
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(QqApiError)
  })
})

describe('REST send shapes', () => {
  /** Build a client whose token always succeeds; sends echo a captured response. */
  function sendingClient(sendResponse: () => Response) {
    return makeFetch((url) => {
      if (url.endsWith('/app/getAppAccessToken')) return tokenResponse('TOK1')
      return sendResponse()
    })
  }

  it('group send → /v2/groups/{id}/messages with msg_type + msg_id + msg_seq', async () => {
    const { fetchImpl, calls } = sendingClient(() => new Response('{}', { status: 200 }))
    const client = createQqClient({ ...BASE_OPTS, fetchImpl })
    await client.sendGroupMessage('G_ABC', { content: 'hi', msg_id: 'M1', msg_seq: 2 })

    const call = calls.find((c) => c.url.includes('/v2/groups/'))!
    expect(call.url).toBe('https://api.sgroup.qq.com/v2/groups/G_ABC/messages')
    expect(call.init.method).toBe('POST')
    expect((call.init.headers as Record<string, string>).authorization).toBe('QQBot TOK1')
    expect(jsonBody(call.init)).toEqual({
      content: 'hi',
      msg_type: 0,
      msg_id: 'M1',
      msg_seq: 2,
    })
  })

  it('C2C send → /v2/users/{id}/messages', async () => {
    const { fetchImpl, calls } = sendingClient(() => new Response('{}', { status: 200 }))
    const client = createQqClient({ ...BASE_OPTS, fetchImpl })
    await client.sendC2CMessage('U_1', { content: 'yo', msg_id: 'M2', msg_seq: 1 })

    const call = calls.find((c) => c.url.includes('/v2/users/'))!
    expect(call.url).toBe('https://api.sgroup.qq.com/v2/users/U_1/messages')
    expect(jsonBody(call.init)).toEqual({
      content: 'yo',
      msg_type: 0,
      msg_id: 'M2',
      msg_seq: 1,
    })
  })

  it('channel send → /channels/{id}/messages with content + msg_id only', async () => {
    const { fetchImpl, calls } = sendingClient(() => new Response('{}', { status: 200 }))
    const client = createQqClient({ ...BASE_OPTS, fetchImpl })
    await client.sendChannelMessage('CH_1', { content: 'c', msg_id: 'M3' })

    const call = calls.find((c) => c.url.includes('/channels/'))!
    expect(call.url).toBe('https://api.sgroup.qq.com/channels/CH_1/messages')
    expect(jsonBody(call.init)).toEqual({ content: 'c', msg_id: 'M3' })
  })

  it('guild DM send → /dms/{id}/messages', async () => {
    const { fetchImpl, calls } = sendingClient(() => new Response('{}', { status: 200 }))
    const client = createQqClient({ ...BASE_OPTS, fetchImpl })
    await client.sendGuildDirectMessage('GU_1', { content: 'd', msg_id: 'M4' })

    const call = calls.find((c) => c.url.includes('/dms/'))!
    expect(call.url).toBe('https://api.sgroup.qq.com/dms/GU_1/messages')
    expect(jsonBody(call.init)).toEqual({ content: 'd', msg_id: 'M4' })
  })

  it('tolerates an empty 2xx body', async () => {
    const { fetchImpl } = sendingClient(() => new Response('', { status: 200 }))
    const client = createQqClient({ ...BASE_OPTS, fetchImpl })
    await expect(
      client.sendGroupMessage('G', { content: 'x', msg_id: 'M', msg_seq: 1 }),
    ).resolves.toEqual({})
  })

  it('throws QqApiError on a non-2xx send', async () => {
    const { fetchImpl } = sendingClient(() => new Response('', { status: 403 }))
    const client = createQqClient({ ...BASE_OPTS, fetchImpl })
    await expect(
      client.sendGroupMessage('G', { content: 'x', msg_id: 'M', msg_seq: 1 }),
    ).rejects.toMatchObject({ name: 'QqApiError', status: 403 })
  })

  it('throws QqApiError on a 2xx with a non-zero business code', async () => {
    const { fetchImpl } = sendingClient(
      () => new Response(JSON.stringify({ code: 40034, message: 'rejected' }), { status: 200 }),
    )
    const client = createQqClient({ ...BASE_OPTS, fetchImpl })
    await expect(
      client.sendC2CMessage('U', { content: 'x', msg_id: 'M', msg_seq: 1 }),
    ).rejects.toMatchObject({ name: 'QqApiError', code: 40034 })
  })
})
