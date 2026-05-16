import { describe, expect, it } from 'vitest'
import {
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
