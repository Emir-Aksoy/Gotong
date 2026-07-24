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
 *     committed; the staged key is stale → DISCARD `.next` (moved aside to a
 *     sweep-unique `.next.discarded.*` slot, never overwritten, never deleted
 *     — see the branch comment and `moveAsideNoClobber`).
 *   - live key fails but the staged key unwraps it → the DB was re-wrapped under
 *     the staged key → PROMOTE `.next` over the live file (finish the rotation).
 *   - neither unwraps it → genuine corruption (or a torn `.next` with the live
 *     key also gone) → leave both files untouched so the normal boot fails
 *     loudly; we never guess with the vault key.
 *
 * With no `.next` at all, leftover `.next.discarded*` files are normally just
 * stale bytes — but if the live key can no longer unwrap the DEK while a
 * discarded copy can, a concurrent rotation committed and then lost its
 * staging to a racing sweep; the boot stops loudly and points at the file
 * instead of failing with no trail (`probeDiscardedKeys`). An orphan staged
 * SECRETS copy in the same picture is judged by trial-decrypt, not blindly
 * deleted — it may be the survivor of a torn promote — and only a live key
 * the DEK probe vouches for ('ok') is allowed to judge it
 * (`reconcileStagedSecrets`).
 *
 * local-file only: env / kms-stub keys live outside the workspace, so there is
 * no `.next` file to reconcile (rotation there is an out-of-band change).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { probeVaultMasterKey } from '@gotong/identity'

// Reuse the rotation command's filenames so the two can never drift apart.
import {
  claimStagedKey,
  IDENTITY_DB_FILENAME,
  installClaimedKey,
  MASTER_KEY_FILENAME,
  restoreKeyClaim,
} from './rotate-master-key.js'
import {
  liveSecretsReadUnder,
  reconcileStagedSecrets,
  SPACE_SECRETS_FILENAME,
  STAGED_SECRETS_FILENAME,
} from './space-secrets-unify.js'

export type RotationRecoveryAction =
  /** No staged key (or non-local-file provider) — nothing to reconcile. */
  | 'none'
  /** Live key still unwraps the DEK (or no DEK) — stale `.next` removed. */
  | 'discarded'
  /** Staged key unwraps the DEK — promoted over the live file. */
  | 'promoted'
  /** Needs an operator: neither key unwraps the DEK, or a kept secrets
   *  staging masks a live file that no longer reads under the proven key
   *  (booting on would mix key eras). The reason names the fix. */
  | 'inconclusive'

export interface RotationRecoveryResult {
  action: RotationRecoveryAction
  reason: string
}

/**
 * Reconcile a possibly-interrupted local-file KEK rotation in `spaceDir`.
 * Pure filesystem + read-only probes — safe to call on every boot. With no
 * `<keyfile>.next` present it only reconciles leftover staging debris
 * (orphan staged secrets, swept `.discarded` key slots) and reports 'none' —
 * unless a swept slot holds the key the DB now needs, which upgrades the
 * verdict to 'inconclusive' (see `probeDiscardedKeys`).
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
    // A staged SECRETS copy without a staged key is usually crash debris —
    // but it can also be the survivor of a torn promote (key rename durable,
    // secrets rename lost to a power cut: dir fsync is best-effort). Blind
    // deletion there would strand every provider secret under the old
    // derived key, so trial-decrypt judges which one it is — and the judge
    // itself needs authority: a key that merely EXISTS on disk may be the
    // wrong one (the very state the discarded-slot rescue below points at),
    // so the reconciler only gets the live key once the vault DEK probe
    // vouches for it ('ok'). Unproven → the staging is kept, not judged.
    let provenKek: Buffer | undefined
    if (existsSync(join(spaceDir, STAGED_SECRETS_FILENAME))) {
      const liveKey = readKeyFile(keyFilePath)
      if (liveKey && probeVaultMasterKey(join(spaceDir, IDENTITY_DB_FILENAME), liveKey) === 'ok') {
        provenKek = liveKey
      }
    }
    const orphan = reconcileStagedSecrets(spaceDir, provenKek)
    // A swept staging file (`.next.discarded*`) can hold the only copy of a
    // key the DB now needs — see the discard branch below for how that state
    // arises. Probing it here is what makes the "loud, recoverable" promise
    // real; without this the boot would just fail vault_decrypt_failed with
    // no pointer to the rescue bytes.
    const rescue = probeDiscardedKeys(spaceDir)
    if (rescue) return rescue
    // A kept staging is benign while the live secrets read under the proven
    // key. When they do NOT, the kept file is likely the only readable copy
    // and booting on would mix key eras — stop for an operator instead.
    if (orphan === 'kept' && provenKek && liveSecretsReadUnder(spaceDir, provenKek) === false) {
      return {
        action: 'inconclusive',
        reason:
          `${SPACE_SECRETS_FILENAME} does not read under the proven live key and ` +
          `${STAGED_SECRETS_FILENAME} was kept (unjudgeable) — reconcile the provider ` +
          'secrets by hand; see docs/OPERATIONS.md.',
      }
    }
    return {
      action: 'none',
      reason:
        orphan === 'promoted'
          ? // 'NOTE:' rides along so the boot log gate surfaces this 'none' —
            // it DID change state (an auto-promote), unlike the quiet default.
            'no staged key file; NOTE: rescued orphan staged secrets from a torn promote'
          : orphan === 'kept'
            ? `no staged key file; NOTE: ${STAGED_SECRETS_FILENAME} kept (unjudgeable) — inspect it`
            : 'no staged key file',
    }
  }

  const dbPath = join(spaceDir, IDENTITY_DB_FILENAME)
  const liveKey = readKeyFile(keyFilePath)
  const stagedKey = readKeyFile(stagedPath)

  // 1. Live key still unwraps the DEK (or no DEK is at risk) → the rotation
  //    never committed its DB re-wrap; `.next` is stale. Discard it — and the
  //    staged secrets copy with it (B①: the space-secrets key derives from the
  //    KEK, so the two staging files commit or roll back together).
  if (liveKey) {
    const live = probeVaultMasterKey(dbPath, liveKey)
    if (live === 'ok' || live === 'no-vault') {
      // Secrets first: a crash between the two moves leaves the staging for
      // the no-staged-key branch above to re-judge. Judged, never blind —
      // the file on that path may be an older KEPT copy rather than this
      // rotation's staging, and 'no-vault' proves no key at all, so there
      // only the key-independent verdicts (exact copy / empty) may delete.
      const orphan = reconcileStagedSecrets(spaceDir, live === 'ok' ? liveKey : undefined)
      // Move, never delete: our probe-then-discard is not atomic, so a
      // CONCURRENT rotation could commit its DB re-wrap between our probe
      // (live was still 'ok') and this line — if it then crashes before its
      // own self-heal, the bytes we're sweeping are the only copy of the key
      // its DB now needs. Keeping them on disk turns that worst case into an
      // operator recovery (probeDiscardedKeys points at the file on the next
      // boot), never a bricked vault. Each sweep archives into its own
      // sweep-unique slot with a single atomic rename — never overwriting an
      // earlier sweep's bytes, never deleting a newer generation (see
      // moveAsideNoClobber). The staged SECRETS deletion above is bounded on
      // purpose where it happens: a provably-stale copy costs re-entering
      // provider keys at worst (loud), never the vault.
      moveAsideNoClobber(stagedPath)
      // Same era check as the no-staged-key branch: a kept staging over a
      // live file the proven key can't read means the boot would mix eras.
      if (orphan === 'kept' && live === 'ok' && liveSecretsReadUnder(spaceDir, liveKey) === false) {
        return {
          action: 'inconclusive',
          reason:
            `stale staged key swept, but ${SPACE_SECRETS_FILENAME} does not read under the live ` +
            `key and ${STAGED_SECRETS_FILENAME} was kept (unjudgeable) — reconcile the provider ` +
            'secrets by hand; see docs/OPERATIONS.md.',
        }
      }
      return {
        action: 'discarded',
        reason:
          (live === 'ok' ? 'live key unwraps DEK; staged key is stale' : 'no vault DEK at risk') +
          (orphan === 'kept'
            ? `; NOTE: ${STAGED_SECRETS_FILENAME} kept (unjudgeable) — inspect it`
            : ''),
      }
    }
  }

  // 2. Live key can't unwrap the DEK (or is gone). If the staged key can, the
  //    DB was re-wrapped under it → promote `.next` to finish the rotation.
  //    Secrets first, key second — same order as rotate-master-key step 3/4.
  if (stagedKey) {
    const staged = probeVaultMasterKey(dbPath, stagedKey)
    if (staged === 'ok') {
      // A proven staged KEY doesn't prove the secrets staging is PAIRED with
      // it — an older kept file may be squatting on the path. Promote only
      // what reads under the proven key (the reconciler fsyncs BEFORE the
      // key moves, and keeps what it can't judge for an operator). The live
      // key rides along as the prior-era witness: a live slot updated under
      // the OLD key after the staging was cut must not be rolled back.
      const secrets = reconcileStagedSecrets(
        spaceDir,
        stagedKey,
        liveKey ? { priorKek: liveKey } : undefined,
      )
      // The probe vouched for the BYTES read above, not for whatever sits at
      // the path now — a rival rotation may have re-claimed `.next` since a
      // concurrent recovery promoted ours (its bytes can become the only
      // copy of a NEWER generation). Claim → verify → act, same engine as
      // rotate step 4: one rename captures the inode into a `.discarded.*`
      // slot (the rescue namespace — a crash mid-promote leaves the key
      // where probeDiscardedKeys points), the claim is byte-verified, and
      // only the CLAIMED inode is installed over the live key
      // (installClaimedKey — the target end is inode-bound too). A foreign
      // inode is restored untouched and recovery hands off to an operator.
      const slot = claimStagedKey(stagedPath)
      let claimed: Buffer | undefined
      if (slot) {
        try {
          claimed = readFileSync(slot)
        } catch {
          claimed = undefined
        }
      }
      if (!slot || !claimed || !claimed.equals(stagedKey)) {
        if (slot) restoreKeyClaim(slot, stagedPath)
        return {
          action: 'inconclusive',
          reason:
            `${MASTER_KEY_FILENAME}.next changed while recovery was promoting it — a ` +
            'concurrent rotation or recovery is running; stop it and boot again to settle ' +
            'the final state.',
        }
      }
      const installed = installClaimedKey({
        spaceDir,
        dbPath,
        slot,
        keyBytes: stagedKey,
        keyFilePath,
        stagedPath,
      })
      if (installed === 'stale-generation') {
        return {
          action: 'inconclusive',
          reason:
            'the vault DB moved to a newer generation while recovery was promoting the ' +
            'staged key — the newer rotation owns the end state; boot again to settle it.',
        }
      }
      if (installed === 'target-contended') {
        return {
          action: 'inconclusive',
          reason:
            'the live key file was re-created while recovery was promoting the staged key — ' +
            'a concurrent rotation or recovery is running; stop it and boot again to settle ' +
            'the final state.',
        }
      }
      if (installed === 'superseded') {
        return {
          action: 'inconclusive',
          reason:
            'a newer generation (DB re-wrap or a fresh `.next` staging) advanced right after ' +
            'recovery promoted the staged key — a concurrent rotation is running; stop it and ' +
            'boot again to settle the final state.',
        }
      }
      // The KEY promote above is unconditional — `.next` holds the only key
      // that opens the DB, so finishing it is what un-bricks the vault. But
      // if the live secrets do NOT read under that key and the staging was
      // kept, booting on would mix key eras: stop for an operator.
      if (secrets === 'kept' && liveSecretsReadUnder(spaceDir, stagedKey) === false) {
        return {
          action: 'inconclusive',
          reason:
            `staged key promoted, but ${SPACE_SECRETS_FILENAME} does not read under it and ` +
            `${STAGED_SECRETS_FILENAME} was kept (unjudgeable) — reconcile the provider ` +
            'secrets by hand; see docs/OPERATIONS.md.',
        }
      }
      return {
        action: 'promoted',
        reason:
          'staged key unwraps DEK; completed interrupted rotation' +
          (secrets === 'kept'
            ? `; NOTE: ${STAGED_SECRETS_FILENAME} kept (unjudgeable) — inspect it`
            : ''),
      }
    }
  }

  // 3. Neither key unwraps the DEK. Before settling for a generic verdict,
  //    check the swept slots: a racing sweep can archive the committed key
  //    while a rival's dead `.next` stays behind (DB=K2 / live=K1 / .next=K3 /
  //    discarded=K2) — the exact-file pointer beats "investigate by hand".
  //    Still no guessing: rescue is a louder *message*, never a promote.
  const rescue = probeDiscardedKeys(spaceDir)
  if (rescue) return rescue
  return { action: 'inconclusive', reason: 'neither live nor staged key unwraps the vault DEK' }
}

/**
 * Atomically move `stagedPath` aside to a sweep-unique `.discarded` slot —
 * the same claim engine the promotes use (see claimStagedKey in
 * rotate-master-key.ts for why one rename() and a wx placeholder make this
 * strict): a sweep is just a claim nobody comes back for. The swept bytes
 * stay on disk because they may be the only copy a concurrent rotation's DB
 * needs; probeDiscardedKeys points an operator at them on the next boot.
 */
function moveAsideNoClobber(stagedPath: string): void {
  claimStagedKey(stagedPath)
}

/**
 * Rescue probe for swept staging files. If the live key can no longer unwrap
 * the DEK but a `.next.discarded*` copy can, a concurrent rotation committed
 * its DB re-wrap and was interrupted after a racing recovery swept its staged
 * key — the swept file holds the only key that opens the vault. We do NOT
 * auto-promote bytes an earlier recovery explicitly judged stale; we stop the
 * boot loudly with a one-move fix instead (docs/OPERATIONS.md). With no
 * discarded files present this is a single readdir — the every-boot cost
 * stays flat. A broken DB ('unreadable') never judges keys, here as in the
 * main path.
 */
function probeDiscardedKeys(spaceDir: string): RotationRecoveryResult | undefined {
  const prefix = `${MASTER_KEY_FILENAME}.next.discarded`
  let candidates: string[]
  try {
    candidates = readdirSync(spaceDir)
      .filter((name) => name.startsWith(prefix))
      .sort()
  } catch {
    return undefined
  }
  if (candidates.length === 0) return undefined

  const dbPath = join(spaceDir, IDENTITY_DB_FILENAME)
  const liveKey = readKeyFile(join(spaceDir, MASTER_KEY_FILENAME))
  if (liveKey) {
    const live = probeVaultMasterKey(dbPath, liveKey)
    // Live key healthy / nothing at risk / DB unreadable → the discarded
    // copies are what they claim to be: stale. Leave them for manual cleanup.
    if (live !== 'mismatch') return undefined
  }
  for (const name of candidates) {
    const key = readKeyFile(join(spaceDir, name))
    if (key && probeVaultMasterKey(dbPath, key) === 'ok') {
      return {
        action: 'inconclusive',
        reason:
          `the live key cannot unwrap the vault DEK, but swept staging file ${name} can — ` +
          'a concurrent rotation committed its DB re-wrap and was interrupted after a recovery ' +
          `swept its staged key. To recover: mv ${name} ${MASTER_KEY_FILENAME}.next inside the ` +
          'space dir and start again (recovery will promote it). See docs/OPERATIONS.md.',
      }
    }
  }
  return undefined
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
