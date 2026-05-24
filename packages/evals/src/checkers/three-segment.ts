/**
 * Three-segment output contract checker (P0-1).
 *
 * The contract: every personal-growth agent output should have
 *   1. an **opening judgment** (≤ 50 字 TL;DR) — exact markdown
 *      heading depends on the agent (interviewer uses "我的核心判断",
 *      synthesist uses "一句话发展路径", coaches use "我的核心判断"
 *      too);
 *   2. a **body** with the agent's actual analysis (already enforced
 *      by the prompt structure);
 *   3. a **closing confidence/boundaries** block (≤ 80-120 字) titled
 *      "置信度与边界" or "这次画像的置信度与边界" or similar.
 *
 * This checker takes a flexible "expected opening heading" + "expected
 * closing heading" pair (since the heading wording is slightly
 * different per agent) and verifies:
 *
 *   - opening heading appears in the first 30% of the text (TL;DR
 *     must be UP FRONT, not buried)
 *   - closing heading appears in the last 30% of the text
 *   - both headings appear at most once each (defensive: a duplicate
 *     means the LLM tripped over the contract somehow)
 *   - opening section body fits the byte cap when one is supplied
 *
 * Returns a `ContractCheckResult` with `ok: boolean` and a list of
 * `violations` — empty when ok=true. Callers (typically vitest tests)
 * assert on `ok` and pretty-print the violations on failure.
 */

export interface ThreeSegmentOptions {
  /**
   * Markdown heading text for the opening TL;DR block (without the
   * leading "## "). Example: "我的核心判断(一句话)" or "一句话发展路径".
   * Matched **as substring** — accepts trailing punctuation differences.
   */
  openingHeading: string

  /**
   * Markdown heading text for the closing confidence block (without
   * the leading "## "). Example: "这次输出的置信度与边界" or
   * "这份计划的置信度与边界".
   */
  closingHeading: string

  /**
   * Optional max byte length of the opening section body (between the
   * opening heading and the next "## "). Default `undefined` skips the
   * check.
   */
  maxOpeningBytes?: number

  /**
   * Optional max byte length of the closing section body. Default
   * `undefined` skips the check.
   */
  maxClosingBytes?: number

  /**
   * How far into the document the opening heading is still allowed to
   * appear. Default 0.3 means "within first 30% of the text". Set to
   * 1.0 to disable position checking.
   */
  openingMustAppearWithin?: number

  /**
   * How far before the end the closing heading must appear. Default 0.7
   * means "within last 30%" (i.e. position ≥ 0.7 of text length).
   */
  closingMustAppearAfter?: number
}

export interface Violation {
  kind:
    | 'opening_missing'
    | 'opening_duplicated'
    | 'opening_too_late'
    | 'opening_too_long'
    | 'closing_missing'
    | 'closing_duplicated'
    | 'closing_too_early'
    | 'closing_too_long'
  message: string
}

export interface ContractCheckResult {
  ok: boolean
  violations: Violation[]
}

/**
 * Check that `text` honors the three-segment contract.
 *
 * Pure function: no IO, no side effects, fully deterministic. Returns
 * a structured result instead of throwing — callers compose multiple
 * checkers and want to aggregate failures.
 */
export function checkThreeSegmentContract(
  text: string,
  opts: ThreeSegmentOptions,
): ContractCheckResult {
  const violations: Violation[] = []
  const totalLen = text.length
  if (totalLen === 0) {
    return {
      ok: false,
      violations: [
        { kind: 'opening_missing', message: 'text is empty' },
        { kind: 'closing_missing', message: 'text is empty' },
      ],
    }
  }

  const openingPattern = headingPattern(opts.openingHeading)
  const closingPattern = headingPattern(opts.closingHeading)

  const openingHits = findAll(text, openingPattern)
  const closingHits = findAll(text, closingPattern)

  // --- opening checks ---
  if (openingHits.length === 0) {
    violations.push({
      kind: 'opening_missing',
      message: `expected opening heading containing "${opts.openingHeading}" — not found`,
    })
  } else {
    if (openingHits.length > 1) {
      violations.push({
        kind: 'opening_duplicated',
        message: `opening heading "${opts.openingHeading}" appears ${openingHits.length} times — should appear once`,
      })
    }
    const openingPos = openingHits[0]! / totalLen
    const maxOpeningPos = opts.openingMustAppearWithin ?? 0.3
    if (openingPos > maxOpeningPos) {
      violations.push({
        kind: 'opening_too_late',
        message: `opening heading appears at ${(openingPos * 100).toFixed(0)}% of text — must appear within first ${(maxOpeningPos * 100).toFixed(0)}%`,
      })
    }
    if (opts.maxOpeningBytes !== undefined) {
      const openingBody = extractSectionBody(text, openingHits[0]!)
      if (openingBody.length > opts.maxOpeningBytes) {
        violations.push({
          kind: 'opening_too_long',
          message: `opening section body is ${openingBody.length} bytes — cap is ${opts.maxOpeningBytes}`,
        })
      }
    }
  }

  // --- closing checks ---
  if (closingHits.length === 0) {
    violations.push({
      kind: 'closing_missing',
      message: `expected closing heading containing "${opts.closingHeading}" — not found`,
    })
  } else {
    if (closingHits.length > 1) {
      violations.push({
        kind: 'closing_duplicated',
        message: `closing heading "${opts.closingHeading}" appears ${closingHits.length} times — should appear once`,
      })
    }
    const closingPos = closingHits[0]! / totalLen
    const minClosingPos = opts.closingMustAppearAfter ?? 0.7
    if (closingPos < minClosingPos) {
      violations.push({
        kind: 'closing_too_early',
        message: `closing heading appears at ${(closingPos * 100).toFixed(0)}% of text — must appear after ${(minClosingPos * 100).toFixed(0)}%`,
      })
    }
    if (opts.maxClosingBytes !== undefined) {
      const closingBody = extractSectionBody(text, closingHits[0]!)
      if (closingBody.length > opts.maxClosingBytes) {
        violations.push({
          kind: 'closing_too_long',
          message: `closing section body is ${closingBody.length} bytes — cap is ${opts.maxClosingBytes}`,
        })
      }
    }
  }

  return { ok: violations.length === 0, violations }
}

// ───────────────────────────────────────────────────────────────────
// internal helpers
// ───────────────────────────────────────────────────────────────────

/**
 * Build a regex that matches `## <heading>` at the start of a line.
 * The heading text is matched as a literal substring on the same
 * line — so "我的核心判断" matches "## 我的核心判断(一句话)" too.
 */
function headingPattern(headingText: string): RegExp {
  const escaped = headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^##\\s+[^\\n]*${escaped}[^\\n]*$`, 'gm')
}

/** Find all match positions for `pattern` in `text`. */
function findAll(text: string, pattern: RegExp): number[] {
  const positions: number[] = []
  let m: RegExpExecArray | null
  pattern.lastIndex = 0
  while ((m = pattern.exec(text)) !== null) {
    positions.push(m.index)
    // Guard against zero-width matches looping forever.
    if (m.index === pattern.lastIndex) pattern.lastIndex++
  }
  return positions
}

/**
 * Extract the body between a heading at `startIdx` and the next "## "
 * line (or end of text). Returns the body content (trimmed) without
 * the heading line itself.
 */
function extractSectionBody(text: string, startIdx: number): string {
  // Skip past the heading line.
  const newlineAfterHeading = text.indexOf('\n', startIdx)
  if (newlineAfterHeading === -1) return ''
  const bodyStart = newlineAfterHeading + 1
  // Find next "## " at start of line.
  const nextHeadingPattern = /^##\s/gm
  nextHeadingPattern.lastIndex = bodyStart
  const m = nextHeadingPattern.exec(text)
  const bodyEnd = m ? m.index : text.length
  return text.slice(bodyStart, bodyEnd).trim()
}
