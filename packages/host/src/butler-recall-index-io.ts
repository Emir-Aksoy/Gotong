import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createLogger, writeFileAtomic } from '@gotong/core'
import { MemoryFileHandle, MemoryFileSnapshotError, ownerDir } from '@gotong/service-memory-file'
import { BUTLER_MEMORY_KINDS } from './personal-butler-memory.js'
import type { OpenButlerRecallIndexOptions, PersistedRecallIndex, RecallIndexIo } from './butler-recall-index.js'

const CACHE = 'recall-index.json'
// Exactly core.uniqueTmpPath's grammar; never adopt arbitrary lookalike files.
const OWN_TEMP = /^recall-index\.json\.[1-9][0-9]*\.[0-9a-z]+\.[0-9a-f]{6}\.tmp$/
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

/** Static path checks, not protection against hostile cross-process path replacement. */
async function regularFile(path: string): Promise<boolean> {
  try {
    const info = await fs.lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new MemoryFileSnapshotError('SNAPSHOT_INVALID_SCOPE')
    return true
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

export function createRecallIndexIo(opts: OpenButlerRecallIndexOptions): RecallIndexIo {
  const rootDir = resolve(opts.rootDir)
  const owner = Object.freeze({ kind: 'user' as const, id: opts.userId })
  const config = Object.freeze({ kinds: Object.freeze([...(opts.kinds ?? BUTLER_MEMORY_KINDS)]) })
  const logger = opts.logger ?? createLogger('butler-recall-index')
  const freshHandle = () => new MemoryFileHandle({ rootDir, owner, config, logger })
  let handle: MemoryFileHandle
  let dir: string
  try {
    handle = freshHandle()
    dir = ownerDir(rootDir, owner)
  } catch { throw new MemoryFileSnapshotError('SNAPSHOT_INVALID_SCOPE') }
  const path = join(dir, CACHE)
  const guard = async () => { await handle.watermark() }

  return {
    assertUsable: guard,
    watermark: () => handle.watermark(),
    loadAll: async () => [...(await handle.snapshot()).entries],
    async loadPersisted() {
      await guard()
      if (!await regularFile(path)) return null
      const fd = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      let raw: string
      try { raw = await fd.readFile('utf8') } finally { await fd.close() }
      await guard()
      const parsed = JSON.parse(raw) as PersistedRecallIndex
      return parsed && typeof parsed.watermark === 'string' && parsed.snapshot ? parsed : null
    },
    async persist(data) {
      await guard()
      await regularFile(path)
      // No mkdir: an absent owner is a valid empty source, not a cache write mandate.
      await writeFileAtomic(path, JSON.stringify(data), 0o600)
      await guard()
    },
    async removePersisted() {
      // Cleanup must survive an old read handle's generation becoming stale.
      // A pending mutation still refuses cleanup; coordinators retire BEFORE mutation.
      const cleanupHandle = freshHandle()
      await cleanupHandle.watermark()
      let names: string[]
      try { names = await fs.readdir(dir) } catch (error) {
        if (missing(error)) return
        throw error
      }
      const targets: string[] = []
      for (const name of names) {
        if (!name.startsWith(CACHE)) continue
        if (name !== CACHE && name !== `${CACHE}.tmp` && !OWN_TEMP.test(name)) {
          throw new MemoryFileSnapshotError('SNAPSHOT_INVALID_SCOPE')
        }
        const target = join(dir, name)
        if (await regularFile(target)) targets.push(target)
      }
      // Complete preflight before any unlink: one unknown name blocks the whole purge.
      await cleanupHandle.watermark()
      for (const target of targets) await fs.unlink(target)
      // Also sync on retry after a prior sync failed with all files already gone.
      const fd = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { await fd.sync() } finally { await fd.close() }
      await cleanupHandle.watermark()
    },
  }
}
