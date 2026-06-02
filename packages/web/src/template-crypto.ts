/**
 * Symmetric encryption for the v5 B-M3 *sensitive* template sidecar.
 *
 * Decision #5: a template's structure is shareable plaintext, but the sensitive
 * material an owner may opt into exporting — literal MCP secrets ("knowledge
 * content" in our MCP-first model: the credentials that reach a knowledge base)
 * and personnel info (who owns what) — must be **encrypted, with the key handed
 * over separately**. So the export embeds an opaque ciphertext blob in the
 * template file and returns the key only in the HTTP response body; whoever
 * receives the file still needs the out-of-band key to read the sidecar.
 *
 * AES-256-GCM gives confidentiality + integrity (the auth tag detects any
 * tamper of the ciphertext or IV). One fresh random key + IV per export — keys
 * are never reused, so there is no nonce-reuse footgun.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm' as const
const KEY_BYTES = 32 // 256-bit
const IV_BYTES = 12 // 96-bit nonce — the GCM standard

/** An opaque, self-describing ciphertext envelope (all fields base64). */
export interface EncryptedBlob {
  algo: typeof ALGO
  iv: string
  ciphertext: string
  authTag: string
}

/** True when `v` structurally looks like an {@link EncryptedBlob}. */
export function isEncryptedBlob(v: unknown): v is EncryptedBlob {
  if (!v || typeof v !== 'object') return false
  const b = v as Record<string, unknown>
  return (
    b.algo === ALGO &&
    typeof b.iv === 'string' &&
    typeof b.ciphertext === 'string' &&
    typeof b.authTag === 'string'
  )
}

/**
 * Encrypt an arbitrary JSON-serializable value under a fresh random key.
 * Returns the ciphertext envelope (to embed in the template) and the key as
 * base64 (to deliver separately). The key is NOT inside the blob — that
 * separation is the whole point.
 */
export function encryptJson(value: unknown): { blob: EncryptedBlob; keyB64: string } {
  const key = randomBytes(KEY_BYTES)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()
  return {
    blob: {
      algo: ALGO,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: authTag.toString('base64'),
    },
    keyB64: key.toString('base64'),
  }
}

/**
 * Decrypt an {@link EncryptedBlob} with its separately-delivered base64 key
 * (the B-M4 import path). Throws on a wrong key, a wrong-length key, or any
 * tamper (GCM auth-tag check fails in `final()`) — fail-closed, never returns
 * partial / unverified plaintext.
 */
export function decryptJson(blob: EncryptedBlob, keyB64: string): unknown {
  if (blob.algo !== ALGO) {
    throw new Error(`unsupported template cipher '${String(blob.algo)}' (want ${ALGO})`)
  }
  const key = Buffer.from(keyB64, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error(`template decryption key must be ${KEY_BYTES} bytes (base64), got ${key.length}`)
  }
  const decipher = createDecipheriv(ALGO, key, Buffer.from(blob.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(blob.authTag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, 'base64')),
    decipher.final(),
  ])
  return JSON.parse(plaintext.toString('utf8'))
}
