import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  decryptSecret,
  encryptSecret,
  Space,
  type EncryptedSecret,
  type SecretsFile,
} from '@gotong/core'
import { openIdentityStore } from '@gotong/identity'

import {
  deriveSpaceSecretsKey,
  discardStagedSecrets,
  promoteStagedSecrets,
  reconcileStagedSecrets,
  stageRotatedSecrets,
  unifySpaceSecrets,
  PRE_UNIFY_BAK_SUFFIX,
  SPACE_SECRETS_FILENAME,
  STAGED_SECRETS_FILENAME,
} from '../src/space-secrets-unify.js'
import {
  IDENTITY_DB_FILENAME,
  installClaimedKey,
  MASTER_KEY_FILENAME,
  rotateMasterKey,
} from '../src/rotate-master-key.js'
import { recoverMasterKeyRotation } from '../src/master-key-recovery.js'

/**
 * B① master-key unification. Pins the whole convergence story:
 *
 *   - migration: v1 → v2 re-encryption is backup-first, idempotent, and
 *     crash-safe (every interruption point lands in a branch that finishes
 *     or retries — never a mixed-key file);
 *   - binding gate: a blocked migration (restored backup without its legacy
 *     key) binds NOTHING, so the legacy path stays byte-identical;
 *   - rotation: the derived key rotates with the KEK — staged secrets commit
 *     or roll back in the same recovery branch as `<keyfile>.next`;
 *   - end-to-end: a real Space with the bound key reads the migrated
 *     plaintexts and stamps v2 on writes.
 */

const KEK_A = Buffer.alloc(32, 0xaa)
const KEK_B = Buffer.alloc(32, 0xbb)
const KEK_C = Buffer.alloc(32, 0xcc)
const LEGACY_KEY = Buffer.alloc(32, 0x33)

let dir: string
let secretsPath: string
let legacyKeyPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gotong-unify-'))
  secretsPath = join(dir, SPACE_SECRETS_FILENAME)
  legacyKeyPath = join(dir, 'runtime', 'secret.key')
  mkdirSync(join(dir, 'runtime'), { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeLegacyKeyFile(): void {
  // core's loadOrCreateMasterKey stores the key as hex text.
  writeFileSync(legacyKeyPath, LEGACY_KEY.toString('hex') + '\n', { mode: 0o600 })
}

function writeV1File(entries: { providers?: Record<string, string>; agents?: Record<string, string> }): void {
  const enc = (pt: string): EncryptedSecret => encryptSecret(LEGACY_KEY, pt)
  const file: SecretsFile = {
    version: 1,
    providers: Object.fromEntries(Object.entries(entries.providers ?? {}).map(([k, v]) => [k, enc(v)])),
    agents: Object.fromEntries(Object.entries(entries.agents ?? {}).map(([k, v]) => [k, enc(v)])),
  }
  writeFileSync(secretsPath, JSON.stringify(file), { mode: 0o600 })
}

function readFileJson(): SecretsFile {
  return JSON.parse(readFileSync(secretsPath, 'utf8')) as SecretsFile
}

describe('deriveSpaceSecretsKey', () => {
  it('is deterministic, 32 bytes, and differs per KEK', () => {
    const a1 = deriveSpaceSecretsKey(KEK_A)
    const a2 = deriveSpaceSecretsKey(KEK_A)
    const b = deriveSpaceSecretsKey(KEK_B)
    expect(a1.length).toBe(32)
    expect(a1.equals(a2)).toBe(true)
    expect(a1.equals(b)).toBe(false)
    // Domain separation: the derived key is never the KEK itself.
    expect(a1.equals(KEK_A)).toBe(false)
  })

  it('rejects a wrong-length KEK', () => {
    expect(() => deriveSpaceSecretsKey(Buffer.alloc(16))).toThrow(/32 bytes/)
  })
})

describe('unifySpaceSecrets (boot migration)', () => {
  const derived = deriveSpaceSecretsKey(KEK_A)

  it('fresh space (no secrets file): binds and retires an orphan legacy key', () => {
    writeLegacyKeyFile()
    const r = unifySpaceSecrets({ spaceDir: dir, derivedKey: derived })
    expect(r).toMatchObject({ action: 'fresh', bound: true })
    expect(existsSync(legacyKeyPath)).toBe(false)
    expect(existsSync(legacyKeyPath + PRE_UNIFY_BAK_SUFFIX)).toBe(true)
  })

  it('v1 with entries + legacy key file: migrates, backup-first, key renamed', () => {
    writeLegacyKeyFile()
    writeV1File({ providers: { anthropic: 'sk-ant-1' }, agents: { a1: 'sk-agent-1' } })
    const r = unifySpaceSecrets({ spaceDir: dir, derivedKey: derived })
    expect(r).toMatchObject({ action: 'migrated', bound: true })
    const file = readFileJson()
    expect(file.version).toBe(2)
    // Plaintexts survive under the DERIVED key…
    expect(decryptSecret(derived, file.providers.anthropic!)).toBe('sk-ant-1')
    expect(decryptSecret(derived, file.agents.a1!)).toBe('sk-agent-1')
    // …and the legacy key no longer decrypts the new ciphertext.
    expect(() => decryptSecret(LEGACY_KEY, file.providers.anthropic!)).toThrow()
    // Backup-first: the pre-migration copy still decrypts with the legacy key.
    const bak = JSON.parse(readFileSync(secretsPath + PRE_UNIFY_BAK_SUFFIX, 'utf8')) as SecretsFile
    expect(decryptSecret(LEGACY_KEY, bak.providers.anthropic!)).toBe('sk-ant-1')
    // The legacy key file is renamed, never deleted.
    expect(existsSync(legacyKeyPath)).toBe(false)
    expect(readFileSync(legacyKeyPath + PRE_UNIFY_BAK_SUFFIX, 'utf8').trim()).toBe(LEGACY_KEY.toString('hex'))
  })

  it('is idempotent: second run is already-unified and touches nothing', () => {
    writeLegacyKeyFile()
    writeV1File({ providers: { anthropic: 'sk-ant-1' } })
    unifySpaceSecrets({ spaceDir: dir, derivedKey: derived })
    const bytes = readFileSync(secretsPath, 'utf8')
    const r2 = unifySpaceSecrets({ spaceDir: dir, derivedKey: derived })
    expect(r2).toMatchObject({ action: 'already-unified', bound: true })
    expect(readFileSync(secretsPath, 'utf8')).toBe(bytes)
  })

  it('crash between v2 write and key rename: next boot finishes the rename', () => {
    // Simulate: file already v2, legacy key file still present.
    writeLegacyKeyFile()
    writeV1File({ providers: { anthropic: 'sk-ant-1' } })
    unifySpaceSecrets({ spaceDir: dir, derivedKey: derived })
    // Resurrect the legacy key file as if the rename never happened.
    writeLegacyKeyFile()
    const r = unifySpaceSecrets({ spaceDir: dir, derivedKey: derived })
    expect(r).toMatchObject({ action: 'completed-key-rename', bound: true })
    expect(existsSync(legacyKeyPath)).toBe(false)
  })

  it('v1 entries but legacy key missing (restored backup): blocked, file untouched, NOT bound', () => {
    writeV1File({ providers: { anthropic: 'sk-ant-1' } })
    const bytes = readFileSync(secretsPath, 'utf8')
    const r = unifySpaceSecrets({ spaceDir: dir, derivedKey: derived })
    expect(r).toMatchObject({ action: 'blocked-missing-legacy-key', bound: false })
    expect(readFileSync(secretsPath, 'utf8')).toBe(bytes)
    expect(existsSync(secretsPath + PRE_UNIFY_BAK_SUFFIX)).toBe(false)
  })

  it('GOTONG_SECRET_KEY env legacy (no key file): migrates via the env key', () => {
    writeV1File({ providers: { deepseek: 'sk-ds-1' } })
    const r = unifySpaceSecrets({
      spaceDir: dir,
      derivedKey: derived,
      envSecretKey: LEGACY_KEY.toString('hex'),
    })
    expect(r).toMatchObject({ action: 'migrated', bound: true })
    expect(decryptSecret(derived, readFileJson().providers.deepseek!)).toBe('sk-ds-1')
  })

  it('empty v1 file: commits the v2 marker without needing the legacy key', () => {
    writeFileSync(secretsPath, JSON.stringify({ version: 1, providers: {}, agents: {} }))
    const r = unifySpaceSecrets({ spaceDir: dir, derivedKey: derived })
    expect(r).toMatchObject({ action: 'migrated', bound: true })
    expect(readFileJson().version).toBe(2)
  })

  it('an undecryptable entry is carried verbatim (绝不静默删数据), the rest migrate', () => {
    writeLegacyKeyFile()
    writeV1File({ providers: { anthropic: 'sk-ant-1' } })
    // Inject a corrupt entry encrypted under some unrelated key.
    const file = readFileJson()
    file.providers.broken = encryptSecret(Buffer.alloc(32, 0x77), 'lost')
    writeFileSync(secretsPath, JSON.stringify(file))
    const r = unifySpaceSecrets({ spaceDir: dir, derivedKey: derived })
    expect(r.action).toBe('migrated')
    expect(r.carried).toEqual(['provider:broken'])
    const out = readFileJson()
    expect(decryptSecret(derived, out.providers.anthropic!)).toBe('sk-ant-1')
    // Carried bytes are byte-identical to the pre-migration ciphertext.
    expect(out.providers.broken).toEqual(file.providers.broken)
  })

  it('corrupt JSON: does nothing and does NOT bind', () => {
    writeFileSync(secretsPath, '{not json')
    const r = unifySpaceSecrets({ spaceDir: dir, derivedKey: derived })
    expect(r).toMatchObject({ action: 'none', bound: false })
    expect(readFileSync(secretsPath, 'utf8')).toBe('{not json')
  })

  it('unknown (future) file version: refuses to touch it, does NOT bind', () => {
    const future = JSON.stringify({ version: 3, providers: {}, agents: {} })
    writeFileSync(secretsPath, future)
    const r = unifySpaceSecrets({ spaceDir: dir, derivedKey: derived })
    expect(r).toMatchObject({ action: 'none', bound: false })
    // "Migrating" a format we don't understand would destroy it — bytes intact.
    expect(readFileSync(secretsPath, 'utf8')).toBe(future)
  })

  it('malformed GOTONG_SECRET_KEY (65 hex chars) is rejected, not silently truncated', () => {
    writeV1File({ providers: { anthropic: 'sk-ant-1' } })
    const bytes = readFileSync(secretsPath, 'utf8')
    const r = unifySpaceSecrets({
      spaceDir: dir,
      derivedKey: derived,
      // Buffer.from(…, 'hex') would quietly drop the odd tail and "succeed"
      // with a key that never encrypted anything — strict shape must refuse.
      envSecretKey: LEGACY_KEY.toString('hex') + 'a',
    })
    expect(r).toMatchObject({ action: 'blocked-missing-legacy-key', bound: false })
    expect(readFileSync(secretsPath, 'utf8')).toBe(bytes)
  })

  it('retire failure (read-only runtime/) still binds; next boot retries the rename', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return // root ignores modes
    writeLegacyKeyFile()
    writeV1File({ providers: { anthropic: 'sk-ant-1' } })
    chmodSync(join(dir, 'runtime'), 0o500)
    try {
      // The v2 file is committed by the time retire runs — a rename EACCES
      // must not un-bind an otherwise complete migration.
      const r = unifySpaceSecrets({ spaceDir: dir, derivedKey: derived })
      expect(r).toMatchObject({ action: 'migrated', bound: true })
      expect(readFileJson().version).toBe(2)
      expect(existsSync(legacyKeyPath)).toBe(true) // rename failed, key still in place
    } finally {
      chmodSync(join(dir, 'runtime'), 0o755)
    }
    const r2 = unifySpaceSecrets({ spaceDir: dir, derivedKey: derived })
    expect(r2).toMatchObject({ action: 'completed-key-rename', bound: true })
    expect(existsSync(legacyKeyPath)).toBe(false)
    expect(readFileSync(legacyKeyPath + PRE_UNIFY_BAK_SUFFIX, 'utf8').trim()).toBe(LEGACY_KEY.toString('hex'))
  })

  it('a DIFFERENT pre-existing backup is never clobbered — new copies take .N suffixes', () => {
    // Plant strangers at both backup destinations (an older workspace
    // generation restored over a migrated dir leaves exactly this).
    writeLegacyKeyFile()
    writeV1File({ providers: { anthropic: 'sk-ant-1' } })
    writeFileSync(secretsPath + PRE_UNIFY_BAK_SUFFIX, 'stranger-secrets')
    writeFileSync(legacyKeyPath + PRE_UNIFY_BAK_SUFFIX, 'stranger-key')
    const preMigration = readFileSync(secretsPath, 'utf8')
    const r = unifySpaceSecrets({ spaceDir: dir, derivedKey: derived })
    expect(r).toMatchObject({ action: 'migrated', bound: true })
    // Strangers intact byte-for-byte…
    expect(readFileSync(secretsPath + PRE_UNIFY_BAK_SUFFIX, 'utf8')).toBe('stranger-secrets')
    expect(readFileSync(legacyKeyPath + PRE_UNIFY_BAK_SUFFIX, 'utf8')).toBe('stranger-key')
    // …and the real backups landed on the first free .N slot.
    expect(readFileSync(secretsPath + PRE_UNIFY_BAK_SUFFIX + '.2', 'utf8')).toBe(preMigration)
    expect(readFileSync(legacyKeyPath + PRE_UNIFY_BAK_SUFFIX + '.2', 'utf8').trim()).toBe(LEGACY_KEY.toString('hex'))
  })

  it('kekUnproven: an unprovable KEK never binds over committed v2 entries', () => {
    // Key-less restore: identity.sqlite absent ⇒ boot auto-mints a junk KEK
    // the vault can't vouch for. Binding its derivation over entries written
    // under the REAL KEK would strand every future write behind a junk key.
    const realDerived = deriveSpaceSecretsKey(KEK_A)
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(realDerived, 'sk-ant-1') }, agents: {} }),
    )
    const bytes = readFileSync(secretsPath, 'utf8')
    const junkDerived = deriveSpaceSecretsKey(KEK_B)
    const r = unifySpaceSecrets({ spaceDir: dir, derivedKey: junkDerived, kekUnproven: true })
    expect(r).toMatchObject({ action: 'none', bound: false })
    expect(readFileSync(secretsPath, 'utf8')).toBe(bytes)
  })

  it('kekUnproven: v1 migration still allowed — the LEGACY key vouches, not the vault', () => {
    // A fresh identity (no vault rows yet) legitimately mints its KEK; the
    // migration's own proof is decrypting v1 entries with the legacy key.
    writeLegacyKeyFile()
    writeV1File({ providers: { anthropic: 'sk-ant-1' } })
    const r = unifySpaceSecrets({ spaceDir: dir, derivedKey: derived, kekUnproven: true })
    expect(r).toMatchObject({ action: 'migrated', bound: true })
    expect(decryptSecret(derived, readFileJson().providers.anthropic!)).toBe('sk-ant-1')
  })

  it('kekUnproven: fresh space (no secrets file) still binds — nothing to poison', () => {
    const r = unifySpaceSecrets({ spaceDir: dir, derivedKey: derived, kekUnproven: true })
    expect(r).toMatchObject({ action: 'fresh', bound: true })
  })

  it('a PROVEN KEK of the wrong era never binds over v2 entries it cannot read', () => {
    // DB and secrets file restored from different generations: the vault
    // vouches for this KEK, yet every v2 entry was written under some OTHER
    // KEK's derivation. Binding would mix eras in one file on the next write
    // — refuse loudly (restore the matching key, or re-enter the API keys).
    const eraA = deriveSpaceSecretsKey(KEK_A)
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(eraA, 'sk-ant-1') }, agents: {} }),
    )
    const bytes = readFileSync(secretsPath, 'utf8')
    const r = unifySpaceSecrets({ spaceDir: dir, derivedKey: deriveSpaceSecretsKey(KEK_B) })
    expect(r).toMatchObject({ action: 'none', bound: false })
    expect(readFileSync(secretsPath, 'utf8')).toBe(bytes)
  })
})

describe('rotation staging (stage / promote / discard)', () => {
  const dA = deriveSpaceSecretsKey(KEK_A)
  const dB = deriveSpaceSecretsKey(KEK_B)

  function writeV2File(): void {
    const file: SecretsFile = {
      version: 2,
      providers: { anthropic: encryptSecret(dA, 'sk-ant-1') },
      agents: {},
    }
    writeFileSync(secretsPath, JSON.stringify(file), { mode: 0o600 })
  }

  it('stages under the NEW derived key; promote replaces the live file', () => {
    writeV2File()
    expect(stageRotatedSecrets(dir, KEK_A, KEK_B)).toBe('staged')
    // Live file untouched until promote.
    expect(decryptSecret(dA, readFileJson().providers.anthropic!)).toBe('sk-ant-1')
    expect(promoteStagedSecrets(dir)).toBe(true)
    expect(decryptSecret(dB, readFileJson().providers.anthropic!)).toBe('sk-ant-1')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(false)
  })

  it('discard removes the staged copy and leaves the live file alone', () => {
    writeV2File()
    stageRotatedSecrets(dir, KEK_A, KEK_B)
    expect(discardStagedSecrets(dir)).toBe(true)
    expect(decryptSecret(dA, readFileJson().providers.anthropic!)).toBe('sk-ant-1')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(false)
  })

  it('a v1 (not yet unified) file is never staged — rotation must not touch it', () => {
    writeLegacyKeyFile()
    writeV1File({ providers: { anthropic: 'sk-ant-1' } })
    expect(stageRotatedSecrets(dir, KEK_A, KEK_B)).toBe('none')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(false)
  })

  it('an unknown (future) file version THROWS — never silently rotates past it', () => {
    // Treating v3 as 'none' would let the KEK rotate while a newer-format
    // secrets file stays under the OLD derived key — permanently stranded.
    // The throw lands before the DB re-wrap, so the rotation aborts whole.
    const future = JSON.stringify({ version: 3, providers: {}, agents: {} })
    writeFileSync(secretsPath, future)
    expect(() => stageRotatedSecrets(dir, KEK_A, KEK_B)).toThrow(/unknown version/)
    expect(readFileSync(secretsPath, 'utf8')).toBe(future)
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(false)
  })

  it('a pre-existing staging file THROWS — never overwrite what recovery kept', () => {
    // Recovery keeps a staging it cannot judge precisely because it may be
    // the only surviving ciphertext. A later rotation must stop loudly at
    // step 1.5 (before anything commits) instead of silently destroying it.
    writeV2File()
    const stagedPath = join(dir, STAGED_SECRETS_FILENAME)
    const kept = JSON.stringify({ version: 3, providers: {}, agents: {} })
    writeFileSync(stagedPath, kept)
    expect(() => stageRotatedSecrets(dir, KEK_A, KEK_B)).toThrow(/already exists/)
    // Both files byte-untouched.
    expect(readFileSync(stagedPath, 'utf8')).toBe(kept)
    expect(decryptSecret(dA, readFileJson().providers.anthropic!)).toBe('sk-ant-1')
  })
})

describe('rotateMasterKey carries the space secrets with the KEK', () => {
  it('after a full rotation the secrets decrypt under HKDF(new KEK) only', () => {
    // Seed vault + unified secrets under KEK_A.
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_A, { mode: 0o600 })
    const s = openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_A })
    s.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret: 'vault-secret' })
    s.close()
    const dA = deriveSpaceSecretsKey(KEK_A)
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dA, 'sk-ant-1') }, agents: {} }),
    )

    rotateMasterKey({ spaceDir: dir, generateKey: () => Buffer.from(KEK_B) })

    const newKek = readFileSync(keyFile)
    expect(newKek.equals(KEK_B)).toBe(true)
    const file = readFileJson()
    expect(file.version).toBe(2)
    expect(decryptSecret(deriveSpaceSecretsKey(KEK_B), file.providers.anthropic!)).toBe('sk-ant-1')
    expect(() => decryptSecret(dA, file.providers.anthropic!)).toThrow()
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(false)
  })

  it('staged secrets swept AFTER the commit re-stage from the live file (self-heal)', () => {
    // Same concurrent-recovery window as the key-file sweep: once the DB
    // committed to the new KEK, losing the staged re-encryption must not
    // leave the live secrets stranded under the OLD derived key — the
    // rotation re-stages from the (untouched) live file and promotes.
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_A, { mode: 0o600 })
    const s = openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_A })
    s.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret: 'vault-secret' })
    s.close()
    const dA = deriveSpaceSecretsKey(KEK_A)
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dA, 'sk-ant-1') }, agents: {} }),
    )

    rotateMasterKey({
      spaceDir: dir,
      generateKey: () => Buffer.from(KEK_B),
      afterDbRewrap: () => rmSync(join(dir, STAGED_SECRETS_FILENAME)),
    })

    // Rotation completed end to end: new KEK live, secrets under HKDF(new).
    expect(readFileSync(keyFile).equals(KEK_B)).toBe(true)
    const file = readFileJson()
    expect(decryptSecret(deriveSpaceSecretsKey(KEK_B), file.providers.anthropic!)).toBe('sk-ant-1')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(false)
    expect(existsSync(keyFile + '.next')).toBe(false)
  })

  it('an unknown-version secrets file ABORTS the whole rotation (KEK + secrets unchanged)', () => {
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_A, { mode: 0o600 })
    const s = openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_A })
    s.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret: 'vault-secret' })
    s.close()
    const future = JSON.stringify({ version: 3, providers: {}, agents: {} })
    writeFileSync(secretsPath, future)

    // stageRotatedSecrets throws at step 1.5 — BEFORE the DB re-wrap — so
    // nothing committed: the OLD key still opens the vault, the live key
    // file is untouched, and the newer-format secrets file is unread.
    expect(() => rotateMasterKey({ spaceDir: dir, generateKey: () => Buffer.from(KEK_B) })).toThrow(
      /unknown version/,
    )
    expect(readFileSync(keyFile).equals(KEK_A)).toBe(true)
    expect(readFileSync(secretsPath, 'utf8')).toBe(future)
    const reopened = openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_A })
    reopened.close()
    // The staged KEY from step 1 is inert crash debris; boot recovery's
    // probe sees the DB was never re-wrapped and discards it.
    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('discarded')
    expect(existsSync(keyFile + '.next')).toBe(false)
    expect(readFileSync(keyFile).equals(KEK_A)).toBe(true)
  })

  it('a KEPT staging blocks the next rotation loudly; recovery clears only the key debris', () => {
    // End of the kept-file lifecycle: recovery kept a staging it could not
    // judge, an operator re-ran rotation anyway. stageRotatedSecrets throws
    // AFTER the key staged but BEFORE the DB re-wrap — nothing committed.
    // Boot recovery then discards the inert key `.next` (DB never re-wrapped)
    // while the reconciler keeps the unjudgeable staging for the operator.
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_A, { mode: 0o600 })
    const s = openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_A })
    s.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret: 'vault-secret' })
    s.close()
    const dA = deriveSpaceSecretsKey(KEK_A)
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dA, 'sk-ant-1') }, agents: {} }),
    )
    const stagedSecrets = join(dir, STAGED_SECRETS_FILENAME)
    const kept = JSON.stringify({ version: 3, providers: {}, agents: {} })
    writeFileSync(stagedSecrets, kept)

    expect(() => rotateMasterKey({ spaceDir: dir, generateKey: () => Buffer.from(KEK_B) })).toThrow(
      /already exists/,
    )
    // Nothing committed: the OLD key is live and still opens the vault.
    expect(readFileSync(keyFile).equals(KEK_A)).toBe(true)
    openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_A }).close()

    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('discarded')
    expect(existsSync(keyFile + '.next')).toBe(false)
    // The kept staging SURVIVES both the abort and the recovery sweep.
    expect(readFileSync(stagedSecrets, 'utf8')).toBe(kept)
    expect(decryptSecret(dA, readFileJson().providers.anthropic!)).toBe('sk-ant-1')
  })

  it('staged secrets swapped underneath the rotation ABORT before the commit (claim re-verify)', () => {
    // A concurrent recovery (or rival rotation) replacing the staging between
    // our stage and our commit means the bytes we staged are not the bytes
    // that would settle after the re-wrap. The pre-commit claim re-check
    // treats the staging like the key claim: not our bytes → nothing commits.
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_A, { mode: 0o600 })
    const s = openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_A })
    s.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret: 'vault-secret' })
    s.close()
    const dA = deriveSpaceSecretsKey(KEK_A)
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dA, 'sk-ant-1') }, agents: {} }),
    )

    expect(() =>
      rotateMasterKey({
        spaceDir: dir,
        generateKey: () => Buffer.from(KEK_B),
        beforeDbRewrap: () =>
          writeFileSync(
            join(dir, STAGED_SECRETS_FILENAME),
            JSON.stringify({ version: 2, providers: {}, agents: {} }),
          ),
      }),
    ).toThrow(/underneath this rotation/)
    // Nothing committed: old KEK live, vault opens under it, secrets intact.
    expect(readFileSync(keyFile).equals(KEK_A)).toBe(true)
    openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_A }).close()
    expect(decryptSecret(dA, readFileJson().providers.anthropic!)).toBe('sk-ant-1')
    // Boot recovery then clears the debris (the swapped-in staging is a
    // zero-entry file — key-independent positive evidence it holds nothing).
    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('discarded')
    expect(existsSync(keyFile + '.next')).toBe(false)
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(false)
  })

  it('settle failure AFTER the commit throws; boot recovery promotes the key then escalates', () => {
    // The DB committed to the new KEK, then the staging was destroyed and
    // squatted by an unjudgeable file before step 3. The old code promoted
    // that squatter blind; now the rotation refuses to report success (live
    // secrets are era-dead under the new key), and boot recovery finishes
    // the KEY promote (un-brick) but stops for the operator.
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_A, { mode: 0o600 })
    const s = openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_A })
    s.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret: 'vault-secret' })
    s.close()
    const dA = deriveSpaceSecretsKey(KEK_A)
    const live = JSON.stringify({
      version: 2,
      providers: { anthropic: encryptSecret(dA, 'sk-ant-1') },
      agents: {},
    })
    writeFileSync(secretsPath, live)
    const squatter = JSON.stringify({ version: 3, providers: {}, agents: {} })

    expect(() =>
      rotateMasterKey({
        spaceDir: dir,
        generateKey: () => Buffer.from(KEK_B),
        afterDbRewrap: () => {
          rmSync(join(dir, STAGED_SECRETS_FILENAME))
          writeFileSync(join(dir, STAGED_SECRETS_FILENAME), squatter)
        },
      }),
    ).toThrow(/could not be settled/)
    // The key did NOT promote inside the failed rotation…
    expect(readFileSync(keyFile).equals(KEK_A)).toBe(true)
    // …boot recovery promotes it (the DB is under KEK_B now) and escalates.
    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('inconclusive')
    expect(readFileSync(keyFile).equals(KEK_B)).toBe(true)
    openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_B }).close()
    // Squatter + live both left for the operator, byte-untouched.
    expect(readFileSync(join(dir, STAGED_SECRETS_FILENAME), 'utf8')).toBe(squatter)
    expect(readFileSync(secretsPath, 'utf8')).toBe(live)
  })

  it('a rotation resumed after a NEWER generation committed touches NOTHING (anti-brick)', () => {
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_A, { mode: 0o600 })
    const s = openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_A })
    s.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret: 'vault-secret' })
    s.close()
    const dA = deriveSpaceSecretsKey(KEK_A)
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dA, 'sk-ant-1') }, agents: {} }),
    )

    // afterDbRewrap emulates a LONG suspend (VM pause / SIGSTOP) during which
    // the world moved on: boot recovery finished OUR promote (secrets + key),
    // then a LATER rotation staged K3+S3 and committed the DB to K3 before
    // crashing. When we resume, `.next` holds the ONLY copy of K3 — the old
    // step-4 self-heal overwrote it with our K2 (DB=K3, K3 gone: bricked).
    expect(() =>
      rotateMasterKey({
        spaceDir: dir,
        generateKey: () => Buffer.from(KEK_B),
        afterDbRewrap: () => {
          promoteStagedSecrets(dir) // recovery settles S2…
          renameSync(keyFile + '.next', keyFile) // …and promotes K2
          writeFileSync(keyFile + '.next', KEK_C, { mode: 0o600 }) // rival stages K3
          stageRotatedSecrets(dir, KEK_B, KEK_C) // …and S3
          const rival = openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_B })
          rival.rotateVaultMasterKey(Buffer.from(KEK_C)) // rival COMMITS, then "crashes"
          rival.close()
        },
      }),
    ).toThrow(/no longer proves this rotation/)

    // THE anti-brick assertions: `.next` still holds K3 (the only copy of
    // the key the DB now needs), and the rival's staged secrets survive.
    expect(readFileSync(keyFile + '.next').equals(KEK_C)).toBe(true)
    expect(readFileSync(keyFile).equals(KEK_B)).toBe(true)
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(true)
    // Boot recovery then finishes the NEWER generation cleanly.
    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('promoted')
    expect(readFileSync(keyFile).equals(KEK_C)).toBe(true)
    openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_C }).close()
    expect(decryptSecret(deriveSpaceSecretsKey(KEK_C), readFileJson().providers.anthropic!)).toBe('sk-ant-1')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(false)
  })

  it('step 4 never clobbers a FOREIGN `.next` claim staged after a sweep', () => {
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_A, { mode: 0o600 })
    const s = openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_A })
    s.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret: 'vault-secret' })
    s.close()
    const dA = deriveSpaceSecretsKey(KEK_A)
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dA, 'sk-ant-1') }, agents: {} }),
    )

    // A racing recovery swept our K2 claim into a discarded slot, and a rival
    // rotation re-claimed `.next` with K3 WITHOUT committing (the DB is still
    // ours). Overwriting K3 could destroy the rival's only key copy the
    // moment it commits — the promote must refuse instead of self-healing.
    expect(() =>
      rotateMasterKey({
        spaceDir: dir,
        generateKey: () => Buffer.from(KEK_B),
        afterDbRewrap: () => {
          renameSync(keyFile + '.next', keyFile + '.next.discarded.race')
          writeFileSync(keyFile + '.next', KEK_C, { mode: 0o600 })
        },
      }),
    ).toThrow(/re-claimed the staged key/)
    // Foreign claim untouched; our promote pending; secrets already settled
    // under K2 in step 3 — coherent with the committed DB.
    expect(readFileSync(keyFile + '.next').equals(KEK_C)).toBe(true)
    expect(readFileSync(keyFile).equals(KEK_A)).toBe(true)
    expect(decryptSecret(deriveSpaceSecretsKey(KEK_B), readFileJson().providers.anthropic!)).toBe('sk-ant-1')
    // Boot stops loudly and points at the swept slot (probeDiscardedKeys)…
    const stuck = recoverMasterKeyRotation(dir)
    expect(stuck.action).toBe('inconclusive')
    expect(stuck.reason).toContain('.next.discarded.race')
    // …operator clears the rival's dead claim, restores the slot, reboots:
    rmSync(keyFile + '.next')
    renameSync(keyFile + '.next.discarded.race', keyFile + '.next')
    const fixed = recoverMasterKeyRotation(dir)
    expect(fixed.action).toBe('promoted')
    expect(readFileSync(keyFile).equals(KEK_B)).toBe(true)
    openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_B }).close()
  })

  it('step 4 promotes the CLAIMED inode, never the path (recovery finished ours + rival re-staged)', () => {
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_A, { mode: 0o600 })
    const s = openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_A })
    s.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret: 'vault-secret' })
    s.close()
    const dA = deriveSpaceSecretsKey(KEK_A)
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dA, 'sk-ant-1') }, agents: {} }),
    )

    // The suspend window round 15 called out: a concurrent recovery finishes
    // OUR key promote (live = K2, `.next` freed), then a rival rotation
    // stages K3 WITHOUT committing. A by-path rename in step 4 would move K3
    // over the live K2 — destroying the only key the DB opens under the
    // moment the rival aborts (its 2-pre claim check fails). The claim
    // engine captures the K3 inode, sees foreign bytes, restores it, and
    // refuses loudly instead.
    expect(() =>
      rotateMasterKey({
        spaceDir: dir,
        generateKey: () => Buffer.from(KEK_B),
        afterDbRewrap: () => {
          promoteStagedSecrets(dir) // recovery settles S2…
          renameSync(keyFile + '.next', keyFile) // …and promotes K2 (live = K2 now)
          writeFileSync(keyFile + '.next', KEK_C, { mode: 0o600 }) // rival re-stages K3, uncommitted
        },
      }),
    ).toThrow(/re-claimed the staged key/)
    // THE anti-brick assertions: live key is STILL K2 (the committed
    // generation — a by-path rename would have made it K3), and the rival's
    // staging is byte-for-byte where it left it.
    expect(readFileSync(keyFile).equals(KEK_B)).toBe(true)
    expect(readFileSync(keyFile + '.next').equals(KEK_C)).toBe(true)
    openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_B }).close()
    expect(decryptSecret(deriveSpaceSecretsKey(KEK_B), readFileJson().providers.anthropic!)).toBe('sk-ant-1')
    // The rival died before committing: recovery judges its staging stale
    // (live key opens the DB) and sweeps it — the system is coherent.
    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('discarded')
    expect(readFileSync(keyFile).equals(KEK_B)).toBe(true)
  })

  it('installClaimedKey refuses a stale generation — a claimed key never lands over a newer live', () => {
    // Round 16's brick sequence, reduced to the install step: R1 (K1→K2)
    // claimed its verified K2 into a rescue slot and then sat suspended while
    // R2 (K2→K3) FULLY completed — DB and live are both K3 now. R1's old
    // code path (rename slot → live) would bury K3's only disk copy under
    // the retired K2. The install engine captures the live inode, re-proves
    // the generation AFTER the capture, sees the DB no longer vouches for
    // K2, restores the live file untouched, and parks the claim.
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    const dbPath = join(dir, IDENTITY_DB_FILENAME)
    writeFileSync(keyFile, KEK_C, { mode: 0o600 })
    const s = openIdentityStore({ dbPath, masterKey: KEK_C })
    s.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret: 'vault-secret' })
    s.close()
    const slot = `${keyFile}.next.discarded.stale-r1`
    writeFileSync(slot, KEK_B, { mode: 0o600 })

    const verdict = installClaimedKey({
      spaceDir: dir,
      dbPath,
      slot,
      keyBytes: Buffer.from(KEK_B),
      keyFilePath: keyFile,
      stagedPath: `${keyFile}.next`,
    })
    expect(verdict).toBe('stale-generation')
    // The kill-shot assertions: live is STILL the newer generation's K3
    // byte-for-byte, the stale claim is parked untouched, and the vault
    // opens under K3. No stray `.next` materialised.
    expect(readFileSync(keyFile).equals(KEK_C)).toBe(true)
    expect(readFileSync(slot).equals(KEK_B)).toBe(true)
    openIdentityStore({ dbPath, masterKey: KEK_C }).close()
    expect(existsSync(`${keyFile}.next`)).toBe(false)
    // The parked claim is inert debris while the live key opens the DB —
    // boot recovery ignores it instead of blocking on a rescue message.
    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('none')
  })

  it('a rival commit inside the probe→link window is caught by the post-install gate (superseded)', () => {
    // Round 17's honesty gap: R2 loaded the key into memory BEFORE R1's
    // capture, then staged `.next`=K3, committed DB→K3, and crashed — all
    // inside R1's probe→link window. R1's link still lands (the live path
    // is empty), so without the post-gate R1 would report 'installed' while
    // the DB says K3. The gate re-probes AFTER the durable install and
    // refuses success; the winner's staging is untouched and the next
    // recovery pass settles the end state.
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    const dbPath = join(dir, IDENTITY_DB_FILENAME)
    writeFileSync(keyFile, KEK_B, { mode: 0o600 })
    const s = openIdentityStore({ dbPath, masterKey: KEK_B })
    s.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret: 'vault-secret' })
    s.close()
    const slot = `${keyFile}.next.discarded.r1`
    writeFileSync(slot, KEK_B, { mode: 0o600 })

    const verdict = installClaimedKey({
      spaceDir: dir,
      dbPath,
      slot,
      keyBytes: Buffer.from(KEK_B),
      keyFilePath: keyFile,
      stagedPath: `${keyFile}.next`,
      beforeInstallLink: () => {
        writeFileSync(`${keyFile}.next`, KEK_C, { mode: 0o600 })
        const rival = openIdentityStore({ dbPath, masterKey: KEK_B })
        rival.rotateVaultMasterKey(Buffer.from(KEK_C))
        rival.close()
      },
    })
    expect(verdict).toBe('superseded')
    // Disk state is honest about what happened: our key IS on the live path
    // (the link landed), but no slot was cleaned up and the winner's staging
    // is byte-for-byte intact — recovery has everything it needs.
    expect(readFileSync(keyFile).equals(KEK_B)).toBe(true)
    expect(readFileSync(slot).equals(KEK_B)).toBe(true)
    expect(readFileSync(`${keyFile}.next`).equals(KEK_C)).toBe(true)
    // The next recovery pass settles to the WINNER: live K2 no longer opens
    // the DB, the staged K3 does → promoted.
    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('promoted')
    expect(readFileSync(keyFile).equals(KEK_C)).toBe(true)
    openIdentityStore({ dbPath, masterKey: KEK_C }).close()
  })

  it('a rival staging (uncommitted) re-appearing in the window also refuses success (superseded)', () => {
    // Same window, rival staged `.next` but had NOT committed yet: the DB
    // still proves our key, but a mid-flight rival owns `.next` — claiming
    // success now would race its commit. The gate refuses; the system stays
    // healthy (live = DB = our key) and recovery later judges the rival's
    // staging on its own evidence.
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    const dbPath = join(dir, IDENTITY_DB_FILENAME)
    writeFileSync(keyFile, KEK_B, { mode: 0o600 })
    const s = openIdentityStore({ dbPath, masterKey: KEK_B })
    s.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret: 'vault-secret' })
    s.close()
    const slot = `${keyFile}.next.discarded.r1b`
    writeFileSync(slot, KEK_B, { mode: 0o600 })

    const verdict = installClaimedKey({
      spaceDir: dir,
      dbPath,
      slot,
      keyBytes: Buffer.from(KEK_B),
      keyFilePath: keyFile,
      stagedPath: `${keyFile}.next`,
      beforeInstallLink: () => {
        writeFileSync(`${keyFile}.next`, KEK_C, { mode: 0o600 })
      },
    })
    expect(verdict).toBe('superseded')
    expect(readFileSync(keyFile).equals(KEK_B)).toBe(true)
    expect(readFileSync(`${keyFile}.next`).equals(KEK_C)).toBe(true)
    // The rival never committed: recovery judges its staging stale (the live
    // key opens the DB) and sweeps it — coherent end state.
    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('discarded')
    expect(readFileSync(keyFile).equals(KEK_B)).toBe(true)
  })

  it('a mid-rotation secret UPDATE under the old key aborts the settle — never rolled back', () => {
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_A, { mode: 0o600 })
    const s = openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_A })
    s.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret: 'vault-secret' })
    s.close()
    const dA = deriveSpaceSecretsKey(KEK_A)
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dA, 'sk-OLD') }, agents: {} }),
    )

    // Discipline violation: a still-running host saves a NEW value under the
    // OLD derived key after our staging snapshot. The staging is now a stale
    // re-encryption of sk-OLD; under the new key alone the live slot merely
    // looks dead, and the old cover rule silently rolled the update back and
    // reported a clean rotation. The currentKey witness sees the difference.
    expect(() =>
      rotateMasterKey({
        spaceDir: dir,
        generateKey: () => Buffer.from(KEK_B),
        beforeDbRewrap: () =>
          writeFileSync(
            secretsPath,
            JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dA, 'sk-UPDATED') }, agents: {} }),
          ),
      }),
    ).toThrow(/could not be settled/)
    // The update SURVIVES; staging kept for the operator; key promote pending.
    expect(decryptSecret(dA, readFileJson().providers.anthropic!)).toBe('sk-UPDATED')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(true)
    expect(readFileSync(keyFile).equals(KEK_A)).toBe(true)
    // Boot recovery: key promote un-bricks, secrets escalate — still no rollback.
    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('inconclusive')
    expect(readFileSync(keyFile).equals(KEK_B)).toBe(true)
    expect(decryptSecret(dA, readFileJson().providers.anthropic!)).toBe('sk-UPDATED')
  })
})

describe('recoverMasterKeyRotation reconciles staged secrets in the same branch', () => {
  function seedVault(kek: Buffer): void {
    const s = openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: kek })
    s.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret: 'vault-secret' })
    s.close()
  }

  it("discarded branch (DB never re-wrapped): staged secrets die with the staged key", () => {
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_A, { mode: 0o600 })
    seedVault(KEK_A)
    const dA = deriveSpaceSecretsKey(KEK_A)
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dA, 'sk-ant-1') }, agents: {} }),
    )
    // Crash after both stagings, before the DB re-wrap.
    writeFileSync(keyFile + '.next', KEK_B, { mode: 0o600 })
    stageRotatedSecrets(dir, KEK_A, KEK_B)

    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('discarded')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(false)
    expect(decryptSecret(dA, readFileJson().providers.anthropic!)).toBe('sk-ant-1')
  })

  it('promoted branch (DB re-wrapped): staged secrets promote with the staged key', () => {
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_A, { mode: 0o600 })
    // Vault already under KEK_B = the rotation committed its DB re-wrap.
    seedVault(KEK_B)
    const dA = deriveSpaceSecretsKey(KEK_A)
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dA, 'sk-ant-1') }, agents: {} }),
    )
    writeFileSync(keyFile + '.next', KEK_B, { mode: 0o600 })
    stageRotatedSecrets(dir, KEK_A, KEK_B)

    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('promoted')
    expect(readFileSync(keyFile).equals(KEK_B)).toBe(true)
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(false)
    expect(decryptSecret(deriveSpaceSecretsKey(KEK_B), readFileJson().providers.anthropic!)).toBe('sk-ant-1')
  })

  it('promote branch with an UNPAIRED staging: key promotes, then ESCALATES for the operator', () => {
    // A proven staged KEY does not prove the file on the staging path is
    // paired with it — here an older KEPT copy (unknown generation) squats
    // there. Recovery must finish the key promote (that un-bricks the vault)
    // without blindly renaming that file over the live secrets — and since
    // the live secrets do NOT read under the promoted key, booting on would
    // mix eras: the verdict escalates instead of reporting success.
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_A, { mode: 0o600 })
    seedVault(KEK_B) // DB re-wrapped: the staged key is the proven one
    const dA = deriveSpaceSecretsKey(KEK_A)
    const live = JSON.stringify({
      version: 2,
      providers: { anthropic: encryptSecret(dA, 'sk-ant-1') },
      agents: {},
    })
    writeFileSync(secretsPath, live)
    writeFileSync(keyFile + '.next', KEK_B, { mode: 0o600 })
    const stagedSecrets = join(dir, STAGED_SECRETS_FILENAME)
    const kept = JSON.stringify({ version: 3, providers: {}, agents: {} })
    writeFileSync(stagedSecrets, kept)

    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('inconclusive')
    expect(r.reason).toContain(STAGED_SECRETS_FILENAME)
    // The key promote itself is NOT held hostage — `.next` held the only key
    // that opens the DB.
    expect(readFileSync(keyFile).equals(KEK_B)).toBe(true)
    expect(existsSync(keyFile + '.next')).toBe(false)
    // The unjudgeable staging is KEPT in place — never promoted over live.
    expect(readFileSync(stagedSecrets, 'utf8')).toBe(kept)
    expect(readFileSync(secretsPath, 'utf8')).toBe(live)
  })

  it('kept staging with HEALTHY live secrets is benign: promote succeeds with a note', () => {
    // Same squatter, but the live file already reads under the promoted key
    // (the secrets settled in a previous pass). Blocking the boot here would
    // punish a state that is actually coherent — succeed, note the leftover.
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_A, { mode: 0o600 })
    seedVault(KEK_B)
    const dB = deriveSpaceSecretsKey(KEK_B)
    const live = JSON.stringify({
      version: 2,
      providers: { anthropic: encryptSecret(dB, 'sk-ant-1') },
      agents: {},
    })
    writeFileSync(secretsPath, live)
    writeFileSync(keyFile + '.next', KEK_B, { mode: 0o600 })
    const stagedSecrets = join(dir, STAGED_SECRETS_FILENAME)
    const kept = JSON.stringify({ version: 3, providers: {}, agents: {} })
    writeFileSync(stagedSecrets, kept)

    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('promoted')
    expect(r.reason).toContain('NOTE')
    expect(readFileSync(keyFile).equals(KEK_B)).toBe(true)
    expect(readFileSync(stagedSecrets, 'utf8')).toBe(kept)
    expect(readFileSync(secretsPath, 'utf8')).toBe(live)
  })

  it('discard branch escalates too: kept staging over era-dead live secrets', () => {
    // Vault + live key agree (KEK_A) but the live SECRETS were restored from
    // another generation and a kept staging squats the path. The stale key
    // debris is swept as usual — but reporting plain 'discarded' would boot
    // into a hub where every provider secret fails to decrypt.
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_A, { mode: 0o600 })
    seedVault(KEK_A)
    const dB = deriveSpaceSecretsKey(KEK_B)
    const live = JSON.stringify({
      version: 2,
      providers: { anthropic: encryptSecret(dB, 'sk-era-b') },
      agents: {},
    })
    writeFileSync(secretsPath, live)
    writeFileSync(keyFile + '.next', KEK_B, { mode: 0o600 })
    const stagedSecrets = join(dir, STAGED_SECRETS_FILENAME)
    const kept = JSON.stringify({ version: 3, providers: {}, agents: {} })
    writeFileSync(stagedSecrets, kept)

    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('inconclusive')
    expect(r.reason).toContain(SPACE_SECRETS_FILENAME)
    // Key debris still swept; both secrets files untouched for the operator.
    expect(existsSync(keyFile + '.next')).toBe(false)
    expect(readFileSync(stagedSecrets, 'utf8')).toBe(kept)
    expect(readFileSync(secretsPath, 'utf8')).toBe(live)
  })

  it('no-staged-key branch escalates: kept staging while live secrets do not read', () => {
    // No key rotation in flight at all — but the secrets file on disk is from
    // another era AND an unjudgeable staging squats the path. The proven live
    // key can positively demonstrate the mismatch, so the boot stops instead
    // of running with a dead secrets store.
    writeFileSync(join(dir, MASTER_KEY_FILENAME), KEK_A, { mode: 0o600 })
    seedVault(KEK_A)
    const dB = deriveSpaceSecretsKey(KEK_B)
    const live = JSON.stringify({
      version: 2,
      providers: { anthropic: encryptSecret(dB, 'sk-era-b') },
      agents: {},
    })
    writeFileSync(secretsPath, live)
    const stagedSecrets = join(dir, STAGED_SECRETS_FILENAME)
    const kept = JSON.stringify({ version: 3, providers: {}, agents: {} })
    writeFileSync(stagedSecrets, kept)

    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('inconclusive')
    expect(r.reason).toContain(SPACE_SECRETS_FILENAME)
    expect(readFileSync(stagedSecrets, 'utf8')).toBe(kept)
    expect(readFileSync(secretsPath, 'utf8')).toBe(live)
  })

  it('orphan staged secrets with NO staged key = crash debris — discarded on boot', () => {
    // A crash between the two discard rms (or a partial cleanup) can leave
    // secrets.next behind alone. The live key A is PROVEN by the vault probe
    // and the live secrets read under it — positive evidence the orphan is a
    // stale snapshot, so it must not linger.
    writeFileSync(join(dir, MASTER_KEY_FILENAME), KEK_A, { mode: 0o600 })
    seedVault(KEK_A)
    const dA = deriveSpaceSecretsKey(KEK_A)
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dA, 'sk-ant-1') }, agents: {} }),
    )
    stageRotatedSecrets(dir, KEK_A, KEK_B) // …but the key staging never happened
    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('none')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(false)
    expect(decryptSecret(dA, readFileJson().providers.anthropic!)).toBe('sk-ant-1')
  })

  it('wrong live key never judges the orphan: staging survives until the rescue heals the key', () => {
    // The poison state the discarded-slot rescue points at: rotation A→B
    // committed its DB re-wrap, a racing sweep archived its staged key, and
    // the live file still holds A. The orphan staging belongs to B's era —
    // judging it with the UNPROVEN live key A would delete the only copy of
    // the secrets the healed workspace needs.
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_A, { mode: 0o600 })
    seedVault(KEK_B) // DB committed to B; A can NOT unwrap it
    const dA = deriveSpaceSecretsKey(KEK_A)
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dA, 'sk-ant-1') }, agents: {} }),
    )
    stageRotatedSecrets(dir, KEK_A, KEK_B)
    const sweptSlot = join(dir, `${MASTER_KEY_FILENAME}.next.discarded.rival`)
    writeFileSync(sweptSlot, KEK_B, { mode: 0o600 })

    // Boot 1: the unproven live key judges nothing; the rescue stops the boot.
    const r1 = recoverMasterKeyRotation(dir)
    expect(r1.action).toBe('inconclusive')
    expect(r1.reason).toContain('identity-master.key.next.discarded')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(true)

    // Operator's one-move fix — recovery then promotes key AND secrets whole.
    renameSync(sweptSlot, keyFile + '.next')
    const r2 = recoverMasterKeyRotation(dir)
    expect(r2.action).toBe('promoted')
    expect(readFileSync(keyFile).equals(KEK_B)).toBe(true)
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(false)
    expect(decryptSecret(deriveSpaceSecretsKey(KEK_B), readFileJson().providers.anthropic!)).toBe('sk-ant-1')
  })

  it('torn promote: orphan staged secrets under the LIVE key are rescued, not deleted', () => {
    // Rotation A→B committed everything and a power cut persisted the KEY
    // promote but rolled back the SECRETS promote (dir fsync is best-effort):
    // live key = B, live secrets = old era, and the orphan staging holds the
    // ONLY copy under B. The old blind discard destroyed exactly this state.
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_B, { mode: 0o600 })
    seedVault(KEK_B)
    const dA = deriveSpaceSecretsKey(KEK_A)
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dA, 'sk-ant-1') }, agents: {} }),
    )
    stageRotatedSecrets(dir, KEK_A, KEK_B)

    const r = recoverMasterKeyRotation(dir)
    expect(r.action).toBe('none')
    expect(r.reason).toContain('rescued orphan staged secrets')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(false)
    expect(decryptSecret(deriveSpaceSecretsKey(KEK_B), readFileJson().providers.anthropic!)).toBe('sk-ant-1')
    // Idempotent: the healed state reports a plain 'none' on the next boot.
    expect(recoverMasterKeyRotation(dir).reason).toBe('no staged key file')
  })

  it('operator re-run after a crash: recovery first, then a fresh rotation succeeds', () => {
    // The FULL state machine rotateMasterKeyCmd walks. A rotation to KEK_B
    // crashed between the DB re-wrap and the key promote — the classic brick
    // window: `.next` holds the ONLY key that opens the DB. The CLI re-run is
    // recovery-first (reconcile), then rotates fresh to KEK_C. Blind
    // re-staging here used to overwrite `.next` and brick the vault forever.
    const KEK_C = Buffer.alloc(32, 0xcc)
    const keyFile = join(dir, MASTER_KEY_FILENAME)
    writeFileSync(keyFile, KEK_A, { mode: 0o600 })
    const seed = openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_A })
    const entryId = seed.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret: 'vault-secret' }).id
    seed.close()
    const dA = deriveSpaceSecretsKey(KEK_A)
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dA, 'sk-ant-1') }, agents: {} }),
    )
    // Crash between step 2 (DB re-wrap) and step 3/4 (promotes):
    writeFileSync(keyFile + '.next', KEK_B, { mode: 0o600 })
    stageRotatedSecrets(dir, KEK_A, KEK_B)
    const s = openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_A })
    s.rotateVaultMasterKey(KEK_B)
    s.close()

    // Re-run leg 1 — recovery reconciles the interrupted rotation to B.
    const rec = recoverMasterKeyRotation(dir)
    expect(rec.action).toBe('promoted')

    // Re-run leg 2 — the fresh rotation to C now starts from a coherent
    // B-state and lands whole: live key = C, vault opens under C, secrets
    // decrypt under HKDF(C), zero staging debris.
    rotateMasterKey({ spaceDir: dir, generateKey: () => Buffer.from(KEK_C) })
    expect(readFileSync(keyFile).equals(KEK_C)).toBe(true)
    expect(existsSync(keyFile + '.next')).toBe(false)
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(false)
    const reopened = openIdentityStore({ dbPath: join(dir, IDENTITY_DB_FILENAME), masterKey: KEK_C })
    expect(reopened.readVaultSecret(entryId)).toBe('vault-secret')
    reopened.close()
    expect(decryptSecret(deriveSpaceSecretsKey(KEK_C), readFileJson().providers.anthropic!)).toBe('sk-ant-1')
  })
})

describe('reconcileStagedSecrets (survivor vs debris, unit)', () => {
  function writeLive(under: Buffer, value: string): void {
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(under, value) }, agents: {} }),
    )
  }

  it("no staged file → 'none'", () => {
    expect(reconcileStagedSecrets(dir, KEK_A)).toBe('none')
  })

  it('survivor (staged under live key, live file another era) → promoted', () => {
    writeLive(deriveSpaceSecretsKey(KEK_A), 'sk-ant-1')
    stageRotatedSecrets(dir, KEK_A, KEK_B)
    expect(reconcileStagedSecrets(dir, KEK_B)).toBe('promoted')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(false)
    const file = JSON.parse(readFileSync(secretsPath, 'utf8')) as SecretsFile
    expect(decryptSecret(deriveSpaceSecretsKey(KEK_B), file.providers.anthropic!)).toBe('sk-ant-1')
  })

  it('survivor with the live file MISSING entirely → promoted (only copy wins)', () => {
    writeLive(deriveSpaceSecretsKey(KEK_A), 'sk-ant-1')
    stageRotatedSecrets(dir, KEK_A, KEK_B)
    rmSync(secretsPath, { force: true })
    expect(reconcileStagedSecrets(dir, KEK_B)).toBe('promoted')
    const file = JSON.parse(readFileSync(secretsPath, 'utf8')) as SecretsFile
    expect(decryptSecret(deriveSpaceSecretsKey(KEK_B), file.providers.anthropic!)).toBe('sk-ant-1')
  })

  it('stale debris (another key era) → discarded, live file untouched', () => {
    writeLive(deriveSpaceSecretsKey(KEK_A), 'sk-ant-1')
    stageRotatedSecrets(dir, KEK_A, KEK_B)
    const liveBefore = readFileSync(secretsPath)
    expect(reconcileStagedSecrets(dir, KEK_A)).toBe('discarded')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(false)
    expect(readFileSync(secretsPath).equals(liveBefore)).toBe(true)
  })

  it('redundant duplicate (both read under the live key) → discarded', () => {
    writeLive(deriveSpaceSecretsKey(KEK_B), 'sk-ant-1')
    writeFileSync(join(dir, STAGED_SECRETS_FILENAME), readFileSync(secretsPath))
    expect(reconcileStagedSecrets(dir, KEK_B)).toBe('discarded')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(false)
  })

  it('no proven live KEK → kept untouched (never judge, never destroy)', () => {
    writeLive(deriveSpaceSecretsKey(KEK_A), 'sk-ant-1')
    stageRotatedSecrets(dir, KEK_A, KEK_B)
    expect(reconcileStagedSecrets(dir, undefined)).toBe('kept')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(true)
    // Torn/short key file (derivation throws) is equally unjudgeable.
    expect(reconcileStagedSecrets(dir, Buffer.alloc(7, 1))).toBe('kept')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(true)
  })

  it('zero-entry staging → discarded; unparseable staging → kept (no positive evidence)', () => {
    writeFileSync(
      join(dir, STAGED_SECRETS_FILENAME),
      JSON.stringify({ version: 2, providers: {}, agents: {} }),
    )
    expect(reconcileStagedSecrets(dir, KEK_A)).toBe('discarded')
    // Bad JSON might be a truncated-but-repairable copy — never destroy what
    // we can't read.
    writeFileSync(join(dir, STAGED_SECRETS_FILENAME), 'not-json{')
    expect(reconcileStagedSecrets(dir, KEK_A)).toBe('kept')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(true)
  })

  it('unknown-generation staging → kept (a newer Gotong may have written it)', () => {
    writeFileSync(
      join(dir, STAGED_SECRETS_FILENAME),
      JSON.stringify({ version: 3, providers: { x: { future: true } }, agents: {} }),
    )
    expect(reconcileStagedSecrets(dir, KEK_A)).toBe('kept')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(true)
  })

  it('staging of a foreign era with NO healthy live file → kept (may be the only copy)', () => {
    // Under the proven KEK neither file reads: the staging could be junk — or
    // the last surviving ciphertext of an era whose key the operator still
    // has. No positive evidence, no destruction.
    writeLive(deriveSpaceSecretsKey(KEK_B), 'sk-era-b')
    writeFileSync(
      join(dir, STAGED_SECRETS_FILENAME),
      JSON.stringify(
        { version: 2, providers: { anthropic: encryptSecret(deriveSpaceSecretsKey(KEK_B), 'sk-era-b2') }, agents: {} },
      ),
    )
    expect(reconcileStagedSecrets(dir, KEK_A)).toBe('kept')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(true)
  })

  it('staging with an EXTRA readable slot promotes — the unique entry is recovered', () => {
    // Per-slot rule, promote side: every LIVE slot is covered (same
    // plaintext) and the staging carries one MORE readable entry. The old
    // existential rule discarded this staging — losing the only copy of the
    // extra slot. Promote recovers it.
    const dB = deriveSpaceSecretsKey(KEK_B)
    writeLive(dB, 'sk-ant-1')
    writeFileSync(
      join(dir, STAGED_SECRETS_FILENAME),
      JSON.stringify({
        version: 2,
        providers: { anthropic: encryptSecret(dB, 'sk-ant-1'), openai: encryptSecret(dB, 'sk-oa-1') },
        agents: {},
      }),
    )
    expect(reconcileStagedSecrets(dir, KEK_B)).toBe('promoted')
    const file = JSON.parse(readFileSync(secretsPath, 'utf8')) as SecretsFile
    expect(decryptSecret(dB, file.providers.anthropic!)).toBe('sk-ant-1')
    expect(decryptSecret(dB, file.providers.openai!)).toBe('sk-oa-1')
  })

  it('a live slot MISSING from the staging blocks promote → kept (no entry may be lost)', () => {
    // Per-slot rule, the other direction: the staging reads under the proven
    // key but does not carry `openai`, which only exists in the (era-dead)
    // live file. The old existential rule promoted here and silently dropped
    // that entry; now nothing is destroyed and the operator decides.
    const eraA = deriveSpaceSecretsKey(KEK_A)
    const dB = deriveSpaceSecretsKey(KEK_B)
    writeFileSync(
      secretsPath,
      JSON.stringify({
        version: 2,
        providers: { anthropic: encryptSecret(eraA, 'sk-ant-1'), openai: encryptSecret(eraA, 'sk-oa-1') },
        agents: {},
      }),
    )
    writeFileSync(
      join(dir, STAGED_SECRETS_FILENAME),
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dB, 'sk-ant-1') }, agents: {} }),
    )
    const liveBefore = readFileSync(secretsPath)
    expect(reconcileStagedSecrets(dir, KEK_B)).toBe('kept')
    expect(readFileSync(secretsPath).equals(liveBefore)).toBe(true)
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(true)
  })

  it('same slot readable on BOTH sides with different plaintexts → kept (no silent winner)', () => {
    // Same era, diverged values (a running host re-wrote the key after the
    // staging was cut). Discard loses the staged value, promote clobbers the
    // newer live one — neither has positive evidence, so neither happens.
    const dB = deriveSpaceSecretsKey(KEK_B)
    writeLive(dB, 'sk-NEW')
    writeFileSync(
      join(dir, STAGED_SECRETS_FILENAME),
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dB, 'sk-OLD') }, agents: {} }),
    )
    const liveBefore = readFileSync(secretsPath)
    expect(reconcileStagedSecrets(dir, KEK_B)).toBe('kept')
    expect(readFileSync(secretsPath).equals(liveBefore)).toBe(true)
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(true)
  })

  it('a non-object section is structurally invalid → kept, never a zero-entry discard', () => {
    // {version:2, providers:"junk"} must not be mistaken for an EMPTY v2 file
    // — the zero-entry discard's evidence is "parsed clean and holds
    // nothing", which a mangled section does not provide.
    writeFileSync(
      join(dir, STAGED_SECRETS_FILENAME),
      JSON.stringify({ version: 2, providers: 'junk', agents: {} }),
    )
    expect(reconcileStagedSecrets(dir, KEK_A)).toBe('kept')
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(true)
  })

  it('a slot UPDATED under the old era after staging blocks promote when the prior key witnesses', () => {
    // Live holds the NEWER value under the OLD era; the staging re-encrypts
    // the value from BEFORE the update. Under the new key alone the live slot
    // just looks dead ("re-encryption of an old-era original") — only the
    // prior-era witness can see it holds a different, newer value.
    const dA = deriveSpaceSecretsKey(KEK_A)
    const dB = deriveSpaceSecretsKey(KEK_B)
    writeLive(dA, 'sk-UPDATED')
    writeFileSync(
      join(dir, STAGED_SECRETS_FILENAME),
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dB, 'sk-OLD') }, agents: {} }),
    )
    const liveBefore = readFileSync(secretsPath)
    expect(reconcileStagedSecrets(dir, KEK_B, { priorKek: KEK_A })).toBe('kept')
    expect(readFileSync(secretsPath).equals(liveBefore)).toBe(true)
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(true)
    // WITHOUT the witness the same state promotes (rollback) — which is why
    // every call site that has the prior era's key must pass it.
    expect(reconcileStagedSecrets(dir, KEK_B)).toBe('promoted')
    const file = JSON.parse(readFileSync(secretsPath, 'utf8')) as SecretsFile
    expect(decryptSecret(dB, file.providers.anthropic!)).toBe('sk-OLD')
  })

  it('the witness AGREEING (same old-era value) still promotes — torn promotes stay self-healing', () => {
    writeLive(deriveSpaceSecretsKey(KEK_A), 'sk-ant-1')
    stageRotatedSecrets(dir, KEK_A, KEK_B)
    expect(reconcileStagedSecrets(dir, KEK_B, { priorKek: KEK_A })).toBe('promoted')
    const file = JSON.parse(readFileSync(secretsPath, 'utf8')) as SecretsFile
    expect(decryptSecret(deriveSpaceSecretsKey(KEK_B), file.providers.anthropic!)).toBe('sk-ant-1')
  })

  it('a witness that cannot read the dead live slot blocks promote too (third era ≠ original)', () => {
    // If the live slot reads under NEITHER the proven key nor the witness,
    // it is not "the old-era original of this staging" — it belongs to some
    // third era. With a witness present that must block; the 2-arg form's
    // permissiveness there is the documented residual of callers that have
    // no prior key to offer.
    const KEK_Z = Buffer.alloc(32, 0x99)
    writeLive(deriveSpaceSecretsKey(KEK_Z), 'sk-z')
    writeFileSync(
      join(dir, STAGED_SECRETS_FILENAME),
      JSON.stringify(
        { version: 2, providers: { anthropic: encryptSecret(deriveSpaceSecretsKey(KEK_B), 'sk-b') }, agents: {} },
      ),
    )
    const liveBefore = readFileSync(secretsPath)
    expect(reconcileStagedSecrets(dir, KEK_B, { priorKek: KEK_A })).toBe('kept')
    expect(readFileSync(secretsPath).equals(liveBefore)).toBe(true)
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(true)
  })

  it('a SUPPLIED but underivable witness blocks like a disagreeing one — never fails open', () => {
    // recovery hands the reconciler whatever live key file it found; a torn
    // 7-byte key cannot derive. Collapsing that to "no witness supplied"
    // would re-enable the permissive dead-live promote exactly when the old
    // era is least trustworthy — it must stay restrictive (kept) instead.
    const dA = deriveSpaceSecretsKey(KEK_A)
    const dB = deriveSpaceSecretsKey(KEK_B)
    writeLive(dA, 'sk-UPDATED')
    writeFileSync(
      join(dir, STAGED_SECRETS_FILENAME),
      JSON.stringify({ version: 2, providers: { anthropic: encryptSecret(dB, 'sk-OLD') }, agents: {} }),
    )
    const liveBefore = readFileSync(secretsPath)
    expect(reconcileStagedSecrets(dir, KEK_B, { priorKek: Buffer.alloc(7, 0x01) })).toBe('kept')
    expect(readFileSync(secretsPath).equals(liveBefore)).toBe(true)
    expect(existsSync(join(dir, STAGED_SECRETS_FILENAME))).toBe(true)
  })

  it('a crash-orphaned `.judging.*` claim is re-parked and judged (restore-first)', () => {
    // Emulate a crash between destroy()'s claim-rename and its act: the
    // staging sits at a judging slot, the staging path is empty. Without
    // restore-first this survivor would be invisible forever ('none').
    writeLive(deriveSpaceSecretsKey(KEK_A), 'sk-ant-1')
    stageRotatedSecrets(dir, KEK_A, KEK_B)
    const orphanPath = join(dir, `${STAGED_SECRETS_FILENAME}.judging.dead-beef`)
    renameSync(join(dir, STAGED_SECRETS_FILENAME), orphanPath)
    expect(reconcileStagedSecrets(dir, KEK_B)).toBe('promoted')
    const file = JSON.parse(readFileSync(secretsPath, 'utf8')) as SecretsFile
    expect(decryptSecret(deriveSpaceSecretsKey(KEK_B), file.providers.anthropic!)).toBe('sk-ant-1')
    expect(existsSync(orphanPath)).toBe(false)
  })

  it('a judging orphan stays parked while the staging path is occupied', () => {
    writeLive(deriveSpaceSecretsKey(KEK_A), 'sk-ant-1')
    const orphanPath = join(dir, `${STAGED_SECRETS_FILENAME}.judging.parked`)
    writeFileSync(orphanPath, 'orphan-bytes')
    stageRotatedSecrets(dir, KEK_A, KEK_B) // occupies the staging path
    // The FRESH staging is judged; the orphan is untouched.
    expect(reconcileStagedSecrets(dir, KEK_B)).toBe('promoted')
    expect(readFileSync(orphanPath, 'utf8')).toBe('orphan-bytes')
    // The next pass restores it onto the now-free path and judges it — bad
    // JSON → kept, visible to the operator machinery again.
    expect(reconcileStagedSecrets(dir, KEK_B)).toBe('kept')
    expect(readFileSync(join(dir, STAGED_SECRETS_FILENAME), 'utf8')).toBe('orphan-bytes')
    expect(existsSync(orphanPath)).toBe(false)
  })
})

describe('end-to-end with a real Space', () => {
  it('migrated file reads through a bound Space; writes stay v2', async () => {
    const { space } = await Space.openOrInit(join(dir, 'ws'), { name: 'unify-e2e' })
    // Seed a v1 store via the legacy path (no binding yet).
    await space.setProviderApiKey('anthropic', 'sk-ant-legacy')
    expect(JSON.parse(readFileSync(join(dir, 'ws', SPACE_SECRETS_FILENAME), 'utf8')).version).toBe(1)

    // Boot #2: unify + bind (fresh Space instance, like a real restart).
    const derived = deriveSpaceSecretsKey(KEK_A)
    const r = unifySpaceSecrets({ spaceDir: join(dir, 'ws'), derivedKey: derived })
    expect(r).toMatchObject({ action: 'migrated', bound: true })
    const space2 = await Space.open(join(dir, 'ws'))
    space2.bindSecretsMasterKey(derived)
    expect(await space2.getProviderApiKey('anthropic')).toBe('sk-ant-legacy')

    // New writes go through the bound key and keep the v2 stamp.
    await space2.setAgentApiKey('agent-1', 'sk-agent-new')
    const file = JSON.parse(readFileSync(join(dir, 'ws', SPACE_SECRETS_FILENAME), 'utf8')) as SecretsFile
    expect(file.version).toBe(2)
    expect(decryptSecret(derived, file.agents['agent-1']!)).toBe('sk-agent-new')

    // Boot #3 WITHOUT binding (identity KEK failed to load): reads refuse
    // loudly instead of minting a junk legacy key.
    const space3 = await Space.open(join(dir, 'ws'))
    await expect(space3.getProviderApiKey('anthropic')).rejects.toThrow(/bound to the identity master key/)
    expect(existsSync(join(dir, 'ws', 'runtime', 'secret.key'))).toBe(false)
  })
})
