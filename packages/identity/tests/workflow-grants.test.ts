/**
 * Phase 19 P2-M5 — workflow grants (WorkflowGrantStore via IdentityStore).
 *
 * Coverage:
 *   - set + get round-trip; default grantedAt (Date.now) + null grantedBy
 *   - set is an upsert on (workflowId, userId): a regrant replaces the perm
 *   - has(): perm-ladder rank (owner ⊇ editor ⊇ viewer); missing grant → false
 *   - listForWorkflow / listForUser: oldest-first, scoped correctly
 *   - remove (true/false) + removeAllForWorkflow (count)
 *   - validation: bad perm, empty ids
 *   - isolation: a grant on one workflow never leaks to another
 *
 * grantedAt is passed explicitly where ordering matters so the tests are
 * wall-clock independent. The table has no FK to users, so plain string ids
 * stand in.
 */

import { describe, expect, it, beforeEach } from 'vitest'

import { IdentityError, IdentityStore, openIdentityStore, userPrincipal } from '../src/index.js'

describe('IdentityStore — workflow grants (Phase 19 P2-M5)', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:' })
  })

  it('set + get round-trips a grant, defaulting grantedBy=null', () => {
    const g = store.setWorkflowGrant({
      workflowId: 'wf-a',
      userId: 'alice',
      perm: 'owner',
      grantedAt: 1000,
    })
    expect(g).toEqual({
      workflowId: 'wf-a',
      userId: 'alice',
      perm: 'owner',
      grantedBy: null,
      grantedAt: 1000,
    })
    expect(store.listWorkflowGrants('wf-a')).toEqual([g])
    expect(store.hasWorkflowGrant('wf-a', 'bob', 'viewer')).toBe(false)
  })

  it('set assigns a default grantedAt when omitted', () => {
    const before = Date.now()
    const g = store.setWorkflowGrant({ workflowId: 'wf-a', userId: 'alice', perm: 'viewer' })
    expect(g.grantedAt).toBeGreaterThanOrEqual(before)
  })

  it('set is an upsert — a regrant replaces the perm + granter', () => {
    store.setWorkflowGrant({ workflowId: 'wf-a', userId: 'alice', perm: 'viewer', grantedBy: 'sys' })
    store.setWorkflowGrant({ workflowId: 'wf-a', userId: 'alice', perm: 'editor', grantedBy: 'owner-u' })
    const g = store.listWorkflowGrants('wf-a')[0]
    expect(g?.perm).toBe('editor')
    expect(g?.grantedBy).toBe('owner-u')
    // still exactly one row for the pair
    expect(store.listWorkflowGrants('wf-a')).toHaveLength(1)
  })

  it('has(): the perm ladder owner ⊇ editor ⊇ viewer', () => {
    store.setWorkflowGrant({ workflowId: 'wf', userId: 'owner-u', perm: 'owner' })
    store.setWorkflowGrant({ workflowId: 'wf', userId: 'editor-u', perm: 'editor' })
    store.setWorkflowGrant({ workflowId: 'wf', userId: 'viewer-u', perm: 'viewer' })

    // owner satisfies every requirement
    expect(store.hasWorkflowGrant('wf', 'owner-u', 'owner')).toBe(true)
    expect(store.hasWorkflowGrant('wf', 'owner-u', 'editor')).toBe(true)
    expect(store.hasWorkflowGrant('wf', 'owner-u', 'viewer')).toBe(true)
    // editor satisfies editor + viewer, not owner
    expect(store.hasWorkflowGrant('wf', 'editor-u', 'owner')).toBe(false)
    expect(store.hasWorkflowGrant('wf', 'editor-u', 'editor')).toBe(true)
    expect(store.hasWorkflowGrant('wf', 'editor-u', 'viewer')).toBe(true)
    // viewer satisfies only viewer
    expect(store.hasWorkflowGrant('wf', 'viewer-u', 'editor')).toBe(false)
    expect(store.hasWorkflowGrant('wf', 'viewer-u', 'viewer')).toBe(true)
    // no grant → false for any level (fail closed)
    expect(store.hasWorkflowGrant('wf', 'stranger', 'viewer')).toBe(false)
  })

  it('listForWorkflow / listForUser are oldest-first and scoped', () => {
    store.setWorkflowGrant({ workflowId: 'wf-a', userId: 'alice', perm: 'owner', grantedAt: 1 })
    store.setWorkflowGrant({ workflowId: 'wf-a', userId: 'bob', perm: 'editor', grantedAt: 2 })
    store.setWorkflowGrant({ workflowId: 'wf-b', userId: 'alice', perm: 'viewer', grantedAt: 3 })

    const onA = store.listWorkflowGrants('wf-a')
    expect(onA.map((g) => g.userId)).toEqual(['alice', 'bob']) // oldest-first
    // per-user view goes through the generic resource_grants surface
    const aliceHas = store
      .listPrincipalGrants(userPrincipal('alice'))
      .filter((g) => g.resourceKind === 'workflow')
    expect(aliceHas.map((g) => `${g.resourceId}:${g.perm}`)).toEqual([
      'wf-a:owner',
      'wf-b:viewer',
    ])
  })

  it('remove deletes one grant; removeAllForWorkflow clears the workflow', () => {
    store.setWorkflowGrant({ workflowId: 'wf', userId: 'alice', perm: 'owner' })
    store.setWorkflowGrant({ workflowId: 'wf', userId: 'bob', perm: 'editor' })

    expect(store.removeWorkflowGrant('wf', 'bob')).toBe(true)
    expect(store.removeWorkflowGrant('wf', 'bob')).toBe(false) // already gone
    expect(store.listWorkflowGrants('wf')).toHaveLength(1)

    expect(store.removeAllWorkflowGrants('wf')).toBe(1)
    expect(store.listWorkflowGrants('wf')).toHaveLength(0)
  })

  it('rejects an invalid perm and empty ids', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store.setWorkflowGrant({ workflowId: 'wf', userId: 'u', perm: 'admin' as any }),
    ).toThrow(IdentityError)
    expect(() =>
      store.setWorkflowGrant({ workflowId: '', userId: 'u', perm: 'owner' }),
    ).toThrow(IdentityError)
    expect(() =>
      store.setWorkflowGrant({ workflowId: 'wf', userId: '', perm: 'owner' }),
    ).toThrow(IdentityError)
  })

  it('grants are isolated per workflow', () => {
    store.setWorkflowGrant({ workflowId: 'wf-a', userId: 'alice', perm: 'owner' })
    expect(store.hasWorkflowGrant('wf-b', 'alice', 'viewer')).toBe(false)
    expect(store.listWorkflowGrants('wf-b')).toEqual([])
  })
})
