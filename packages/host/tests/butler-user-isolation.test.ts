import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileButlerUserIsolation } from '../src/butler-user-isolation.js'

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}))

const failed = { code: 'BUTLER_USER_ISOLATION_FAILED' }
const quiesced = { code: 'BUTLER_USER_QUIESCED' }
const digest = (id: string) => createHash('sha256').update(id, 'utf8').digest('hex')
let sandbox: string
let root: string
const control = () => join(root, '.user-isolation')
const marker = (id = 'alice') => join(control(), digest(id))

beforeEach(async () => {
  sandbox = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'gotong-isolation-'))
  root = join(sandbox, 'memory')
})

afterEach(() => { vi.restoreAllMocks() })

function observeSync(failAt?: string) {
  const realOpen = fs.open
  const synced: string[] = []
  const closed: string[] = []
  let failedOnce = false
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args)
    const path = String(args[0])
    const sync = handle.sync.bind(handle)
    const close = handle.close.bind(handle)
    vi.spyOn(handle, 'sync').mockImplementation(async () => {
      synced.push(path)
      if (!failedOnce && path === failAt) {
        failedOnce = true
        throw Object.assign(new Error('private-user-and-path'), { code: 'EIO' })
      }
      await sync()
    })
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      closed.push(path)
      await close()
    })
    return handle
  })
  return { synced, closed }
}

describe('FileButlerUserIsolation', () => {
  it('allows absent roots and controls without creating or reading content', async () => {
    const writes = vi.spyOn(fs, 'mkdir')
    const directories = vi.spyOn(fs, 'readdir')
    const contents = vi.spyOn(fs, 'readFile')
    const opens = vi.spyOn(fs, 'open')
    const metadata = vi.spyOn(fs, 'lstat')
    await new FileButlerUserIsolation(root).assertOpen('alice')
    expect(metadata).toHaveBeenCalled()
    expect(writes).not.toHaveBeenCalled()
    expect(directories).not.toHaveBeenCalled()
    expect(contents).not.toHaveBeenCalled()
    expect(opens).not.toHaveBeenCalled()
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('proves normal admission works on a real read-only directory without write or content APIs', async () => {
    await fs.mkdir(control(), { recursive: true })
    await fs.chmod(control(), 0o500)
    await fs.chmod(root, 0o500)
    const mkdir = vi.spyOn(fs, 'mkdir')
    const readdir = vi.spyOn(fs, 'readdir')
    const readFile = vi.spyOn(fs, 'readFile')
    const open = vi.spyOn(fs, 'open')
    await new FileButlerUserIsolation(root).assertOpen('alice')
    expect(mkdir).not.toHaveBeenCalled()
    expect(readdir).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect((await fs.lstat(root)).mode & 0o777).toBe(0o500)
  })

  it('persists an empty hashed marker across a new instance without closing other users', async () => {
    const store = new FileButlerUserIsolation(root)
    await store.close('alice')
    expect(await fs.readdir(control())).toEqual([digest('alice')])
    expect(await fs.readdir(marker())).toEqual([])
    expect((await fs.lstat(marker())).isDirectory()).toBe(true)
    await expect(store.assertOpen('alice')).rejects.toMatchObject(quiesced)
    const restarted = new FileButlerUserIsolation(root)
    await expect(restarted.assertOpen('alice')).rejects.toMatchObject(quiesced)
    await expect(restarted.assertOpen('bob')).resolves.toBeUndefined()
    await expect(fs.lstat(join(root, 'alice'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recognizes a pre-existing empty marker with metadata only', async () => {
    await fs.mkdir(marker(), { recursive: true })
    const readdir = vi.spyOn(fs, 'readdir')
    const mkdir = vi.spyOn(fs, 'mkdir')
    const open = vi.spyOn(fs, 'open')
    await expect(new FileButlerUserIsolation(root).assertOpen('alice')).rejects.toMatchObject(quiesced)
    expect(readdir).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('does not normalize distinct valid Unicode identities into hash aliases', async () => {
    const ids = ['Alice', 'alice', '\u00e9', 'e\u0301', '\ufffd', '\ud83d\ude00']
    const store = new FileButlerUserIsolation(root)
    for (const id of ids) await store.close(id)
    expect((await fs.readdir(control())).sort()).toEqual(ids.map(digest).sort())
    for (const id of ids) await expect(new FileButlerUserIsolation(root).assertOpen(id)).rejects.toMatchObject(quiesced)
  })

  it.each(['', ' ', '.', '..', '../alice', 'alice/bob', 'alice\\bob', 'alice\0', '\ud800', '\udc00', null, 123])(
    'fails closed before disk access for invalid user ID %j', async id => {
      const store = new FileButlerUserIsolation(root)
      const metadata = vi.spyOn(fs, 'lstat')
      const mkdir = vi.spyOn(fs, 'mkdir')
      await expect(store.assertOpen(id as string)).rejects.toMatchObject(failed)
      await expect(store.close(id as string)).rejects.toMatchObject(failed)
      expect(metadata).not.toHaveBeenCalled()
      expect(mkdir).not.toHaveBeenCalled()
    },
  )

  it.each(['root', 'control'] as const)(
    'rejects a static %s symlink without touching its target', async location => {
      const target = join(sandbox, 'target')
      await fs.mkdir(target)
      await fs.writeFile(join(target, 'sentinel'), 'untouched')
      if (location === 'control') await fs.mkdir(root)
      await fs.symlink(target, location === 'root' ? root : control())
      const store = new FileButlerUserIsolation(root)
      await expect(store.assertOpen('alice')).rejects.toMatchObject(failed)
      await expect(store.close('alice')).rejects.toMatchObject(failed)
      expect(await fs.readdir(target)).toEqual(['sentinel'])
      expect(await fs.readFile(join(target, 'sentinel'), 'utf8')).toBe('untouched')
    },
  )

  it('supports a trusted ancestor alias such as the macOS temporary directory', async () => {
    const target = join(sandbox, 'target')
    const alias = join(sandbox, 'alias')
    await fs.mkdir(target)
    await fs.symlink(target, alias)
    root = join(alias, 'nested', 'memory')
    const store = new FileButlerUserIsolation(root)
    await expect(store.assertOpen('alice')).resolves.toBeUndefined()
    await store.close('alice')
    const canonical = new FileButlerUserIsolation(join(target, 'nested', 'memory'))
    await expect(canonical.assertOpen('alice')).rejects.toMatchObject(quiesced)
  })

  it.each(['root', 'control'] as const)('rejects a non-directory %s', async location => {
    if (location === 'control') await fs.mkdir(root)
    await fs.writeFile(location === 'root' ? root : control(), 'private-content')
    const store = new FileButlerUserIsolation(root)
    await expect(store.assertOpen('alice')).rejects.toMatchObject(failed)
    await expect(store.close('alice')).rejects.toMatchObject(failed)
  })

  it.each(['file', 'symlink', 'dangling-symlink', 'nonempty', 'descendant-symlink'] as const)(
    'blocks admission for a %s marker but rejects closing its invalid shape', async shape => {
      await fs.mkdir(control(), { recursive: true })
      const target = join(sandbox, 'target')
      await fs.mkdir(target)
      await fs.writeFile(join(target, 'sentinel'), 'untouched')
      if (shape === 'file') await fs.writeFile(marker(), 'private-content')
      else if (shape === 'symlink') await fs.symlink(target, marker())
      else if (shape === 'dangling-symlink') await fs.symlink(join(sandbox, 'absent'), marker())
      else {
        await fs.mkdir(marker())
        if (shape === 'nonempty') await fs.writeFile(join(marker(), 'extra'), 'private-content')
        else await fs.symlink(target, join(marker(), 'extra'))
      }
      const store = new FileButlerUserIsolation(root)
      await expect(store.assertOpen('alice')).rejects.toMatchObject(quiesced)
      const open = vi.spyOn(fs, 'open')
      await expect(store.close('alice')).rejects.toMatchObject(failed)
      expect(open).not.toHaveBeenCalled()
      expect(await fs.readdir(target)).toEqual(['sentinel'])
    },
  )

  it('uses exclusive mkdir and syncs marker, control, root and all creation ancestors bottom-up', async () => {
    root = join(sandbox, 'fresh-parent', 'nested', 'memory')
    const mkdir = vi.spyOn(fs, 'mkdir')
    const { synced, closed } = observeSync()
    await new FileButlerUserIsolation(root).close('alice')
    expect(mkdir.mock.calls.some(([path]) => path === marker())).toBe(true)
    for (const [, options] of mkdir.mock.calls) expect(options).not.toMatchObject({ recursive: true })
    const expected: string[] = []
    for (let path = marker(); ; path = dirname(path)) {
      expected.push(path)
      if (path === parse(path).root) break
    }
    expect(synced).toEqual(expected)
    expect(closed).toEqual(expected)
  })

  it.each(['marker', 'control', 'root', 'ancestor'] as const)(
    'retains the marker after %s fsync failure and retries sync in a new instance', async location => {
      const failedPath = { marker: marker(), control: control(), root, ancestor: sandbox }[location]
      const { synced, closed } = observeSync(failedPath)
      const store = new FileButlerUserIsolation(root)
      const error = await store.close('alice').catch(e => e)
      expect(error).toBeInstanceOf(Error)
      expect(error).toMatchObject(failed)
      expect(error).not.toHaveProperty('cause')
      expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain('private-user-and-path')
      expect(error.message).not.toContain(root)
      expect(await fs.readdir(marker())).toEqual([])
      expect(closed).toEqual(synced)
      await expect(store.assertOpen('alice')).rejects.toMatchObject(quiesced)
      const restarted = new FileButlerUserIsolation(root)
      await expect(restarted.assertOpen('alice')).rejects.toMatchObject(quiesced)
      const before = synced.length
      await restarted.close('alice')
      expect(synced.slice(before, before + 3)).toEqual([marker(), control(), root])
      expect(synced.filter(path => path === failedPath)).toHaveLength(2)
      await restarted.close('alice')
      expect(synced.filter(path => path === marker())).toHaveLength(3)
    },
  )

  it('sanitizes metadata errors and keeps that user closed in this instance', async () => {
    const store = new FileButlerUserIsolation(root)
    vi.spyOn(fs, 'lstat').mockRejectedValueOnce(Object.assign(new Error('private-content'), { code: 'EACCES' }))
    const error = await store.assertOpen('alice').catch(e => e)
    expect(error).toMatchObject(failed)
    expect(error).not.toHaveProperty('cause')
    expect(error.message).not.toContain('private-content')
    await expect(store.assertOpen('alice')).rejects.toMatchObject(quiesced)
    await expect(store.assertOpen('bob')).resolves.toBeUndefined()
    await store.close('alice')
    await expect(new FileButlerUserIsolation(root).assertOpen('alice')).rejects.toMatchObject(quiesced)
  })

  it('retries a failed mkdir without reopening admission', async () => {
    const store = new FileButlerUserIsolation(root)
    vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(Object.assign(new Error('private-content'), { code: 'EACCES' }))
    await expect(store.close('alice')).rejects.toMatchObject(failed)
    await expect(store.assertOpen('alice')).rejects.toMatchObject(quiesced)
    await store.close('alice')
    await expect(new FileButlerUserIsolation(root).assertOpen('alice')).rejects.toMatchObject(quiesced)
  })

  it('supports concurrent idempotent closes without a temporary file or reopen API', async () => {
    const store = new FileButlerUserIsolation(root)
    await Promise.all(Array.from({ length: 8 }, () => store.close('alice')))
    expect(await fs.readdir(control())).toEqual([digest('alice')])
    expect(await fs.readdir(marker())).toEqual([])
    expect(store).not.toHaveProperty('reopen')
    expect(store).not.toHaveProperty('delete')
  })
})
