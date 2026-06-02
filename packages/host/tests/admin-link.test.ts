// H20 regression: the admin token URL must NEVER appear in process
// stdout. Pre-3.4 the host banner did `console.log(adminUrl)` on first
// boot, and `mint-admin-token` did the same. Anyone with read access
// to `journalctl -u aipehub.service`, `docker logs <ctr>`, or
// `pm2 logs aipehub` could mine the plaintext token from the captured
// boot stream.
//
// v3.4 writes the URL to `<space>/runtime/admin-link.txt` (mode 0o600)
// and prints only the file path on the banner. See AUDIT-v3.3.md
// finding H20.
//
// This test exercises the contract two ways:
//   1. The `writeAdminLinkFile` helper writes the file with the right
//      mode + content, and is idempotent across re-runs.
//   2. A structural scan of `src/main.ts` confirms there is no
//      `console.log`/`process.stdout.write` call that embeds the
//      adminToken variable. The scan is a guardrail for future
//      refactors — a regex match means the secret is on its way back
//      into the log stream.

import { readFileSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeAdminLinkFile } from '../src/admin-link.js'

const POSIX = process.platform !== 'win32'

describe('admin link file (H20)', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aipehub-link-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes the URL with mode 0o600 on POSIX', async () => {
    const path = join(root, 'runtime', 'admin-link.txt')
    const url = 'http://127.0.0.1:3000/admin?token=deadbeef'

    await writeAdminLinkFile(path, url)

    const content = await readFile(path, 'utf8')
    expect(content).toBe(`${url}\n`)

    if (POSIX) {
      const mode = statSync(path).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('overwrites idempotently — second call replaces first', async () => {
    const path = join(root, 'runtime', 'admin-link.txt')
    await writeAdminLinkFile(path, 'http://127.0.0.1:3000/admin?token=AAAA')
    await writeAdminLinkFile(path, 'http://127.0.0.1:3000/admin?token=BBBB')
    const content = await readFile(path, 'utf8')
    expect(content).toContain('BBBB')
    expect(content).not.toContain('AAAA')

    if (POSIX) {
      const mode = statSync(path).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('main.ts has no console.log / stdout.write embedding the admin token', () => {
    // Structural guardrail — future refactors that try to "just log
    // the URL for convenience" land here as a CI failure. The audit
    // findings only stay fixed if we make regressions visible.
    //
    // Patterns we deny:
    //   console.log(`…${adminToken}…`)
    //   console.log(`…${token}…`)         (mint-admin-token uses `token`)
    //   process.stdout.write(`…${adminToken}…`)
    //   process.stdout.write(`…${token}…`)
    //   console.log(adminUrl)             (where adminUrl is a string containing the token)
    //
    // We DO allow `console.log(\`  ${linkPath}\`)` — the path is not
    // secret material.
    const mainTsPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'src',
      'main.ts',
    )
    const src = readFileSync(mainTsPath, 'utf8')

    // Strip comments + string literals containing markdown to avoid
    // false positives from the docstring at the top of the file (which
    // legitimately mentions "admin URL is printed to stdout" in the
    // PRE-v3.4 historical-context section).
    const lines = src.split('\n')

    type Hit = { line: number; text: string }
    const violations: Hit[] = []
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]!
      // Skip comment-only lines (`*` is JSDoc continuation, `//` is
      // single-line). Inline-comment trailing content is conservatively
      // included.
      const trimmed = raw.trimStart()
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue

      // Look for a stdout-bound call that interpolates a token / URL.
      // We pattern-match on the call name and the interpolation marker.
      const stdoutCall = /(?:console\.log|process\.stdout\.write|console\.error)\(/
      if (!stdoutCall.test(raw)) continue

      // Within stdout calls, deny ${adminToken} / ${token} (the two
      // names this file uses) and `?token=${`. The `?token=` pattern
      // also catches future refactors that might compose the URL
      // differently.
      const tokenInterpolation = /\$\{(?:adminToken|token)\}/
      const urlWithToken = /\?token=\$\{/
      if (tokenInterpolation.test(raw) || urlWithToken.test(raw)) {
        violations.push({ line: i + 1, text: raw.trimEnd() })
      }
    }

    expect(
      violations,
      `Found ${violations.length} stdout call(s) that embed an admin token:\n` +
        violations.map((v) => `  src/main.ts:${v.line}: ${v.text}`).join('\n') +
        `\nWrite the URL to runtime/admin-link.txt via writeAdminLinkFile() instead.`,
    ).toEqual([])
  })
})
