/**
 * Unit tests for `checkThreeSegmentContract` (P0-1 enforcement layer).
 *
 * The checker is a pure function — every test is "build a synthetic
 * text, run the checker, assert on result.ok and violations". No
 * fixtures, no fs, no LLM.
 */

import { describe, expect, it } from 'vitest'

import {
  checkThreeSegmentContract,
  type Violation,
} from '../src/checkers/three-segment.js'

function kinds(vs: Violation[]): string[] {
  return vs.map((v) => v.kind)
}

describe('checkThreeSegmentContract — happy path', () => {
  it('passes when opening and closing both present, in correct positions', () => {
    const text = [
      '## 我的核心判断',
      '一句话判断',
      '',
      '## 中间分析',
      '... body content goes here, this is the meat of the analysis ...',
      'more body, even more body, padding to make this a realistic length',
      '',
      '## 置信度与边界',
      '老实说我哪里不确定',
    ].join('\n')

    const r = checkThreeSegmentContract(text, {
      openingHeading: '我的核心判断',
      closingHeading: '置信度与边界',
    })
    expect(r.ok).toBe(true)
    expect(r.violations).toEqual([])
  })
})

describe('checkThreeSegmentContract — missing headings', () => {
  it('flags missing opening', () => {
    const text = '## 分析\nbody\n## 置信度与边界\nclosing'
    const r = checkThreeSegmentContract(text, {
      openingHeading: '我的核心判断',
      closingHeading: '置信度与边界',
    })
    expect(r.ok).toBe(false)
    expect(kinds(r.violations)).toContain('opening_missing')
  })

  it('flags missing closing', () => {
    const text = '## 我的核心判断\ntop\n## 分析\nbody'
    const r = checkThreeSegmentContract(text, {
      openingHeading: '我的核心判断',
      closingHeading: '置信度与边界',
    })
    expect(r.ok).toBe(false)
    expect(kinds(r.violations)).toContain('closing_missing')
  })

  it('flags both missing on empty text', () => {
    const r = checkThreeSegmentContract('', {
      openingHeading: '我的核心判断',
      closingHeading: '置信度与边界',
    })
    expect(r.ok).toBe(false)
    expect(kinds(r.violations).sort()).toEqual(['closing_missing', 'opening_missing'])
  })
})

describe('checkThreeSegmentContract — position checks', () => {
  it('flags opening that appears too late', () => {
    const body = 'x'.repeat(500)
    const text = `${body}\n## 我的核心判断\nthis is too late\n## 置信度与边界\nclosing`
    const r = checkThreeSegmentContract(text, {
      openingHeading: '我的核心判断',
      closingHeading: '置信度与边界',
      // closing appears at the end so it's fine; just check opening.
      closingMustAppearAfter: 0.0,
    })
    expect(r.ok).toBe(false)
    expect(kinds(r.violations)).toContain('opening_too_late')
  })

  it('flags closing that appears too early', () => {
    const text =
      '## 我的核心判断\nopen\n## 置信度与边界\ntoo early\n' +
      'x'.repeat(2000)
    const r = checkThreeSegmentContract(text, {
      openingHeading: '我的核心判断',
      closingHeading: '置信度与边界',
    })
    expect(r.ok).toBe(false)
    expect(kinds(r.violations)).toContain('closing_too_early')
  })
})

describe('checkThreeSegmentContract — duplication checks', () => {
  it('flags opening that appears twice', () => {
    const text =
      '## 我的核心判断\nfirst\n## something\n... body ...\n' +
      '## 我的核心判断\nrepeated by LLM mistake\n## 置信度与边界\nend'
    const r = checkThreeSegmentContract(text, {
      openingHeading: '我的核心判断',
      closingHeading: '置信度与边界',
    })
    expect(kinds(r.violations)).toContain('opening_duplicated')
  })

  it('flags closing that appears twice', () => {
    // Use long enough body so positions are realistic
    const body = 'lorem ipsum '.repeat(50)
    const text =
      `## 我的核心判断\nopen\n${body}\n` +
      '## 置信度与边界\nfirst end\n' +
      '## something else\nmore\n' +
      '## 置信度与边界\nrepeat'
    const r = checkThreeSegmentContract(text, {
      openingHeading: '我的核心判断',
      closingHeading: '置信度与边界',
    })
    expect(kinds(r.violations)).toContain('closing_duplicated')
  })
})

describe('checkThreeSegmentContract — byte-cap checks', () => {
  it('flags opening section body that exceeds the cap', () => {
    const longOpening = 'x'.repeat(500)
    const text = `## 我的核心判断\n${longOpening}\n## 中间\nbody\n## 置信度与边界\nend`
    const r = checkThreeSegmentContract(text, {
      openingHeading: '我的核心判断',
      closingHeading: '置信度与边界',
      maxOpeningBytes: 100,
    })
    expect(r.ok).toBe(false)
    expect(kinds(r.violations)).toContain('opening_too_long')
  })

  it('flags closing section body that exceeds the cap', () => {
    const longClosing = 'x'.repeat(500)
    const text = `## 我的核心判断\nshort\n## body\nmid\n## 置信度与边界\n${longClosing}`
    const r = checkThreeSegmentContract(text, {
      openingHeading: '我的核心判断',
      closingHeading: '置信度与边界',
      maxClosingBytes: 200,
    })
    expect(r.ok).toBe(false)
    expect(kinds(r.violations)).toContain('closing_too_long')
  })

  it('skips byte cap check when not specified', () => {
    const longOpening = 'x'.repeat(5000)
    const text = `## 我的核心判断\n${longOpening}\n## body\nmid\n## 置信度与边界\nend`
    const r = checkThreeSegmentContract(text, {
      openingHeading: '我的核心判断',
      closingHeading: '置信度与边界',
      // no byte caps
    })
    // Opening is at position 0 → not "too late" — only too long if cap set.
    expect(r.ok).toBe(true)
  })
})

describe('checkThreeSegmentContract — substring heading match', () => {
  it('matches heading text as substring (tolerates suffixes)', () => {
    // Body has enough volume that closing genuinely lands in the last
    // 30% — otherwise the position check rightly rejects.
    const body = '中段分析内容,大段证据,'.repeat(20)
    const text = [
      '## 我的核心判断(一句话)',
      'tl;dr',
      '## body',
      body,
      '## 这次输出的置信度与边界',
      'closer',
    ].join('\n')
    const r = checkThreeSegmentContract(text, {
      openingHeading: '我的核心判断',
      closingHeading: '置信度与边界',
    })
    expect(r.ok).toBe(true)
  })
})
