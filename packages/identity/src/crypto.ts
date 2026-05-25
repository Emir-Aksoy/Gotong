/**
 * AES-256-GCM application-layer encryption for vault secrets (A1).
 *
 * # Why a separate crypto module from credentials.ts
 *
 * credentials.ts hashes auth material (passwords, api keys) one-way —
 * you can only verify, never recover. The vault holds the opposite kind
 * of secret: LLM provider keys, MCP tokens, peer-hub mutual-auth tokens.
 * Those MUST be decryptable because the host re-presents them to upstream
 * services. Different threat model, different primitive.
 *
 * # Why AES-GCM (not chacha20-poly1305 / fernet / libsodium)
 *
 *   - GCM is in node:crypto core — zero external deps, consistent with
 *     the rest of identity/credentials.ts.
 *   - Authenticated encryption (AEAD): the 16-byte auth tag detects
 *     bit-flips that would otherwise yield garbage plaintext silently.
 *   - 12-byte nonce is the NIST-recommended size for GCM.
 *
 * # Why a separate master key (not derived from owner password)
 *
 * Vault secrets are read by host-internal jobs at arbitrary times (e.g.
 * a scheduled rollup at 2am calling the LLM). If the key were derived
 * from an operator password, the host couldn't decrypt anything between
 * reboot and operator login. Unacceptable for an unattended single-org
 * host.
 *
 * # Why the master key lives in the workspace .aipehub/ dir
 *
 *   - Single-machine deployment model. The .key file is exactly as
 *     secret as the .sqlite next to it. An attacker who can read one
 *     can read both, so protecting them separately at this deployment
 *     model gains nothing.
 *   - When v5 introduces KMS / HSM, `loadOrCreateMasterKey` is the only
 *     function to swap (it can route to KMS via env detection).
 *
 * # On-disk format
 *
 *   v1.gcm$<nonce_b64url>$<ciphertext_b64url>$<authtag_b64url>
 *
 * The version prefix lets us swap algorithm later (`v2.xchacha`) without
 * breaking old rows — decrypt routes on the prefix.
 *
 * # Threat model
 *
 *   - Attacker reads .sqlite but NOT .key   → cannot decrypt. ✅
 *   - Attacker reads both files             → game over (fs perms 0600
 *                                               is the only line of defence).
 *   - Attacker flips one ciphertext byte    → GCM auth tag rejects on
 *                                               decrypt. ✅
 *   - Operator deletes .key by mistake      → old rows un-decryptable,
 *                                               must be re-issued by hand.
 *                                               Make a backup of .key with
 *                                               the same care as .sqlite.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

import { IdentityError } from './errors.js'

const KEY_LEN_BYTES = 32 // AES-256
const NONCE_LEN_BYTES = 12 // GCM standard
const AUTH_TAG_LEN_BYTES = 16
const ENC_VERSION = 'v1.gcm'

/**
 * Exported for tests + advanced callers that want to inject a key
 * (e.g. KMS-backed deployment). Always 32 bytes.
 */
export const MASTER_KEY_LEN_BYTES = KEY_LEN_BYTES

/**
 * Load the host's master encryption key from `path`, generating a fresh
 * 32-byte random one on first run. File mode is forced to 0o600 (POSIX)
 * so only the host process user can read it.
 *
 * A pre-existing file that's the wrong length throws immediately rather
 * than silently re-keying — a stale .key means existing vault rows can't
 * decrypt, and a silent re-key would erase that signal.
 */
export function loadOrCreateMasterKey(path: string): Buffer {
  if (existsSync(path)) {
    const buf = readFileSync(path)
    if (buf.length !== KEY_LEN_BYTES) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `master key file ${path} has wrong length (${buf.length}, expected ${KEY_LEN_BYTES})`,
      })
    }
    return buf
  }
  mkdirSync(dirname(path), { recursive: true })
  const key = randomBytes(KEY_LEN_BYTES)
  writeFileSync(path, key, { mode: 0o600 })
  // chmod again defensively — writeFileSync honours mode on create, but
  // a pre-existing file (race) would keep its old perms.
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600)
    } catch {
      // tolerate exFAT / SMB / sandboxed fs that reject chmod
    }
  }
  return key
}

/**
 * Encrypt plaintext with the master key. Returns the on-disk blob
 * ready for the vault.secret_enc column.
 */
export function encryptSecret(masterKey: Buffer, plaintext: string): string {
  assertKey(masterKey)
  if (typeof plaintext !== 'string') {
    throw new IdentityError({
      code: 'invalid_input',
      message: 'plaintext must be a string',
    })
  }
  const nonce = randomBytes(NONCE_LEN_BYTES)
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    ENC_VERSION,
    nonce.toString('base64url'),
    ct.toString('base64url'),
    tag.toString('base64url'),
  ].join('$')
}

/**
 * Decrypt a vault.secret_enc blob. Throws `IdentityError` with code
 * `vault_decrypt_failed` on any failure (corrupt row, tampered
 * ciphertext, wrong master key, unknown version). Returns UTF-8
 * plaintext.
 */
export function decryptSecret(masterKey: Buffer, blob: string): string {
  assertKey(masterKey)
  if (typeof blob !== 'string') {
    throw new IdentityError({
      code: 'vault_decrypt_failed',
      message: 'secret blob must be a string',
    })
  }
  const parts = blob.split('$')
  if (parts.length !== 4) {
    throw new IdentityError({
      code: 'vault_decrypt_failed',
      message: 'malformed vault secret blob (expected 4 $-separated parts)',
    })
  }
  // `noUncheckedIndexedAccess` makes destructured-array elements
  // `string | undefined`. We just length-gated above, so the assertion
  // is sound; the explicit tuple type keeps TS happy.
  const [version, nonceB64, ctB64, tagB64] = parts as [
    string,
    string,
    string,
    string,
  ]
  if (version !== ENC_VERSION) {
    throw new IdentityError({
      code: 'vault_decrypt_failed',
      message: `unsupported vault secret version: ${version}`,
    })
  }
  let nonce: Buffer
  let ct: Buffer
  let tag: Buffer
  try {
    nonce = Buffer.from(nonceB64, 'base64url')
    ct = Buffer.from(ctB64, 'base64url')
    tag = Buffer.from(tagB64, 'base64url')
  } catch (err) {
    throw new IdentityError({
      code: 'vault_decrypt_failed',
      message: 'malformed base64url in vault secret blob',
      cause: err,
    })
  }
  if (nonce.length !== NONCE_LEN_BYTES) {
    throw new IdentityError({
      code: 'vault_decrypt_failed',
      message: `nonce length ${nonce.length} != ${NONCE_LEN_BYTES}`,
    })
  }
  if (tag.length !== AUTH_TAG_LEN_BYTES) {
    throw new IdentityError({
      code: 'vault_decrypt_failed',
      message: `auth tag length ${tag.length} != ${AUTH_TAG_LEN_BYTES}`,
    })
  }
  const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce)
  decipher.setAuthTag(tag)
  let plaintext: Buffer
  try {
    plaintext = Buffer.concat([decipher.update(ct), decipher.final()])
  } catch (err) {
    // GCM auth tag mismatch surfaces as a plain Error here. Wrap so the
    // caller has a stable code to switch on.
    throw new IdentityError({
      code: 'vault_decrypt_failed',
      message:
        'authentication tag mismatch (corrupted ciphertext or wrong master key)',
      cause: err,
    })
  }
  return plaintext.toString('utf8')
}

function assertKey(masterKey: Buffer): void {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== KEY_LEN_BYTES) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `masterKey must be a ${KEY_LEN_BYTES}-byte Buffer; got ${
        Buffer.isBuffer(masterKey) ? `${masterKey.length} bytes` : typeof masterKey
      }`,
    })
  }
}
