/**
 * Integration test for the v4 identity layer wired into host startup.
 *
 * Doesn't boot the full host (no web / ws / hub) — that's covered by
 * the existing main.ts smoke tests. This file pins the contract
 * between `Space.openOrInit` (which mints the legacy v3 admin URL token
 * for host-level admin routes) and `openIdentityStore().bootstrap()`
 * (which creates the v4 owner user).
 *
 * A2.2 — bootstrap no longer migrates the v3 admin token into the v4
 * surface. The two auth systems are deliberately decoupled: v3 admin
 * cookie / `/admin?token=` keeps the host-level admin routes (agents,
 * secrets, workflows) accessible; the v4 IdentityStore handles user
 * management + invitations + audit log. Pre-A2.2 tests that asserted
 * "the v3 admin token can authenticate against the v4 surface" were
 * removed — that contract no longer exists.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Space } from '@gotong/core'
import { openIdentityStore } from '@gotong/identity'

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
  const d = mkdtempSync(join(tmpdir(), 'gotong-host-id-'))
  tmpDirs.push(d)
  return d
}

describe('host startup × @gotong/identity', () => {
  it('first-init: bootstrap creates owner user with no credentials', async () => {
    const spaceDir = mkTmp()
    const { adminToken } = await Space.openOrInit(spaceDir, {
      name: 'test-workspace',
      adminDisplayName: 'Operator',
    })
    // Space.openOrInit still mints a v3 admin token for the
    // host-level `/admin?token=...` URL — but that token NEVER touches
    // the IdentityStore. The two systems are independent post-A2.2.
    expect(typeof adminToken).toBe('string')
    expect(adminToken!.length).toBeGreaterThan(0)

    const identity = openIdentityStore({
      dbPath: join(spaceDir, 'identity.sqlite'),
    })
    try {
      const ib = identity.bootstrap({
        ownerEmail: 'admin@local',
        ownerDisplayName: 'Operator',
      })
      expect(ib.bootstrapped).toBe(true)
      expect(typeof ib.ownerUserId).toBe('string')

      // Side effects: db file on disk, owner user with role=owner,
      // and crucially — NO credentials. The first operator picks a
      // password via the C1 setup wizard (or via the emergency
      // `mint-admin-token` host subcommand).
      expect(existsSync(join(spaceDir, 'identity.sqlite'))).toBe(true)
      expect(identity.countUsers()).toBe(1)
      const owner = identity.getUserById(ib.ownerUserId!)
      expect(owner?.email).toBe('admin@local')
      expect(identity.getMembership(ib.ownerUserId!)?.role).toBe('owner')
      expect(identity.listCredentials(ib.ownerUserId!)).toEqual([])

      // A2.2 — the v3 admin token CANNOT log into the v4 surface.
      // authenticateToken throws because there's no matching credential.
      expect(() =>
        identity.authenticateToken({ token: adminToken! }),
      ).toThrow(/authentication_failed|invalid/)
    } finally {
      identity.close()
    }
  })

  it('second boot: bootstrap is idempotent — no mutation', async () => {
    const spaceDir = mkTmp()
    await Space.openOrInit(spaceDir, {
      name: 'test-workspace',
      adminDisplayName: 'Operator',
    })

    const identityA = openIdentityStore({
      dbPath: join(spaceDir, 'identity.sqlite'),
    })
    const ibA = identityA.bootstrap({ ownerEmail: 'admin@local' })
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
      const ibB = identityB.bootstrap({ ownerEmail: 'admin@local' })
      expect(ibB.bootstrapped).toBe(false)
      expect(ibB.ownerUserId).toBeNull()
      expect(identityB.listUsers()).toEqual(usersAfterFirst)
      expect(identityB.listCredentials(ibA.ownerUserId!)).toEqual(
        credsAfterFirst,
      )
    } finally {
      identityB.close()
    }
  })

  it('non-first init (adminToken=null): bootstrap still creates owner user', async () => {
    // Simulates the upgrade path: an existing v3 workspace boots into a
    // v4 host for the first time. `openOrInit` returns adminToken=null
    // because the workspace was already initialised in v3. Bootstrap
    // still creates the owner user — the operator picks a password via
    // the setup wizard.
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
      const ib = identity.bootstrap({ ownerEmail: 'admin@local' })
      expect(ib.bootstrapped).toBe(true)

      // Owner user exists but has no credentials yet — operator will
      // need to set a password via the setup wizard.
      const creds = identity.listCredentials(ib.ownerUserId!)
      expect(creds).toEqual([])
    } finally {
      identity.close()
    }
  })

  it('post-bootstrap: owner can set password, mint api keys and create members via IdentityStore', async () => {
    // End-to-end "what does v4 buy us" smoke. After bootstrap, the
    // owner sets a password (the setup-wizard flow), then creates a
    // second user (Alice) and issues themselves an api key. None of
    // this was possible in v3.
    const spaceDir = mkTmp()
    await Space.openOrInit(spaceDir, {
      name: 'test-workspace',
      adminDisplayName: 'Operator',
    })
    const identity = openIdentityStore({
      dbPath: join(spaceDir, 'identity.sqlite'),
    })
    try {
      const ib = identity.bootstrap({ ownerEmail: 'admin@local' })
      expect(ib.bootstrapped).toBe(true)

      // Owner sets their own password (what the setup wizard does).
      identity.setPassword(ib.ownerUserId!, 'owner-password-long-enough')

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
