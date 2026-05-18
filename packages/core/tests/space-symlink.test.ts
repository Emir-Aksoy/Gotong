// H7 regression: `Space.init` / `Space.open` must refuse to operate
// on a workspace where the root or a sensitive child is a symbolic
// link, or where ownership doesn't match the running user.
//
// Two attack scenarios from AUDIT-v3.3.md finding H7:
//
//   1. Symlink pre-staging — an attacker on a shared host creates
//      `<root>/runtime/secret.key` as a symbolic link to a victim's
//      file BEFORE the victim runs `aipehub-host`. Without this check
//      our `writeFile(secret.key, …)` would follow the symlink and
//      overwrite the victim's file with random key material — a
//      cheap DoS / data corruption.
//
//   2. Workspace-root hijack — the attacker creates `<root>` itself
//      as a symlink (or as a regular dir owned by their uid). Our
//      writes would either land in the attacker's territory or
//      land in the symlink target.
//
// POSIX only. Windows uses NTFS ACLs as the trust boundary; mode bits
// and uid aren't meaningful there.

import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Space, SpaceUnsafeError } from '../src/space.js'

const POSIX = process.platform !== 'win32'

describe.skipIf(!POSIX)('Space — filesystem safety checks (H7)', () => {
  let scratch: string

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'aipehub-h7-'))
  })

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  it('Space.init throws when the workspace root is a symbolic link', async () => {
    // Attacker scenario: pre-stage `<root>` as a symlink to a real dir.
    const realDir = join(scratch, 'real')
    const fakeRoot = join(scratch, 'fake-root')
    await mkdir(realDir)
    await symlink(realDir, fakeRoot)

    await expect(Space.init(fakeRoot, { name: 'attacker-victim' })).rejects.toMatchObject({
      name: 'SpaceUnsafeError',
      code: 'workspace_symlink',
      path: fakeRoot,
    })

    // No sensitive files should have been written to the symlink
    // target. The realDir should still be empty.
    expect(existsSync(join(realDir, 'space.json'))).toBe(false)
    expect(existsSync(join(realDir, 'admins.json'))).toBe(false)
  })

  it('Space.init throws when runtime/secret.key is pre-staged as a symlink', async () => {
    // Attacker scenario: create the runtime dir + pre-stage
    // secret.key as a symlink to a victim file. Note: we have to
    // create runtime/ ourselves before symlink because Space.init's
    // own mkdir would follow the symlink-on-runtime case (different
    // attack vector covered separately).
    const victimFile = join(scratch, 'victim.txt')
    await writeFile(victimFile, 'sensitive victim data\n', 'utf8')

    const root = join(scratch, 'workspace')
    await mkdir(join(root, 'runtime'), { recursive: true })
    await symlink(victimFile, join(root, 'runtime', 'secret.key'))

    await expect(Space.init(root, { name: 'victim-test' })).rejects.toMatchObject({
      name: 'SpaceUnsafeError',
      code: 'workspace_symlink',
      path: join(root, 'runtime', 'secret.key'),
    })

    // Victim file content is unchanged.
    const victimAfter = await import('node:fs/promises').then((m) =>
      m.readFile(victimFile, 'utf8'),
    )
    expect(victimAfter).toBe('sensitive victim data\n')
  })

  it('Space.init throws when admins.json is pre-staged as a symlink', async () => {
    // Defends against the same attack vector applied to non-runtime
    // sensitive files. admins.json being a symlink would let an
    // attacker direct the first `createAdmin` write to a victim file.
    const victimFile = join(scratch, 'victim.json')
    await writeFile(victimFile, '{"victim": "data"}\n', 'utf8')

    const root = join(scratch, 'workspace')
    await mkdir(root, { recursive: true })
    await symlink(victimFile, join(root, 'admins.json'))

    await expect(Space.init(root, { name: 'admins-symlink-test' })).rejects.toMatchObject({
      name: 'SpaceUnsafeError',
      code: 'workspace_symlink',
      path: join(root, 'admins.json'),
    })
  })

  it('Space.open throws when a sensitive file is replaced with a symlink between sessions', async () => {
    // Init a workspace cleanly. The attacker waits until between
    // sessions and replaces admins.json with a symlink pointing at a
    // victim file. The next Space.open MUST refuse.
    const root = join(scratch, 'workspace')
    const { space } = await Space.init(root, {
      name: 'tampering-test',
      adminDisplayName: 'Operator',
    })

    // Sanity — the workspace works normally.
    expect((await space.admins()).length).toBe(1)

    // Attacker tampering between sessions.
    const victimFile = join(scratch, 'victim.json')
    await writeFile(victimFile, '{"victim": "data"}\n', 'utf8')
    await rm(join(root, 'admins.json'))
    await symlink(victimFile, join(root, 'admins.json'))

    await expect(Space.open(root)).rejects.toMatchObject({
      name: 'SpaceUnsafeError',
      code: 'workspace_symlink',
      path: join(root, 'admins.json'),
    })
  })

  it('SpaceUnsafeError carries the code + path for programmatic branching', async () => {
    // Hosts that want to surface a specific UI message based on the
    // failure mode should be able to branch on `err.code` without
    // grepping the message.
    const realDir = join(scratch, 'real')
    const fakeRoot = join(scratch, 'fake-root')
    await mkdir(realDir)
    await symlink(realDir, fakeRoot)

    let caught: unknown
    try {
      await Space.init(fakeRoot, { name: 'introspection-test' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SpaceUnsafeError)
    if (caught instanceof SpaceUnsafeError) {
      expect(caught.code).toBe('workspace_symlink')
      expect(caught.path).toBe(fakeRoot)
      expect(caught.message).toContain('symbolic link')
    }
  })

  it('Space.init succeeds when root is a regular pre-existing directory (idempotent)', async () => {
    // Common legitimate case: an operator runs the host with a
    // pre-mounted volume that already has the dir created by Docker.
    // We must not refuse this — the dir is owned by us, not a
    // symlink, exists. Init should proceed.
    const root = join(scratch, 'workspace')
    await mkdir(root, { recursive: true })

    const { space } = await Space.init(root, { name: 'idempotent-test' })
    expect(existsSync(space.paths.space)).toBe(true)
  })

  it('Space.init succeeds when root does not pre-exist (first-run case)', async () => {
    const root = join(scratch, 'never-existed-before')
    const { space } = await Space.init(root, { name: 'first-run-test' })
    expect(existsSync(space.paths.space)).toBe(true)
    // After init, our own files should be regular files owned by
    // the running user — sanity check that the safety predicate
    // doesn't falsely flag valid state.
    const stat = statSync(space.paths.admins)
    expect(stat.isSymbolicLink()).toBe(false)
    expect(stat.uid).toBe(process.getuid!())
  })

  it('Space.open succeeds on a clean workspace (no false positives)', async () => {
    const root = join(scratch, 'workspace')
    await Space.init(root, { name: 'open-clean-test', adminDisplayName: 'Op' })
    // No tampering between init and open — this must pass.
    const reopened = await Space.open(root)
    expect((await reopened.admins()).length).toBe(1)
  })
})
