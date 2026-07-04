/**
 * Phase 12 M5 — DiscordClient coverage with injected fetch.
 *
 * Focus: auth header shape, rate-limit Retry-After surface, error
 * unification, query-param building.
 */

import { describe, expect, it, vi } from 'vitest'

import { createDiscordClient, DiscordApiError } from '../src/client.js'

interface Stub {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

/**
 * Build a fetch that returns responses from `responses` in order.
 * When the array is exhausted it keeps returning the last entry.
 */
function mockFetch(
  responses: Stub[],
): typeof fetch & { calls: Array<[string, RequestInit]> } {
  const calls: Array<[string, RequestInit]> = []
  let i = 0
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push([url, init ?? {}])
    const r = responses[Math.min(i, responses.length - 1)]!
    i++
    const status = r.status ?? 200
    // 204 No Content per the spec must have a null body — Response
    // throws otherwise on Node's undici impl.
    const body = status === 204 ? null : JSON.stringify(r.body ?? {})
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    })
  }) as unknown as typeof fetch & { calls: Array<[string, RequestInit]> }
  ;(fn as unknown as { calls: typeof calls }).calls = calls
  return fn
}

describe('createDiscordClient', () => {
  it('throws on missing token', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createDiscordClient({} as any)).toThrow(/token is required/)
    expect(() => createDiscordClient({ token: '' })).toThrow(/token is required/)
  })

  it('sends Bot Authorization + User-Agent on every call', async () => {
    const fetchImpl = mockFetch([
      { status: 200, body: { id: '1', content: 'ok' } },
    ])
    const c = createDiscordClient({ token: 'xyz', fetchImpl })
    await c.call('POST', '/channels/1/messages', { body: { content: 'hi' } })
    expect(fetchImpl.calls).toHaveLength(1)
    const [url, init] = fetchImpl.calls[0]!
    expect(url).toBe('https://discord.com/api/v10/channels/1/messages')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bot xyz')
    expect(headers['user-agent']).toMatch(/gotong-im-discord/)
  })

  it('honours configured baseUrl + strips trailing slash', async () => {
    const fetchImpl = mockFetch([{ status: 200, body: {} }])
    const c = createDiscordClient({
      token: 'xyz',
      baseUrl: 'https://example.com/api/',
      fetchImpl,
    })
    await c.call('GET', '/gateway/bot')
    expect(fetchImpl.calls[0]![0]).toBe('https://example.com/api/gateway/bot')
  })

  it('appends query params, skipping undefined', async () => {
    const fetchImpl = mockFetch([{ status: 200, body: {} }])
    const c = createDiscordClient({ token: 'xyz', fetchImpl })
    await c.call('GET', '/channels/1/messages', {
      query: { limit: 50, before: 'x', dropped: undefined },
    })
    const u = new URL(fetchImpl.calls[0]![0])
    expect(u.searchParams.get('limit')).toBe('50')
    expect(u.searchParams.get('before')).toBe('x')
    expect(u.searchParams.has('dropped')).toBe(false)
  })

  it('serialises JSON body with content-type header', async () => {
    const fetchImpl = mockFetch([{ status: 200, body: { id: '1' } }])
    const c = createDiscordClient({ token: 'xyz', fetchImpl })
    await c.call('POST', '/channels/1/messages', { body: { content: 'hi' } })
    const [, init] = fetchImpl.calls[0]!
    expect((init.headers as Record<string, string>)['content-type']).toMatch(/application\/json/)
    expect(init.body).toBe(JSON.stringify({ content: 'hi' }))
  })

  it('returns undefined for 204 No Content', async () => {
    const fetchImpl = mockFetch([{ status: 204 }])
    const c = createDiscordClient({ token: 'xyz', fetchImpl })
    const out = await c.call('DELETE', '/messages/1')
    expect(out).toBeUndefined()
  })

  it('throws DiscordApiError with code + message on 4xx', async () => {
    const fetchImpl = mockFetch([
      {
        status: 403,
        body: { code: 50001, message: 'Missing Access' },
      },
    ])
    const c = createDiscordClient({ token: 'xyz', fetchImpl })
    try {
      await c.call('POST', '/channels/1/messages', { body: {} })
      throw new Error('should not reach')
    } catch (err) {
      expect(err).toBeInstanceOf(DiscordApiError)
      const apiErr = err as DiscordApiError
      expect(apiErr.code).toBe(50001)
      expect(apiErr.status).toBe(403)
      expect(apiErr.message).toMatch(/Missing Access/)
    }
  })

  it('surfaces 429 retry-after from body (seconds, float)', async () => {
    const fetchImpl = mockFetch([
      {
        status: 429,
        body: { code: 0, retry_after: 1.5, message: 'You are being rate limited.' },
      },
    ])
    const c = createDiscordClient({ token: 'xyz', fetchImpl })
    try {
      await c.call('POST', '/channels/1/messages', { body: {} })
      throw new Error('should not reach')
    } catch (err) {
      const apiErr = err as DiscordApiError
      expect(apiErr.status).toBe(429)
      expect(apiErr.retryAfterMs).toBe(1500)
    }
  })

  it('falls back to Retry-After header when body lacks retry_after', async () => {
    const fetchImpl = mockFetch([
      {
        status: 429,
        headers: { 'retry-after': '2' },
        body: { message: 'rate limited' },
      },
    ])
    const c = createDiscordClient({ token: 'xyz', fetchImpl })
    try {
      await c.call('POST', '/channels/1/messages', { body: {} })
      throw new Error('should not reach')
    } catch (err) {
      const apiErr = err as DiscordApiError
      expect(apiErr.retryAfterMs).toBe(2000)
    }
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
    const c = createDiscordClient({ token: 'xyz', fetchImpl: slow, timeoutMs: 20 })
    await expect(c.call('GET', '/gateway/bot')).rejects.toThrow()
  })

  it('exposes the resolved baseUrl', () => {
    const c = createDiscordClient({ token: 'xyz', baseUrl: 'https://x.com/api/v10///' })
    expect(c.baseUrl).toBe('https://x.com/api/v10')
  })

  it('throws DiscordApiError when the body is unparseable JSON', async () => {
    const fetchImpl = vi.fn(async () => {
      // Body is JSON Content-Type but text isn't valid — happens
      // occasionally from edge servers.
      return new Response('<html>500</html>', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const c = createDiscordClient({ token: 'xyz', fetchImpl })
    await expect(c.call('GET', '/gateway/bot')).rejects.toThrow(/unparseable JSON/)
  })
})
