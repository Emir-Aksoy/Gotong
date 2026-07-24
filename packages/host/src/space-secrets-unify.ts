/**
 * B① master-key unification — one root key for the whole workspace.
 *
 * Pre-B① the workspace held TWO independent master keys:
 *   - `runtime/secret.key` (v3, @gotong/core SpaceSecrets) encrypting
 *     `secrets.enc.json` — the LLM provider / per-agent API keys, and
 *   - `identity-master.key` (v4 vault KEK) encrypting the identity vault
 *     (IM tokens, OAuth secrets, peer tokens, TOTP…).
 *
 * Two files to safeguard when moving house, two env overrides with
 * near-identical semantics, and a real rotation blind spot: rotating the
 * KEK left the LLM keys under the untouched legacy key.
 *
 * This module folds the v3 key INTO the v4 KEK by derivation:
 *
 *     spaceSecretsKey = HKDF-SHA256(KEK, info='gotong/space-secrets/v1')
 *
 * The derived key is injected into `Space.bindSecretsMasterKey` at boot,
 * and `secrets.enc.json` is migrated (re-encrypted, version 1 → 2) with a
 * backup-first, crash-safe two-phase write. The legacy key file is renamed
 * (`.pre-unify.bak`), never deleted — 框架绝不静默删数据.
 *
 * # Binding is gated on a COMMITTED v2 file
 *
 * If migration can't run (restored backup whose legacy key was excluded,
 * unreadable file, invalid env key) we return `bound: false` and the host
 * does NOT inject — Space falls back to the byte-identical legacy path
 * (today's behavior: undecryptable entries read as null, operator
 * re-enters keys via the panel) and migration retries next boot. Keys the
 * operator re-enters go through the legacy path as v1 and are unified on
 * the following boot — the restore story self-heals.
 *
 * # Crash matrix (boot migration)
 *
 *   - crash before the v2 write        → v1 + legacy key intact → rerun
 *   - crash after write, before rename → v2 + legacy key present →
 *     next boot takes the `completed-key-rename` branch
 *   - the write itself is tmp+rename atomic (writeJsonAtomicSync)
 *
 * # Rotation staging (`secrets.enc.json.next`)
 *
 * When the KEK rotates, the derived key rotates with it, so
 * `rotate-master-key.ts` stages a re-encrypted copy BEFORE the DB re-wrap
 * (`stageRotatedSecrets` commits via link() and refuses an occupied path)
 * and settles it right before the key-file promote. Boot recovery
 * (`master-key-recovery.ts`) settles the staged copy in the same branch
 * where it settles `<keyfile>.next`. Neither ever acts blindly: every
 * destructive move on the staging path goes through
 * `reconcileStagedSecrets` — per-slot trial-decrypt under a vault-proven
 * key, the survivor of a torn promote is promoted, provably-stale debris
 * is discarded, and the unjudgeable is kept for an operator.
 */

import { hkdfSync, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  decryptSecret,
  encryptSecret,
  SECRETS_FILE_VERSION_UNIFIED,
  SECURE_FILE_MODE,
  uniqueTmpPath,
  writeJsonAtomicSync,
  type EncryptedSecret,
  type SecretsFile,
} from '@gotong/core'

export const SPACE_SECRETS_FILENAME = 'secrets.enc.json'
export const LEGACY_SECRET_KEY_REL = 'runtime/secret.key'
/** Renamed-not-deleted suffix for the retired legacy key + pre-migration file copy. */
export const PRE_UNIFY_BAK_SUFFIX = '.pre-unify.bak'
/** Rotation staging file (encrypted under the NEW derived key). */
export const STAGED_SECRETS_FILENAME = 'secrets.enc.json.next'
/** HKDF domain-separation label — versioned so a future re-derivation can coexist. */
export const SPACE_SECRETS_HKDF_INFO = 'gotong/space-secrets/v1'

const KEY_BYTES = 32

/** Derive the space-secrets key from the identity KEK (deterministic, 32 bytes). */
export function deriveSpaceSecretsKey(kek: Buffer): Buffer {
  if (!Buffer.isBuffer(kek) || kek.length !== KEY_BYTES) {
    throw new Error(`deriveSpaceSecretsKey: KEK must be ${KEY_BYTES} bytes, got ${kek?.length}`)
  }
  return Buffer.from(hkdfSync('sha256', kek, Buffer.alloc(0), SPACE_SECRETS_HKDF_INFO, KEY_BYTES))
}

type LogDuck = {
  info: (msg: string, meta?: Record<string, unknown>) => void
  warn: (msg: string, meta?: Record<string, unknown>) => void
}

export type UnifyAction =
  /** File unreadable / nothing decided — legacy path stays active. */
  | 'none'
  /** No secrets file yet — fresh space, binding starts the v2 era. */
  | 'fresh'
  /** v1 entries re-encrypted under the derived key (version → 2). */
  | 'migrated'
  /** File already v2; a leftover legacy key file was renamed away. */
  | 'completed-key-rename'
  /** File already v2 and clean. */
  | 'already-unified'
  /** v1 has entries but the legacy key is gone — restored backup; not touched. */
  | 'blocked-missing-legacy-key'

export interface UnifyResult {
  action: UnifyAction
  /** True ⇔ the caller should bindSecretsMasterKey(derivedKey) on the Space. */
  bound: boolean
  /** Entry names carried over verbatim because they didn't decrypt (already unreadable pre-migration). */
  carried?: string[]
}

export interface UnifyOptions {
  spaceDir: string
  derivedKey: Buffer
  /** Pass-through of GOTONG_SECRET_KEY — legacy env override, honored env-first like loadOrCreateMasterKey. */
  envSecretKey?: string
  /**
   * True when the caller could NOT prove the KEK against the vault DEK
   * (probe returned 'no-vault': DB absent, no DEK row yet, or unreadable).
   * An unproven KEK may be a freshly auto-minted junk key after a restore
   * that (correctly) excluded `identity-master.key` — a committed v2 file
   * WITH entries is evidence of a previous key era, so we refuse to bind
   * rather than let writes poison the store under an unprovable key.
   * v1 migration stays allowed: there the legacy key itself vouches for
   * the plaintexts, and a fresh identity's minted KEK is legitimately the
   * new root. Absent/false = proven ('ok' probe).
   */
  kekUnproven?: boolean
  log?: LogDuck
}

/**
 * Migrate `secrets.enc.json` to the derived key if needed. Idempotent, safe
 * to call every boot. Never throws for expected states (missing key,
 * unreadable file) — those return `bound: false` so the caller keeps the
 * legacy path; genuine fs faults propagate to the caller's catch.
 */
export function unifySpaceSecrets(opts: UnifyOptions): UnifyResult {
  const log = opts.log
  const secretsPath = join(opts.spaceDir, SPACE_SECRETS_FILENAME)
  const legacyKeyPath = join(opts.spaceDir, ...LEGACY_SECRET_KEY_REL.split('/'))

  let file: SecretsFile | undefined
  if (existsSync(secretsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(secretsPath, 'utf8')) as Partial<SecretsFile>
      // Known generations only — an unknown (future) version must not be
      // "migrated": we'd rewrite a format we don't understand.
      const v = parsed.version
      if (v !== undefined && v !== 1 && v !== SECRETS_FILE_VERSION_UNIFIED) {
        log?.warn('space secrets: unknown secrets.enc.json version — unification skipped', { version: v })
        return { action: 'none', bound: false }
      }
      file = {
        version: v === SECRETS_FILE_VERSION_UNIFIED ? 2 : 1,
        providers: parsed.providers ?? {},
        agents: parsed.agents ?? {},
      }
    } catch (err) {
      // Corrupt JSON: binding would let writes stamp v2 over a file we never
      // read — leave the legacy path byte-identical and let the operator see
      // the same read error Space itself reports.
      log?.warn('space secrets: unreadable secrets.enc.json — unification skipped', { err })
      return { action: 'none', bound: false }
    }
  }

  // No secrets file at all: nothing to migrate. Retire an orphan legacy key
  // file if present (it protects nothing) and start the v2 era.
  if (!file) {
    retireLegacyKeyFile(legacyKeyPath, log)
    return { action: 'fresh', bound: true }
  }

  if (file.version === SECRETS_FILE_VERSION_UNIFIED) {
    // Unproven KEK + committed v2 entries: an earlier era encrypted these
    // under a key we cannot prove we hold. Binding would refuse reads
    // per-entry but let WRITES land under a possibly-junk key — mixed keys
    // the moment the real key comes back. Stay unbound: Space's v2 guard
    // refuses loudly and the operator restores identity-master.key.
    if (opts.kekUnproven && Object.keys(file.providers).length + Object.keys(file.agents).length > 0) {
      log?.warn(
        'space secrets: v2 entries exist but the KEK cannot be proven against the vault — binding refused. ' +
          'Restore identity-master.key (or GOTONG_MASTER_KEY) from your key stash; see docs/OPERATIONS.md.',
      )
      return { action: 'none', bound: false }
    }
    // Same refusal for a PROVEN KEK of the wrong ERA: entries exist and not
    // one decrypts under this derived key — the file belongs to another KEK
    // generation (interrupted rotation, mixed restore). Binding would let
    // writes stamp THIS era into THAT file: a mixed-key file no single key
    // ever fully reads again. (≥1 readable entry = this era; the rest are
    // carried legacy ciphertext, same as migration leaves behind.)
    const v2Entries = [...Object.values(file.providers), ...Object.values(file.agents)]
    if (v2Entries.length > 0 && !v2Entries.some((enc) => decryptsUnder(enc, opts.derivedKey))) {
      log?.warn(
        'space secrets: no v2 entry decrypts under the derived key — another KEK generation wrote this ' +
          'file; binding refused to avoid mixing eras. Restore the matching identity-master.key, or move ' +
          'secrets.enc.json aside and re-enter the API keys; see docs/OPERATIONS.md.',
      )
      return { action: 'none', bound: false }
    }
    // Already unified. A legacy key file still present = the rename phase of
    // a previous migration was interrupted — finish it.
    if (existsSync(legacyKeyPath)) {
      retireLegacyKeyFile(legacyKeyPath, log)
      return { action: 'completed-key-rename', bound: true }
    }
    return { action: 'already-unified', bound: true }
  }

  // v1. Empty file: nothing to re-encrypt — commit the v2 marker so a later
  // un-bound boot can't silently mint a junk legacy key for it.
  const entryCount = Object.keys(file.providers).length + Object.keys(file.agents).length
  if (entryCount === 0) {
    writeJsonAtomicSync(secretsPath, { version: SECRETS_FILE_VERSION_UNIFIED, providers: {}, agents: {} }, SECURE_FILE_MODE)
    retireLegacyKeyFile(legacyKeyPath, log)
    return { action: 'migrated', bound: true }
  }

  // v1 with entries: we need the legacy key. Same precedence as
  // loadOrCreateMasterKey (env first, then file) — but never CREATE one.
  const legacyKey = resolveLegacyKey(legacyKeyPath, opts.envSecretKey, log)
  if (!legacyKey) {
    log?.warn(
      'space secrets: v1 entries present but the legacy key is unavailable — unification blocked. ' +
        'This is expected after restoring a backup (the key is excluded by design): re-enter the ' +
        'API keys in the admin panel and the next boot unifies them.',
      { secretsPath },
    )
    return { action: 'blocked-missing-legacy-key', bound: false }
  }

  // Backup first, then re-encrypt. Entries that don't DECRYPT under the
  // legacy key were already unreadable before today — carry the ciphertext
  // verbatim (绝不静默删数据) and name them in the log. An ENCRYPT failure is
  // different: the entry was readable, so losing it would be data loss —
  // abort the whole migration (legacy path intact, retried next boot).
  const carried: string[] = []
  const reencrypt = (section: Record<string, EncryptedSecret>, label: string): Record<string, EncryptedSecret> => {
    const out: Record<string, EncryptedSecret> = {}
    for (const [name, enc] of Object.entries(section)) {
      let plaintext: string | undefined
      try {
        plaintext = decryptSecret(legacyKey, enc)
      } catch {
        out[name] = enc
        carried.push(`${label}:${name}`)
        continue
      }
      out[name] = encryptSecret(opts.derivedKey, plaintext) // throws → migration aborts
    }
    return out
  }
  const migrated: SecretsFile = {
    version: SECRETS_FILE_VERSION_UNIFIED,
    providers: reencrypt(file.providers, 'provider'),
    agents: reencrypt(file.agents, 'agent'),
  }
  preserveBackupCopy(secretsPath, secretsPath + PRE_UNIFY_BAK_SUFFIX)
  writeJsonAtomicSync(secretsPath, migrated, SECURE_FILE_MODE)
  retireLegacyKeyFile(legacyKeyPath, log)
  if (carried.length > 0) {
    log?.warn('space secrets: entries carried verbatim (undecryptable before migration too)', { carried })
  }
  return { action: 'migrated', bound: true, carried: carried.length > 0 ? carried : undefined }
}

/**
 * Copy `src` to `bak` without ever clobbering different bytes: an identical
 * backup already there is kept as-is; a DIFFERENT one (older workspace
 * generation restored over a migrated dir) is preserved and the new copy
 * goes to the first free `<bak>.N`. COPYFILE_EXCL keeps the copy from
 * following a pre-planted symlink at the destination.
 */
function preserveBackupCopy(src: string, bak: string): void {
  let target = bak
  if (existsSync(bak)) {
    if (readFileSync(bak).equals(readFileSync(src))) return
    let n = 2
    while (existsSync(`${bak}.${n}`)) n++
    target = `${bak}.${n}`
  }
  copyFileSync(src, target, fsConstants.COPYFILE_EXCL)
  try {
    chmodSync(target, SECURE_FILE_MODE)
  } catch {
    // exFAT / SMB: mode bits not honored; same tolerance as the key writers.
  }
}

/**
 * Rename the legacy key file out of the active path — keep the bytes, and
 * never overwrite a DIFFERENT existing backup (renamed-not-deleted means
 * not-deleted for the previous backup either). Best-effort: by the time
 * this runs the v2 file is committed, so a rename failure (EACCES…) must
 * not block binding — warn and let `completed-key-rename` retry next boot.
 */
function retireLegacyKeyFile(legacyKeyPath: string, log?: LogDuck): void {
  try {
    if (!existsSync(legacyKeyPath)) return
    let bak = legacyKeyPath + PRE_UNIFY_BAK_SUFFIX
    if (existsSync(bak) && !readFileSync(bak).equals(readFileSync(legacyKeyPath))) {
      let n = 2
      while (existsSync(`${bak}.${n}`)) n++
      bak = `${bak}.${n}`
    }
    rmSync(bak, { force: true }) // identical bytes (or free slot) only — Windows rename needs the target gone
    renameSync(legacyKeyPath, bak)
  } catch (err) {
    log?.warn('space secrets: could not retire the legacy key file (will retry next boot)', { err })
  }
}

/** env-first legacy key resolution; returns undefined instead of creating. */
function resolveLegacyKey(legacyKeyPath: string, envSecretKey: string | undefined, log?: LogDuck): Buffer | undefined {
  // Strict 64-hex — Buffer.from(…, 'hex') silently tolerates trailing junk.
  const parse = (raw: string): Buffer | undefined => {
    const s = raw.trim()
    return /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, 'hex') : undefined
  }
  if (envSecretKey) {
    const buf = parse(envSecretKey)
    if (buf) return buf
    log?.warn('space secrets: GOTONG_SECRET_KEY is not exactly 64 hex chars — ignored for migration')
    return undefined
  }
  if (!existsSync(legacyKeyPath)) return undefined
  try {
    return parse(readFileSync(legacyKeyPath, 'utf8'))
  } catch {
    return undefined
  }
}

// --- rotation support -------------------------------------------------------

/**
 * Shared refusal for "the secrets staging path is occupied". Raised by the
 * cheap pre-check AND by the exclusive `link()` commit below — the pre-check
 * gives the common case a clean early exit, the link closes the
 * check-to-commit race window with the filesystem as arbiter.
 */
function stagedSecretsExistError(): Error {
  return new Error(
    `${STAGED_SECRETS_FILENAME} already exists — recovery kept it because it could not be judged ` +
      '(it may be the only surviving copy of re-encrypted secrets). Inspect it, move it aside ' +
      '(or delete it if you are sure), then re-run. See docs/OPERATIONS.md.',
  )
}

/**
 * Stage `secrets.enc.json.next` re-encrypted under HKDF(newKek). Called by
 * rotate-master-key BEFORE the DB re-wrap. Returns 'none' when the file is
 * absent or still v1 (not yet bound to the KEK — rotation must not touch it).
 * Undecryptable entries are carried verbatim, same posture as migration.
 */
export function stageRotatedSecrets(spaceDir: string, oldKek: Buffer, newKek: Buffer): 'staged' | 'none' {
  // A pre-existing staging file here is one recovery chose to KEEP because it
  // could not judge it (unknown generation, unreadable, possibly the only
  // surviving ciphertext). Overwriting it would destroy exactly what that
  // refusal protected — stop the rotation before anything commits instead.
  // (Recovery-judged debris is deleted before this runs; a same-run re-stage
  // only happens after the staging was swept, i.e. the path is free.)
  const stagedPath = join(spaceDir, STAGED_SECRETS_FILENAME)
  if (existsSync(stagedPath)) {
    throw stagedSecretsExistError()
  }
  const secretsPath = join(spaceDir, SPACE_SECRETS_FILENAME)
  if (!existsSync(secretsPath)) return 'none'
  const parsed = JSON.parse(readFileSync(secretsPath, 'utf8')) as Partial<SecretsFile>
  // Explicit v1 (or unversioned) = not yet bound to the KEK — rotation must
  // not touch it. An UNKNOWN version is different: a newer Gotong derived its
  // key from the KEK we're about to replace, so skipping would strand it.
  // Refuse — the throw lands before the DB re-wrap, so nothing commits.
  const v = parsed.version
  if (v === undefined || v === 1) return 'none'
  if (v !== SECRETS_FILE_VERSION_UNIFIED) {
    throw new Error(
      `secrets.enc.json has unknown version ${JSON.stringify(v)} — refusing to rotate the KEK under it (newer Gotong wrote it?)`,
    )
  }
  const oldKey = deriveSpaceSecretsKey(oldKek)
  const newKey = deriveSpaceSecretsKey(newKek)
  // Same decrypt/encrypt split as migration: only a DECRYPT failure (entry
  // was already unreadable) is carried; an encrypt failure aborts the whole
  // rotation before its commit point.
  const reencrypt = (section: Record<string, EncryptedSecret> | undefined): Record<string, EncryptedSecret> => {
    const out: Record<string, EncryptedSecret> = {}
    for (const [name, enc] of Object.entries(section ?? {})) {
      let plaintext: string | undefined
      try {
        plaintext = decryptSecret(oldKey, enc)
      } catch {
        out[name] = enc
        continue
      }
      out[name] = encryptSecret(newKey, plaintext)
    }
    return out
  }
  const staged: SecretsFile = {
    version: SECRETS_FILE_VERSION_UNIFIED,
    providers: reencrypt(parsed.providers),
    agents: reencrypt(parsed.agents),
  }
  // Commit via hardlink, not rename: rename CLOBBERS whatever landed on the
  // staging path between the pre-check above and this commit (a racing
  // rotation's fresh staging, or a copy recovery kept). link() fails EEXIST
  // instead — the filesystem is the arbiter, same posture as the key file's
  // `wx` claim. The tmp is fully written AND fsync'd before it becomes
  // visible on the staging path, so the durability barrier below still
  // precedes the caller's DB commit (a power cut can otherwise commit the DB
  // to the new KEK while this staging never reached disk).
  const tmp = uniqueTmpPath(stagedPath)
  writeFileSync(tmp, `${JSON.stringify(staged, null, 2)}\n`, { encoding: 'utf8', mode: SECURE_FILE_MODE })
  try {
    fsyncFile(tmp)
    linkSync(tmp, stagedPath)
  } catch (err) {
    rmSync(tmp, { force: true })
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw stagedSecretsExistError()
    throw err
  }
  rmSync(tmp, { force: true })
  fsyncDirBestEffort(spaceDir)
  return 'staged'
}

/**
 * fsync `path`. Only "this filesystem doesn't support fsync" answers
 * (ENOTSUP / EINVAL / EISDIR) are tolerable — a real I/O failure (EIO,
 * ENOSPC, …) means the durability promise did NOT hold, and pretending
 * otherwise would let a DB commit against bytes that never reached disk.
 */
export function fsyncFile(path: string): void {
  const fd = openSync(path, 'r+')
  try {
    fsyncSync(fd)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOTSUP' && code !== 'EINVAL' && code !== 'EISDIR') throw err
  } finally {
    closeSync(fd)
  }
}

/** Directory-entry fsync is pure best-effort — directories can't be opened on
 *  Windows and many mounts reject fsync on them; the file fsync above is the
 *  load-bearing half. */
export function fsyncDirBestEffort(dir: string): void {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // tolerated by design
  }
}

/** Promote the staged copy over the live file. True if there was one. */
export function promoteStagedSecrets(spaceDir: string): boolean {
  const stagedPath = join(spaceDir, STAGED_SECRETS_FILENAME)
  if (!existsSync(stagedPath)) return false
  renameSync(stagedPath, join(spaceDir, SPACE_SECRETS_FILENAME))
  // Ordering barrier: both callers rename the KEY file right after this
  // returns. If a power cut persisted that key rename but rolled back this
  // one, the next boot would see the old-era secrets live and the staging
  // gone from the promote — make this rename durable before the key moves.
  // (Best-effort only; reconcileStagedSecrets is the backstop when the
  // filesystem can't honor it.)
  fsyncDirBestEffort(spaceDir)
  return true
}

/** Discard the staged copy (rotation rolled back). True if there was one. */
export function discardStagedSecrets(spaceDir: string): boolean {
  const stagedPath = join(spaceDir, STAGED_SECRETS_FILENAME)
  if (!existsSync(stagedPath)) return false
  rmSync(stagedPath, { force: true })
  return true
}

/**
 * Judge `secrets.enc.json.next` — the ONLY code allowed to destroy or
 * promote a staging file its caller didn't just write itself. All three
 * recovery branches route through it (`master-key-recovery.ts`), and so
 * does rotate-master-key's own post-commit settle — nothing blind-promotes.
 *
 * Two hard rules bound the destructive moves:
 *
 *   1. AUTHORITY — trial-decrypt proves a file matches a key, not that the
 *      key is this workspace's KEK (a stray/wrong live key must judge
 *      nothing). `provenKek` is therefore the caller's assertion that the
 *      vault DEK probe answered 'ok' for it; without that, only the
 *      key-independent verdicts (byte-identical copy, zero entries) may
 *      delete, everything else is kept.
 *   2. POSITIVE EVIDENCE, PER SLOT — a whole-file verdict needs every entry
 *      accounted for; "some entry decrypts" proves nothing about the rest.
 *
 *      DISCARD only if every staged `section:name` slot loses nothing:
 *      byte-identical to the live slot (carried pairs included), or both
 *      decrypt to the same plaintext (redundant), or the staged slot is
 *      dead under the proven key while the live slot reads (stale
 *      predecessor of a healthy slot).
 *
 *      PROMOTE only if ≥1 staged slot reads under the proven key AND every
 *      LIVE slot is covered by the staging: byte-identical, or staged
 *      reads while live is dead (the re-encryption of an old-era
 *      original — and when the caller supplies the PRIOR era's key as a
 *      witness, the dead slot must read the same value under it: a slot
 *      UPDATED under the old era after the staging was cut is a newer
 *      value, and rolling it back would be silent data loss), or both
 *      read the same plaintext. A missing live file is vacuously covered
 *      (only-copy survivor); an unparseable or foreign-format live file
 *      is NEVER clobbered.
 *
 *      Everything else — unparseable staging, unknown generations,
 *      structurally invalid sections, divergent readable values, live
 *      slots the staging lacks — is KEPT for an operator.
 *
 * Destructive moves bind evidence to the ENTITY operated on, not a path: the
 * staging is first CLAIMED — one rename() moves whatever inode sits at the
 * path into a run-unique `.judging.*` slot — then the claim is byte-verified
 * against the judged snapshot. A racer's swap either escapes the claim
 * (ENOENT → kept) or fails the verify and is restored; the promote renames
 * the CLAIMED inode, so bytes staged after our read can never reach the live
 * path unjudged. A crash inside that window parks the staging at the claim
 * slot; every reconcile pass re-parks such orphans first (restore-first).
 *
 * A 'kept' file can NOT be destroyed by the paths that don't judge:
 * `stageRotatedSecrets` refuses to overwrite an existing staging (link()
 * EEXIST — the next rotation stops loudly instead).
 */
export function reconcileStagedSecrets(
  spaceDir: string,
  provenKek: Buffer | undefined,
  opts?: { priorKek?: Buffer },
): 'promoted' | 'discarded' | 'kept' | 'none' {
  const stagedPath = join(spaceDir, STAGED_SECRETS_FILENAME)
  restoreJudgingOrphans(spaceDir, stagedPath)
  if (!existsSync(stagedPath)) return 'none'
  const livePath = join(spaceDir, SPACE_SECRETS_FILENAME)
  let stagedBytes: Buffer
  try {
    stagedBytes = readFileSync(stagedPath)
  } catch {
    return 'kept'
  }
  // ONE raw read of the live file anchors every judgment below AND the
  // destination re-verify inside destroy(): the verdict binds to these bytes,
  // not to "whatever sits at the path at act time". Present-but-unreadable is
  // 'invalid' (never clobbered), never mistaken for absent (vacuous promote).
  let liveBytesJudged: Buffer | undefined
  let liveParsed: SlotMap | 'absent' | 'invalid'
  try {
    liveBytesJudged = readFileSync(livePath)
    liveParsed = parseV2Slots(liveBytesJudged)
  } catch {
    liveBytesJudged = undefined
    liveParsed = existsSync(livePath) ? 'invalid' : 'absent'
  }
  // Claim → verify → act (see doc comment). The claim slot is private to this
  // call, so the rm/rename inside it are race-free by construction.
  const destroy = (verdict: 'discarded' | 'promoted'): 'discarded' | 'promoted' | 'kept' => {
    const claim = `${stagedPath}.judging.${process.pid}-${randomBytes(4).toString('hex')}`
    try {
      renameSync(stagedPath, claim)
    } catch {
      return 'kept' // staging vanished underneath us — the racer owns the outcome
    }
    let claimed: Buffer
    try {
      claimed = readFileSync(claim)
    } catch {
      return 'kept' // unreadable claim — restore-first re-parks it next pass
    }
    if (!claimed.equals(stagedBytes)) {
      // We claimed a racer's replacement, not the judged file: put it back.
      // link() no-clobber — if the path was re-staged meanwhile, the claim
      // stays parked and restore-first hands it to the next pass.
      restoreLinkDurable(claim, stagedPath, spaceDir)
      return 'kept'
    }
    // Bind the DESTINATION too: the verdict rests on the live bytes read at
    // entry, so a live file that changed since (a host writing mid-rotation,
    // outside the stop-the-host discipline) invalidates it — restore the
    // claim and keep. The residual exposure is the rename syscall itself,
    // and a still-running host would clobber any promote with its very next
    // save regardless: the discipline, not this check, is the invariant.
    let liveNow: Buffer | undefined
    try {
      liveNow = readFileSync(livePath)
    } catch {
      liveNow = undefined
    }
    const liveUnchanged =
      liveBytesJudged === undefined
        ? liveNow === undefined && !existsSync(livePath)
        : liveNow !== undefined && liveNow.equals(liveBytesJudged)
    if (!liveUnchanged) {
      restoreLinkDurable(claim, stagedPath, spaceDir)
      return 'kept'
    }
    if (verdict === 'discarded') {
      rmSync(claim, { force: true })
      return 'discarded'
    }
    renameSync(claim, livePath)
    fsyncDirBestEffort(spaceDir)
    return 'promoted'
  }
  // A byte-identical duplicate of the live file is safe to drop under ANY
  // key state — deleting an exact copy loses nothing.
  if (liveBytesJudged !== undefined && stagedBytes.equals(liveBytesJudged)) return destroy('discarded')
  const staged = parseV2Slots(stagedBytes)
  if (staged === 'invalid') return 'kept'
  if (staged.size === 0) return destroy('discarded') // zero entries — nothing a deletion could lose
  if (!provenKek) return 'kept'
  let derived: Buffer
  try {
    derived = deriveSpaceSecretsKey(provenKek)
  } catch {
    return 'kept'
  }
  // Prior-era witness (rotation knows currentKey, recovery's promote branch
  // has the live key). Only ever RESTRICTIVE: it can demote a would-be
  // promote to kept, never enable a destructive verdict on its own. Three
  // states, not two: SUPPLIED but underivable (a torn live key file) must
  // block like a disagreeing witness — collapsing it to "not supplied"
  // would fail open exactly when the old era is least trustworthy.
  let priorDerived: Buffer | 'invalid' | undefined
  if (opts?.priorKek) {
    try {
      priorDerived = deriveSpaceSecretsKey(opts.priorKek)
    } catch {
      priorDerived = 'invalid'
    }
  }
  const live = liveParsed
  const stagedPt = new Map<string, string | undefined>()
  for (const [slot, enc] of staged) stagedPt.set(slot, plaintextOf(enc, derived))

  if (live !== 'absent' && live !== 'invalid') {
    let discardable = true
    for (const [slot, enc] of staged) {
      const liveEnc = live.get(slot)
      const sPt = stagedPt.get(slot)
      const lPt = liveEnc === undefined ? undefined : plaintextOf(liveEnc, derived)
      const loseNothing =
        (liveEnc !== undefined && sameCiphertext(enc, liveEnc)) || // carried pair / identical bytes
        (sPt !== undefined && lPt !== undefined && sPt === lPt) || // redundant duplicate
        (sPt === undefined && lPt !== undefined) // stale predecessor of a healthy slot
      if (!loseNothing) {
        discardable = false
        break
      }
    }
    if (discardable) return destroy('discarded')
  }
  const anyStagedReads = [...stagedPt.values()].some((v) => v !== undefined)
  if (anyStagedReads) {
    if (live === 'absent') return destroy('promoted') // only surviving copy wins
    if (live !== 'invalid') {
      let covered = true
      for (const [slot, liveEnc] of live) {
        const sEnc = staged.get(slot)
        if (sEnc === undefined) {
          covered = false // live has a slot the staging lacks — promote would lose it
          break
        }
        const sPt = stagedPt.get(slot)
        const lPt = plaintextOf(liveEnc, derived)
        const ok =
          sameCiphertext(sEnc, liveEnc) ||
          // readable re-encryption over a dead original — unless the prior-era
          // witness shows the dead slot held a DIFFERENT value (updated after
          // the staging was cut, or a third era entirely): rolling that back
          // would be silent data loss. An unusable witness blocks the same way.
          (sPt !== undefined &&
            lPt === undefined &&
            (priorDerived === undefined ||
              (priorDerived !== 'invalid' && plaintextOf(liveEnc, priorDerived) === sPt))) ||
          (sPt !== undefined && sPt === lPt)
        if (!ok) {
          covered = false // divergent readable values — order unprovable
          break
        }
      }
      if (covered) return destroy('promoted')
    }
  }
  // No positive evidence either way (foreign era, divergence, unparseable
  // live under a would-be promote). The staging may be the only surviving
  // copy — keep it for an operator.
  return 'kept'
}

/**
 * Re-park crash-orphaned `.judging.*` claim slots onto the staging path so
 * the judge above sees them again (a crash between claim and act would
 * otherwise hide the staging from every path check forever). One orphan
 * restores per pass (no-clobber link); any parked while the path is occupied
 * stay put — the restored file then flows through the normal kept/NOTE
 * machinery, which is what reports it to the operator.
 */
function restoreJudgingOrphans(spaceDir: string, stagedPath: string): void {
  const prefix = `${STAGED_SECRETS_FILENAME}.judging.`
  let names: string[]
  try {
    names = readdirSync(spaceDir)
      .filter((n) => n.startsWith(prefix))
      .sort()
  } catch {
    return
  }
  for (const name of names) {
    if (existsSync(stagedPath)) return // occupied — orphans stay parked
    restoreLinkDurable(join(spaceDir, name), stagedPath, spaceDir)
  }
}

/**
 * Restore a parked/claimed file onto `to` — link() no-clobber, with the NEW
 * name made durable BEFORE the old one is dropped: without that barrier a
 * power cut can persist the unlink but not the link, and these bytes may be
 * the only readable copy of the provider secrets. Returns false when the
 * target is occupied or the fs refuses (the source stays parked for the
 * next pass).
 */
function restoreLinkDurable(from: string, to: string, dir: string): boolean {
  try {
    linkSync(from, to)
  } catch {
    return false // EEXIST / fs error — leave it parked
  }
  fsyncDirBestEffort(dir)
  try {
    rmSync(from, { force: true })
    fsyncDirBestEffort(dir)
  } catch {
    /* cleanup only — the restore itself is durable */
  }
  return true
}

/**
 * true = ≥1 live entry decrypts under HKDF(kek); false = entries exist but
 * none do (era mismatch — the file belongs to another KEK generation);
 * undefined = nothing to judge (missing / empty / unenumerable file, or the
 * KEK can't derive). Lets recovery and rotation tell a benign kept staging
 * (live healthy) from one masking an unreadable live file.
 */
export function liveSecretsReadUnder(spaceDir: string, kek: Buffer): boolean | undefined {
  let derived: Buffer
  try {
    derived = deriveSpaceSecretsKey(kek)
  } catch {
    return undefined
  }
  const live = readV2Slots(join(spaceDir, SPACE_SECRETS_FILENAME))
  if (live === 'absent' || live === 'invalid' || live.size === 0) return undefined
  for (const enc of live.values()) if (plaintextOf(enc, derived) !== undefined) return true
  return false
}

// --- slot-level helpers -----------------------------------------------------

/** `section:name` → ciphertext for a v2 file. */
type SlotMap = Map<string, EncryptedSecret>

/** 'invalid' = present but not enumerable (bad JSON, wrong/unknown version,
 *  non-object section) — never conflated with "zero entries". */
function parseV2Slots(bytes: Buffer): SlotMap | 'invalid' {
  let parsed: Partial<SecretsFile>
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as Partial<SecretsFile>
  } catch {
    return 'invalid'
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== SECRETS_FILE_VERSION_UNIFIED) {
    return 'invalid'
  }
  const slots: SlotMap = new Map()
  for (const section of ['providers', 'agents'] as const) {
    const sec = parsed[section]
    if (sec === undefined || sec === null) continue
    if (typeof sec !== 'object' || Array.isArray(sec)) return 'invalid'
    for (const [name, enc] of Object.entries(sec)) slots.set(`${section}:${name}`, enc)
  }
  return slots
}

function readV2Slots(path: string): SlotMap | 'absent' | 'invalid' {
  if (!existsSync(path)) return 'absent'
  try {
    return parseV2Slots(readFileSync(path))
  } catch {
    return 'invalid'
  }
}

function decryptsUnder(enc: EncryptedSecret, key: Buffer): boolean {
  return plaintextOf(enc, key) !== undefined
}

function plaintextOf(enc: EncryptedSecret, key: Buffer): string | undefined {
  try {
    return decryptSecret(key, enc)
  } catch {
    return undefined
  }
}

/** Ciphertext equality via stringify round-trip: both sides come out of the
 *  same JSON.parse of files our own writers serialized, so field order is
 *  stable; a hand-edited exotic ordering merely fails toward 'kept'. */
function sameCiphertext(a: EncryptedSecret, b: EncryptedSecret): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
