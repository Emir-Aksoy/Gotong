/**
 * Unit tests for the HITL helpers added to PersonalGrowthAgent in v2.5.
 *
 * Covers:
 *   - parseNeedInputMarker — extract + validate the LLM's NEED_INPUT
 *     block, with graceful degradation on malformed input
 *   - renderQaBlock — formats the second-round prompt augmentation
 *
 * The actual end-to-end "agent dispatches to admin, waits, resumes"
 * path is exercised by scripts/test-hitl.mjs (live LLM round-trip).
 * These unit tests pin the boundary behaviour we DON'T want to drift
 * — especially the "≤3 questions" cap and the "fall through on bad
 * JSON" promises, both of which are load-bearing for not deadlocking
 * a workflow run on a confused LLM.
 */

import { describe, expect, it } from 'vitest'

import {
  parseNeedInputMarker,
  renderQaBlock,
} from '../src/agents/personal-growth-agent.js'

describe('parseNeedInputMarker', () => {
  it('extracts a well-formed marker with one textarea question', () => {
    const text = `prelude\n<NEED_INPUT>{"questions":[{"id":"sleep","label":"睡眠如何","type":"textarea"}]}</NEED_INPUT>\nepilogue`
    const r = parseNeedInputMarker(text)
    expect(r).not.toBeNull()
    expect(r?.questions).toEqual([
      { id: 'sleep', label: '睡眠如何', type: 'textarea' },
    ])
  })

  it('returns null when no marker is present', () => {
    expect(parseNeedInputMarker('just a portrait, no marker')).toBeNull()
  })

  it('returns null when JSON inside marker is malformed', () => {
    const text = '<NEED_INPUT>{not valid json}</NEED_INPUT>'
    expect(parseNeedInputMarker(text)).toBeNull()
  })

  it('returns null when questions array is empty', () => {
    const text = '<NEED_INPUT>{"questions":[]}</NEED_INPUT>'
    expect(parseNeedInputMarker(text)).toBeNull()
  })

  it('returns null when questions exceeds the hard cap of 3', () => {
    // Four questions — over-cap suggests the LLM is drifting; we
    // bail and let the first-round output stand. Catches a real
    // degradation mode (the alternative is asking the user to
    // answer 8+ questions in one go).
    const qs = Array.from({ length: 4 }, (_, i) => ({
      id: `q${i}`,
      label: `Q${i}`,
      type: 'textarea',
    }))
    const text = `<NEED_INPUT>${JSON.stringify({ questions: qs })}</NEED_INPUT>`
    expect(parseNeedInputMarker(text)).toBeNull()
  })

  it('returns null when a question has no id', () => {
    const text = '<NEED_INPUT>{"questions":[{"label":"no id","type":"textarea"}]}</NEED_INPUT>'
    expect(parseNeedInputMarker(text)).toBeNull()
  })

  it('returns null when a question has no label', () => {
    const text = '<NEED_INPUT>{"questions":[{"id":"x","type":"textarea"}]}</NEED_INPUT>'
    expect(parseNeedInputMarker(text)).toBeNull()
  })

  it('defaults type to textarea when omitted', () => {
    const text = '<NEED_INPUT>{"questions":[{"id":"x","label":"x?"}]}</NEED_INPUT>'
    const r = parseNeedInputMarker(text)
    expect(r?.questions[0]?.type).toBe('textarea')
  })

  it('coerces an unknown type to textarea (defensive)', () => {
    const text = '<NEED_INPUT>{"questions":[{"id":"x","label":"x?","type":"checkbox"}]}</NEED_INPUT>'
    const r = parseNeedInputMarker(text)
    expect(r?.questions[0]?.type).toBe('textarea')
  })

  it('preserves rows hint for textarea (clamped to 1-20)', () => {
    const text = '<NEED_INPUT>{"questions":[{"id":"x","label":"X","type":"textarea","rows":5}]}</NEED_INPUT>'
    const r = parseNeedInputMarker(text)
    expect(r?.questions[0]?.rows).toBe(5)
  })

  it('clamps rows above 20', () => {
    const text = '<NEED_INPUT>{"questions":[{"id":"x","label":"X","type":"textarea","rows":999}]}</NEED_INPUT>'
    expect(parseNeedInputMarker(text)?.questions[0]?.rows).toBe(20)
  })

  it('drops bogus rows (non-number, NaN)', () => {
    const text = '<NEED_INPUT>{"questions":[{"id":"x","label":"X","type":"textarea","rows":"five"}]}</NEED_INPUT>'
    expect(parseNeedInputMarker(text)?.questions[0]?.rows).toBeUndefined()
  })

  it('preserves required:true', () => {
    const text = '<NEED_INPUT>{"questions":[{"id":"x","label":"X","required":true}]}</NEED_INPUT>'
    expect(parseNeedInputMarker(text)?.questions[0]?.required).toBe(true)
  })

  it('strips required when not exactly true (defensive)', () => {
    const text = '<NEED_INPUT>{"questions":[{"id":"x","label":"X","required":"yes"}]}</NEED_INPUT>'
    expect(parseNeedInputMarker(text)?.questions[0]?.required).toBeUndefined()
  })

  it('captures optional title + context', () => {
    const text = '<NEED_INPUT>{"title":"补一些","context":"info too thin","questions":[{"id":"x","label":"X"}]}</NEED_INPUT>'
    const r = parseNeedInputMarker(text)
    expect(r?.title).toBe('补一些')
    expect(r?.context).toBe('info too thin')
  })

  it('handles multiline JSON inside the marker', () => {
    const text = `<NEED_INPUT>{
      "questions": [
        { "id": "x", "label": "X?", "type": "textarea" }
      ]
    }</NEED_INPUT>`
    expect(parseNeedInputMarker(text)?.questions[0]?.id).toBe('x')
  })

  it('extracts the FIRST marker when multiple appear', () => {
    const text =
      '<NEED_INPUT>{"questions":[{"id":"a","label":"A"}]}</NEED_INPUT>' +
      '<NEED_INPUT>{"questions":[{"id":"b","label":"B"}]}</NEED_INPUT>'
    expect(parseNeedInputMarker(text)?.questions[0]?.id).toBe('a')
  })
})

describe('renderQaBlock', () => {
  it('formats Q + A pairs and ends with the no-more-NEED_INPUT directive', () => {
    const qs = [
      { id: 'sleep', label: '你睡眠怎样', type: 'textarea' as const },
      { id: 'exercise', label: '你运动频率', type: 'textarea' as const },
    ]
    const answers = { sleep: '每天 5 小时', exercise: '基本零' }
    const md = renderQaBlock(qs, answers)
    expect(md).toContain('用户对你刚才提的补充问题给出了答复')
    expect(md).toContain('**Q: 你睡眠怎样**')
    expect(md).toContain('每天 5 小时')
    expect(md).toContain('**Q: 你运动频率**')
    expect(md).toContain('基本零')
    // The directive must be present — it's the only thing preventing
    // a second NEED_INPUT round.
    expect(md).toContain('不要再输出')
    expect(md).toContain('NEED_INPUT')
  })

  it('skips questions that have no answer (user only partially answered)', () => {
    const qs = [
      { id: 'a', label: 'QA', type: 'textarea' as const },
      { id: 'b', label: 'QB', type: 'textarea' as const },
    ]
    const md = renderQaBlock(qs, { a: 'only A answered' })
    expect(md).toContain('QA')
    expect(md).toContain('only A answered')
    expect(md).not.toContain('QB')
  })
})
