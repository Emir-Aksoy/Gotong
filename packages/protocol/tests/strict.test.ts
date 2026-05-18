/**
 * `decodeFrameStrict` is the dev-only validation path that catches
 * bad-frame bugs from external SDK implementations early — the lax
 * `decodeFrame` only checks the envelope, so a `HELLO` with the wrong
 * `client.name` shape would silently slip through and only surface as
 * a confused runtime error deep in the transport layer.
 *
 * Two invariants we pin:
 *   1. Anything `decodeFrame` accepts AND is well-formed under its
 *      discriminator → `decodeFrameStrict` also accepts.
 *   2. Anything malformed under its discriminator → `decodeFrameStrict`
 *      returns `{ ok: false, reason: 'invalid_frame', detail }` with a
 *      detail string that mentions the offending field.
 *
 * Forward-compat: unknown frame `type` strings still pass (a v1.5 client
 * reading a v2.0 frame must not hard-fail).
 */

import { describe, expect, it } from 'vitest'

import {
  decodeFrame,
  decodeFrameStrict,
  encodeFrame,
  PROTOCOL_VERSION,
  type Frame,
} from '../src/index.js'

describe('decodeFrameStrict — passthrough for envelope errors', () => {
  it('still returns invalid_json on bad JSON', () => {
    expect(decodeFrameStrict('{not json')).toEqual({ ok: false, reason: 'invalid_json' })
  })

  it('still returns not_object on a scalar', () => {
    expect(decodeFrameStrict('42')).toEqual({ ok: false, reason: 'not_object' })
  })

  it('still returns missing_type when type is absent', () => {
    expect(decodeFrameStrict('{}')).toEqual({ ok: false, reason: 'missing_type' })
  })
})

describe('decodeFrameStrict — happy path mirrors decodeFrame', () => {
  // Pin: every shape that round-trips through encodeFrame must also pass
  // strict decode. If this drifts we have a contract bug.
  const samples: Frame[] = [
    { type: 'PING', ts: 1 },
    { type: 'PONG', ts: 2 },
    { type: 'GOODBYE' },
    { type: 'GOODBYE', reason: 'shutdown' },
    {
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'aipehub-test', version: '0.0.0' },
      agents: [{ id: 'a', capabilities: [] }],
    },
    {
      type: 'WELCOME',
      sessionId: 's1',
      protocolVersion: PROTOCOL_VERSION,
      serverTime: 1,
      heartbeatIntervalMs: 30_000,
    },
    { type: 'REJECT', code: 'auth_failed', message: 'no api key' },
    { type: 'CANCEL', recipient: 'a', taskId: 't', reason: 'broadcast lost' },
    { type: 'ERROR', code: 'bad_frame', message: 'oops' },
    {
      type: 'SERVICE_RESULT',
      callId: 'c1',
      ok: false,
      error: { code: 'forbidden_service', message: 'no decl' },
    },
    { type: 'SERVICE_RESULT', callId: 'c1', ok: true, value: { x: 1 } },
  ]
  for (const frame of samples) {
    it(`accepts well-formed ${frame.type}`, () => {
      const lax = decodeFrame(encodeFrame(frame))
      const strict = decodeFrameStrict(encodeFrame(frame))
      expect(lax.ok).toBe(true)
      expect(strict.ok).toBe(true)
    })
  }
})

describe('decodeFrameStrict — rejects malformed per-type fields', () => {
  function expectInvalid(json: string, hint: RegExp): void {
    const r = decodeFrameStrict(json)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('invalid_frame')
      expect(r.detail ?? '').toMatch(hint)
    }
  }

  it('HELLO without client.name', () => {
    expectInvalid(
      '{"type":"HELLO","protocolVersion":"1.2","client":{"version":"0.0"},"agents":[]}',
      /client\.name/,
    )
  })

  it('HELLO without agents array', () => {
    expectInvalid(
      '{"type":"HELLO","protocolVersion":"1.2","client":{"name":"x","version":"0"}}',
      /agents/,
    )
  })

  it('HELLO agent missing id', () => {
    expectInvalid(
      '{"type":"HELLO","protocolVersion":"1.2","client":{"name":"x","version":"0"},"agents":[{"capabilities":[]}]}',
      /agents\[0\]\.id/,
    )
  })

  it('WELCOME with non-numeric serverTime', () => {
    expectInvalid(
      '{"type":"WELCOME","sessionId":"s","protocolVersion":"1.2","serverTime":"now","heartbeatIntervalMs":30000}',
      /serverTime/,
    )
  })

  it('REJECT without message', () => {
    expectInvalid('{"type":"REJECT","code":"auth_failed"}', /message/)
  })

  it('TASK without task object', () => {
    expectInvalid('{"type":"TASK","recipient":"a"}', /task/)
  })

  it('SERVICE_CALL with non-array args', () => {
    expectInvalid(
      '{"type":"SERVICE_CALL","callId":"c","from":"a","service":{"type":"memory","impl":"file","owner":{"kind":"agent","id":"a"}},"method":"recall","args":{}}',
      /args/,
    )
  })

  it('SERVICE_RESULT ok=false without error', () => {
    expectInvalid('{"type":"SERVICE_RESULT","callId":"c","ok":false}', /error/)
  })

  it('PING with string ts', () => {
    expectInvalid('{"type":"PING","ts":"now"}', /ts/)
  })

  it('GOODBYE with non-string reason', () => {
    // reason is OPTIONAL — but if present, must be a string.
    expectInvalid('{"type":"GOODBYE","reason":42}', /reason/)
  })
})

describe('decodeFrameStrict — forward-compat', () => {
  it('unknown frame type passes (silent forward-compat)', () => {
    // A v1.5 server might send `WHATEVER`. The lax decode passes; the
    // strict decode also passes — failing here would be the wrong move
    // because we have no schema to validate against.
    const r = decodeFrameStrict('{"type":"WHATEVER","x":1}')
    expect(r.ok).toBe(true)
  })

  it('extra unknown fields on a known frame still pass', () => {
    const r = decodeFrameStrict('{"type":"PING","ts":1,"unrelated":"hi"}')
    expect(r.ok).toBe(true)
  })
})
