import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  decryptSecret,
  encryptSecret,
  generateDataKey,
  unwrapDataKey,
  wrapDataKey,
} from '../src/crypto.js'
import { openDb, type SqliteDb } from '../src/db.js'
import { IdentityError } from '../src/errors.js'
import { applyMigrations } from '../src/schema.js'
import { VaultStore } from '../src/vault-store.js'

/**
 * Route B P0-M4b — envelope encryption. Secrets are encrypted with a data
 * key (DEK); the DEK is stored once, wrapped by the master key (KEK). These
 * tests pin: secrets are under the DEK (not the KEK), the wrapped DEK is
 * persisted and reused across reopen, a wrong KEK fails closed, and legacy
 * KEK-direct rows migrate on first access. Each guard is falsifiable.
 */

const KEK = Buffer.alloc(32, 0xab)

function freshDb(): SqliteDb {
  const db = openDb(':memory:')
  applyMigrations(db)
  return db
}

/** Raw read of a vault row's ciphertext, bypassing the store. */
function rawSecretEnc(db: SqliteDb, id: string): string {
  const row = db.prepare('SELECT secret_enc FROM vault WHERE id = ?').get(id) as
    | { secret_enc: string }
    | undefined
  if (!row) throw new Error(`no vault row ${id}`)
  return row.secret_enc
}

function rawWrappedDek(db: SqliteDb): string | undefined {
  const row = db.prepare('SELECT value FROM vault_meta WHERE key = ?').get('vault.dek.v1') as
    | { value: string }
    | undefined
  return row?.value
}

function makeEntry(vault: VaultStore, secret: string): string {
  return vault.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret }).id
}

describe('vault envelope — secrets are encrypted under the DEK (Route B P0-M4b)', () => {
  it('a stored secret cannot be decrypted with the master key directly', () => {
    const db = freshDb()
    const vault = new VaultStore(db, KEK)
    const id = makeEntry(vault, 'sk-secret')
    const blob = rawSecretEnc(db, id)
    // Under the KEK directly → fails (the row is under the DEK).
    expect(() => decryptSecret(KEK, blob)).toThrow(/vault_decrypt_failed|authentication tag/)
    // Under the DEK unwrapped from vault_meta → succeeds.
    const dek = unwrapDataKey(KEK, rawWrappedDek(db)!)
    expect(decryptSecret(dek, blob)).toBe('sk-secret')
  })

  it('persists a wrapped DEK row on first write; the value is neither the raw KEK nor raw DEK', () => {
    const db = freshDb()
    expect(rawWrappedDek(db)).toBeUndefined() // not seeded at migrate time
    const vault = new VaultStore(db, KEK)
    makeEntry(vault, 'x')
    const wrapped = rawWrappedDek(db)
    expect(wrapped).toBeTruthy()
    expect(wrapped).not.toBe(KEK.toString('base64'))
    expect(wrapped).not.toContain(KEK.toString('hex'))
    // unwraps to a real 32-byte key
    expect(unwrapDataKey(KEK, wrapped!)).toHaveLength(32)
  })
})

describe('vault envelope — reopen behaviour (Route B P0-M4b)', () => {
  it('a second store over the same db reads the secret by unwrapping the persisted DEK', () => {
    const db = freshDb()
    const id = makeEntry(new VaultStore(db, KEK), 'cross-open-secret')
    // Fresh instance → empty _dek cache → must unwrap the persisted DEK.
    const reopened = new VaultStore(db, KEK)
    expect(reopened.readVaultSecret(id)).toBe('cross-open-secret')
  })

  it('reopening with the WRONG master key fails closed (vault_decrypt_failed)', () => {
    const db = freshDb()
    const id = makeEntry(new VaultStore(db, KEK), 'secret')
    const wrong = randomBytes(32)
    let code: string | undefined
    try {
      new VaultStore(db, wrong).readVaultSecret(id)
    } catch (err) {
      code = (err as IdentityError).code
    }
    expect(code).toBe('vault_decrypt_failed')
  })
})

describe('vault envelope — legacy migration (Route B P0-M4b)', () => {
  it('re-encrypts a pre-envelope KEK-direct row under the DEK on first access', () => {
    const db = freshDb()
    // Simulate the old code: a vault row encrypted with the KEK directly,
    // and NO vault_meta row (no DEK ever existed).
    const legacyBlob = encryptSecret(KEK, 'legacy-secret')
    db.prepare(
      `INSERT INTO vault(id, kind, owner_kind, owner_id, label, secret_enc, metadata,
         created_at, last_used_at, revoked_at)
       VALUES(?, 'llm_provider', 'org', NULL, NULL, ?, NULL, ?, NULL, NULL)`,
    ).run('legacy1', legacyBlob, Date.now())
    expect(rawWrappedDek(db)).toBeUndefined()

    const vault = new VaultStore(db, KEK)
    // First access migrates it and returns the original plaintext.
    expect(vault.readVaultSecret('legacy1')).toBe('legacy-secret')
    // The DEK is now seeded and the row was re-encrypted (ciphertext changed).
    const wrapped = rawWrappedDek(db)
    expect(wrapped).toBeTruthy()
    const after = rawSecretEnc(db, 'legacy1')
    expect(after).not.toBe(legacyBlob)
    // And the new ciphertext is under the DEK, not the KEK.
    const dek = unwrapDataKey(KEK, wrapped!)
    expect(decryptSecret(dek, after)).toBe('legacy-secret')
    expect(() => decryptSecret(KEK, after)).toThrow()
  })

  it('a fresh empty vault seeds the DEK without error', () => {
    const db = freshDb()
    const vault = new VaultStore(db, KEK)
    const id = makeEntry(vault, 'fresh')
    expect(vault.readVaultSecret(id)).toBe('fresh')
    expect(rawWrappedDek(db)).toBeTruthy()
  })
})

describe('crypto envelope helpers (Route B P0-M4b)', () => {
  it('wrapDataKey / unwrapDataKey round-trip', () => {
    const dek = generateDataKey()
    expect(dek).toHaveLength(32)
    const wrapped = wrapDataKey(KEK, dek)
    expect(unwrapDataKey(KEK, wrapped).equals(dek)).toBe(true)
  })

  it('unwrap with the wrong KEK throws vault_decrypt_failed', () => {
    const wrapped = wrapDataKey(KEK, generateDataKey())
    expect(() => unwrapDataKey(randomBytes(32), wrapped)).toThrow(/vault_decrypt_failed|authentication tag/)
  })

  it('wrapDataKey with a wrong-length KEK throws invalid_input (fails before touching rows)', () => {
    expect(() => wrapDataKey(Buffer.alloc(8, 1), generateDataKey())).toThrow(IdentityError)
  })

  it('unwrapping a blob that decodes to a wrong-length key is rejected', () => {
    // A KEK-wrapped value whose plaintext is NOT a 32-byte key.
    const bogus = encryptSecret(KEK, Buffer.from('too-short').toString('base64'))
    expect(() => unwrapDataKey(KEK, bogus)).toThrow(/wrong length|vault_decrypt_failed/)
  })
})
