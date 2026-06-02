/**
 * v5 Stream 0-M1 — unified Principal vocabulary.
 *
 * Pure-function module: key codec round-trips, fail-visible parsing, and the
 * vault-owner bridge that IS the org→hub convergence. No DB needed.
 */

import { describe, expect, it } from 'vitest'

import {
  PRINCIPAL_KINDS,
  HUB_SELF_ID,
  HUB_PRINCIPAL,
  isPrincipalKind,
  userPrincipal,
  agentPrincipal,
  peerPrincipal,
  hubPrincipal,
  principalKey,
  parsePrincipalKey,
  principalFromVaultOwner,
  principalToVaultOwner,
  type Principal,
} from '../src/principal.js'

describe('PrincipalKind', () => {
  it('enumerates exactly the four v5 kinds', () => {
    expect([...PRINCIPAL_KINDS]).toEqual(['hub', 'user', 'agent', 'peer'])
  })

  it('isPrincipalKind guards known vs unknown strings', () => {
    expect(isPrincipalKind('agent')).toBe(true)
    expect(isPrincipalKind('hub')).toBe(true)
    expect(isPrincipalKind('org')).toBe(false) // 'org' is the OLD vault kind, not a principal
    expect(isPrincipalKind('')).toBe(false)
  })
})

describe('convenience constructors', () => {
  it('build the expected principals', () => {
    expect(userPrincipal('u1')).toEqual({ kind: 'user', id: 'u1' })
    expect(agentPrincipal('writer')).toEqual({ kind: 'agent', id: 'writer' })
    expect(peerPrincipal('hub-b')).toEqual({ kind: 'peer', id: 'hub-b' })
    expect(hubPrincipal('hub-a')).toEqual({ kind: 'hub', id: 'hub-a' })
  })

  it('hubPrincipal defaults to the self sentinel', () => {
    expect(hubPrincipal()).toEqual({ kind: 'hub', id: HUB_SELF_ID })
    expect(HUB_PRINCIPAL).toEqual({ kind: 'hub', id: HUB_SELF_ID })
  })
})

describe('principalKey / parsePrincipalKey', () => {
  it('round-trips every kind', () => {
    const cases: Principal[] = [
      { kind: 'hub', id: 'self' },
      { kind: 'user', id: 'u-123' },
      { kind: 'agent', id: 'inbox-monitor' },
      { kind: 'peer', id: 'acme-hub' },
    ]
    for (const p of cases) {
      expect(parsePrincipalKey(principalKey(p))).toEqual(p)
    }
  })

  it('keeps colons in the id (only the first colon splits)', () => {
    const p = peerPrincipal('hub:with:colons')
    expect(principalKey(p)).toBe('peer:hub:with:colons')
    expect(parsePrincipalKey('peer:hub:with:colons')).toEqual(p)
  })

  it('throws on a malformed key (fail-visible, never grant nobody)', () => {
    expect(() => parsePrincipalKey('nocolon')).toThrow(/malformed/)
    expect(() => parsePrincipalKey(':noid')).toThrow(/malformed/)
    expect(() => parsePrincipalKey('user:')).toThrow(/malformed/)
  })

  it('throws on an unknown kind', () => {
    expect(() => parsePrincipalKey('org:self')).toThrow(/unknown principal kind/)
    expect(() => parsePrincipalKey('robot:x')).toThrow(/unknown principal kind/)
  })
})

describe('vault-owner bridge (the org→hub convergence)', () => {
  it('maps vault org → hub principal (NULL id → self)', () => {
    expect(principalFromVaultOwner('org', null)).toEqual({ kind: 'hub', id: HUB_SELF_ID })
    expect(principalFromVaultOwner('org', 'tenant-7')).toEqual({ kind: 'hub', id: 'tenant-7' })
  })

  it('passes user/peer straight through', () => {
    expect(principalFromVaultOwner('user', 'u1')).toEqual({ kind: 'user', id: 'u1' })
    expect(principalFromVaultOwner('peer', 'hub-b')).toEqual({ kind: 'peer', id: 'hub-b' })
  })

  it('inverts back to the legacy vault owner shape', () => {
    expect(principalToVaultOwner({ kind: 'hub', id: HUB_SELF_ID })).toEqual({ ownerKind: 'org', ownerId: null })
    expect(principalToVaultOwner({ kind: 'hub', id: 'tenant-7' })).toEqual({ ownerKind: 'org', ownerId: 'tenant-7' })
    expect(principalToVaultOwner(userPrincipal('u1'))).toEqual({ ownerKind: 'user', ownerId: 'u1' })
    expect(principalToVaultOwner(peerPrincipal('hub-b'))).toEqual({ ownerKind: 'peer', ownerId: 'hub-b' })
  })

  it('round-trips org↔hub through both bridges', () => {
    const back = principalToVaultOwner(principalFromVaultOwner('org', null))
    expect(back).toEqual({ ownerKind: 'org', ownerId: null })
  })

  it('refuses to forge a vault owner for an agent principal (no agent vault owner yet)', () => {
    expect(() => principalToVaultOwner(agentPrincipal('writer'))).toThrow(/agent principals are not vault owners/)
  })
})
