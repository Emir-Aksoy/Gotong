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
 * Where the master key comes from (Route B P0-M4a).
 *
 *   - `local-file`  The default, behaviour-identical path: a 0600 key file
 *                   in the workspace, created on first run. Right for a
 *                   single machine where the key is as secret as the db.
 *   - `env`         The key is injected as decoded material (e.g. a secret
 *                   mounted by Kubernetes / Docker / a secret manager into
 *                   an env var). Nothing is written to disk.
 *   - `kms-stub`    A reserved seam for a real KMS/HSM provider. The
 *                   interface is in place but `load()` throws — wiring a
 *                   cloud KMS is deferred (P2 / on demand), and a stub that
 *                   silently invented a key would be a security lie.
 */
export type MasterKeyProviderKind = 'local-file' | 'env' | 'kms-stub'

/**
 * Resolves the host's 32-byte master key. `load()` is sync to match the
 * existing boot path; it may have side effects (local-file creates the key
 * on first call). `describe()` returns a log-safe source label and MUST
 * NEVER include key bytes.
 */
export interface MasterKeyProvider {
  readonly kind: MasterKeyProviderKind
  load(): Buffer
  describe(): string
}

/** Default provider: the on-disk 0600 key file (unchanged behaviour). */
export class LocalFileMasterKeyProvider implements MasterKeyProvider {
  readonly kind = 'local-file' as const
  constructor(private readonly path: string) {}
  load(): Buffer {
    return loadOrCreateMasterKey(this.path)
  }
  describe(): string {
    return `local-file(${this.path})`
  }
}

/**
 * Key injected as encoded material (hex by default, base64 optional). The
 * material is decoded and length-checked on every `load()` — no disk, no
 * cache. Rotating the key is a restart with new env material.
 */
export class EnvMasterKeyProvider implements MasterKeyProvider {
  readonly kind = 'env' as const
  constructor(
    private readonly material: string,
    private readonly encoding: 'hex' | 'base64' = 'hex',
    private readonly sourceLabel = 'env',
  ) {}
  load(): Buffer {
    return decodeMasterKeyMaterial(this.material, this.encoding)
  }
  describe(): string {
    return `env(${this.sourceLabel})`
  }
}

/**
 * Reserved KMS/HSM seam. `load()` fails closed with an actionable message
 * rather than returning a key — there is no real implementation yet, and
 * inventing one silently would be worse than refusing.
 */
export class KmsStubMasterKeyProvider implements MasterKeyProvider {
  readonly kind = 'kms-stub' as const
  load(): Buffer {
    throw new IdentityError({
      code: 'invalid_input',
      message:
        'master key provider "kms-stub" is a reserved interface with no ' +
        'implementation; set AIPE_MASTER_KEY_PROVIDER=local-file (default) ' +
        'or =env and supply AIPE_MASTER_KEY',
    })
  }
  describe(): string {
    return 'kms-stub(unimplemented)'
  }
}

/** Decode + length-check injected key material. Wrong length → throws. */
function decodeMasterKeyMaterial(material: string, encoding: 'hex' | 'base64'): Buffer {
  if (typeof material !== 'string') {
    throw new IdentityError({
      code: 'invalid_input',
      message: 'master key material must be a string',
    })
  }
  // Buffer.from with a bad charset does not throw — it silently drops
  // invalid bytes — so the length check below is the real gate.
  const buf = Buffer.from(material.trim(), encoding)
  if (buf.length !== KEY_LEN_BYTES) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `master key material must decode to ${KEY_LEN_BYTES} bytes (${
        encoding === 'hex' ? `${KEY_LEN_BYTES * 2} hex chars` : 'base64'
      }); got ${buf.length} bytes`,
    })
  }
  return buf
}

export interface ResolveMasterKeyProviderInput {
  /** AIPE_MASTER_KEY_PROVIDER — undefined/'' → 'local-file'. */
  kind?: string
  /** Key file path for the local-file provider. */
  localFilePath: string
  /** Injected material for the env provider (e.g. process.env.AIPE_MASTER_KEY). */
  envKeyMaterial?: string
  /** Encoding of `envKeyMaterial`; default 'hex'. */
  envKeyEncoding?: 'hex' | 'base64'
}

/**
 * Pick a `MasterKeyProvider` from config. The default (no kind) is
 * `local-file`, so an unconfigured host behaves exactly as before.
 */
export function resolveMasterKeyProvider(
  input: ResolveMasterKeyProviderInput,
): MasterKeyProvider {
  const kind = (input.kind ?? '').trim().toLowerCase()
  switch (kind) {
    case '':
    case 'local-file':
      return new LocalFileMasterKeyProvider(input.localFilePath)
    case 'env':
      if (!input.envKeyMaterial) {
        throw new IdentityError({
          code: 'invalid_input',
          message:
            'AIPE_MASTER_KEY_PROVIDER=env requires AIPE_MASTER_KEY (the ' +
            '32-byte master key as hex)',
        })
      }
      return new EnvMasterKeyProvider(input.envKeyMaterial, input.envKeyEncoding ?? 'hex')
    case 'kms-stub':
      return new KmsStubMasterKeyProvider()
    default:
      throw new IdentityError({
        code: 'invalid_input',
        message: `unknown master key provider '${input.kind}' (expected local-file | env | kms-stub)`,
      })
  }
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

// ---- Envelope encryption (Route B P0-M4b) ----
//
// The master key (KEK) no longer encrypts vault secrets directly. A single
// 32-byte data key (DEK) encrypts every secret; the DEK is stored once,
// wrapped by the KEK. The point is rotation (M4c): swapping the KEK only
// re-wraps the DEK — the secret rows are never re-encrypted, so an O(1)
// operation rotates the key that protects an unbounded number of secrets.
//
// The threat model is unchanged. The wrapped DEK lives next to the data it
// protects (a row in the SQLite db), exactly as secret as the ciphertext
// beside it; without the KEK it can't be unwrapped, so reading the db
// without the key still yields nothing. The wrap blob reuses the same
// `v1.gcm$...` AEAD format — a DEK is just a 32-byte plaintext.

/** Generate a fresh 32-byte data key (DEK). */
export function generateDataKey(): Buffer {
  return randomBytes(KEY_LEN_BYTES)
}

/**
 * Wrap a DEK under the KEK → an on-disk blob (the vault_meta value).
 * A wrong-length KEK throws `invalid_input` here, BEFORE any secret rows
 * are touched, which is what keeps "a wrong-length master key surfaces on
 * the first vault call" true after the envelope change.
 */
export function wrapDataKey(masterKey: Buffer, dek: Buffer): string {
  assertKey(masterKey)
  assertKey(dek) // a DEK is itself a 32-byte key
  return encryptSecret(masterKey, dek.toString('base64'))
}

/**
 * Unwrap a DEK previously produced by `wrapDataKey`. A wrong KEK (or a
 * tampered blob) throws `vault_decrypt_failed` — the same code the vault
 * raised before, so callers that reopen with the wrong key see no new
 * error shape, only a new (earlier) failure point.
 */
export function unwrapDataKey(masterKey: Buffer, wrapped: string): Buffer {
  assertKey(masterKey)
  const dek = Buffer.from(decryptSecret(masterKey, wrapped), 'base64')
  if (dek.length !== KEY_LEN_BYTES) {
    throw new IdentityError({
      code: 'vault_decrypt_failed',
      message: `unwrapped data key has wrong length (${dek.length}, expected ${KEY_LEN_BYTES})`,
    })
  }
  return dek
}
