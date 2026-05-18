import { describe, expect, it } from 'vitest'
import {
  assertSafeOwnerId,
  ownerKey,
  ownersEqual,
  parseOwnerKey,
  resolveOwner,
} from '../src/owner.js'

describe('resolveOwner', () => {
  it("private → ('agent', agentId)", () => {
    expect(resolveOwner('private', { agentId: 'writer-zh' })).toEqual({
      kind: 'agent',
      id: 'writer-zh',
    })
  })

  it("workflow → ('workflow-run', runId)", () => {
    expect(resolveOwner('workflow', { runId: 'r-123' })).toEqual({
      kind: 'workflow-run',
      id: 'r-123',
    })
  })

  it('shared:<group> → (shared, group)', () => {
    expect(resolveOwner('shared:industry-coaches', { agentId: 'a1' })).toEqual({
      kind: 'shared',
      id: 'industry-coaches',
    })
  })

  it('shared scope honors an explicit groupId override', () => {
    expect(resolveOwner('shared:typo', { groupId: 'corrected' })).toEqual({
      kind: 'shared',
      id: 'corrected',
    })
  })

  it("private without agentId throws", () => {
    expect(() => resolveOwner('private', {})).toThrow(/agentId/)
  })

  it('workflow without runId throws', () => {
    expect(() => resolveOwner('workflow', { agentId: 'a1' })).toThrow(/runId/)
  })

  it('shared:<empty> throws', () => {
    // The cast bypasses the literal-type check; we want the runtime
    // guard to catch the empty group at the source.
    expect(() => resolveOwner('shared:' as 'shared:x', {})).toThrow(/non-empty/)
  })

  it('unknown scope throws', () => {
    // @ts-expect-error: deliberate bad input
    expect(() => resolveOwner('public', {})).toThrow(/unknown scope/)
  })
})

describe('ownerKey / parseOwnerKey', () => {
  it('round-trips agent owner', () => {
    const o = { kind: 'agent', id: 'writer-zh' } as const
    expect(parseOwnerKey(ownerKey(o))).toEqual(o)
  })

  it('round-trips workflow-run owner', () => {
    const o = { kind: 'workflow-run', id: 'r-1' } as const
    expect(parseOwnerKey(ownerKey(o))).toEqual(o)
  })

  it('preserves ids that themselves contain slashes', () => {
    // The kind is the prefix before the FIRST slash; everything else
    // is the id. Lets agent ids like `org/team-1` pass through.
    const o = { kind: 'agent', id: 'org/team-1' } as const
    expect(parseOwnerKey(ownerKey(o))).toEqual(o)
  })

  it('rejects malformed key (no slash)', () => {
    expect(() => parseOwnerKey('agentname')).toThrow(/malformed/)
  })

  it('rejects unknown kind', () => {
    expect(() => parseOwnerKey('robot/r2d2')).toThrow(/unknown owner kind/)
  })

  it('rejects empty id', () => {
    expect(() => parseOwnerKey('agent/')).toThrow(/empty id/)
  })
})

describe('ownersEqual', () => {
  it('true on identical', () => {
    expect(
      ownersEqual({ kind: 'agent', id: 'a' }, { kind: 'agent', id: 'a' }),
    ).toBe(true)
  })

  it('false on different kind', () => {
    expect(
      ownersEqual({ kind: 'agent', id: 'a' }, { kind: 'shared', id: 'a' }),
    ).toBe(false)
  })

  it('false on different id', () => {
    expect(
      ownersEqual({ kind: 'agent', id: 'a' }, { kind: 'agent', id: 'b' }),
    ).toBe(false)
  })
})

// =========================================================================
// S7: assertSafeOwnerId — blocks Owner.id values that would escape the
// per-tenant directory tree when joined into a filesystem path.
// =========================================================================
describe('assertSafeOwnerId (S7 path-traversal hardening)', () => {
  it('accepts normal alphanumeric ids', () => {
    expect(() => assertSafeOwnerId('writer-zh')).not.toThrow()
    expect(() => assertSafeOwnerId('industry-coaches')).not.toThrow()
    expect(() => assertSafeOwnerId('550e8400-e29b-41d4-a716-446655440000')).not.toThrow()
    expect(() => assertSafeOwnerId('a_b.c-d')).not.toThrow()
  })

  it('accepts unicode (Chinese) ids', () => {
    // Chinese filenames work on POSIX + macOS APFS; we don't want to
    // exclude legitimate i18n agent ids.
    expect(() => assertSafeOwnerId('写手')).not.toThrow()
    expect(() => assertSafeOwnerId('writer-写手-01')).not.toThrow()
  })

  it('rejects empty string', () => {
    expect(() => assertSafeOwnerId('')).toThrow(/non-empty/)
  })

  it('rejects null byte', () => {
    expect(() => assertSafeOwnerId('normal\0escape')).toThrow(/null byte/)
  })

  it('rejects forward slash', () => {
    expect(() => assertSafeOwnerId('org/team-1')).toThrow(/path separators/)
    expect(() => assertSafeOwnerId('../shared/group-x')).toThrow(/path separators/)
  })

  it('rejects backslash', () => {
    expect(() => assertSafeOwnerId('org\\team-1')).toThrow(/path separators/)
  })

  it('rejects bare relative-path segments', () => {
    expect(() => assertSafeOwnerId('.')).toThrow(/relative-path segment/)
    expect(() => assertSafeOwnerId('..')).toThrow(/relative-path segment/)
  })

  it('resolveOwner runs assertSafeOwnerId for every Owner.id-bearing path', () => {
    // SDK-level guard so callers can't sneak a bad id through scope
    // translation either. Each scope kind covered.
    expect(() => resolveOwner('private', { agentId: '../escape' })).toThrow(/path separators/)
    expect(() => resolveOwner('workflow', { runId: '..' })).toThrow(/relative-path segment/)
    expect(() => resolveOwner('shared:..', {})).toThrow(/relative-path segment/)
  })

  it('rejects non-string id at type boundary', () => {
    // The runtime guard covers JS callers who didn't get the benefit
    // of the TS type.
    expect(() => assertSafeOwnerId(undefined as unknown as string)).toThrow(/non-empty string/)
    expect(() => assertSafeOwnerId(123 as unknown as string)).toThrow(/non-empty string/)
  })
})
