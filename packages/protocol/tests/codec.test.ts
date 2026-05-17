/**
 * `codec.ts` is two ten-line functions but they live on every WebSocket
 * frame in both directions — a regression here silently breaks every
 * connection. The tests pin down the four observable decode outcomes
 * (ok / invalid_json / not_object / missing_type), assert round-trip
 * encode→decode is lossless on every Frame shape we ship, and prove
 * extra/unknown fields are tolerated (the protocol's forward-compat
 * promise).
 */

import { describe, expect, it } from 'vitest'

import {
  decodeFrame,
  encodeFrame,
  PROTOCOL_VERSION,
  type ClientFrame,
  type Frame,
  type ServerFrame,
} from '../src/index.js'

describe('decodeFrame — happy path', () => {
  it('returns a Frame when given a JSON object with a string `type`', () => {
    const out = decodeFrame('{"type":"PING","ts":123}')
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.frame.type).toBe('PING')
      // Round-trip preserves the rest of the payload verbatim.
      expect((out.frame as { ts: number }).ts).toBe(123)
    }
  })

  it('accepts an unknown `type` string — discriminator is not gated', () => {
    // The wire protocol's forward-compat promise: a v1.5 server can send
    // frame types a v1.0 client has never heard of. Decode must succeed
    // so the caller can choose to log + ignore rather than hard-fail.
    const out = decodeFrame('{"type":"FROM_THE_FUTURE","x":1}')
    expect(out.ok).toBe(true)
  })

  it('tolerates extra unknown fields on a known frame', () => {
    const out = decodeFrame('{"type":"PONG","ts":7,"latencyMs":12,"foo":"bar"}')
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect((out.frame as { latencyMs: number }).latencyMs).toBe(12)
      expect((out.frame as { foo: string }).foo).toBe('bar')
    }
  })
})

describe('decodeFrame — error branches', () => {
  it('reports invalid_json on malformed input', () => {
    const out = decodeFrame('{not json')
    expect(out).toEqual({ ok: false, reason: 'invalid_json' })
  })

  it('reports not_object on a JSON scalar', () => {
    expect(decodeFrame('42')).toEqual({ ok: false, reason: 'not_object' })
    expect(decodeFrame('"hello"')).toEqual({ ok: false, reason: 'not_object' })
    expect(decodeFrame('true')).toEqual({ ok: false, reason: 'not_object' })
    // null is technically an object in JS but the JSON.parse result is
    // typeof === 'object' && obj === null; our check uses `!obj` so it
    // falls into not_object as intended.
    expect(decodeFrame('null')).toEqual({ ok: false, reason: 'not_object' })
  })

  it('reports not_object on a JSON array', () => {
    // Array passes typeof === 'object', but `[].type` is undefined →
    // the missing-type branch is what fires. Documented here so the
    // ordering of checks doesn't drift.
    expect(decodeFrame('[]')).toEqual({ ok: false, reason: 'missing_type' })
  })

  it('reports missing_type when `type` is absent', () => {
    expect(decodeFrame('{}')).toEqual({ ok: false, reason: 'missing_type' })
    expect(decodeFrame('{"foo":"bar"}')).toEqual({ ok: false, reason: 'missing_type' })
  })

  it('reports missing_type when `type` is the wrong shape', () => {
    expect(decodeFrame('{"type":42}')).toEqual({ ok: false, reason: 'missing_type' })
    expect(decodeFrame('{"type":null}')).toEqual({ ok: false, reason: 'missing_type' })
    expect(decodeFrame('{"type":["PING"]}')).toEqual({ ok: false, reason: 'missing_type' })
  })
})

describe('encodeFrame', () => {
  it('produces a string that decodeFrame can roundtrip', () => {
    const original: Frame = { type: 'PING', ts: 999 }
    const encoded = encodeFrame(original)
    expect(typeof encoded).toBe('string')
    const decoded = decodeFrame(encoded)
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.frame).toEqual(original)
  })

  it('does not embed undefined fields (matches JSON.stringify semantics)', () => {
    // ResultFrame has an optional reason on GOODBYE — omitting it should
    // NOT produce a literal "reason": undefined on the wire (invalid JSON).
    const frame: Frame = { type: 'GOODBYE' }
    expect(encodeFrame(frame)).toBe('{"type":"GOODBYE"}')
  })
})

describe('encodeFrame → decodeFrame — round-trip coverage of every Frame shape', () => {
  // One sample per discriminant from frames.ts. Failure here means a
  // frame variant has changed shape — adjust the sample AND the
  // server-side handler that reads it.
  const samples: { name: string; frame: Frame }[] = [
    // ClientFrame
    {
      name: 'HELLO (v1.0 — no services)',
      frame: {
        type: 'HELLO',
        protocolVersion: PROTOCOL_VERSION,
        client: { name: 'aipehub-test', version: '0.0.0' },
        agents: [{ id: 'a', capabilities: ['x'] }],
      } satisfies ClientFrame,
    },
    {
      name: 'HELLO (v1.1+ — with services)',
      frame: {
        type: 'HELLO',
        protocolVersion: PROTOCOL_VERSION,
        client: { name: 'aipehub-test', version: '0.0.0' },
        agents: [{ id: 'a', capabilities: [] }],
        services: [
          {
            type: 'memory',
            impl: 'file',
            owner: { kind: 'agent', id: 'self' },
          },
        ],
      } satisfies ClientFrame,
    },
    {
      name: 'RESULT',
      frame: {
        type: 'RESULT',
        result: {
          kind: 'ok',
          taskId: 't1',
          by: 'a',
          ts: 0,
        },
      } satisfies ClientFrame,
    },
    {
      name: 'PUBLISH',
      frame: { type: 'PUBLISH', from: 'a', channel: 'chan-x', body: { v: 1 } },
    },
    {
      name: 'SUBSCRIBE',
      frame: { type: 'SUBSCRIBE', participantId: 'a', channel: 'chan-x' },
    },
    {
      name: 'UNSUBSCRIBE',
      frame: { type: 'UNSUBSCRIBE', participantId: 'a', channel: 'chan-x' },
    },
    {
      name: 'SERVICE_CALL',
      frame: {
        type: 'SERVICE_CALL',
        callId: 'c1',
        from: 'a',
        service: { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'a' } },
        method: 'recall',
        args: [{ k: 5 }],
      } satisfies ClientFrame,
    },
    {
      name: 'PING (either direction)',
      frame: { type: 'PING', ts: 1 },
    },
    {
      name: 'PONG (either direction)',
      frame: { type: 'PONG', ts: 1 },
    },
    {
      name: 'GOODBYE (either direction)',
      frame: { type: 'GOODBYE', reason: 'shutdown' },
    },
    // ServerFrame
    {
      name: 'WELCOME',
      frame: {
        type: 'WELCOME',
        sessionId: 's1',
        protocolVersion: PROTOCOL_VERSION,
        serverTime: 1700000000000,
        heartbeatIntervalMs: 30_000,
      } satisfies ServerFrame,
    },
    {
      name: 'REJECT',
      frame: { type: 'REJECT', code: 'auth_failed', message: 'no api key' },
    },
    {
      name: 'TASK',
      frame: {
        type: 'TASK',
        recipient: 'a',
        task: {
          id: 't1',
          from: 'system',
          strategy: { kind: 'explicit', to: 'a' },
          payload: { hello: true },
        },
      },
    },
    {
      name: 'CANCEL',
      frame: { type: 'CANCEL', recipient: 'a', taskId: 't1', reason: 'user' },
    },
    {
      name: 'MESSAGE',
      frame: {
        type: 'MESSAGE',
        recipient: 'a',
        msg: { from: 'sys', channel: 'chan-x', body: { v: 1 }, ts: 0 },
      },
    },
    {
      name: 'ERROR',
      frame: { type: 'ERROR', code: 'bad_frame', message: 'oops' },
    },
    {
      name: 'SERVICE_RESULT (ok)',
      frame: { type: 'SERVICE_RESULT', callId: 'c1', ok: true, value: { items: [] } },
    },
    {
      name: 'SERVICE_RESULT (error)',
      frame: {
        type: 'SERVICE_RESULT',
        callId: 'c1',
        ok: false,
        error: { code: 'forbidden_service', message: 'no decl' },
      },
    },
  ]

  for (const { name, frame } of samples) {
    it(`round-trips ${name}`, () => {
      const encoded = encodeFrame(frame)
      const decoded = decodeFrame(encoded)
      expect(decoded.ok).toBe(true)
      if (decoded.ok) expect(decoded.frame).toEqual(frame)
    })
  }
})
