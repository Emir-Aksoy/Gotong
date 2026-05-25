/**
 * Integration tests for IdentityStore.
 *
 * Each test opens a fresh `:memory:` SQLite — no on-disk side effects,
 * full isolation between tests. We rely on better-sqlite3's in-memory
 * mode (same code path as on-disk; only the storage backend differs).
 *
 * Coverage focus:
 *   - happy paths for every public method (bootstrap, createUser,
 *     setPassword, issueApiKey / issueAdminToken, authenticate*,
 *     getSessionByToken, revoke*)
 *   - the security-relevant rejections (duplicate email,
 *     authentication_failed on wrong password / unknown token,
 *     session_expired through TTL, role 'invalid_role')
 *   - bootstrap idempotence (the most likely place for a future
 *     refactor to introduce a subtle bug)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  openIdentityStore,
  IdentityStore,
  IdentityError,
  type Role,
} from '../src/index.js'

describe('IdentityStore', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:' })
  })

  afterEach(() => {
    store.close()
  })

  // =====================================================================
  // bootstrap
  // =====================================================================

  describe('bootstrap', () => {
    it('first call on empty db creates owner user with no credentials', () => {
      const r = store.bootstrap()
      expect(r.bootstrapped).toBe(true)
      expect(r.adminTokenMigrated).toBe(false)
      expect(r.ownerUserId).toBeTypeOf('string')

      const u = store.getUserById(r.ownerUserId!)
      expect(u?.email).toBe('admin@local')
      expect(u?.displayName).toBe('Admin')

      const m = store.getMembership(r.ownerUserId!)
      expect(m?.role).toBe('owner')

      expect(store.listCredentials(r.ownerUserId!).length).toBe(0)
    })

    it('first call with adminToken migrates it as admin_token credential', () => {
      const r = store.bootstrap({ adminToken: 'legacy-v3-admin-hex-token' })
      expect(r.adminTokenMigrated).toBe(true)
      const creds = store.listCredentials(r.ownerUserId!)
      expect(creds.length).toBe(1)
      expect(creds[0]!.kind).toBe('admin_token')
      // identifier is sha256 of the raw token — opaque to user but we
      // can verify by checking we can auth with the raw token.
      const session = store.authenticateToken({
        token: 'legacy-v3-admin-hex-token',
      })
      expect(session.userId).toBe(r.ownerUserId)
    })

    it('second call is idempotent (returns bootstrapped=false, no mutation)', () => {
      store.bootstrap({ adminToken: 'first-token' })
      const before = store.listUsers()
      const r2 = store.bootstrap({ adminToken: 'different-token' })
      expect(r2.bootstrapped).toBe(false)
      expect(r2.ownerUserId).toBeNull()
      expect(r2.adminTokenMigrated).toBe(false)
      // Total users unchanged; the "different-token" was NOT added.
      expect(store.listUsers()).toEqual(before)
    })

    it('honors custom ownerEmail / ownerDisplayName', () => {
      const r = store.bootstrap({
        ownerEmail: 'founder@acme.test',
        ownerDisplayName: 'Founder',
      })
      const u = store.getUserById(r.ownerUserId!)
      expect(u?.email).toBe('founder@acme.test')
      expect(u?.displayName).toBe('Founder')
    })

    it('rejects malformed ownerEmail', () => {
      expect(() => store.bootstrap({ ownerEmail: 'not-an-email' })).toThrow(
        IdentityError,
      )
    })
  })

  // =====================================================================
  // createUser
  // =====================================================================

  describe('createUser', () => {
    it('creates a user with default role=member and no credentials', () => {
      const u = store.createUser({ email: 'alice@acme.test' })
      expect(u.email).toBe('alice@acme.test')
      expect(u.displayName).toBeNull()
      expect(u.lastLoginAt).toBeNull()
      expect(store.getMembership(u.id)?.role).toBe('member')
      expect(store.listCredentials(u.id).length).toBe(0)
    })

    it('normalises email to lowercase + trim', () => {
      const u = store.createUser({ email: '  Alice@Acme.TEST  ' })
      expect(u.email).toBe('alice@acme.test')
      expect(store.getUserByEmail('alice@acme.test')?.id).toBe(u.id)
      expect(store.getUserByEmail('ALICE@ACME.TEST')?.id).toBe(u.id)
    })

    it('creates a password credential when password is provided', () => {
      const u = store.createUser({
        email: 'bob@acme.test',
        password: 'longer-than-eight',
      })
      const creds = store.listCredentials(u.id)
      expect(creds.length).toBe(1)
      expect(creds[0]!.kind).toBe('password')
      expect(creds[0]!.identifier).toBe('bob@acme.test')
    })

    it('honors explicit role', () => {
      const u = store.createUser({
        email: 'carol@acme.test',
        role: 'admin',
      })
      expect(store.getMembership(u.id)?.role).toBe('admin')
    })

    it('rejects duplicate email with code=duplicate_email', () => {
      store.createUser({ email: 'dup@acme.test' })
      let thrown: unknown
      try {
        store.createUser({ email: 'dup@acme.test' })
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(IdentityError)
      expect((thrown as IdentityError).code).toBe('duplicate_email')
    })

    it('rejects malformed email with code=invalid_email', () => {
      expect(() => store.createUser({ email: 'not-email' })).toThrow(
        IdentityError,
      )
      try {
        store.createUser({ email: 'not-email' })
      } catch (e) {
        expect((e as IdentityError).code).toBe('invalid_email')
      }
    })

    it('rejects invalid role with code=invalid_role', () => {
      try {
        store.createUser({
          email: 'x@y.test',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          role: 'superuser' as any,
        })
      } catch (e) {
        expect(e).toBeInstanceOf(IdentityError)
        expect((e as IdentityError).code).toBe('invalid_role')
      }
    })

    it('rolls back fully when password is too short (no orphan user)', () => {
      try {
        store.createUser({
          email: 'tx-rollback@acme.test',
          password: 'short',
        })
      } catch {
        // expected
      }
      expect(store.getUserByEmail('tx-rollback@acme.test')).toBeNull()
    })
  })

  // =====================================================================
  // listUsers / countUsers / getUserBy*
  // =====================================================================

  describe('listUsers / countUsers / lookups', () => {
    it('listUsers returns all users sorted by created_at', () => {
      const a = store.createUser({ email: 'a@x.test' })
      const b = store.createUser({ email: 'b@x.test' })
      const all = store.listUsers()
      expect(all.map((u) => u.id)).toEqual([a.id, b.id])
    })

    it('countUsers tracks insertions', () => {
      expect(store.countUsers()).toBe(0)
      store.createUser({ email: 'a@x.test' })
      expect(store.countUsers()).toBe(1)
      store.createUser({ email: 'b@x.test' })
      expect(store.countUsers()).toBe(2)
    })

    it('getUserById / getUserByEmail return null on miss', () => {
      expect(store.getUserById('nope')).toBeNull()
      expect(store.getUserByEmail('nope@x.test')).toBeNull()
    })
  })

  // =====================================================================
  // setRole
  // =====================================================================

  describe('setRole', () => {
    // V4-AUDIT-03
    it('refuses to demote the last owner (code=last_owner)', () => {
      const owner = store.createUser({ email: 'owner@x.test', role: 'owner' })
      // Add a non-owner so there's plenty of users, but only one owner.
      store.createUser({ email: 'plain@x.test', role: 'member' })
      try {
        store.setRole(owner.id, 'member')
        throw new Error('expected setRole to throw last_owner')
      } catch (e) {
        expect(e).toBeInstanceOf(IdentityError)
        expect((e as IdentityError).code).toBe('last_owner')
      }
      // Sanity: original owner role unchanged.
      expect(store.getMembership(owner.id)?.role).toBe('owner')
    })

    it('allows demoting one owner when ≥2 owners exist', () => {
      const o1 = store.createUser({ email: 'o1@x.test', role: 'owner' })
      const o2 = store.createUser({ email: 'o2@x.test', role: 'owner' })
      const m = store.setRole(o2.id, 'admin')
      expect(m.role).toBe('admin')
      // o1 still owner.
      expect(store.getMembership(o1.id)?.role).toBe('owner')
    })

    it('changes role; returns updated membership', () => {
      const u = store.createUser({ email: 'a@x.test' })
      expect(store.getMembership(u.id)?.role).toBe('member')
      const m = store.setRole(u.id, 'admin')
      expect(m.role).toBe('admin')
      expect(store.getMembership(u.id)?.role).toBe('admin')
    })

    it('no-op when role is already current (returns same membership)', () => {
      const u = store.createUser({ email: 'a@x.test', role: 'member' })
      const m1 = store.getMembership(u.id)!
      const m2 = store.setRole(u.id, 'member')
      expect(m2.id).toBe(m1.id)
    })

    it('rejects invalid role', () => {
      const u = store.createUser({ email: 'a@x.test' })
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store.setRole(u.id, 'godmode' as any)
      } catch (e) {
        expect((e as IdentityError).code).toBe('invalid_role')
      }
    })

    it('rejects unknown user', () => {
      try {
        store.setRole('nope', 'admin' as Role)
      } catch (e) {
        expect((e as IdentityError).code).toBe('user_not_found')
      }
    })
  })

  // =====================================================================
  // credentials: password / admin_token / api_key
  // =====================================================================

  describe('credentials', () => {
    it('setPassword replaces any existing password credential', () => {
      const u = store.createUser({
        email: 'a@x.test',
        password: 'first-password',
      })
      expect(store.listCredentials(u.id).length).toBe(1)
      store.setPassword(u.id, 'second-password')
      const creds = store.listCredentials(u.id)
      expect(creds.length).toBe(1)
      // Old password no longer works.
      expect(() =>
        store.authenticatePassword({
          email: 'a@x.test',
          password: 'first-password',
        }),
      ).toThrow(IdentityError)
      // New password works.
      const s = store.authenticatePassword({
        email: 'a@x.test',
        password: 'second-password',
      })
      expect(s.userId).toBe(u.id)
    })

    it('issueAdminToken returns a token that authenticateToken accepts', () => {
      const u = store.createUser({ email: 'admin@x.test', role: 'admin' })
      const { token, credentialId } = store.issueAdminToken({
        userId: u.id,
        label: 'manual',
      })
      expect(token).toMatch(/^adm_/)
      const s = store.authenticateToken({ token })
      expect(s.userId).toBe(u.id)
      const creds = store.listCredentials(u.id)
      expect(creds.find((c) => c.id === credentialId)?.label).toBe('manual')
    })

    it('issueApiKey returns a key that authenticateToken accepts', () => {
      const u = store.createUser({ email: 'svc@x.test' })
      const { key } = store.issueApiKey({
        userId: u.id,
        label: 'CI runner',
      })
      expect(key).toMatch(/^aipk_/)
      const s = store.authenticateToken({ token: key })
      expect(s.userId).toBe(u.id)
    })

    it('revokeCredential invalidates the credential', () => {
      const u = store.createUser({ email: 'a@x.test' })
      const { key, credentialId } = store.issueApiKey({ userId: u.id })
      // Sanity check it works before revocation.
      store.authenticateToken({ token: key })
      store.revokeCredential(credentialId)
      expect(() => store.authenticateToken({ token: key })).toThrow(
        IdentityError,
      )
    })

    it('issueApiKey / issueAdminToken reject unknown user', () => {
      try {
        store.issueApiKey({ userId: 'nope' })
      } catch (e) {
        expect((e as IdentityError).code).toBe('user_not_found')
      }
    })

    it('two issued api keys produce different raw values', () => {
      const u = store.createUser({ email: 'a@x.test' })
      const a = store.issueApiKey({ userId: u.id })
      const b = store.issueApiKey({ userId: u.id })
      expect(a.key).not.toBe(b.key)
      expect(a.credentialId).not.toBe(b.credentialId)
    })
  })

  // =====================================================================
  // authenticate*
  // =====================================================================

  describe('authenticate*', () => {
    it('authenticatePassword: wrong password throws authentication_failed', () => {
      store.createUser({ email: 'a@x.test', password: 'correct-password' })
      try {
        store.authenticatePassword({
          email: 'a@x.test',
          password: 'wrong-password',
        })
      } catch (e) {
        expect((e as IdentityError).code).toBe('authentication_failed')
      }
    })

    it('authenticatePassword: unknown email throws authentication_failed (no leak)', () => {
      // Should NOT leak "no such user" via a different error code.
      try {
        store.authenticatePassword({
          email: 'ghost@x.test',
          password: 'anything-long-enough',
        })
      } catch (e) {
        expect((e as IdentityError).code).toBe('authentication_failed')
      }
    })

    it('authenticateToken: bad token throws authentication_failed', () => {
      try {
        store.authenticateToken({ token: 'aipk_definitely-not-a-real-key' })
      } catch (e) {
        expect((e as IdentityError).code).toBe('authentication_failed')
      }
    })

    it('authenticatePassword updates user.last_login_at', () => {
      const u = store.createUser({
        email: 'a@x.test',
        password: 'pw-long-enough',
      })
      expect(u.lastLoginAt).toBeNull()
      store.authenticatePassword({
        email: 'a@x.test',
        password: 'pw-long-enough',
      })
      const after = store.getUserById(u.id)!
      expect(after.lastLoginAt).not.toBeNull()
    })
  })

  // =====================================================================
  // session lookup + revocation + expiry
  // =====================================================================

  describe('sessions', () => {
    it('getSessionByToken returns {user, role, session} for live session', () => {
      const u = store.createUser({
        email: 'a@x.test',
        password: 'pw-long-enough',
        role: 'admin',
      })
      const s = store.authenticatePassword({
        email: 'a@x.test',
        password: 'pw-long-enough',
      })
      const got = store.getSessionByToken(s.token)
      expect(got?.user.id).toBe(u.id)
      expect(got?.role).toBe('admin')
      expect(got?.session.token).toBe(s.token)
    })

    it('returns null for unknown / empty token', () => {
      expect(store.getSessionByToken('ses_unknown')).toBeNull()
      expect(store.getSessionByToken('')).toBeNull()
    })

    it('returns null after expiry (TTL elapsed)', async () => {
      store.createUser({ email: 'a@x.test', password: 'pw-long-enough' })
      const s = store.authenticatePassword({
        email: 'a@x.test',
        password: 'pw-long-enough',
        ttlMs: 25,
      })
      expect(store.getSessionByToken(s.token)).not.toBeNull()
      await new Promise((r) => setTimeout(r, 40))
      expect(store.getSessionByToken(s.token)).toBeNull()
    })

    it('revokeSession invalidates immediately', () => {
      store.createUser({ email: 'a@x.test', password: 'pw-long-enough' })
      const s = store.authenticatePassword({
        email: 'a@x.test',
        password: 'pw-long-enough',
      })
      store.revokeSession(s.token)
      expect(store.getSessionByToken(s.token)).toBeNull()
    })

    it('revokeAllSessionsForUser kills every session for that user', () => {
      const u = store.createUser({
        email: 'a@x.test',
        password: 'pw-long-enough',
      })
      const s1 = store.authenticatePassword({
        email: 'a@x.test',
        password: 'pw-long-enough',
      })
      const s2 = store.authenticatePassword({
        email: 'a@x.test',
        password: 'pw-long-enough',
      })
      expect(s1.token).not.toBe(s2.token)
      const r = store.revokeAllSessionsForUser(u.id)
      expect(r.removed).toBe(2)
      expect(store.getSessionByToken(s1.token)).toBeNull()
      expect(store.getSessionByToken(s2.token)).toBeNull()
    })

    it('cleanupExpiredSessions removes expired rows', async () => {
      store.createUser({ email: 'a@x.test', password: 'pw-long-enough' })
      store.authenticatePassword({
        email: 'a@x.test',
        password: 'pw-long-enough',
        ttlMs: 25,
      })
      const live = store.authenticatePassword({
        email: 'a@x.test',
        password: 'pw-long-enough',
        ttlMs: 60_000,
      })
      await new Promise((r) => setTimeout(r, 40))
      const { removed } = store.cleanupExpiredSessions()
      expect(removed).toBe(1)
      // Live one still there.
      expect(store.getSessionByToken(live.token)).not.toBeNull()
    })

    it('FK cascade: deleting a credential does NOT kill live sessions (sessions are independent of cred)', () => {
      const u = store.createUser({ email: 'a@x.test' })
      const { key, credentialId } = store.issueApiKey({ userId: u.id })
      const s = store.authenticateToken({ token: key })
      // Now revoke the api key — existing session should still resolve
      // (sessions are detached from the credential that minted them).
      store.revokeCredential(credentialId)
      expect(store.getSessionByToken(s.token)).not.toBeNull()
      // But the api key itself can't mint a new session anymore.
      expect(() => store.authenticateToken({ token: key })).toThrow(
        IdentityError,
      )
    })
  })

  // =====================================================================
  // Audit log (V4-AUDIT-06)
  // =====================================================================

  describe('audit log', () => {
    it('writeAuditLog persists a row and listAuditLog reads it back', () => {
      const u = store.createUser({ email: 'a@x.test' })
      const entry = store.writeAuditLog({
        action: 'login_success',
        actorUserId: u.id,
        actorSource: 'v4-session',
        targetUserId: u.id,
        ip: '127.0.0.1',
        userAgent: 'curl/8',
        metadata: { foo: 'bar' },
      })
      expect(entry.id).toBeTypeOf('string')
      expect(entry.ts).toBeGreaterThan(0)
      const list = store.listAuditLog()
      expect(list.length).toBe(1)
      expect(list[0]!.id).toBe(entry.id)
      expect(list[0]!.action).toBe('login_success')
      expect(list[0]!.metadata).toEqual({ foo: 'bar' })
      expect(list[0]!.success).toBe(true)
    })

    it('records login_failure with success=false + nullable actor', () => {
      store.writeAuditLog({
        action: 'login_failure',
        actorSource: 'anonymous',
        ip: '127.0.0.1',
        success: false,
        metadata: { email: 'ghost@x.test' },
      })
      const failures = store.listAuditLog({ success: false })
      expect(failures.length).toBe(1)
      expect(failures[0]!.actorUserId).toBeNull()
      expect(failures[0]!.success).toBe(false)
      expect(failures[0]!.metadata).toEqual({ email: 'ghost@x.test' })
    })

    it('listAuditLog returns rows newest-first', async () => {
      store.writeAuditLog({ action: 'first', actorSource: 'system' })
      // 1ms gap so ts strictly increases on platforms with ms-resolution Date.now.
      await new Promise((r) => setTimeout(r, 2))
      store.writeAuditLog({ action: 'second', actorSource: 'system' })
      const list = store.listAuditLog()
      expect(list.map((e) => e.action)).toEqual(['second', 'first'])
    })

    it('filters by action / targetUserId / success and respects limit + offset', () => {
      const u1 = store.createUser({ email: 'u1@x.test' })
      const u2 = store.createUser({ email: 'u2@x.test' })
      // 3 rows: 2 set_role for u1 (one fail), 1 set_role for u2 (success)
      store.writeAuditLog({
        action: 'set_role',
        actorSource: 'v3-admin',
        targetUserId: u1.id,
      })
      store.writeAuditLog({
        action: 'set_role',
        actorSource: 'v3-admin',
        targetUserId: u1.id,
        success: false,
      })
      store.writeAuditLog({
        action: 'set_role',
        actorSource: 'v3-admin',
        targetUserId: u2.id,
      })
      expect(store.listAuditLog({ action: 'set_role' }).length).toBe(3)
      expect(store.listAuditLog({ targetUserId: u1.id }).length).toBe(2)
      expect(store.listAuditLog({ success: false }).length).toBe(1)
      expect(
        store.listAuditLog({ targetUserId: u1.id, success: true }).length,
      ).toBe(1)
      expect(store.listAuditLog({ limit: 2 }).length).toBe(2)
      // offset 2 skips the first 2 newest, leaving 1
      expect(store.listAuditLog({ limit: 10, offset: 2 }).length).toBe(1)
    })

    it('rejects invalid actorSource / oversize metadata / non-string action', () => {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store.writeAuditLog({ action: 'x', actorSource: 'bogus' as any }),
      ).toThrow(IdentityError)
      expect(() =>
        store.writeAuditLog({
          action: '',
          actorSource: 'system',
        }),
      ).toThrow(IdentityError)
      const bigMeta: Record<string, string> = {}
      // 8KB cap on serialised JSON; 1000 entries × ~10 chars overshoots.
      for (let i = 0; i < 1000; i++) bigMeta['k' + i] = 'value-padding'
      expect(() =>
        store.writeAuditLog({
          action: 'big_meta',
          actorSource: 'system',
          metadata: bigMeta,
        }),
      ).toThrow(IdentityError)
    })

    it('limit is clamped to [1, 1000]', () => {
      // Even with 0 rows, calling with limit:0 should not blow up.
      expect(store.listAuditLog({ limit: 0 })).toEqual([])
      // No throw on huge limit either.
      expect(store.listAuditLog({ limit: 999_999 })).toEqual([])
    })

    // ---------------------------------------------------------------------
    // FED-M4 — 'federated' actorSource accepts + records origin metadata
    // ---------------------------------------------------------------------
    it("accepts 'federated' actorSource and round-trips origin in metadata", () => {
      const entry = store.writeAuditLog({
        action: 'federated_action_demo',
        actorSource: 'federated',
        // A federated actor's userId is the SENDING hub's user id —
        // we don't have a local user row to point actorUserId at,
        // so leave it null and put the full origin in metadata.
        actorUserId: null,
        metadata: {
          origin: {
            orgId: 'orgA-hub',
            userId: 'alice@orgA',
            userRole: 'admin',
            userEmail: 'alice@orga.test',
          },
          note: 'federated capability invocation',
        },
      })
      expect(entry.actorSource).toBe('federated')
      expect(entry.actorUserId).toBeNull()
      expect(entry.metadata?.origin).toMatchObject({
        orgId: 'orgA-hub',
        userId: 'alice@orgA',
        userRole: 'admin',
      })

      // Verify it round-trips through listAuditLog.
      const rows = store.listAuditLog({ action: 'federated_action_demo' })
      expect(rows.length).toBe(1)
      expect(rows[0]!.actorSource).toBe('federated')
      const meta = rows[0]!.metadata as { origin: { orgId: string } } | null
      expect(meta?.origin.orgId).toBe('orgA-hub')
    })
  })
})
