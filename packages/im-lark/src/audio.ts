/**
 * VOICE-M2 — derive a voice clip's duration from its ogg/opus bytes.
 *
 * Lark's file upload wants a `duration` (milliseconds) for `file_type=opus`
 * (it becomes the length shown on the voice bubble). Duration is a property
 * of the BYTES, so the bridge reads it from the container instead of asking
 * every producer to thread a number through the generic `ImAttachment`
 * contract (which stays untouched — it is deliberately a zero-dep type pkg).
 *
 * How: the granule position of the LAST Ogg page is the total sample count
 * at opus's fixed 48 kHz clock ⇒ ms = granulepos / 48. We ignore the
 * OpusHead pre-skip (~312 samples ≈ 6.5 ms) — bubble-label precision.
 */

/** Honest size-based estimate (~16 kbps mono ≈ 2000 bytes/s), floor 1s. */
function estimateMsFromSize(byteLength: number): number {
  return Math.max(1000, Math.round(byteLength / 2))
}

const OGG_MAGIC = Buffer.from('OggS', 'ascii')

/** 24h of samples at the opus 48 kHz clock — anything above is a corrupt page. */
const MAX_PLAUSIBLE_GRANULE = 24n * 3600n * 48000n

/**
 * Duration (ms) of an ogg/opus clip.
 *
 *  - Not an Ogg container at all (no `OggS` capture pattern) → `null`;
 *    the caller must NOT upload it as `file_type=opus` (Lark can't play it).
 *  - Ogg, but the last page's granule position is unreadable / non-positive
 *    / absurd → size-based estimate. It IS opus; a rough bubble label beats
 *    refusing to speak.
 */
export function opusDurationMs(bytes: Buffer | Uint8Array): number | null {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = buf.lastIndexOf(OGG_MAGIC)
  if (at === -1) return null
  // Page header: OggS(4) version(1) type(1) granule_position(8 LE) …
  if (at + 14 > buf.length) return estimateMsFromSize(buf.length)
  const granule = buf.readBigInt64LE(at + 6)
  if (granule <= 0n || granule > MAX_PLAUSIBLE_GRANULE) return estimateMsFromSize(buf.length)
  return Math.round(Number(granule) / 48)
}
