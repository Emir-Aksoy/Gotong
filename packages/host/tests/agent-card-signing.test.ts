/**
 * STD-M1 — Agent Card signing (JWS ES256 over the A2A discovery card).
 *
 * The load-bearing gate is the INDEPENDENT-VERIFIER ROUND-TRIP: we sign a
 * card, then verify it two ways — (a) our own `verifyAgentCardSignature`,
 * and (b) a from-scratch JWS check using ONLY `node:crypto` + the documented
 * algorithm (canonicalize → `protected.payload` → ES256 verify). If (b)
 * passes, an arbitrary A2A verifier that never touched our code reaches our
 * bytes — that's what "standards-aligned" has to mean. Plus: tampering any
 * field breaks it, canonicalization is deterministic, the kid is a stable
 * thumbprint, and an unsigned surface stays byte-for-byte as before.
 */

import { createPublicKey, createHash, verify as cryptoVerify } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { buildAgentCard, createAgentCardSurface, type AgentCard } from '../src/agent-card.js'
import {
  FileAgentCardSigner,
  buildJwks,
  jcsCanonicalize,
  signAgentCard,
  verifyAgentCardSignature,
} from '../src/agent-card-signing.js'

const tmp = mkdtempSync(join(tmpdir(), 'gotong-card-sign-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

let keyN = 0
const freshKeyPath = (): string => join(tmp, `signing-${keyN++}.key`)

const sampleCard = (): AgentCard =>
  buildAgentCard({
    name: '爸爸的 hub',
    version: '3.2.0',
    url: 'https://hub.example.com',
    description: '家里的常驻 hub',
    authSchemes: ['bearer'],
    skills: [{ id: 'dad-chat', name: '爸爸聊天' }],
  })

describe('jcsCanonicalize (RFC 8785, card shape)', () => {
  it('sorts object keys deeply and emits no whitespace', () => {
    expect(jcsCanonicalize({ b: 1, a: { d: true, c: 'x' } })).toBe('{"a":{"c":"x","d":true},"b":1}')
  })

  it('is order-independent (same object, different key order → same bytes)', () => {
    const a = jcsCanonicalize({ name: 'x', version: '1', url: 'u' })
    const b = jcsCanonicalize({ url: 'u', version: '1', name: 'x' })
    expect(a).toBe(b)
  })

  it('keeps array order and omits undefined members', () => {
    expect(jcsCanonicalize({ xs: ['b', 'a'], skip: undefined })).toBe('{"xs":["b","a"]}')
  })

  it('throws on a non-finite number rather than silently signing null', () => {
    expect(() => jcsCanonicalize({ n: Infinity })).toThrow(/non-finite/)
  })
})

describe('FileAgentCardSigner', () => {
  it('creates a 0600 PKCS#8 key on first use and a stable kid across reloads', () => {
    const path = freshKeyPath()
    const a = new FileAgentCardSigner(path)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toMatch(/BEGIN PRIVATE KEY/)
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
    // Reloading the same file yields the same public key → same thumbprint.
    const b = new FileAgentCardSigner(path)
    expect(b.kid()).toBe(a.kid())
    expect(a.kid()).toMatch(/^[A-Za-z0-9_-]{43}$/) // base64url SHA-256, no padding
  })

  it('kid equals the RFC 7638 thumbprint of the public JWK', () => {
    const signer = new FileAgentCardSigner(freshKeyPath())
    const jwk = signer.publicJwk()
    const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`
    const expected = createHash('sha256').update(canonical, 'utf8').digest().toString('base64url')
    expect(signer.kid()).toBe(expected)
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256' })
  })

  it('rejects a file that is not a usable EC private key (no silent re-key)', () => {
    const path = freshKeyPath()
    writeFileSync(path, 'not a key')
    expect(() => new FileAgentCardSigner(path)).toThrow(/not a valid private key/)
  })
})

describe('signAgentCard + verify round-trip', () => {
  it('our verifier accepts a freshly signed card', () => {
    const signer = new FileAgentCardSigner(freshKeyPath())
    const card = { ...sampleCard(), signatures: [signAgentCard(sampleCard(), signer, { jku: 'https://hub.example.com/.well-known/jwks.json' })] }
    expect(verifyAgentCardSignature(card, buildJwks(signer))).toEqual({ ok: true })
  })

  it('an INDEPENDENT node:crypto verifier reaches the same bytes (spec interop)', () => {
    const signer = new FileAgentCardSigner(freshKeyPath())
    const base = sampleCard()
    const sig = signAgentCard(base, signer)

    // Rebuild the JWS signing input from scratch, using only the spec:
    // ASCII(BASE64URL(protected) '.' BASE64URL(JCS(card without signatures))).
    const header = JSON.parse(Buffer.from(sig.protected, 'base64url').toString('utf8'))
    expect(header).toMatchObject({ alg: 'ES256', typ: 'JOSE' })
    expect(header.kid).toBe(signer.kid())

    const payloadB64 = Buffer.from(jcsCanonicalize(base), 'utf8').toString('base64url')
    const signingInput = Buffer.from(`${sig.protected}.${payloadB64}`, 'ascii')

    // Resolve the public key straight from the JWKS, as an outside client would.
    const jwks = JSON.parse(buildJwks(signer)) as { keys: import('node:crypto').JsonWebKey[] }
    const pub = createPublicKey({ key: jwks.keys[0]!, format: 'jwk' })
    const ok = cryptoVerify(
      'sha256',
      signingInput,
      { key: pub, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig.signature, 'base64url'),
    )
    expect(ok).toBe(true)
  })

  it('the signature covers the card MINUS its own signatures field', () => {
    const signer = new FileAgentCardSigner(freshKeyPath())
    const bare = sampleCard()
    // Sign while NO signatures field exists, then attach it. If the payload
    // included `signatures`, this pre-attachment signature would stop
    // verifying the moment the field appears. It still verifies → excluded.
    // (ES256 is randomized, so we assert via verify, never signature equality.)
    const card = { ...bare, signatures: [signAgentCard(bare, signer)] }
    expect(verifyAgentCardSignature(card, buildJwks(signer)).ok).toBe(true)
  })

  it('tampering ANY field breaks verification', () => {
    const signer = new FileAgentCardSigner(freshKeyPath())
    const card = { ...sampleCard(), signatures: [signAgentCard(sampleCard(), signer)] }
    expect(verifyAgentCardSignature(card, buildJwks(signer)).ok).toBe(true)

    const tampered = { ...card, name: '别人的 hub' }
    expect(verifyAgentCardSignature(tampered, buildJwks(signer)).ok).toBe(false)

    // A different key's JWKS must also fail (kid won't match / sig won't verify).
    const other = new FileAgentCardSigner(freshKeyPath())
    expect(verifyAgentCardSignature(card, buildJwks(other)).ok).toBe(false)
  })

  it('buildJwks emits a sig-use EC key carrying the kid', () => {
    const signer = new FileAgentCardSigner(freshKeyPath())
    const jwks = JSON.parse(buildJwks(signer)) as { keys: Array<Record<string, unknown>> }
    expect(jwks.keys).toHaveLength(1)
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', use: 'sig', alg: 'ES256', kid: signer.kid() })
    expect(typeof jwks.keys[0]!.x).toBe('string')
    expect(typeof jwks.keys[0]!.y).toBe('string')
  })
})

describe('createAgentCardSurface', () => {
  const baseDeps = {
    curationFile: join(tmp, 'no-such-curation.json'),
    nameFallback: 'My Hub',
    version: '3.2.0',
    description: 'a hub',
    hasPeerRegistry: true,
    advertiseSkills: false,
    enumerateSkills: () => [],
    log: { warn: () => {} },
  }

  it('unsigned (signer null): card has NO signatures and jwks() is null (byte-unchanged path)', () => {
    const surface = createAgentCardSurface({ ...baseDeps, signer: null })
    const card = JSON.parse(surface.json('https://h.example.com')) as AgentCard
    expect('signatures' in card).toBe(false)
    expect(surface.jwks()).toBeNull()
  })

  it('signed: served card verifies against the served JWKS, with request-derived jku', () => {
    const signer = new FileAgentCardSigner(freshKeyPath())
    const surface = createAgentCardSurface({ ...baseDeps, signer })
    const card = JSON.parse(surface.json('https://real.example.com')) as AgentCard
    const jwks = surface.jwks()
    expect(jwks).not.toBeNull()

    // The whole point: parse what we serve, verify it against what we serve.
    expect(verifyAgentCardSignature(card, jwks!)).toEqual({ ok: true })

    // jku reflects how the client reached us (request-derived base URL).
    const header = JSON.parse(Buffer.from(card.signatures![0]!.protected, 'base64url').toString('utf8'))
    expect(header.jku).toBe('https://real.example.com/.well-known/jwks.json')
  })
})
