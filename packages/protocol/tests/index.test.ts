/**
 * Smoke-test the package's public re-exports. The README + downstream
 * SDKs deep-import constants and frame types — a missing re-export is
 * a breaking change. Asserting on the runtime surface guards against
 * accidental drops during refactors.
 */

import { describe, expect, it } from 'vitest'

import * as protocol from '../src/index.js'

const expectedRuntimeExports = [
  // codec
  'decodeFrame',
  'encodeFrame',
  // constants
  'PROTOCOL_VERSION',
  'DEFAULT_HEARTBEAT_INTERVAL_MS',
  'HELLO_TIMEOUT_MS',
  'AWAIT_APPROVAL_TIMEOUT_MS',
  'MAX_MISSED_PINGS',
  'DEFAULT_SERVICE_CALL_TIMEOUT_MS',
  'BUILTIN_SERVICE_METHODS',
  // method-allowlist API
  'majorVersionOf',
  'registerServiceMethods',
  'unregisterServiceMethods',
  'getServiceMethods',
  'isServiceMethodAllowed',
  'resetServiceMethodsForTests',
]

describe('package surface', () => {
  for (const name of expectedRuntimeExports) {
    it(`exports \`${name}\``, () => {
      expect((protocol as Record<string, unknown>)[name]).toBeDefined()
    })
  }

  it('does not export an unexpectedly large surface', () => {
    // Soft canary — keeps the public surface from growing silently.
    // Bump the upper bound if you intentionally add a new export.
    const keys = Object.keys(protocol)
    expect(keys.length).toBeLessThan(40)
  })
})
