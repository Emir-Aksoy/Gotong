import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@gotong/core'
import { ownerDir } from '@gotong/service-memory-file'
import { purgeButlerMemoryGitHistory } from '../src/butler-memory-git-purge.js'
import { execFileGitRunner, snapshotMemoryTree } from '../src/butler-memory-git.js'
import { ButlerUserActivity } from '../src/butler-user-activity.js'
import { FileButlerUserIsolation } from '../src/butler-user-isolation.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const logger = createLogger('git-purge-test', { level: 'silent' })
const failed = { code: 'BUTLER_MEMORY_GIT_PURGE_FAILED' }
let rootDir: string
const member = (userId = 'alice') => ownerDir(rootDir, { kind: 'user', id: userId })
const gitDir = (userId = 'alice') => join(member(userId), '.git')
const activity = () => new ButlerUserActivity(new FileButlerUserIsolation(rootDir))
const purge = (userActivity = activity(), userId = 'alice') => purgeButlerMemoryGitHistory({ rootDir, userId, userActivity })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
async function file(path: string, text = 'synthetic private data') {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, text)
}
async function seed(userId = 'alice') {
  await file(join(gitDir(userId), 'HEAD'), 'ref: refs/heads/main\n')
  await file(join(gitDir(userId), 'objects', 'ab', 'old-object'))
  await file(join(member(userId), 'semantic.jsonl'), 'current synthetic memory')
}
async function exists(path: string) {
  try { await fs.lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
async function closed() {
  await expect(new FileButlerUserIsolation(rootDir).assertOpen('alice')).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
}
beforeEach(async () => { rootDir = await fs.mkdtemp(join(tmpdir(), 'gotong-git-purge-')) })
afterEach(() => { vi.restoreAllMocks() })

describe('owned Git history purge', () => {
  it('removes packed history from real snapshots, preserving working files, another user and an ancestor repository', async () => {
    expect((await execFileGitRunner(['init'], rootDir)).code).toBe(0)
    await file(join(member(), 'semantic.jsonl'), 'old synthetic assertion')
    expect(await snapshotMemoryTree({ dir: member(), logger, now: () => 1 })).toBe('committed')
    await file(join(member(), 'semantic.jsonl'), 'corrected synthetic assertion')
    expect(await snapshotMemoryTree({ dir: member(), logger, now: () => 2 })).toBe('committed')
    expect((await execFileGitRunner(['gc'], member())).code).toBe(0)
    expect((await execFileGitRunner(['show', 'HEAD~1:semantic.jsonl'], member())).stdout).toBe('old synthetic assertion')
    await seed('bob')
    const ancestorHead = await fs.readFile(join(rootDir, '.git', 'HEAD'), 'utf8')
    await purge()
    expect(await exists(gitDir())).toBe(false)
    expect(await fs.readFile(join(member(), 'semantic.jsonl'), 'utf8')).toBe('corrected synthetic assertion')
    expect(await fs.readFile(join(member(), '.gitignore'), 'utf8')).toBe('*.tmp\n*.lock\n')
    expect(await fs.readFile(join(rootDir, '.git', 'HEAD'), 'utf8')).toBe(ancestorHead)
    expect(await fs.readFile(join(gitDir('bob'), 'objects', 'ab', 'old-object'), 'utf8')).toBe('synthetic private data')
    await closed()
    await expect(activity().run('bob', () => 'ok')).resolves.toBe('ok')
  })

  it.each(['absent', 'empty', 'partial'] as const)('can retry when Git history is %s', async state => {
    if (state === 'empty') await fs.mkdir(gitDir(), { recursive: true })
    if (state === 'partial') await file(join(gitDir(), 'logs', 'remaining'))
    await purge()
    await purge()
    expect(await exists(gitDir())).toBe(false)
    await closed()
  })

  it.each(['task', 'resource', 'finalizer'] as const)('does not delete until the shared %s has really finished', async phase => {
    await seed()
    const shared = activity()
    const entered = deferred()
    const closingEntered = deferred()
    const gate = deferred()
    const quiesce = shared.quiesce.bind(shared)
    vi.spyOn(shared, 'quiesce').mockImplementation(userId => {
      const closing = quiesce(userId)
      closingEntered.resolve()
      return closing
    })
    const work = async () => { entered.resolve(); await gate.promise }
    let running: Promise<unknown> | undefined
    if (phase === 'task') {
      running = shared.run('alice', async () => { await work(); return 'private answer' })
      void running.catch(() => {})
      await entered.promise
    } else if (phase === 'resource') shared.register('alice', work)
    else shared.registerFinalizer('alice', work)
    const removing = purge(shared)
    await closingEntered.promise
    if (phase !== 'task') await entered.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(await exists(join(gitDir(), 'HEAD'))).toBe(true)
    gate.resolve()
    await removing
    if (running) await expect(running).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(await exists(gitDir())).toBe(false)
  })

  it.each(['isolation', 'retirement'] as const)('does not delete on %s failure and can retry', async phase => {
    await seed()
    const shared = activity()
    const retire = vi.fn()
    shared.register('alice', retire)
    if (phase === 'isolation') vi.spyOn(FileButlerUserIsolation.prototype, 'close').mockRejectedValueOnce(new Error('private-path'))
    else retire.mockRejectedValueOnce(new Error('private-path'))
    await expect(purge(shared)).rejects.toMatchObject(failed)
    expect(await exists(join(gitDir(), 'HEAD'))).toBe(true)
    if (phase === 'isolation') expect(retire).not.toHaveBeenCalled()
    await purge(shared)
    expect(await exists(gitDir())).toBe(false)
    await closed()
  })

  it.each(['root', 'user-kind', 'user', 'git', 'nested'] as const)('rejects a static %s symlink without unlinking anything', async level => {
    const elsewhere = await fs.mkdtemp(join(tmpdir(), 'gotong-git-purge-outside-'))
    const target = level === 'root' ? rootDir : level === 'user-kind' ? join(rootDir, 'user')
      : level === 'user' ? member() : level === 'git' ? gitDir() : join(gitDir(), 'linked')
    if (level === 'root') await fs.rmdir(rootDir)
    await fs.mkdir(dirname(target), { recursive: true })
    await file(join(elsewhere, 'sentinel'))
    await fs.symlink(elsewhere, target)
    if (level === 'nested') await file(join(gitDir(), 'HEAD'))
    const unlink = vi.spyOn(fs, 'unlink')
    await expect(purge()).rejects.toMatchObject(failed)
    expect(unlink).not.toHaveBeenCalled()
    expect(await fs.readFile(join(elsewhere, 'sentinel'), 'utf8')).toBe('synthetic private data')
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true)
  })

  it('refuses a gitfile rather than following it or treating it as absent', async () => {
    await file(gitDir(), 'gitdir: /synthetic-outside/repo\n')
    await expect(purge()).rejects.toMatchObject(failed)
    expect(await fs.readFile(gitDir(), 'utf8')).toBe('gitdir: /synthetic-outside/repo\n')
    await closed()
  })

  it.each(['commondir', 'gitdir', 'worktrees/link', 'modules/sub', 'objects/info/alternates', 'objects/info/http-alternates', 'WORKTREES/link'])(
    'refuses shared layout %s during full preflight', async path => {
      await seed()
      await file(join(gitDir(), path), '/synthetic-external')
      const unlink = vi.spyOn(fs, 'unlink')
      await expect(purge()).rejects.toMatchObject(failed)
      expect(unlink).not.toHaveBeenCalled()
      expect(await exists(join(gitDir(), 'HEAD'))).toBe(true)
      await closed()
    },
  )

  it('refuses hard-linked history instead of leaving an external copy behind', async () => {
    await seed()
    await fs.link(join(gitDir(), 'HEAD'), join(rootDir, 'external-head'))
    const unlink = vi.spyOn(fs, 'unlink')
    await expect(purge()).rejects.toMatchObject(failed)
    expect(unlink).not.toHaveBeenCalled()
    expect(await exists(join(rootDir, 'external-head'))).toBe(true)
  })

  it.each(['special', 'device', 'depth', 'count'] as const)('refuses %s anomalies before any deletion', async shape => {
    await seed()
    if (shape === 'depth') await fs.mkdir(join(gitDir(), ...Array<string>(65).fill('d')), { recursive: true })
    if (shape === 'count') {
      const readdir = fs.readdir
      vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
        if (String(args[0]) === gitDir()) return Array<string>(100001).fill('node') as never
        return readdir(...args)
      })
    }
    if (shape === 'special' || shape === 'device') {
      const lstat = fs.lstat
      vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
        const info = await lstat(...args)
        if (String(args[0]) === join(gitDir(), 'HEAD')) {
          if (shape === 'special') return { ...info, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false } as never
          return Object.assign(info, { dev: Number(info.dev) + 1 }) as never
        }
        return info
      })
    }
    const unlink = vi.spyOn(fs, 'unlink')
    await expect(purge()).rejects.toMatchObject(failed)
    expect(unlink).not.toHaveBeenCalled()
  })

  it.each(['unlink', 'rmdir', 'git-sync', 'sync'] as const)('keeps isolation after %s failure and finishes a fresh retry', async phase => {
    await seed()
    if (phase === 'unlink') {
      const unlink = fs.unlink
      vi.spyOn(fs, 'unlink').mockImplementationOnce(unlink)
        .mockRejectedValueOnce(new Error('private-path: private-content', { cause: 'private-cause' }))
    }
    if (phase === 'rmdir') vi.spyOn(fs, 'rmdir').mockRejectedValueOnce(new Error('private-path'))
    if (phase === 'sync' || phase === 'git-sync') {
      const open = fs.open
      let injected = false
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args)
        if (String(args[0]) === (phase === 'sync' ? member() : gitDir()) && !injected) {
          injected = true
          vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('private-path'))
        }
        return handle
      })
    }
    const error = await purge().catch(error => error)
    expect(error).toMatchObject(failed)
    expect(String(error)).not.toContain('private-')
    expect(error.cause).toBeUndefined()
    await closed()
    if (phase === 'sync') expect(await exists(gitDir())).toBe(false)
    else expect(await exists(join(gitDir(), 'HEAD'))).toBe(false)
    await purge()
    expect(await exists(gitDir())).toBe(false)
    expect(await fs.readFile(join(member(), 'semantic.jsonl'), 'utf8')).toBe('current synthetic memory')
  })

  it('rejects an unreadable owner listing before retirement', async () => {
    await seed()
    const readdir = fs.readdir
    vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
      if (String(args[0]) === join(rootDir, 'user')) throw Object.assign(new Error('private-path'), { code: 'EACCES' })
      return readdir(...args)
    })
    const shared = activity()
    const quiesce = vi.spyOn(shared, 'quiesce')
    await expect(purge(shared)).rejects.toMatchObject(failed)
    expect(quiesce).not.toHaveBeenCalled()
    expect(await exists(join(gitDir(), 'HEAD'))).toBe(true)
  })

  it('re-syncs the user directory on retry after Git history is already absent', async () => {
    await seed()
    const shared = activity()
    await purge(shared)
    const open = fs.open
    const sync = vi.fn(async () => {})
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const fd = await open(...args)
      if (String(args[0]) === member()) {
        const original = fd.sync.bind(fd)
        vi.spyOn(fd, 'sync').mockImplementation(async () => { await sync(); await original() })
      }
      return fd
    })
    await purge(shared)
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('does not use cached quiescence to skip a failed durability check on a later purge', async () => {
    await seed()
    const shared = activity()
    await shared.quiesce('alice')
    vi.spyOn(FileButlerUserIsolation.prototype, 'close').mockRejectedValueOnce(new Error('private-sync'))
    await expect(purge(shared)).rejects.toMatchObject(failed)
    expect(await exists(join(gitDir(), 'HEAD'))).toBe(true)
    await expect(shared.run('alice', () => 'private-answer')).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await purge(shared)
    expect(await exists(gitDir())).toBe(false)
  })

  it('serializes overlapping calls and each waits for its supplied registry', async () => {
    await seed()
    const first = activity()
    const second = activity()
    const entered = deferred()
    const gate = deferred()
    second.register('alice', async () => { entered.resolve(); await gate.promise })
    const a = purge(first)
    let secondDone = false
    const b = purge(second).then(() => { secondDone = true })
    await entered.promise
    await a
    expect(secondDone).toBe(false)
    gate.resolve()
    await b
    expect(await exists(gitDir())).toBe(false)
    await seed()
    await Promise.all([purge(), purge(), purge()])
    expect(await exists(gitDir())).toBe(false)
  })

  it.each(['../bob', '.', '', '\ud800', 'alice\u0000'])('refuses invalid user %j without changing other history', async userId => {
    await seed('bob')
    await expect(purge(activity(), userId)).rejects.toMatchObject(failed)
    expect(await exists(join(gitDir('bob'), 'HEAD'))).toBe(true)
  })

  it.each(['bare', 'different-root'] as const)('rejects a %s registry before retiring resources', async binding => {
    await seed()
    const shared = binding === 'bare' ? new ButlerUserActivity()
      : new ButlerUserActivity(new FileButlerUserIsolation(join(rootDir, 'other-root')))
    const retire = vi.fn()
    shared.register('alice', retire)
    await expect(purge(shared)).rejects.toMatchObject(failed)
    expect(retire).not.toHaveBeenCalled()
    expect(await exists(join(gitDir(), 'HEAD'))).toBe(true)
  })

  it.each([['alice', 'Alice'], ['cafe\u0301', 'caf\u00e9']])('rejects directory alias %s / %s before quiescence', async (stored, alias) => {
    await seed(stored)
    const lstat = fs.lstat
    vi.spyOn(fs, 'lstat').mockImplementation((...args) => {
      if (String(args[0]) === member(alias)) return lstat(member(stored)) as never
      return lstat(...args) as never
    })
    const shared = activity()
    const quiesce = vi.spyOn(shared, 'quiesce')
    await expect(purge(shared, alias)).rejects.toMatchObject(failed)
    expect(quiesce).not.toHaveBeenCalled()
    expect(await exists(join(gitDir(stored), 'HEAD'))).toBe(true)
  })
})
