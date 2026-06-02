/**
 * Route B P0-M4d — operator-facing online master-key (KEK) rotation for the
 * local-file provider.
 *
 * M4c made the store mechanism real (`rotateVaultMasterKey` re-wraps the single
 * data key under a new KEK in O(1) — secret rows are never touched). This is the
 * entrypoint that actually drives it, so an operator can rotate the vault key
 * without writing code. Without it the "online rotation" is a method nobody can
 * call — the rotation equivalent of an enforcement gate with no caller.
 *
 * # Why local-file only
 *
 * The DB stores only the *wrapped* DEK, so any rotation must unwrap with the
 * current KEK and re-wrap under a new one. For `local-file` the new KEK is a
 * fresh random key we generate and persist to the 0600 key file — never printed
 * (same secret-grade discipline as the admin link file). For `env` / `kms-stub`
 * the KEK is managed outside the workspace; rotating it is an out-of-band change
 * to the injected material (and would require the operator to supply both old
 * and new keys), so this command fails closed there with an actionable message
 * rather than pretending to rotate something it can't persist.
 *
 * # Crash-safe ordering (no downtime)
 *
 * The live key file and the DB's wrapped DEK must agree on the next boot. We:
 *   1. stage the new key to `<keyfile>.next` (0600) — the live file is untouched
 *   2. re-wrap the DEK in the DB under the new key (atomic single-row replace)
 *   3. promote: rename `<keyfile>.next` over the live key file (atomic on POSIX)
 *
 * The new key reaches disk (step 1) BEFORE the DB commit (step 2), so the only
 * crash window (after 2, before 3) leaves the live file holding the OLD key
 * while `<keyfile>.next` holds the NEW one — recoverable by renaming `.next`
 * into place. Auto-recovery on boot is deferred to P0-M5 (fault injection); this
 * command's contract is only that the new key is never *lost* in that window.
 *
 * A running host caches its DEK, so a rotation by this separate process does not
 * disturb it — the new KEK takes effect on the next restart. That is the
 * "no downtime" property: rotate now, restart at your convenience.
 */

import { chmodSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  resolveMasterKeyProvider,
} from '@aipehub/identity'

/** Workspace-relative filenames, kept in sync with the boot path in main.ts. */
export const MASTER_KEY_FILENAME = 'identity-master.key'
export const IDENTITY_DB_FILENAME = 'identity.sqlite'

export interface RotateMasterKeyInput {
  /** Workspace directory (AIPE_SPACE). */
  spaceDir: string
  /** AIPE_MASTER_KEY_PROVIDER — undefined / '' → local-file. */
  providerKind?: string
  /** AIPE_MASTER_KEY — current env material (only consulted for env provider). */
  envKeyMaterial?: string
  /** Encoding of `envKeyMaterial`; default 'hex'. */
  envKeyEncoding?: 'hex' | 'base64'
  /** Injectable RNG for deterministic tests; defaults to crypto.randomBytes. */
  generateKey?: () => Buffer
}

export interface RotateMasterKeyResult {
  /** Absolute path of the live key file that now holds the new key. */
  keyFilePath: string
}

/**
 * Rotate the vault master key (KEK) for a local-file workspace. Throws on any
 * misconfiguration (non-local-file provider, missing/wrong-length current key,
 * a generated key that equals the current one) BEFORE mutating anything, so a
 * failed rotation never half-rotates.
 */
export function rotateMasterKey(input: RotateMasterKeyInput): RotateMasterKeyResult {
  const providerKind = (input.providerKind ?? '').trim().toLowerCase()
  if (providerKind !== '' && providerKind !== 'local-file') {
    // env / kms-stub keys live outside the workspace — we can't persist a new
    // one here. Fail closed instead of rotating the DB into a key the operator
    // has no way to load on next boot.
    throw new Error(
      `rotate-master-key supports the local-file provider only; ` +
        `AIPE_MASTER_KEY_PROVIDER='${input.providerKind}' is managed outside the ` +
        `workspace — rotate the injected key material out of band.`,
    )
  }

  const keyFilePath = join(input.spaceDir, MASTER_KEY_FILENAME)
  const dbPath = join(input.spaceDir, IDENTITY_DB_FILENAME)

  // Load the CURRENT key through the same provider the host boots with, so a
  // missing / wrong-length key file fails here exactly as it would on boot.
  const provider = resolveMasterKeyProvider({
    kind: input.providerKind,
    localFilePath: keyFilePath,
    envKeyMaterial: input.envKeyMaterial,
    envKeyEncoding: input.envKeyEncoding ?? 'hex',
  })
  const currentKey = provider.load()

  const gen = input.generateKey ?? (() => randomBytes(MASTER_KEY_LEN_BYTES))
  const newKey = gen()
  if (!Buffer.isBuffer(newKey) || newKey.length !== MASTER_KEY_LEN_BYTES) {
    throw new Error(`generated master key must be ${MASTER_KEY_LEN_BYTES} bytes`)
  }
  if (newKey.equals(currentKey)) {
    // A no-op "rotation" would retire nothing; refuse rather than silently
    // re-wrap under the same key (almost certainly an RNG / injection bug).
    throw new Error('generated master key is identical to the current key; aborting')
  }

  const store = openIdentityStore({ dbPath, masterKey: currentKey })
  try {
    // 1. Stage the new key beside the live file (live key untouched).
    const stagedPath = `${keyFilePath}.next`
    writeFileSync(stagedPath, newKey, { mode: 0o600 })
    if (process.platform !== 'win32') {
      try {
        chmodSync(stagedPath, 0o600)
      } catch {
        // tolerate exFAT / SMB / sandboxed fs that reject chmod
      }
    }
    // 2. Re-wrap the DEK in the DB under the new key (atomic single row). The
    //    new key is already on disk (step 1), so a crash here is recoverable.
    store.rotateVaultMasterKey(newKey)
    // 3. Promote the staged key over the live key (atomic on POSIX). After this
    //    the OLD key no longer opens the vault — that is the point of rotation.
    renameSync(stagedPath, keyFilePath)
  } finally {
    store.close()
  }

  return { keyFilePath }
}
