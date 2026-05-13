import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decryptSecret,
  emptySecretsFile,
  encryptSecret,
  loadOrCreateMasterKey,
} from '../src/secrets.js'
import { Space } from '../src/space.js'

/**
 * Secrets layer must:
 *   - Round-trip plaintext through encrypt → decrypt with the same key
 *   - Refuse to decrypt with the wrong key (single error class, no
 *     side-channel leak about which case failed)
 *   - Refuse to decrypt tampered ciphertext
 *   - Generate a fresh master key on first call and reuse it after
 *   - Prefer AIPE_SECRET_KEY env over the on-disk key
 *
 * The Space wrapper must:
 *   - Persist encrypted secrets to secrets.enc.json on a roundtrip
 *   - List configured providers/agents without leaking plaintext
 *   - Drop an agent's override key when the agent is removed
 */

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
    const dir = mkdtempSync(join(tmpdir(), 'aipehub-secrets-'))
    const path = join(dir, 'secret.key')
    const k1 = await loadOrCreateMasterKey(path)
    expect(k1.length).toBe(32)
    const k2 = await loadOrCreateMasterKey(path)
    expect(k2.toString('hex')).toBe(k1.toString('hex'))
  })

  it('prefers AIPE_SECRET_KEY env over the on-disk key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aipehub-secrets-'))
    const path = join(dir, 'secret.key')
    await loadOrCreateMasterKey(path)                  // writes random
    const envHex = '00'.repeat(32)
    const prev = process.env.AIPE_SECRET_KEY
    process.env.AIPE_SECRET_KEY = envHex
    try {
      const k = await loadOrCreateMasterKey(path)
      expect(k.toString('hex')).toBe(envHex)
    } finally {
      if (prev === undefined) delete process.env.AIPE_SECRET_KEY
      else process.env.AIPE_SECRET_KEY = prev
    }
  })

  it('rejects bad-length AIPE_SECRET_KEY', async () => {
    const prev = process.env.AIPE_SECRET_KEY
    process.env.AIPE_SECRET_KEY = 'too-short'
    try {
      await expect(loadOrCreateMasterKey('/tmp/never')).rejects.toThrow(/64 hex chars/)
    } finally {
      if (prev === undefined) delete process.env.AIPE_SECRET_KEY
      else process.env.AIPE_SECRET_KEY = prev
    }
  })
})

describe('Space secret methods', () => {
  it('persists, lists, and reads back a workspace provider key (no plaintext leak)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aipehub-space-secrets-'))
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
    const root = mkdtempSync(join(tmpdir(), 'aipehub-space-agentkey-'))
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
    const root = mkdtempSync(join(tmpdir(), 'aipehub-space-cross-'))
    const { space } = await Space.init(root, { name: 'test' })
    await space.setProviderApiKey('openai', 'sk-openai-x')

    // Open another Space pointing at the same root — same master key on
    // disk, same secrets.enc.json — decrypt should work transparently.
    const reopened = await Space.open(root)
    expect(await reopened.getProviderApiKey('openai')).toBe('sk-openai-x')
  })

  it('empty plaintext is rejected (you can\'t set "" as a key)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aipehub-empty-'))
    const { space } = await Space.init(root, { name: 'test' })
    await expect(space.setProviderApiKey('anthropic', '')).rejects.toThrow(/non-empty/)
    await expect(space.setAgentApiKey('alice', '')).rejects.toThrow(/non-empty/)
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
