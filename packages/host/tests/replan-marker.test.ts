/**
 * P1-4 — Replanning marker parser unit tests.
 *
 * The marker is the synthesist's way to say "go back and re-run X
 * dimension before this 12-week plan is usable." It's a hint, not an
 * auto-trigger — the admin opens the artifact, sees the banner, and
 * decides whether to act.
 *
 * Covered:
 *   - Happy path: well-formed marker → parsed
 *   - All 5 allowed dimension steps recognised
 *   - portrait / synthesis / unknown step → rejected (those are
 *     workflow-level concerns, not REPLAN-level)
 *   - Missing reason / empty reason / overlong reason → rejected
 *   - No marker → null (the common case)
 *   - Malformed JSON → null
 *   - Marker that's not an object (array / primitive) → null
 *   - Extra whitespace inside the tags tolerated
 */

import { describe, expect, it } from 'vitest'

import {
  parseReplanMarker,
  REPLAN_ALLOWED_STEPS,
} from '../src/agents/personal-growth-agent.js'

describe('parseReplanMarker (P1-4)', () => {
  it('returns null when no marker is present', () => {
    expect(parseReplanMarker('## 一句话发展路径\n先把睡眠按住,再启动副业。')).toBeNull()
  })

  it('returns null for malformed JSON inside marker', () => {
    expect(
      parseReplanMarker('something <REPLAN>{not valid json}</REPLAN> trailing'),
    ).toBeNull()
  })

  it('returns null when JSON is not an object (array)', () => {
    expect(parseReplanMarker('<REPLAN>["body","x"]</REPLAN>')).toBeNull()
  })

  it('returns null when JSON is not an object (string primitive)', () => {
    expect(parseReplanMarker('<REPLAN>"hello"</REPLAN>')).toBeNull()
  })

  it('returns parsed object for a well-formed body marker', () => {
    const got = parseReplanMarker(
      '...some prose...\n<REPLAN>{"step":"body","reason":"body 漏看了桥本氏症"}</REPLAN>\n...more prose...',
    )
    expect(got).toEqual({ step: 'body', reason: 'body 漏看了桥本氏症' })
  })

  it('recognises all 5 allowed dimension steps', () => {
    for (const step of REPLAN_ALLOWED_STEPS) {
      const text = `<REPLAN>{"step":"${step}","reason":"test"}</REPLAN>`
      const got = parseReplanMarker(text)
      expect(got).toEqual({ step, reason: 'test' })
    }
  })

  it('rejects portrait step (workflow-level concern, not REPLAN)', () => {
    expect(
      parseReplanMarker('<REPLAN>{"step":"portrait","reason":"x"}</REPLAN>'),
    ).toBeNull()
  })

  it('rejects synthesis step (the synthesist re-running itself is nonsense)', () => {
    expect(
      parseReplanMarker('<REPLAN>{"step":"synthesis","reason":"x"}</REPLAN>'),
    ).toBeNull()
  })

  it('rejects unknown step name', () => {
    expect(
      parseReplanMarker('<REPLAN>{"step":"finance","reason":"x"}</REPLAN>'),
    ).toBeNull()
  })

  it('rejects missing reason', () => {
    expect(parseReplanMarker('<REPLAN>{"step":"body"}</REPLAN>')).toBeNull()
  })

  it('rejects empty / whitespace-only reason', () => {
    expect(
      parseReplanMarker('<REPLAN>{"step":"body","reason":""}</REPLAN>'),
    ).toBeNull()
    expect(
      parseReplanMarker('<REPLAN>{"step":"body","reason":"   "}</REPLAN>'),
    ).toBeNull()
  })

  it('rejects overlong reason (> 200 chars) — defensive against LLM pasting whole paragraphs', () => {
    const overlong = 'x'.repeat(201)
    expect(
      parseReplanMarker(`<REPLAN>{"step":"body","reason":"${overlong}"}</REPLAN>`),
    ).toBeNull()
  })

  it('trims the reason whitespace', () => {
    const got = parseReplanMarker(
      '<REPLAN>{"step":"mind","reason":"  trimmed  "}</REPLAN>',
    )
    expect(got).toEqual({ step: 'mind', reason: 'trimmed' })
  })

  it('tolerates extra whitespace and newlines between tags and JSON', () => {
    const text = '<REPLAN>\n  {"step":"goal","reason":"r"}  \n</REPLAN>'
    expect(parseReplanMarker(text)).toEqual({ step: 'goal', reason: 'r' })
  })

  it('first marker wins when two appear (defensive — synthesist should only emit one)', () => {
    const text =
      '<REPLAN>{"step":"body","reason":"first"}</REPLAN>' +
      '<REPLAN>{"step":"mind","reason":"second"}</REPLAN>'
    expect(parseReplanMarker(text)).toEqual({ step: 'body', reason: 'first' })
  })

  it('synthesist with no replan section returns null even if document mentions "REPLAN" elsewhere', () => {
    // Just talking about the feature isn't the same as emitting the marker.
    const text =
      '## 是否建议重跑某维度(可选)\n无 — 5 维分析连贯,无需重跑(若有矛盾会在这里写 <REPLAN> JSON 标记)。'
    expect(parseReplanMarker(text)).toBeNull()
  })
})
