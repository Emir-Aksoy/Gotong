/**
 * Phase 12 M1 — IM bindings + binding-code CRUD coverage.
 *
 * Coverage:
 *   - issueImBindingCode: mint default 6-digit / explicit code path /
 *     ttl clamp / rotate-on-reissue / unknown user rejected /
 *     explicit code collision rejected
 *   - claimImBindingCode: happy-path → returns userId + binding row;
 *     invalid code → 'im_binding_code_invalid'; expired code dropped
 *     from codes table + 'im_binding_code_expired'; re-bind same
 *     (platform, platformUserId) overwrites prior user_id
 *   - getUserIdByImBinding / getImBinding: present + absent
 *   - listImBindings: unfiltered + by-platform
 *   - removeImBinding: 1 on hit / 0 on miss / empty arg guards
 *   - sweepExpiredImBindingCodes: deletes expired only / non-finite
 *     `now` guard
 *
 * All tests use `:memory:` SQLite, no disk side effects.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IdentityError, IdentityStore, openIdentityStore } from '../src/index.js'

describe('IdentityStore — IM bindings (Phase 12 M1)', () => {
  let store: IdentityStore
  let userId: string
  let otherUserId: string

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:' })
    const u = store.createUser({ email: 'alice@local', displayName: 'Alice' })
    userId = u.id
    const v = store.createUser({ email: 'bob@local', displayName: 'Bob' })
    otherUserId = v.id
  })

  afterEach(() => {
    store.close()
  })

  // --- issueImBindingCode ---------------------------------------------------

  describe('issueImBindingCode', () => {
    it('mints a default 6-digit code with ~10min TTL', () => {
      const code = store.issueImBindingCode({ userId })
      expect(code.code).toMatch(/^\d{6}$/)
      expect(code.userId).toBe(userId)
      const ttl = code.expiresAt - code.createdAt
      // TTL exactly 10 min when not overridden.
      expect(ttl).toBe(10 * 60_000)
    })

    it('clamps ttlMs to [60_000, 3_600_000]', () => {
      const tooShort = store.issueImBindingCode({ userId, ttlMs: 1 })
      expect(tooShort.expiresAt - tooShort.createdAt).toBe(60_000)
      // Rotate-on-reissue means we need a fresh user for the upper-bound check,
      // since otherwise the prior code's row gets deleted under us. (Same
      // user is fine because we read the returned row, but make it explicit.)
      const tooLong = store.issueImBindingCode({
        userId: otherUserId,
        ttlMs: 999_999_999,
      })
      expect(tooLong.expiresAt - tooLong.createdAt).toBe(3_600_000)
    })

    it('accepts an explicit code (4-32 chars [A-Za-z0-9])', () => {
      const code = store.issueImBindingCode({ userId, code: 'ABC123xyz' })
      expect(code.code).toBe('ABC123xyz')
    })

    it.each([
      'AB', // too short
      'AB!', // bad char
      'a'.repeat(33), // too long
      '', // empty
    ])('rejects malformed explicit code: %s', (bad) => {
      expect(() => store.issueImBindingCode({ userId, code: bad })).toThrow(
        IdentityError,
      )
    })

    it('rotates: re-issuing for the same user deletes the prior code', () => {
      const first = store.issueImBindingCode({ userId, code: 'FIRST1' })
      const second = store.issueImBindingCode({ userId, code: 'SECND2' })
      expect(second.code).toBe('SECND2')
      // First code is no longer claimable — should be invalid, not expired.
      expect(() =>
        store.claimImBindingCode({
          code: first.code,
          platform: 'telegram',
          platformUserId: 'tg-1',
        }),
      ).toThrow(/code does not exist/)
    })

    it('rejects when userId does not exist', () => {
      expect(() => store.issueImBindingCode({ userId: 'ghost' })).toThrow(
        /user ghost not found/,
      )
    })

    it('rejects an explicit code that collides with another user', () => {
      store.issueImBindingCode({ userId, code: 'SHARED' })
      // Same explicit code, different user — UNIQUE on PK fires.
      expect(() =>
        store.issueImBindingCode({ userId: otherUserId, code: 'SHARED' }),
      ).toThrow(/conflict/)
    })

    it('rejects ttlMs that is not a finite number', () => {
      expect(() =>
        store.issueImBindingCode({ userId, ttlMs: Number.NaN }),
      ).toThrow(/must be a finite number/)
    })

    it('rejects empty userId', () => {
      expect(() => store.issueImBindingCode({ userId: '' })).toThrow(/required/)
    })
  })

  // --- claimImBindingCode --------------------------------------------------

  describe('claimImBindingCode', () => {
    it('happy path: returns userId + binding row + deletes the code', () => {
      const issued = store.issueImBindingCode({ userId, code: 'CODE01' })
      const r = store.claimImBindingCode({
        code: issued.code,
        platform: 'telegram',
        platformUserId: 'tg-42',
        displayName: 'Alice on TG',
      })
      expect(r.userId).toBe(userId)
      expect(r.binding.platform).toBe('telegram')
      expect(r.binding.platformUserId).toBe('tg-42')
      expect(r.binding.userId).toBe(userId)
      expect(r.binding.displayName).toBe('Alice on TG')
      // Code is consumed: re-claim → 'invalid' not 'expired'.
      expect(() =>
        store.claimImBindingCode({
          code: issued.code,
          platform: 'telegram',
          platformUserId: 'tg-43',
        }),
      ).toThrow(/code does not exist/)
    })

    it('throws im_binding_code_invalid when code unknown', () => {
      try {
        store.claimImBindingCode({
          code: 'NOPE00',
          platform: 'telegram',
          platformUserId: 'tg-1',
        })
        throw new Error('should not reach')
      } catch (err) {
        expect(err).toBeInstanceOf(IdentityError)
        expect((err as IdentityError).code).toBe('im_binding_code_invalid')
      }
    })

    it('throws im_binding_code_expired (row lingers; sweep / reissue cleans)', () => {
      // Drive expiry deterministically by tweaking `expires_at` via
      // the test back-door on the db handle. The public API doesn't
      // expose now-injection on `claim`.
      const issued = store.issueImBindingCode({ userId, code: 'EXPIRE' })
      const db = (store as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } }
      }).db
      db.prepare('UPDATE im_binding_codes SET expires_at = 1 WHERE code = ?').run(
        issued.code,
      )
      try {
        store.claimImBindingCode({
          code: issued.code,
          platform: 'telegram',
          platformUserId: 'tg-1',
        })
        throw new Error('should not reach')
      } catch (err) {
        expect(err).toBeInstanceOf(IdentityError)
        expect((err as IdentityError).code).toBe('im_binding_code_expired')
      }
      // Re-claim of the same expired code: still 'expired' (row isn't
      // auto-deleted — see impl comment). Sweep / next reissue cleans.
      try {
        store.claimImBindingCode({
          code: issued.code,
          platform: 'telegram',
          platformUserId: 'tg-1',
        })
        throw new Error('should not reach')
      } catch (err) {
        expect((err as IdentityError).code).toBe('im_binding_code_expired')
      }
      // Sweep removes it; now we see 'invalid'.
      store.sweepExpiredImBindingCodes(Date.now())
      try {
        store.claimImBindingCode({
          code: issued.code,
          platform: 'telegram',
          platformUserId: 'tg-1',
        })
        throw new Error('should not reach')
      } catch (err) {
        expect((err as IdentityError).code).toBe('im_binding_code_invalid')
      }
    })

    it('re-bind: same (platform, platformUserId) overwrites prior user_id', () => {
      const c1 = store.issueImBindingCode({ userId, code: 'BIND01' })
      store.claimImBindingCode({
        code: c1.code,
        platform: 'telegram',
        platformUserId: 'tg-shared',
      })
      const c2 = store.issueImBindingCode({ userId: otherUserId, code: 'BIND02' })
      const r = store.claimImBindingCode({
        code: c2.code,
        platform: 'telegram',
        platformUserId: 'tg-shared',
      })
      expect(r.userId).toBe(otherUserId)
      // Forward resolve picks the new owner.
      expect(store.getUserIdByImBinding('telegram', 'tg-shared')).toBe(otherUserId)
    })

    it.each([
      [{ code: '', platform: 'telegram', platformUserId: 'x' }, /code is required/],
      [{ code: 'X', platform: '', platformUserId: 'x' }, /platform is required/],
      [{ code: 'X', platform: 'tg', platformUserId: '' }, /platformUserId is required/],
    ])('rejects malformed input %#', (bad, re) => {
      expect(() => store.claimImBindingCode(bad as any)).toThrow(re)
    })

    it('rejects non-string displayName', () => {
      const c = store.issueImBindingCode({ userId, code: 'DSNULL' })
      expect(() =>
        store.claimImBindingCode({
          code: c.code,
          platform: 'telegram',
          platformUserId: 'x',
          displayName: 123 as any,
        }),
      ).toThrow(/displayName must be string or null/)
    })
  })

  // --- getUserIdByImBinding / getImBinding ---------------------------------

  describe('getUserIdByImBinding / getImBinding', () => {
    beforeEach(() => {
      const c = store.issueImBindingCode({ userId, code: 'GET001' })
      store.claimImBindingCode({
        code: c.code,
        platform: 'telegram',
        platformUserId: 'tg-1',
        displayName: 'Alice',
      })
    })

    it('returns userId for a present binding', () => {
      expect(store.getUserIdByImBinding('telegram', 'tg-1')).toBe(userId)
    })

    it('returns null for unbound IM user', () => {
      expect(store.getUserIdByImBinding('telegram', 'tg-999')).toBeNull()
    })

    it('returns full binding row via getImBinding', () => {
      const b = store.getImBinding('telegram', 'tg-1')
      expect(b).not.toBeNull()
      expect(b!.userId).toBe(userId)
      expect(b!.displayName).toBe('Alice')
      expect(b!.createdAt).toBeTypeOf('number')
    })

    it('returns null for empty / non-string args', () => {
      expect(store.getUserIdByImBinding('', 'x')).toBeNull()
      expect(store.getUserIdByImBinding('telegram', '')).toBeNull()
      expect(store.getImBinding('', 'x')).toBeNull()
    })
  })

  // --- listImBindings -------------------------------------------------------

  describe('listImBindings', () => {
    beforeEach(() => {
      const c1 = store.issueImBindingCode({ userId, code: 'TG001' })
      store.claimImBindingCode({
        code: c1.code,
        platform: 'telegram',
        platformUserId: 'tg-a',
      })
      const c2 = store.issueImBindingCode({ userId, code: 'SLA001' })
      store.claimImBindingCode({
        code: c2.code,
        platform: 'slack',
        platformUserId: 'sl-a',
      })
    })

    it('lists all bindings for a user across platforms', () => {
      const bs = store.listImBindings(userId)
      expect(bs.length).toBe(2)
      const platforms = bs.map((b) => b.platform).sort()
      expect(platforms).toEqual(['slack', 'telegram'])
    })

    it('filters by platform', () => {
      const bs = store.listImBindings(userId, { platform: 'telegram' })
      expect(bs.length).toBe(1)
      expect(bs[0]!.platform).toBe('telegram')
    })

    it('returns [] for unknown user / empty userId', () => {
      expect(store.listImBindings('ghost')).toEqual([])
      expect(store.listImBindings('')).toEqual([])
    })
  })

  // --- removeImBinding ------------------------------------------------------

  describe('removeImBinding', () => {
    it('returns 1 on hit and unbinds', () => {
      const c = store.issueImBindingCode({ userId, code: 'RM0001' })
      store.claimImBindingCode({
        code: c.code,
        platform: 'telegram',
        platformUserId: 'tg-rm',
      })
      expect(store.removeImBinding('telegram', 'tg-rm')).toBe(1)
      expect(store.getUserIdByImBinding('telegram', 'tg-rm')).toBeNull()
    })

    it('returns 0 on miss', () => {
      expect(store.removeImBinding('telegram', 'ghost')).toBe(0)
    })

    it('rejects empty args', () => {
      expect(() => store.removeImBinding('', 'x')).toThrow(/platform is required/)
      expect(() => store.removeImBinding('tg', '')).toThrow(
        /platformUserId is required/,
      )
    })
  })

  // --- sweepExpiredImBindingCodes ------------------------------------------

  describe('sweepExpiredImBindingCodes', () => {
    it('deletes expired rows and leaves fresh ones', () => {
      const fresh = store.issueImBindingCode({ userId, code: 'FRESH1' })
      const stale = store.issueImBindingCode({
        userId: otherUserId,
        code: 'STALE1',
      })
      const db = (store as unknown as {
        db: { prepare: (s: string) => { run: (...a: unknown[]) => void } }
      }).db
      db.prepare('UPDATE im_binding_codes SET expires_at = 1 WHERE code = ?').run(
        stale.code,
      )

      const removed = store.sweepExpiredImBindingCodes(Date.now())
      expect(removed).toBe(1)
      // Fresh code still claimable; stale is gone.
      const ok = store.claimImBindingCode({
        code: fresh.code,
        platform: 'telegram',
        platformUserId: 'tg-fresh',
      })
      expect(ok.userId).toBe(userId)
      expect(() =>
        store.claimImBindingCode({
          code: stale.code,
          platform: 'telegram',
          platformUserId: 'tg-stale',
        }),
      ).toThrow(/code does not exist/)
    })

    it('rejects non-finite now', () => {
      expect(() => store.sweepExpiredImBindingCodes(Number.NaN)).toThrow(
        /invalid now/,
      )
    })

    it('returns 0 when nothing expired', () => {
      store.issueImBindingCode({ userId, code: 'KEEP01' })
      expect(store.sweepExpiredImBindingCodes(Date.now())).toBe(0)
    })
  })

  // --- ON DELETE CASCADE — schema invariant ---------------------------------

  it('deleting a user row cascades to im_bindings + im_binding_codes', () => {
    // Identity doesn't expose a public deleteUser API yet, but FK
    // cascade is a schema contract we want to lock in. Drive it
    // directly with the FK-pragma-on connection.
    const c = store.issueImBindingCode({ userId, code: 'CSC001' })
    store.claimImBindingCode({
      code: c.code,
      platform: 'telegram',
      platformUserId: 'tg-cs',
    })
    // Pending code on the OTHER user to confirm we don't cascade too far.
    store.issueImBindingCode({ userId: otherUserId, code: 'PEND01' })

    const db = (store as unknown as {
      db: { prepare: (s: string) => { run: (...a: unknown[]) => void } }
    }).db
    db.prepare('DELETE FROM users WHERE id = ?').run(userId)

    expect(store.getUserIdByImBinding('telegram', 'tg-cs')).toBeNull()
    expect(store.listImBindings(userId)).toEqual([])
    // otherUser's pending code is untouched: PEND01 still claimable.
    const r = store.claimImBindingCode({
      code: 'PEND01',
      platform: 'telegram',
      platformUserId: 'tg-other',
    })
    expect(r.userId).toBe(otherUserId)
  })
})
