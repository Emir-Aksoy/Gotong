/**
 * Route B P0-M4d — operator-facing master-key (KEK) rotation for the
 * local-file provider (run with the host STOPPED — see below).
 *
 * M4c made the store mechanism real (`rotateVaultMasterKey` re-wraps the single
 * data key under a new KEK in O(1) — secret rows are never touched). This is the
 * entrypoint that actually drives it, so an operator can rotate the vault key
 * without writing code. Without it the rotation is a method nobody can
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
 * # Crash-safe ordering (stop the host first)
 *
 * The live key file and the DB's wrapped DEK must agree on the next boot. We:
 *   1. stage the new key to `<keyfile>.next` (0600, exclusive-create, fsync'd)
 *      — the live file is untouched
 *   2. re-wrap the DEK in the DB under the new key (atomic single-row replace)
 *   3. promote: claim `<keyfile>.next` into a `.discarded.*` slot (one atomic
 *      rename captures the inode), byte-verify the claim, then INSTALL the
 *      claimed inode — capture the live key into another slot, re-prove the
 *      DB generation after the capture, and link() the claim in exclusively
 *      (both ends inode-bound; nothing is ever replaced by path)
 *
 * The new key reaches disk — durably: the staged file is fsync'd — BEFORE the
 * DB commit (step 2), so the only crash window (after 2, before 3/4) leaves the
 * live file holding the OLD key while `<keyfile>.next` holds the NEW one. Boot
 * recovery (P0-M5, master-key-recovery.ts) reconciles that window
 * automatically — and rotateMasterKeyCmd runs the same recovery before
 * rotating, so an operator re-run comes out clean. The contract: once the DB
 * commits to the new key, that key exists on disk and is never *lost*. Scope:
 * local filesystems — NFS/SMB weaken rename atomicity and fsync, so keep the
 * workspace on a local disk (docs/OPERATIONS.md).
 *
 * Run ONE rotation at a time. Recovery cannot tell a CONCURRENT rotation's
 * in-flight staging from a crashed rotation's debris (on disk they are the
 * same state), so a parallel run's recovery-first pass may discard our staged
 * key while the live key still opens the DB. Two guards bound that: the claim
 * is re-verified immediately before the DB commit (gone/changed → abort with
 * nothing committed), and after the commit both promotes self-heal from
 * memory instead of trusting disk state — so the vault KEK can never be
 * bricked. The residual worst case of truly simultaneous runs is bounded and
 * loud: one run aborts, and the staged *provider-secrets* re-encryption can
 * be lost (re-enter LLM keys after boot) — never the vault.
 *
 * Since B① the space-secrets key is DERIVED from the KEK, so rotation re-encrypts
 * secrets.enc.json too (steps 1.5 / 3 below). A running host still holds the OLD
 * derived key: a secret it saves between our staging snapshot and the settle
 * leaves the staging no longer covering the live file — the per-slot judge
 * refuses to promote (kept) and the rotation surfaces it loudly rather than
 * clobbering the new entry. The supported procedure is still stop → rotate →
 * start; this process cannot detect a live host (no lock file by design — 114
 * knobs frozen), so the discipline is documented, not enforced. See
 * docs/OPERATIONS.md.
 */

import { chmodSync, closeSync, existsSync, linkSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  probeVaultMasterKey,
  resolveMasterKeyProvider,
} from '@gotong/identity'

import {
  fsyncDirBestEffort,
  fsyncFile,
  liveSecretsReadUnder,
  reconcileStagedSecrets,
  stageRotatedSecrets,
  STAGED_SECRETS_FILENAME,
} from './space-secrets-unify.js'

/** Workspace-relative filenames, kept in sync with the boot path in main.ts. */
export const MASTER_KEY_FILENAME = 'identity-master.key'
export const IDENTITY_DB_FILENAME = 'identity.sqlite'

export interface RotateMasterKeyInput {
  /** Workspace directory (GOTONG_SPACE). */
  spaceDir: string
  /** GOTONG_MASTER_KEY_PROVIDER — undefined / '' → local-file. */
  providerKind?: string
  /** GOTONG_MASTER_KEY — current env material (only consulted for env provider). */
  envKeyMaterial?: string
  /** Encoding of `envKeyMaterial`; default 'hex'. */
  envKeyEncoding?: 'hex' | 'base64'
  /** Injectable RNG for deterministic tests; defaults to crypto.randomBytes. */
  generateKey?: () => Buffer
  /**
   * Test-only fault injection (P0-M5 discipline: crash-safety paths are
   * exercised, not trusted). `beforeDbRewrap` runs after both stagings, just
   * before the claim re-check + DB commit; `afterDbRewrap` right after the
   * commit. Production callers never set these.
   */
  beforeDbRewrap?: () => void
  afterDbRewrap?: () => void
}

export interface RotateMasterKeyResult {
  /** Absolute path of the live key file that now holds the new key. */
  keyFilePath: string
}

/**
 * Shared refusal for "a `.next` staging file already exists". Raised by the
 * cheap pre-check AND by the exclusive-create write below — the pre-check
 * gives the common case a clean early exit, the `wx` write closes the
 * check-to-write race window with the filesystem as arbiter.
 */
function stagedKeyExistsError(): Error {
  return new Error(
    `a staged key from an interrupted rotation exists (${MASTER_KEY_FILENAME}.next) — ` +
      `refusing to overwrite it. Start the host once (boot recovery reconciles it), ` +
      `then re-run; if this persists, see docs/OPERATIONS.md.`,
  )
}

/**
 * Rotate the vault master key (KEK) for a local-file workspace. All REFUSALS
 * (non-local-file provider, missing/wrong-length current key, a generated key
 * that equals the current one, leftover staging from an interrupted rotation)
 * land BEFORE the DB re-wrap commit point, where any `.next` debris is inert
 * (boot recovery discards it). A crash AFTER the commit point leaves the DB
 * under the new key with the live file one step behind — `.next` then holds
 * the only current key, and boot recovery (or a re-run of the CLI, which runs
 * recovery first) promotes it. Against a CONCURRENT run sweeping our staging
 * (its recovery can't tell in-flight from debris), the claim is re-verified
 * right before the commit and re-materialised from memory right after it.
 * Either way the new key is never lost (local filesystems — see header).
 */
export function rotateMasterKey(input: RotateMasterKeyInput): RotateMasterKeyResult {
  const providerKind = (input.providerKind ?? '').trim().toLowerCase()
  if (providerKind !== '' && providerKind !== 'local-file') {
    // env / kms-stub keys live outside the workspace — we can't persist a new
    // one here. Fail closed instead of rotating the DB into a key the operator
    // has no way to load on next boot.
    throw new Error(
      `rotate-master-key supports the local-file provider only; ` +
        `GOTONG_MASTER_KEY_PROVIDER='${input.providerKind}' is managed outside the ` +
        `workspace — rotate the injected key material out of band.`,
    )
  }

  const keyFilePath = join(input.spaceDir, MASTER_KEY_FILENAME)
  const dbPath = join(input.spaceDir, IDENTITY_DB_FILENAME)

  // EXCLUSIVE: a `.next` from an interrupted rotation may be the ONLY key
  // that unwraps the DB (crash after the re-wrap, before the promote).
  // Blindly re-staging would overwrite that sole copy and brick the vault
  // forever. Refuse — the caller (rotateMasterKeyCmd) runs boot recovery
  // first, so an operator re-run reconciles and then rotates cleanly; if
  // recovery left it in place (inconclusive), a human must look anyway.
  // (Race-proofing lives at the staging write itself: `wx` below.)
  if (existsSync(`${keyFilePath}.next`)) {
    throw stagedKeyExistsError()
  }

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
    // 1. Stage the new key beside the live file (live key untouched). `wx`
    //    (exclusive create) makes the staging file itself the claim token:
    //    two racing rotations can both pass the pre-check above, but only one
    //    can CREATE `.next` — the loser dies here instead of silently
    //    overwriting the winner's staged key mid-rotation (which could retire
    //    a key that exists nowhere else once the winner promotes).
    const stagedPath = `${keyFilePath}.next`
    try {
      writeFileSync(stagedPath, newKey, { mode: 0o600, flag: 'wx' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw stagedKeyExistsError()
      throw err
    }
    if (process.platform !== 'win32') {
      try {
        chmodSync(stagedPath, 0o600)
      } catch {
        // tolerate exFAT / SMB / sandboxed fs that reject chmod
      }
    }
    //    fsync the staged key (and its dirent) BEFORE the DB commit: the whole
    //    crash story rests on "the new key is durable before the DB needs it",
    //    and without fsync a power cut could persist the DB re-wrap while
    //    `.next` evaporates. A filesystem that genuinely can't fsync degrades
    //    to process-crash safety; a real I/O failure ABORTS (see fsyncFile).
    fsyncFile(stagedPath)
    fsyncDirBestEffort(input.spaceDir)
    // 1.5 (B① unification): the space-secrets key is DERIVED from the KEK, so
    //     it rotates with it. Stage a re-encrypted secrets.enc.json.next now —
    //     pure staging, live file untouched; boot recovery discards or promotes
    //     it in the same branch as `<keyfile>.next`.
    const secretsStaged =
      stageRotatedSecrets(input.spaceDir, currentKey, newKey) === 'staged'
    // Snapshot the staged secrets bytes: like the key claim, the evidence
    // must bind to the file the commit relies on — re-verified at 2-pre.
    const stagedSecretsPath = join(input.spaceDir, STAGED_SECRETS_FILENAME)
    const stagedSecretsBytes = secretsStaged ? readFileSync(stagedSecretsPath) : undefined
    input.beforeDbRewrap?.()
    // 2-pre. Re-verify the claim at the point of no return. A concurrent
    //    `rotate-master-key` runs recovery FIRST, and recovery cannot tell our
    //    in-flight staging from crashed-rotation debris (on disk they are the
    //    same state) — while the live key still opens the DB it discards the
    //    staged key. Committing the DB to a key whose only durable copy was
    //    just deleted would brick the vault; aborting here is free.
    let claim: Buffer | undefined
    try {
      claim = readFileSync(stagedPath)
    } catch {
      claim = undefined
    }
    if (!claim || !claim.equals(newKey)) {
      throw new Error(
        'staged key vanished/changed underneath this rotation — a concurrent ' +
          'rotation or recovery ran. Nothing was committed. Run ONE rotation ' +
          'at a time, then re-run.',
      )
    }
    // Same re-verify for the staged SECRETS: committing the DB against a
    // staging a racer swapped would promote bytes nobody audited (or strand
    // the real re-encryption). Aborting here is free — nothing committed.
    if (stagedSecretsBytes) {
      let sClaim: Buffer | undefined
      try {
        sClaim = readFileSync(stagedSecretsPath)
      } catch {
        sClaim = undefined
      }
      if (!sClaim || !sClaim.equals(stagedSecretsBytes)) {
        throw new Error(
          'staged secrets vanished/changed underneath this rotation — a ' +
            'concurrent rotation or recovery ran. Nothing was committed. Run ' +
            'ONE rotation at a time, then re-run.',
        )
      }
    }
    // 2. Re-wrap the DEK in the DB under the new key (atomic single row). The
    //    new key is already durable on disk (step 1), so a crash here is
    //    recoverable. If a rival rotation committed first, the unwrap inside
    //    fails loudly (vault_decrypt_failed) and we abort having committed
    //    nothing — SQLite serialises the two commits.
    store.rotateVaultMasterKey(newKey)
    input.afterDbRewrap?.()
    // From the commit point on, the ONLY correct end-state is live = newKey;
    // both promotes below therefore self-heal from memory instead of trusting
    // disk state a concurrent recovery may have swept since the re-check.
    // GENERATION GATE: this process may have sat suspended (VM pause,
    // SIGSTOP) long enough for boot recovery to finish OUR promote and a
    // LATER rotation to commit the DB to yet another key. From that moment
    // newKey is a stale authority — judging with it would discard the newer
    // generation's staging, and step 4's self-heal would overwrite `.next`,
    // possibly the only copy of the key the DB now needs. The DB is the
    // arbiter: re-prove our generation before every settle step, and hand
    // off loudly if it moved on. (The residual probe→act window is bounded
    // by destroy()'s claim-verify — foreign staged bytes never promote.)
    const newerGenerationError = () =>
      new Error(
        'the vault DB no longer proves this rotation — a newer generation committed ' +
          'underneath it (or the DB became unreadable). Nothing more was touched; the newer ' +
          'rotation or boot recovery owns the end state. Run ONE rotation at a time. ' +
          'See docs/OPERATIONS.md.',
      )
    const gen = probeVaultMasterKey(dbPath, newKey)
    if (gen !== 'ok' && gen !== 'no-vault') throw newerGenerationError()
    // 3. Settle staged secrets FIRST, then the key file: a crash between the
    //    two leaves live-secrets already under the new derived key while the
    //    staged KEY still exists — recovery's probe promotes it. The reverse
    //    order would strand a stray secrets `.next` after the key promote
    //    erased the evidence that a rotation was in flight. And never settle
    //    BLINDLY: the same single authority recovery uses judges the file on
    //    the path (evidence binds to the file operated on) — our own staging
    //    reads under the new key and promotes; one a racer swapped in is
    //    judged on its own evidence, never renamed over the live secrets.
    //    currentKey rides along as the prior-era witness: a live slot the
    //    running host updated under the OLD key after our staging snapshot
    //    reads differently under it, and the judge refuses to roll it back.
    if (secretsStaged) {
      let settled = reconcileStagedSecrets(input.spaceDir, newKey, { priorKek: currentKey })
      if (settled === 'none') {
        // Swept — re-stage from the live file (untouched, still under the old
        // derived key) and settle; every input is still in memory.
        stageRotatedSecrets(input.spaceDir, currentKey, newKey)
        settled = reconcileStagedSecrets(input.spaceDir, newKey, { priorKek: currentKey })
      }
      if (settled !== 'promoted' && liveSecretsReadUnder(input.spaceDir, newKey) === false) {
        // The DB committed (the KEK itself is safe: `.next` is durable and
        // recovery promotes it), but the provider secrets could not be
        // settled under the new key — surface it instead of reporting a
        // clean rotation over an unreadable secrets file.
        throw new Error(
          `provider secrets could not be settled under the new key (verdict: ${settled}) — ` +
            'the DB re-wrap committed and boot recovery will finish or escalate the key promote; ' +
            `inspect ${STAGED_SECRETS_FILENAME}. See docs/OPERATIONS.md.`,
        )
      }
    }
    // 4. Promote the staged key over the live key — claim → verify → act,
    //    the same doctrine as the secrets reconciler. Reading `.next` and
    //    then renaming BY PATH would promote whatever sits there at rename
    //    time: a recovery can finish our promote and a rival re-stage its
    //    key in between, and the by-path rename would move the rival's
    //    uncommitted key over the live file (its only copy, our DB — brick).
    //    claimStagedKey() renames the inode into a sweep-unique
    //    `.discarded.*` slot first (the rescue namespace: a crash mid-
    //    promote leaves the key exactly where probeDiscardedKeys points an
    //    operator), and only a byte-verified claim is installed over the
    //    live key (installClaimedKey — the target end is inode-bound too).
    //    A foreign inode is restored untouched; self-heal re-creation is
    //    EXCLUSIVE (wx), so a rival staging between our probe and our write
    //    is never overwritten; self-heal runs only while the DB still
    //    proves our generation.
    const rivalReclaimError = () =>
      new Error(
        'a rival rotation re-claimed the staged key file underneath this promote — refusing ' +
          'to overwrite it. The DB re-wrap committed; boot (or re-run, which runs recovery ' +
          'first) to settle the promote. See docs/OPERATIONS.md.',
      )
    for (let attempt = 0; ; attempt++) {
      const slot = claimStagedKey(stagedPath)
      if (slot) {
        let claimed: Buffer | undefined
        try {
          claimed = readFileSync(slot)
        } catch {
          claimed = undefined
        }
        if (claimed && claimed.equals(newKey)) {
          // Source verified — but the TARGET must be bound too: this process
          // may have sat suspended long enough for a LATER generation to have
          // fully completed, and a by-path rename here would bury that
          // generation's only key copy. installClaimedKey captures the live
          // inode, re-proves the generation AFTER the capture, and installs
          // with an exclusive link — see its doc.
          const installed = installClaimedKey({
            spaceDir: input.spaceDir,
            dbPath,
            slot,
            keyBytes: newKey,
            keyFilePath,
            stagedPath,
          })
          if (installed === 'stale-generation') throw newerGenerationError()
          if (installed === 'target-contended') {
            throw new Error(
              'the live key file was re-created underneath this promote — a concurrent ' +
                'rotation or recovery owns it now. The DB re-wrap committed and the staged ' +
                'key is parked in a rescue slot; boot to settle the final state. ' +
                'See docs/OPERATIONS.md.',
            )
          }
          if (installed === 'superseded') {
            throw new Error(
              'the promote landed but the vault DB (or a fresh `.next` staging) moved to a ' +
                'newer generation right underneath it — a concurrent rotation is running and ' +
                'owns the end state. Do NOT treat this rotation as complete; boot to settle ' +
                'it. Run ONE rotation at a time. See docs/OPERATIONS.md.',
            )
          }
          break
        }
        // We claimed a FOREIGN inode (rival staged after a sweep, not yet
        // committed — it becomes that rival's only key copy the moment it
        // commits). Put it back untouched; our promote stays pending and
        // recovery settles it (the swept slot holds our bytes and
        // probeDiscardedKeys points at it).
        restoreKeyClaim(slot, stagedPath)
        const gen4 = probeVaultMasterKey(dbPath, newKey)
        if (gen4 !== 'ok' && gen4 !== 'no-vault') throw newerGenerationError()
        throw rivalReclaimError()
      }
      // `.next` is empty (swept). Self-heal from memory — but only while the
      // DB still proves our generation, and never more than once: a path
      // that keeps vanishing means an active racer owns it.
      const gen4 = probeVaultMasterKey(dbPath, newKey)
      if (gen4 !== 'ok' && gen4 !== 'no-vault') throw newerGenerationError()
      if (attempt > 0) throw rivalReclaimError()
      try {
        writeFileSync(stagedPath, newKey, { mode: 0o600, flag: 'wx' })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        continue // re-claimed underneath the probe — the next pass judges it
      }
      fsyncFile(stagedPath)
      // loop: claim our own fresh write and promote through the verified path
    }
    // (installClaimedKey fsyncs the install before returning, so "rotation
    // complete" below is already durable — callers may prune old backups.)
  } finally {
    store.close()
  }

  return { keyFilePath }
}

/**
 * Claim the inode at `path`: one rename() moves whatever sits there into a
 * sweep-unique slot under `<slotPrefix>.discarded.*` and returns the slot
 * path (undefined if the path was already empty). One rename is the whole
 * trick — it moves THE inode currently at the path, so bytes placed after a
 * caller's read can never slip by-path into a promote; the caller
 * byte-verifies the claim before acting on it. The slot name is claimed with
 * an exclusive create first (`wx`), making no-clobber STRICT, not just
 * probabilistic: the rename can only ever replace our own empty placeholder.
 *
 * The `.discarded.*` namespace is DELIBERATELY shared with recovery's sweep:
 * a crash between claim and act parks the bytes exactly where
 * probeDiscardedKeys already points an operator, and a zero-byte placeholder
 * left by a crash before the rename reads as absent (inert debris). ENOENT
 * on the rename means a racer took the path first — that racer owns the
 * outcome.
 */
function claimIntoSlot(path: string, slotPrefix: string): string | undefined {
  let slot: string
  for (;;) {
    slot = `${slotPrefix}.discarded.${process.pid}-${randomBytes(4).toString('hex')}`
    try {
      closeSync(openSync(slot, 'wx'))
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  try {
    renameSync(path, slot)
  } catch (err) {
    rmSync(slot, { force: true }) // unused placeholder — ours, safe to drop
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  // Durability barrier: the claimed bytes may be the only copy a concurrent
  // rotation's DB needs — persist the dirent before anything acts on them.
  fsyncDirBestEffort(dirname(path))
  return slot
}

/** Claim `<keyfile>.next` itself — see claimIntoSlot for the mechanism. */
export function claimStagedKey(stagedPath: string): string | undefined {
  return claimIntoSlot(stagedPath, stagedPath)
}

export interface InstallClaimedKeyInput {
  /** Workspace directory (dirent fsync target). */
  spaceDir: string
  /** identity.sqlite path — the DB is the generation arbiter. */
  dbPath: string
  /** Rescue slot holding the caller's byte-verified claim. */
  slot: string
  /** The bytes the caller verified in the slot; the DB must still prove them. */
  keyBytes: Buffer
  /** Live key file to install over. */
  keyFilePath: string
  /** `.next` path — namespace anchor so a captured live inode parks under the same rescue prefix. */
  stagedPath: string
  /**
   * Test-only fault injection (P0-M5 discipline: crash-safety paths are
   * exercised, not trusted). Runs between the generation probe and the
   * exclusive link — the window the post-install gate exists for.
   * Production callers never set this.
   */
  beforeInstallLink?: () => void
}

/**
 * Install a byte-verified claimed key over the live key file with the TARGET
 * bound too — the last unbound edge. A plain rename(slot, keyFilePath)
 * replaces whatever sits at the live path at that instant: a suspended run
 * resuming after recovery finished its promote and a LATER rotation fully
 * completed would rename its stale key over the newer generation's live file
 * (its only copy — brick). So instead:
 *
 *   1. CAPTURE the current live inode (if any) into the shared rescue
 *      namespace — after this the canonical key path is empty, so no rival
 *      can resolve a current key from disk and commit a new generation in
 *      the window (a racer already holding a key in memory that commits
 *      anyway is safe: its own staged `.next` survives and recovery
 *      finishes it).
 *   2. Re-prove the generation AFTER the capture — the answer can no longer
 *      go stale the way a probe-before-act can.
 *   3. Install with an EXCLUSIVE link(): if any writer re-created the live
 *      path in between, EEXIST refuses — nothing is ever replaced by path.
 *
 *   4. POST-GATE once the install is durable: re-probe the DB and look for
 *      a re-created `.next`. A racer that loaded the key into memory BEFORE
 *      our capture can still stage + commit inside the probe→link window;
 *      its committed key is never lost (its own `.next` survives), but
 *      reporting 'installed' would let this run claim a success the DB no
 *      longer backs. 'superseded' keeps every slot parked and the caller
 *      hands off loudly — boot recovery settles the end state. A commit
 *      landing after this gate is the documented bounded residual of truly
 *      simultaneous runs.
 *
 * Non-'installed' outcomes leave every key byte parked in `.discarded.*`
 * slots where probeDiscardedKeys arbitrates at boot (live healthy → inert
 * debris; live dead/absent → loud one-move rescue). On 'installed' the old
 * live key is retired (rm) — that is the point of a rotation — only after
 * the install itself is durable.
 */
export function installClaimedKey(
  input: InstallClaimedKeyInput,
): 'installed' | 'stale-generation' | 'target-contended' | 'superseded' {
  const liveOut = claimIntoSlot(input.keyFilePath, input.stagedPath)
  const gen = probeVaultMasterKey(input.dbPath, input.keyBytes)
  if (gen !== 'ok' && gen !== 'no-vault') {
    // The DB moved on (or died) — the captured live may be the newer
    // generation's ONLY disk copy: put it back exactly where it was. Our
    // claim stays parked (a retired intermediate — inert while the restored
    // live opens the DB, rescued by probeDiscardedKeys if it does not).
    if (liveOut) restoreKeyClaim(liveOut, input.keyFilePath)
    return 'stale-generation'
  }
  input.beforeInstallLink?.()
  try {
    linkSync(input.slot, input.keyFilePath)
  } catch (err) {
    // EEXIST: a writer re-created the live path since the capture. Refuse —
    // both inodes stay parked in the rescue namespace and the DB arbitrates
    // at boot. Any OTHER error (EPERM, EIO…) is a broken filesystem, not a
    // race — surface it verbatim instead of blaming a phantom rival (both
    // keys are parked where probeDiscardedKeys points).
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    return 'target-contended'
  }
  fsyncDirBestEffort(input.spaceDir)
  const gen2 = probeVaultMasterKey(input.dbPath, input.keyBytes)
  if ((gen2 !== 'ok' && gen2 !== 'no-vault') || existsSync(input.stagedPath)) {
    // Post-install gate (doc step 4): the DB stopped backing this key, or a
    // fresh `.next` appeared — a rival advanced inside the window. Keep
    // every slot parked; the caller refuses success and recovery owns the
    // end state (the rival's staging is never touched from here).
    return 'superseded'
  }
  try {
    rmSync(input.slot, { force: true })
    if (liveOut) rmSync(liveOut, { force: true })
    fsyncDirBestEffort(input.spaceDir)
  } catch {
    /* cleanup only — the install itself is durable */
  }
  return 'installed'
}

/**
 * Put a claimed key back on its path — link() no-clobber, so a path
 * re-staged meanwhile is never overwritten (the claim then simply stays
 * parked in the rescue namespace where probeDiscardedKeys reports it). The
 * NEW name is made durable BEFORE the old one is dropped: without that
 * barrier a power cut can persist the unlink but not the link, and the
 * bytes being restored may be the only copy of a key a rival's committed
 * DB needs.
 */
export function restoreKeyClaim(slot: string, stagedPath: string): void {
  try {
    linkSync(slot, stagedPath)
  } catch {
    return /* EEXIST / fs error — the slot is already where rescue looks */
  }
  fsyncDirBestEffort(dirname(stagedPath))
  try {
    rmSync(slot, { force: true })
    fsyncDirBestEffort(dirname(stagedPath))
  } catch {
    /* cleanup only — the restore itself is durable */
  }
}
