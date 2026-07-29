/**
 * qr.ts — a minimal QR encoder, byte mode, error-correction level M.
 *
 * SHELL-M1 needs a QR the member's phone can scan off the /me page: it
 * carries the hub address AND the one-time pairing code, which is what
 * makes "type a URL into a fresh app" disappear as a step.
 *
 * Why write one instead of taking a dependency:
 *   - it renders SERVER-side, so the SPA needs no encoder and no CDN (the
 *     app shell later runs under a strict CSP with no external hosts);
 *   - the payload contains a live credential, so the fewer third-party
 *     code paths it passes through the better;
 *   - the spec surface we need is small: one mode, one EC level, versions
 *     1–10. Everything below is ISO/IEC 18004, no invention.
 *
 * The correctness argument is NOT "it looks like a QR code". `tests/qr.test.ts`
 * builds the same matrices with an independent implementation (the encoder
 * vendored inside `qrcode-terminal`) and compares every module. Any drift in
 * Reed–Solomon, block interleaving, mask choice, or format bits shows up as a
 * differing pixel, the same way PUSH-M1 checks its crypto against the RFC's
 * own vectors rather than against itself.
 */

/** Highest version we build tables for. v10 at level M holds 213 bytes. */
const MAX_VERSION = 10

/**
 * Per version (index = version - 1), at EC level M:
 *   [ecCodewordsPerBlock, group1Blocks, group1DataCodewords, group2Blocks, group2DataCodewords]
 * Straight from the standard's block table.
 */
const EC_BLOCKS_M: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [10, 1, 16, 0, 0], // v1
  [16, 1, 28, 0, 0], // v2
  [26, 1, 44, 0, 0], // v3
  [18, 2, 32, 0, 0], // v4
  [24, 2, 43, 0, 0], // v5
  [16, 4, 27, 0, 0], // v6
  [18, 4, 31, 0, 0], // v7
  [22, 2, 38, 2, 39], // v8
  [22, 3, 36, 2, 37], // v9
  [26, 4, 43, 1, 44], // v10
]

/** Alignment-pattern centre coordinates per version (v1 has none). */
const ALIGNMENT_CENTRES: ReadonlyArray<readonly number[]> = [
  [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
]

/** Remainder bits appended after the interleaved codeword stream. */
function remainderBits(version: number): number {
  return version >= 2 && version <= 6 ? 7 : 0
}

// ---------------------------------------------------------------------------
// GF(256) — the field Reed–Solomon works in. Primitive polynomial 0x11d.
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a]! + LOG[b]!]!
}

/** Generator polynomial of degree `degree`, coefficients high-order first. */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1])
  for (let d = 0; d < degree; d++) {
    // poly *= (x + α^d). Coefficients stay high-order first, so multiplying
    // by x keeps the index and multiplying by α^d moves one index down.
    const next = new Uint8Array(poly.length + 1)
    for (let i = 0; i < poly.length; i++) {
      next[i] = (next[i]! ^ poly[i]!) & 0xff
      next[i + 1] = (next[i + 1]! ^ gfMul(poly[i]!, EXP[d]!)) & 0xff
    }
    poly = next
  }
  return poly
}

/** The `ecLen` error-correction codewords for one data block. */
function rsEncode(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsGenerator(ecLen)
  const rem = new Uint8Array(ecLen)
  for (const byte of data) {
    const factor = byte ^ rem[0]!
    rem.copyWithin(0, 1)
    rem[ecLen - 1] = 0
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i++) rem[i] = (rem[i]! ^ gfMul(gen[i + 1]!, factor)) & 0xff
    }
  }
  return rem
}

// ---------------------------------------------------------------------------
// Bit assembly
// ---------------------------------------------------------------------------

class BitBuffer {
  readonly bits: number[] = []
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1)
  }
}

/** Data codewords for `bytes` at `version`, padded to the version's capacity. */
function buildDataCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const [ecPerBlock, g1, g1Data, g2, g2Data] = EC_BLOCKS_M[version - 1]!
  const totalData = g1 * g1Data + g2 * g2Data

  const buf = new BitBuffer()
  buf.put(0b0100, 4) // byte mode
  buf.put(bytes.length, version >= 10 ? 16 : 8) // character count indicator
  for (const b of bytes) buf.put(b, 8)

  // Terminator (up to 4 zero bits), then pad to a byte boundary.
  const capacityBits = totalData * 8
  for (let i = 0; i < 4 && buf.bits.length < capacityBits; i++) buf.bits.push(0)
  while (buf.bits.length % 8 !== 0) buf.bits.push(0)

  const codewords = new Uint8Array(totalData)
  for (let i = 0; i < buf.bits.length; i += 8) {
    let v = 0
    for (let k = 0; k < 8; k++) v = (v << 1) | buf.bits[i + k]!
    codewords[i / 8] = v
  }
  // Pad bytes alternate 0xEC / 0x11 — the standard's filler, not a choice.
  for (let i = buf.bits.length / 8, alt = 0; i < totalData; i++, alt++) {
    codewords[i] = alt % 2 === 0 ? 0xec : 0x11
  }
  return codewords
}

/** Split into blocks, RS-encode each, and interleave data then EC. */
function interleave(dataCodewords: Uint8Array, version: number): Uint8Array {
  const [ecPerBlock, g1, g1Data, g2, g2Data] = EC_BLOCKS_M[version - 1]!
  const blocks: Uint8Array[] = []
  const ecBlocks: Uint8Array[] = []
  let offset = 0
  for (let i = 0; i < g1 + g2; i++) {
    const len = i < g1 ? g1Data : g2Data
    const block = dataCodewords.subarray(offset, offset + len)
    offset += len
    blocks.push(block)
    ecBlocks.push(rsEncode(block, ecPerBlock))
  }

  const out: number[] = []
  const maxData = Math.max(g1Data, g2Data)
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) if (i < block.length) out.push(block[i]!)
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const ec of ecBlocks) out.push(ec[i]!)
  }
  return Uint8Array.from(out)
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

/** -1 = free, 0 = light, 1 = dark. `reserved` marks function-pattern cells. */
interface Canvas {
  size: number
  modules: Int8Array
  reserved: Uint8Array
}

function newCanvas(version: number): Canvas {
  const size = version * 4 + 17
  return {
    size,
    modules: new Int8Array(size * size).fill(-1),
    reserved: new Uint8Array(size * size),
  }
}

function setFunction(c: Canvas, row: number, col: number, dark: boolean): void {
  c.modules[row * c.size + col] = dark ? 1 : 0
  c.reserved[row * c.size + col] = 1
}

function drawFinder(c: Canvas, row: number, col: number): void {
  // The 7×7 finder plus its one-module light separator. Coordinates outside
  // the matrix are simply skipped, which is how the separator works at edges.
  for (let r = -1; r <= 7; r++) {
    for (let cc = -1; cc <= 7; cc++) {
      const rr = row + r
      const c2 = col + cc
      if (rr < 0 || rr >= c.size || c2 < 0 || c2 >= c.size) continue
      const inRing = (r >= 0 && r <= 6 && (cc === 0 || cc === 6)) ||
        (cc >= 0 && cc <= 6 && (r === 0 || r === 6))
      const inCore = r >= 2 && r <= 4 && cc >= 2 && cc <= 4
      setFunction(c, rr, c2, inRing || inCore)
    }
  }
}

function drawFunctionPatterns(c: Canvas, version: number): void {
  drawFinder(c, 0, 0)
  drawFinder(c, 0, c.size - 7)
  drawFinder(c, c.size - 7, 0)

  // Timing patterns.
  for (let i = 8; i < c.size - 8; i++) {
    const dark = i % 2 === 0
    setFunction(c, 6, i, dark)
    setFunction(c, i, 6, dark)
  }

  // Alignment patterns, except where they would collide with a finder.
  const centres = ALIGNMENT_CENTRES[version - 1]!
  for (const r of centres) {
    for (const col of centres) {
      const nearFinder =
        (r === 6 && col === 6) ||
        (r === 6 && col === c.size - 7) ||
        (r === c.size - 7 && col === 6)
      if (nearFinder) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1
          setFunction(c, r + dr, col + dc, dark)
        }
      }
    }
  }

  // Always-dark module.
  setFunction(c, c.size - 8, 8, true)

  // Reserve the format-info strips (values written after masking).
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      c.reserved[8 * c.size + i] = 1
      c.reserved[i * c.size + 8] = 1
    }
  }
  for (let i = 0; i < 8; i++) {
    c.reserved[8 * c.size + (c.size - 1 - i)] = 1
    c.reserved[(c.size - 1 - i) * c.size + 8] = 1
  }

  if (version >= 7) {
    const info = versionInfoBits(version)
    for (let i = 0; i < 18; i++) {
      const dark = ((info >> i) & 1) === 1
      const a = Math.floor(i / 3)
      const b = (i % 3) + c.size - 11
      setFunction(c, b, a, dark)
      setFunction(c, a, b, dark)
    }
  }
}

/** 18-bit version information with its BCH(18,6) check bits. */
function versionInfoBits(version: number): number {
  let d = version << 12
  for (let i = 0; i < 6; i++) {
    if (d >>> (17 - i) & 1) d ^= 0x1f25 << (5 - i)
  }
  return (version << 12) | d
}

/** 15-bit format information for EC level M and the given mask. */
function formatInfoBits(mask: number): number {
  // Level M is 0b00 in the format table.
  const data = (0b00 << 3) | mask
  let d = data << 10
  for (let i = 0; i < 5; i++) {
    if (d >>> (14 - i) & 1) d ^= 0x537 << (4 - i)
  }
  return ((data << 10) | d) ^ 0b101010000010010
}

function drawFormatInfo(c: Canvas, mask: number): void {
  const bits = formatInfoBits(mask)
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1
    // Copy 1 — around the top-left finder.
    if (i < 6) setFunction(c, i, 8, dark)
    else if (i < 8) setFunction(c, i + 1, 8, dark)
    else if (i === 8) setFunction(c, 8, 7, dark)
    else setFunction(c, 8, 14 - i, dark)
    // Copy 2 — split across the other two finders.
    if (i < 8) setFunction(c, 8, c.size - 1 - i, dark)
    else setFunction(c, c.size - 15 + i, 8, dark)
  }
}

/** Zig-zag the codeword stream into the free cells, right to left. */
function placeCodewords(c: Canvas, stream: Uint8Array, version: number): void {
  const bits: number[] = []
  for (const byte of stream) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1)
  for (let i = 0; i < remainderBits(version); i++) bits.push(0)

  let bit = 0
  let upward = true
  for (let right = c.size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern; the pairs step around it.
    if (right === 6) right = 5
    for (let step = 0; step < c.size; step++) {
      const row = upward ? c.size - 1 - step : step
      for (const col of [right, right - 1]) {
        if (c.reserved[row * c.size + col]) continue
        c.modules[row * c.size + col] = bit < bits.length ? bits[bit]! : 0
        bit++
      }
    }
    upward = !upward
  }
}

function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0
    case 1: return row % 2 === 0
    case 2: return col % 3 === 0
    case 3: return (row + col) % 3 === 0
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
  }
}

function applyMask(c: Canvas, mask: number): void {
  for (let row = 0; row < c.size; row++) {
    for (let col = 0; col < c.size; col++) {
      const i = row * c.size + col
      if (c.reserved[i]) continue
      if (maskBit(mask, row, col)) c.modules[i] = (c.modules[i]! ^ 1) & 1
    }
  }
}

/** The standard's four penalty rules; lowest total wins. */
function penalty(c: Canvas): number {
  const n = c.size
  const at = (r: number, col: number): number => c.modules[r * n + col]!
  let score = 0

  // Rule 1 — runs of five or more.
  for (let i = 0; i < n; i++) {
    for (const byRow of [true, false]) {
      let run = 1
      for (let j = 1; j < n; j++) {
        const cur = byRow ? at(i, j) : at(j, i)
        const prev = byRow ? at(i, j - 1) : at(j - 1, i)
        if (cur === prev) {
          run++
          if (run === 5) score += 3
          else if (run > 5) score += 1
        } else run = 1
      }
    }
  }

  // Rule 2 — 2×2 blocks of one colour.
  for (let r = 0; r < n - 1; r++) {
    for (let col = 0; col < n - 1; col++) {
      const v = at(r, col)
      if (v === at(r, col + 1) && v === at(r + 1, col) && v === at(r + 1, col + 1)) score += 3
    }
  }

  // Rule 3 — finder-lookalike sequences.
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
  const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
  for (let i = 0; i < n; i++) {
    for (let j = 0; j + 11 <= n; j++) {
      let rowHit1 = true, rowHit2 = true, colHit1 = true, colHit2 = true
      for (let k = 0; k < 11; k++) {
        const rv = at(i, j + k)
        const cv = at(j + k, i)
        if (rv !== p1[k]) rowHit1 = false
        if (rv !== p2[k]) rowHit2 = false
        if (cv !== p1[k]) colHit1 = false
        if (cv !== p2[k]) colHit2 = false
      }
      if (rowHit1) score += 40
      if (rowHit2) score += 40
      if (colHit1) score += 40
      if (colHit2) score += 40
    }
  }

  // Rule 4 — deviation from an even light/dark split.
  let dark = 0
  for (let i = 0; i < n * n; i++) if (c.modules[i] === 1) dark++
  const percent = (dark * 100) / (n * n)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10
  return score
}

/** Smallest version at level M that holds `byteLength` bytes in byte mode. */
function chooseVersion(byteLength: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const [ecPerBlock, g1, g1Data, g2, g2Data] = EC_BLOCKS_M[v - 1]!
    const dataBits = (g1 * g1Data + g2 * g2Data) * 8
    const headerBits = 4 + (v >= 10 ? 16 : 8)
    if (headerBits + byteLength * 8 <= dataBits) return v
  }
  throw new Error(`qr: payload too long (${byteLength} bytes; max is version ${MAX_VERSION} at level M)`)
}

/**
 * Encode `text` and return the module matrix, `true` = dark. Rows are
 * top-to-bottom, columns left-to-right; no quiet zone (the renderer adds it).
 *
 * `opts.mask` forces a mask instead of scoring all eight. Production never
 * passes it; the cross-check test does, because mask CHOICE is a quality
 * heuristic rather than a correctness property — implementations disagree
 * about it legitimately (the reference we compare against scores rule 3 with
 * the older 7-module pattern, we use the standard's 11-module one). Comparing
 * mask-for-mask is the stronger check anyway: it pins the data encoding, the
 * Reed–Solomon, the interleaving, the placement, the format bits, and all
 * eight mask functions, and leaves out only the tie-break nobody's scanner
 * can tell apart.
 */
export function qrMatrix(text: string, opts: { mask?: number } = {}): boolean[][] {
  const bytes = new TextEncoder().encode(text)
  const version = chooseVersion(bytes.length)
  const stream = interleave(buildDataCodewords(bytes, version), version)

  const render = (mask: number): Canvas => {
    const c = newCanvas(version)
    drawFunctionPatterns(c, version)
    placeCodewords(c, stream, version)
    applyMask(c, mask)
    drawFormatInfo(c, mask)
    return c
  }

  let best: Canvas
  if (opts.mask !== undefined) {
    best = render(opts.mask)
  } else {
    best = render(0)
    let bestScore = penalty(best)
    for (let mask = 1; mask < 8; mask++) {
      const c = render(mask)
      const score = penalty(c)
      if (score < bestScore) {
        bestScore = score
        best = c
      }
    }
  }

  const c = best
  const out: boolean[][] = []
  for (let r = 0; r < c.size; r++) {
    const row: boolean[] = []
    for (let col = 0; col < c.size; col++) row.push(c.modules[r * c.size + col] === 1)
    out.push(row)
  }
  return out
}

/**
 * Render `text` as an SVG, sized in module units so the page can scale it
 * with CSS. Always light-background/dark-modules regardless of the viewer's
 * theme: a scanner needs the contrast in that polarity, and a QR that only
 * reads in light mode is a bug a member would experience as "it doesn't work".
 */
export function qrSvg(text: string, opts: { quietZone?: number } = {}): string {
  const quiet = opts.quietZone ?? 4
  const matrix = qrMatrix(text)
  const size = matrix.length + quiet * 2
  let path = ''
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (matrix[r]![c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `shape-rendering="crispEdges" role="img">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/>` +
    `</svg>`
  )
}

/** The same SVG as a data URI, ready for an `<img src>` (no innerHTML needed). */
export function qrSvgDataUri(text: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(text))}`
}
