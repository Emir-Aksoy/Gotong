import type { Frame } from './frames.js'

export type DecodeResult<F extends Frame = Frame> =
  | { ok: true; frame: F }
  | {
      ok: false
      reason: 'invalid_json' | 'not_object' | 'missing_type' | 'invalid_frame' | 'too_large'
      detail?: string
    }

/**
 * Maximum text payload `decodeFrame` will parse, in **bytes** (UTF-16
 * code units in JS strings — close enough to bytes for the size
 * envelope we care about). Frames larger than this fail fast with
 * `reason: 'too_large'` BEFORE `JSON.parse` runs, so a multi-megabyte
 * payload can't OOM the host on parse.
 *
 * This is defence in depth — the transport layer should already cap
 * payloads via `WebSocketServer.maxPayload` (see
 * `@aipehub/transport-ws` finding C1). The check here protects:
 *
 *   - Test harnesses and SDK consumers that decode frames without
 *     going through the WS server.
 *   - Future transports (HTTP long-poll, named-pipe IPC) that may not
 *     have a comparable size knob.
 *
 * Default 1 MiB — comfortably above the 256 KiB `maxPayload` default
 * in transport-ws but small enough that a single-frame parse never
 * pushes the heap past a megabyte. See AUDIT-v3.3.md finding H12.
 *
 * Override via `decodeFrame(text, { maxBytes })` for callers that
 * need to accept larger frames (e.g. artifact-uploaded TASK payloads).
 */
export const DEFAULT_DECODE_MAX_BYTES = 1_048_576 // 1 MiB

export interface DecodeFrameOptions {
  /** Override the default 1 MiB size cap. Pass 0 or a negative value to disable. */
  maxBytes?: number
}

/**
 * Decode a WebSocket text payload into a Frame. The check is shallow on
 * purpose: we validate the envelope (`{ type: string, ... }`) and trust
 * the discriminated union for the rest. Callers can narrow with
 * `frame.type` and validate fields as needed.
 *
 * Pre-flight size check (v3.4): payloads longer than `maxBytes`
 * (default 1 MiB) are rejected without invoking `JSON.parse`. The
 * `detail` field on the failed result carries the actual byte count
 * so log shippers can correlate with throttle-style alerts. See
 * AUDIT-v3.3.md finding H12.
 */
export function decodeFrame(text: string, options: DecodeFrameOptions = {}): DecodeResult {
  const maxBytes = options.maxBytes ?? DEFAULT_DECODE_MAX_BYTES
  if (maxBytes > 0 && text.length > maxBytes) {
    return {
      ok: false,
      reason: 'too_large',
      detail: `payload is ${text.length} bytes, exceeds limit of ${maxBytes}`,
    }
  }
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

/**
 * Strict-mode decode. Same as `decodeFrame` but additionally validates the
 * per-type required fields. Intended for dev / integration testing of
 * third-party SDK implementations — production hot path stays on
 * `decodeFrame` for cost reasons (validation is O(n) on object size).
 *
 * Gated by callers via `AIPE_PROTOCOL_STRICT=1` env (see
 * `@aipehub/transport-ws` for the wire-up). The function itself reads
 * nothing from the environment so it remains a pure function safe for
 * unit-testing.
 *
 * Validation philosophy: same forward-compat promise as the lax path —
 * unknown frame `type` values pass (so a v1.5 client reading a v2.0 frame
 * doesn't hard-fail), and unknown extra fields on a known frame are
 * tolerated. We only reject frames whose **required** named field is
 * missing or has the wrong primitive type.
 */
export function decodeFrameStrict(text: string, options: DecodeFrameOptions = {}): DecodeResult {
  const lax = decodeFrame(text, options)
  if (!lax.ok) return lax
  const detail = validateFrame(lax.frame)
  if (detail) return { ok: false, reason: 'invalid_frame', detail }
  return lax
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame)
}

// ---------------------------------------------------------------------------
// Frame validation — strict-mode only
// ---------------------------------------------------------------------------
//
// Hand-written field checks (no zod / no schema lib) so `@aipehub/protocol`
// stays zero-runtime-deps. Each branch covers ONLY the fields the type
// signature declares as required; optional fields and unknown extras pass
// through (forward-compat rule).
//
// Returns null when the frame is well-formed under its discriminator, or
// a human-readable diagnostic string otherwise. Callers don't enumerate
// reasons — the string is fed back to the operator who set
// `AIPE_PROTOCOL_STRICT=1` because they were debugging a bad-frame
// situation in the first place.

function validateFrame(frame: Frame): string | null {
  const f = frame as Record<string, unknown>
  switch (f.type) {
    case 'HELLO':
      if (typeof f.protocolVersion !== 'string') return 'HELLO.protocolVersion must be a string'
      if (!isObject(f.client)) return 'HELLO.client must be an object'
      if (typeof (f.client as { name?: unknown }).name !== 'string') return 'HELLO.client.name must be a string'
      if (typeof (f.client as { version?: unknown }).version !== 'string') return 'HELLO.client.version must be a string'
      if (!Array.isArray(f.agents)) return 'HELLO.agents must be an array'
      for (const [i, a] of (f.agents as unknown[]).entries()) {
        if (!isObject(a)) return `HELLO.agents[${i}] must be an object`
        if (typeof (a as { id?: unknown }).id !== 'string') return `HELLO.agents[${i}].id must be a string`
        if (!Array.isArray((a as { capabilities?: unknown }).capabilities)) {
          return `HELLO.agents[${i}].capabilities must be an array`
        }
      }
      return null
    case 'WELCOME':
      if (typeof f.sessionId !== 'string') return 'WELCOME.sessionId must be a string'
      if (typeof f.protocolVersion !== 'string') return 'WELCOME.protocolVersion must be a string'
      if (typeof f.serverTime !== 'number') return 'WELCOME.serverTime must be a number'
      if (typeof f.heartbeatIntervalMs !== 'number') return 'WELCOME.heartbeatIntervalMs must be a number'
      return null
    case 'REJECT':
      if (typeof f.code !== 'string') return 'REJECT.code must be a string'
      if (typeof f.message !== 'string') return 'REJECT.message must be a string'
      return null
    case 'TASK':
      if (typeof f.recipient !== 'string') return 'TASK.recipient must be a string'
      if (!isObject(f.task)) return 'TASK.task must be an object'
      return null
    case 'RESULT':
      if (!isObject(f.result)) return 'RESULT.result must be an object'
      return null
    case 'PUBLISH':
      if (typeof f.from !== 'string') return 'PUBLISH.from must be a string'
      if (typeof f.channel !== 'string') return 'PUBLISH.channel must be a string'
      // body may be anything (including null) per the wire types
      return null
    case 'SUBSCRIBE':
    case 'UNSUBSCRIBE':
      if (typeof f.participantId !== 'string') return `${f.type}.participantId must be a string`
      if (typeof f.channel !== 'string') return `${f.type}.channel must be a string`
      return null
    case 'CANCEL':
      if (typeof f.recipient !== 'string') return 'CANCEL.recipient must be a string'
      if (typeof f.taskId !== 'string') return 'CANCEL.taskId must be a string'
      if (typeof f.reason !== 'string') return 'CANCEL.reason must be a string'
      return null
    case 'MESSAGE':
      if (typeof f.recipient !== 'string') return 'MESSAGE.recipient must be a string'
      if (!isObject(f.msg)) return 'MESSAGE.msg must be an object'
      return null
    case 'ERROR':
      if (typeof f.code !== 'string') return 'ERROR.code must be a string'
      if (typeof f.message !== 'string') return 'ERROR.message must be a string'
      return null
    case 'PING':
    case 'PONG':
      if (typeof f.ts !== 'number') return `${f.type}.ts must be a number`
      return null
    case 'GOODBYE':
      // reason is optional
      if (f.reason !== undefined && typeof f.reason !== 'string') return 'GOODBYE.reason must be a string'
      return null
    case 'SERVICE_CALL':
      if (typeof f.callId !== 'string') return 'SERVICE_CALL.callId must be a string'
      if (typeof f.from !== 'string') return 'SERVICE_CALL.from must be a string'
      if (!isObject(f.service)) return 'SERVICE_CALL.service must be an object'
      if (typeof (f.service as { type?: unknown }).type !== 'string') return 'SERVICE_CALL.service.type must be a string'
      if (typeof (f.service as { impl?: unknown }).impl !== 'string') return 'SERVICE_CALL.service.impl must be a string'
      if (!isObject((f.service as { owner?: unknown }).owner)) return 'SERVICE_CALL.service.owner must be an object'
      if (typeof f.method !== 'string') return 'SERVICE_CALL.method must be a string'
      if (!Array.isArray(f.args)) return 'SERVICE_CALL.args must be an array'
      return null
    case 'SERVICE_RESULT':
      if (typeof f.callId !== 'string') return 'SERVICE_RESULT.callId must be a string'
      if (typeof f.ok !== 'boolean') return 'SERVICE_RESULT.ok must be a boolean'
      if (f.ok === false) {
        if (!isObject(f.error)) return 'SERVICE_RESULT.error must be an object when ok=false'
        if (typeof (f.error as { code?: unknown }).code !== 'string') return 'SERVICE_RESULT.error.code must be a string'
        if (typeof (f.error as { message?: unknown }).message !== 'string') return 'SERVICE_RESULT.error.message must be a string'
      }
      // value (ok=true) may be anything — no check
      return null
    default:
      // Forward-compat: unknown discriminator passes. A v1.5 server can
      // legitimately send a frame type a v1.2 client has never heard of;
      // the lax decode path is what surfaces it, the caller decides
      // whether to log + ignore.
      return null
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
