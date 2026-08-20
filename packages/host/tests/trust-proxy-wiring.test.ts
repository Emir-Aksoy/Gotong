/**
 * `GOTONG_TRUST_PROXY` has to reach the web server, and this gate is here
 * because for a long time it did not.
 *
 * The knob answers one question — "is `x-forwarded-for` on this request
 * trustworthy, i.e. am I behind a reverse proxy I control?" — and four
 * different things depend on the answer: the admin login limiter, the device
 * `claim` limiter, the public `/setkey` link limiter, and the origin the A2A
 * agent card advertises. Every one of those lived in `serveWeb`, and `main.ts`
 * never passed the flag, so `opts.trustProxy ?? false` was permanently false.
 *
 * The consequence is not a missing feature, it is an inverted one: in the
 * official compose (Caddy in front, `GOTONG_TRUST_PROXY=1` set in the file
 * next to it) every web request buckets under the proxy container's single
 * address. One attacker's ten requests then rate-limit the whole hub — and
 * HANDS-M3b's design doc names that very limiter as what holds up a route
 * mounted ahead of the CSRF gate.
 *
 * A behavioural test cannot see this: `serveWeb` honours whatever it is given,
 * and `main()` is a process. The defect was in the wiring, so the gate is on
 * the wiring.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url))

describe('GOTONG_TRUST_PROXY reaches every consumer', () => {
  it('main.ts passes it into serveWeb', () => {
    const src = readFileSync(MAIN, 'utf8')
    const at = src.indexOf('await serveWeb(hub, {')
    expect(at, 'the serveWeb call moved — update this gate, do not delete it').toBeGreaterThan(0)
    // The options object literal, up to the line that closes it.
    const block = src.slice(at, src.indexOf('\n  })', at))
    expect(block).toContain('trustProxy:')
    expect(block).toContain("envBool('GOTONG_TRUST_PROXY'")
  })

  it('every reader of the knob agrees on the default', () => {
    // Fail-closed: an unset knob means "the address on the socket is the
    // client". A reader that defaulted the other way would trust a header
    // anybody can write.
    const src = readFileSync(MAIN, 'utf8')
    const readers = [...src.matchAll(/envBool\('GOTONG_TRUST_PROXY',\s*([a-z]+)\)/g)]
    expect(readers.length).toBeGreaterThan(0)
    for (const m of readers) expect(m[1]).toBe('false')
  })
})
