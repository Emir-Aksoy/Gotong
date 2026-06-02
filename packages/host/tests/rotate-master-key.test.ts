import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openIdentityStore } from '@aipehub/identity'

import {
  IDENTITY_DB_FILENAME,
  MASTER_KEY_FILENAME,
  rotateMasterKey,
} from '../src/rotate-master-key.js'

/**
 * Route B P0-M4d — the operator-facing `rotate-master-key` orchestration. M4c
 * pinned the store mechanism (re-wrap the data key, byte-identical ciphertext);
 * this pins the CLI flow end to end against a real file-based workspace: the new
 * key is persisted to the key file, the vault opens with it on the next boot,
 * the OLD key is retired, and a misconfigured / failed rotation never
 * half-rotates. Each assertion is falsifiable — neutralise a guard and a
 * specific expectation goes RED.
 */

const K_OLD = Buffer.alloc(32, 0x11)
const K_NEW = Buffer.alloc(32, 0x22)

let dir: string
let keyFile: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aipe-rotcli-'))
  keyFile = join(dir, MASTER_KEY_FILENAME)
  dbPath = join(dir, IDENTITY_DB_FILENAME)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Seed the workspace: a 0600 key file + one vault secret under K_OLD. */
function seed(secret: string): string {
  writeFileSync(keyFile, K_OLD, { mode: 0o600 })
  const s = openIdentityStore({ dbPath, masterKey: K_OLD })
  const id = s.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret }).id
  s.close()
  return id
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (err) {
    return (err as { code?: string }).code
  }
}

describe('rotateMasterKey (Route B P0-M4d)', () => {
  it('persists the new key, opens on next boot, and retires the old key', () => {
    const id = seed('sk-live')

    rotateMasterKey({ spaceDir: dir, generateKey: () => K_NEW })

    // The live key file now holds the NEW key (step 3 promote ran).
    expect(readFileSync(keyFile).equals(K_NEW)).toBe(true)
    // The staged file was renamed away — no leftover.
    expect(existsSync(`${keyFile}.next`)).toBe(false)

    // Simulate the next boot: load the key from the file → vault opens.
    const next = openIdentityStore({ dbPath, masterKey: readFileSync(keyFile) })
    expect(next.readVaultSecret(id)).toBe('sk-live')
    next.close()

    // The OLD key no longer unwraps the data key.
    const stale = openIdentityStore({ dbPath, masterKey: K_OLD })
    expect(codeOf(() => stale.readVaultSecret(id))).toBe('vault_decrypt_failed')
    stale.close()
  })

  it('refuses a non-local-file provider and mutates nothing', () => {
    const id = seed('sk-env')

    expect(() =>
      rotateMasterKey({
        spaceDir: dir,
        providerKind: 'env',
        envKeyMaterial: K_OLD.toString('hex'),
        generateKey: () => K_NEW,
      }),
    ).toThrow(/local-file/)

    // Key file untouched, vault still opens with the original key.
    expect(readFileSync(keyFile).equals(K_OLD)).toBe(true)
    const s = openIdentityStore({ dbPath, masterKey: K_OLD })
    expect(s.readVaultSecret(id)).toBe('sk-env')
    s.close()
  })

  it('refuses to rotate to a key identical to the current one', () => {
    seed('sk-same')
    // The RNG handing back the current key is almost certainly a bug; a no-op
    // rotation would retire nothing.
    expect(() => rotateMasterKey({ spaceDir: dir, generateKey: () => K_OLD })).toThrow(
      /identical/,
    )
  })

  it('a wrong-length generated key throws and does not half-rotate', () => {
    const id = seed('sk-safe')

    expect(() =>
      rotateMasterKey({ spaceDir: dir, generateKey: () => Buffer.alloc(8, 1) }),
    ).toThrow(/32 bytes/)

    // No staged key left behind, key file unchanged, vault still opens.
    expect(existsSync(`${keyFile}.next`)).toBe(false)
    expect(readFileSync(keyFile).equals(K_OLD)).toBe(true)
    const s = openIdentityStore({ dbPath, masterKey: K_OLD })
    expect(s.readVaultSecret(id)).toBe('sk-safe')
    s.close()
  })

  it('chained rotations: only the latest key opens the vault', () => {
    const id = seed('sk-chain')
    const K_MID = Buffer.alloc(32, 0x33)

    rotateMasterKey({ spaceDir: dir, generateKey: () => K_MID })
    rotateMasterKey({ spaceDir: dir, generateKey: () => K_NEW })

    const latest = openIdentityStore({ dbPath, masterKey: K_NEW })
    expect(latest.readVaultSecret(id)).toBe('sk-chain')
    latest.close()

    for (const retired of [K_OLD, K_MID]) {
      const s = openIdentityStore({ dbPath, masterKey: retired })
      expect(codeOf(() => s.readVaultSecret(id))).toBe('vault_decrypt_failed')
      s.close()
    }
  })
})
