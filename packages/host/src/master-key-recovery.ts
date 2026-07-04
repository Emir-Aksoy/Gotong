/**
 * Route B P0-M5 — boot recovery for an interrupted master-key (KEK) rotation.
 *
 * `rotate-master-key.ts` (P0-M4d) rotates the local-file KEK in three ordered
 * steps: stage the new key to `<keyfile>.next`, re-wrap the DEK in the DB under
 * it, then promote `.next` over the live key file. It is crash-safe by ordering
 * — the new key always reaches disk before the DB commit — but it deliberately
 * left the *recovery* to this milestone. The dangerous window is between the DB
 * re-wrap and the promote: the DB is now under the NEW key while the live file
 * still holds the OLD one, so the OLD key can no longer unwrap the vault and the
 * host boots into a bricked vault until `.next` is moved into place by hand.
 *
 * This runs at boot, BEFORE the live key is loaded, and finishes (or unwinds)
 * an interrupted rotation deterministically by asking identity's probe which
 * key actually unwraps the stored DEK:
 *   - live key unwraps it (or there is no DEK at risk) → the rotation never
 *     committed; the staged key is stale → DISCARD `.next`.
 *   - live key fails but the staged key unwraps it → the DB was re-wrapped under
 *     the staged key → PROMOTE `.next` over the live file (finish the rotation).
 *   - neither unwraps it → genuine corruption (or a torn `.next` with the live
 *     key also gone) → leave both files untouched so the normal boot fails
 *     loudly; we never guess with the vault key.
 *
 * local-file only: env / kms-stub keys live outside the workspace, so there is
 * no `.next` file to reconcile (rotation there is an out-of-band change).
 */

import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { probeVaultMasterKey } from '@gotong/identity'

// Reuse the rotation command's filenames so the two can never drift apart.
import { IDENTITY_DB_FILENAME, MASTER_KEY_FILENAME } from './rotate-master-key.js'

export type RotationRecoveryAction =
  /** No staged key (or non-local-file provider) — nothing to reconcile. */
  | 'none'
  /** Live key still unwraps the DEK (or no DEK) — stale `.next` removed. */
  | 'discarded'
  /** Staged key unwraps the DEK — promoted over the live file. */
  | 'promoted'
  /** Neither key unwraps the DEK — left untouched for an operator. */
  | 'inconclusive'

export interface RotationRecoveryResult {
  action: RotationRecoveryAction
  reason: string
}

/**
 * Reconcile a possibly-interrupted local-file KEK rotation in `spaceDir`.
 * Pure filesystem + a read-only DEK probe — safe to call on every boot; with
 * no `<keyfile>.next` present it is a no-op (`action: 'none'`).
 */
export function recoverMasterKeyRotation(
  spaceDir: string,
  providerKind?: string,
): RotationRecoveryResult {
  const kind = (providerKind ?? '').trim().toLowerCase()
  if (kind !== '' && kind !== 'local-file') {
    return { action: 'none', reason: 'provider is not local-file; key managed out of band' }
  }

  const keyFilePath = join(spaceDir, MASTER_KEY_FILENAME)
  const stagedPath = `${keyFilePath}.next`
  if (!existsSync(stagedPath)) {
    return { action: 'none', reason: 'no staged key file' }
  }

  const dbPath = join(spaceDir, IDENTITY_DB_FILENAME)
  const liveKey = readKeyFile(keyFilePath)
  const stagedKey = readKeyFile(stagedPath)

  // 1. Live key still unwraps the DEK (or no DEK is at risk) → the rotation
  //    never committed its DB re-wrap; `.next` is stale. Discard it.
  if (liveKey) {
    const live = probeVaultMasterKey(dbPath, liveKey)
    if (live === 'ok' || live === 'no-vault') {
      rmSync(stagedPath, { force: true })
      return {
        action: 'discarded',
        reason: live === 'ok' ? 'live key unwraps DEK; staged key is stale' : 'no vault DEK at risk',
      }
    }
  }

  // 2. Live key can't unwrap the DEK (or is gone). If the staged key can, the
  //    DB was re-wrapped under it → promote `.next` to finish the rotation.
  if (stagedKey) {
    const staged = probeVaultMasterKey(dbPath, stagedKey)
    if (staged === 'ok') {
      renameSync(stagedPath, keyFilePath)
      return { action: 'promoted', reason: 'staged key unwraps DEK; completed interrupted rotation' }
    }
  }

  // 3. Neither key unwraps the DEK. Don't guess with the vault key — leave both
  //    files so the normal boot fails loudly and an operator can investigate.
  return { action: 'inconclusive', reason: 'neither live nor staged key unwraps the vault DEK' }
}

/**
 * Read a 32-byte master key file, or undefined if absent / unreadable. A
 * wrong-length (torn) file is still returned so the probe can reject it as a
 * 'mismatch' — the probe is the single place that judges a key.
 */
function readKeyFile(path: string): Buffer | undefined {
  try {
    if (!existsSync(path)) return undefined
    const buf = readFileSync(path)
    // A zero-length file is never a usable key; treat as absent. Any other
    // length is handed to the probe, which length-checks before unwrapping.
    return buf.length === 0 ? undefined : buf
  } catch {
    return undefined
  }
}
