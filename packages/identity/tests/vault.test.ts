/**
 * Tests for A1 — vault (encrypted application-layer secret storage).
 *
 * Coverage:
 *   - crypto round-trip + tamper detection + wrong-key rejection
 *   - loadOrCreateMasterKey: first-run generation + reuse + length check
 *   - createVaultEntry validation (kind / ownerKind / ownerId / secret /
 *     metadata size)
 *   - listVaultEntries filter (kind / ownerKind / ownerId-null / activeOnly)
 *   - readVaultSecret: decrypts + touches last_used_at + refuses revoked
 *   - revokeVaultEntry: soft-delete + idempotence + missing-id rejection
 *   - vault_not_configured: openIdentityStore without masterKey
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  IdentityError,
  IdentityStore,
  MASTER_KEY_LEN_BYTES,
  loadOrCreateMasterKey,
  openIdentityStore,
} from '../src/index.js'
import {
  decryptSecret,
  encryptSecret,
} from '../src/crypto.js'

const FIXED_KEY = Buffer.alloc(MASTER_KEY_LEN_BYTES, 0xab) // deterministic

describe('crypto primitives', () => {
  it('encrypt / decrypt round-trip recovers the original plaintext', () => {
    const blob = encryptSecret(FIXED_KEY, 'sk-ant-secret-key-12345')
    expect(blob.startsWith('v1.gcm$')).toBe(true)
    expect(blob.split('$').length).toBe(4)
    const got = decryptSecret(FIXED_KEY, blob)
    expect(got).toBe('sk-ant-secret-key-12345')
  })

  it('two encrypts of the same plaintext produce different blobs (nonce randomness)', () => {
    const a = encryptSecret(FIXED_KEY, 'hello')
    const b = encryptSecret(FIXED_KEY, 'hello')
    expect(a).not.toBe(b)
    expect(decryptSecret(FIXED_KEY, a)).toBe('hello')
    expect(decryptSecret(FIXED_KEY, b)).toBe('hello')
  })

  it('tampered ciphertext throws vault_decrypt_failed', () => {
    const blob = encryptSecret(FIXED_KEY, 'original')
    const parts = blob.split('$')
    // Flip one base64url char in the ciphertext section. Picking 'A'
    // ensures the result is still valid base64url (collision-resistant
    // to the validity check we'd otherwise short-circuit on).
    const ct = parts[2]
    parts[2] = ct[0] === 'A' ? 'B' + ct.slice(1) : 'A' + ct.slice(1)
    const tampered = parts.join('$')
    expect(() => decryptSecret(FIXED_KEY, tampered)).toThrow(IdentityError)
    try {
      decryptSecret(FIXED_KEY, tampered)
    } catch (err) {
      expect((err as IdentityError).code).toBe('vault_decrypt_failed')
    }
  })

  it('wrong master key throws vault_decrypt_failed', () => {
    const blob = encryptSecret(FIXED_KEY, 'secret')
    const otherKey = Buffer.alloc(MASTER_KEY_LEN_BYTES, 0xcd)
    expect(() => decryptSecret(otherKey, blob)).toThrow(/vault_decrypt_failed|authentication tag/)
  })

  it('unknown version prefix throws vault_decrypt_failed', () => {
    expect(() => decryptSecret(FIXED_KEY, 'v9.unknown$aa$bb$cc')).toThrow(IdentityError)
  })

  it('malformed blob (wrong part count) throws vault_decrypt_failed', () => {
    expect(() => decryptSecret(FIXED_KEY, 'not-a-blob')).toThrow(IdentityError)
    expect(() => decryptSecret(FIXED_KEY, 'v1.gcm$only$three')).toThrow(IdentityError)
  })

  it('wrong-length master key throws invalid_input on encrypt and decrypt', () => {
    const shortKey = Buffer.alloc(16, 0x01)
    expect(() => encryptSecret(shortKey, 'x')).toThrow(IdentityError)
    expect(() => decryptSecret(shortKey, encryptSecret(FIXED_KEY, 'x'))).toThrow(
      IdentityError,
    )
  })
})

describe('loadOrCreateMasterKey', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aipehub-vault-test-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('first run generates a 32-byte file at the path (creating parent dirs)', () => {
    const path = join(tmp, 'nested', 'subdir', 'master.key')
    const key = loadOrCreateMasterKey(path)
    expect(key.length).toBe(MASTER_KEY_LEN_BYTES)
    const onDisk = readFileSync(path)
    expect(onDisk.equals(key)).toBe(true)
    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777
      expect(mode).toBe(0o600) // owner-only
    }
  })

  it('second run with existing file returns the same key (no rotation)', () => {
    const path = join(tmp, 'master.key')
    const first = loadOrCreateMasterKey(path)
    const second = loadOrCreateMasterKey(path)
    expect(first.equals(second)).toBe(true)
  })

  it('existing file with wrong length throws invalid_input', () => {
    const path = join(tmp, 'master.key')
    writeFileSync(path, Buffer.alloc(16, 0x01)) // half the required length
    expect(() => loadOrCreateMasterKey(path)).toThrow(IdentityError)
  })
})

describe('IdentityStore.vault', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:', masterKey: FIXED_KEY })
  })
  afterEach(() => {
    store.close()
  })

  describe('createVaultEntry', () => {
    it('creates org-level llm_provider entry with metadata', () => {
      const entry = store.createVaultEntry({
        kind: 'llm_provider',
        ownerKind: 'org',
        secret: 'sk-ant-prod-key',
        label: 'Anthropic prod',
        metadata: { provider: 'anthropic', model: 'claude-opus-4' },
      })
      expect(entry.id).toBeTypeOf('string')
      expect(entry.kind).toBe('llm_provider')
      expect(entry.ownerKind).toBe('org')
      expect(entry.ownerId).toBeNull()
      expect(entry.label).toBe('Anthropic prod')
      expect(entry.metadata).toEqual({ provider: 'anthropic', model: 'claude-opus-4' })
      expect(entry.lastUsedAt).toBeNull()
      expect(entry.revokedAt).toBeNull()
    })

    it('creates user-owned entry with explicit ownerId', () => {
      const entry = store.createVaultEntry({
        kind: 'third_party_api',
        ownerKind: 'user',
        ownerId: 'alice-id',
        secret: 'personal-token',
      })
      expect(entry.ownerKind).toBe('user')
      expect(entry.ownerId).toBe('alice-id')
    })

    it('creates peer-owned entry with peer hub id', () => {
      const entry = store.createVaultEntry({
        kind: 'peer_token',
        ownerKind: 'peer',
        ownerId: 'widgets-hub',
        secret: 'shared-peer-secret-very-long-string',
      })
      expect(entry.ownerKind).toBe('peer')
      expect(entry.ownerId).toBe('widgets-hub')
    })

    it('rejects unknown kind', () => {
      expect(() =>
        store.createVaultEntry({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          kind: 'bogus' as any,
          ownerKind: 'org',
          secret: 'x',
        }),
      ).toThrow(IdentityError)
    })

    it('rejects unknown ownerKind', () => {
      expect(() =>
        store.createVaultEntry({
          kind: 'llm_provider',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ownerKind: 'galaxy' as any,
          secret: 'x',
        }),
      ).toThrow(IdentityError)
    })

    it('rejects org-owned entry with non-null ownerId (misclassification guard)', () => {
      expect(() =>
        store.createVaultEntry({
          kind: 'llm_provider',
          ownerKind: 'org',
          ownerId: 'should-not-be-here',
          secret: 'x',
        }),
      ).toThrow(/ownerKind=org must have null ownerId/)
    })

    it('rejects user-owned entry without ownerId', () => {
      expect(() =>
        store.createVaultEntry({
          kind: 'llm_provider',
          ownerKind: 'user',
          secret: 'x',
        }),
      ).toThrow(/requires non-empty ownerId/)
    })

    it('rejects empty secret', () => {
      expect(() =>
        store.createVaultEntry({
          kind: 'llm_provider',
          ownerKind: 'org',
          secret: '',
        }),
      ).toThrow(IdentityError)
    })

    it('rejects oversize metadata (>8KB serialised)', () => {
      const big = { blob: 'x'.repeat(9000) }
      expect(() =>
        store.createVaultEntry({
          kind: 'llm_provider',
          ownerKind: 'org',
          secret: 'x',
          metadata: big,
        }),
      ).toThrow(/metadata too large/)
    })
  })

  describe('readVaultSecret', () => {
    it('returns the original plaintext and touches last_used_at', async () => {
      const entry = store.createVaultEntry({
        kind: 'llm_provider',
        ownerKind: 'org',
        secret: 'sk-ant-roundtrip',
      })
      expect(store.getVaultEntry(entry.id)?.lastUsedAt).toBeNull()
      // sleep a tick so last_used_at differs from created_at on
      // very fast machines (Date.now() resolution = 1ms).
      await new Promise((r) => setTimeout(r, 2))
      const plaintext = store.readVaultSecret(entry.id)
      expect(plaintext).toBe('sk-ant-roundtrip')
      const after = store.getVaultEntry(entry.id)!
      expect(after.lastUsedAt).not.toBeNull()
      expect(after.lastUsedAt!).toBeGreaterThanOrEqual(after.createdAt)
    })

    it('throws vault_entry_not_found on unknown id', () => {
      expect(() => store.readVaultSecret('does-not-exist')).toThrow(IdentityError)
      try {
        store.readVaultSecret('does-not-exist')
      } catch (err) {
        expect((err as IdentityError).code).toBe('vault_entry_not_found')
      }
    })

    it('refuses to decrypt a revoked entry', () => {
      const entry = store.createVaultEntry({
        kind: 'llm_provider',
        ownerKind: 'org',
        secret: 'will-be-revoked',
      })
      store.revokeVaultEntry(entry.id)
      expect(() => store.readVaultSecret(entry.id)).toThrow(IdentityError)
    })
  })

  describe('listVaultEntries', () => {
    beforeEach(() => {
      store.createVaultEntry({
        kind: 'llm_provider',
        ownerKind: 'org',
        secret: 'a',
        label: 'org-llm',
      })
      store.createVaultEntry({
        kind: 'llm_provider',
        ownerKind: 'user',
        ownerId: 'alice',
        secret: 'b',
        label: 'alice-llm',
      })
      store.createVaultEntry({
        kind: 'peer_token',
        ownerKind: 'peer',
        ownerId: 'widgets-hub',
        secret: 'c',
        label: 'peer-token',
      })
      const toRevoke = store.createVaultEntry({
        kind: 'mcp_server',
        ownerKind: 'org',
        secret: 'd',
        label: 'revoked-mcp',
      })
      store.revokeVaultEntry(toRevoke.id)
    })

    it('returns all active rows by default (revoked excluded)', () => {
      const list = store.listVaultEntries()
      expect(list.length).toBe(3) // 4 created, 1 revoked
      expect(list.every((e) => e.revokedAt === null)).toBe(true)
    })

    it('activeOnly:false includes revoked rows', () => {
      const list = store.listVaultEntries({ activeOnly: false })
      expect(list.length).toBe(4)
      expect(list.some((e) => e.revokedAt !== null)).toBe(true)
    })

    it('kind filter narrows correctly', () => {
      const list = store.listVaultEntries({ kind: 'llm_provider' })
      expect(list.length).toBe(2)
      expect(list.every((e) => e.kind === 'llm_provider')).toBe(true)
    })

    it('ownerKind filter narrows correctly', () => {
      const list = store.listVaultEntries({ ownerKind: 'peer' })
      expect(list.length).toBe(1)
      expect(list[0]!.ownerKind).toBe('peer')
    })

    it('ownerId=null filter returns org-owned rows', () => {
      const list = store.listVaultEntries({ ownerKind: 'org', ownerId: null })
      expect(list.length).toBe(1)
      expect(list[0]!.label).toBe('org-llm')
    })

    it('ownerId="alice" filter returns alice-owned rows', () => {
      const list = store.listVaultEntries({ ownerKind: 'user', ownerId: 'alice' })
      expect(list.length).toBe(1)
      expect(list[0]!.label).toBe('alice-llm')
    })
  })

  describe('revokeVaultEntry', () => {
    it('soft-deletes the entry (revoked_at populated)', () => {
      const entry = store.createVaultEntry({
        kind: 'llm_provider',
        ownerKind: 'org',
        secret: 'x',
      })
      store.revokeVaultEntry(entry.id)
      const after = store.getVaultEntry(entry.id)!
      expect(after.revokedAt).not.toBeNull()
    })

    it('is idempotent (second revoke is a no-op, not an error)', () => {
      const entry = store.createVaultEntry({
        kind: 'llm_provider',
        ownerKind: 'org',
        secret: 'x',
      })
      store.revokeVaultEntry(entry.id)
      const firstRevokedAt = store.getVaultEntry(entry.id)!.revokedAt
      // second revoke does NOT update the timestamp (guarded UPDATE).
      store.revokeVaultEntry(entry.id)
      const secondRevokedAt = store.getVaultEntry(entry.id)!.revokedAt
      expect(secondRevokedAt).toBe(firstRevokedAt)
    })

    it('throws vault_entry_not_found on unknown id', () => {
      expect(() => store.revokeVaultEntry('nope')).toThrow(IdentityError)
    })
  })
})

describe('IdentityStore.vault — without masterKey', () => {
  let store: IdentityStore
  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:' }) // no masterKey
  })
  afterEach(() => {
    store.close()
  })

  it('createVaultEntry throws vault_not_configured', () => {
    expect(() =>
      store.createVaultEntry({
        kind: 'llm_provider',
        ownerKind: 'org',
        secret: 'x',
      }),
    ).toThrow(IdentityError)
    try {
      store.createVaultEntry({
        kind: 'llm_provider',
        ownerKind: 'org',
        secret: 'x',
      })
    } catch (err) {
      expect((err as IdentityError).code).toBe('vault_not_configured')
    }
  })

  it('readVaultSecret throws vault_not_configured', () => {
    expect(() => store.readVaultSecret('any-id')).toThrow(IdentityError)
    try {
      store.readVaultSecret('any-id')
    } catch (err) {
      expect((err as IdentityError).code).toBe('vault_not_configured')
    }
  })

  it('listVaultEntries works without a key (does not decrypt)', () => {
    // listing is allowed sans key because it never touches secret_enc.
    // Useful for an admin UI that just wants to show "what vault rows
    // exist" before any user clicks "reveal".
    expect(store.listVaultEntries()).toEqual([])
  })

  it('non-Buffer masterKey at openIdentityStore is a TypeError', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openIdentityStore({ dbPath: ':memory:', masterKey: 'string-not-buffer' as any }),
    ).toThrow(TypeError)
  })

  it('masterKey of wrong length surfaces on first encrypt call', () => {
    const badStore = openIdentityStore({
      dbPath: ':memory:',
      masterKey: Buffer.alloc(8, 0x01), // too short
    })
    expect(() =>
      badStore.createVaultEntry({
        kind: 'llm_provider',
        ownerKind: 'org',
        secret: 'x',
      }),
    ).toThrow(IdentityError)
    badStore.close()
  })
})

describe('crypto + store integration', () => {
  it('a row encrypted with one masterKey cannot be read with another', () => {
    const keyA = randomBytes(MASTER_KEY_LEN_BYTES)
    const keyB = randomBytes(MASTER_KEY_LEN_BYTES)

    // Write the row with keyA
    const storeA = openIdentityStore({ dbPath: ':memory:', masterKey: keyA })
    const entry = storeA.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'cross-key-secret',
    })
    expect(storeA.readVaultSecret(entry.id)).toBe('cross-key-secret')

    // Manually copy the row across by re-running encrypt/decrypt against
    // the OTHER store's key. This validates the per-store master-key
    // isolation property — share the .sqlite without the .key and you
    // can't decrypt.
    const blob = encryptSecret(keyA, 'cross-key-secret')
    expect(() => decryptSecret(keyB, blob)).toThrow(IdentityError)
    storeA.close()
  })
})
