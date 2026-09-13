import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ownerDir } from '@gotong/service-memory-file'
import type { ButlerUserActivity } from './butler-user-activity.js'

export interface ButlerMemoryGitPurgeOptions {
  rootDir: string
  /** Trusted membership identity, never a model-supplied directory. */
  userId: string
  /** All same-root writers must use this registry; never manufacture a substitute. */
  userActivity: ButlerUserActivity
}

export class ButlerMemoryGitPurgeError extends Error {
  readonly code = 'BUTLER_MEMORY_GIT_PURGE_FAILED'
  constructor() {
    super('Butler memory Git history cleanup refused or failed.')
    this.name = 'ButlerMemoryGitPurgeError'
  }
}

const MAX_NODES = 100_000
const MAX_DEPTH = 64
const SHARED_LAYOUT = new Set(['commondir', 'gitdir', 'worktrees', 'modules', 'objects/info/alternates', 'objects/info/http-alternates'])
const pending = new Map<string, Promise<void>>()
const fail = () => new ButlerMemoryGitPurgeError()
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

async function metadata(path: string) {
  try { return await fs.lstat(path) } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

interface Directory { path: string; dev: number }

async function childDirectory(parent: Directory, name: string): Promise<Directory | undefined> {
  const path = join(parent.path, name)
  const info = await metadata(path)
  if (!info) return undefined
  // lstat alone cannot distinguish Alice/alice or Unicode-equivalent aliases
  // on case-insensitive filesystems. Isolation keys must match directory bytes.
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== parent.dev
    || !(await fs.readdir(parent.path)).includes(name)) throw fail()
  return { path, dev: info.dev }
}

/** Only configured ancestors may use system aliases such as /tmp -> /private/tmp. */
async function ownerLocation(root: string, userId: string): Promise<{ nearest: Directory; owner?: Directory } | undefined> {
  const info = await metadata(root)
  if (!info) return undefined
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail()
  let current: Directory = { path: root, dev: info.dev }
  for (const name of ['user', userId]) {
    const next = await childDirectory(current, name)
    if (!next) return { nearest: current }
    current = next
  }
  return { nearest: current, owner: current }
}

async function syncDirectory(path: string): Promise<void> {
  const fd = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    if (!(await fd.stat()).isDirectory()) throw fail()
    await fd.sync()
  } finally { await fd.close() }
}

interface Tree { files: string[]; directories: string[] }

async function inspectTree(root: Directory): Promise<Tree> {
  const tree: Tree = { files: [], directories: [] }
  let nodes = 0
  async function visit(path: string, relative: string, depth: number): Promise<void> {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH || SHARED_LAYOUT.has(relative.toLowerCase())) throw fail()
    const info = await fs.lstat(path)
    if (info.isSymbolicLink() || info.dev !== root.dev) throw fail()
    if (info.isFile()) {
      if (info.nlink !== 1) throw fail()
      tree.files.push(path)
      return
    }
    if (!info.isDirectory()) throw fail()
    const names = await fs.readdir(path)
    if (nodes + names.length > MAX_NODES) throw fail()
    for (const name of names) await visit(join(path, name), relative ? `${relative}/${name}` : name, depth + 1)
    tree.directories.push(path)
  }
  await visit(root.path, '', 0)
  return tree
}

async function removeHistory(root: string, userId: string): Promise<void> {
  const location = await ownerLocation(root, userId)
  if (!location) throw fail()
  const git = location.owner && await childDirectory(location.owner, '.git')
  if (git) {
    const tree = await inspectTree(git)
    // Full preflight precedes the first unlink. No Git subprocess, recursive rm,
    // hooks, config parsing, rename-to-trash or backup of the deleted originals.
    for (const file of tree.files) await fs.unlink(file)
    for (const dir of tree.directories) {
      await syncDirectory(dir)
      await fs.rmdir(dir)
    }
  }
  // Retry must sync even when the prior attempt removed .git but failed here.
  await syncDirectory(location.nearest.path)
  if (await metadata(join(ownerDir(root, { kind: 'user', id: userId }), '.git'))) throw fail()
}

/**
 * Internal managed-copy operation, NOT a route or model tool. Call outside the
 * target user's admitted work/retirement callbacks. Requires exclusive writers
 * through the supplied same-root registry; not a cross-process lock or a claim
 * that projections, sessions, external clones/backups or physical media are erased.
 * No config/core.worktree parsing or proof of exclusive Git ownership: external
 * repositories pointing back into this directory can lose access to its history.
 * Static path preflight does not defend against hostile concurrent replacement.
 */
export async function purgeButlerMemoryGitHistory(opts: ButlerMemoryGitPurgeOptions): Promise<void> {
  try {
    if (typeof opts.rootDir !== 'string' || !opts.rootDir.trim() || opts.rootDir.includes('\0')) throw fail()
    const root = resolve(opts.rootDir)
    const { userId, userActivity } = opts
    ownerDir(root, { kind: 'user', id: userId })
    if (!userId.trim() || Buffer.from(userId, 'utf8').toString('utf8') !== userId) throw fail()
    // Reject owner aliases before resource retirement can touch that owner's files.
    await ownerLocation(root, userId)
    await userActivity.quiesceMemoryRoot(root, userId)
    const key = ownerDir(await fs.realpath(root), { kind: 'user', id: userId })
    const prior = pending.get(key) ?? Promise.resolve()
    const operation = prior.catch(() => {}).then(() => removeHistory(root, userId))
    pending.set(key, operation)
    try { await operation } finally {
      if (pending.get(key) === operation) pending.delete(key)
    }
  } catch {
    // No underlying path, Git output, memory text, or cause escapes this boundary.
    throw fail()
  }
}
