import type { Frame } from './frames.js'

export type DecodeResult<F extends Frame = Frame> =
  | { ok: true; frame: F }
  | { ok: false; reason: 'invalid_json' | 'not_object' | 'missing_type' }

/**
 * Decode a WebSocket text payload into a Frame. The check is shallow on
 * purpose: we validate the envelope (`{ type: string, ... }`) and trust
 * the discriminated union for the rest. Callers can narrow with
 * `frame.type` and validate fields as needed.
 */
export function decodeFrame(text: string): DecodeResult {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not_object' }
  const t = (obj as { type?: unknown }).type
  if (typeof t !== 'string') return { ok: false, reason: 'missing_type' }
  return { ok: true, frame: obj as Frame }
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame)
}
