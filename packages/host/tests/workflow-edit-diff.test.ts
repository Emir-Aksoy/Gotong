/**
 * WFEDIT-D1 — unit tests for the pure line diff the member editor renders.
 * The contract worth pinning: same/add/del classification, del-before-add
 * ordering at a replacement, no phantom trailing-newline change, and the
 * honest degradation (everything-replaced) past the cell cap instead of an
 * unbounded DP table.
 */

import { describe, expect, it } from 'vitest'

import { computeLineDiff } from '../src/workflow-edit-diff.js'

describe('computeLineDiff', () => {
  it('identical inputs → all same', () => {
    const y = 'a\nb\nc\n'
    expect(computeLineDiff(y, y)).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'same', text: 'b' },
      { kind: 'same', text: 'c' },
    ])
  })

  it('pure insertion keeps surrounding lines as same', () => {
    expect(computeLineDiff('a\nc\n', 'a\nb\nc\n')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'add', text: 'b' },
      { kind: 'same', text: 'c' },
    ])
  })

  it('pure deletion keeps surrounding lines as same', () => {
    expect(computeLineDiff('a\nb\nc\n', 'a\nc\n')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'same', text: 'c' },
    ])
  })

  it('a modified line reads del-then-add at the same position', () => {
    expect(computeLineDiff('a\nold\nc\n', 'a\nnew\nc\n')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' },
      { kind: 'same', text: 'c' },
    ])
  })

  it('empty before → all add; empty after → all del', () => {
    expect(computeLineDiff('', 'a\nb\n')).toEqual([
      { kind: 'add', text: 'a' },
      { kind: 'add', text: 'b' },
    ])
    expect(computeLineDiff('a\nb\n', '')).toEqual([
      { kind: 'del', text: 'a' },
      { kind: 'del', text: 'b' },
    ])
  })

  it('trailing-newline difference is not a phantom change', () => {
    // Same single line, one side with EOF newline — nothing changed.
    expect(computeLineDiff('a\n', 'a')).toEqual([{ kind: 'same', text: 'a' }])
  })

  it('handles CRLF input without spurious changes', () => {
    expect(computeLineDiff('a\r\nb\r\n', 'a\nb\n')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'same', text: 'b' },
    ])
  })

  it('degrades to everything-replaced past the cell cap (no unbounded table)', () => {
    // 600×600 lines = 361,201 cells > the 250k cap. Lines share a prefix so a
    // real LCS WOULD find matches — the degraded path must not.
    const before = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n')
    const after = Array.from({ length: 600 }, (_, i) => `line ${i} edited`).join('\n')
    const out = computeLineDiff(before, after)
    expect(out).toHaveLength(1200)
    expect(out.slice(0, 600).every((l) => l.kind === 'del')).toBe(true)
    expect(out.slice(600).every((l) => l.kind === 'add')).toBe(true)
  })

  it('round-trips: same+add reconstruct after, same+del reconstruct before', () => {
    const before = 'schema: v1\nid: flow\nsteps:\n  - a\n  - b\n'
    const after = 'schema: v1\nid: flow\nname: better\nsteps:\n  - a\n  - c\n'
    const out = computeLineDiff(before, after)
    const rebuiltBefore = out.filter((l) => l.kind !== 'add').map((l) => l.text)
    const rebuiltAfter = out.filter((l) => l.kind !== 'del').map((l) => l.text)
    expect(rebuiltBefore).toEqual(['schema: v1', 'id: flow', 'steps:', '  - a', '  - b'])
    expect(rebuiltAfter).toEqual(['schema: v1', 'id: flow', 'name: better', 'steps:', '  - a', '  - c'])
  })
})
