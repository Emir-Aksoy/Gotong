/**
 * ❶-M2 — unit tests for `scrubSecrets`, the key-agnostic redactor that the host
 * runs over a workflow run's failure reason before it reaches the member who
 * started it (`/me` recent runs).
 *
 * Two contracts worth pinning, in tension with each other:
 *  1) A leaked key MUST NOT survive — neither a `Bearer <key>` / `api_key=<key>`
 *     request echo, nor a bare long token, and not even as a fragment that a
 *     naive length-clamp could leave behind.
 *  2) The error's MEANINGFUL words MUST survive — the frontend `describeError()`
 *     classifier keys off short English phrases ("401", "invalid api key",
 *     "quota", "rate limit"); scrubbing must not eat them or the member loses
 *     the actionable "go add a key" hint.
 */

import { describe, expect, it } from 'vitest'

import { scrubSecrets } from '../src/scrub-secrets.js'

describe('scrubSecrets', () => {
  it('empty / undefined → empty string', () => {
    expect(scrubSecrets(undefined)).toBe('')
    expect(scrubSecrets('')).toBe('')
  })

  it('leaves a clean failure reason (no secret) byte-for-byte', () => {
    const clean = "step 'reply' failed: model is overloaded, please retry"
    expect(scrubSecrets(clean)).toBe(clean)
  })

  it('redacts a Bearer token echoed from the Authorization header', () => {
    const raw =
      "step 'reply' failed: 401 from provider (Authorization: Bearer sk-proj-AbC123dEf456GhI789jKl012MnO345pQr)"
    const out = scrubSecrets(raw)
    expect(out).not.toContain('sk-proj-AbC123dEf456GhI789jKl012MnO345pQr')
    expect(out).not.toContain('AbC123dEf456GhI789jKl012MnO345pQr')
    // scheme kept for context, value gone
    expect(out).toContain('Bearer ***')
  })

  it('redacts a vendor-prefixed key but keeps the prefix for context', () => {
    const raw = 'auth failed for key sk-AbCdEf0123456789GhIjKlMnOpQrStUvWxYz'
    const out = scrubSecrets(raw)
    expect(out).not.toContain('AbCdEf0123456789GhIjKlMnOpQrStUvWxYz')
    expect(out).toContain('sk-***')
  })

  it('redacts a Slack xoxb- token', () => {
    const raw = 'invalid_auth: xoxb-2401-2403-AbCdEfGhIjKlMnOpQr'
    const out = scrubSecrets(raw)
    expect(out).not.toContain('AbCdEfGhIjKlMnOpQr')
    expect(out).toContain('xoxb-***')
  })

  it('redacts a labelled secret (api_key=<value>)', () => {
    const raw = 'request rejected: api_key=abcdef0123456789ABCDEF was revoked'
    const out = scrubSecrets(raw)
    expect(out).not.toContain('abcdef0123456789ABCDEF')
    // label kept, value gone
    expect(out).toMatch(/api_key=\*\*\*/)
  })

  it('redacts a bare 40+ char token-shaped run', () => {
    const secret = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0' // 40 chars
    const raw = `unexpected token in response: ${secret}`
    const out = scrubSecrets(raw)
    expect(out).not.toContain(secret)
    expect(out).toContain('***')
  })

  it('preserves describeError classifier keywords through scrubbing', () => {
    // Each of these short phrases is what the frontend classifier matches on —
    // they must survive even when a key sits right next to them.
    const cases = [
      "step 'x' failed: 401 invalid api key (Authorization: Bearer sk-AbCdEf0123456789GhIjKlMnOpQr)",
      "step 'x' failed: 429 quota exceeded for api_key=ZyXwVu9876543210AbCdEfGhIj",
      "step 'x' failed: rate limit reached, retry later",
    ]
    const a = scrubSecrets(cases[0])
    expect(a).toContain('401')
    expect(a).toContain('invalid api key')
    expect(a).not.toContain('sk-AbCdEf0123456789GhIjKlMnOpQr')

    const b = scrubSecrets(cases[1])
    expect(b).toContain('quota')
    expect(b).not.toContain('ZyXwVu9876543210AbCdEfGhIj')

    const c = scrubSecrets(cases[2])
    expect(c).toBe(cases[2]) // no secret → untouched
    expect(c).toContain('rate limit')
  })

  it('does NOT redact short ids / UUIDs (avoids over-scrubbing)', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000' // 36 chars
    const raw = `run ${uuid} step 'reply' failed: timeout`
    const out = scrubSecrets(raw)
    expect(out).toContain(uuid)
  })

  it('redacts BEFORE clamping length so a key near the cut cannot survive', () => {
    // Pad so the secret straddles the default 300-char cap; a naive
    // slice-then-scrub would leave a sub-40 tail in the clear.
    const pad = 'x'.repeat(285)
    const secret = 'KEY1234567890abcdefABCDEF1234567890zzzzzz' // 41 chars
    const raw = `${pad} ${secret}`
    const out = scrubSecrets(raw)
    expect(out).not.toContain('KEY1234567890abcdefABCDEF1234567890zzzzzz')
    // and the redacted form is still within the cap
    expect(out.length).toBeLessThanOrEqual(300)
  })

  it('clamps output to the requested max length', () => {
    // Short space-separated words (no 40+ run) so nothing is redacted away —
    // this exercises the length clamp, not rule 4.
    const raw = Array.from({ length: 100 }, () => 'word').join(' ')
    expect(scrubSecrets(raw, 50).length).toBe(50)
  })
})
