import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openIdentityStore } from '@gotong/identity'

import {
  IDENTITY_DB_FILENAME,
  MASTER_KEY_FILENAME,
  rotateMasterKey,
} from '../src/rotate-master-key.js'

/**
 * Route B P0-M4d — the operator-facing `rotate-master-key` orchestration. M4c
 * pinned the store mechanism (re-wrap the data key, byte-identical ciphertext);
 * this pins the CLI flow end to end against a real file-based workspace: the new
 * key is persisted to the key file, the vault opens with it on the next boot,
 * the OLD key is retired, and a misconfigured / failed rotation never
 * half-rotates. Each assertion is falsifiable — neutralise a guard and a
 * specific expectation goes RED.
 */

const K_OLD = Buffer.alloc(32, 0x11)
const K_NEW = Buffer.alloc(32, 0x22)

let dir: string
let keyFile: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gotong-rotcli-'))
  keyFile = join(dir, MASTER_KEY_FILENAME)
  dbPath = join(dir, IDENTITY_DB_FILENAME)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Seed the workspace: a 0600 key file + one vault secret under K_OLD. */
function seed(secret: string): string {
  writeFileSync(keyFile, K_OLD, { mode: 0o600 })
  const s = openIdentityStore({ dbPath, masterKey: K_OLD })
  const id = s.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret }).id
  s.close()
  return id
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (err) {
    return (err as { code?: string }).code
  }
}

describe('rotateMasterKey (Route B P0-M4d)', () => {
  it('persists the new key, opens on next boot, and retires the old key', () => {
    const id = seed('sk-live')

    rotateMasterKey({ spaceDir: dir, generateKey: () => K_NEW })

    // The live key file now holds the NEW key (step 3 promote ran).
    expect(readFileSync(keyFile).equals(K_NEW)).toBe(true)
    // The staged file was renamed away — no leftover.
    expect(existsSync(`${keyFile}.next`)).toBe(false)

    // Simulate the next boot: load the key from the file → vault opens.
    const next = openIdentityStore({ dbPath, masterKey: readFileSync(keyFile) })
    expect(next.readVaultSecret(id)).toBe('sk-live')
    next.close()

    // The OLD key no longer unwraps the data key.
    const stale = openIdentityStore({ dbPath, masterKey: K_OLD })
    expect(codeOf(() => stale.readVaultSecret(id))).toBe('vault_decrypt_failed')
    stale.close()
  })

  it('refuses a non-local-file provider and mutates nothing', () => {
    const id = seed('sk-env')

    expect(() =>
      rotateMasterKey({
        spaceDir: dir,
        providerKind: 'env',
        envKeyMaterial: K_OLD.toString('hex'),
        generateKey: () => K_NEW,
      }),
    ).toThrow(/local-file/)

    // Key file untouched, vault still opens with the original key.
    expect(readFileSync(keyFile).equals(K_OLD)).toBe(true)
    const s = openIdentityStore({ dbPath, masterKey: K_OLD })
    expect(s.readVaultSecret(id)).toBe('sk-env')
    s.close()
  })

  it('refuses to rotate to a key identical to the current one', () => {
    seed('sk-same')
    // The RNG handing back the current key is almost certainly a bug; a no-op
    // rotation would retire nothing.
    expect(() => rotateMasterKey({ spaceDir: dir, generateKey: () => K_OLD })).toThrow(
      /identical/,
    )
  })

  it('a wrong-length generated key throws and does not half-rotate', () => {
    const id = seed('sk-safe')

    expect(() =>
      rotateMasterKey({ spaceDir: dir, generateKey: () => Buffer.alloc(8, 1) }),
    ).toThrow(/32 bytes/)

    // No staged key left behind, key file unchanged, vault still opens.
    expect(existsSync(`${keyFile}.next`)).toBe(false)
    expect(readFileSync(keyFile).equals(K_OLD)).toBe(true)
    const s = openIdentityStore({ dbPath, masterKey: K_OLD })
    expect(s.readVaultSecret(id)).toBe('sk-safe')
    s.close()
  })

  it('chained rotations: only the latest key opens the vault', () => {
    const id = seed('sk-chain')
    const K_MID = Buffer.alloc(32, 0x33)

    rotateMasterKey({ spaceDir: dir, generateKey: () => K_MID })
    rotateMasterKey({ spaceDir: dir, generateKey: () => K_NEW })

    const latest = openIdentityStore({ dbPath, masterKey: K_NEW })
    expect(latest.readVaultSecret(id)).toBe('sk-chain')
    latest.close()

    for (const retired of [K_OLD, K_MID]) {
      const s = openIdentityStore({ dbPath, masterKey: retired })
      expect(codeOf(() => s.readVaultSecret(id))).toBe('vault_decrypt_failed')
      s.close()
    }
  })

  it('refuses to overwrite a staged .next from an interrupted rotation (sole-copy protection)', () => {
    const id = seed('sk-brick')
    const K_STAGED = Buffer.alloc(32, 0x44)
    // Simulate a crash AFTER the DB re-wrap, BEFORE the promote: the DB is
    // wrapped under K_STAGED and `<keyfile>.next` holds the ONLY copy of it —
    // the live file still has the retired K_OLD.
    const s = openIdentityStore({ dbPath, masterKey: K_OLD })
    s.rotateVaultMasterKey(K_STAGED)
    s.close()
    writeFileSync(`${keyFile}.next`, K_STAGED, { mode: 0o600 })

    // A blind re-run must refuse BEFORE staging anything: overwriting `.next`
    // here would destroy the only key that opens the DB — vault bricked.
    expect(() => rotateMasterKey({ spaceDir: dir, generateKey: () => K_NEW })).toThrow(
      /interrupted rotation/,
    )

    // The sole copy survived byte-for-byte, the live file is untouched…
    expect(readFileSync(`${keyFile}.next`).equals(K_STAGED)).toBe(true)
    expect(readFileSync(keyFile).equals(K_OLD)).toBe(true)
    // …and the staged key still opens the vault — nothing was bricked.
    const rec = openIdentityStore({ dbPath, masterKey: K_STAGED })
    expect(rec.readVaultSecret(id)).toBe('sk-brick')
    rec.close()
  })

  it('a rival .next landing AFTER the pre-check still cannot be clobbered (atomic wx claim)', () => {
    const id = seed('sk-race')
    const K_RIVAL = Buffer.alloc(32, 0x55)

    // generateKey runs between the existsSync pre-check and the staging
    // write — plant a rival staged key there, simulating a concurrent
    // rotation winning the race in that window. The exclusive-create (`wx`)
    // write must lose LOUDLY: silently overwriting would destroy what may be
    // the rival's sole copy of a key its rotation is about to promote.
    expect(() =>
      rotateMasterKey({
        spaceDir: dir,
        generateKey: () => {
          writeFileSync(`${keyFile}.next`, K_RIVAL, { mode: 0o600 })
          return K_NEW
        },
      }),
    ).toThrow(/interrupted rotation/)

    // Rival's staged bytes intact; our rotation committed nothing.
    expect(readFileSync(`${keyFile}.next`).equals(K_RIVAL)).toBe(true)
    expect(readFileSync(keyFile).equals(K_OLD)).toBe(true)
    const s = openIdentityStore({ dbPath, masterKey: K_OLD })
    expect(s.readVaultSecret(id)).toBe('sk-race')
    s.close()
  })

  it('a concurrent recovery sweeping .next BEFORE the commit aborts the rotation cleanly', () => {
    const id = seed('sk-swept')
    // A parallel `rotate-master-key` run does recovery FIRST, and recovery
    // cannot tell our in-flight staging from crashed-rotation debris — while
    // the live key still opens the DB it deletes `.next`. Without the
    // pre-commit re-check the rotation would commit the DB to a key whose
    // only durable copy is gone, then die at the promote: vault bricked.
    expect(() =>
      rotateMasterKey({
        spaceDir: dir,
        generateKey: () => K_NEW,
        beforeDbRewrap: () => rmSync(`${keyFile}.next`),
      }),
    ).toThrow(/concurrent/)

    // Nothing committed: the live key still opens the vault, no staging left.
    expect(readFileSync(keyFile).equals(K_OLD)).toBe(true)
    expect(existsSync(`${keyFile}.next`)).toBe(false)
    const s = openIdentityStore({ dbPath, masterKey: K_OLD })
    expect(s.readVaultSecret(id)).toBe('sk-swept')
    s.close()
  })

  it('a rival key REPLACING .next before the commit also aborts (byte re-verify, not existence)', () => {
    const id = seed('sk-replaced')
    const K_RIVAL = Buffer.alloc(32, 0x55)
    expect(() =>
      rotateMasterKey({
        spaceDir: dir,
        generateKey: () => K_NEW,
        beforeDbRewrap: () => writeFileSync(`${keyFile}.next`, K_RIVAL, { mode: 0o600 }),
      }),
    ).toThrow(/concurrent/)

    // We aborted without committing; the rival's staging is left for ITS run.
    expect(readFileSync(`${keyFile}.next`).equals(K_RIVAL)).toBe(true)
    expect(readFileSync(keyFile).equals(K_OLD)).toBe(true)
    const s = openIdentityStore({ dbPath, masterKey: K_OLD })
    expect(s.readVaultSecret(id)).toBe('sk-replaced')
    s.close()
  })

  it('a concurrent recovery sweeping .next AFTER the commit cannot brick — the key re-materialises', () => {
    const id = seed('sk-heal')
    // Once the DB committed to the new key, the only correct end-state is
    // live=new. The staged file may be swept in the tiny window after the
    // re-check — step 4 must rewrite it from memory and finish, because at
    // that point `.next` (not the live file) is what opens the vault.
    rotateMasterKey({
      spaceDir: dir,
      generateKey: () => K_NEW,
      afterDbRewrap: () => rmSync(`${keyFile}.next`),
    })

    // Rotation COMPLETED despite the sweep: live key is the new one and opens
    // the vault; no staging debris remains.
    expect(readFileSync(keyFile).equals(K_NEW)).toBe(true)
    expect(existsSync(`${keyFile}.next`)).toBe(false)
    const s = openIdentityStore({ dbPath, masterKey: K_NEW })
    expect(s.readVaultSecret(id)).toBe('sk-heal')
    s.close()
  })
})
