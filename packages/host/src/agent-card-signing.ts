/**
 * A2A Agent Card signing — the host's FILE-BACKED signing key (STD-M1).
 *
 * The pure JWS/JCS/verify core moved to `@gotong/a2a` (STD-M2) so the CLI
 * `peer-card` verifier can share it without depending on this assembly layer.
 * What stays here is the one host-shaped piece: a P-256 signing key persisted
 * as a 0600 PKCS#8 PEM in `.gotong/`, mirroring `identity/crypto.ts`'s master
 * key. The pure primitives are re-exported below so existing host imports (and
 * the host tests) keep resolving from this module.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { ecThumbprint, es256Sign, type AgentCardSigner } from '@gotong/a2a'

// Re-export the pure A2A card-signature core so host code / tests that import
// from this module keep working after the STD-M2 extraction to @gotong/a2a.
export {
  jcsCanonicalize,
  signAgentCard,
  attachSignature,
  buildJwks,
  verifyAgentCardSignature,
  readCardSignatureHeader,
  ecThumbprint,
  es256Sign,
} from '@gotong/a2a'
export type {
  AgentCardSigner,
  AgentCardSignatureValue,
  SignedCard,
  SignAgentCardOpts,
  VerifyResult,
} from '@gotong/a2a'

/**
 * File-backed ES256 signer. Mirrors `loadOrCreateMasterKey`: a 0600 PKCS#8
 * PEM at `path`, generated on first use, never silently re-keyed. Loading
 * happens once (in the constructor); the host constructs this only when card
 * signing is enabled, so an unsigned host pays nothing.
 *
 * The env / KMS injection seams that `MasterKeyProvider` has are deliberately
 * NOT duplicated here yet — a signing key on a single-machine host is exactly
 * as secret as the `.sqlite` beside it, same as the master key's default. The
 * seam can be added the day a KMS-backed deployment needs it.
 */
export class FileAgentCardSigner implements AgentCardSigner {
  private readonly privateKey: KeyObject
  private readonly jwk: Record<string, unknown>
  private readonly thumbprint: string

  constructor(path: string) {
    this.privateKey = loadOrCreateSigningKey(path)
    const publicKey = createPublicKey(this.privateKey)
    this.jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
    this.thumbprint = ecThumbprint(this.jwk)
  }

  kid(): string {
    return this.thumbprint
  }

  publicJwk(): Record<string, unknown> {
    return { ...this.jwk }
  }

  sign(signingInput: Buffer): Buffer {
    return es256Sign(this.privateKey, signingInput)
  }
}

/**
 * Load the host's P-256 signing key from `path` (PKCS#8 PEM), generating a
 * fresh one on first run with mode 0600. A file that isn't a usable EC
 * private key throws immediately rather than silently re-keying — a rotated
 * key changes the kid, which peers may have pinned, so a silent swap would
 * erase that signal.
 */
export function loadOrCreateSigningKey(path: string): KeyObject {
  if (existsSync(path)) {
    let key: KeyObject
    try {
      key = createPrivateKey(readFileSync(path, 'utf8'))
    } catch (err) {
      throw new Error(`agent-card signing key at ${path} is not a valid private key: ${String(err)}`)
    }
    if (key.asymmetricKeyType !== 'ec') {
      throw new Error(`agent-card signing key at ${path} must be an EC (P-256) key, got ${key.asymmetricKeyType}`)
    }
    return key
  }
  mkdirSync(dirname(path), { recursive: true })
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  writeFileSync(path, pem, { mode: 0o600 })
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600)
    } catch {
      // tolerate exFAT / SMB / sandboxed fs that reject chmod (same as crypto.ts)
    }
  }
  return privateKey
}
