/**
 * v5 A-M3 — HostMeCredentialsService against a REAL IdentityStore vault
 * (encryption + listing + revoke), so ownership scoping, the provider
 * allow-list, the secret-never-leaks projection, the delete ownership gate,
 * and the best-effort audit are all covered against the actual store.
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
} from '@aipehub/identity'

import { HostMeCredentialsService } from '../src/me-credentials-service.js'

const ALICE = 'user-alice'
const BOB = 'user-bob'

describe('HostMeCredentialsService (v5 A-M3)', () => {
  let dir: string
  let identity: IdentityStore
  let svc: HostMeCredentialsService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipehub-mecred-'))
    identity = openIdentityStore({
      dbPath: join(dir, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
    svc = new HostMeCredentialsService({ identity })
  })

  afterEach(() => {
    identity.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('providers() is the member BYO allow-list (no mock / openai-compatible)', async () => {
    expect(await svc.providers()).toEqual(['anthropic', 'openai'])
  })

  it('create: stores a user-owned vault key + projects metadata (never the secret)', async () => {
    const v = await svc.create(ALICE, { provider: 'anthropic', apiKey: 'sk-ant-alice', label: 'my key' })
    expect(v.provider).toBe('anthropic')
    expect(v.label).toBe('my key')
    expect(typeof v.id).toBe('string')
    // The view must NOT carry the secret.
    expect(JSON.stringify(v)).not.toContain('sk-ant-alice')
    // It really landed in the vault as a user-owned row that decrypts back.
    const rows = identity.listVaultEntries({ kind: 'llm_provider', ownerKind: 'user', ownerId: ALICE })
    expect(rows.map((r) => r.id)).toContain(v.id)
    expect(identity.readVaultSecret(v.id)).toBe('sk-ant-alice')
  })

  it('create: rejects a provider outside the allow-list', async () => {
    await expect(svc.create(ALICE, { provider: 'mock', apiKey: 'x' })).rejects.toMatchObject({ status: 400 })
    await expect(
      svc.create(ALICE, { provider: 'openai-compatible', apiKey: 'x' }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('list: only the caller’s own active credentials (cross-user isolation)', async () => {
    const a = await svc.create(ALICE, { provider: 'anthropic', apiKey: 'sk-a' })
    await svc.create(BOB, { provider: 'openai', apiKey: 'sk-b' })
    const aliceList = await svc.list(ALICE)
    expect(aliceList.map((c) => c.id)).toEqual([a.id])
    const bobList = await svc.list(BOB)
    expect(bobList.map((c) => c.provider)).toEqual(['openai'])
  })

  it('remove: owner revokes their own key; it drops out of the list', async () => {
    const a = await svc.create(ALICE, { provider: 'anthropic', apiKey: 'sk-a' })
    expect(await svc.remove(ALICE, a.id)).toBe(true)
    expect(await svc.list(ALICE)).toEqual([])
    // The vault row is soft-deleted (revoked), not hard-deleted.
    expect(identity.getVaultEntry(a.id)?.revokedAt).toBeTruthy()
  })

  it('remove: a member cannot revoke ANOTHER member’s key → 404 (no enumeration)', async () => {
    const bobKey = await svc.create(BOB, { provider: 'openai', apiKey: 'sk-bob' })
    await expect(svc.remove(ALICE, bobKey.id)).rejects.toMatchObject({ status: 404 })
    // Bob's key is untouched.
    expect(identity.getVaultEntry(bobKey.id)?.revokedAt).toBeNull()
  })

  it('remove: a member cannot revoke an ORG key → 404', async () => {
    const orgKey = identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      ownerId: null,
      secret: 'sk-org',
      metadata: { provider: 'anthropic' },
    })
    await expect(svc.remove(ALICE, orgKey.id)).rejects.toMatchObject({ status: 404 })
    expect(identity.getVaultEntry(orgKey.id)?.revokedAt).toBeNull()
  })

  it('remove: unknown credential id → 404', async () => {
    await expect(svc.remove(ALICE, 'does-not-exist')).rejects.toMatchObject({ status: 404 })
  })

  it('create + remove write best-effort audit rows tagged ownerScope=user', async () => {
    const v = await svc.create(ALICE, { provider: 'anthropic', apiKey: 'sk-a' })
    await svc.remove(ALICE, v.id)
    const creates = identity.listAuditLog!({ action: 'vault_create' })
    const revokes = identity.listAuditLog!({ action: 'vault_revoke' })
    const c = creates.find((a) => (a.metadata as { vaultEntryId?: string } | null)?.vaultEntryId === v.id)!
    expect(c).toBeTruthy()
    expect(c.actorUserId).toBe(ALICE)
    expect((c.metadata as { ownerScope?: string }).ownerScope).toBe('user')
    expect(revokes.some((a) => (a.metadata as { vaultEntryId?: string } | null)?.vaultEntryId === v.id)).toBe(true)
  })
})
