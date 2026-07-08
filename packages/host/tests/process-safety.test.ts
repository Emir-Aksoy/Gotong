/**
 * Audit P1 — the global unhandledRejection net logs (keeps the host alive)
 * instead of letting Node's default terminate the process. We test the pure
 * handler so there's no global process-state pollution across tests.
 */

import { describe, expect, it } from 'vitest'

import { unhandledRejectionHandler, type ProcessSafetyLogger } from '../src/process-safety.js'

function captureLogger(): { errs: Array<{ msg: string; meta?: Record<string, unknown> }>; log: ProcessSafetyLogger } {
  const errs: Array<{ msg: string; meta?: Record<string, unknown> }> = []
  return { errs, log: { error: (msg, meta) => errs.push({ msg, ...(meta ? { meta } : {}) }) } }
}

describe('unhandledRejectionHandler', () => {
  it('logs an Error reason with its message + stack (kept alive, not rethrown)', () => {
    const { errs, log } = captureLogger()
    // The handler must NOT throw — that would re-trigger the crash it prevents.
    expect(() => unhandledRejectionHandler(log)(new Error('boom'))).not.toThrow()
    expect(errs).toHaveLength(1)
    expect(errs[0]!.msg).toContain('unhandledRejection')
    expect(errs[0]!.meta!.err).toBe('boom')
    expect(String(errs[0]!.meta!.stack)).toContain('boom')
  })

  it('logs a non-Error reason as a string (no stack)', () => {
    const { errs, log } = captureLogger()
    unhandledRejectionHandler(log)('just a string reason')
    expect(errs[0]!.meta!.err).toBe('just a string reason')
    expect(errs[0]!.meta!.stack).toBeUndefined()
  })
})
