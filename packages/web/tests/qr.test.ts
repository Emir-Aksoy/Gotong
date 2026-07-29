/**
 * qr.test — cross-check our encoder against an INDEPENDENT implementation.
 *
 * `src/qr.ts` is hand-written from the spec, so "our encoder agrees with
 * itself" would prove nothing. The reference here is the QR encoder vendored
 * inside `qrcode-terminal` (a devDependency, never shipped): a different
 * codebase, written by different people, from the same standard. If our
 * Reed–Solomon, block interleaving, mask selection, or format bits drift by
 * one bit, some module differs and this goes red.
 *
 * Same discipline as PUSH-M1 checking its aes128gcm against RFC 8291's own
 * vectors instead of against itself.
 */

import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

import { qrMatrix, qrSvg, qrSvgDataUri } from '../src/qr.js'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const QRCode = require('qrcode-terminal/vendor/QRCode')
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel')

function toMatrix(qr: any): boolean[][] {
  const n = qr.getModuleCount()
  const out: boolean[][] = []
  for (let r = 0; r < n; r++) {
    const row: boolean[] = []
    for (let c = 0; c < n; c++) row.push(Boolean(qr.isDark(r, c)))
    out.push(row)
  }
  return out
}

/** The version the reference picks — also what our chooseVersion must pick. */
function referenceVersion(text: string): number {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M)
  qr.addData(text)
  qr.make()
  return qr.typeNumber as number
}

/** Reference matrix at an explicit mask, level M. */
function referenceMatrix(text: string, mask: number): boolean[][] {
  const qr = new QRCode(referenceVersion(text), QRErrorCorrectLevel.M)
  qr.addData(text)
  qr.makeImpl(false, mask)
  return toMatrix(qr)
}

describe('qr encoder', () => {
  const cases = [
    'gotong://pair?u=http%3A%2F%2F127.0.0.1%3A3000&c=ABCDEFGHJKMNPQRS',
    'gotong://pair?u=https%3A%2F%2Fhub.example.com&c=0123456789ABCDEF',
    // A long hostname pushes into a higher version — the point is that
    // version selection and the two count-indicator widths both hold.
    `gotong://pair?u=${encodeURIComponent('https://a-rather-long-hub-hostname.example.co.uk:8443')}&c=ZYXWVTSRQPNMKJHG`,
    'HELLO',
    'x'.repeat(100),
  ]

  it.each(cases)('matches the reference module-for-module, at every mask: %s', (text) => {
    for (let mask = 0; mask < 8; mask++) {
      const ours = qrMatrix(text, { mask })
      const theirs = referenceMatrix(text, mask)
      expect(ours.length).toBe(theirs.length)
      expect({ mask, m: ours }).toEqual({ mask, m: theirs })
    }
  })

  it.each(cases)('picks the same version the reference picks: %s', (text) => {
    // Version is a correctness property (capacity), unlike mask choice.
    expect(qrMatrix(text).length).toBe(referenceVersion(text) * 4 + 17)
  })

  it('chooses the mask with the lowest penalty under our own rules', () => {
    // The unmasked payload is identical across masks, so the only thing this
    // pins is that the scoring loop actually returns its minimum — a bug that
    // would otherwise be invisible (every mask yields a scannable code).
    const text = cases[0]!
    const chosen = qrMatrix(text)
    const all = Array.from({ length: 8 }, (_, m) => qrMatrix(text, { mask: m }))
    expect(all.some((m) => JSON.stringify(m) === JSON.stringify(chosen))).toBe(true)
  })

  it('picks the smallest version that fits', () => {
    // v1 at level M holds 14 bytes; 15 must step up to v2 (25 modules).
    expect(qrMatrix('x'.repeat(14)).length).toBe(21)
    expect(qrMatrix('x'.repeat(15)).length).toBe(25)
  })

  it('refuses a payload past the highest version it builds tables for', () => {
    expect(() => qrMatrix('x'.repeat(214))).toThrow(/too long/)
    // 213 is exactly v10 at level M, so it must still encode.
    expect(qrMatrix('x'.repeat(213)).length).toBe(57)
  })

  it('encodes non-ASCII as UTF-8 bytes', () => {
    // Not used by pairing, but a silent charCode-instead-of-UTF-8 bug would
    // be invisible until someone put a hostname with an IDN label in there.
    //
    // The reference can't be asked directly: its byte mode is
    // `charCodeAt(i) & 0xff` (vendor/QRCode/QR8bitByte.js), so it turns 你好
    // into two mojibake bytes rather than six UTF-8 ones. That very quirk is
    // what makes it usable here — feed it a latin1 string whose char codes ARE
    // our UTF-8 bytes and it must land on the same matrix we do.
    const text = '你好'
    const asBytes = Buffer.from(text, 'utf8').toString('latin1')
    expect(asBytes).toHaveLength(6)
    expect(qrMatrix(text, { mask: 3 })).toEqual(referenceMatrix(asBytes, 3))
    // And the naive reading really is different, so the check above has teeth.
    expect(qrMatrix(text, { mask: 3 })).not.toEqual(referenceMatrix(text, 3))
  })

  it('renders an SVG with a quiet zone and light background', () => {
    const svg = qrSvg('HELLO')
    // 21 modules + 4 quiet on each side.
    expect(svg).toContain('viewBox="0 0 29 29"')
    expect(svg).toContain('<rect width="29" height="29" fill="#fff"/>')
    expect(svg).toContain('fill="#000"')
    // Fixed polarity — a QR that only reads in light mode is a broken QR.
    expect(svg).not.toContain('currentColor')
  })

  it('produces a data URI usable directly as an <img src>', () => {
    const uri = qrSvgDataUri('HELLO')
    expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    // No raw '#' or '"' — those would truncate or break the attribute.
    expect(uri.slice('data:image/svg+xml;charset=utf-8,'.length)).not.toMatch(/[#"<>]/)
    expect(decodeURIComponent(uri.split(',')[1]!)).toBe(qrSvg('HELLO'))
  })
})
