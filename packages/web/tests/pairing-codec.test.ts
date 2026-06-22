import { describe, it, expect } from 'vitest'
import { encodePairCode, decodePairCode, PairCodeError } from '../src/pairing-codec.js'

describe('pairing-codec (ease-of-use ④-M1)', () => {
  const sample = {
    peerId: 'hub_a1b2c3d4',
    endpoint: 'wss://partner.example.com:4000',
    // 256-bit base64url token, the shape `aipehub mint-peer-token` emits.
    token: 'qC8kZ3mN7pR2vT5wX9bD1fH4jL6sU0aE-Cg_iK2mO4q',
  }

  it('round-trips peerId / endpoint / token', () => {
    const code = encodePairCode(sample)
    expect(typeof code).toBe('string')
    expect(decodePairCode(code)).toEqual(sample)
  })

  it('emits a url-safe code (no +, /, = or whitespace)', () => {
    const code = encodePairCode(sample)
    expect(code).not.toMatch(/[+/=\s]/)
  })

  it('trims surrounding whitespace on encode and decode', () => {
    const code = encodePairCode({
      peerId: '  hub_x  ',
      endpoint: '  wss://x:4000  ',
      token: '  tok123  ',
    })
    expect(decodePairCode(`\n  ${code}  \n`)).toEqual({
      peerId: 'hub_x',
      endpoint: 'wss://x:4000',
      token: 'tok123',
    })
  })

  it('rejects a blank field on encode', () => {
    expect(() => encodePairCode({ ...sample, token: '   ' })).toThrow(PairCodeError)
    expect(() => encodePairCode({ ...sample, peerId: '' })).toThrow(PairCodeError)
  })

  it('rejects garbage / non-pairing-code strings on decode', () => {
    expect(() => decodePairCode('')).toThrow(PairCodeError)
    expect(() => decodePairCode('   ')).toThrow(PairCodeError)
    expect(() => decodePairCode('not-base64-json!!!')).toThrow(PairCodeError)
    // valid base64url of a non-object JSON value
    expect(() => decodePairCode(Buffer.from('"hello"').toString('base64url'))).toThrow(
      PairCodeError,
    )
  })

  it('rejects a missing field after decode', () => {
    const codeNoToken = Buffer.from(
      JSON.stringify({ v: 1, peerId: 'hub_x', endpoint: 'wss://x:4000' }),
    ).toString('base64url')
    expect(() => decodePairCode(codeNoToken)).toThrow(/missing/)
  })

  it('rejects an unknown version', () => {
    const futureCode = Buffer.from(
      JSON.stringify({ v: 99, peerId: 'hub_x', endpoint: 'wss://x:4000', token: 't' }),
    ).toString('base64url')
    expect(() => decodePairCode(futureCode)).toThrow(/version/)
  })
})
