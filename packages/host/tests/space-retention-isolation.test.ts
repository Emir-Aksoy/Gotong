import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openLongRunDossierStore } from '@gotong/personal-butler'
import { ownerDir } from '@gotong/service-memory-file'
import { butlerLongRunRoot } from '../src/butler-space-dirs.js'
import { ButlerUserActivity } from '../src/butler-user-activity.js'
import { FileButlerUserIsolation } from '../src/butler-user-isolation.js'
import { buildRetentionLadder, retentionLadderOnce } from '../src/space-retention.js'
import type { GitRunner } from '../src/butler-memory-git.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const NOW = Date.now()
const OLD = NOW - 100 * 86_400_000
const policy = { memory_archive_days: 30, dossier_days: 30, departed_session_days: 30 }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
let space: string
const root = () => join(space, 'butler', 'memory')
const archive = (uid: string) => join(root(), 'user', uid, 'knowledge', 'archive', 'fact.md')
const dossierDir = (uid: string) => ownerDir(butlerLongRunRoot(root()), { kind: 'user', id: uid })
const dossier = (uid: string) => join(dossierDir(uid), 'task', 'dossier.json')
const session = (uid: string) => join(space, 'butler', 'sessions', `${uid}.json`)
const actions = () => join(space, 'runtime', 'space-actions.jsonl')
async function file(path: string, content: string) {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, content)
  await fs.utimes(path, new Date(OLD), new Date(OLD))
}
async function seed(uid: string) {
  await file(archive(uid), 'synthetic private archive')
  const store = openLongRunDossierStore({ dir: dossierDir(uid), now: () => OLD })
  await store.create({ taskId: 'task', userId: uid, objective: 'synthetic task' })
  await store.mutate('task', d => { d.status = 'done' })
  await file(session(uid), 'synthetic private session')
}
const git: GitRunner = async () => ({ code: 0, stdout: String(Math.floor(NOW / 1000)), stderr: '' })
function options(userActivity?: ButlerUserActivity) {
  return { spaceDir: space, actionsFile: actions(), policy, liveUserIds: new Set<string>(), git, now: () => NOW, userActivity }
}
async function retained(uid: string) {
  for (const path of [archive(uid), dossier(uid), session(uid)]) expect((await fs.stat(path)).isFile()).toBe(true)
}

beforeEach(async () => {
  space = await fs.mkdtemp(join(tmpdir(), 'gotong-retention-isolation-'))
  await file(join(space, 'runtime', 'last-backup.json'), JSON.stringify({
    format: 'gotong.last-backup/v1', at: NOW, tier: 'full', includesMasterKey: false, archive: 'synthetic.tar.gz',
  }))
})
afterEach(() => { vi.restoreAllMocks() })

describe('member retention admission', () => {
  it('only walks canonical user dossiers, without treating owner kinds or misplaced trees as users', async () => {
    const outside = [
      join(space, 'butler', 'longrun', 'misplaced', 'task', 'dossier.json'),
      join(space, 'butler', 'longrun', 'agent', 'other', 'task', 'dossier.json'),
    ]
    for (const path of outside) await file(path, JSON.stringify({ status: 'done', updatedAt: OLD }))
    await seed('user')
    const activity = new ButlerUserActivity()
    const run = vi.spyOn(activity, 'run')
    const result = await retentionLadderOnce({ ...options(activity), policy: { dossier_days: 30 } })
    expect(result).toMatchObject({ deleted: 1, failed: 0 })
    expect(run.mock.calls.map(([uid]) => uid)).toEqual(['user'])
    await expect(fs.stat(dossier('user'))).rejects.toMatchObject({ code: 'ENOENT' })
    for (const path of outside) expect((await fs.stat(path)).isFile()).toBe(true)
  })

  it.each(['default', 'shared', 'thunk'] as const)('preserves all isolated user categories and still cleans another user: %s', async mode => {
    await seed('alice')
    await seed('bob')
    const activity = new ButlerUserActivity(new FileButlerUserIsolation(root()))
    await activity.quiesce('alice')
    await file(join(space, 'retention.json'), JSON.stringify(policy))
    const read = vi.spyOn(fs, 'readFile')
    const dirs = vi.spyOn(fs, 'readdir')
    const gitSpy = vi.fn(git)
    const result = mode === 'thunk'
      ? await buildRetentionLadder({ spaceDir: space, listUserIds: () => [], git: gitSpy })()
      : await retentionLadderOnce({ ...options(mode === 'shared' ? activity : undefined), git: gitSpy })
    expect(result).toMatchObject({ deleted: 3, failed: 3 })
    expect(gitSpy.mock.calls.some(([, cwd]) => cwd.endsWith('/alice'))).toBe(false)
    expect(read.mock.calls.some(([path]) => String(path) === dossier('alice'))).toBe(false)
    expect(dirs.mock.calls.some(([path]) => String(path).includes('/alice/'))).toBe(false)
    await retained('alice')
    for (const path of [archive('bob'), dossier('bob'), session('bob')]) {
      await expect(fs.stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await fs.readFile(actions(), 'utf8')).not.toContain('alice')
  })

  it.each(['git', 'audit', 'unlink'] as const)('drains an admitted %s before retirement and refuses later categories', async phase => {
    await seed('alice')
    const activity = new ButlerUserActivity()
    const entered = deferred()
    const gate = deferred()
    const retire = vi.fn()
    activity.register('alice', retire)
    const append = fs.appendFile
    const unlink = fs.unlink
    if (phase === 'audit') vi.spyOn(fs, 'appendFile').mockImplementation(async (...args) => {
      if (String(args[0]) === actions()) { entered.resolve(); await gate.promise }
      return append(...args)
    })
    if (phase === 'unlink') vi.spyOn(fs, 'unlink').mockImplementation(async path => {
      if (String(path) === archive('alice')) { entered.resolve(); await gate.promise }
      return unlink(path)
    })
    const delayedGit: GitRunner = async (...args) => {
      if (phase === 'git') { entered.resolve(); await gate.promise }
      return git(...args)
    }
    const running = retentionLadderOnce({ ...options(activity), git: delayedGit })
    await entered.promise
    const closing = activity.quiesce('alice')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(retire).not.toHaveBeenCalled()
    gate.resolve()
    const result = await running
    await closing
    expect(retire).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ deleted: 1, failed: 3 })
    await expect(fs.stat(archive('alice'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.stat(dossier('alice'))).isFile()).toBe(true)
    expect((await fs.stat(session('alice'))).isFile()).toBe(true)
  })

  it('does not fall back to unguarded cleanup after an admission failure', async () => {
    await seed('alice')
    const activity = new ButlerUserActivity({
      assertOpen: async () => { throw new Error('private-marker', { cause: 'private-marker' }) },
      close: async () => {},
    })
    const warn = vi.fn()
    const result = await retentionLadderOnce({ ...options(activity), logger: { warn } })
    expect(result).toMatchObject({ deleted: 0, failed: 3 })
    await retained('alice')
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-marker')
    await expect(fs.stat(actions())).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
