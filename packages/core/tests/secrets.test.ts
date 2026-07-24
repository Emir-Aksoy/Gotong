import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decryptSecret,
  emptySecretsFile,
  encryptSecret,
  loadOrCreateMasterKey,
  SECRETS_FILE_VERSION_UNIFIED,
  type SecretsFile,
} from '../src/secrets.js'
import { Space } from '../src/space.js'

/**
 * Secrets layer must:
 *   - Round-trip plaintext through encrypt → decrypt with the same key
 *   - Refuse to decrypt with the wrong key (single error class, no
 *     side-channel leak about which case failed)
 *   - Refuse to decrypt tampered ciphertext
 *   - Generate a fresh master key on first call and reuse it after
 *   - Prefer GOTONG_SECRET_KEY env over the on-disk key
 *
 * The Space wrapper must:
 *   - Persist encrypted secrets to secrets.enc.json on a roundtrip
 *   - List configured providers/agents without leaking plaintext
 *   - Drop an agent's override key when the agent is removed
 */

// H16: every `mkdtempSync` was previously leaked into $TMPDIR — on CI
// that's harmless but on a dev box it adds up. Centralise so afterEach
// can sweep them up, regardless of whether the test passed or threw.
const tempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(d)
  return d
}
afterEach(async () => {
  // Drain the list before awaiting so a parallel-test rerun doesn't
  // double-remove. Cleanup is best-effort; teardown errors must not
  // mask the actual test failure.
  const dirs = tempDirs.splice(0)
  await Promise.all(
    dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})),
  )
})

describe('encryptSecret / decryptSecret', () => {
  it('round-trips plaintext with the same key', () => {
    const key = Buffer.alloc(32, 7)
    const enc = encryptSecret(key, 'sk-test-abcdef')
    expect(enc.iv.length).toBeGreaterThan(0)
    expect(enc.ciphertext.length).toBeGreaterThan(0)
    expect(enc.authTag.length).toBeGreaterThan(0)
    const plain = decryptSecret(key, enc)
    expect(plain).toBe('sk-test-abcdef')
  })

  it('handles unicode plaintext', () => {
    const key = Buffer.alloc(32, 7)
    const enc = encryptSecret(key, '密钥-中文-🔑')
    expect(decryptSecret(key, enc)).toBe('密钥-中文-🔑')
  })

  it('fails on the wrong key', () => {
    const key1 = Buffer.alloc(32, 1)
    const key2 = Buffer.alloc(32, 2)
    const enc = encryptSecret(key1, 'secret')
    expect(() => decryptSecret(key2, enc)).toThrow(/cannot decrypt/)
  })

  it('fails on tampered ciphertext', () => {
    const key = Buffer.alloc(32, 7)
    const enc = encryptSecret(key, 'secret')
    // flip a byte in the ciphertext
    const ct = Buffer.from(enc.ciphertext, 'base64')
    ct[0] = ct[0]! ^ 0xff
    const tampered = { ...enc, ciphertext: ct.toString('base64') }
    expect(() => decryptSecret(key, tampered)).toThrow(/cannot decrypt/)
  })

  it('throws if master key is not 32 bytes', () => {
    expect(() => encryptSecret(Buffer.alloc(16), 'x')).toThrow(/32 bytes/)
    const enc = encryptSecret(Buffer.alloc(32), 'x')
    expect(() => decryptSecret(Buffer.alloc(16), enc)).toThrow(/32 bytes/)
  })

  it('produces a different ciphertext each time (fresh IV)', () => {
    const key = Buffer.alloc(32, 7)
    const a = encryptSecret(key, 'same')
    const b = encryptSecret(key, 'same')
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    // Both still decrypt to the same plaintext
    expect(decryptSecret(key, a)).toBe('same')
    expect(decryptSecret(key, b)).toBe('same')
  })
})

describe('loadOrCreateMasterKey', () => {
  it('generates a fresh 32-byte key on first call and reuses it after', async () => {
    const dir = makeTempDir('gotong-secrets-')
    const path = join(dir, 'secret.key')
    const k1 = await loadOrCreateMasterKey(path)
    expect(k1.length).toBe(32)
    const k2 = await loadOrCreateMasterKey(path)
    expect(k2.toString('hex')).toBe(k1.toString('hex'))
  })

  it('prefers GOTONG_SECRET_KEY env over the on-disk key', async () => {
    const dir = makeTempDir('gotong-secrets-')
    const path = join(dir, 'secret.key')
    await loadOrCreateMasterKey(path)                  // writes random
    const envHex = '00'.repeat(32)
    const prev = process.env.GOTONG_SECRET_KEY
    process.env.GOTONG_SECRET_KEY = envHex
    try {
      const k = await loadOrCreateMasterKey(path)
      expect(k.toString('hex')).toBe(envHex)
    } finally {
      if (prev === undefined) delete process.env.GOTONG_SECRET_KEY
      else process.env.GOTONG_SECRET_KEY = prev
    }
  })

  it('rejects bad-length GOTONG_SECRET_KEY', async () => {
    const prev = process.env.GOTONG_SECRET_KEY
    process.env.GOTONG_SECRET_KEY = 'too-short'
    try {
      await expect(loadOrCreateMasterKey('/tmp/never')).rejects.toThrow(/64 hex chars/)
    } finally {
      if (prev === undefined) delete process.env.GOTONG_SECRET_KEY
      else process.env.GOTONG_SECRET_KEY = prev
    }
  })

  it('rejects non-hex and odd-length keys Buffer.from would silently truncate', async () => {
    // Buffer.from('…', 'hex') stops at the first invalid pair and drops an
    // odd tail — a 65-char value would previously "pass" the length check
    // with a key the operator never wrote. Strict /^[0-9a-fA-F]{64}$/ now.
    const prev = process.env.GOTONG_SECRET_KEY
    try {
      process.env.GOTONG_SECRET_KEY = 'ab'.repeat(32) + 'f' // 65 chars, odd tail
      await expect(loadOrCreateMasterKey('/tmp/never')).rejects.toThrow(/64 hex chars/)
      process.env.GOTONG_SECRET_KEY = 'ab'.repeat(31) + 'zz' // 64 chars, non-hex
      await expect(loadOrCreateMasterKey('/tmp/never')).rejects.toThrow(/64 hex chars/)
    } finally {
      if (prev === undefined) delete process.env.GOTONG_SECRET_KEY
      else process.env.GOTONG_SECRET_KEY = prev
    }
  })

  it('rejects a key FILE whose content is not exactly 64 hex chars', async () => {
    const dir = makeTempDir('gotong-keyfile-junk-')
    const keyPath = join(dir, 'secret.key')
    // 64 valid hex + trailing junk: hex-decode would silently keep 32 bytes
    // and ignore the tail — refuse instead (operator meant SOMETHING there).
    writeFileSync(keyPath, 'ab'.repeat(32) + 'zz\n', 'utf8')
    await expect(loadOrCreateMasterKey(keyPath)).rejects.toThrow(/not exactly 64 hex chars/)
  })
})

describe('Space secret methods', () => {
  it('persists, lists, and reads back a workspace provider key (no plaintext leak)', async () => {
    const root = makeTempDir('gotong-space-secrets-')
    const { space } = await Space.init(root, { name: 'test' })

    expect(await space.listProviderApiKeys()).toEqual({})
    expect(await space.getProviderApiKey('anthropic')).toBeNull()

    await space.setProviderApiKey('anthropic', 'sk-ant-test')
    const list = await space.listProviderApiKeys()
    expect(Object.keys(list)).toEqual(['anthropic'])
    expect(typeof list.anthropic).toBe('string')           // timestamp, not the key
    expect(list.anthropic).not.toContain('sk-ant-test')    // make sure listing doesn't leak

    expect(await space.getProviderApiKey('anthropic')).toBe('sk-ant-test')

    const removed = await space.removeProviderApiKey('anthropic')
    expect(removed).toBe(true)
    expect(await space.getProviderApiKey('anthropic')).toBeNull()
  })

  it('per-agent key is preferred and is dropped when the agent is removed', async () => {
    const root = makeTempDir('gotong-space-agentkey-')
    const { space } = await Space.init(root, { name: 'test' })

    await space.upsertAgent({ id: 'alice', allowedCapabilities: ['x'] })
    await space.setProviderApiKey('anthropic', 'ws-default')
    await space.setAgentApiKey('alice', 'alice-only')

    expect(await space.getAgentApiKey('alice')).toBe('alice-only')
    expect(await space.getProviderApiKey('anthropic')).toBe('ws-default')

    // Removing the agent drops its key automatically
    await space.removeAgent('alice')
    expect(await space.getAgentApiKey('alice')).toBeNull()
    // Workspace default is untouched
    expect(await space.getProviderApiKey('anthropic')).toBe('ws-default')
  })

  it('round-trips secrets across two Space instances (on-disk file is canonical)', async () => {
    const root = makeTempDir('gotong-space-cross-')
    const { space } = await Space.init(root, { name: 'test' })
    await space.setProviderApiKey('openai', 'sk-openai-x')

    // Open another Space pointing at the same root — same master key on
    // disk, same secrets.enc.json — decrypt should work transparently.
    const reopened = await Space.open(root)
    expect(await reopened.getProviderApiKey('openai')).toBe('sk-openai-x')
  })

  it('empty plaintext is rejected (you can\'t set "" as a key)', async () => {
    const root = makeTempDir('gotong-empty-')
    const { space } = await Space.init(root, { name: 'test' })
    await expect(space.setProviderApiKey('anthropic', '')).rejects.toThrow(/non-empty/)
    await expect(space.setAgentApiKey('alice', '')).rejects.toThrow(/non-empty/)
  })
})

describe('bindSecretsMasterKey (B① unification seam)', () => {
  const DERIVED = Buffer.alloc(32, 0x5a)

  it('bound Space writes v2, reads back, and never mints runtime/secret.key', async () => {
    const root = makeTempDir('gotong-bind-')
    const { space } = await Space.init(root, { name: 'test' })
    space.bindSecretsMasterKey(DERIVED)

    await space.setProviderApiKey('anthropic', 'sk-bound')
    const file = JSON.parse(readFileSync(join(root, 'secrets.enc.json'), 'utf8')) as SecretsFile
    expect(file.version).toBe(SECRETS_FILE_VERSION_UNIFIED)
    expect(decryptSecret(DERIVED, file.providers.anthropic!)).toBe('sk-bound')
    expect(await space.getProviderApiKey('anthropic')).toBe('sk-bound')
    // The whole point of unification: the legacy key file is never created.
    expect(existsSync(join(root, 'runtime', 'secret.key'))).toBe(false)
  })

  it('rejects a non-32-byte key and a conflicting rebind', async () => {
    const root = makeTempDir('gotong-bind-bad-')
    const { space } = await Space.init(root, { name: 'test' })
    expect(() => space.bindSecretsMasterKey(Buffer.alloc(16))).toThrow(/32-byte/)
    space.bindSecretsMasterKey(DERIVED)
    // Same key again is fine (idempotent)…
    space.bindSecretsMasterKey(Buffer.from(DERIVED))
    // …a DIFFERENT key is a wiring bug — refuse loudly.
    expect(() => space.bindSecretsMasterKey(Buffer.alloc(32, 0x77))).toThrow(/different secrets key/)
  })

  it('v2 file without a bound key: get AND set refuse loudly (no junk-key fallback)', async () => {
    const root = makeTempDir('gotong-v2-guard-')
    const { space } = await Space.init(root, { name: 'test' })
    const v2: SecretsFile = {
      version: 2,
      providers: { anthropic: encryptSecret(DERIVED, 'sk-locked') },
      agents: {},
    }
    writeFileSync(join(root, 'secrets.enc.json'), JSON.stringify(v2))

    await expect(space.getProviderApiKey('anthropic')).rejects.toThrow(/no derived key was bound/)
    await expect(space.setProviderApiKey('openai', 'sk-new')).rejects.toThrow(/no derived key was bound/)
    // The refusal must not have minted a legacy key file as a side effect.
    expect(existsSync(join(root, 'runtime', 'secret.key'))).toBe(false)
  })

  it('unbound legacy path is untouched: v1 file stays v1 through writes', async () => {
    const root = makeTempDir('gotong-v1-legacy-')
    const { space } = await Space.init(root, { name: 'test' })
    await space.setProviderApiKey('anthropic', 'sk-legacy')
    const file = JSON.parse(readFileSync(join(root, 'secrets.enc.json'), 'utf8')) as SecretsFile
    expect(file.version).toBe(1)
    expect(existsSync(join(root, 'runtime', 'secret.key'))).toBe(true)
  })

  it('a CACHED legacy key never touches a v2 file (file generation beats the cache)', async () => {
    const root = makeTempDir('gotong-cache-guard-')
    const { space } = await Space.init(root, { name: 'test' })
    // Legacy path: this write mints AND caches the legacy master key.
    await space.setProviderApiKey('anthropic', 'sk-legacy')
    expect(await space.getProviderApiKey('anthropic')).toBe('sk-legacy')
    // Boot migration stamps the file to v2 out from under the live instance.
    const v2: SecretsFile = {
      version: 2,
      providers: { anthropic: encryptSecret(DERIVED, 'sk-unified') },
      agents: {},
    }
    writeFileSync(join(root, 'secrets.enc.json'), JSON.stringify(v2))
    // The cached key must NOT be applied to the v2 file — a set here would
    // re-encrypt under the legacy key while keeping the v2 stamp: mixed keys.
    await expect(space.getProviderApiKey('anthropic')).rejects.toThrow(/no derived key was bound/)
    await expect(space.setProviderApiKey('openai', 'sk-x')).rejects.toThrow(/no derived key was bound/)
  })

  it('bound Space refuses a v1 file WITH entries (mixed-restore guard)', async () => {
    const root = makeTempDir('gotong-v1-regress-')
    const { space } = await Space.init(root, { name: 'test' })
    space.bindSecretsMasterKey(DERIVED)
    // A pre-unification backup restored over the live dir while bound: those
    // entries are under the LEGACY key — decrypting or re-stamping them with
    // the derived key would corrupt, so both directions refuse.
    const v1: SecretsFile = {
      version: 1,
      providers: { anthropic: encryptSecret(Buffer.alloc(32, 0x33), 'sk-old') },
      agents: {},
    }
    writeFileSync(join(root, 'secrets.enc.json'), JSON.stringify(v1))
    await expect(space.getProviderApiKey('anthropic')).rejects.toThrow(/regressed to v1/)
    await expect(space.setProviderApiKey('openai', 'sk-x')).rejects.toThrow(/regressed to v1/)
  })

  it('unknown (future) file version refuses loudly instead of coercing to v1', async () => {
    const root = makeTempDir('gotong-vfuture-')
    const { space } = await Space.init(root, { name: 'test' })
    writeFileSync(join(root, 'secrets.enc.json'), JSON.stringify({ version: 3, providers: {}, agents: {} }))
    await expect(space.getProviderApiKey('anthropic')).rejects.toThrow(/unknown version/)
  })

  it('REMOVE paths run the same generation gate (writeSecretsFile re-stamps)', async () => {
    // A remove is a WRITE: writeSecretsFile stamps v2 whenever a key is
    // bound, so an ungated remove on a v1-with-entries file would re-stamp
    // the survivors as v2 while they are still legacy-key ciphertext.
    const bound = makeTempDir('gotong-rm-bound-')
    const { space } = await Space.init(bound, { name: 'test' })
    space.bindSecretsMasterKey(DERIVED)
    const legacy = Buffer.alloc(32, 0x33)
    const v1: SecretsFile = {
      version: 1,
      providers: { anthropic: encryptSecret(legacy, 'sk-old') },
      agents: { alice: encryptSecret(legacy, 'sk-alice') },
    }
    writeFileSync(join(bound, 'secrets.enc.json'), JSON.stringify(v1))
    await expect(space.removeProviderApiKey('anthropic')).rejects.toThrow(/regressed to v1/)
    await expect(space.removeAgentApiKey('alice')).rejects.toThrow(/regressed to v1/)
    // Refusal is loud, not lossy: entries survive for the legacy-key boot.
    const after = JSON.parse(readFileSync(join(bound, 'secrets.enc.json'), 'utf8')) as SecretsFile
    expect(after.providers.anthropic).toBeDefined()
    expect(after.agents.alice).toBeDefined()

    // Mirror direction: a v2 file with no bound key must refuse removes too
    // (an unbound write would stamp the file back to v1 — generation rollback).
    const unbound = makeTempDir('gotong-rm-unbound-')
    const { space: space2 } = await Space.init(unbound, { name: 'test' })
    const v2: SecretsFile = {
      version: 2,
      providers: { anthropic: encryptSecret(DERIVED, 'sk-locked') },
      agents: { bob: encryptSecret(DERIVED, 'sk-bob') },
    }
    writeFileSync(join(unbound, 'secrets.enc.json'), JSON.stringify(v2))
    await expect(space2.removeProviderApiKey('anthropic')).rejects.toThrow(/no derived key was bound/)
    await expect(space2.removeAgentApiKey('bob')).rejects.toThrow(/no derived key was bound/)
    expect(existsSync(join(unbound, 'runtime', 'secret.key'))).toBe(false)
  })

  it('unbound v1 remove succeeds WITHOUT minting runtime/secret.key', async () => {
    // A remove never decrypts, so the legacy path must not mint a key file
    // as a side effect of deleting an entry — that was the point of gating
    // via assertSecretsGenerationCoherent instead of getMasterKey.
    const root = makeTempDir('gotong-rm-v1-')
    const { space } = await Space.init(root, { name: 'test' })
    const v1: SecretsFile = {
      version: 1,
      providers: { anthropic: encryptSecret(Buffer.alloc(32, 0x44), 'sk-old') },
      agents: {},
    }
    writeFileSync(join(root, 'secrets.enc.json'), JSON.stringify(v1))
    expect(await space.removeProviderApiKey('anthropic')).toBe(true)
    const after = JSON.parse(readFileSync(join(root, 'secrets.enc.json'), 'utf8')) as SecretsFile
    expect(after.version).toBe(1)
    expect(after.providers.anthropic).toBeUndefined()
    expect(existsSync(join(root, 'runtime', 'secret.key'))).toBe(false)
  })
})

describe('emptySecretsFile', () => {
  it('returns a fresh, mutable empty file', () => {
    const f = emptySecretsFile()
    expect(f.version).toBe(1)
    expect(f.providers).toEqual({})
    expect(f.agents).toEqual({})
    // ensure we got our own object, not a frozen singleton
    f.providers.foo = { iv: 'x', ciphertext: 'y', authTag: 'z', updatedAt: '' }
    const fresh = emptySecretsFile()
    expect(fresh.providers).toEqual({})
  })
})
