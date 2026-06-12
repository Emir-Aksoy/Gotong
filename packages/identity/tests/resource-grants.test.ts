/**
 * v5 A-M1 — unified resource grants (ResourceGrantStore via IdentityStore +
 * the v16 copy-and-drop migration off the old workflow_grants table).
 *
 * Two halves:
 *   1. The generic facade — set/get/has/list/remove for an arbitrary
 *      (resourceKind, resourceId, principal). Covers every principal kind,
 *      the perm ladder, upsert-on-regrant, oldest-first listing, isolation,
 *      and validation (bad kind / bad perm / bad principal / empty ids).
 *   2. The v16 migration — seed a pre-v16 db that still has workflow_grants,
 *      run applyMigrations, and assert every row was copied to resource_grants
 *      under a `user:<id>` principal and the old table is gone.
 *
 * grantedAt is passed explicitly where ordering matters so the tests are
 * wall-clock independent. The table has no FK, so plain string ids stand in.
 */

import { describe, expect, it, beforeEach } from 'vitest'

import {
  IdentityError,
  IdentityStore,
  openIdentityStore,
  userPrincipal,
  agentPrincipal,
  peerPrincipal,
  hubPrincipal,
  type Principal,
} from '../src/index.js'
import { openDb } from '../src/db.js'
import { applyMigrations, MIGRATION_VERSIONS } from '../src/schema.js'

describe('IdentityStore — resource grants (v5 A-M1)', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:' })
  })

  it('set + get round-trips a grant, defaulting grantedBy=null', () => {
    const g = store.setResourceGrant({
      resourceKind: 'agent',
      resourceId: 'agent-a',
      principal: userPrincipal('alice'),
      perm: 'owner',
      grantedAt: 1000,
    })
    expect(g).toEqual({
      resourceKind: 'agent',
      resourceId: 'agent-a',
      principal: { kind: 'user', id: 'alice' },
      perm: 'owner',
      grantedBy: null,
      grantedAt: 1000,
    })
    expect(store.getResourceGrant('agent', 'agent-a', userPrincipal('alice'))).toEqual(g)
    expect(store.getResourceGrant('agent', 'agent-a', userPrincipal('bob'))).toBeNull()
  })

  it('set assigns a default grantedAt when omitted', () => {
    const before = Date.now()
    const g = store.setResourceGrant({
      resourceKind: 'credential',
      resourceId: 'cred-1',
      principal: agentPrincipal('summarizer'),
      perm: 'viewer',
    })
    expect(g.grantedAt).toBeGreaterThanOrEqual(before)
  })

  it('every principal kind round-trips through the principal codec', () => {
    const principals: Principal[] = [
      userPrincipal('alice'),
      agentPrincipal('summarizer'),
      peerPrincipal('org-x'),
      hubPrincipal(),
    ]
    for (const p of principals) {
      store.setResourceGrant({ resourceKind: 'agent', resourceId: 'shared', principal: p, perm: 'editor' })
    }
    const rows = store.listResourceGrants('agent', 'shared')
    expect(rows.map((g) => `${g.principal.kind}:${g.principal.id}`).sort()).toEqual([
      'agent:summarizer',
      'hub:self',
      'peer:org-x',
      'user:alice',
    ])
  })

  it('set is an upsert on (resourceKind, resourceId, principal)', () => {
    const p = userPrincipal('alice')
    store.setResourceGrant({ resourceKind: 'agent', resourceId: 'a', principal: p, perm: 'viewer', grantedBy: 'sys' })
    store.setResourceGrant({ resourceKind: 'agent', resourceId: 'a', principal: p, perm: 'editor', grantedBy: 'owner-u' })
    const g = store.getResourceGrant('agent', 'a', p)
    expect(g?.perm).toBe('editor')
    expect(g?.grantedBy).toBe('owner-u')
    expect(store.listResourceGrants('agent', 'a')).toHaveLength(1)
  })

  it('has(): the perm ladder owner ⊇ editor ⊇ viewer, fail-closed on miss', () => {
    store.setResourceGrant({ resourceKind: 'agent', resourceId: 'a', principal: userPrincipal('o'), perm: 'owner' })
    store.setResourceGrant({ resourceKind: 'agent', resourceId: 'a', principal: userPrincipal('e'), perm: 'editor' })
    store.setResourceGrant({ resourceKind: 'agent', resourceId: 'a', principal: userPrincipal('v'), perm: 'viewer' })

    expect(store.hasResourceGrant('agent', 'a', userPrincipal('o'), 'owner')).toBe(true)
    expect(store.hasResourceGrant('agent', 'a', userPrincipal('e'), 'owner')).toBe(false)
    expect(store.hasResourceGrant('agent', 'a', userPrincipal('e'), 'editor')).toBe(true)
    expect(store.hasResourceGrant('agent', 'a', userPrincipal('v'), 'editor')).toBe(false)
    expect(store.hasResourceGrant('agent', 'a', userPrincipal('v'), 'viewer')).toBe(true)
    // a different principal kind with the same id is NOT the same subject
    expect(store.hasResourceGrant('agent', 'a', agentPrincipal('o'), 'viewer')).toBe(false)
    expect(store.hasResourceGrant('agent', 'a', userPrincipal('stranger'), 'viewer')).toBe(false)
  })

  it('listForResource / listForPrincipal are oldest-first and scoped', () => {
    const alice = userPrincipal('alice')
    store.setResourceGrant({ resourceKind: 'agent', resourceId: 'a', principal: alice, perm: 'owner', grantedAt: 1 })
    store.setResourceGrant({ resourceKind: 'agent', resourceId: 'a', principal: userPrincipal('bob'), perm: 'editor', grantedAt: 2 })
    store.setResourceGrant({ resourceKind: 'credential', resourceId: 'c', principal: alice, perm: 'viewer', grantedAt: 3 })

    const onA = store.listResourceGrants('agent', 'a')
    expect(onA.map((g) => g.principal.id)).toEqual(['alice', 'bob'])
    const aliceHas = store.listPrincipalGrants(alice)
    expect(aliceHas.map((g) => `${g.resourceKind}/${g.resourceId}:${g.perm}`)).toEqual([
      'agent/a:owner',
      'credential/c:viewer',
    ])
  })

  it('remove deletes one grant; removeAllForResource clears the resource', () => {
    store.setResourceGrant({ resourceKind: 'agent', resourceId: 'a', principal: userPrincipal('alice'), perm: 'owner' })
    store.setResourceGrant({ resourceKind: 'agent', resourceId: 'a', principal: userPrincipal('bob'), perm: 'editor' })

    expect(store.removeResourceGrant('agent', 'a', userPrincipal('bob'))).toBe(true)
    expect(store.removeResourceGrant('agent', 'a', userPrincipal('bob'))).toBe(false)
    expect(store.listResourceGrants('agent', 'a')).toHaveLength(1)
    expect(store.removeAllResourceGrants('agent', 'a')).toBe(1)
    expect(store.listResourceGrants('agent', 'a')).toHaveLength(0)
  })

  it('rejects an invalid resourceKind, perm, principal, and empty ids', () => {
    const p = userPrincipal('u')
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store.setResourceGrant({ resourceKind: 'secret' as any, resourceId: 'r', principal: p, perm: 'owner' }),
    ).toThrow(IdentityError)
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store.setResourceGrant({ resourceKind: 'agent', resourceId: 'r', principal: p, perm: 'admin' as any }),
    ).toThrow(IdentityError)
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store.setResourceGrant({ resourceKind: 'agent', resourceId: 'r', principal: { kind: 'robot', id: 'x' } as any, perm: 'owner' }),
    ).toThrow(IdentityError)
    expect(() =>
      store.setResourceGrant({ resourceKind: 'agent', resourceId: '', principal: p, perm: 'owner' }),
    ).toThrow(IdentityError)
  })

  it('grants are isolated per (kind, resource)', () => {
    store.setResourceGrant({ resourceKind: 'agent', resourceId: 'a', principal: userPrincipal('alice'), perm: 'owner' })
    // same id, different kind → different resource
    expect(store.hasResourceGrant('credential', 'a', userPrincipal('alice'), 'viewer')).toBe(false)
    expect(store.getResourceGrant('credential', 'a', userPrincipal('alice'))).toBeNull()
  })

  // ---------------------------------------------------------------------
  // The Phase 19 P2-M5 workflow-grant facade now rides on resource_grants.
  // ---------------------------------------------------------------------

  it('workflow facade is a resource grant with a user principal', () => {
    store.setWorkflowGrant({ workflowId: 'wf-a', userId: 'alice', perm: 'owner', grantedAt: 7 })
    // visible through BOTH the legacy facade and the generic view
    expect(store.listWorkflowGrants('wf-a')).toEqual([{
      workflowId: 'wf-a',
      userId: 'alice',
      perm: 'owner',
      grantedBy: null,
      grantedAt: 7,
    }])
    expect(store.getResourceGrant('workflow', 'wf-a', userPrincipal('alice'))).toEqual({
      resourceKind: 'workflow',
      resourceId: 'wf-a',
      principal: { kind: 'user', id: 'alice' },
      perm: 'owner',
      grantedBy: null,
      grantedAt: 7,
    })
  })

  it('listWorkflowGrants hides non-user principals (no userId to report)', () => {
    store.setWorkflowGrant({ workflowId: 'wf', userId: 'alice', perm: 'owner', grantedAt: 1 })
    // an agent granted on the same workflow via the generic API
    store.setResourceGrant({ resourceKind: 'workflow', resourceId: 'wf', principal: agentPrincipal('bot'), perm: 'editor', grantedAt: 2 })
    const rows = store.listWorkflowGrants('wf')
    expect(rows.map((g) => g.userId)).toEqual(['alice'])
    // the generic view still sees both
    expect(store.listResourceGrants('workflow', 'wf')).toHaveLength(2)
  })
})

describe('resource_grants — v16 migration copies + drops workflow_grants', () => {
  it('copies every workflow_grants row to a user: principal then drops the old table', () => {
    const db = openDb(':memory:')
    // Stand up the schema_migrations ledger and mark EVERY migration except
    // v16 as already applied, so applyMigrations runs ONLY v16. (We don't need
    // the real tables for those versions; the v16 SQL only touches
    // workflow_grants + resource_grants.) Marking all-but-16 — rather than a
    // fixed v1..v15 range — keeps this isolation test immune to later appended
    // migrations (e.g. v17's ALTER TABLE peers, which would otherwise run here
    // against a peers table this synthetic db never created).
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `)
    const seedMig = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
    for (const v of MIGRATION_VERSIONS) if (v !== 16) seedMig.run(v, `seed-${v}`, 0)

    // The old (v13) workflow_grants table + a couple of rows.
    db.exec(`
      CREATE TABLE workflow_grants (
        workflow_id  TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        perm         TEXT NOT NULL,
        granted_by   TEXT,
        granted_at   INTEGER NOT NULL,
        PRIMARY KEY (workflow_id, user_id)
      );
    `)
    const seedGrant = db.prepare(
      'INSERT INTO workflow_grants (workflow_id, user_id, perm, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)',
    )
    seedGrant.run('wf-a', 'alice', 'owner', null, 100)
    seedGrant.run('wf-a', 'bob', 'editor', 'alice', 200)
    seedGrant.run('wf-b', 'alice', 'viewer', null, 300)

    const { applied } = applyMigrations(db)
    expect(applied).toEqual([16]) // only the new migration ran

    // resource_grants now holds the copied rows under user: principals.
    const rows = db
      .prepare('SELECT resource_kind, resource_id, principal, perm, granted_by, granted_at FROM resource_grants ORDER BY granted_at ASC')
      .all() as Array<{
      resource_kind: string
      resource_id: string
      principal: string
      perm: string
      granted_by: string | null
      granted_at: number
    }>
    expect(rows).toEqual([
      { resource_kind: 'workflow', resource_id: 'wf-a', principal: 'user:alice', perm: 'owner', granted_by: null, granted_at: 100 },
      { resource_kind: 'workflow', resource_id: 'wf-a', principal: 'user:bob', perm: 'editor', granted_by: 'alice', granted_at: 200 },
      { resource_kind: 'workflow', resource_id: 'wf-b', principal: 'user:alice', perm: 'viewer', granted_by: null, granted_at: 300 },
    ])

    // The old table is gone.
    const leftover = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_grants'")
      .all() as unknown[]
    expect(leftover).toHaveLength(0)
    db.close()
  })
})
