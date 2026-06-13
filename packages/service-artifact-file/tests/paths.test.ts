import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { resolveOwnerPath, sanitisePath } from '../src/paths.js'

const owner = { kind: 'agent', id: 'a1' } as const

describe('sanitisePath', () => {
  it.each([
    'reports/q1.md',
    'a/b/c/d.json',
    'top.md',
    'a-dir/notes',
  ])('accepts %s', (p) => {
    expect(sanitisePath(p)).toBeTypeOf('string')
  })

  it.each([
    ['', /non-empty/],
    ['   ', /non-empty/],
    ['/abs', /relative/],
    ['..', /traversal/],
    ['../escape', /traversal/],
    ['a/../../escape', /traversal/],
    ['null\0byte', /null byte/],
  ] as const)('rejects %s', (p, pattern) => {
    expect(() => sanitisePath(p)).toThrow(pattern)
  })

  it('rejects non-string input', () => {
    // @ts-expect-error: deliberate
    expect(() => sanitisePath(42)).toThrow(/must be a string/)
  })

  // Cross-platform regression: artifactIds are wire identifiers with `/`
  // separators (round-trip through URLs + the `uploads/<date>/<rand>`
  // regex). On Windows `node:path.normalize()` emits `\`, so before the
  // fix `write()` returned `uploads\2026-..\x.txt` and broke callers.
  // sanitisePath must always return the POSIX-separator form. Passing a
  // backslash path here proves the conversion happens on every platform
  // (on POSIX `\` is a regular char so normalize leaves it; the replace
  // still POSIX-ifies it — matching what `handle.list()` does).
  it('returns forward-slash separators regardless of input', () => {
    expect(sanitisePath('a\\b\\c.txt')).toBe('a/b/c.txt')
    expect(sanitisePath('uploads\\2026-06-12\\deadbeef.txt')).toBe(
      'uploads/2026-06-12/deadbeef.txt',
    )
    expect(sanitisePath('reports/q1.md')).toBe('reports/q1.md')
  })
})

describe('resolveOwnerPath', () => {
  const rootDir = resolve('/tmp/aipe-art-paths-test')

  it('stays inside the owner directory', () => {
    const full = resolveOwnerPath(rootDir, owner, 'reports/q1.md')
    expect(full).toBe(resolve(join(rootDir, 'agent', 'a1', 'reports', 'q1.md')))
  })

  it('blocks .. escape', () => {
    expect(() => resolveOwnerPath(rootDir, owner, '../escape')).toThrow(/traversal/)
  })

  it('blocks deeper .. escape', () => {
    expect(() => resolveOwnerPath(rootDir, owner, 'a/../../escape')).toThrow(/traversal/)
  })

  it('preserves nested userPaths', () => {
    const full = resolveOwnerPath(rootDir, owner, 'deep/nested/path.md')
    expect(full.startsWith(resolve(join(rootDir, 'agent', 'a1')))).toBe(true)
    expect(full.endsWith('path.md')).toBe(true)
  })
})
