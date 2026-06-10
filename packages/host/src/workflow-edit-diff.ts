/**
 * WFEDIT-D1 — line diff between the pre-edit and post-edit workflow YAML, so
 * the member editor can SHOW exactly what the AI changed (the OpenClaw-style
 * "here's the change" affordance) instead of asking the member to eyeball two
 * YAML blobs.
 *
 * WHY this lives in host and not the browser: the edit service is the only
 * place that holds both the pre-edit YAML and the persisted result of the SAME
 * pipeline run, and a pure function here gets real vitest coverage — the member
 * SPA is hand-written static JS with no unit harness, so it should stay a dumb
 * renderer of `diff` rows.
 *
 * Plain LCS over LINES. Workflow YAML is tens of lines, so the O(n·m) table is
 * nothing; a defensive cell cap degrades to "everything replaced" honestly
 * instead of burning CPU on an adversarial megabyte input.
 */

export interface WorkflowEditDiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
}

/**
 * Above this n·m the DP table isn't worth building. 250k cells ≈ two 500-line
 * files — far beyond any real workflow YAML, cheap enough to never false-trip.
 */
const LCS_CELL_CAP = 250_000

/**
 * Line diff `before → after`. Deletions are emitted before insertions at the
 * same position (the conventional "old then new" reading order).
 */
export function computeLineDiff(before: string, after: string): WorkflowEditDiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)

  if ((a.length + 1) * (b.length + 1) > LCS_CELL_CAP) {
    return [
      ...a.map((text): WorkflowEditDiffLine => ({ kind: 'del', text })),
      ...b.map((text): WorkflowEditDiffLine => ({ kind: 'add', text })),
    ]
  }

  // LCS lengths: table[i][j] = LCS of a[i..] and b[j..], flattened row-major.
  const w = b.length + 1
  const table = new Uint32Array((a.length + 1) * w)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] =
        a[i] === b[j]
          ? table[(i + 1) * w + (j + 1)]! + 1
          : Math.max(table[(i + 1) * w + j]!, table[i * w + (j + 1)]!)
    }
  }

  const out: WorkflowEditDiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (table[(i + 1) * w + j]! >= table[i * w + (j + 1)]!) {
      out.push({ kind: 'del', text: a[i]! })
      i++
    } else {
      out.push({ kind: 'add', text: b[j]! })
      j++
    }
  }
  for (; i < a.length; i++) out.push({ kind: 'del', text: a[i]! })
  for (; j < b.length; j++) out.push({ kind: 'add', text: b[j]! })
  return out
}

/**
 * Split into lines without a phantom trailing entry: `'a\n'` is ONE line, not
 * `['a','']` — otherwise every diff against an EOF-newline file shows a fake
 * empty-line change.
 */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
