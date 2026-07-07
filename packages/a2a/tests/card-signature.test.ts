/**
 * STD — A2A Agent Card signing primitives (the pure JWS/JCS/verify core that
 * moved here from host so the CLI verifier can share it).
 *
 * The load-bearing gate is the INDEPENDENT-VERIFIER ROUND-TRIP: sign a card,
 * then verify it with ONLY `node:crypto` + the documented algorithm. If that
 * passes, an arbitrary A2A verifier that never touched our code reaches our
 * bytes — that's what "standards-aligned" has to mean. Plus: tampering any
 * field breaks it, canonicalization is deterministic, and the header decoder
 * (`readCardSignatureHeader`, which the CLI uses to find the JWKS) is honest.
 */

import { createHash, createPublicKey, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  attachSignature,
  buildJwks,
  ecThumbprint,
  es256Sign,
  jcsCanonicalize,
  readCardSignatureHeader,
  signAgentCard,
  verifyAgentCardSignature,
  verifyCardKidMatches,
  type AgentCardSigner,
} from '../src/card-signature.js'

/** An in-memory ES256 signer — proves the interface works with any impl. */
function makeSigner(): AgentCardSigner {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as Record<string, unknown>
  const thumb = ecThumbprint(jwk)
  return {
    kid: () => thumb,
    publicJwk: () => jwk,
    sign: (input: Buffer) => es256Sign(privateKey, input),
  }
}

const sampleCard = () => ({
  name: '爸爸的 hub',
  description: '家里的常驻 hub',
  version: '3.2.0',
  url: 'https://hub.example.com',
  supportedInterfaces: [{ url: 'https://hub.example.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '0.2' }],
  skills: [{ id: 'dad-chat', name: '爸爸聊天', description: '', tags: [] }],
})

describe('jcsCanonicalize (RFC 8785, card shape)', () => {
  it('sorts object keys deeply and emits no whitespace', () => {
    expect(jcsCanonicalize({ b: 1, a: { d: true, c: 'x' } })).toBe('{"a":{"c":"x","d":true},"b":1}')
  })

  it('is order-independent (same object, different key order → same bytes)', () => {
    expect(jcsCanonicalize({ name: 'x', version: '1', url: 'u' })).toBe(jcsCanonicalize({ url: 'u', version: '1', name: 'x' }))
  })

  it('keeps array order and omits undefined members', () => {
    expect(jcsCanonicalize({ xs: ['b', 'a'], skip: undefined })).toBe('{"xs":["b","a"]}')
  })

  it('throws on a non-finite number rather than silently signing null', () => {
    expect(() => jcsCanonicalize({ n: Infinity })).toThrow(/non-finite/)
  })
})

describe('sign + verify round-trip', () => {
  it('our verifier accepts a freshly signed card', () => {
    const signer = makeSigner()
    const card = attachSignature(sampleCard(), signer, { jku: 'https://hub.example.com/.well-known/jwks.json' })
    expect(verifyAgentCardSignature(card, buildJwks(signer))).toMatchObject({ ok: true })
  })

  it('an INDEPENDENT node:crypto verifier reaches the same bytes (spec interop)', () => {
    const signer = makeSigner()
    const base = sampleCard()
    const sig = signAgentCard(base, signer)

    // Rebuild the JWS signing input from scratch, using only the spec:
    // ASCII(BASE64URL(protected) '.' BASE64URL(JCS(card without signatures))).
    const header = JSON.parse(Buffer.from(sig.protected, 'base64url').toString('utf8'))
    expect(header).toMatchObject({ alg: 'ES256', typ: 'JOSE' })
    expect(header.kid).toBe(signer.kid())

    const payloadB64 = Buffer.from(jcsCanonicalize(base), 'utf8').toString('base64url')
    const signingInput = Buffer.from(`${sig.protected}.${payloadB64}`, 'ascii')
    const jwks = JSON.parse(buildJwks(signer)) as { keys: import('node:crypto').JsonWebKey[] }
    const pub = createPublicKey({ key: jwks.keys[0]!, format: 'jwk' })
    const ok = cryptoVerify('sha256', signingInput, { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig.signature, 'base64url'))
    expect(ok).toBe(true)
  })

  it('the signature covers the card MINUS its own signatures field', () => {
    // ES256 is randomized, so prove exclusion via verify, never sig equality.
    const signer = makeSigner()
    const card = attachSignature(sampleCard(), signer)
    expect(verifyAgentCardSignature(card, buildJwks(signer)).ok).toBe(true)
  })

  it('tampering ANY field breaks verification, and a foreign JWKS fails too', () => {
    const signer = makeSigner()
    const card = attachSignature(sampleCard(), signer)
    expect(verifyAgentCardSignature(card, buildJwks(signer)).ok).toBe(true)

    expect(verifyAgentCardSignature({ ...card, name: '别人的 hub' }, buildJwks(signer)).ok).toBe(false)
    expect(verifyAgentCardSignature(card, buildJwks(makeSigner())).ok).toBe(false)
  })

  it('reports a structured reason instead of throwing on garbage', () => {
    const signer = makeSigner()
    expect(verifyAgentCardSignature({}, buildJwks(signer))).toEqual({ ok: false, reason: 'no signature on card' })
    const card = attachSignature(sampleCard(), signer)
    expect(verifyAgentCardSignature(card, 'not json').ok).toBe(false)
  })

  it('buildJwks emits a sig-use EC key carrying the kid', () => {
    const signer = makeSigner()
    const jwks = JSON.parse(buildJwks(signer)) as { keys: Array<Record<string, unknown>> }
    expect(jwks.keys).toHaveLength(1)
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', use: 'sig', alg: 'ES256', kid: signer.kid() })
  })
})

describe('ecThumbprint (RFC 7638)', () => {
  it('is the SHA-256 over the canonical EC JWK members', () => {
    const signer = makeSigner()
    const jwk = signer.publicJwk()
    const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`
    expect(signer.kid()).toBe(createHash('sha256').update(canonical, 'utf8').digest().toString('base64url'))
    expect(signer.kid()).toMatch(/^[A-Za-z0-9_-]{43}$/) // base64url SHA-256, no padding
  })
})

describe('readCardSignatureHeader (consumer finds the JWKS)', () => {
  it('decodes the protected header (kid + jku) of a signed card', () => {
    const signer = makeSigner()
    const card = attachSignature(sampleCard(), signer, { jku: 'https://hub.example.com/.well-known/jwks.json' })
    const header = readCardSignatureHeader(card)
    expect(header).toMatchObject({ alg: 'ES256', kid: signer.kid(), jku: 'https://hub.example.com/.well-known/jwks.json' })
  })

  it('returns null for an unsigned card or an undecodable protected header', () => {
    expect(readCardSignatureHeader({})).toBeNull()
    expect(readCardSignatureHeader({ signatures: [{ protected: '!!!not-base64-json', signature: 'x' }] })).toBeNull()
  })
})

describe('verifyCardKidMatches (STD-M2b pin binding)', () => {
  it('success returns the RECOMPUTED key thumbprint (not just the header label)', () => {
    const signer = makeSigner()
    const card = attachSignature(sampleCard(), signer)
    const v = verifyAgentCardSignature(card, buildJwks(signer))
    expect(v.ok).toBe(true)
    expect(v.keyThumbprint).toBe(signer.kid())
  })

  it('match when pinned kid === verifying key; mismatch for a different pin', () => {
    const signer = makeSigner()
    const card = attachSignature(sampleCard(), signer)
    const jwks = buildJwks(signer)
    expect(verifyCardKidMatches(card, jwks, signer.kid())).toMatchObject({ status: 'match' })
    expect(verifyCardKidMatches(card, jwks, 'some-other-kid').status).toBe('mismatch')
  })

  it('unsigned card → unsigned; tampered card → mismatch (not a false match)', () => {
    const signer = makeSigner()
    expect(verifyCardKidMatches({}, buildJwks(signer), signer.kid())).toEqual({ status: 'unsigned' })
    const card = attachSignature(sampleCard(), signer)
    expect(verifyCardKidMatches({ ...card, name: 'tampered' }, buildJwks(signer), signer.kid()).status).toBe('mismatch')
  })

  it('binds the pin to the REAL key, not the header kid label (lying-JWKS defense)', () => {
    // Attacker signs the card WITH a forged victim kid in the protected header,
    // then serves a JWKS whose (attacker) key is LABELED with that victim kid.
    const attacker = makeSigner()
    const victimKid = 'A'.repeat(43) // plausible-looking, but NOT the attacker's thumbprint
    const base = sampleCard()
    const header = { alg: 'ES256', typ: 'JOSE', kid: victimKid }
    const protectedB64 = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url')
    const payloadB64 = Buffer.from(jcsCanonicalize(base), 'utf8').toString('base64url')
    const signature = attacker.sign(Buffer.from(`${protectedB64}.${payloadB64}`, 'ascii')).toString('base64url')
    const card = { ...base, signatures: [{ protected: protectedB64, signature }] }
    const jwks = JSON.stringify({ keys: [{ ...attacker.publicJwk(), kid: victimKid, use: 'sig', alg: 'ES256' }] })

    // The signature verifies (a real sig by the served key)...
    const v = verifyAgentCardSignature(card, jwks)
    expect(v.ok).toBe(true)
    // ...but the recomputed thumbprint is the ATTACKER's, not the forged label.
    expect(v.keyThumbprint).not.toBe(victimKid)
    // ...so pinning the victim kid correctly reports a mismatch, not a match.
    expect(verifyCardKidMatches(card, jwks, victimKid).status).toBe('mismatch')
  })
})
