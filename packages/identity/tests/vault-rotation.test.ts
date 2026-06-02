import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDb, type SqliteDb } from '../src/db.js'
import { IdentityError } from '../src/errors.js'
import { openIdentityStore } from '../src/index.js'
import { applyMigrations } from '../src/schema.js'
import { VaultStore } from '../src/vault-store.js'

/**
 * Route B P0-M4c — online master-key (KEK) rotation. The envelope (M4b) lets
 * a rotation re-wrap the single data key instead of re-encrypting every
 * secret, so these tests pin: after rotate, the OLD key no longer opens the
 * vault, the NEW key does, secret ciphertext is byte-unchanged (O(1)), and a
 * bad new key can't half-rotate. Each guard is falsifiable.
 */

const K1 = Buffer.alloc(32, 0x11)
const K2 = Buffer.alloc(32, 0x22)
const K3 = Buffer.alloc(32, 0x33)

function freshDb(): SqliteDb {
  const db = openDb(':memory:')
  applyMigrations(db)
  return db
}

function makeEntry(vault: VaultStore, secret: string): string {
  return vault.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret }).id
}

function rawSecretEnc(db: SqliteDb, id: string): string {
  return (db.prepare('SELECT secret_enc FROM vault WHERE id = ?').get(id) as { secret_enc: string })
    .secret_enc
}
function rawWrappedDek(db: SqliteDb): string {
  return (db.prepare('SELECT value FROM vault_meta WHERE key = ?').get('vault.dek.v1') as {
    value: string
  }).value
}
function readCode(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (err) {
    return (err as IdentityError).code
  }
}

describe('VaultStore.rotateMasterKey (Route B P0-M4c)', () => {
  it('after rotation the new key opens the vault and the old key no longer does', () => {
    const db = freshDb()
    const v1 = new VaultStore(db, K1)
    const id = makeEntry(v1, 'sk-secret')

    v1.rotateMasterKey(K2)

    // Same instance keeps working (the cached DEK is unchanged).
    expect(v1.readVaultSecret(id)).toBe('sk-secret')
    // A fresh store must use the NEW key (DEK rewrapped under K2).
    expect(new VaultStore(db, K2).readVaultSecret(id)).toBe('sk-secret')
    // The OLD key can no longer unwrap the DEK.
    expect(readCode(() => new VaultStore(db, K1).readVaultSecret(id))).toBe('vault_decrypt_failed')
  })

  it('does not touch secret rows — only the wrapped DEK changes (O(1))', () => {
    const db = freshDb()
    const v1 = new VaultStore(db, K1)
    const id = makeEntry(v1, 'unchanged-ciphertext')
    const beforeSecret = rawSecretEnc(db, id)
    const beforeDek = rawWrappedDek(db)

    v1.rotateMasterKey(K2)

    expect(rawSecretEnc(db, id)).toBe(beforeSecret) // ciphertext untouched
    expect(rawWrappedDek(db)).not.toBe(beforeDek) // only the wrapping moved
  })

  it('secrets written after rotation are readable with the new key', () => {
    const db = freshDb()
    const v1 = new VaultStore(db, K1)
    makeEntry(v1, 'before')
    v1.rotateMasterKey(K2)
    const id2 = makeEntry(v1, 'after')
    expect(new VaultStore(db, K2).readVaultSecret(id2)).toBe('after')
  })

  it('chained rotations: only the latest key works', () => {
    const db = freshDb()
    const v1 = new VaultStore(db, K1)
    const id = makeEntry(v1, 'chained')
    v1.rotateMasterKey(K2)
    v1.rotateMasterKey(K3)
    expect(new VaultStore(db, K3).readVaultSecret(id)).toBe('chained')
    expect(readCode(() => new VaultStore(db, K1).readVaultSecret(id))).toBe('vault_decrypt_failed')
    expect(readCode(() => new VaultStore(db, K2).readVaultSecret(id))).toBe('vault_decrypt_failed')
  })

  it('a wrong-length new key throws invalid_input and does NOT half-rotate', () => {
    const db = freshDb()
    const v1 = new VaultStore(db, K1)
    const id = makeEntry(v1, 'safe')
    expect(() => v1.rotateMasterKey(Buffer.alloc(8, 1))).toThrow(IdentityError)
    // The vault is still openable with the original key — no partial write.
    expect(new VaultStore(db, K1).readVaultSecret(id)).toBe('safe')
  })

  it('rotating a vault that was never configured throws vault_not_configured', () => {
    const db = freshDb()
    const noKey = new VaultStore(db)
    expect(readCode(() => noKey.rotateMasterKey(K2))).toBe('vault_not_configured')
  })
})

describe('IdentityStore.rotateVaultMasterKey — reopen forwarder (Route B P0-M4c)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipe-rot-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('rotates so the next boot must use the new key', () => {
    const dbPath = join(dir, 'identity.sqlite')
    const s1 = openIdentityStore({ dbPath, masterKey: K1 })
    const id = s1.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret: 'persisted' }).id
    s1.rotateVaultMasterKey(K2)
    s1.close()

    // Reopen with the NEW key → reads.
    const s2 = openIdentityStore({ dbPath, masterKey: K2 })
    expect(s2.readVaultSecret(id)).toBe('persisted')
    s2.close()

    // Reopen with the OLD key → fails closed.
    const s3 = openIdentityStore({ dbPath, masterKey: K1 })
    expect(readCode(() => s3.readVaultSecret(id))).toBe('vault_decrypt_failed')
    s3.close()
  })
})
