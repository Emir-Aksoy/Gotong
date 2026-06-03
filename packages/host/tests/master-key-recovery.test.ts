import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openIdentityStore } from '@aipehub/identity'

import { recoverMasterKeyRotation } from '../src/master-key-recovery.js'
import { IDENTITY_DB_FILENAME, MASTER_KEY_FILENAME } from '../src/rotate-master-key.js'

/**
 * Route B P0-M5 — boot recovery for an interrupted local-file KEK rotation.
 * P0-M4d is crash-safe by ordering but explicitly deferred the *recovery*: a
 * crash between the DB re-wrap and the key-file promote leaves the live key
 * unable to unwrap the vault while `<keyfile>.next` holds the only key that can.
 * These pin the recovery's decision in every crash window: promote the staged
 * key only when it (and not the live key) unwraps the DEK, discard it when the
 * live key still works, and refuse to guess when neither does. Each guard is
 * falsifiable — neutralise it and a specific scenario goes RED.
 */

const K_OLD = Buffer.alloc(32, 0x11)
const K_NEW = Buffer.alloc(32, 0x22)
const K_THIRD = Buffer.alloc(32, 0x33)

let dir: string
let keyFile: string
let stagedFile: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aipe-mkrec-'))
  keyFile = join(dir, MASTER_KEY_FILENAME)
  stagedFile = `${keyFile}.next`
  dbPath = join(dir, IDENTITY_DB_FILENAME)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Seed: a 0600 key file under K_OLD + one vault secret (seeds the DEK). */
function seed(secret: string): string {
  writeFileSync(keyFile, K_OLD, { mode: 0o600 })
  const s = openIdentityStore({ dbPath, masterKey: K_OLD })
  const id = s.createVaultEntry({ kind: 'llm_provider', ownerKind: 'org', secret }).id
  s.close()
  return id
}

/** Re-wrap the DB's DEK under `newKey` (the rotation's step 2), live untouched. */
function reWrapDbTo(newKey: Buffer): void {
  const s = openIdentityStore({ dbPath, masterKey: K_OLD })
  s.rotateVaultMasterKey(newKey)
  s.close()
}

describe('recoverMasterKeyRotation (Route B P0-M5)', () => {
  it('promotes the staged key when the DB was re-wrapped under it (crash after re-wrap, before promote)', () => {
    const id = seed('sk-live')
    reWrapDbTo(K_NEW) // DB now under K_NEW…
    writeFileSync(keyFile, K_OLD, { mode: 0o600 }) // …but the live file is still K_OLD…
    writeFileSync(stagedFile, K_NEW, { mode: 0o600 }) // …and the new key sits in .next.

    const rec = recoverMasterKeyRotation(dir)
    expect(rec.action).toBe('promoted')

    // The live file now holds K_NEW and the staged file is gone…
    expect(readFileSync(keyFile).equals(K_NEW)).toBe(true)
    expect(existsSync(stagedFile)).toBe(false)
    // …so the next boot loads it and the vault opens.
    const next = openIdentityStore({ dbPath, masterKey: readFileSync(keyFile) })
    expect(next.readVaultSecret(id)).toBe('sk-live')
    next.close()
  })

  it('discards a stale staged key when the live key still unwraps the DEK (crash before re-wrap)', () => {
    const id = seed('sk-live') // DB under K_OLD…
    writeFileSync(stagedFile, K_NEW, { mode: 0o600 }) // …staged but never re-wrapped.

    const rec = recoverMasterKeyRotation(dir)
    expect(rec.action).toBe('discarded')

    expect(existsSync(stagedFile)).toBe(false) // stale staged key removed
    expect(readFileSync(keyFile).equals(K_OLD)).toBe(true) // live key untouched
    const next = openIdentityStore({ dbPath, masterKey: readFileSync(keyFile) })
    expect(next.readVaultSecret(id)).toBe('sk-live')
    next.close()
  })

  it('discards the staged key when there is no vault DEK at risk', () => {
    // Open + close under K_OLD without ever touching the vault → no DEK row.
    writeFileSync(keyFile, K_OLD, { mode: 0o600 })
    openIdentityStore({ dbPath, masterKey: K_OLD }).close()
    writeFileSync(stagedFile, K_NEW, { mode: 0o600 })

    const rec = recoverMasterKeyRotation(dir)
    expect(rec.action).toBe('discarded')
    expect(existsSync(stagedFile)).toBe(false)
    expect(readFileSync(keyFile).equals(K_OLD)).toBe(true)
  })

  it('leaves both files untouched when neither key unwraps the DEK (refuses to guess)', () => {
    seed('sk-live')
    reWrapDbTo(K_NEW) // DB under K_NEW…
    writeFileSync(keyFile, K_OLD, { mode: 0o600 }) // …live is K_OLD (mismatch)…
    writeFileSync(stagedFile, K_THIRD, { mode: 0o600 }) // …staged is a third unrelated key.

    const rec = recoverMasterKeyRotation(dir)
    expect(rec.action).toBe('inconclusive')

    // Both files are preserved for an operator to investigate.
    expect(readFileSync(keyFile).equals(K_OLD)).toBe(true)
    expect(readFileSync(stagedFile).equals(K_THIRD)).toBe(true)
  })

  it("is a no-op ('none') when there is no staged key", () => {
    seed('sk-live')
    const rec = recoverMasterKeyRotation(dir)
    expect(rec.action).toBe('none')
    expect(readFileSync(keyFile).equals(K_OLD)).toBe(true)
  })

  it("is a no-op for a non-local-file provider, never touching .next", () => {
    seed('sk-live')
    writeFileSync(stagedFile, K_NEW, { mode: 0o600 })

    const rec = recoverMasterKeyRotation(dir, 'env')
    expect(rec.action).toBe('none')
    // The env-provider key is managed out of band — we must not delete .next.
    expect(existsSync(stagedFile)).toBe(true)
    expect(readFileSync(keyFile).equals(K_OLD)).toBe(true)
  })
})
