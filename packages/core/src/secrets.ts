/**
 * Secrets-at-rest for the workspace (v2.1).
 *
 * Each provider's API key — and any per-agent override — is stored as
 * an AES-256-GCM ciphertext blob in `<space>/secrets.enc.json`. The
 * master key lives separately at `<space>/runtime/secret.key`
 * (0600-permissioned) so:
 *
 *   - `secrets.enc.json` can be in your space's regular backup
 *     (transcript + agents.json + this) and the backup, on its own, is
 *     useless without the master key.
 *   - `runtime/secret.key` is excluded from backup (the convention is
 *     "runtime/ is machine-local state"). If the box dies, the secrets
 *     stay encrypted forever. That's a feature, not a bug: it forces a
 *     deliberate re-entry on a new machine rather than silently rolling
 *     production keys onto a fresh host.
 *
 * Operators with paranoia (or a real KMS) can override the on-disk key
 * with the `AIPE_SECRET_KEY` environment variable (64 hex chars = 32
 * bytes). That path is read every spawn — no caching — so a key
 * rotation is just a host restart with the new env value.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

const AES_ALGORITHM = 'aes-256-gcm' as const
const IV_BYTES = 12          // GCM standard
const KEY_BYTES = 32         // AES-256

export interface EncryptedSecret {
  /** AES-GCM IV, base64 (12 bytes). */
  iv: string
  /** AES-GCM ciphertext, base64. */
  ciphertext: string
  /** AES-GCM authentication tag, base64 (16 bytes). */
  authTag: string
  /** ISO timestamp of the last write — diagnostic only, not crypto-critical. */
  updatedAt: string
}

/**
 * Encrypt a plaintext string into an `EncryptedSecret`. The master key
 * must be exactly 32 bytes (AES-256). A fresh 12-byte IV is generated
 * per call — never reuse one with the same key.
 */
export function encryptSecret(masterKey: Buffer, plaintext: string): EncryptedSecret {
  if (masterKey.length !== KEY_BYTES) {
    throw new Error(`encryptSecret: master key must be ${KEY_BYTES} bytes, got ${masterKey.length}`)
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(AES_ALGORITHM, masterKey, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return {
    iv: iv.toString('base64'),
    ciphertext: ct.toString('base64'),
    authTag: authTag.toString('base64'),
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Decrypt an `EncryptedSecret`. Throws if the tag check fails (data
 * tampering) or the key is wrong. Both produce the same error class to
 * avoid leaking which case happened — a small but free side-channel
 * win.
 */
export function decryptSecret(masterKey: Buffer, enc: EncryptedSecret): string {
  if (masterKey.length !== KEY_BYTES) {
    throw new Error(`decryptSecret: master key must be ${KEY_BYTES} bytes, got ${masterKey.length}`)
  }
  const iv = Buffer.from(enc.iv, 'base64')
  const ct = Buffer.from(enc.ciphertext, 'base64')
  const authTag = Buffer.from(enc.authTag, 'base64')
  const decipher = createDecipheriv(AES_ALGORITHM, masterKey, iv)
  decipher.setAuthTag(authTag)
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return pt.toString('utf8')
  } catch {
    // Either wrong key or tampered ciphertext — same error to caller.
    throw new Error('decryptSecret: cannot decrypt (wrong key or corrupted data)')
  }
}

/**
 * Resolve the master key for this host run, in priority order:
 *
 *   1. `AIPE_SECRET_KEY` env var (64 hex chars / 32 bytes) — preferred
 *      in deployments where the key is mounted as a secret.
 *   2. `<keyPath>` on disk — preferred in single-machine setups.
 *   3. Generate a random 32-byte key, write it to `<keyPath>` with mode
 *      0600, and return it. Subsequent boots use path 2.
 *
 * The file write is best-effort `chmod 0600`; on filesystems that don't
 * honour POSIX modes (e.g. exFAT, some network mounts) the chmod
 * silently no-ops. Operators in those environments should set
 * `AIPE_SECRET_KEY` and not rely on the file mode.
 */
export async function loadOrCreateMasterKey(keyPath: string): Promise<Buffer> {
  const env = process.env.AIPE_SECRET_KEY
  if (env) {
    const buf = Buffer.from(env, 'hex')
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `AIPE_SECRET_KEY must be ${KEY_BYTES * 2} hex chars (${KEY_BYTES} bytes); got ${env.length} chars`,
      )
    }
    return buf
  }
  if (existsSync(keyPath)) {
    const hex = (await readFile(keyPath, 'utf8')).trim()
    const buf = Buffer.from(hex, 'hex')
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `master key at '${keyPath}' is not ${KEY_BYTES} bytes (got ${buf.length}); delete it to regenerate`,
      )
    }
    return buf
  }
  const fresh = randomBytes(KEY_BYTES)
  await mkdir(dirname(keyPath), { recursive: true })
  // `mode: 0o600` is honoured by writeFile **at file creation** on POSIX
  // — owner-only from the very first byte. Pre-3.4 we wrote with the
  // default umask (≈0o644) and immediately chmod-ed; that left a
  // microsecond-scale window where another local user could `open()` the
  // file for read. See AUDIT-v3.3.md finding H6.
  //
  // On Windows the mode bits aren't a security boundary (NTFS ACLs are);
  // writeFile honours the option without error and the resulting file
  // mode is set per Node's POSIX-compat layer. No try/catch needed —
  // earlier `.catch(() => {})` silently swallowed real failures on
  // exFAT / SMB shares, which we now surface as a normal error.
  await writeFile(keyPath, fresh.toString('hex') + '\n', { encoding: 'utf8', mode: 0o600 })
  return fresh
}

/**
 * Disk shape of `<space>/secrets.enc.json`. Version is a hard integer
 * so a future major rewrite can refuse to load old files cleanly.
 */
export interface SecretsFile {
  version: 1
  /** Workspace-level provider keys: `{ anthropic: {...}, openai: {...} }`. */
  providers: Record<string, EncryptedSecret>
  /** Per-agent overrides keyed by agent id. */
  agents: Record<string, EncryptedSecret>
}

export const SECRETS_FILE_VERSION = 1

export function emptySecretsFile(): SecretsFile {
  return { version: SECRETS_FILE_VERSION, providers: {}, agents: {} }
}
