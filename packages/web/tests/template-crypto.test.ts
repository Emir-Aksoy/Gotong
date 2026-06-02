/**
 * Unit tests for the v5 B-M3 sensitive-template cipher (AES-256-GCM).
 * Confidentiality + integrity: a round-trip recovers the value, a wrong key is
 * rejected, and any tamper of the ciphertext / IV / tag fails closed.
 */

import { describe, expect, it } from 'vitest'

import { decryptJson, encryptJson, isEncryptedBlob } from '../src/template-crypto.js'

describe('template-crypto (B-M3 sensitive sidecar)', () => {
  const payload = {
    secrets: { '${CHROMA_TOKEN}': 'sk-LITERAL', '${AUTHORIZATION}': 'Bearer xyz' },
    personnel: { 'support-agent': [{ principal: 'user:alice', perm: 'owner' }] },
  }

  it('round-trips an arbitrary JSON value', () => {
    const { blob, keyB64 } = encryptJson(payload)
    expect(decryptJson(blob, keyB64)).toEqual(payload)
  })

  it('produces a well-formed, self-describing blob; the key is NOT inside it', () => {
    const { blob, keyB64 } = encryptJson(payload)
    expect(isEncryptedBlob(blob)).toBe(true)
    expect(blob.algo).toBe('aes-256-gcm')
    // The whole point of decision #5: the key travels separately.
    const serialized = JSON.stringify(blob)
    expect(serialized).not.toContain(keyB64)
    expect(serialized).not.toContain('sk-LITERAL')
  })

  it('uses a fresh key + IV each call (no nonce reuse)', () => {
    const a = encryptJson(payload)
    const b = encryptJson(payload)
    expect(a.keyB64).not.toBe(b.keyB64)
    expect(a.blob.iv).not.toBe(b.blob.iv)
    expect(a.blob.ciphertext).not.toBe(b.blob.ciphertext)
  })

  it('rejects a wrong key', () => {
    const { blob } = encryptJson(payload)
    const wrong = encryptJson(payload).keyB64 // a valid-length but different key
    expect(() => decryptJson(blob, wrong)).toThrow()
  })

  it('rejects a wrong-length key', () => {
    const { blob } = encryptJson(payload)
    expect(() => decryptJson(blob, Buffer.from('too-short').toString('base64'))).toThrow(/32 bytes/)
  })

  it('fails closed on tampered ciphertext (GCM auth tag)', () => {
    const { blob, keyB64 } = encryptJson(payload)
    const tampered = { ...blob, ciphertext: flipLastBase64Byte(blob.ciphertext) }
    expect(() => decryptJson(tampered, keyB64)).toThrow()
  })

  it('rejects an unknown cipher algo', () => {
    const { blob, keyB64 } = encryptJson(payload)
    const wrongAlgo = { ...blob, algo: 'rot13' as unknown as typeof blob.algo }
    expect(() => decryptJson(wrongAlgo, keyB64)).toThrow(/unsupported template cipher/)
  })
})

/** Flip a byte in a base64 buffer so the decoded ciphertext is corrupted. */
function flipLastBase64Byte(b64: string): string {
  const buf = Buffer.from(b64, 'base64')
  buf[buf.length - 1] ^= 0xff
  return buf.toString('base64')
}
