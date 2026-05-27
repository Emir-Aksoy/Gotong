/**
 * Phase 12 M6 — SlackClient coverage with injected fetch.
 *
 * Focus: Bearer auth header shape, JSON body+charset, ok:false unification,
 * 429 Retry-After surface, baseUrl normalisation.
 */

import { describe, expect, it, vi } from 'vitest'

import { createSlackClient, SlackApiError } from '../src/client.js'

interface Stub {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

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
    const body = status === 204 ? null : JSON.stringify(r.body ?? { ok: true })
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    })
  }) as unknown as typeof fetch & { calls: Array<[string, RequestInit]> }
  ;(fn as unknown as { calls: typeof calls }).calls = calls
  return fn
}

describe('createSlackClient', () => {
  it('throws on missing token', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createSlackClient({} as any)).toThrow(/token is required/)
    expect(() => createSlackClient({ token: '' })).toThrow(/token is required/)
  })

  it('sends Bearer Authorization + JSON content-type on every call', async () => {
    const fetchImpl = mockFetch([{ body: { ok: true, ts: '1' } }])
    const c = createSlackClient({ token: 'xoxb-xyz', fetchImpl })
    await c.call('/chat.postMessage', { body: { channel: 'C1', text: 'hi' } })
    expect(fetchImpl.calls).toHaveLength(1)
    const [url, init] = fetchImpl.calls[0]!
    expect(url).toBe('https://slack.com/api/chat.postMessage')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer xoxb-xyz')
    expect(headers['content-type']).toMatch(/application\/json/)
    expect(init.body).toBe(JSON.stringify({ channel: 'C1', text: 'hi' }))
  })

  it('normalises a path with or without leading slash', async () => {
    const fetchImpl = mockFetch([{ body: { ok: true } }, { body: { ok: true } }])
    const c = createSlackClient({ token: 'xoxb-xyz', fetchImpl })
    await c.call('chat.postMessage', { body: {} })
    await c.call('/chat.postMessage', { body: {} })
    expect(fetchImpl.calls[0]![0]).toBe('https://slack.com/api/chat.postMessage')
    expect(fetchImpl.calls[1]![0]).toBe('https://slack.com/api/chat.postMessage')
  })

  it('honours configured baseUrl + strips trailing slashes', async () => {
    const fetchImpl = mockFetch([{ body: { ok: true } }])
    const c = createSlackClient({
      token: 'xoxb-xyz',
      baseUrl: 'https://example.com/slack/',
      fetchImpl,
    })
    await c.call('/auth.test')
    expect(fetchImpl.calls[0]![0]).toBe('https://example.com/slack/auth.test')
  })

  it('serialises an empty body as {} when none is provided', async () => {
    const fetchImpl = mockFetch([{ body: { ok: true } }])
    const c = createSlackClient({ token: 'xoxb-xyz', fetchImpl })
    await c.call('/auth.test')
    expect(fetchImpl.calls[0]![1].body).toBe('{}')
  })

  it('throws SlackApiError when ok: false (HTTP 200)', async () => {
    const fetchImpl = mockFetch([{ body: { ok: false, error: 'channel_not_found' } }])
    const c = createSlackClient({ token: 'xoxb-xyz', fetchImpl })
    try {
      await c.call('/chat.postMessage', { body: { channel: 'C_BAD', text: 'x' } })
      throw new Error('should not reach')
    } catch (err) {
      expect(err).toBeInstanceOf(SlackApiError)
      const e = err as SlackApiError
      expect(e.code).toBe('channel_not_found')
      expect(e.status).toBe(200)
      expect(e.message).toMatch(/channel_not_found/)
    }
  })

  it('throws SlackApiError on non-2xx HTTP', async () => {
    const fetchImpl = mockFetch([
      { status: 503, body: { ok: false, error: 'service_unavailable' } },
    ])
    const c = createSlackClient({ token: 'xoxb-xyz', fetchImpl })
    try {
      await c.call('/chat.postMessage', { body: {} })
      throw new Error('should not reach')
    } catch (err) {
      expect(err).toBeInstanceOf(SlackApiError)
      const e = err as SlackApiError
      expect(e.status).toBe(503)
      expect(e.code).toBe('service_unavailable')
    }
  })

  it('surfaces 429 retry-after as retryAfterMs', async () => {
    const fetchImpl = mockFetch([
      {
        status: 429,
        headers: { 'retry-after': '3' },
        body: { ok: false, error: 'ratelimited' },
      },
    ])
    const c = createSlackClient({ token: 'xoxb-xyz', fetchImpl })
    try {
      await c.call('/chat.postMessage', { body: {} })
      throw new Error('should not reach')
    } catch (err) {
      const e = err as SlackApiError
      expect(e.status).toBe(429)
      expect(e.retryAfterMs).toBe(3000)
      expect(e.code).toBe('ratelimited')
    }
  })

  it('handles 429 with no Retry-After header gracefully (null retryAfterMs)', async () => {
    const fetchImpl = mockFetch([{ status: 429, body: { ok: false, error: 'ratelimited' } }])
    const c = createSlackClient({ token: 'xoxb-xyz', fetchImpl })
    try {
      await c.call('/chat.postMessage', { body: {} })
      throw new Error('should not reach')
    } catch (err) {
      const e = err as SlackApiError
      expect(e.retryAfterMs).toBeNull()
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
    const c = createSlackClient({ token: 'xoxb-xyz', fetchImpl: slow, timeoutMs: 20 })
    await expect(c.call('/chat.postMessage', { body: {} })).rejects.toThrow()
  })

  it('exposes the resolved baseUrl', () => {
    const c = createSlackClient({ token: 'xoxb-xyz', baseUrl: 'https://x.com/api/v0///' })
    expect(c.baseUrl).toBe('https://x.com/api/v0')
  })

  it('throws SlackApiError when the body is unparseable JSON', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response('<html>5xx</html>', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const c = createSlackClient({ token: 'xoxb-xyz', fetchImpl })
    await expect(c.call('/chat.postMessage', { body: {} })).rejects.toThrow(/unparseable JSON/)
  })

  it('returns the parsed envelope on ok:true', async () => {
    const fetchImpl = mockFetch([{ body: { ok: true, channel: 'C1', ts: '123.456' } }])
    const c = createSlackClient({ token: 'xoxb-xyz', fetchImpl })
    const out = await c.call<{ ok: true; channel?: string; ts?: string }>('/chat.postMessage', {
      body: { channel: 'C1', text: 'x' },
    })
    expect(out.ok).toBe(true)
    expect(out.channel).toBe('C1')
    expect(out.ts).toBe('123.456')
  })
})
