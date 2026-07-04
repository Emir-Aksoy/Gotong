import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  probeVaultMasterKey,
} from '../src/index.js'

/**
 * Route B P0-M5 — `probeVaultMasterKey` is the authority the host's
 * interrupted-rotation recovery asks "does this key unwrap the stored DEK?".
 * These pin the three answers it must distinguish so the recovery can promote
 * the staged key only when it is genuinely the one the DB was re-wrapped under:
 *   - the correct KEK → 'ok'
 *   - a different / truncated KEK while a DEK exists → 'mismatch'
 *   - no DB / no seeded DEK → 'no-vault' (no secret at risk)
 * The unwrap verdict is the load-bearing guard; falsifying it (always 'ok')
 * turns every 'mismatch' assertion red.
 */

const KEK = Buffer.alloc(MASTER_KEY_LEN_BYTES, 0xab)

describe('probeVaultMasterKey (Route B P0-M5)', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gotong-mk-probe-'))
    dbPath = join(dir, 'identity.sqlite')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Open a store under `key`, seed a vault entry (which seeds the DEK), close. */
  function seedVault(key: Buffer): void {
    const store = openIdentityStore({ dbPath, masterKey: key })
    try {
      store.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret: 'sk-xyz' })
    } finally {
      store.close()
    }
  }

  it("returns 'no-vault' when the DB file does not exist", () => {
    expect(probeVaultMasterKey(join(dir, 'absent.sqlite'), KEK)).toBe('no-vault')
  })

  it("returns 'no-vault' when the DB exists but the vault was never used", () => {
    // Open + close without ever touching the vault — no DEK row is seeded.
    const store = openIdentityStore({ dbPath, masterKey: KEK })
    store.close()
    expect(probeVaultMasterKey(dbPath, KEK)).toBe('no-vault')
  })

  it("returns 'ok' for the key the DEK was wrapped under", () => {
    seedVault(KEK)
    expect(probeVaultMasterKey(dbPath, KEK)).toBe('ok')
  })

  it("returns 'mismatch' for a different 32-byte key", () => {
    seedVault(KEK)
    const wrong = Buffer.alloc(MASTER_KEY_LEN_BYTES, 0xcd)
    expect(probeVaultMasterKey(dbPath, wrong)).toBe('mismatch')
  })

  it("returns 'mismatch' for a truncated / wrong-length key (torn .next)", () => {
    seedVault(KEK)
    // A crash mid-write of `<keyfile>.next` can leave a short, partial key.
    expect(probeVaultMasterKey(dbPath, randomBytes(7))).toBe('mismatch')
  })
})
