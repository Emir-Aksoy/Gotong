import { describe, expect, it } from 'vitest'
import {
  ORG_SELF_ID,
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

  // ========================================================================
  // A3 (v4 Phase 5) — identity-rooted kinds aligned with @aipehub/identity.
  // user / org / peer values must mirror identity's vault `OwnerKind` so a
  // single (kind, id) tuple round-trips between vault rows and service
  // attach calls.
  // ========================================================================

  it("user:<id> → ('user', userId) — explicit suffix", () => {
    expect(resolveOwner('user:alice', { userId: 'alice' })).toEqual({
      kind: 'user',
      id: 'alice',
    })
  })

  it('user scope honors an explicit userId override (typo correction)', () => {
    expect(resolveOwner('user:typo', { userId: 'alice-id' })).toEqual({
      kind: 'user',
      id: 'alice-id',
    })
  })

  it("user:<empty> throws", () => {
    // Cast bypasses literal-type check; runtime guard catches the empty id.
    expect(() => resolveOwner('user:' as 'user:x', {})).toThrow(/non-empty/)
  })

  it("org → ('org', ORG_SELF_ID) — no context required", () => {
    expect(resolveOwner('org', {})).toEqual({ kind: 'org', id: ORG_SELF_ID })
    expect(ORG_SELF_ID).toBe('self')
  })

  it("peer:<id> → ('peer', peerId)", () => {
    expect(resolveOwner('peer:widgets-hub', { peerId: 'widgets-hub' })).toEqual({
      kind: 'peer',
      id: 'widgets-hub',
    })
  })

  it('peer scope honors an explicit peerId override', () => {
    expect(resolveOwner('peer:typo', { peerId: 'real-peer' })).toEqual({
      kind: 'peer',
      id: 'real-peer',
    })
  })

  it("peer:<empty> throws", () => {
    expect(() => resolveOwner('peer:' as 'peer:x', {})).toThrow(/non-empty/)
  })

  it('A3 path-traversal hardening: every new kind rejects unsafe ids', () => {
    // Same defense-in-depth applies to the new kinds — a yaml typo or
    // a hostile peer-registry entry must not slip a `../` past us.
    expect(() => resolveOwner('user:../escape', {})).toThrow(/path separators/)
    expect(() => resolveOwner('peer:..', {})).toThrow(/relative-path segment/)
    // 'org' takes no input id (constant 'self'); just pin that it's safe.
    expect(() => assertSafeOwnerId(ORG_SELF_ID)).not.toThrow()
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

  // A3 — new kinds round-trip through (parse|owner)Key just like the old ones.
  it('round-trips user owner', () => {
    const o = { kind: 'user', id: 'alice-id' } as const
    expect(parseOwnerKey(ownerKey(o))).toEqual(o)
  })

  it('round-trips org owner with ORG_SELF_ID', () => {
    const o = { kind: 'org', id: ORG_SELF_ID } as const
    expect(parseOwnerKey(ownerKey(o))).toEqual(o)
    expect(ownerKey(o)).toBe('org/self')
  })

  it('round-trips peer owner', () => {
    const o = { kind: 'peer', id: 'widgets-hub' } as const
    expect(parseOwnerKey(ownerKey(o))).toEqual(o)
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
