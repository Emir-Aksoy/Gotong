/**
 * Integration test for the v4 identity layer wired into host startup.
 *
 * Doesn't boot the full host (no web / ws / hub) — that's covered by
 * the existing main.ts smoke tests. This file pins the contract
 * between `Space.openOrInit` (which mints the v3 admin token) and
 * `openIdentityStore().bootstrap()` (which migrates it). If a future
 * refactor breaks the handover, this suite catches it before the
 * admin token silently fails to migrate in real production startups.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Space } from '@aipehub/core'
import { openIdentityStore } from '@aipehub/identity'

const tmpDirs: string[] = []

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* leave behind on cleanup failure — `tmp` is the OS's problem */
    }
  }
})

function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'aipehub-host-id-'))
  tmpDirs.push(d)
  return d
}

describe('host startup × @aipehub/identity', () => {
  it('first-init: v3 admin token is migrated into the IdentityStore', async () => {
    const spaceDir = mkTmp()
    const { adminToken } = await Space.openOrInit(spaceDir, {
      name: 'test-workspace',
      adminDisplayName: 'Operator',
    })
    expect(typeof adminToken).toBe('string')
    expect(adminToken!.length).toBeGreaterThan(0)

    const identity = openIdentityStore({
      dbPath: join(spaceDir, 'identity.sqlite'),
    })
    try {
      const ib = identity.bootstrap({
        adminToken: adminToken!,
        ownerEmail: 'admin@local',
        ownerDisplayName: 'Operator',
      })
      expect(ib.bootstrapped).toBe(true)
      expect(ib.adminTokenMigrated).toBe(true)
      expect(typeof ib.ownerUserId).toBe('string')

      // Side effects: db file on disk, owner user with role=owner.
      expect(existsSync(join(spaceDir, 'identity.sqlite'))).toBe(true)
      expect(identity.countUsers()).toBe(1)
      const owner = identity.getUserById(ib.ownerUserId!)
      expect(owner?.email).toBe('admin@local')
      expect(identity.getMembership(ib.ownerUserId!)?.role).toBe('owner')

      // The v3 admin token now authenticates against the v4 surface
      // — this is the load-bearing assertion. If it stops being true,
      // upgrading from v3 → v4 would silently lock users out of the
      // new admin paths.
      const session = identity.authenticateToken({ token: adminToken! })
      expect(session.userId).toBe(ib.ownerUserId)

      const probe = identity.getSessionByToken(session.token)
      expect(probe?.role).toBe('owner')
      expect(probe?.user.email).toBe('admin@local')
    } finally {
      identity.close()
    }
  })

  it('second boot: bootstrap is idempotent — no users/credentials added', async () => {
    const spaceDir = mkTmp()
    const { adminToken } = await Space.openOrInit(spaceDir, {
      name: 'test-workspace',
      adminDisplayName: 'Operator',
    })

    const identityA = openIdentityStore({
      dbPath: join(spaceDir, 'identity.sqlite'),
    })
    const ibA = identityA.bootstrap({
      adminToken: adminToken!,
      ownerEmail: 'admin@local',
    })
    expect(ibA.bootstrapped).toBe(true)
    const usersAfterFirst = identityA.listUsers()
    const credsAfterFirst = identityA.listCredentials(ibA.ownerUserId!)
    identityA.close()

    // "Second boot" = a fresh handle pointing at the same file. Mirrors
    // what main.ts does every time the host process starts.
    const identityB = openIdentityStore({
      dbPath: join(spaceDir, 'identity.sqlite'),
    })
    try {
      const ibB = identityB.bootstrap({
        adminToken: adminToken!, // even passing the token again must be safe
        ownerEmail: 'admin@local',
      })
      expect(ibB.bootstrapped).toBe(false)
      expect(ibB.ownerUserId).toBeNull()
      expect(ibB.adminTokenMigrated).toBe(false)
      expect(identityB.listUsers()).toEqual(usersAfterFirst)
      // Credential list is keyed by id, not by content, so equality is
      // sufficient — bootstrap must not re-mint the credential row.
      expect(identityB.listCredentials(ibA.ownerUserId!)).toEqual(
        credsAfterFirst,
      )
    } finally {
      identityB.close()
    }
  })

  it('non-first init (adminToken=null) still creates owner user but no credential', async () => {
    // Simulates the upgrade path: an existing v3 workspace boots into a
    // v4 host for the first time. `openOrInit` returns adminToken=null
    // because the workspace was already initialised in v3. Bootstrap
    // should still create the owner user — the operator will need to
    // log in via the v3 path once, then issue a fresh credential via
    // the UI (Phase 2.3).
    const spaceDir = mkTmp()
    // First create the space in "v3 mode" (with admin).
    await Space.openOrInit(spaceDir, {
      name: 'test-workspace',
      adminDisplayName: 'Operator',
    })
    // Now open again — like restarting the host.
    const { adminToken } = await Space.openOrInit(spaceDir, {
      name: 'test-workspace',
      adminDisplayName: 'Operator',
    })
    expect(adminToken).toBeNull()

    const identity = openIdentityStore({
      dbPath: join(spaceDir, 'identity.sqlite'),
    })
    try {
      // Mirror main.ts: pass `adminToken` field only when non-null.
      const bootstrapInput: { ownerEmail: string; adminToken?: string } = {
        ownerEmail: 'admin@local',
      }
      const ib = identity.bootstrap(bootstrapInput)
      expect(ib.bootstrapped).toBe(true)
      expect(ib.adminTokenMigrated).toBe(false)

      // Owner user exists but has no credentials yet — operator will
      // need to log in via v3 path and self-issue.
      const creds = identity.listCredentials(ib.ownerUserId!)
      expect(creds).toEqual([])
    } finally {
      identity.close()
    }
  })

  it('post-bootstrap: owner can mint api keys and create member users via IdentityStore', async () => {
    // End-to-end "what does v4 buy us" smoke. After bootstrap, the
    // owner uses the new surface to create a second user (Alice) and
    // give them a password. Alice can then log in and gets a session
    // resolving to role=member. None of this was possible in v3.
    const spaceDir = mkTmp()
    const { adminToken } = await Space.openOrInit(spaceDir, {
      name: 'test-workspace',
      adminDisplayName: 'Operator',
    })
    const identity = openIdentityStore({
      dbPath: join(spaceDir, 'identity.sqlite'),
    })
    try {
      const ib = identity.bootstrap({
        adminToken: adminToken!,
        ownerEmail: 'admin@local',
      })
      expect(ib.bootstrapped).toBe(true)

      // Owner spins up a second user with a password.
      const alice = identity.createUser({
        email: 'alice@team.test',
        displayName: 'Alice',
        password: 'a-long-enough-password',
        role: 'member',
      })
      expect(alice.email).toBe('alice@team.test')

      // Owner issues themselves an api key for programmatic access.
      const { key } = identity.issueApiKey({
        userId: ib.ownerUserId!,
        label: 'CI runner',
      })
      expect(key).toMatch(/^aipk_/)
      const ownerSession = identity.authenticateToken({ token: key })
      const ownerProbe = identity.getSessionByToken(ownerSession.token)
      expect(ownerProbe?.role).toBe('owner')

      // Alice logs in via password.
      const aliceSession = identity.authenticatePassword({
        email: 'alice@team.test',
        password: 'a-long-enough-password',
      })
      const aliceProbe = identity.getSessionByToken(aliceSession.token)
      expect(aliceProbe?.role).toBe('member')
      expect(aliceProbe?.user.id).toBe(alice.id)
    } finally {
      identity.close()
    }
  })
})
