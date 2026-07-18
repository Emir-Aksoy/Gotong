/**
 * VOICE-M2 — opus clip duration from the Ogg container.
 *
 * The duration on a Lark voice bubble comes from the BYTES (last Ogg page
 * granule position / 48), never from a side channel — so the generic
 * `ImAttachment` contract stays untouched.
 */

import { describe, expect, it } from 'vitest'

import { opusDurationMs } from '../src/audio.js'

/** One minimal Ogg page header with the given granule position. */
function page(granule: bigint, pad = 20): Buffer {
  const b = Buffer.alloc(14 + pad)
  b.write('OggS', 0, 'ascii')
  b.writeBigInt64LE(granule, 6)
  return b
}

describe('VOICE-M2 opusDurationMs', () => {
  it('reads the LAST page granule at the 48kHz opus clock', () => {
    // Two pages: mid-stream at 1s, final at 3s — the final one wins.
    const clip = Buffer.concat([page(48_000n), page(144_000n)])
    expect(opusDurationMs(clip)).toBe(3000)
  })

  it('a non-ogg buffer is null — the caller must NOT upload it as opus', () => {
    expect(opusDurationMs(Buffer.from('ID3 mp3-ish bytes'))).toBeNull()
    expect(opusDurationMs(Buffer.alloc(0))).toBeNull()
  })

  it('an unreadable/absurd granule falls back to a size estimate, never null', () => {
    // granule -1 (no packet ends on this page) → estimate from byte size.
    const weird = page(-1n, 4000)
    const ms = opusDurationMs(weird)
    expect(ms).not.toBeNull()
    expect(ms!).toBeGreaterThanOrEqual(1000)
    // Truncated header right at the magic → still an estimate, not a crash.
    const truncated = Buffer.concat([Buffer.alloc(100), Buffer.from('OggS')])
    expect(opusDurationMs(truncated)).toBeGreaterThanOrEqual(1000)
  })

  it('accepts a plain Uint8Array view', () => {
    const buf = page(96_000n)
    const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    expect(opusDurationMs(view)).toBe(2000)
  })
})
