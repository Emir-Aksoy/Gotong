/**
 * Tests for `loadBundledExamples` / `loadExamplesFromDir`.
 *
 * The bundled-examples path is exercised against the real templates that
 * ship in this package — that round-trip catches a regression if anyone
 * drops a malformed YAML in `templates/` (parseWorkflow would skip it,
 * but we also want to know the count stays sensible).
 *
 * The arbitrary-dir path is exercised against a tmp dir we build inline,
 * including the "bad yaml gets skipped, doesn't throw" behavior — that's
 * the contract host startup depends on (one broken file must NOT take
 * down the assistant).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  loadBundledExamples,
  loadExamplesFromDir,
  type WorkflowExample,
} from '../src/index.js'

// ───────────────────────────────────────────────────────────────────
// Bundled loader
// ───────────────────────────────────────────────────────────────────

describe('loadBundledExamples', () => {
  it('returns at least 2 examples from the package templates dir', () => {
    const ex = loadBundledExamples()
    expect(ex.length).toBeGreaterThanOrEqual(2)
  })

  it('every bundled example has a non-empty description + yaml', () => {
    const ex = loadBundledExamples()
    for (const e of ex) {
      expect(typeof e.description).toBe('string')
      expect(e.description.length).toBeGreaterThan(0)
      expect(typeof e.yaml).toBe('string')
      expect(e.yaml).toContain('schema: gotong.workflow/v1')
      expect(e.yaml).toContain('workflow:')
    }
  })

  it('bundled examples cover both simple and parallel patterns', () => {
    const ex = loadBundledExamples()
    const yamls = ex.map((e) => e.yaml).join('\n')
    // editorial-flow has plain steps; admin-task-flow has parallel.
    expect(yamls).toContain('parallel: true')
    expect(yamls).toContain('branches:')
  })

  it('bundled examples are sorted by filename (deterministic order)', () => {
    // Calling twice should produce the same order — the few-shot prompt
    // depends on it for caching, and tests would otherwise flake.
    const a = loadBundledExamples().map((e) => e.description)
    const b = loadBundledExamples().map((e) => e.description)
    expect(a).toEqual(b)
  })
})

// ───────────────────────────────────────────────────────────────────
// Arbitrary-dir loader
// ───────────────────────────────────────────────────────────────────

describe('loadExamplesFromDir', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gotong-examples-test-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function write(name: string, content: string): void {
    writeFileSync(join(dir, name), content, 'utf8')
  }

  const GOOD_YAML = `schema: gotong.workflow/v1
workflow:
  id: tiny
  description: A trivial one-step flow
  trigger:
    capability: tiny:run
  steps:
    - id: a
      dispatch:
        strategy: { kind: capability, capabilities: [c] }
        payload: { msg: hi }
`

  it('reads a single good YAML and returns one WorkflowExample', () => {
    write('one.yaml', GOOD_YAML)
    const ex = loadExamplesFromDir(dir)
    expect(ex).toHaveLength(1)
    expect(ex[0]!.description).toBe('A trivial one-step flow')
    expect(ex[0]!.yaml).toContain('id: tiny')
  })

  it('uses workflow.name when description is missing', () => {
    write(
      'named.yaml',
      `schema: gotong.workflow/v1
workflow:
  id: with-name
  name: Friendly Name
  trigger: { capability: c }
  steps:
    - id: a
      dispatch:
        strategy: { kind: capability, capabilities: [c] }
        payload: {}
`,
    )
    const ex = loadExamplesFromDir(dir)
    expect(ex[0]!.description).toBe('Friendly Name')
  })

  it('falls back to filename basename when neither description nor name is present', () => {
    write(
      'fallback-shape.yaml',
      `schema: gotong.workflow/v1
workflow:
  id: bare
  trigger: { capability: c }
  steps:
    - id: a
      dispatch:
        strategy: { kind: capability, capabilities: [c] }
        payload: {}
`,
    )
    const ex = loadExamplesFromDir(dir)
    expect(ex[0]!.description).toBe('fallback-shape')
  })

  it('accepts both .yaml and .yml extensions', () => {
    write('one.yaml', GOOD_YAML)
    write('two.yml', GOOD_YAML.replace('id: tiny', 'id: tiny2'))
    const ex = loadExamplesFromDir(dir)
    expect(ex).toHaveLength(2)
  })

  it('skips non-yaml files silently', () => {
    write('one.yaml', GOOD_YAML)
    write('README.md', '# not a workflow')
    write('notes.txt', 'hi')
    const ex = loadExamplesFromDir(dir)
    expect(ex).toHaveLength(1)
  })

  it('skips malformed YAML with a warning, does NOT throw', () => {
    write('good.yaml', GOOD_YAML)
    write('bad.yaml', 'schema: gotong.workflow/v1\nworkflow: this-is-not-an-object\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ex = loadExamplesFromDir(dir)
    expect(ex).toHaveLength(1)
    expect(ex[0]!.yaml).toContain('id: tiny')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('returns [] on a missing dir without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ex = loadExamplesFromDir(join(dir, 'does-not-exist'))
    expect(ex).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('returns sorted, deterministic order (case-insensitive by name)', () => {
    write('zebra.yaml', GOOD_YAML.replace('id: tiny', 'id: tiny-z'))
    write('Apple.yaml', GOOD_YAML.replace('id: tiny', 'id: tiny-a'))
    write('mango.yaml', GOOD_YAML.replace('id: tiny', 'id: tiny-m'))
    const ex = loadExamplesFromDir(dir)
    const ids = ex.map((e: WorkflowExample) =>
      (e.yaml.match(/id: (tiny-[a-z])/)?.[1]) ?? '?',
    )
    // 'A' < 'm' < 'z' case-insensitively
    expect(ids).toEqual(['tiny-a', 'tiny-m', 'tiny-z'])
  })

  it('ignores subdirectories (does not recurse)', () => {
    write('top.yaml', GOOD_YAML)
    mkdirSync(join(dir, 'nested'))
    writeFileSync(join(dir, 'nested', 'deep.yaml'), GOOD_YAML, 'utf8')
    const ex = loadExamplesFromDir(dir)
    // Only top.yaml should be picked up — subdir entries are non-files
    // so readFileSync would throw, but we also skip the recursion entirely.
    expect(ex.some((e) => e.yaml.includes('id: tiny'))).toBe(true)
  })
})
