/**
 * Phase 12 M2 — TelegramClient coverage with injected fetch.
 */

import { describe, expect, it, vi } from 'vitest'

import { createTelegramClient, TelegramApiError } from '../src/client.js'

function mockFetch(responses: Array<{ status?: number; body: unknown }>): typeof fetch {
  let i = 0
  return vi.fn(async () => {
    const r = responses[i++ % responses.length]!
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

describe('createTelegramClient', () => {
  it('throws on missing token', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createTelegramClient({} as any)).toThrow(/token is required/)
    expect(() =>
      createTelegramClient({ token: '', fetchImpl: globalThis.fetch }),
    ).toThrow(/token is required/)
  })

  it('hits POST <baseUrl>/bot<token>/<method> with JSON body', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { id: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const c = createTelegramClient({
      token: 'BOT_TOKEN',
      baseUrl: 'https://tg.example.test',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })
    const r = await c.call<{ id: number }>('sendMessage', { chat_id: 1, text: 'hi' })
    expect(r).toEqual({ id: 1 })
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe('https://tg.example.test/botBOT_TOKEN/sendMessage')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ chat_id: 1, text: 'hi' })
  })

  it('throws TelegramApiError on ok:false', async () => {
    const c = createTelegramClient({
      token: 't',
      fetchImpl: mockFetch([
        {
          body: {
            ok: false,
            description: 'Unauthorized',
            error_code: 401,
          },
        },
      ]),
    })
    try {
      await c.call('sendMessage', { chat_id: 1 })
      throw new Error('should not reach')
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramApiError)
      const apiErr = err as TelegramApiError
      expect(apiErr.method).toBe('sendMessage')
      expect(apiErr.errorCode).toBe(401)
      expect(apiErr.retryAfter).toBeNull()
      expect(apiErr.message).toMatch(/Unauthorized/)
    }
  })

  it('surfaces retry_after on 429', async () => {
    const c = createTelegramClient({
      token: 't',
      fetchImpl: mockFetch([
        {
          status: 200, // Telegram returns 200 + ok:false even on rate limit
          body: {
            ok: false,
            description: 'Too Many Requests: retry after 7',
            error_code: 429,
            parameters: { retry_after: 7 },
          },
        },
      ]),
    })
    try {
      await c.call('getUpdates', {})
      throw new Error('should not reach')
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramApiError)
      expect((err as TelegramApiError).retryAfter).toBe(7)
    }
  })

  it('aborts after timeoutMs', async () => {
    // fetchImpl that never resolves; the AbortController should fire.
    const slow: typeof fetch = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          // Reject only when aborted; otherwise hang.
          const signal = init?.signal
          signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        }) as Promise<Response>,
    ) as unknown as typeof fetch
    const c = createTelegramClient({
      token: 't',
      fetchImpl: slow,
      timeoutMs: 20,
    })
    await expect(c.call('getUpdates', {})).rejects.toThrow()
  })
})
