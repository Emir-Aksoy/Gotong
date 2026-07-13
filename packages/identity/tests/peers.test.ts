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
  type PeerRegistration,
} from '../src/index.js'
import { openDb } from '../src/db.js'

describe('IdentityStore — peers (D1)', () => {
  let store: IdentityStore
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gotong-id-peers-'))
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
        endpointUrl: 'wss://acme.example/gotong',
        label: 'Acme org',
        peerToken: 'shared-secret-128-bit-token',
      })
      expect(p.peerId).toBe('hub_acme')
      expect(p.endpointUrl).toBe('wss://acme.example/gotong')
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
      const u = store.updatePeer(id, { endpointUrl: 'wss://new.example/gotong' })
      expect(u.endpointUrl).toBe('wss://new.example/gotong')
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
      const tmp2 = await mkdtemp(join(tmpdir(), 'gotong-id-peers-corrupt-'))
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
      const tmp2 = await mkdtemp(join(tmpdir(), 'gotong-id-peers-legacy-'))
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
      // v5 E5 — a legacy row reads the v23 default: summary sharing OFF.
      expect(p.shareSummary).toBe(false)
      s.close()
      await rm(tmp2, { recursive: true, force: true })
    })
  })

  // ---------- audit L13 — policy JSON normalization + corruption trail ----------

  describe('policy JSON non-array normalization (audit L13)', () => {
    // Hand-mangle one stored policy column to an arbitrary JSON string via a
    // second raw connection (the only way to plant valid-JSON-wrong-shape —
    // the store itself only ever writes via JSON.stringify), then read back.
    async function readWithMangledColumn(
      column: string,
      rawJson: string,
      seed: Parameters<IdentityStore['addPeer']>[0],
    ): Promise<PeerRegistration> {
      const tmp2 = await mkdtemp(join(tmpdir(), 'gotong-id-peers-l13-'))
      const path = join(tmp2, 'identity.sqlite')
      const mk = randomBytes(MASTER_KEY_LEN_BYTES)
      const s1 = openIdentityStore({ dbPath: path, masterKey: mk })
      s1.addPeer(seed)
      s1.close()
      const raw = openDb(path)
      raw.prepare(`UPDATE peers SET ${column} = ? WHERE peer_id = ?`).run(rawJson, seed.peerId)
      raw.close()
      const s2 = openIdentityStore({ dbPath: path, masterKey: mk })
      const p = s2.getPeerByPeerId(seed.peerId)!
      s2.close()
      await rm(tmp2, { recursive: true, force: true })
      return p
    }

    const seedFor = (peerId: string) => ({
      peerId,
      endpointUrl: `wss://${peerId}.example`,
      peerToken: `tok-${peerId}`,
    })

    it('a non-array outbound_caps_json ("chat" string) normalizes to null + trail — NOT a passthrough', async () => {
      // The bug: the old parser returned the raw string, so `new Set("chat")`
      // downstream char-splits into {c,h,a,t} — the WRONG allowlist.
      const p = await readWithMangledColumn('outbound_caps_json', '"chat"', seedFor('hub_l13_str'))
      expect(p.outboundCaps).toBeNull()
      expect(p.policyCorrupt).toEqual(['outboundCaps'])
    })

    it('a numeric allowed_data_classes_json (42) normalizes to null + trail — NOT a "not iterable" crash', async () => {
      const p = await readWithMangledColumn('allowed_data_classes_json', '42', seedFor('hub_l13_num'))
      expect(p.allowedDataClasses).toBeNull()
      expect(p.policyCorrupt).toEqual(['allowedDataClasses'])
    })

    it('an array with junk elements keeps the string entries (intent honoured) and flags', async () => {
      const p = await readWithMangledColumn(
        'allowed_knowledge_bases_json',
        '["company_kb", 42, "policy_kb"]',
        seedFor('hub_l13_junk'),
      )
      expect(p.allowedKnowledgeBases).toEqual(['company_kb', 'policy_kb'])
      expect(p.policyCorrupt).toEqual(['allowedKnowledgeBases'])
    })

    it('an all-junk array collapses to [] (deny-all, fail-closed), never a passthrough', async () => {
      const p = await readWithMangledColumn('outbound_caps_json', '[1, 2, 3]', seedFor('hub_l13_alljunk'))
      expect(p.outboundCaps).toEqual([]) // [] = explicit deny-all; storage still keeps null (unset) distinct from [], though the acl gate fail-closes both since GT-M2
      expect(p.policyCorrupt).toEqual(['outboundCaps'])
    })

    it('an acl_json that is an array (wrong top-level shape) normalizes to null + trail', async () => {
      const p = await readWithMangledColumn('acl_json', '["chat"]', seedFor('hub_l13_aclarr'))
      expect(p.acl).toBeNull()
      expect(p.policyCorrupt).toEqual(['acl'])
    })

    it('a non-array acl.capabilities sub-field is dropped + flagged (same new Set() risk)', async () => {
      const p = await readWithMangledColumn(
        'acl_json',
        '{"capabilities":"chat","requireOrigin":true}',
        seedFor('hub_l13_aclsub'),
      )
      // The object survives; the bad sub-array is dropped (undefined = no cap
      // check), the good boolean is kept, and the trail names the sub-field.
      expect(p.acl).toEqual({ requireOrigin: true })
      expect(p.policyCorrupt).toEqual(['acl.capabilities'])
    })

    it('a healthy row omits policyCorrupt entirely (record shape unchanged)', () => {
      const p = store.addPeer({
        peerId: 'hub_l13_ok',
        endpointUrl: 'wss://ok.example',
        peerToken: 'tok-ok-1',
        outboundCaps: ['chat'],
        acl: { capabilities: ['chat'], requireOriginRole: ['admin'] },
        allowedDataClasses: ['public'],
      })
      for (const r of [p, store.getPeerByPeerId('hub_l13_ok')!]) {
        expect(r.outboundCaps).toEqual(['chat'])
        expect(r.acl).toEqual({ capabilities: ['chat'], requireOriginRole: ['admin'] })
        expect('policyCorrupt' in r).toBe(false)
      }
    })

    it('multiple corrupt columns all appear in the trail', async () => {
      const tmp2 = await mkdtemp(join(tmpdir(), 'gotong-id-peers-l13-multi-'))
      const path = join(tmp2, 'identity.sqlite')
      const mk = randomBytes(MASTER_KEY_LEN_BYTES)
      const s1 = openIdentityStore({ dbPath: path, masterKey: mk })
      s1.addPeer(seedFor('hub_l13_multi'))
      s1.close()
      const raw = openDb(path)
      raw
        .prepare('UPDATE peers SET outbound_caps_json = ?, allowed_data_classes_json = ? WHERE peer_id = ?')
        .run('"x"', '{"a":1}', 'hub_l13_multi')
      raw.close()
      const s2 = openIdentityStore({ dbPath: path, masterKey: mk })
      const p = s2.getPeerByPeerId('hub_l13_multi')!
      s2.close()
      await rm(tmp2, { recursive: true, force: true })
      expect(p.outboundCaps).toBeNull()
      expect(p.allowedDataClasses).toBeNull()
      expect(p.policyCorrupt).toContain('outboundCaps')
      expect(p.policyCorrupt).toContain('allowedDataClasses')
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

  // ---------- v5 C-M1 — callable-knowledge-base allowlist (schema v17) ----------

  describe('callable-knowledge-base allowlist (v5 C-M1)', () => {
    it('addPeer without the field → null (every shared KB callable)', () => {
      const p = store.addPeer({
        peerId: 'hub_cm1def', endpointUrl: 'wss://cm1.example', peerToken: 'tok-cm1-1',
      })
      expect(p.allowedKnowledgeBases).toBeNull()
    })

    it('addPeer round-trips an explicit KB allowlist (incl. [] lockdown)', () => {
      const p = store.addPeer({
        peerId: 'hub_cm1full', endpointUrl: 'wss://cm1f.example', peerToken: 'tok-cm1f-1',
        allowedKnowledgeBases: ['company_kb', 'policy_kb'],
      })
      for (const r of [p, store.getPeerByPeerId('hub_cm1full')!]) {
        expect(r.allowedKnowledgeBases).toEqual(['company_kb', 'policy_kb'])
      }
      const locked = store.addPeer({
        peerId: 'hub_cm1lock', endpointUrl: 'wss://cm1l.example', peerToken: 'tok-cm1l-1',
        allowedKnowledgeBases: [],
      })
      expect(locked.allowedKnowledgeBases).toEqual([]) // [] = no KB callable, distinct from null
    })

    it('updatePeer preserves the KB allowlist on undefined, clears on null', () => {
      const p = store.addPeer({
        peerId: 'hub_cm1upd', endpointUrl: 'wss://cm1u.example', peerToken: 'tok-cm1u-1',
        allowedKnowledgeBases: ['company_kb'],
      })
      const preserved = store.updatePeer(p.id, { label: 'renamed' })
      expect(preserved.allowedKnowledgeBases).toEqual(['company_kb']) // undefined preserves
      const cleared = store.updatePeer(p.id, { allowedKnowledgeBases: null })
      expect(cleared.allowedKnowledgeBases).toBeNull() // explicit null clears
    })

    it('updatePeer sets the KB allowlist without touching the data-class contract', () => {
      const p = store.addPeer({
        peerId: 'hub_cm1iso', endpointUrl: 'wss://cm1i.example', peerToken: 'tok-cm1i-1',
        allowedDataClasses: ['public'],
      })
      const u = store.updatePeer(p.id, { allowedKnowledgeBases: ['company_kb'] })
      expect(u.allowedKnowledgeBases).toEqual(['company_kb'])
      expect(u.allowedDataClasses).toEqual(['public']) // untouched
    })
  })

  // ---------- v5 E5 — per-link summary-sharing opt-in (schema v23) ----------

  describe('summary-sharing opt-in (v5 E5)', () => {
    it('addPeer without the field → false (fail-closed, summary not shared)', () => {
      const p = store.addPeer({
        peerId: 'hub_e5def', endpointUrl: 'wss://e5.example', peerToken: 'tok-e5-1',
      })
      expect(p.shareSummary).toBe(false)
    })

    it('addPeer round-trips an explicit opt-in', () => {
      const p = store.addPeer({
        peerId: 'hub_e5on', endpointUrl: 'wss://e5on.example', peerToken: 'tok-e5on-1',
        shareSummary: true,
      })
      for (const r of [p, store.getPeerByPeerId('hub_e5on')!]) {
        expect(r.shareSummary).toBe(true)
      }
    })

    it('updatePeer preserves the opt-in on undefined, sets on explicit bool', () => {
      const p = store.addPeer({
        peerId: 'hub_e5upd', endpointUrl: 'wss://e5u.example', peerToken: 'tok-e5u-1',
        shareSummary: true,
      })
      const preserved = store.updatePeer(p.id, { label: 'renamed' })
      expect(preserved.shareSummary).toBe(true) // undefined preserves
      const off = store.updatePeer(p.id, { shareSummary: false })
      expect(off.shareSummary).toBe(false) // explicit false sets
    })

    it('updatePeer toggles summary sharing without touching the KB allowlist', () => {
      const p = store.addPeer({
        peerId: 'hub_e5iso', endpointUrl: 'wss://e5i.example', peerToken: 'tok-e5i-1',
        allowedKnowledgeBases: ['company_kb'],
      })
      const u = store.updatePeer(p.id, { shareSummary: true })
      expect(u.shareSummary).toBe(true)
      expect(u.allowedKnowledgeBases).toEqual(['company_kb']) // untouched
    })
  })

  describe('transcript-sharing opt-in (v5 Stream G day-5)', () => {
    it('addPeer without the field → false (fail-closed, transcript not shared)', () => {
      const p = store.addPeer({
        peerId: 'hub_g5def', endpointUrl: 'wss://g5.example', peerToken: 'tok-g5-1',
      })
      expect(p.shareTranscript).toBe(false)
    })

    it('addPeer round-trips an explicit opt-in', () => {
      const p = store.addPeer({
        peerId: 'hub_g5on', endpointUrl: 'wss://g5on.example', peerToken: 'tok-g5on-1',
        shareTranscript: true,
      })
      for (const r of [p, store.getPeerByPeerId('hub_g5on')!]) {
        expect(r.shareTranscript).toBe(true)
      }
    })

    it('updatePeer preserves the opt-in on undefined, sets on explicit bool', () => {
      const p = store.addPeer({
        peerId: 'hub_g5upd', endpointUrl: 'wss://g5u.example', peerToken: 'tok-g5u-1',
        shareTranscript: true,
      })
      const preserved = store.updatePeer(p.id, { label: 'renamed' })
      expect(preserved.shareTranscript).toBe(true) // undefined preserves
      const off = store.updatePeer(p.id, { shareTranscript: false })
      expect(off.shareTranscript).toBe(false) // explicit false sets
    })

    it('transcript and summary sharing are independent dimensions', () => {
      // Each opt-in is its own column; flipping one must not move the other.
      const p = store.addPeer({
        peerId: 'hub_g5iso', endpointUrl: 'wss://g5i.example', peerToken: 'tok-g5i-1',
        shareSummary: true,
      })
      const u = store.updatePeer(p.id, { shareTranscript: true })
      expect(u.shareTranscript).toBe(true)
      expect(u.shareSummary).toBe(true) // untouched by the transcript toggle
      const off = store.updatePeer(p.id, { shareSummary: false })
      expect(off.shareSummary).toBe(false)
      expect(off.shareTranscript).toBe(true) // transcript opt-in survives
    })
  })

  describe('pinnedKid trust anchor (STD-M2b)', () => {
    // 43-char base64url shape (RFC 7638). The store itself stores any string —
    // shape validation is the web layer's job — but we use realistic values.
    const KID = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM1234'
    const KID2 = 'ROTATED' + 'x'.repeat(36)

    it('addPeer without the field → null (no anchor; identity rests on the token)', () => {
      const p = store.addPeer({
        peerId: 'hub_pkdef', endpointUrl: 'wss://pk.example', peerToken: 'tok-pk-1',
      })
      expect(p.pinnedKid).toBeNull()
    })

    it('addPeer round-trips an explicit pin', () => {
      const p = store.addPeer({
        peerId: 'hub_pkon', endpointUrl: 'wss://pkon.example', peerToken: 'tok-pkon-1',
        pinnedKid: KID,
      })
      for (const r of [p, store.getPeerByPeerId('hub_pkon')!]) {
        expect(r.pinnedKid).toBe(KID)
      }
    })

    it('updatePeer preserves on undefined, replaces on a new value, CLEARS on null', () => {
      const p = store.addPeer({
        peerId: 'hub_pkupd', endpointUrl: 'wss://pku.example', peerToken: 'tok-pku-1',
        pinnedKid: KID,
      })
      const preserved = store.updatePeer(p.id, { label: 'renamed' })
      expect(preserved.pinnedKid).toBe(KID) // undefined preserves
      const rotated = store.updatePeer(p.id, { pinnedKid: KID2 })
      expect(rotated.pinnedKid).toBe(KID2) // a new value replaces
      const cleared = store.updatePeer(p.id, { pinnedKid: null })
      expect(cleared.pinnedKid).toBeNull() // explicit null clears the anchor
    })

    it('the pin is independent of policy fields (a policy edit leaves it untouched)', () => {
      const p = store.addPeer({
        peerId: 'hub_pkiso', endpointUrl: 'wss://pki.example', peerToken: 'tok-pki-1',
        pinnedKid: KID,
      })
      const u = store.updatePeer(p.id, { requireApprovalOutbound: true })
      expect(u.requireApprovalOutbound).toBe(true)
      expect(u.pinnedKid).toBe(KID) // untouched by an unrelated policy change
    })
  })

  describe('trustTier grade (GT-M3)', () => {
    it('addPeer without the field → null (un-graded; consumer applies floor T1)', () => {
      const p = store.addPeer({
        peerId: 'hub_ttdef', endpointUrl: 'wss://tt.example', peerToken: 'tok-tt-1',
      })
      expect(p.trustTier).toBeNull()
    })

    it('addPeer round-trips an explicit grade', () => {
      const p = store.addPeer({
        peerId: 'hub_tton', endpointUrl: 'wss://tton.example', peerToken: 'tok-tton-1',
        trustTier: 'T2',
      })
      for (const r of [p, store.getPeerByPeerId('hub_tton')!]) {
        expect(r.trustTier).toBe('T2')
      }
    })

    it('updatePeer preserves on undefined, replaces on a new grade, CLEARS on null', () => {
      const p = store.addPeer({
        peerId: 'hub_ttupd', endpointUrl: 'wss://ttu.example', peerToken: 'tok-ttu-1',
        trustTier: 'T2',
      })
      const preserved = store.updatePeer(p.id, { label: 'renamed' })
      expect(preserved.trustTier).toBe('T2') // undefined preserves
      const promoted = store.updatePeer(p.id, { trustTier: 'T3' })
      expect(promoted.trustTier).toBe('T3') // a new grade replaces
      const cleared = store.updatePeer(p.id, { trustTier: null })
      expect(cleared.trustTier).toBeNull() // explicit null clears (back to un-graded)
    })

    it('the grade is independent of the pin and of policy fields (orthogonal axes)', () => {
      const p = store.addPeer({
        peerId: 'hub_ttiso', endpointUrl: 'wss://tti.example', peerToken: 'tok-tti-1',
        trustTier: 'T2',
        pinnedKid: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM1234',
      })
      // Changing outbound authorization must NOT disturb the trust grade,
      // nor the identity anchor — trustTier / outboundCaps / pinnedKid are
      // three decoupled axes (GRADED-TRUST.md 八).
      const u = store.updatePeer(p.id, { outboundCaps: ['draft'] })
      expect(u.outboundCaps).toEqual(['draft'])
      expect(u.trustTier).toBe('T2')
      expect(u.pinnedKid).toBe('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM1234')
      // ...and clearing the pin leaves the grade intact (岔口 3 纯软连接:
      // identity confidence and authorization tier never move together).
      const v = store.updatePeer(p.id, { pinnedKid: null })
      expect(v.pinnedKid).toBeNull()
      expect(v.trustTier).toBe('T2')
    })

    it('an unrecognised stored tier projects to null (defensive, like `kind`)', async () => {
      // Plant a tier this build doesn't know via a second raw connection
      // (close-then-reopen, mirroring the audit-L13 helper). The projection
      // must fail safe to null (un-graded → floor T1), never surface a bogus
      // value the decision matrix can't map.
      const tmp2 = await mkdtemp(join(tmpdir(), 'gotong-id-peers-tt-'))
      const path = join(tmp2, 'identity.sqlite')
      const mk = randomBytes(MASTER_KEY_LEN_BYTES)
      const s1 = openIdentityStore({ dbPath: path, masterKey: mk })
      s1.addPeer({ peerId: 'hub_ttbad', endpointUrl: 'wss://ttb.example', peerToken: 'tok-ttb-1', trustTier: 'T1' })
      s1.close()
      const raw = openDb(path)
      raw.prepare('UPDATE peers SET trust_tier = ? WHERE peer_id = ?').run('T9', 'hub_ttbad')
      raw.close()
      const s2 = openIdentityStore({ dbPath: path, masterKey: mk })
      expect(s2.getPeerByPeerId('hub_ttbad')!.trustTier).toBeNull()
      s2.close()
      await rm(tmp2, { recursive: true, force: true })
    })
  })
})
