/**
 * Route B P0-M1 — identity store tenant/namespace dimension.
 *
 * The namespace on an identity store is *metadata*: physical isolation is the
 * host's tenant-resolved `dbPath` (see core's `tenantRoot`). These tests pin
 * (a) the namespace is recorded / defaults to `'default'` / is validated, and
 * (b) two stores opened at distinct on-disk paths (the shape a multi-tenant
 * host produces) never share rows, each reporting its own namespace.
 *
 * `@gotong/identity` has zero runtime deps on purpose, so this test does NOT
 * import `@gotong/core` — it reproduces the `<base>/tenants/<id>/` layout by
 * hand (core already owns the `tenantRoot` contract test).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openIdentityStore, type IdentityStore } from '../src/index.js'

describe('identity store namespace (Route B P0-M1)', () => {
  it('defaults to the default tenant', () => {
    const s = openIdentityStore({ dbPath: ':memory:' })
    expect(s.namespace).toBe('default')
    s.close()
  })

  it('records an explicit namespace', () => {
    const s = openIdentityStore({ dbPath: ':memory:', namespace: 'alpha' })
    expect(s.namespace).toBe('alpha')
    s.close()
  })

  it('rejects an empty / non-string namespace', () => {
    expect(() => openIdentityStore({ dbPath: ':memory:', namespace: '' })).toThrow(
      TypeError,
    )
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openIdentityStore({ dbPath: ':memory:', namespace: 7 as any }),
    ).toThrow(TypeError)
  })

  describe('two tenants at distinct on-disk paths are isolated', () => {
    let base: string
    let a: IdentityStore
    let b: IdentityStore

    beforeEach(async () => {
      base = await mkdtemp(join(tmpdir(), 'gotong-id-tenant-'))
      // The layout a multi-tenant host resolves via core's `tenantRoot`.
      a = openIdentityStore({
        dbPath: join(base, 'tenants', 'alpha', 'identity.sqlite'),
        namespace: 'alpha',
      })
      b = openIdentityStore({
        dbPath: join(base, 'tenants', 'beta', 'identity.sqlite'),
        namespace: 'beta',
      })
    })

    afterEach(async () => {
      a.close()
      b.close()
      await rm(base, { recursive: true, force: true })
    })

    it('a user created in tenant A is invisible in tenant B', () => {
      a.bootstrap({ ownerEmail: 'owner-a@local', ownerDisplayName: 'A' })
      b.bootstrap({ ownerEmail: 'owner-b@local', ownerDisplayName: 'B' })
      a.createUser({ email: 'member@alpha.example' })

      expect(a.getUserByEmail('member@alpha.example')).not.toBeNull()
      expect(b.getUserByEmail('member@alpha.example')).toBeNull()
      // Bootstrap owner is per-store too.
      expect(a.getUserByEmail('owner-a@local')).not.toBeNull()
      expect(a.getUserByEmail('owner-b@local')).toBeNull()
      expect(a.namespace).toBe('alpha')
      expect(b.namespace).toBe('beta')
    })
  })
})
