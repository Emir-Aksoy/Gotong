/**
 * Route B P0-M5 — vault master-key (KEK) probe for interrupted-rotation
 * recovery.
 *
 * Online KEK rotation (P0-M4d) is crash-safe by ordering: stage the new key to
 * `<keyfile>.next`, re-wrap the DEK in the DB under it, then promote `.next`
 * over the live key file. A crash between the re-wrap and the promote leaves the
 * DB wrapped under the NEW key while the live file still holds the OLD one — and
 * the live key can no longer unwrap the DEK, so the vault is bricked on boot
 * until someone moves `.next` into place.
 *
 * The host's boot recovery (P0-M5, host side) decides which of the live vs
 * staged key is the real one by asking exactly one question of each: *does this
 * key unwrap the stored DEK?* That is what this probe answers. It is the only
 * authority on the question because the DEK wrap format lives here (crypto.ts);
 * keeping the probe in identity stops the host from re-implementing AEAD
 * details it has no business knowing.
 */

import { existsSync } from 'node:fs'

import { unwrapDataKey } from './crypto.js'
import { openDb } from './db.js'
import { VAULT_DEK_META_KEY } from './vault-store.js'

export type MasterKeyProbeResult =
  /** The key unwraps the stored DEK — it is the live vault KEK. */
  | 'ok'
  /** A wrapped DEK exists but this key fails to unwrap it (wrong/old KEK). */
  | 'mismatch'
  /** No DB / no `vault_meta` / no DEK row — no secret is at risk either way. */
  | 'no-vault'

/**
 * Does `key` unwrap the vault DEK stored in the identity DB at `dbPath`?
 *
 * Read-only: opens the DB, reads one row, never migrates and never writes.
 * Returns `'no-vault'` (not an error) when there is nothing to protect — a
 * missing DB, a pre-envelope schema with no `vault_meta` table, or a fresh DB
 * whose DEK has not been seeded yet (the DEK is created lazily on first vault
 * use). A wrong-length or garbage `key` reads as `'mismatch'`, never throws —
 * the caller hands us a staged `.next` file that a crash may have truncated.
 */
export function probeVaultMasterKey(dbPath: string, key: Buffer): MasterKeyProbeResult {
  // A DB that isn't there yet can't hold a secret; opening would *create* one.
  if (dbPath !== ':memory:' && !existsSync(dbPath)) return 'no-vault'

  let db
  try {
    db = openDb(dbPath)
  } catch {
    // Unopenable (locked / not a DB / native binding missing) — treat as
    // nothing-to-recover rather than crashing the boot recovery.
    return 'no-vault'
  }
  try {
    let row: { value: string } | undefined
    try {
      row = db.prepare('SELECT value FROM vault_meta WHERE key = ?').get(VAULT_DEK_META_KEY) as
        | { value: string }
        | undefined
    } catch {
      // `vault_meta` table absent (older schema / never migrated) → no DEK.
      return 'no-vault'
    }
    if (!row) return 'no-vault'
    try {
      unwrapDataKey(key, row.value)
      return 'ok'
    } catch {
      // Wrong KEK (GCM auth tag mismatch) or a wrong-length / garbage key.
      return 'mismatch'
    }
  } finally {
    db.close()
  }
}
