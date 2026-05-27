/**
 * Phase 12 M3 — MatrixClient coverage with injected fetch.
 */

import { describe, expect, it, vi } from 'vitest'

import { createMatrixClient, MatrixApiError } from '../src/client.js'

interface MockResponse {
  status?: number
  body?: unknown
  /** Raw header overrides (e.g. retry-after). */
  headers?: Record<string, string>
}

function mockFetch(responses: MockResponse[]): typeof fetch {
  let i = 0
  return vi.fn(async () => {
    const r = responses[i++ % responses.length]!
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    })
  }) as unknown as typeof fetch
}

describe('createMatrixClient', () => {
  it('throws on missing homeserverUrl or accessToken', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createMatrixClient({} as any)).toThrow(/homeserverUrl is required/)
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createMatrixClient({ homeserverUrl: 'https://m.org' } as any),
    ).toThrow(/accessToken is required/)
    expect(() =>
      createMatrixClient({ homeserverUrl: '', accessToken: 'x' }),
    ).toThrow(/homeserverUrl is required/)
    expect(() =>
      createMatrixClient({ homeserverUrl: 'https://m.org', accessToken: '' }),
    ).toThrow(/accessToken is required/)
  })

  it('strips trailing slash from homeserverUrl', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ user_id: '@bot:matrix.org' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const c = createMatrixClient({
      homeserverUrl: 'https://matrix.example/',
      accessToken: 'tok',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })
    await c.call('GET', '/_matrix/client/v3/account/whoami')
    const [url] = fetchSpy.mock.calls[0]!
    expect(url).toBe('https://matrix.example/_matrix/client/v3/account/whoami')
  })

  it('hits the right method+path with Bearer auth and JSON body', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ event_id: '$evt:m.org' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const c = createMatrixClient({
      homeserverUrl: 'https://matrix.example',
      accessToken: 'BOT_TOKEN',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })
    await c.call('PUT', '/_matrix/client/v3/rooms/!r:m.org/send/m.room.message/txn1', {
      body: { msgtype: 'm.text', body: 'hi' },
    })
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe(
      'https://matrix.example/_matrix/client/v3/rooms/!r:m.org/send/m.room.message/txn1',
    )
    expect(init?.method).toBe('PUT')
    const headers = init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer BOT_TOKEN')
    expect(headers['content-type']).toBe('application/json')
    expect(JSON.parse(init?.body as string)).toEqual({ msgtype: 'm.text', body: 'hi' })
  })

  it('builds querystring from options.query (skipping undefined)', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ next_batch: 's1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const c = createMatrixClient({
      homeserverUrl: 'https://m.example',
      accessToken: 't',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })
    await c.call('GET', '/_matrix/client/v3/sync', {
      query: { timeout: 30000, since: 's0', dropped: undefined, filter: '{}' },
    })
    const [url] = fetchSpy.mock.calls[0]!
    expect(url).toContain('?')
    // Order isn't guaranteed by URLSearchParams across runtimes — check
    // membership instead.
    const u = new URL(url as string)
    expect(u.searchParams.get('timeout')).toBe('30000')
    expect(u.searchParams.get('since')).toBe('s0')
    expect(u.searchParams.get('filter')).toBe('{}')
    expect(u.searchParams.has('dropped')).toBe(false)
  })

  it('throws MatrixApiError with errcode + status + retry-after-ms on rate limit', async () => {
    const c = createMatrixClient({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      fetchImpl: mockFetch([
        {
          status: 429,
          body: {
            errcode: 'M_LIMIT_EXCEEDED',
            error: 'Too Many Requests',
            retry_after_ms: 5000,
          },
        },
      ]),
    })
    try {
      await c.call('GET', '/_matrix/client/v3/sync')
      throw new Error('should not reach')
    } catch (err) {
      expect(err).toBeInstanceOf(MatrixApiError)
      const apiErr = err as MatrixApiError
      expect(apiErr.status).toBe(429)
      expect(apiErr.errcode).toBe('M_LIMIT_EXCEEDED')
      expect(apiErr.retryAfterMs).toBe(5000)
      expect(apiErr.message).toMatch(/M_LIMIT_EXCEEDED/)
    }
  })

  it('picks max(body.retry_after_ms, header.Retry-After*1000) when both present', async () => {
    const c = createMatrixClient({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      fetchImpl: mockFetch([
        {
          status: 429,
          headers: { 'retry-after': '10' }, // 10 seconds → 10_000 ms
          body: {
            errcode: 'M_LIMIT_EXCEEDED',
            retry_after_ms: 3000, // smaller; should be ignored
          },
        },
      ]),
    })
    try {
      await c.call('GET', '/_matrix/client/v3/sync')
      throw new Error('should not reach')
    } catch (err) {
      expect((err as MatrixApiError).retryAfterMs).toBe(10_000)
    }
  })

  it('throws MatrixApiError on 4xx without a JSON body', async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        new Response('<html>nope</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    ) as unknown as typeof fetch
    const c = createMatrixClient({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      fetchImpl,
    })
    try {
      await c.call('GET', '/_matrix/client/v3/sync')
      throw new Error('should not reach')
    } catch (err) {
      expect(err).toBeInstanceOf(MatrixApiError)
      expect((err as MatrixApiError).status).toBe(502)
      expect((err as MatrixApiError).errcode).toBeNull()
      expect((err as MatrixApiError).retryAfterMs).toBeNull()
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
    const c = createMatrixClient({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      fetchImpl: slow,
      timeoutMs: 20,
    })
    await expect(c.call('GET', '/_matrix/client/v3/sync')).rejects.toThrow()
  })

  it('honours per-call timeoutMs override (long-poll case)', async () => {
    let observedTimeoutFired = false
    const slow: typeof fetch = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener('abort', () => {
            observedTimeoutFired = true
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        }) as Promise<Response>,
    ) as unknown as typeof fetch
    const c = createMatrixClient({
      homeserverUrl: 'https://m.org',
      accessToken: 't',
      fetchImpl: slow,
      timeoutMs: 5_000, // default; not used here
    })
    // Per-call override should beat the default.
    await expect(
      c.call('GET', '/_matrix/client/v3/sync', { timeoutMs: 20 }),
    ).rejects.toThrow()
    expect(observedTimeoutFired).toBe(true)
  })
})
