/**
 * REAL-machine functional proof of the layer-2 OS kernel jail — the boundary the
 * pure builders only describe. We actually run `node -e <write>` wrapped under
 * the host's enforcer (`sandbox-exec` on macOS / `bwrap` on Linux) and assert:
 *   - a write INSIDE an allowed root succeeds, and
 *   - a write OUTSIDE every root is DENIED by the kernel (non-zero exit, no file).
 *
 * This is the JAIL-M3 deliverable that the unit tests (injected probe + lexical
 * builders) deliberately can't give: that the generated profile/argv really
 * confine a child on THIS machine. It self-skips when no enforcer is available
 * (`detectFsJail` → 'none'), so CI on a host without bubblewrap stays green
 * rather than failing for an environmental reason.
 *
 * The writable root + the forbidden target both live under a throwaway base in
 * the user's HOME (NOT /tmp or /var/folders — those are in MAC_ESSENTIAL_WRITABLE,
 * which would make a "forbidden" sibling writable and void the proof). HOME is
 * read-only under both enforcers, so only the explicitly-bound root is writable.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { detectFsJail, wrapWithFsJail } from '../src/index.js'

// Real probe (no injected platform/probe) — what THIS machine can actually do.
const cap = await detectFsJail({ noCache: true })

// One throwaway base under HOME; `root` is the only allowed-writable dir, `denied`
// is a sibling under HOME (read-only under the jail). Cleaned up in afterAll.
const base = mkdtempSync(join(homedir(), '.gotong-jail-real-'))
const root = join(base, 'root')
mkdirSync(root)
const okPath = join(root, 'ok.txt')
const deniedPath = join(base, 'denied.txt') // under base (HOME), NOT inside any root

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

/** `node -e <writeScript> <target>` — writes 'jailed' to argv[1], throws on EACCES/EROFS/EPERM. */
const WRITE_SCRIPT = "require('fs').writeFileSync(process.argv[1], 'jailed')"

/** Spawn `node` writing to `target`, wrapped under the detected enforcer. */
function jailedWrite(target: string): { status: number | null; stderr: string } {
  const wrapped = wrapWithFsJail({
    command: process.execPath,
    args: ['-e', WRITE_SCRIPT, target],
    allowedRoots: [root],
    cwd: root,
    kind: cap.kind,
  })
  const r = spawnSync(wrapped.command, wrapped.args, { cwd: root, encoding: 'utf8' })
  return { status: r.status, stderr: r.stderr ?? '' }
}

// Self-skip on a host with no OS kernel jail (e.g. Linux without bubblewrap).
const suite = cap.kind === 'none' ? describe.skip : describe

suite(`workspace-jail real enforcement (${cap.kind})`, () => {
  it('allows a write INSIDE an allowed root', () => {
    const r = jailedWrite(okPath)
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    expect(existsSync(okPath)).toBe(true)
  })

  it('DENIES a write OUTSIDE every root (kernel-enforced, not lexical)', () => {
    const r = jailedWrite(deniedPath)
    // The kernel refuses the write → node throws → non-zero exit, and crucially
    // the file is never created. (Lexical layer 1 would not catch this absolute
    // path either way — this proves layer 2 is the real perimeter.)
    expect(r.status).not.toBe(0)
    expect(existsSync(deniedPath)).toBe(false)
  })
})
