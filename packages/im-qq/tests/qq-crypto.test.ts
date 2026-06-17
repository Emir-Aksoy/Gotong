/**
 * QQ official Ed25519 scheme — derive / sign / verify.
 *
 * Cross-checks the bridge's helpers against Node's own `sign`/`verify`
 * on the same keypair, so a regression in either direction (we sign
 * wrong / we verify wrong) is caught.
 */

import { sign as nodeSign, verify as nodeVerify } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  deriveQqKeyPair,
  deriveQqSeed,
  signQqCallback,
  verifyQqEventSignature,
} from '../src/qq-crypto.js'

const SECRET = 'test-bot-secret'

describe('deriveQqSeed', () => {
  it('repeats a short secret up to 32 bytes', () => {
    const seed = deriveQqSeed('abc') // 3 bytes → repeated
    expect(seed).toHaveLength(32)
    // First bytes are the secret, repeated.
    expect(seed.subarray(0, 3).toString('utf8')).toBe('abc')
    expect(seed.subarray(3, 6).toString('utf8')).toBe('abc')
  })

  it('truncates a secret longer than 32 bytes', () => {
    const long = 'x'.repeat(40)
    const seed = deriveQqSeed(long)
    expect(seed).toHaveLength(32)
    expect(seed.toString('utf8')).toBe('x'.repeat(32))
  })

  it('leaves an exactly-32-byte secret unchanged', () => {
    const exact = 'y'.repeat(32)
    expect(deriveQqSeed(exact).toString('utf8')).toBe(exact)
  })

  it('is deterministic for the same secret', () => {
    expect(deriveQqSeed(SECRET).equals(deriveQqSeed(SECRET))).toBe(true)
  })

  it('throws on an empty secret', () => {
    expect(() => deriveQqSeed('')).toThrow(/non-empty/)
  })
})

describe('deriveQqKeyPair', () => {
  it('produces an Ed25519 keypair', () => {
    const { privateKey, publicKey } = deriveQqKeyPair(SECRET)
    expect(privateKey.asymmetricKeyType).toBe('ed25519')
    expect(publicKey.asymmetricKeyType).toBe('ed25519')
  })

  it('is deterministic — same secret yields the same public key', () => {
    const a = deriveQqKeyPair(SECRET).publicKey.export({ format: 'der', type: 'spki' })
    const b = deriveQqKeyPair(SECRET).publicKey.export({ format: 'der', type: 'spki' })
    expect(Buffer.compare(a as Buffer, b as Buffer)).toBe(0)
  })

  it('different secrets yield different public keys', () => {
    const a = deriveQqKeyPair('one').publicKey.export({ format: 'der', type: 'spki' })
    const b = deriveQqKeyPair('two').publicKey.export({ format: 'der', type: 'spki' })
    expect(Buffer.compare(a as Buffer, b as Buffer)).not.toBe(0)
  })
})

describe('signQqCallback', () => {
  it('signs event_ts + plain_token verifiably with the public key', () => {
    const { privateKey, publicKey } = deriveQqKeyPair(SECRET)
    const eventTs = '1700000000'
    const plainToken = 'challenge-abc'
    const sigHex = signQqCallback(privateKey, eventTs, plainToken)
    // Hex string of a 64-byte Ed25519 signature → 128 hex chars.
    expect(sigHex).toMatch(/^[0-9a-f]{128}$/)
    const ok = nodeVerify(
      null,
      Buffer.from(eventTs + plainToken, 'utf8'),
      publicKey,
      Buffer.from(sigHex, 'hex'),
    )
    expect(ok).toBe(true)
  })

  it('binds the order — swapping ts/token does not verify', () => {
    const { privateKey, publicKey } = deriveQqKeyPair(SECRET)
    const sigHex = signQqCallback(privateKey, 'TS', 'TOKEN')
    const ok = nodeVerify(
      null,
      Buffer.from('TOKEN' + 'TS', 'utf8'), // swapped
      publicKey,
      Buffer.from(sigHex, 'hex'),
    )
    expect(ok).toBe(false)
  })
})

describe('verifyQqEventSignature', () => {
  const { privateKey, publicKey } = deriveQqKeyPair(SECRET)
  const timestamp = '1700000123'
  const rawBody = '{"op":0,"id":"EV1","t":"C2C_MESSAGE_CREATE","d":{}}'

  /** Produce the signature QQ would send for a given timestamp + body. */
  function signEvent(ts: string, body: string): string {
    return nodeSign(null, Buffer.from(ts + body, 'utf8'), privateKey).toString('hex')
  }

  it('accepts a correctly-signed event', () => {
    const signature = signEvent(timestamp, rawBody)
    expect(verifyQqEventSignature(publicKey, { signature, timestamp, rawBody })).toBe(true)
  })

  it('rejects a tampered body', () => {
    const signature = signEvent(timestamp, rawBody)
    expect(
      verifyQqEventSignature(publicKey, {
        signature,
        timestamp,
        rawBody: rawBody.replace('EV1', 'EV2'),
      }),
    ).toBe(false)
  })

  it('rejects a tampered timestamp', () => {
    const signature = signEvent(timestamp, rawBody)
    expect(
      verifyQqEventSignature(publicKey, { signature, timestamp: '1700000999', rawBody }),
    ).toBe(false)
  })

  it('rejects a signature of the wrong length without throwing', () => {
    expect(
      verifyQqEventSignature(publicKey, { signature: 'deadbeef', timestamp, rawBody }),
    ).toBe(false)
  })

  it('rejects non-hex / malformed signature input', () => {
    expect(
      verifyQqEventSignature(publicKey, { signature: 'zz'.repeat(64), timestamp, rawBody }),
    ).toBe(false)
  })

  it('returns false on non-string inputs rather than throwing', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(verifyQqEventSignature(publicKey, { signature: 123 as any, timestamp, rawBody })).toBe(
      false,
    )
  })
})
