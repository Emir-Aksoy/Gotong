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
