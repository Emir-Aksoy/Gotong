/**
 * Structure checker — verifies an LLM output contains all required
 * markdown sections (in any order) and optionally that certain
 * sections forbid specific phrases.
 *
 * This is the cheapest possible eval: pure regex / substring scans,
 * runs in microseconds, no LLM, no state. Used in vitest tests to
 * pin down "output X must contain sections A/B/C and must NOT contain
 * banned phrase Y."
 *
 * Use case examples:
 *
 *   - personal-growth body coach output MUST contain:
 *       "## 我的核心判断", "## 我看到的身体基线",
 *       "## 三个最该关注的点", "## 我需要专业医生的边界",
 *       "## 这次输出的置信度与边界"
 *   - It must NOT contain:
 *       "以下是" (banned导语), "您" (forced 「你」 form)
 */

export interface StructureExpectation {
  /**
   * Section headings that MUST appear (matched as substrings on lines
   * starting with `## `). Order is ignored — only presence.
   */
  requiredSections: string[]

  /**
   * Phrases that MUST appear anywhere in the text (plain substring, no
   * heading requirement). For outputs that use numbered/short sections
   * instead of markdown `##` headings — e.g. the morning brief's
   * 「今日重点 / 提醒 / 今日一学」.
   */
  requiredPhrases?: string[]

  /**
   * Phrases anywhere in the text that MUST NOT appear. Useful for
   * guarding against forbidden disclaimers, formality markers, etc.
   */
  forbiddenPhrases?: string[]

  /**
   * Max total byte length of the output. Default undefined skips
   * the check.
   */
  maxBytes?: number
}

export interface StructureViolation {
  kind: 'missing_section' | 'missing_phrase' | 'forbidden_phrase' | 'too_long'
  message: string
}

export interface StructureCheckResult {
  ok: boolean
  violations: StructureViolation[]
}

export function checkStructure(
  text: string,
  expect: StructureExpectation,
): StructureCheckResult {
  const violations: StructureViolation[] = []

  for (const heading of expect.requiredSections) {
    if (!textContainsHeading(text, heading)) {
      violations.push({
        kind: 'missing_section',
        message: `required section "## ...${heading}..." not found`,
      })
    }
  }

  if (expect.requiredPhrases) {
    for (const phrase of expect.requiredPhrases) {
      if (!text.includes(phrase)) {
        violations.push({
          kind: 'missing_phrase',
          message: `required phrase "${phrase}" not found in text`,
        })
      }
    }
  }

  if (expect.forbiddenPhrases) {
    for (const phrase of expect.forbiddenPhrases) {
      if (text.includes(phrase)) {
        violations.push({
          kind: 'forbidden_phrase',
          message: `forbidden phrase "${phrase}" found in text`,
        })
      }
    }
  }

  if (expect.maxBytes !== undefined && text.length > expect.maxBytes) {
    violations.push({
      kind: 'too_long',
      message: `text is ${text.length} bytes — cap is ${expect.maxBytes}`,
    })
  }

  return { ok: violations.length === 0, violations }
}

function textContainsHeading(text: string, headingSubstring: string): boolean {
  const escaped = headingSubstring.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pat = new RegExp(`^##\\s+[^\\n]*${escaped}[^\\n]*$`, 'm')
  return pat.test(text)
}
