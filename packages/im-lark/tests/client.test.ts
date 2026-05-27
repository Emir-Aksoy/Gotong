/**
 * Phase 12 M4 — LarkClient coverage with injected fetch.
 *
 * Focus: tenant_access_token caching + refresh, business-logic error
 * unification (HTTP 200 + code != 0), retry-coalescing of concurrent
 * refreshes.
 */

import { describe, expect, it, vi } from 'vitest'

import { createLarkClient, LarkApiError } from '../src/client.js'

interface Stub {
  status?: number
  body?: unknown
}

/**
 * Build a fetch that returns responses from `responses` in order
 * (FIFO). When the array is exhausted it returns the last entry —
 * useful for "this endpoint always succeeds after the first refresh."
 */
function mockFetch(responses: Stub[]): typeof fetch & { calls: Array<[string, RequestInit]> } {
  const calls: Array<[string, RequestInit]> = []
  let i = 0
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push([url, init ?? {}])
    const r = responses[Math.min(i, responses.length - 1)]!
    i++
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch & { calls: Array<[string, RequestInit]> }
  ;(fn as unknown as { calls: typeof calls }).calls = calls
  return fn
}

const okToken = (expire = 7200): Stub => ({
  status: 200,
  body: { code: 0, msg: 'ok', tenant_access_token: 'tok_abc', expire },
})

describe('createLarkClient', () => {
  it('throws on missing appId or appSecret', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createLarkClient({} as any)).toThrow(/appId is required/)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createLarkClient({ appId: 'cli_x' } as any)).toThrow(/appSecret is required/)
    expect(() =>
      createLarkClient({ appId: '', appSecret: 'x' }),
    ).toThrow(/appId is required/)
    expect(() =>
      createLarkClient({ appId: 'cli_x', appSecret: '' }),
    ).toThrow(/appSecret is required/)
  })

  it('fetches a tenant_access_token on the first business call and caches it', async () => {
    const fetchImpl = mockFetch([
      okToken(),
      { status: 200, body: { code: 0, msg: 'ok', data: { message_id: 'om_1' } } },
      { status: 200, body: { code: 0, msg: 'ok', data: { message_id: 'om_2' } } },
    ])
    const c = createLarkClient({
      appId: 'cli_x',
      appSecret: 's',
      fetchImpl,
    })
    await c.call('POST', '/open-apis/im/v1/messages', { body: {} })
    await c.call('POST', '/open-apis/im/v1/messages', { body: {} })
    // Calls: [auth, msg, msg] — token is cached after the first auth.
    expect(fetchImpl.calls).toHaveLength(3)
    expect(fetchImpl.calls[0]![0]).toContain('/auth/v3/tenant_access_token/internal')
    // The two business calls carry the Bearer header.
    for (const [, init] of fetchImpl.calls.slice(1)) {
      const headers = init.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer tok_abc')
    }
  })

  it('refreshes the token once it has expired (safety margin applied)', async () => {
    // Set a TTL shorter than the default 2-min safety margin so the
    // cached token is "expired" immediately after fetch.
    const fetchImpl = mockFetch([
      okToken(1), // 1s ttl - 120s margin = "expired before issued"
      { status: 200, body: { code: 0, msg: 'ok' } },
      okToken(7200),
      { status: 200, body: { code: 0, msg: 'ok' } },
    ])
    const c = createLarkClient({
      appId: 'cli_x',
      appSecret: 's',
      fetchImpl,
    })
    await c.call('POST', '/open-apis/im/v1/messages', { body: {} })
    await c.call('POST', '/open-apis/im/v1/messages', { body: {} })
    // Token was refetched on the second call.
    const authCalls = fetchImpl.calls.filter(([url]) =>
      url.includes('/auth/v3/tenant_access_token'),
    )
    expect(authCalls).toHaveLength(2)
  })

  it('coalesces concurrent token refreshes', async () => {
    const fetchImpl = mockFetch([
      okToken(),
      { status: 200, body: { code: 0, msg: 'ok' } },
      { status: 200, body: { code: 0, msg: 'ok' } },
      { status: 200, body: { code: 0, msg: 'ok' } },
    ])
    const c = createLarkClient({
      appId: 'cli_x',
      appSecret: 's',
      fetchImpl,
    })
    // Three concurrent business calls — only ONE auth call should fire.
    await Promise.all([
      c.call('POST', '/open-apis/im/v1/messages', { body: { i: 1 } }),
      c.call('POST', '/open-apis/im/v1/messages', { body: { i: 2 } }),
      c.call('POST', '/open-apis/im/v1/messages', { body: { i: 3 } }),
    ])
    const authCalls = fetchImpl.calls.filter(([url]) =>
      url.includes('/auth/v3/tenant_access_token'),
    )
    expect(authCalls).toHaveLength(1)
  })

  it('invalidateToken() forces a refresh on the next call', async () => {
    const fetchImpl = mockFetch([
      okToken(),
      { status: 200, body: { code: 0, msg: 'ok' } },
      okToken(),
      { status: 200, body: { code: 0, msg: 'ok' } },
    ])
    const c = createLarkClient({
      appId: 'cli_x',
      appSecret: 's',
      fetchImpl,
    })
    await c.call('POST', '/open-apis/im/v1/messages', { body: {} })
    c.invalidateToken()
    await c.call('POST', '/open-apis/im/v1/messages', { body: {} })
    const authCalls = fetchImpl.calls.filter(([url]) =>
      url.includes('/auth/v3/tenant_access_token'),
    )
    expect(authCalls).toHaveLength(2)
  })

  it('uses the configured baseUrl (Lark international)', async () => {
    const fetchImpl = mockFetch([
      okToken(),
      { status: 200, body: { code: 0, msg: 'ok' } },
    ])
    const c = createLarkClient({
      appId: 'cli_x',
      appSecret: 's',
      baseUrl: 'https://open.larksuite.com',
      fetchImpl,
    })
    await c.call('POST', '/open-apis/im/v1/messages', { body: {} })
    expect(fetchImpl.calls[0]![0]).toBe(
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
    )
    expect(fetchImpl.calls[1]![0]).toBe(
      'https://open.larksuite.com/open-apis/im/v1/messages',
    )
  })

  it('strips trailing slash from baseUrl', async () => {
    const fetchImpl = mockFetch([okToken(), { body: { code: 0 } }])
    const c = createLarkClient({
      appId: 'cli_x',
      appSecret: 's',
      baseUrl: 'https://open.feishu.cn/',
      fetchImpl,
    })
    await c.call('GET', '/open-apis/contact/v3/users/me')
    expect(fetchImpl.calls[0]![0]).toBe(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    )
  })

  it('appends query params, skipping undefined', async () => {
    const fetchImpl = mockFetch([okToken(), { body: { code: 0 } }])
    const c = createLarkClient({
      appId: 'cli_x',
      appSecret: 's',
      fetchImpl,
    })
    await c.call('POST', '/open-apis/im/v1/messages', {
      query: { receive_id_type: 'chat_id', dropped: undefined },
      body: { receive_id: 'oc_x', msg_type: 'text', content: '{}' },
    })
    const u = new URL(fetchImpl.calls[1]![0])
    expect(u.searchParams.get('receive_id_type')).toBe('chat_id')
    expect(u.searchParams.has('dropped')).toBe(false)
  })

  it('throws LarkApiError with code+msg when HTTP 200 + code != 0', async () => {
    const fetchImpl = mockFetch([
      okToken(),
      {
        status: 200,
        body: { code: 230002, msg: 'Bot not in chat' },
      },
    ])
    const c = createLarkClient({
      appId: 'cli_x',
      appSecret: 's',
      fetchImpl,
    })
    try {
      await c.call('POST', '/open-apis/im/v1/messages', { body: {} })
      throw new Error('should not reach')
    } catch (err) {
      expect(err).toBeInstanceOf(LarkApiError)
      const apiErr = err as LarkApiError
      expect(apiErr.code).toBe(230002)
      expect(apiErr.msg).toBe('Bot not in chat')
      expect(apiErr.status).toBe(200)
      expect(apiErr.message).toMatch(/Bot not in chat/)
    }
  })

  it('throws LarkApiError when token-fetch returns code != 0', async () => {
    const fetchImpl = mockFetch([
      {
        status: 200,
        body: { code: 99991663, msg: 'invalid app_secret' },
      },
    ])
    const c = createLarkClient({
      appId: 'cli_x',
      appSecret: 'wrong',
      fetchImpl,
    })
    await expect(c.call('POST', '/open-apis/im/v1/messages', { body: {} })).rejects.toThrow(
      /invalid app_secret/,
    )
  })

  it('aborts after timeoutMs', async () => {
    const slow: typeof fetch = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        }) as Promise<Response>,
    ) as unknown as typeof fetch
    const c = createLarkClient({
      appId: 'cli_x',
      appSecret: 's',
      fetchImpl: slow,
      timeoutMs: 20,
    })
    await expect(c.call('POST', '/open-apis/im/v1/messages', { body: {} })).rejects.toThrow()
  })
})
