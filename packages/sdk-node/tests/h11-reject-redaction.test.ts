/**
 * H11 regression — REJECT.message must be scrubbed before it lands
 * in a thrown Error.
 *
 * Background: the sdk-node Session does
 *
 *     case 'REJECT': {
 *       const err = new Error(`hub rejected: ${frame.code}: ${frame.message}`)
 *       ...
 *     }
 *
 * `frame.message` is server-controlled. A misconfigured Hub or upstream
 * proxy can put the caller's own credentials back into the message —
 * `"apiKey 'sk-...' not recognised"`. The Error then typically lands
 * in Sentry / application logs / stderr, where it can be read by
 * anyone with log access.
 *
 * Mitigation: pass `frame.message` through `redactSecrets()` before
 * concatenating into the Error. The regex set covers the three
 * patterns we know are credential-shaped today:
 *
 *   - `sk-...` (OpenAI / Anthropic / DeepSeek)
 *   - `Bearer ...` (HTTP Authorization header)
 *   - `aipe-...` (AipeHub-issued tokens)
 *
 * See AUDIT-v3.3.md finding H11.
 */

import { describe, expect, it } from 'vitest'

import { redactSecrets } from '../src/redact.js'

describe('H11 — redactSecrets()', () => {
  describe('sk-... API keys', () => {
    it('redacts a standalone OpenAI-shaped key', () => {
      const out = redactSecrets("apiKey 'sk-abc123XYZ_def-456' not recognised")
      expect(out).not.toContain('sk-abc123')
      expect(out).toContain('<redacted>')
    })

    it('redacts the modern long-form Anthropic / DeepSeek style', () => {
      const out = redactSecrets(
        'bad key: sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-something',
      )
      expect(out).not.toContain('sk-ant')
      expect(out).toContain('<redacted>')
    })

    it('preserves the rest of the message intact', () => {
      // The diagnostic value of the message has to survive — only
      // the secret span is replaced.
      const out = redactSecrets(
        "auth_failed: apiKey 'sk-real-secret-12345' did not match any verifier",
      )
      expect(out).toContain('auth_failed')
      expect(out).toContain('did not match any verifier')
    })

    it('redacts multiple sk- keys in one string', () => {
      const out = redactSecrets('first sk-foo123 then sk-bar456 done')
      expect(out).not.toContain('sk-foo')
      expect(out).not.toContain('sk-bar')
      expect(out.match(/<redacted>/g)?.length).toBe(2)
    })
  })

  describe('Bearer ... headers', () => {
    it('redacts a literal Bearer header echoed back by an upstream proxy', () => {
      const out = redactSecrets(
        'upstream said 502: Authorization: Bearer aipe-tok-abc-xyz-def',
      )
      expect(out).not.toContain('aipe-tok-abc-xyz-def')
      expect(out).toContain('Authorization: <redacted>')
    })

    it('is case-insensitive on the `Bearer` keyword', () => {
      const out = redactSecrets('bearer my-token-here')
      expect(out).not.toContain('my-token-here')
    })
  })

  describe('aipe-... admin / agent tokens', () => {
    it('redacts a literal AipeHub admin token', () => {
      const out = redactSecrets('rejected: token aipe-admin-deadbeef invalid')
      expect(out).not.toContain('aipe-admin')
      expect(out).toContain('<redacted>')
    })
  })

  describe('benign strings — no false positives', () => {
    it('does not touch plain prose with no credential pattern', () => {
      const input = "auth_failed: apiKey 'redacted-on-our-side' not recognised"
      expect(redactSecrets(input)).toBe(input)
    })

    it('does not touch session ids or IP addresses', () => {
      const input = 'session s_a1b2c3 from 192.168.1.1 rejected (code=duplicate_id)'
      expect(redactSecrets(input)).toBe(input)
    })

    it('does not touch error codes — they pass through verbatim', () => {
      // The audit fix intentionally only scrubs `message`; `code`
      // is a constrained enum (bad_hello, unauthorized, ...) and
      // never carries secrets.
      expect(redactSecrets('protocol_mismatch')).toBe('protocol_mismatch')
      expect(redactSecrets('bad_hello')).toBe('bad_hello')
    })
  })

  describe('idempotence', () => {
    it('running on an already-redacted string is a no-op', () => {
      const once = redactSecrets("bad apiKey 'sk-abc123' for you")
      const twice = redactSecrets(once)
      expect(twice).toBe(once)
    })
  })

  describe('non-string defence', () => {
    it('returns empty string for null / undefined', () => {
      expect(redactSecrets(null)).toBe('')
      expect(redactSecrets(undefined)).toBe('')
    })

    it('stringifies a number rather than crashing', () => {
      expect(redactSecrets(42)).toBe('42')
    })
  })
})
