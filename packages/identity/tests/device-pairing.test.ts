/**
 * SHELL-M1 — device pairing codes + expiring device credentials.
 *
 * The load-bearing tests here are the ones about the security boundary,
 * because `claimDevicePairingCode` is reached from a PUBLIC endpoint:
 *   - the minted key really expires (authenticateToken refuses it)
 *   - a code is single-shot even under a claim race
 *   - reissuing kills the previous code
 *   - an attacker-supplied device label can't produce a nameless row
 *   - every pre-existing credential still has NULL expiry (byte-identical
 *     behaviour for the seven call sites that don't pass one)
 *
 * All tests use `:memory:` SQLite, no disk side effects.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IdentityError, IdentityStore, openIdentityStore } from '../src/index.js'

describe('IdentityStore — device pairing (SHELL-M1)', () => {
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

  // ---- issue ----

  it('mints a 16-char Crockford code with a grouped display form', () => {
    const issued = store.issueDevicePairingCode({ userId })
    expect(issued.code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/)
    expect(issued.display).toBe(
      `${issued.code.slice(0, 4)}-${issued.code.slice(4, 8)}-` +
        `${issued.code.slice(8, 12)}-${issued.code.slice(12, 16)}`,
    )
    expect(issued.userId).toBe(userId)
    expect(issued.expiresAt).toBeGreaterThan(issued.createdAt)
  })

  it('never mints the ambiguous letters I, L, O, U', () => {
    // 40 draws × 16 chars is plenty to catch an alphabet regression.
    for (let i = 0; i < 40; i++) {
      const { code } = store.issueDevicePairingCode({ userId })
      expect(code).not.toMatch(/[ILOU]/)
    }
  })

  it('clamps ttl to [1min, 1h] and defaults to 10min', () => {
    const now = Date.now()
    const dflt = store.issueDevicePairingCode({ userId })
    expect(dflt.expiresAt - dflt.createdAt).toBe(10 * 60_000)

    const tooShort = store.issueDevicePairingCode({ userId, ttlMs: 1 })
    expect(tooShort.expiresAt - tooShort.createdAt).toBe(60_000)

    const tooLong = store.issueDevicePairingCode({ userId, ttlMs: 99 * 3_600_000 })
    expect(tooLong.expiresAt - tooLong.createdAt).toBe(3_600_000)
    expect(tooLong.createdAt).toBeGreaterThanOrEqual(now)
  })

  it('rotates on reissue — the previous code stops working', () => {
    const first = store.issueDevicePairingCode({ userId })
    const second = store.issueDevicePairingCode({ userId })
    expect(second.code).not.toBe(first.code)

    expect(() => store.claimDevicePairingCode({ code: first.code })).toThrow(
      IdentityError,
    )
    // The fresh one still works.
    expect(store.claimDevicePairingCode({ code: second.code }).userId).toBe(userId)
  })

  it('does NOT disturb a pending IM binding code (separate tables)', () => {
    const im = store.issueImBindingCode({ userId })
    store.issueDevicePairingCode({ userId })
    // The IM code must still be claimable — the whole reason for a
    // second table rather than reusing im_binding_codes.
    const claimed = store.claimImBindingCode({
      code: im.code,
      platform: 'telegram',
      platformUserId: 'tg-1',
    })
    expect(claimed.userId).toBe(userId)
  })

  it('rejects an unknown user and a non-finite ttl', () => {
    expect(() => store.issueDevicePairingCode({ userId: 'nope' })).toThrow(
      /user nope not found/,
    )
    expect(() =>
      store.issueDevicePairingCode({ userId, ttlMs: Number.NaN }),
    ).toThrow(/finite/)
  })

  it('accepts an explicit code only when it normalises', () => {
    const ok = store.issueDevicePairingCode({
      userId,
      code: 'abcd-efgh-jkmn-pqrs',
    })
    expect(ok.code).toBe('ABCDEFGHJKMNPQRS')
    expect(() =>
      store.issueDevicePairingCode({ userId, code: 'TOO-SHORT' }),
    ).toThrow(/not a valid pairing code/)
  })

  it('refuses an explicit code already held by another user', () => {
    store.issueDevicePairingCode({ userId, code: 'ABCDEFGHJKMNPQRS' })
    expect(() =>
      store.issueDevicePairingCode({
        userId: otherUserId,
        code: 'ABCDEFGHJKMNPQRS',
      }),
    ).toThrow(/conflict/)
  })

  // ---- claim ----

  it('trades a code for an aipk_ key bound to the issuing user', () => {
    const issued = store.issueDevicePairingCode({ userId })
    const device = store.claimDevicePairingCode({
      code: issued.code,
      deviceLabel: "Alice's iPhone",
    })
    expect(device.key).toMatch(/^aipk_/)
    expect(device.userId).toBe(userId)

    // The key authenticates as that user, through the normal path.
    const session = store.authenticateToken({ token: device.key })
    expect(session.userId).toBe(userId)

    const cred = store
      .listCredentials(userId)
      .find((c) => c.id === device.credentialId)
    expect(cred?.label).toBe("Alice's iPhone")
    expect(cred?.expiresAt).toBe(device.expiresAt)
  })

  it('normalises what the member typed — case, I/L/O, and grouping', () => {
    const issued = store.issueDevicePairingCode({
      userId,
      code: '0123456789ABCDEF',
    })
    // Type it back with the classic confusions and lowercase.
    const device = store.claimDevicePairingCode({ code: 'o123-456789-abcdef' })
    expect(device.userId).toBe(userId)
    expect(issued.code).toBe('0123456789ABCDEF')
  })

  it('is single-shot — the second claim of one code fails', () => {
    const issued = store.issueDevicePairingCode({ userId })
    store.claimDevicePairingCode({ code: issued.code })
    try {
      store.claimDevicePairingCode({ code: issued.code })
      throw new Error('expected the second claim to fail')
    } catch (err) {
      expect((err as IdentityError).code).toBe('device_pairing_code_invalid')
    }
  })

  it('refuses an expired code with a distinguishable error', () => {
    // Mint at the shortest allowed ttl, then move the row into the past.
    const issued = store.issueDevicePairingCode({ userId, ttlMs: 60_000 })
    ;(store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
      .prepare('UPDATE device_pairing_codes SET expires_at = ? WHERE code = ?')
      .run(Date.now() - 1, issued.code)

    try {
      store.claimDevicePairingCode({ code: issued.code })
      throw new Error('expected expiry to be refused')
    } catch (err) {
      expect((err as IdentityError).code).toBe('device_pairing_code_expired')
    }
    // Row survives the rollback — swept later, never silently consumed.
    expect(store.sweepExpiredDevicePairingCodes()).toBe(1)
  })

  it('refuses a well-formed code that was never issued', () => {
    try {
      store.claimDevicePairingCode({ code: '0000000000000000' })
      throw new Error('expected an unknown code to be refused')
    } catch (err) {
      expect((err as IdentityError).code).toBe('device_pairing_code_invalid')
    }
  })

  it('refuses a code that is not a pairing-code shape at all', () => {
    for (const bad of ['', 'hello', '0123456789ABCDEFG', 'ABCD!EFG']) {
      try {
        store.claimDevicePairingCode({ code: bad })
        throw new Error(`expected ${JSON.stringify(bad)} to be refused`)
      } catch (err) {
        expect((err as IdentityError).code).toBe('invalid_input')
      }
    }
  })

  it('never stores a nameless or oversized device label', () => {
    const blank = store.issueDevicePairingCode({ userId })
    const d1 = store.claimDevicePairingCode({
      code: blank.code,
      deviceLabel: '   ',
    })
    expect(
      store.listCredentials(userId).find((c) => c.id === d1.credentialId)?.label,
    ).toBe('Paired device')

    const long = store.issueDevicePairingCode({ userId })
    const d2 = store.claimDevicePairingCode({
      code: long.code,
      deviceLabel: 'x'.repeat(500),
    })
    expect(
      store.listCredentials(userId).find((c) => c.id === d2.credentialId)?.label
        ?.length,
    ).toBe(64)
  })

  it('clamps key ttl to [1h, 365d] and defaults to 90 days', () => {
    const mint = (keyTtlMs?: number): number => {
      const issued = store.issueDevicePairingCode({ userId })
      const before = Date.now()
      const device = store.claimDevicePairingCode({ code: issued.code, keyTtlMs })
      return device.expiresAt - before
    }
    // Allow a couple ms of clock drift between our `before` and the store's.
    expect(mint()).toBeGreaterThan(90 * 24 * 3_600_000 - 1_000)
    expect(mint()).toBeLessThanOrEqual(90 * 24 * 3_600_000)
    expect(mint(1)).toBeGreaterThan(3_600_000 - 1_000)
    expect(mint(9_999 * 24 * 3_600_000)).toBeLessThanOrEqual(365 * 24 * 3_600_000)
  })

  // ---- expiry is actually enforced ----

  it('refuses an expired device key at authentication time', () => {
    const issued = store.issueDevicePairingCode({ userId })
    const device = store.claimDevicePairingCode({ code: issued.code })
    // Works now.
    expect(store.authenticateToken({ token: device.key }).userId).toBe(userId)

    // Push the credential's expiry into the past.
    ;(store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
      .prepare('UPDATE credentials SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, device.credentialId)

    try {
      store.authenticateToken({ token: device.key })
      throw new Error('expected the expired key to be refused')
    } catch (err) {
      expect((err as IdentityError).code).toBe('authentication_failed')
    }
    // The row stays so the member can see and revoke it — unlike a code.
    expect(
      store.listCredentials(userId).some((c) => c.id === device.credentialId),
    ).toBe(true)
  })

  it('leaves every ordinary credential with a null expiry', () => {
    // The seven pre-existing insert sites must be byte-identical: an
    // owner-issued API key or admin token still never expires.
    const apiKey = store.issueApiKey({ userId, label: 'ci' })
    const adminToken = store.issueAdminToken({ userId })
    const creds = store.listCredentials(userId)
    expect(creds.find((c) => c.id === apiKey.credentialId)?.expiresAt).toBeNull()
    expect(
      creds.find((c) => c.id === adminToken.credentialId)?.expiresAt,
    ).toBeNull()
    // And they still authenticate.
    expect(store.authenticateToken({ token: apiKey.key }).userId).toBe(userId)
    expect(store.authenticateToken({ token: adminToken.token }).userId).toBe(userId)
  })

  it('revokes a device like any other credential', () => {
    const issued = store.issueDevicePairingCode({ userId })
    const device = store.claimDevicePairingCode({ code: issued.code })
    store.revokeCredential(device.credentialId)
    expect(() => store.authenticateToken({ token: device.key })).toThrow(IdentityError)
  })

  // ---- sweep ----

  it('sweeps only expired codes and guards a non-finite now', () => {
    const live = store.issueDevicePairingCode({ userId })
    const stale = store.issueDevicePairingCode({ userId: otherUserId })
    ;(store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
      .prepare('UPDATE device_pairing_codes SET expires_at = ? WHERE code = ?')
      .run(Date.now() - 1, stale.code)

    expect(store.sweepExpiredDevicePairingCodes()).toBe(1)
    expect(store.claimDevicePairingCode({ code: live.code }).userId).toBe(userId)
    expect(() => store.sweepExpiredDevicePairingCodes(Number.NaN)).toThrow(
      /invalid now/,
    )
  })
})
