// C4 + H6 regression: every workspace file that contains token hashes,
// encrypted secrets, or session ids must be created with mode 0o600 on
// POSIX. Pre-3.4 these files were written with the process umask
// (typically 0o644), and another local user on the box could read both
// `secrets.enc.json` and the sibling `runtime/secret.key` — defeating
// the "encrypted-at-rest" assumption that the master key was beyond
// reach of a non-root attacker who got `read` on the workspace.
//
// Test strategy:
//   1. Init a fresh space → assert every sensitive file is 0o600 and
//      the root + runtime dirs are 0o700.
//   2. Open a workspace where the files were intentionally chmod'd
//      back to 0o644 → confirm `Space.open` re-hardens them
//      (migration path for pre-3.4 workspaces).
//   3. Write a secret via `setProviderApiKey` → confirm the post-write
//      mode is still 0o600 (not silently relaxed by the atomic
//      tmp+rename).
//   4. Write `secret.key` via the first secrets touch → confirm the
//      master key file is 0o600 with no race window (H6).
//
// Skipped wholesale on Windows: chmod is honoured by Node but the
// POSIX bits aren't a meaningful security boundary on NTFS.

import { statSync } from 'node:fs'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Space } from '../src/space.js'

const POSIX = process.platform !== 'win32'

describe.skipIf(!POSIX)('Space — file permission hardening (C4 + H6)', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-perm-'))
    // mkdtemp hands back an existing dir; remove and let init recreate
    await rm(root, { recursive: true, force: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** Lower 9 bits of the file mode — the chmod-meaningful portion. */
  const modeOf = (path: string): number => statSync(path).mode & 0o777

  it('Space.init creates sensitive files with mode 0o600 and dirs with 0o700', async () => {
    const { space } = await Space.init(root, {
      name: 'permtest',
      adminDisplayName: 'Operator',
    })

    // Workspace + runtime directories should be owner-only traversal.
    expect(modeOf(space.root)).toBe(0o700)
    expect(modeOf(join(space.root, 'runtime'))).toBe(0o700)

    // Sensitive files — token hashes, encrypted secrets, session ids.
    expect(modeOf(space.paths.admins)).toBe(0o600)
    expect(modeOf(space.paths.agents)).toBe(0o600)
    expect(modeOf(space.paths.workers)).toBe(0o600)
    expect(modeOf(space.paths.runtime.pendingApps)).toBe(0o600)
    expect(modeOf(space.paths.runtime.adminSessions)).toBe(0o600)
    expect(modeOf(space.paths.runtime.workerSessions)).toBe(0o600)

    // Master key — H6 — atomic-mode at file creation, no chmod race.
    // Created lazily on first secret touch; force it here.
    await space.setProviderApiKey('anthropic', 'sk-test-key')
    expect(modeOf(space.paths.runtime.secretKey)).toBe(0o600)
    expect(modeOf(space.paths.secrets)).toBe(0o600)
  })

  it('Space.open re-hardens a pre-3.4 workspace where files were 0o644', async () => {
    // Step 1: init normally — files come out 0o600.
    const { space: first } = await Space.init(root, {
      name: 'migrate',
      adminDisplayName: 'Operator',
    })
    await first.setProviderApiKey('anthropic', 'sk-pre-migration')

    // Step 2: simulate a pre-3.4 workspace where the files are
    // world-readable. This is the state a user upgrading from v3.3
    // would arrive at — the on-disk files survived the upgrade but
    // are still 0o644 because the old code never set the mode bits.
    const targets = [
      first.paths.admins,
      first.paths.agents,
      first.paths.workers,
      first.paths.secrets,
      first.paths.runtime.pendingApps,
      first.paths.runtime.adminSessions,
      first.paths.runtime.workerSessions,
      first.paths.runtime.secretKey,
    ]
    for (const p of targets) await chmod(p, 0o644)
    for (const p of targets) expect(modeOf(p)).toBe(0o644)

    // Step 3: Space.open triggers the idempotent harden sweep.
    const second = await Space.open(root)
    for (const p of targets) expect(modeOf(p)).toBe(0o600)
    // Sanity: the re-opened Space still works.
    const key = await second.getProviderApiKey('anthropic')
    expect(key).toBe('sk-pre-migration')
  })

  it('setProviderApiKey keeps secrets.enc.json at 0o600 after rewrite', async () => {
    const { space } = await Space.init(root, { name: 'rewrite' })
    await space.setProviderApiKey('anthropic', 'sk-first')
    expect(modeOf(space.paths.secrets)).toBe(0o600)
    // The second write goes through the atomic tmp+rename path —
    // verify the mode survives that.
    await space.setProviderApiKey('openai', 'sk-second')
    expect(modeOf(space.paths.secrets)).toBe(0o600)
  })

  it('createAdmin / removeAdmin preserves admins.json at 0o600', async () => {
    const { space } = await Space.init(root, { name: 'createadmin' })
    expect(modeOf(space.paths.admins)).toBe(0o600)
    const { admin } = await space.createAdmin('Alice')
    expect(modeOf(space.paths.admins)).toBe(0o600)
    await space.removeAdmin(admin.id)
    expect(modeOf(space.paths.admins)).toBe(0o600)
  })

  it('Space.open is idempotent — re-running does not flip permissions', async () => {
    const { space: first } = await Space.init(root, {
      name: 'idempotent',
      adminDisplayName: 'Operator',
    })
    await first.setProviderApiKey('anthropic', 'sk-x')
    const before = [
      modeOf(first.paths.admins),
      modeOf(first.paths.secrets),
      modeOf(first.paths.runtime.secretKey),
    ]
    // Open twice — neither call should regress the modes.
    await Space.open(root)
    await Space.open(root)
    const after = [
      modeOf(first.paths.admins),
      modeOf(first.paths.secrets),
      modeOf(first.paths.runtime.secretKey),
    ]
    expect(after).toEqual(before)
    expect(after).toEqual([0o600, 0o600, 0o600])
  })
})
