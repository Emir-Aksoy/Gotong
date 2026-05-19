/**
 * H5 regression — OpenAI retry classifier must not retry user aborts.
 *
 * Pre-3.4 `isTransientError` matched the bare word `aborted` in
 * `err.message`. The intent was to catch undici's socket-level abort
 * disconnects, but the side effect was:
 *
 *   - User code passes an `AbortController` to the OpenAI SDK.
 *   - User cancels mid-request (UI close, timeout, whatever).
 *   - The SDK rejects with a plain Error whose message contains
 *     `aborted`. (DOMException name='AbortError' is the canonical
 *     case and was already short-circuited; the residual case is
 *     wrappers that strip the DOMException marker.)
 *   - The classifier returns `true` → retry loop fires the request
 *     AGAIN against the upstream provider.
 *   - The provider charges for input tokens on both attempts.
 *
 * That's a double-billing bug. The fix narrows the regex to only
 * match the two undici-specific phrases — `socket aborted` and
 * `request aborted` — that genuinely signal "the network layer
 * aborted underneath us". Bare `aborted` is ambiguous and now falls
 * through to the permanent-error path.
 *
 * See AUDIT-v3.3.md finding H5.
 */

import { describe, expect, it } from 'vitest'

import { isTransientError } from '../src/index.js'

describe('H5 — isTransientError narrowing for user-driven aborts', () => {
  it('does NOT retry a bare Error("aborted") (could be a user cancel)', () => {
    // The smoking gun: the user's app called `controller.abort()`
    // with a message string, and the wrapping layer threw a plain
    // Error("aborted") or Error("aborted by user") instead of the
    // DOMException. Pre-3.4 the regex matched the bare word and
    // retried, doubling billing. The new regex requires a
    // network-specific PREFIX (`socket aborted` / `request aborted`)
    // before flagging transient — these two messages have no such
    // prefix, so they correctly classify as permanent.
    expect(isTransientError(new Error('aborted'))).toBe(false)
    expect(isTransientError(new Error('aborted by user'))).toBe(false)
    expect(isTransientError(new Error('user cancelled'))).toBe(false)
    expect(isTransientError(new Error('operation was aborted'))).toBe(false)
  })

  it('DOES retry "socket aborted" (undici socket-level)', () => {
    // The undici-internal phrase we deliberately keep. The
    // upstream TCP socket aborted mid-response — retry is the
    // right call.
    expect(isTransientError(new Error('socket aborted'))).toBe(true)
    expect(isTransientError(new Error('SOCKET ABORTED'))).toBe(true) // case-insensitive
  })

  it('DOES retry "request aborted" (undici request-level)', () => {
    // The other undici phrase. Same reasoning.
    expect(isTransientError(new Error('request aborted'))).toBe(true)
  })

  it('still catches all the other pre-3.4 transient phrases', () => {
    // Regression: the regex tightening must not have dropped the
    // other branches we already relied on.
    expect(isTransientError(new Error('premature close'))).toBe(true)
    expect(isTransientError(new Error('socket hang up'))).toBe(true)
    expect(isTransientError(new Error('fetch failed'))).toBe(true)
    expect(isTransientError(new Error('read ECONNRESET'))).toBe(true)
    expect(isTransientError(new Error('ETIMEDOUT'))).toBe(true)
  })

  it('AbortError name still short-circuits — defence in depth', () => {
    // The canonical AbortController case keeps working unchanged.
    const e = new Error('The operation was aborted')
    ;(e as Error & { name: string }).name = 'AbortError'
    expect(isTransientError(e)).toBe(false)
  })

  it('ABORT_ERR code still short-circuits — defence in depth', () => {
    const e = new Error('aborted') as Error & { code: string }
    e.code = 'ABORT_ERR'
    expect(isTransientError(e)).toBe(false)
  })

  it('AbortError nested on cause still short-circuits', () => {
    const e = new Error('fetch failed') as Error & {
      cause?: { name: string }
    }
    e.cause = { name: 'AbortError' }
    // Even though "fetch failed" would otherwise match transient,
    // the AbortError marker on cause flips the classifier to
    // permanent first.
    expect(isTransientError(e)).toBe(false)
  })

  it('429 / 5xx HTTP statuses still treated as transient', () => {
    // The other classifier branch — status code — is unchanged.
    expect(isTransientError({ status: 429 })).toBe(true)
    expect(isTransientError({ status: 500 })).toBe(true)
    expect(isTransientError({ status: 503 })).toBe(true)
    expect(isTransientError({ status: 401 })).toBe(false)
    expect(isTransientError({ status: 404 })).toBe(false)
  })
})
