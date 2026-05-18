// H12 regression: `decodeFrame` must check the input size BEFORE
// calling `JSON.parse`. Pre-3.4 a 100 MiB JSON payload would be
// fully parsed and held in memory twice (raw text + parsed object)
// before the envelope check ran — trivially OOM-able for any open Hub.
//
// The WS transport already caps frames via `WebSocketServer.maxPayload`
// (PR #23 finding C1), so this guard is defence in depth:
//   - Other transports (HTTP, named pipes) don't get the WS cap.
//   - Test harnesses calling decodeFrame directly were unprotected.
//   - Future SDKs decoding messages they read from disk (replay logs)
//     would carry whatever size is on disk straight into JSON.parse.
//
// The default cap is 1 MiB — comfortably above transport-ws's 256 KiB
// default so legitimate frames pass through both layers without
// rejection.
//
// See AUDIT-v3.3.md finding H12.

import { describe, expect, it } from 'vitest'

import {
  decodeFrame,
  decodeFrameStrict,
  DEFAULT_DECODE_MAX_BYTES,
  encodeFrame,
} from '../src/index.js'

describe('decodeFrame — size guard (H12)', () => {
  it('exports the documented default', () => {
    expect(DEFAULT_DECODE_MAX_BYTES).toBe(1_048_576)
  })

  it('accepts a frame smaller than the cap', () => {
    const text = encodeFrame({ type: 'PING', ts: 1 })
    const r = decodeFrame(text)
    expect(r.ok).toBe(true)
  })

  it('rejects a frame larger than the default 1 MiB with reason "too_large"', () => {
    // Build a syntactically valid frame whose total length exceeds
    // 1 MiB. The payload field is intentionally large; the result
    // should never reach `JSON.parse` — we should fail fast on the
    // size envelope.
    const huge = JSON.stringify({
      type: 'PING',
      ts: 1,
      padding: 'a'.repeat(DEFAULT_DECODE_MAX_BYTES + 1),
    })
    expect(huge.length).toBeGreaterThan(DEFAULT_DECODE_MAX_BYTES)

    const r = decodeFrame(huge)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('too_large')
      // `detail` carries the actual byte count for log correlation.
      expect(r.detail).toContain(String(huge.length))
      expect(r.detail).toContain(String(DEFAULT_DECODE_MAX_BYTES))
    }
  })

  it('accepts the boundary case: exactly maxBytes long', () => {
    // The check is `text.length > maxBytes`, so exactly-equal is
    // allowed. Build a frame whose serialised form is exactly the
    // limit.
    const target = 100
    const overhead = JSON.stringify({ type: 'PING', ts: 1, padding: '' }).length
    const padding = 'a'.repeat(target - overhead)
    const text = JSON.stringify({ type: 'PING', ts: 1, padding })
    expect(text.length).toBe(target)

    const r = decodeFrame(text, { maxBytes: target })
    expect(r.ok).toBe(true)
  })

  it('rejects when exceeding a custom maxBytes', () => {
    const text = JSON.stringify({ type: 'PING', ts: 1, padding: 'a'.repeat(500) })
    const r = decodeFrame(text, { maxBytes: 100 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('too_large')
  })

  it('disables the cap when maxBytes is 0', () => {
    // Some test harnesses replay multi-MB transcripts and need the
    // guard off. `maxBytes: 0` is the documented escape hatch.
    const huge = JSON.stringify({ type: 'PING', ts: 1, padding: 'x'.repeat(2_000_000) })
    expect(huge.length).toBeGreaterThan(DEFAULT_DECODE_MAX_BYTES)

    const r = decodeFrame(huge, { maxBytes: 0 })
    expect(r.ok).toBe(true)
  })

  it('disables the cap when maxBytes is negative', () => {
    // Defensive — negative is treated identically to 0 (guard off).
    const huge = JSON.stringify({ type: 'PING', ts: 1, padding: 'x'.repeat(2_000_000) })
    const r = decodeFrame(huge, { maxBytes: -1 })
    expect(r.ok).toBe(true)
  })

  it('strict mode honours maxBytes too', () => {
    // The strict-mode decoder shares the size envelope — same
    // memory-safety concern, same defence.
    const huge = JSON.stringify({
      type: 'HELLO',
      protocolVersion: '1.2',
      client: { name: 'fuzzer', version: '0.0' },
      agents: [],
      padding: 'a'.repeat(DEFAULT_DECODE_MAX_BYTES + 1),
    })
    expect(huge.length).toBeGreaterThan(DEFAULT_DECODE_MAX_BYTES)

    const r = decodeFrameStrict(huge)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('too_large')
  })

  it('does not call JSON.parse when the size cap fires', () => {
    // Crucial security property — a payload that fails the size
    // check must NOT be parsed. Even attempting JSON.parse on a
    // multi-megabyte string lets the attacker exercise the parser's
    // memory cost.
    //
    // We can't directly observe "didn't call JSON.parse" but we can
    // assert a corollary: a payload that's too large AND syntactically
    // broken still returns `too_large`, not `invalid_json`. If the
    // size check ran after parse, broken JSON of large size would
    // surface as `invalid_json`.
    const broken = 'a'.repeat(DEFAULT_DECODE_MAX_BYTES + 1) // not valid JSON
    const r = decodeFrame(broken)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('too_large')
  })
})
