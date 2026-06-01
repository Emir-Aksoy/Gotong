/**
 * D1 — peer registry store tests.
 *
 * Coverage:
 *   addPeer:
 *     - happy path: row + vault entry created in one txn; token decrypts
 *     - UNIQUE on peer_id → peer_id_taken
 *     - input validation: empty peerId / endpointUrl / peerToken
 *     - listVaultEntries shows the kind='peer_token' / ownerKind='peer' row
 *
 *   getPeer / getPeerByPeerId / listPeers:
 *     - retrieval shapes; enabledOnly filter; null when missing
 *
 *   updatePeer:
 *     - label-only update keeps token + endpoint untouched
 *     - enabled toggle round-trip
 *     - endpointUrl update (load-balancer cutover)
 *     - peerToken rotation: old vault entry revoked, new one created,
 *       getPeerToken returns the fresh value
 *     - peer_not_found when id is unknown
 *
 *   removePeer:
 *     - returns true when row existed, vault entry revoked
 *     - returns false when id is unknown
 *     - frees the peerId for re-registration
 *
 *   getPeerToken:
 *     - decrypts the stored secret
 *     - peer_not_found
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  IdentityError,
  IdentityStore,
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
} from '../src/index.js'
import { openDb } from '../src/db.js'

describe('IdentityStore — peers (D1)', () => {
  let store: IdentityStore
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'aipe-id-peers-'))
    store = openIdentityStore({
      dbPath: join(tmp, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
  })
  afterEach(async () => {
    store.close()
    await rm(tmp, { recursive: true, force: true })
  })

  // ---------- addPeer ----------

  describe('addPeer', () => {
    it('creates the row and vault entry in one transaction', () => {
      const p = store.addPeer({
        peerId: 'hub_acme',
        endpointUrl: 'wss://acme.example/aipe',
        label: 'Acme org',
        peerToken: 'shared-secret-128-bit-token',
      })
      expect(p.peerId).toBe('hub_acme')
      expect(p.endpointUrl).toBe('wss://acme.example/aipe')
      expect(p.label).toBe('Acme org')
      expect(p.enabled).toBe(true)
      expect(p.vaultEntryId).toMatch(/.+/)
      expect(p.createdAt).toBeGreaterThan(0)
      // The vault entry is real + decrypts to the supplied token.
      expect(store.getPeerToken(p.id)).toBe('shared-secret-128-bit-token')
      // And it's surfaced via the standard vault listing API under
      // kind='peer_token' / ownerKind='peer'.
      const vaultRows = store.listVaultEntries({
        kind: 'peer_token',
        ownerKind: 'peer',
      })
      expect(vaultRows.length).toBe(1)
      expect(vaultRows[0]?.ownerId).toBe('hub_acme')
    })

    it('null label is allowed and round-trips as null', () => {
      const p = store.addPeer({
        peerId: 'hub_x',
        endpointUrl: 'wss://x.example',
        peerToken: 'tok-x-strong-enough',
      })
      expect(p.label).toBeNull()
    })

    it('duplicate peerId → peer_id_taken', () => {
      store.addPeer({
        peerId: 'hub_dup',
        endpointUrl: 'wss://dup.example',
        peerToken: 'tok-1234567890ab',
      })
      let err: unknown = null
      try {
        store.addPeer({
          peerId: 'hub_dup',
          endpointUrl: 'wss://other.example',
          peerToken: 'tok-different-tok',
        })
      } catch (e) { err = e }
      expect(err).toBeInstanceOf(IdentityError)
      expect((err as IdentityError).code).toBe('peer_id_taken')
    })

    it('input validation: empty peerId', () => {
      expect(() => store.addPeer({
        peerId: '',
        endpointUrl: 'wss://x.example',
        peerToken: 'tok-xxxxxxxxxxxx',
      })).toThrow(/peerId/)
    })

    it('input validation: empty endpointUrl', () => {
      expect(() => store.addPeer({
        peerId: 'hub_y',
        endpointUrl: '',
        peerToken: 'tok-xxxxxxxxxxxx',
      })).toThrow(/endpointUrl/)
    })

    it('input validation: empty peerToken', () => {
      expect(() => store.addPeer({
        peerId: 'hub_z',
        endpointUrl: 'wss://z.example',
        peerToken: '',
      })).toThrow(/peerToken/)
    })
  })

  // ---------- get / list ----------

  describe('getPeer / getPeerByPeerId / listPeers', () => {
    beforeEach(() => {
      store.addPeer({
        peerId: 'hub_a',
        endpointUrl: 'wss://a.example',
        label: 'A',
        peerToken: 'tok-aaaaaaaaaaaa',
      })
      const b = store.addPeer({
        peerId: 'hub_b',
        endpointUrl: 'wss://b.example',
        label: 'B',
        peerToken: 'tok-bbbbbbbbbbbb',
      })
      store.updatePeer(b.id, { enabled: false })
    })

    it('getPeer by row id returns the row, null when missing', () => {
      const all = store.listPeers()
      const a = all.find((p) => p.peerId === 'hub_a')!
      expect(store.getPeer(a.id)?.peerId).toBe('hub_a')
      expect(store.getPeer('nonexistent_id')).toBeNull()
    })

    it('getPeerByPeerId finds by wire id', () => {
      expect(store.getPeerByPeerId('hub_a')?.label).toBe('A')
      expect(store.getPeerByPeerId('hub_b')?.enabled).toBe(false)
      expect(store.getPeerByPeerId('not_there')).toBeNull()
    })

    it('listPeers (no filter) returns all rows including disabled', () => {
      const all = store.listPeers()
      expect(all.length).toBe(2)
      expect(all.some((p) => p.enabled === false)).toBe(true)
    })

    it('listPeers({enabledOnly: true}) hides disabled rows', () => {
      const active = store.listPeers({ enabledOnly: true })
      expect(active.length).toBe(1)
      expect(active[0]?.peerId).toBe('hub_a')
    })
  })

  // ---------- updatePeer ----------

  describe('updatePeer', () => {
    let id: string
    beforeEach(() => {
      id = store.addPeer({
        peerId: 'hub_up',
        endpointUrl: 'wss://up.example',
        label: 'orig',
        peerToken: 'tok-original-1234',
      }).id
    })

    it('label-only update preserves token + endpoint + enabled', () => {
      const tokBefore = store.getPeerToken(id)
      const updated = store.updatePeer(id, { label: 'renamed' })
      expect(updated.label).toBe('renamed')
      expect(updated.endpointUrl).toBe('wss://up.example')
      expect(updated.enabled).toBe(true)
      expect(store.getPeerToken(id)).toBe(tokBefore)
    })

    it('label: null clears the label', () => {
      const u = store.updatePeer(id, { label: null })
      expect(u.label).toBeNull()
    })

    it('enabled toggle round-trip', () => {
      expect(store.updatePeer(id, { enabled: false }).enabled).toBe(false)
      expect(store.updatePeer(id, { enabled: true }).enabled).toBe(true)
    })

    it('endpointUrl update (LB cutover)', () => {
      const u = store.updatePeer(id, { endpointUrl: 'wss://new.example/aipe' })
      expect(u.endpointUrl).toBe('wss://new.example/aipe')
    })

    it('peerToken rotation: new vault entry, old revoked, getPeerToken returns fresh', () => {
      const oldEntryId = store.getPeer(id)!.vaultEntryId
      const rotated = store.updatePeer(id, { peerToken: 'tok-rotated-5678' })
      expect(rotated.vaultEntryId).not.toBe(oldEntryId)
      expect(store.getPeerToken(id)).toBe('tok-rotated-5678')
      // The old vault entry exists with revoked_at set.
      const old = store.getVaultEntry(oldEntryId)
      expect(old?.revokedAt).not.toBeNull()
    })

    it('peer_not_found when id is unknown', () => {
      let err: unknown = null
      try { store.updatePeer('no_such', { label: 'x' }) } catch (e) { err = e }
      expect(err).toBeInstanceOf(IdentityError)
      expect((err as IdentityError).code).toBe('peer_not_found')
    })
  })

  // ---------- removePeer ----------

  describe('removePeer', () => {
    it('returns true when row existed; vault entry revoked', () => {
      const p = store.addPeer({
        peerId: 'hub_rm',
        endpointUrl: 'wss://rm.example',
        peerToken: 'tok-rm-1234567890',
      })
      const vaultId = p.vaultEntryId
      expect(store.removePeer(p.id)).toBe(true)
      expect(store.getPeer(p.id)).toBeNull()
      // Vault entry still queryable (soft delete) but revoked.
      const v = store.getVaultEntry(vaultId)
      expect(v?.revokedAt).not.toBeNull()
    })

    it('returns false when id is unknown', () => {
      expect(store.removePeer('not_there')).toBe(false)
    })

    it('after remove, the same peerId is free for re-registration', () => {
      const p = store.addPeer({
        peerId: 'hub_reuse',
        endpointUrl: 'wss://r.example',
        peerToken: 'tok-1234567890ab',
      })
      store.removePeer(p.id)
      const fresh = store.addPeer({
        peerId: 'hub_reuse',
        endpointUrl: 'wss://r.example/new',
        peerToken: 'tok-1234567890cd',
      })
      expect(fresh.peerId).toBe('hub_reuse')
      expect(fresh.endpointUrl).toBe('wss://r.example/new')
    })
  })

  // ---------- getPeerToken ----------

  describe('getPeerToken', () => {
    it('decrypts the stored secret', () => {
      const p = store.addPeer({
        peerId: 'hub_t',
        endpointUrl: 'wss://t.example',
        peerToken: 'super-secret-128',
      })
      expect(store.getPeerToken(p.id)).toBe('super-secret-128')
    })

    it('peer_not_found when id is unknown', () => {
      let err: unknown = null
      try { store.getPeerToken('no_such') } catch (e) { err = e }
      expect(err).toBeInstanceOf(IdentityError)
      expect((err as IdentityError).code).toBe('peer_not_found')
    })
  })

  // ---------- Phase 18 B-M1 — cross-org policy ----------

  describe('cross-org policy (Phase 18 B-M1)', () => {
    it('addPeer without policy fields → safe defaults (compat)', () => {
      const p = store.addPeer({
        peerId: 'hub_nopolicy',
        endpointUrl: 'wss://np.example',
        peerToken: 'tok-nopolicy-1234',
      })
      expect(p.kind).toBe('service')
      expect(p.acl).toBeNull()
      expect(p.outboundCaps).toBeNull()
      expect(p.requireApprovalOutbound).toBe(false)
    })

    it('addPeer round-trips a full policy (returned shape + fresh read)', () => {
      const p = store.addPeer({
        peerId: 'hub_pol',
        endpointUrl: 'wss://pol.example',
        peerToken: 'tok-pol-12345678',
        kind: 'organization',
        acl: { capabilities: ['review', 'translate'], requireOrigin: true, requireOriginRole: ['admin'] },
        outboundCaps: ['draft'],
        requireApprovalOutbound: true,
      })
      for (const r of [p, store.getPeerByPeerId('hub_pol')!]) {
        expect(r.kind).toBe('organization')
        expect(r.acl).toEqual({
          capabilities: ['review', 'translate'],
          requireOrigin: true,
          requireOriginRole: ['admin'],
        })
        expect(r.outboundCaps).toEqual(['draft'])
        expect(r.requireApprovalOutbound).toBe(true)
      }
    })

    it('updatePeer edits policy WITHOUT rotating the token', () => {
      const p = store.addPeer({
        peerId: 'hub_pe', endpointUrl: 'wss://pe.example', peerToken: 'tok-pe-original-1',
      })
      const tokBefore = store.getPeerToken(p.id)
      const u = store.updatePeer(p.id, {
        kind: 'project',
        acl: { capabilities: ['summarize'] },
        outboundCaps: ['draft', 'review'],
        requireApprovalOutbound: true,
      })
      expect(u.kind).toBe('project')
      expect(u.acl).toEqual({ capabilities: ['summarize'] })
      expect(u.outboundCaps).toEqual(['draft', 'review'])
      expect(u.requireApprovalOutbound).toBe(true)
      // token + vault entry untouched by a policy-only update.
      expect(store.getPeerToken(p.id)).toBe(tokBefore)
      expect(u.vaultEntryId).toBe(p.vaultEntryId)
    })

    it('token rotation preserves the existing policy', () => {
      const p = store.addPeer({
        peerId: 'hub_rot', endpointUrl: 'wss://rot.example', peerToken: 'tok-rot-1',
        kind: 'organization', acl: { requireOrigin: true }, outboundCaps: ['x'],
        requireApprovalOutbound: true,
      })
      const rotated = store.updatePeer(p.id, { peerToken: 'tok-rot-2-fresh' })
      expect(store.getPeerToken(p.id)).toBe('tok-rot-2-fresh')
      expect(rotated.kind).toBe('organization')
      expect(rotated.acl).toEqual({ requireOrigin: true })
      expect(rotated.outboundCaps).toEqual(['x'])
      expect(rotated.requireApprovalOutbound).toBe(true)
    })

    it('updatePeer with undefined policy fields preserves them', () => {
      const p = store.addPeer({
        peerId: 'hub_pre', endpointUrl: 'wss://pre.example', peerToken: 'tok-pre-1',
        kind: 'personal', acl: { capabilities: ['a'] }, outboundCaps: ['b'],
        requireApprovalOutbound: true,
      })
      const u = store.updatePeer(p.id, { label: 'just a label' })
      expect(u.kind).toBe('personal')
      expect(u.acl).toEqual({ capabilities: ['a'] })
      expect(u.outboundCaps).toEqual(['b'])
      expect(u.requireApprovalOutbound).toBe(true)
    })

    it('updatePeer with explicit null CLEARS acl / outboundCaps', () => {
      const p = store.addPeer({
        peerId: 'hub_clr', endpointUrl: 'wss://clr.example', peerToken: 'tok-clr-1',
        acl: { capabilities: ['a'] }, outboundCaps: ['b'],
      })
      const u = store.updatePeer(p.id, { acl: null, outboundCaps: null })
      expect(u.acl).toBeNull()
      expect(u.outboundCaps).toBeNull()
    })

    it('corrupt acl_json degrades to null instead of throwing', async () => {
      const tmp2 = await mkdtemp(join(tmpdir(), 'aipe-id-peers-corrupt-'))
      const path = join(tmp2, 'identity.sqlite')
      const mk = randomBytes(MASTER_KEY_LEN_BYTES)
      const s1 = openIdentityStore({ dbPath: path, masterKey: mk })
      s1.addPeer({
        peerId: 'hub_corrupt', endpointUrl: 'wss://c.example', peerToken: 'tok-c-1',
        acl: { capabilities: ['a'] },
      })
      s1.close()
      // Hand-mangle the stored JSON via a second connection.
      const raw = openDb(path)
      raw.prepare('UPDATE peers SET acl_json = ? WHERE peer_id = ?').run('{ not valid json', 'hub_corrupt')
      raw.close()
      const s2 = openIdentityStore({ dbPath: path, masterKey: mk })
      const p = s2.getPeerByPeerId('hub_corrupt')
      expect(p).not.toBeNull()
      expect(p!.acl).toBeNull()       // corrupt → null, did not throw
      expect(p!.kind).toBe('service') // the rest of the row still loads
      s2.close()
      await rm(tmp2, { recursive: true, force: true })
    })

    it('a legacy-shaped row (no policy columns) reads back as v12 defaults', async () => {
      const tmp2 = await mkdtemp(join(tmpdir(), 'aipe-id-peers-legacy-'))
      const path = join(tmp2, 'identity.sqlite')
      const mk = randomBytes(MASTER_KEY_LEN_BYTES)
      // First open runs migrations (incl. v12 ADD COLUMN ... DEFAULT).
      openIdentityStore({ dbPath: path, masterKey: mk }).close()
      // Insert a row using ONLY the pre-B-M1 columns, so SQLite fills the
      // policy columns from their v12 DEFAULTs — exactly what an existing
      // peers row gets after the migration runs.
      const now = Date.now()
      const raw = openDb(path)
      raw.prepare(
        `INSERT INTO peers(id, peer_id, endpoint_url, label, enabled, vault_entry_id, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('row_legacy', 'hub_legacy', 'wss://legacy.example', null, 1, 'vault_fake', now, now)
      raw.close()
      const s = openIdentityStore({ dbPath: path, masterKey: mk })
      const p = s.getPeerByPeerId('hub_legacy')!
      expect(p.kind).toBe('service')
      expect(p.acl).toBeNull()
      expect(p.outboundCaps).toBeNull()
      expect(p.requireApprovalOutbound).toBe(false)
      // Phase 19 P4-M4 — a legacy row also reads the v15 contract defaults.
      expect(p.revocationState).toBe('active')
      expect(p.perLinkQuotaBudget).toBeNull()
      expect(p.allowedDataClasses).toBeNull()
      s.close()
      await rm(tmp2, { recursive: true, force: true })
    })
  })

  // ---------- Phase 19 P4-M4 — per-link trust contract ----------

  describe('per-link trust contract (Phase 19 P4-M4)', () => {
    it('addPeer without contract fields → safe defaults', () => {
      const p = store.addPeer({
        peerId: 'hub_p4def', endpointUrl: 'wss://p4.example', peerToken: 'tok-p4-1',
      })
      expect(p.revocationState).toBe('active')
      expect(p.perLinkQuotaBudget).toBeNull()
      expect(p.allowedDataClasses).toBeNull()
    })

    it('addPeer round-trips revocation / quota / data-classes', () => {
      const p = store.addPeer({
        peerId: 'hub_p4full', endpointUrl: 'wss://p4f.example', peerToken: 'tok-p4f-1',
        revocationState: 'revoked',
        perLinkQuotaBudget: 500,
        allowedDataClasses: ['public', 'internal'],
      })
      for (const r of [p, store.getPeerByPeerId('hub_p4full')!]) {
        expect(r.revocationState).toBe('revoked')
        expect(r.perLinkQuotaBudget).toBe(500)
        expect(r.allowedDataClasses).toEqual(['public', 'internal'])
      }
    })

    it('updatePeer sets revocation + preserves untouched contract fields', () => {
      const p = store.addPeer({
        peerId: 'hub_p4upd', endpointUrl: 'wss://p4u.example', peerToken: 'tok-p4u-1',
        perLinkQuotaBudget: 100, allowedDataClasses: ['public'],
      })
      const u = store.updatePeer(p.id, { revocationState: 'revoked' })
      expect(u.revocationState).toBe('revoked')
      expect(u.perLinkQuotaBudget).toBe(100) // preserved
      expect(u.allowedDataClasses).toEqual(['public']) // preserved
    })

    it('updatePeer explicit null CLEARS quota + data-classes', () => {
      const p = store.addPeer({
        peerId: 'hub_p4clr', endpointUrl: 'wss://p4c.example', peerToken: 'tok-p4c-1',
        perLinkQuotaBudget: 100, allowedDataClasses: ['public'],
      })
      const u = store.updatePeer(p.id, { perLinkQuotaBudget: null, allowedDataClasses: null })
      expect(u.perLinkQuotaBudget).toBeNull()
      expect(u.allowedDataClasses).toBeNull()
    })
  })
})
