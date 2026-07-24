/**
 * Route B P0-M5 — vault master-key (KEK) probe for interrupted-rotation
 * recovery.
 *
 * KEK rotation (P0-M4d, stopped-host) is crash-safe by ordering: stage the new key to
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

import { decryptSecret, unwrapDataKey } from './crypto.js'
import { openDb } from './db.js'
import { VAULT_DEK_META_KEY } from './vault-store.js'

export type MasterKeyProbeResult =
  /** The key unwraps the stored DEK (or decrypts a pre-envelope row) — it is the live vault KEK. */
  | 'ok'
  /** Vault ciphertext exists (wrapped DEK or legacy row) but this key fails against it. */
  | 'mismatch'
  /** No DB / no vault tables / zero vault rows and no DEK — nothing to protect either way. */
  | 'no-vault'
  /** DB file EXISTS but can't be opened or queried — a vault may be in there; can't tell. */
  | 'unreadable'

/**
 * "THE table we queried doesn't exist" is the ONLY query failure that proves
 * absence. The name is pinned because SQLite uses the same wording for a
 * missing *dependency* — e.g. a broken VIEW named `vault` over a dropped
 * backing table reports "no such table: main.<backing>" — and treating that
 * as the vault's absence would fail open on exactly the mangled-DB shapes the
 * 'unreadable' verdict exists for.
 */
function isMissingTable(err: unknown, table: 'vault_meta' | 'vault'): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return new RegExp(`no such table: (?:main\\.)?${table}$`, 'i').test(msg.trim())
}

/**
 * Does `key` unwrap the vault DEK stored in the identity DB at `dbPath`?
 *
 * Read-only: opens the DB, reads at most two rows, never migrates and never
 * writes. Returns `'no-vault'` (not an error) ONLY when there is provably
 * nothing to protect — a missing DB, a schema with no vault tables, or an
 * empty vault with no seeded DEK. Two states that LOOK empty are not:
 *   - a DB file that won't open (or whose tables won't query) is
 *     `'unreadable'` — a torn restore may hold a vault we just can't see, and
 *     callers deciding "safe to (re)bind / discard keys" must fail closed;
 *   - a DEK-less vault WITH rows predates the envelope (rows are KEK-direct,
 *     see vault-store's requireDek migration loop) — those rows prove or
 *     disprove the key by trial decryption exactly like the DEK wrap would.
 * A wrong-length or garbage `key` reads as `'mismatch'`, never throws —
 * the caller hands us a staged `.next` file that a crash may have truncated.
 */
export function probeVaultMasterKey(dbPath: string, key: Buffer): MasterKeyProbeResult {
  // A DB that isn't there yet can't hold a secret; opening would *create* one.
  if (dbPath !== ':memory:' && !existsSync(dbPath)) return 'no-vault'

  let db
  try {
    db = openDb(dbPath)
  } catch {
    // Unopenable (locked / not a DB / native binding missing): evidence of a
    // vault may exist behind the failure — report it, never guess it away.
    return 'unreadable'
  }
  try {
    let row: { value: string } | undefined
    try {
      row = db.prepare('SELECT value FROM vault_meta WHERE key = ?').get(VAULT_DEK_META_KEY) as
        | { value: string }
        | undefined
    } catch (err) {
      // Only a MISSING table (older schema / never migrated) proves no DEK.
      // Any other failure (corrupt pages, hostile schema) hides evidence —
      // fail closed as 'unreadable', never guess it away as 'no-vault'.
      if (!isMissingTable(err, 'vault_meta')) return 'unreadable'
    }
    if (!row) {
      // No DEK row. The vault is NOT automatically empty: rows written before
      // the envelope migration are encrypted with the KEK directly and the
      // DEK is only seeded lazily on first vault use. One row is enough for a
      // verdict — DEK-less rows are all KEK-direct by construction.
      let legacy: { secret_enc: string } | undefined
      try {
        legacy = db.prepare('SELECT secret_enc FROM vault LIMIT 1').get() as
          | { secret_enc: string }
          | undefined
      } catch (err) {
        if (isMissingTable(err, 'vault')) return 'no-vault'
        return 'unreadable'
      }
      if (!legacy) return 'no-vault'
      try {
        decryptSecret(key, legacy.secret_enc)
        return 'ok'
      } catch {
        // Wrong KEK against a live pre-envelope row — same stakes as a
        // wrapped-DEK mismatch: this key must not be treated as provable.
        return 'mismatch'
      }
    }
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
