/**
 * FDE-M2 — pins `checkStructure`, now that template acceptance cases judge
 * with it (previously only exercised indirectly by prompt-lint tests). The new
 * `requiredPhrases` vocabulary exists for outputs that use numbered/short
 * sections instead of markdown `##` headings (e.g. the morning brief).
 */

import { describe, expect, it } from 'vitest'

import { checkStructure } from '../src/checkers/structure.js'

describe('checkStructure', () => {
  it('passes when required sections, phrases and no forbidden phrases line up', () => {
    const text = '## 我的核心判断\n内容\n\n1. 今日重点 —— 喝水\n结尾'
    const r = checkStructure(text, {
      requiredSections: ['核心判断'],
      requiredPhrases: ['今日重点'],
      forbiddenPhrases: ['作为一个AI'],
    })
    expect(r.ok).toBe(true)
    expect(r.violations).toEqual([])
  })

  it('flags a missing required phrase (plain substring, not a heading)', () => {
    const r = checkStructure('1. 提醒 —— 内容', {
      requiredSections: [],
      requiredPhrases: ['今日重点', '提醒'],
    })
    expect(r.ok).toBe(false)
    expect(r.violations).toEqual([
      { kind: 'missing_phrase', message: 'required phrase "今日重点" not found in text' },
    ])
  })

  it('a phrase inside a non-heading line does NOT satisfy requiredSections', () => {
    const r = checkStructure('1. 今日重点 —— 喝水', { requiredSections: ['今日重点'] })
    expect(r.ok).toBe(false)
    expect(r.violations[0]?.kind).toBe('missing_section')
  })

  it('flags forbidden phrases and over-length together', () => {
    const r = checkStructure('作为一个AI我无法确认', {
      requiredSections: [],
      forbiddenPhrases: ['作为一个AI'],
      maxBytes: 3,
    })
    expect(r.ok).toBe(false)
    expect(r.violations.map((v) => v.kind).sort()).toEqual(['forbidden_phrase', 'too_long'])
  })
})
