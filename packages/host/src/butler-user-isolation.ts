import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { assertSafeOwnerId } from '@gotong/services-sdk'

type IsolationErrorCode = 'BUTLER_USER_QUIESCED' | 'BUTLER_USER_ISOLATION_FAILED'

/** Standalone diagnostics; the activity registry owns its own error boundary. */
export class ButlerUserIsolationError extends Error {
  constructor(readonly code: IsolationErrorCode) {
    super(code === 'BUTLER_USER_QUIESCED'
      ? 'Butler user is quiesced.'
      : 'Butler user isolation failed; retry isolation.')
    this.name = 'ButlerUserIsolationError'
  }
}

function failed(): ButlerUserIsolationError {
  return new ButlerUserIsolationError('BUTLER_USER_ISOLATION_FAILED')
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function userHash(userId: string): string {
  try {
    assertSafeOwnerId(userId)
    // UTF-8 replaces lone surrogates: reject them instead of aliasing another ID.
    if (!userId.trim() || Buffer.from(userId, 'utf8').toString('utf8') !== userId) throw failed()
    return createHash('sha256').update(userId, 'utf8').digest('hex')
  } catch {
    throw failed()
  }
}

async function metadata(path: string, trustedAncestor = false) {
  try {
    return await (trustedAncestor ? fs.stat(path) : fs.lstat(path))
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw error
  }
}

async function directoryExists(path: string, trustedAncestor = false): Promise<boolean> {
  const info = await metadata(path, trustedAncestor)
  if (!info) return false
  if (!info.isDirectory() || info.isSymbolicLink()) throw failed()
  return true
}

async function ensureDirectory(path: string, trustedAncestor = false): Promise<void> {
  if (await directoryExists(path, trustedAncestor)) return
  const parent = dirname(path)
  if (parent === path) throw failed()
  await ensureDirectory(parent, true)
  try {
    await fs.mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
  }
  if (!await directoryExists(path, trustedAncestor)) throw failed()
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    if (!(await handle.stat()).isDirectory()) throw failed()
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * A restart barrier outside user Git trees, not a multiprocess drain/lock.
 * The configured root and its descendants reject static symlinks; trusted
 * ancestors may include system aliases. Hostile concurrent replacement is out
 * of scope. Once observed closed (or unreadable), this instance never reopens.
 */
export class FileButlerUserIsolation {
  private readonly rootDir: string
  private readonly closed = new Set<string>()

  constructor(rootDir: string) {
    if (typeof rootDir !== 'string' || !rootDir.trim() || rootDir.includes('\0')) throw failed()
    this.rootDir = resolve(rootDir)
  }

  async assertOpen(userId: string): Promise<void> {
    const hash = userHash(userId)
    if (this.closed.has(hash)) throw new ButlerUserIsolationError('BUTLER_USER_QUIESCED')
    try {
      const control = join(this.rootDir, '.user-isolation')
      if (await directoryExists(this.rootDir) && await directoryExists(control)) {
        // Presence blocks regardless of shape; admission never enumerates content.
        if (await metadata(join(control, hash))) this.closed.add(hash)
      }
    } catch {
      this.closed.add(hash)
      throw failed()
    }
    // A close may have started while the metadata read was pending.
    if (this.closed.has(hash)) throw new ButlerUserIsolationError('BUTLER_USER_QUIESCED')
  }

  async close(userId: string): Promise<void> {
    const hash = userHash(userId)
    this.closed.add(hash)
    try {
      const control = join(this.rootDir, '.user-isolation')
      const marker = join(control, hash)
      await ensureDirectory(this.rootDir)
      await ensureDirectory(control)
      await ensureDirectory(marker)
      if ((await fs.readdir(marker)).length !== 0) throw failed()

      // Validate before canonicalizing: realpath alone would hide a root symlink.
      // Sync the actual ancestry so macOS /var and /tmp aliases are not rejected.
      const canonicalRoot = await fs.realpath(this.rootDir)
      for (let path = join(canonicalRoot, '.user-isolation', hash); ; path = dirname(path)) {
        await syncDirectory(path)
        if (dirname(path) === path) break
      }
      // Retry always repeats every sync, even when the marker already existed.
    } catch {
      // Incomplete durability never removes the marker or reopens local admission.
      throw failed()
    }
  }
}
