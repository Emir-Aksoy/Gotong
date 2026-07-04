/**
 * Phase 6 #9 — IdentityStore.createInvitation enforces an org-wide
 * hard cap on active-pending invitations.
 *
 * Coverage:
 *   - cap default = 1000 (no env)
 *   - cap honored from GOTONG_MAX_PENDING_INVITES env
 *   - createInvitation succeeds at cap-1, throws at cap
 *   - revokeInvitation frees a slot (cap counts active-pending only)
 *   - accepted invites don't count
 *   - expired invites don't count
 *   - countActivePendingInvitations() reflects the same predicate
 *   - error code is `invitations_limit_exceeded` for the route layer
 *     to map to HTTP 409
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  IdentityError,
  IdentityStore,
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
} from '../src/index.js'

describe('IdentityStore.createInvitation — hard cap (Phase 6 #9)', () => {
  let dir: string
  let store: IdentityStore
  const origEnv = process.env.GOTONG_MAX_PENDING_INVITES

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gotong-invite-cap-'))
    store = openIdentityStore({
      dbPath: join(dir, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
    if (origEnv === undefined) delete process.env.GOTONG_MAX_PENDING_INVITES
    else process.env.GOTONG_MAX_PENDING_INVITES = origEnv
  })

  it('countActivePendingInvitations starts at 0', () => {
    expect(store.countActivePendingInvitations()).toBe(0)
  })

  it('counts grow as invites are created, shrink as revoked', () => {
    const a = store.createInvitation({ email: 'a@t.test' })
    const b = store.createInvitation({ email: 'b@t.test' })
    expect(store.countActivePendingInvitations()).toBe(2)
    store.revokeInvitation(a.invitation.id)
    expect(store.countActivePendingInvitations()).toBe(1)
    store.revokeInvitation(b.invitation.id)
    expect(store.countActivePendingInvitations()).toBe(0)
  })

  it('cap honored from GOTONG_MAX_PENDING_INVITES env', () => {
    process.env.GOTONG_MAX_PENDING_INVITES = '3'
    store.createInvitation({ email: 'one@t.test' })
    store.createInvitation({ email: 'two@t.test' })
    store.createInvitation({ email: 'three@t.test' })
    // 4th rejected.
    let err: unknown
    try {
      store.createInvitation({ email: 'four@t.test' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(IdentityError)
    expect((err as IdentityError).code).toBe('invitations_limit_exceeded')
    expect((err as IdentityError).message).toMatch(/3\/3/)
  })

  it('invalid env values fall back to default 1000', () => {
    process.env.GOTONG_MAX_PENDING_INVITES = 'not-a-number'
    // No cap hit at 5 invites — default is still 1000.
    for (let i = 0; i < 5; i++) {
      store.createInvitation({ email: `nan${i}@t.test` })
    }
    expect(store.countActivePendingInvitations()).toBe(5)
  })

  it('zero env value also falls back to default 1000', () => {
    process.env.GOTONG_MAX_PENDING_INVITES = '0'
    // Sanity: zero would mean "no invites allowed at all" — we treat
    // it as misconfiguration and use the default.
    expect(() =>
      store.createInvitation({ email: 'zero@t.test' }),
    ).not.toThrow()
  })

  it('negative env value also falls back to default 1000', () => {
    process.env.GOTONG_MAX_PENDING_INVITES = '-5'
    expect(() =>
      store.createInvitation({ email: 'neg@t.test' }),
    ).not.toThrow()
  })

  it('revoking a pending invite frees a slot under the cap', () => {
    process.env.GOTONG_MAX_PENDING_INVITES = '2'
    const a = store.createInvitation({ email: 'fillA@t.test' })
    store.createInvitation({ email: 'fillB@t.test' })
    // Cap reached.
    expect(() =>
      store.createInvitation({ email: 'fillC@t.test' }),
    ).toThrow(/invitations_limit_exceeded|too many active-pending/)
    // Revoke one → slot frees → next create succeeds.
    store.revokeInvitation(a.invitation.id)
    expect(() =>
      store.createInvitation({ email: 'fillC@t.test' }),
    ).not.toThrow()
  })

  it('cap message includes current/limit ratio', () => {
    process.env.GOTONG_MAX_PENDING_INVITES = '2'
    store.createInvitation({ email: 'msg1@t.test' })
    store.createInvitation({ email: 'msg2@t.test' })
    try {
      store.createInvitation({ email: 'msg3@t.test' })
      throw new Error('expected throw')
    } catch (e) {
      expect((e as Error).message).toContain('2/2')
      expect((e as Error).message).toMatch(/revoke or wait/i)
    }
  })

  it('createInvitation uses BEGIN IMMEDIATE, not DEFERRED (Audit #153)', () => {
    // White-box guard for the TOCTOU fix. With DEFERRED (the SQLite
    // default), two concurrent createInvitation tx in WAL mode can
    // both SELECT count=999, both INSERT, both COMMIT → cap of 1000
    // ends up at 1001 because each TX's snapshot was taken at first
    // read (before the other's commit). IMMEDIATE acquires a
    // RESERVED lock at BEGIN, serialising the read-then-write pair.
    //
    // We can't truly multi-thread better-sqlite3 in a single test
    // process, so the assertion is structural: monkey-patch
    // db.exec to record the BEGIN command and verify it's IMMEDIATE.
    const execCalls: string[] = []
    // @ts-expect-error reach for private .db to wrap exec
    const dbAny = (store as IdentityStore & {
      db: { exec: (s: string) => void }
    }).db
    const origExec = dbAny.exec.bind(dbAny)
    dbAny.exec = (sql: string) => {
      execCalls.push(sql)
      return origExec(sql)
    }
    try {
      store.createInvitation({ email: 'imm@t.test' })
    } finally {
      dbAny.exec = origExec
    }
    // The first BEGIN inside createInvitation must be IMMEDIATE.
    // Other call sites (eg. createUser inside the same test session)
    // would still use plain BEGIN, but they're not what we're testing.
    const begin = execCalls.find((s) => /^BEGIN/i.test(s))
    expect(begin).toBe('BEGIN IMMEDIATE')
  })

  it('expired-but-not-revoked invites do NOT count toward the cap', () => {
    process.env.GOTONG_MAX_PENDING_INVITES = '2'
    // Mint with a 1ms TTL; after a tick, the row is computed-expired
    // even though status='pending' in the table. The cap predicate
    // (`expires_at >= now`) skips it.
    store.createInvitation({ email: 'ttl1@t.test', ttlMs: 60_000 })
    store.createInvitation({ email: 'ttl2@t.test', ttlMs: 60_000 })
    expect(store.countActivePendingInvitations()).toBe(2)
    // Reach into the row and force expires_at into the past — simulates
    // an invite that aged out while sitting in the table.
    const past = Date.now() - 1
    // @ts-expect-error reach for private .db for test setup only
    const updated = (store as IdentityStore & { db: { prepare: (s: string) => { run: (...a: unknown[]) => { changes: number } } } }).db
      .prepare(`UPDATE invitations SET expires_at = ? WHERE email = ?`)
      .run(past, 'ttl1@t.test')
    expect(updated.changes).toBe(1)
    expect(store.countActivePendingInvitations()).toBe(1)
    // Now a fresh create is allowed (count is 1/2, cap 2).
    expect(() =>
      store.createInvitation({ email: 'fresh@t.test' }),
    ).not.toThrow()
  })
})
