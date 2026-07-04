/**
 * V4-AUDIT-02 regression — identity.sqlite is created with mode 0o600.
 *
 * Without this, the file follows the process umask (typically 022 →
 * 0o644 world-readable) and the password / session tables become
 * readable to any local user. On a multi-tenant shared host this is
 * an account-takeover vulnerability.
 *
 * Test is POSIX-only because chmod / mode bits are Unix semantics.
 * On Windows we skip the assertion (the openDb implementation also
 * skips the chmod there).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openIdentityStore } from '../src/index.js'

const isPosix = process.platform !== 'win32'
const tmpDirs: string[] = []

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

describe('identity.sqlite file mode (V4-AUDIT-02)', () => {
  it.runIf(isPosix)('is created with mode 0o600 (owner-only)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gotong-id-mode-'))
    tmpDirs.push(dir)
    const path = join(dir, 'identity.sqlite')
    const store = openIdentityStore({ dbPath: path })
    try {
      const mode = statSync(path).mode & 0o777
      // 0o600 = rw-------. Strictly equal — we don't accept 0o644 etc.
      expect(mode).toBe(0o600)
    } finally {
      store.close()
    }
  })

  it.runIf(isPosix)('keeps mode 0o600 across a re-open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gotong-id-mode-reopen-'))
    tmpDirs.push(dir)
    const path = join(dir, 'identity.sqlite')
    openIdentityStore({ dbPath: path }).close()
    // Re-open — chmodSync runs again, must stay 0o600.
    const store = openIdentityStore({ dbPath: path })
    try {
      const mode = statSync(path).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      store.close()
    }
  })
})
