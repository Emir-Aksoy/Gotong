import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  EnvMasterKeyProvider,
  KmsStubMasterKeyProvider,
  LocalFileMasterKeyProvider,
  loadOrCreateMasterKey,
  MASTER_KEY_LEN_BYTES,
  resolveMasterKeyProvider,
} from '../src/index.js'
// encryptSecret/decryptSecret are intentionally NOT re-exported from index
// (callers must go through IdentityStore.readVaultSecret); the test reaches
// the primitives directly for round-trip assertions.
import { decryptSecret, encryptSecret } from '../src/crypto.js'

/**
 * Route B P0-M4a — pluggable master key provider. The seam must keep the
 * default (local-file) byte-identical to the legacy loader, make the env
 * provider real (decoded material, no disk), and keep the kms-stub honest
 * (interface present, load() refuses). Each guard below is falsifiable.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aipe-mkp-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const HEX_KEY = 'a'.repeat(MASTER_KEY_LEN_BYTES * 2) // 64 hex chars → 32 bytes

describe('resolveMasterKeyProvider — default / local-file (Route B P0-M4a)', () => {
  it('defaults to local-file when kind is unset', () => {
    const p = resolveMasterKeyProvider({ localFilePath: join(dir, 'k.key') })
    expect(p.kind).toBe('local-file')
  })

  it('local-file load() is byte-identical to the legacy loader + creates a 0600 key file', () => {
    const path = join(dir, 'identity-master.key')
    const provider = resolveMasterKeyProvider({ localFilePath: path })
    const key = provider.load()
    expect(key).toHaveLength(MASTER_KEY_LEN_BYTES)
    expect(existsSync(path)).toBe(true)
    // Second load (and a fresh direct loader) returns the SAME persisted key.
    expect(provider.load().equals(key)).toBe(true)
    expect(loadOrCreateMasterKey(path).equals(key)).toBe(true)
    // round-trips a vault blob
    const blob = encryptSecret(key, 'sk-secret')
    expect(decryptSecret(key, blob)).toBe('sk-secret')
  })

  it("explicit kind 'local-file' behaves like the default", () => {
    const p = resolveMasterKeyProvider({ kind: 'local-file', localFilePath: join(dir, 'k.key') })
    expect(p.kind).toBe('local-file')
    expect(p.load()).toHaveLength(MASTER_KEY_LEN_BYTES)
  })
})

describe('resolveMasterKeyProvider — env provider (Route B P0-M4a)', () => {
  it('decodes injected hex material to the exact key and never touches disk', () => {
    const path = join(dir, 'should-not-exist.key')
    const provider = resolveMasterKeyProvider({
      kind: 'env',
      localFilePath: path,
      envKeyMaterial: HEX_KEY,
    })
    expect(provider.kind).toBe('env')
    const key = provider.load()
    expect(key).toEqual(Buffer.from(HEX_KEY, 'hex'))
    // env provider must not create the local-file key
    expect(existsSync(path)).toBe(false)
    const blob = encryptSecret(key, 'token')
    expect(decryptSecret(key, blob)).toBe('token')
  })

  it('tolerates surrounding whitespace/newlines in the material', () => {
    const provider = new EnvMasterKeyProvider(`  ${HEX_KEY}\n`)
    expect(provider.load()).toEqual(Buffer.from(HEX_KEY, 'hex'))
  })

  it('supports base64 encoding', () => {
    const raw = Buffer.from(HEX_KEY, 'hex')
    const provider = new EnvMasterKeyProvider(raw.toString('base64'), 'base64')
    expect(provider.load().equals(raw)).toBe(true)
  })

  it('env provider with no material throws (config error, fail closed)', () => {
    expect(() =>
      resolveMasterKeyProvider({ kind: 'env', localFilePath: join(dir, 'k.key') }),
    ).toThrow(/AIPE_MASTER_KEY/)
  })

  it('rejects wrong-length material (the length gate)', () => {
    const tooShort = 'ab'.repeat(8) // 16 bytes
    expect(() => new EnvMasterKeyProvider(tooShort).load()).toThrow(/32 bytes/)
  })
})

describe('resolveMasterKeyProvider — kms-stub + unknown (Route B P0-M4a)', () => {
  it('kms-stub resolves but load() fails closed (no silent key invention)', () => {
    const provider = resolveMasterKeyProvider({ kind: 'kms-stub', localFilePath: join(dir, 'k.key') })
    expect(provider.kind).toBe('kms-stub')
    expect(() => provider.load()).toThrow(/no\s+implementation|kms-stub/i)
  })

  it('rejects an unknown provider kind', () => {
    expect(() =>
      resolveMasterKeyProvider({ kind: 'vault-hsm', localFilePath: join(dir, 'k.key') }),
    ).toThrow(/unknown master key provider/)
  })
})

describe('provider describe() is log-safe (Route B P0-M4a)', () => {
  it('never leaks key bytes through describe()', () => {
    const local = new LocalFileMasterKeyProvider(join(dir, 'k.key'))
    const key = local.load()
    expect(local.describe()).toContain('local-file')
    expect(local.describe()).not.toContain(key.toString('hex'))

    const envP = new EnvMasterKeyProvider(HEX_KEY)
    expect(envP.describe()).toBe('env(env)')
    expect(envP.describe()).not.toContain(HEX_KEY)

    expect(new KmsStubMasterKeyProvider().describe()).toMatch(/kms-stub/)
  })
})

describe('provider keys are independent (Route B P0-M4a)', () => {
  it('a key from env cannot decrypt a blob written under the local-file key', () => {
    const localKey = new LocalFileMasterKeyProvider(join(dir, 'k.key')).load()
    const envKey = new EnvMasterKeyProvider(HEX_KEY).load()
    const blob = encryptSecret(localKey, 'plaintext')
    expect(() => decryptSecret(envKey, blob)).toThrow()
    // sanity: on-disk key really differs from the injected one
    expect(readFileSync(join(dir, 'k.key')).equals(envKey)).toBe(false)
  })
})
