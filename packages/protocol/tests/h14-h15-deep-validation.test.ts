/**
 * H14 + H15 regression — strict mode now recurses one layer into
 * `TASK.task` / `RESULT.result` / `MESSAGE.msg` (H14), and a new
 * `decodeFrameClosed` rejects unknown discriminators (H15).
 *
 * Pre-3.4:
 *   - `{ type: 'TASK', recipient: 'a', task: {} }` passed strict
 *     because `task` was just checked for "is object". The downstream
 *     SDK then crashed with a less useful error when it tried to read
 *     `task.id`. Same pattern for RESULT (TaskResult variants) and
 *     MESSAGE (Message shape).
 *   - `{ type: 'FROM_THE_FUTURE' }` passed strict by design (forward-
 *     compat). Useful in production; unhelpful when an operator is
 *     trying to assert "the new SDK is sending frames I don't
 *     recognise — fail closed so I can chase the bug".
 *
 * Fix:
 *   - H14: `validateFrame` now drops into `validateTask` /
 *     `validateTaskResult` / `validateMessageBody` for required
 *     subfields.
 *   - H15: New `decodeFrameClosed` enables an opt-in tighter mode
 *     that rejects unknown discriminators. Wired through
 *     `transport-ws` as `GOTONG_PROTOCOL_STRICT=closed`.
 *
 * See AUDIT-v3.3.md findings H14 + H15.
 */

import { describe, expect, it } from 'vitest'

import {
  decodeFrameClosed,
  decodeFrameStrict,
  encodeFrame,
  PROTOCOL_VERSION,
} from '../src/index.js'

// =============================================================================
// H14 — strict mode recurses into TASK.task
// =============================================================================

describe('H14 — TASK.task deep validation', () => {
  const validTaskInner = {
    id: 't1',
    from: 'alice',
    strategy: { kind: 'explicit', to: 'bob' },
    payload: { question: 'hi' },
    createdAt: 1234,
  }

  it('passes when every required field is present', () => {
    const frame = { type: 'TASK', recipient: 'bob', task: validTaskInner }
    const r = decodeFrameStrict(JSON.stringify(frame))
    expect(r.ok).toBe(true)
  })

  it('rejects an empty inner task (the pre-3.4 leakage case)', () => {
    // The audit-cited reproducer: `task: {}` passed pre-3.4.
    const frame = { type: 'TASK', recipient: 'bob', task: {} }
    const r = decodeFrameStrict(JSON.stringify(frame))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('invalid_frame')
      expect(r.detail).toContain('TASK.task.id')
    }
  })

  it('rejects task with missing `from`', () => {
    const t = { ...validTaskInner, from: undefined as unknown as string }
    delete (t as Record<string, unknown>).from
    const r = decodeFrameStrict(
      JSON.stringify({ type: 'TASK', recipient: 'bob', task: t }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('TASK.task.from')
  })

  it('rejects task with non-object strategy', () => {
    const r = decodeFrameStrict(
      JSON.stringify({
        type: 'TASK',
        recipient: 'bob',
        task: { ...validTaskInner, strategy: 'explicit' },
      }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('TASK.task.strategy')
  })

  it('rejects task with missing strategy.kind', () => {
    const r = decodeFrameStrict(
      JSON.stringify({
        type: 'TASK',
        recipient: 'bob',
        task: { ...validTaskInner, strategy: { to: 'bob' } },
      }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('strategy.kind')
  })

  it('rejects task with missing payload field entirely', () => {
    // `payload: null` is OK (allowed by the wire); `payload` absent
    // is not.
    const t = { ...validTaskInner }
    delete (t as Record<string, unknown>).payload
    const r = decodeFrameStrict(
      JSON.stringify({ type: 'TASK', recipient: 'bob', task: t }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('payload')
  })

  it('accepts task with payload=null (null is a valid JSON value)', () => {
    const r = decodeFrameStrict(
      JSON.stringify({
        type: 'TASK',
        recipient: 'bob',
        task: { ...validTaskInner, payload: null },
      }),
    )
    expect(r.ok).toBe(true)
  })

  it('rejects task with non-number createdAt', () => {
    const r = decodeFrameStrict(
      JSON.stringify({
        type: 'TASK',
        recipient: 'bob',
        task: { ...validTaskInner, createdAt: '1234' },
      }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('createdAt')
  })

  it('tolerates extra unknown fields (forward-compat)', () => {
    // Just because we recurse doesn't mean we get strict-mode happy
    // about unknown extras.
    const r = decodeFrameStrict(
      JSON.stringify({
        type: 'TASK',
        recipient: 'bob',
        task: { ...validTaskInner, futureField: 'something' },
      }),
    )
    expect(r.ok).toBe(true)
  })
})

// =============================================================================
// H14 — strict mode recurses into RESULT.result (4 variants)
// =============================================================================

describe('H14 — RESULT.result deep validation', () => {
  it("ok-variant requires `by` and `output`", () => {
    const r = decodeFrameStrict(
      JSON.stringify({
        type: 'RESULT',
        result: { kind: 'ok', taskId: 't1', ts: 1 },
      }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('by')
  })

  it('ok-variant accepts output=null (any JSON value)', () => {
    const r = decodeFrameStrict(
      JSON.stringify({
        type: 'RESULT',
        result: { kind: 'ok', taskId: 't1', by: 'alice', output: null, ts: 1 },
      }),
    )
    expect(r.ok).toBe(true)
  })

  it('failed-variant requires `error` as string', () => {
    const r = decodeFrameStrict(
      JSON.stringify({
        type: 'RESULT',
        result: { kind: 'failed', taskId: 't1', by: 'alice', ts: 1 },
      }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('error')
  })

  it('cancelled-variant requires `reason` as string', () => {
    const r = decodeFrameStrict(
      JSON.stringify({
        type: 'RESULT',
        result: { kind: 'cancelled', taskId: 't1', ts: 1 },
      }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('reason')
  })

  it('no_participant-variant requires `reason`', () => {
    const r = decodeFrameStrict(
      JSON.stringify({
        type: 'RESULT',
        result: { kind: 'no_participant', taskId: 't1', ts: 1 },
      }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('reason')
  })

  it('unknown kind passes (forward-compat — future TaskResult variants)', () => {
    // Strict mode keeps forward-compat for new result kinds — the
    // receiver already needs a default branch.
    const r = decodeFrameStrict(
      JSON.stringify({
        type: 'RESULT',
        result: { kind: 'partial', taskId: 't1', ts: 1, extra: 'whatever' },
      }),
    )
    expect(r.ok).toBe(true)
  })
})

// =============================================================================
// H14 — strict mode recurses into MESSAGE.msg
// =============================================================================

describe('H14 — MESSAGE.msg deep validation', () => {
  const validMsg = {
    id: 'm1',
    channel: 'general',
    from: 'alice',
    body: { text: 'hello' },
    ts: 1234,
  }

  it('passes a well-formed message', () => {
    const r = decodeFrameStrict(
      JSON.stringify({ type: 'MESSAGE', recipient: 'bob', msg: validMsg }),
    )
    expect(r.ok).toBe(true)
  })

  it('rejects msg without `id`', () => {
    const m = { ...validMsg }
    delete (m as Record<string, unknown>).id
    const r = decodeFrameStrict(
      JSON.stringify({ type: 'MESSAGE', recipient: 'bob', msg: m }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('MESSAGE.msg.id')
  })

  it('rejects msg without `channel`', () => {
    const m = { ...validMsg }
    delete (m as Record<string, unknown>).channel
    const r = decodeFrameStrict(
      JSON.stringify({ type: 'MESSAGE', recipient: 'bob', msg: m }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('channel')
  })

  it('accepts msg with body=null', () => {
    const r = decodeFrameStrict(
      JSON.stringify({
        type: 'MESSAGE',
        recipient: 'bob',
        msg: { ...validMsg, body: null },
      }),
    )
    expect(r.ok).toBe(true)
  })
})

// =============================================================================
// H15 — decodeFrameClosed rejects unknown discriminators
// =============================================================================

describe('H15 — decodeFrameClosed unknown-type behaviour', () => {
  it('strict still PASSES unknown frame types (forward-compat)', () => {
    // Sanity: strict mode keeps the forward-compat promise so a
    // v1.5 client can read a v2.0 frame without hard-failing.
    const r = decodeFrameStrict(
      JSON.stringify({ type: 'FROM_THE_FUTURE', whatever: 1 }),
    )
    expect(r.ok).toBe(true)
  })

  it('closed REJECTS unknown frame types with a useful detail', () => {
    const r = decodeFrameClosed(
      JSON.stringify({ type: 'FROM_THE_FUTURE', whatever: 1 }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('invalid_frame')
      expect(r.detail).toContain("'FROM_THE_FUTURE'")
    }
  })

  it('closed accepts a well-formed known frame', () => {
    const helloFrame = encodeFrame({
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      agents: [{ id: 'a', capabilities: [] }],
    })
    const r = decodeFrameClosed(helloFrame)
    expect(r.ok).toBe(true)
  })

  it('closed inherits all strict deep-field checks (HELLO)', () => {
    // Regression: making sure closed mode is "strict + reject
    // unknown", not "strict + reject unknown, lose other rules".
    const r = decodeFrameClosed(
      JSON.stringify({
        type: 'HELLO',
        protocolVersion: PROTOCOL_VERSION,
        client: { name: 42, version: '0.0.0' }, // wrong type
        agents: [],
      }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('HELLO.client.name')
  })

  it('closed inherits all H14 deep-field checks (TASK)', () => {
    const r = decodeFrameClosed(
      JSON.stringify({ type: 'TASK', recipient: 'a', task: {} }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('TASK.task.id')
  })

  it('closed propagates envelope errors unchanged', () => {
    expect(decodeFrameClosed('{not-json').ok).toBe(false)
    expect(decodeFrameClosed('42').ok).toBe(false)
    expect(decodeFrameClosed('{}').ok).toBe(false)
  })
})
