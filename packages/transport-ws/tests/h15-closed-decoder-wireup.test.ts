/**
 * H15 wire-up regression — `AIPE_PROTOCOL_STRICT` env value picks the
 * decoder at session construction. Three valid values:
 *
 *   unset / anything else → decodeFrame      (lax envelope only)
 *   '1'                   → decodeFrameStrict (deep field checks)
 *   'closed'              → decodeFrameClosed (deep + reject unknown)
 *
 * `pickDecoder` is the pure function the Session uses; testing it
 * directly avoids spinning up a WS server for each value.
 *
 * See AUDIT-v3.3.md finding H15.
 */

import { describe, expect, it } from 'vitest'

import {
  decodeFrame,
  decodeFrameClosed,
  decodeFrameStrict,
} from '@aipehub/protocol'

import { pickDecoder } from '../src/session.js'

describe('H15 — pickDecoder decision table', () => {
  it('returns decodeFrame when env is undefined', () => {
    expect(pickDecoder(undefined)).toBe(decodeFrame)
  })

  it('returns decodeFrame for the empty string', () => {
    // An empty `AIPE_PROTOCOL_STRICT=` in a shell exports `''`. Treat
    // that the same as unset — it's clearly not the intent to enable
    // strict mode.
    expect(pickDecoder('')).toBe(decodeFrame)
  })

  it('returns decodeFrame for "0" (people misremember the API)', () => {
    // Common mistake: setting `AIPE_PROTOCOL_STRICT=0` thinking it's
    // a boolean. The contract is strict-on-1, not boolean. Falls
    // through to lax.
    expect(pickDecoder('0')).toBe(decodeFrame)
  })

  it('returns decodeFrameStrict for "1"', () => {
    expect(pickDecoder('1')).toBe(decodeFrameStrict)
  })

  it('returns decodeFrameClosed for "closed"', () => {
    expect(pickDecoder('closed')).toBe(decodeFrameClosed)
  })

  it('returns decodeFrame for typos / unrecognised values', () => {
    // `strict` is a likely typo for the literal value `1`. Falls
    // through to lax — the operator either notices "strict isn't
    // working" or they're fine on the default.
    expect(pickDecoder('strict')).toBe(decodeFrame)
    expect(pickDecoder('CLOSED')).toBe(decodeFrame) // case-sensitive
    expect(pickDecoder('true')).toBe(decodeFrame)
  })
})
