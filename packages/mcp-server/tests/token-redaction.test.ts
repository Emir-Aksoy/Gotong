/**
 * H3 regression — MCP admin token leak through stderr / tool errors.
 *
 * Background: certain `undici`/Node fetch versions thread the full
 * request init object — including `headers.authorization` — into the
 * `TypeError` they throw on transport failure. Pre-3.4 the MCP server
 * had two leaks:
 *
 *   1. `main.ts` top-level catch: `process.stderr.write(err.stack)`
 *      sent the raw stack — which on the affected fetch versions
 *      contains `Bearer <TOKEN>` — straight to stderr. Claude Desktop /
 *      Cursor / Cline capture stderr into their long-lived diagnostic
 *      logs, so anyone with read access to those logs effectively
 *      held the Hub's admin token.
 *
 *   2. `HubClient.unwrap` reflected `err.message` from the server
 *      verbatim. A buggy proxy upstream could echo back the inbound
 *      Authorization header in its 5xx body, and the MCP tool would
 *      pass that to the LLM (which the LLM might log or quote in a
 *      reply).
 *
 * Both paths now run errors through `redactError` /
 * `redactToken` before they leave the HubClient surface, and the
 * top-level `main.ts` catch applies the same redactor on the way
 * out to stderr.
 *
 * See AUDIT-v3.3.md finding H3.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HubClient,
  HubClientError,
  redactError,
  redactToken,
} from '../src/hub-client.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function installFetch(impl: typeof globalThis.fetch): void {
  globalThis.fetch = vi.fn(impl as never) as unknown as typeof globalThis.fetch
}

// =========================================================================
// redactToken — string-level scrubber
// =========================================================================

describe('redactToken', () => {
  const TOKEN = 'aipe-admin-tok-very-secret-12345'

  it('replaces the literal token wherever it appears', () => {
    const input = `failed to call api: Bearer ${TOKEN} got 401`
    const out = redactToken(input, TOKEN)
    expect(out).not.toContain(TOKEN)
    expect(out).toContain('***')
  })

  it('collapses any `Bearer <something>` even when the token literal is unknown', () => {
    // The hub may reflect a different token format in an error message
    // (proxy mishap, future format change). Belt-and-braces: collapse
    // any Bearer pattern.
    const input = 'upstream said: Authorization: Bearer some-other-tok-987'
    const out = redactToken(input, '')
    expect(out).toContain('Bearer ***')
    expect(out).not.toContain('some-other-tok-987')
  })

  it('handles regex meta-characters in the token literal safely', () => {
    // The fix uses `String#split(literal).join('***')` rather than a
    // RegExp built from the token, so a token containing `.` or `*`
    // doesn't accidentally become a wildcard.
    const trickyToken = 'sk-...$^*+?.()|[]{}'
    const input = `header was Bearer ${trickyToken} apparently`
    const out = redactToken(input, trickyToken)
    expect(out).not.toContain(trickyToken)
    // The Bearer regex also catches the same span — both paths
    // collapse it the same way.
    expect(out).toContain('***')
  })

  it('is a no-op when the token does not appear', () => {
    expect(redactToken('no secrets here', 'tok')).toBe('no secrets here')
  })

  it('returns non-string input unchanged', () => {
    // The function is typed `string -> string` but we defend on the
    // runtime side too. A future caller passing `err.message` where
    // `err` is actually a non-Error must not crash.
    // @ts-expect-error — runtime guard
    expect(redactToken(undefined, 'tok')).toBeUndefined()
  })
})

// =========================================================================
// redactError — Error reconstructor
// =========================================================================

describe('redactError', () => {
  const TOKEN = 'aipe-admin-tok-deadbeef'

  it('rebuilds an Error with the token stripped from message AND stack', () => {
    const err = new TypeError(`request failed (Bearer ${TOKEN})`)
    // Simulate an undici-style stack that embeds the init headers.
    err.stack = `TypeError: request failed (Bearer ${TOKEN})
    at fetch (.../undici/index.js:1:1)
      headers: { authorization: 'Bearer ${TOKEN}' }
    at HubClient.raw (.../hub-client.ts:99:13)`

    const cleaned = redactError(err, TOKEN)
    expect(cleaned).toBeInstanceOf(Error)
    expect(cleaned.message).not.toContain(TOKEN)
    expect(cleaned.stack).toBeDefined()
    expect(cleaned.stack).not.toContain(TOKEN)
    // The original is left intact (defence in depth — frame-captured
    // references in the MCP SDK might still hold it).
    expect(err.message).toContain(TOKEN)
  })

  it('recursively redacts `cause` chains (undici TypeError → AbortError)', () => {
    const inner = new Error(`abort: Bearer ${TOKEN}`)
    const outer = new TypeError(`fetch failed (Bearer ${TOKEN})`)
    ;(outer as Error & { cause?: unknown }).cause = inner

    const cleaned = redactError(outer, TOKEN)
    expect(cleaned.message).not.toContain(TOKEN)
    const cause = (cleaned as Error & { cause?: unknown }).cause as Error
    expect(cause).toBeInstanceOf(Error)
    expect(cause.message).not.toContain(TOKEN)
  })

  it('preserves the original error name (TypeError stays TypeError)', () => {
    const err = new TypeError(`x ${TOKEN}`)
    const cleaned = redactError(err, TOKEN)
    expect(cleaned.name).toBe('TypeError')
  })

  it('handles non-Error throwables by wrapping them in a fresh Error', () => {
    // Code can throw strings or numbers; we still need to redact.
    const cleaned = redactError(`exploded: Bearer ${TOKEN}`, TOKEN)
    expect(cleaned).toBeInstanceOf(Error)
    expect(cleaned.message).not.toContain(TOKEN)
  })
})

// =========================================================================
// HubClient — end-to-end: token never escapes through a thrown error
// =========================================================================

describe('HubClient — token does not leak in thrown errors (H3)', () => {
  const TOKEN = 'super-secret-bearer-token-abc123xyz789'

  it('fetch transport failure → thrown error has no token in message or stack', async () => {
    // Simulate undici embedding the init object in its TypeError —
    // the worst observed pre-3.4 leak.
    installFetch(async () => {
      const e = new TypeError(`fetch failed (Bearer ${TOKEN})`)
      e.stack = `TypeError: fetch failed (Bearer ${TOKEN})
    init: { headers: { authorization: 'Bearer ${TOKEN}' } }
    at fetch (...)`
      throw e
    })

    const c = new HubClient({ baseUrl: 'http://x', adminToken: TOKEN })
    let caught: Error | undefined
    try { await c.state() } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).not.toContain(TOKEN)
    expect(caught!.stack ?? '').not.toContain(TOKEN)
  })

  it('server-reflected token in error body is also redacted in HubClientError.message', async () => {
    // Some misconfigured upstream proxies echo the Authorization
    // header back in their 5xx response body. The MCP server's
    // tool handler would otherwise pass that to the LLM.
    installFetch(async () =>
      new Response(
        JSON.stringify({
          error: `upstream: invalid token Bearer ${TOKEN}`,
        }),
        {
          status: 502,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )

    const c = new HubClient({ baseUrl: 'http://x', adminToken: TOKEN })
    let caught: HubClientError | undefined
    try { await c.state() } catch (e) { caught = e as HubClientError }

    expect(caught).toBeInstanceOf(HubClientError)
    expect(caught!.message).not.toContain(TOKEN)
    // status is preserved
    expect(caught!.status).toBe(502)
  })

  it('successful path is unaffected by the redactor', async () => {
    installFetch(async () =>
      new Response(JSON.stringify({ participants: [], transcript: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const c = new HubClient({ baseUrl: 'http://x', adminToken: TOKEN })
    const out = await c.state()
    expect(out).toEqual({ participants: [], transcript: [] })
  })
})
