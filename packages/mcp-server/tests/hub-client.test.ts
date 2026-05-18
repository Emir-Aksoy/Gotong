/**
 * `HubClient` is the entire HTTP layer between the MCP bridge and the
 * Hub. The interesting branches:
 *   - constructor enforces baseUrl + adminToken
 *   - ping() short-circuits to false on network error
 *   - get/post send the bearer header and parse JSON
 *   - unwrap() promotes non-2xx into HubClientError with the body preserved
 *   - timeout aborts in-flight requests
 *
 * We stub `globalThis.fetch` per-test so the tests stay local + fast
 * (no real server). Each `installFetch` swap is undone in afterEach.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { HubClient, HubClientError } from '../src/hub-client.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function installFetch(impl: typeof globalThis.fetch): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl as never) as unknown as typeof globalThis.fetch
  globalThis.fetch = fn
  return fn as unknown as ReturnType<typeof vi.fn>
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('HubClient — constructor guards', () => {
  it('refuses an empty baseUrl', () => {
    // @ts-expect-error — testing runtime guard
    expect(() => new HubClient({ baseUrl: '', adminToken: 't' })).toThrow(/baseUrl/)
  })

  it('refuses an empty adminToken', () => {
    expect(() => new HubClient({ baseUrl: 'http://x', adminToken: '' })).toThrow(/adminToken/)
  })

  it('builds with valid inputs', () => {
    const c = new HubClient({ baseUrl: 'http://127.0.0.1:3000', adminToken: 'tok' })
    expect(c).toBeInstanceOf(HubClient)
  })
})

describe('HubClient — ping', () => {
  it('returns true on 200 from /healthz', async () => {
    installFetch(async () => new Response('ok', { status: 200 }))
    const c = new HubClient({ baseUrl: 'http://x', adminToken: 't' })
    expect(await c.ping()).toBe(true)
  })

  it('returns false on non-200 (e.g. 503 starting up)', async () => {
    installFetch(async () => new Response('no', { status: 503 }))
    const c = new HubClient({ baseUrl: 'http://x', adminToken: 't' })
    expect(await c.ping()).toBe(false)
  })

  it('returns false when fetch itself rejects (DNS / connection refused)', async () => {
    installFetch(async () => {
      throw new TypeError('fetch failed')
    })
    const c = new HubClient({ baseUrl: 'http://x', adminToken: 't' })
    expect(await c.ping()).toBe(false)
  })

  it('does not send the bearer token on /healthz (it is public)', async () => {
    const fetchSpy = installFetch(async (_url: unknown, init?: unknown) => {
      const headers = (init as { headers?: Record<string, string> } | undefined)?.headers ?? {}
      expect(headers).not.toHaveProperty('authorization')
      return new Response('ok', { status: 200 })
    })
    const c = new HubClient({ baseUrl: 'http://x', adminToken: 't' })
    await c.ping()
    expect(fetchSpy).toHaveBeenCalledOnce()
  })
})

describe('HubClient — state / leaderboard / evaluate', () => {
  it('GET /api/state attaches the bearer header', async () => {
    const fetchSpy = installFetch(async (_url: unknown, init?: unknown) => {
      const headers = (init as { headers?: Record<string, string> } | undefined)?.headers ?? {}
      expect(headers.authorization).toBe('Bearer secret')
      return jsonResponse({ participants: [], transcript: [] })
    })
    const c = new HubClient({ baseUrl: 'http://x', adminToken: 'secret' })
    const state = await c.state()
    expect(state.participants).toEqual([])
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('leaderboard with no opts hits the bare /api/leaderboard path', async () => {
    let seenUrl = ''
    installFetch(async (url: unknown) => {
      seenUrl = String(url)
      return jsonResponse({ from: 0, to: 0, rows: [], unratedTaskCount: 0, totalTaskCount: 0 })
    })
    const c = new HubClient({ baseUrl: 'http://x', adminToken: 't' })
    await c.leaderboard()
    expect(seenUrl).toBe('http://x/api/leaderboard')
  })

  it('leaderboard with from/to appends a querystring', async () => {
    let seenUrl = ''
    installFetch(async (url: unknown) => {
      seenUrl = String(url)
      return jsonResponse({ from: 0, to: 0, rows: [], unratedTaskCount: 0, totalTaskCount: 0 })
    })
    const c = new HubClient({ baseUrl: 'http://x', adminToken: 't' })
    await c.leaderboard({ from: 100, to: 200 })
    expect(seenUrl).toBe('http://x/api/leaderboard?from=100&to=200')
  })

  it('evaluate posts the body and parses { ok: true }', async () => {
    let seenBody = ''
    installFetch(async (_url: unknown, init?: unknown) => {
      seenBody = String((init as { body?: string } | undefined)?.body ?? '')
      return jsonResponse({ ok: true })
    })
    const c = new HubClient({ baseUrl: 'http://x', adminToken: 't' })
    await c.evaluate({ taskId: 't1', rating: 4.5, comment: 'great' })
    expect(JSON.parse(seenBody)).toEqual({ taskId: 't1', rating: 4.5, comment: 'great' })
  })
})

describe('HubClient — dispatchAndWait', () => {
  it('adds wait + timeoutMs to the body and posts to /api/admin/dispatch', async () => {
    let seenUrl = ''
    let seenBody = ''
    installFetch(async (url: unknown, init?: unknown) => {
      seenUrl = String(url)
      seenBody = String((init as { body?: string } | undefined)?.body ?? '')
      return jsonResponse({ ok: true, result: { kind: 'ok', taskId: 't1', ts: 1, by: 'a' } })
    })
    const c = new HubClient({ baseUrl: 'http://x', adminToken: 't' })
    const r = await c.dispatchAndWait(
      { strategy: { kind: 'explicit', to: 'a' }, payload: 'hi' },
      12_345,
    )
    expect(seenUrl).toBe('http://x/api/admin/dispatch')
    expect(JSON.parse(seenBody)).toEqual({
      strategy: { kind: 'explicit', to: 'a' },
      payload: 'hi',
      wait: true,
      timeoutMs: 12_345,
    })
    expect(r.ok).toBe(true)
  })

  it('uses the default 60s wait when caller omits it', async () => {
    let seenTimeout: number | undefined
    installFetch(async (_url: unknown, init?: unknown) => {
      const body = (init as { body?: string } | undefined)?.body ?? '{}'
      seenTimeout = (JSON.parse(body) as { timeoutMs?: number }).timeoutMs
      return jsonResponse({ ok: true })
    })
    const c = new HubClient({ baseUrl: 'http://x', adminToken: 't' })
    await c.dispatchAndWait({ strategy: { kind: 'broadcast' } })
    expect(seenTimeout).toBe(60_000)
  })
})

describe('HubClient — error surface', () => {
  it('wraps non-2xx into HubClientError with status + body', async () => {
    installFetch(async () =>
      jsonResponse({ error: 'no such admin' }, { status: 401 }),
    )
    const c = new HubClient({ baseUrl: 'http://x', adminToken: 'bad' })
    let caught: unknown
    try {
      await c.state()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HubClientError)
    const err = caught as HubClientError
    expect(err.status).toBe(401)
    expect(err.message).toBe('no such admin')
    expect(err.body).toEqual({ error: 'no such admin' })
  })

  it('falls back to a generic message when body has no `error` field', async () => {
    installFetch(async () => new Response('teapot', { status: 418 }))
    const c = new HubClient({ baseUrl: 'http://x', adminToken: 't' })
    let caught: unknown
    try {
      await c.state()
    } catch (e) {
      caught = e
    }
    const err = caught as HubClientError
    expect(err.status).toBe(418)
    expect(err.message).toMatch(/418/)
    // Body preserved as the raw string when JSON parse failed.
    expect(err.body).toBe('teapot')
  })

  it('aborts the in-flight request when timeout fires', async () => {
    // Install a slow fetch that observes the abort signal. AbortController
    // throws on `.abort()`; we surface that as the test assertion.
    installFetch(async (_url: unknown, init?: unknown) => {
      const signal = (init as { signal?: AbortSignal } | undefined)?.signal
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')))
      })
    })
    const c = new HubClient({ baseUrl: 'http://x', adminToken: 't', timeoutMs: 10 })
    await expect(c.state()).rejects.toBeDefined()
  })
})
