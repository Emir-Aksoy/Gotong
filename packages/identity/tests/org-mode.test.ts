/**
 * Phase 7 M4 — org_mode + auto-promote
 *
 * Coverage:
 *   - org_meta kv (get / set, missing key, type validation)
 *   - getOrgMode auto-detect (single-user → personal, multi → team)
 *   - explicit setOrgMode pin (overrides auto)
 *   - createInvitation auto-flips personal → team
 *   - createUser auto-flips when user count > 1
 *   - acceptInvitation re-affirms team (in case mode was hand-pinned back)
 *   - bootstrap sets initial 'personal'
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  IdentityStore,
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
} from '../src/index.js'

describe('IdentityStore.org_meta + org_mode (Phase 7 M4)', () => {
  let dir: string
  let store: IdentityStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipehub-org-mode-'))
    store = openIdentityStore({
      dbPath: join(dir, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('org_meta kv', () => {
    it('missing key returns null', () => {
      expect(store.getOrgMeta('nope')).toBeNull()
    })

    it('set + get roundtrips', () => {
      store.setOrgMeta('brand_name', 'Acme Hub')
      expect(store.getOrgMeta('brand_name')).toBe('Acme Hub')
    })

    it('set overwrites existing value', () => {
      store.setOrgMeta('k', 'v1')
      store.setOrgMeta('k', 'v2')
      expect(store.getOrgMeta('k')).toBe('v2')
    })

    it('empty key rejected (both get and set)', () => {
      expect(() => store.getOrgMeta('')).toThrow(/non-empty string/)
      expect(() => store.setOrgMeta('', 'x')).toThrow(/non-empty string/)
    })

    it('non-string value rejected', () => {
      expect(() =>
        // @ts-expect-error intentional bad input
        store.setOrgMeta('k', 42),
      ).toThrow(/must be a string/)
    })
  })

  describe('getOrgMode — auto-detect + explicit pin', () => {
    it('empty db (0 users) → personal (single-user heuristic)', () => {
      // Pre-bootstrap state. countUsers===0 ≤ 1 → personal.
      expect(store.getOrgMode()).toBe('personal')
    })

    it('bootstrap (1 user) defaults to personal', () => {
      const r = store.bootstrap({ ownerEmail: 'me@local' })
      expect(r.bootstrapped).toBe(true)
      expect(store.getOrgMode()).toBe('personal')
      // And the explicit row in org_meta confirms it (not just auto-detect).
      expect(store.getOrgMeta('org_mode')).toBe('personal')
    })

    it('setOrgMode pins value, getOrgMode honours it', () => {
      store.bootstrap({ ownerEmail: 'a@local' })
      store.setOrgMode('team')
      expect(store.getOrgMode()).toBe('team')
    })

    it('setOrgMode rejects invalid values', () => {
      expect(() =>
        // @ts-expect-error intentional bad input
        store.setOrgMode('teamish'),
      ).toThrow(/personal/)
    })
  })

  describe('auto-promote personal → team', () => {
    it('createInvitation flips personal → team (operator intent)', () => {
      store.bootstrap({ ownerEmail: 'owner@team.test' })
      expect(store.getOrgMode()).toBe('personal')
      store.createInvitation({ email: 'invitee@team.test' })
      expect(store.getOrgMode()).toBe('team')
    })

    it('createUser flips when user count > 1', () => {
      store.bootstrap({ ownerEmail: 'owner@team.test' })
      expect(store.getOrgMode()).toBe('personal')
      // First createUser brings count to 2 → flip.
      store.createUser({ email: 'second@team.test', password: 'pw-long-enough' })
      expect(store.getOrgMode()).toBe('team')
    })

    it('createUser does NOT flip when it brings count to exactly 1 (no bootstrap)', () => {
      // Skip bootstrap: countUsers starts at 0; createUser brings to 1.
      // This is the "first user via createUser instead of bootstrap" path.
      // Mode should stay personal (single user).
      store.createUser({ email: 'solo@team.test', password: 'pw-long-enough' })
      expect(store.getOrgMode()).toBe('personal')
    })

    it('acceptInvitation re-affirms team if mode was hand-pinned back', () => {
      store.bootstrap({ ownerEmail: 'owner@team.test' })
      const minted = store.createInvitation({ email: 'invitee@team.test' })
      expect(store.getOrgMode()).toBe('team') // flipped by createInvitation
      // Hand-pin back to personal (operator confused, or this is a test).
      store.setOrgMode('personal')
      expect(store.getOrgMode()).toBe('personal')
      // Now accept the invite — user count goes to 2 → re-flip to team.
      store.acceptInvitation({
        token: minted.token,
        password: 'pw-long-enough',
      })
      expect(store.getOrgMode()).toBe('team')
    })

    it('already-team stays team (idempotent flip)', () => {
      store.bootstrap({ ownerEmail: 'a@team.test' })
      store.setOrgMode('team')
      const before = store.getOrgMeta('org_mode')
      store.createInvitation({ email: 'b@team.test' })
      expect(store.getOrgMeta('org_mode')).toBe(before) // still 'team'
      expect(store.getOrgMode()).toBe('team')
    })
  })
})
