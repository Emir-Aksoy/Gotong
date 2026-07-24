import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  probeVaultMasterKey,
} from '../src/index.js'
import { encryptSecret } from '../src/crypto.js'
import { openDb } from '../src/db.js'

/**
 * Route B P0-M5 — `probeVaultMasterKey` is the authority the host's
 * interrupted-rotation recovery asks "does this key unwrap the stored DEK?".
 * These pin the four answers it must distinguish so the recovery can promote
 * the staged key only when it is genuinely the one the DB was re-wrapped under:
 *   - the correct KEK → 'ok'
 *   - a different / truncated KEK while a DEK exists → 'mismatch'
 *   - no DB / no seeded DEK → 'no-vault' (no secret at risk)
 *   - a DB file that EXISTS but won't open → 'unreadable' (a DEK may be in
 *     there; callers deciding bind/discard must fail closed, never guess)
 * The unwrap verdict is the load-bearing guard; falsifying it (always 'ok')
 * turns every 'mismatch' assertion red. The 'unreadable' split is load-bearing
 * for B①: folding it into 'no-vault' once let a torn identity.sqlite read as
 * "KEK unprovable, nothing at risk" and unlock paths that discard keys.
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

  it("returns 'unreadable' (NOT 'no-vault') when the DB file exists but is junk", () => {
    // A torn restore / disk corruption can leave bytes that aren't SQLite at
    // the DB path. A DEK may still be behind the failure — reporting
    // 'no-vault' here would tell callers "nothing at risk", unlocking paths
    // that bind fresh keys or discard staged ones over a live-but-sick vault.
    writeFileSync(dbPath, 'this is not a sqlite database\n')
    expect(probeVaultMasterKey(dbPath, KEK)).toBe('unreadable')
  })

  it("still returns 'no-vault' for a genuinely absent DB (unreadable split didn't widen it)", () => {
    // Companion to the junk-file case: the 'unreadable' split must not make
    // the probe paranoid about ABSENT DBs — fresh spaces and pre-v4 upgrades
    // legitimately have no identity.sqlite, and binding there is by design.
    expect(probeVaultMasterKey(join(dir, 'never-created.sqlite'), KEK)).toBe('no-vault')
  })

  it("returns 'unreadable' (NOT 'no-vault') when `vault` is a broken VIEW over a missing table", () => {
    // SQLite reports a view's missing DEPENDENCY with the same "no such
    // table:" wording as a directly missing table — but naming the BACKING
    // table ("main.missing_backing"), not the one we queried. An unpinned
    // matcher once read that as "the vault table is absent" and answered
    // 'no-vault' for a mangled DB that may hold secrets behind the wreckage.
    openIdentityStore({ dbPath, masterKey: KEK }).close()
    const raw = openDb(dbPath)
    raw.exec('DROP TABLE vault; CREATE VIEW vault AS SELECT * FROM missing_backing')
    raw.close()
    expect(probeVaultMasterKey(dbPath, KEK)).toBe('unreadable')
  })

  it("returns 'unreadable' when vault_meta exists but the query fails (hostile schema)", () => {
    // Only a MISSING table proves the DEK's absence. Any other query failure
    // (corrupt pages, wrong columns) may be hiding a vault — reporting
    // 'no-vault' there would fail open. Simulate: replace vault_meta with a
    // same-named table that lacks the `value` column → "no such column".
    openIdentityStore({ dbPath, masterKey: KEK }).close()
    const raw = openDb(dbPath)
    raw.exec('DROP TABLE vault_meta; CREATE TABLE vault_meta (k TEXT)')
    raw.close()
    expect(probeVaultMasterKey(dbPath, KEK)).toBe('unreadable')
  })

  describe('pre-envelope vaults (rows exist, DEK never seeded)', () => {
    /**
     * Before the envelope migration, vault rows were encrypted with the KEK
     * DIRECTLY and no vault_meta DEK row exists (vault-store's requireDek
     * migrates them lazily). A DEK-less vault with rows is therefore NOT
     * empty — 'no-vault' here once let a keyless restore read as "nothing at
     * risk" and bind fresh keys over live-but-unprovable secrets. The rows
     * themselves prove or disprove the key by trial decryption.
     */
    function seedPreEnvelopeRow(): void {
      // Full schema, but never touch the vault → no DEK row is seeded.
      openIdentityStore({ dbPath, masterKey: KEK }).close()
      const raw = openDb(dbPath)
      raw
        .prepare(
          `INSERT INTO vault(id, kind, owner_kind, owner_id, label, secret_enc, metadata,
             created_at, last_used_at, revoked_at)
           VALUES(?, 'llm_provider', 'org', NULL, NULL, ?, NULL, ?, NULL, NULL)`,
        )
        .run('legacy1', encryptSecret(KEK, 'legacy-secret'), Date.now())
      raw.close()
    }

    it("returns 'ok' for the KEK the legacy rows are encrypted under", () => {
      seedPreEnvelopeRow()
      expect(probeVaultMasterKey(dbPath, KEK)).toBe('ok')
    })

    it("returns 'mismatch' (NOT 'no-vault') for a wrong key against legacy rows", () => {
      seedPreEnvelopeRow()
      const wrong = Buffer.alloc(MASTER_KEY_LEN_BYTES, 0xcd)
      expect(probeVaultMasterKey(dbPath, wrong)).toBe('mismatch')
    })
  })
})
