/**
 * MemoryFilePlugin — first-party memory:file ServicePlugin.
 *
 * Owns lifecycle (init / attach / detach / softDelete / restore /
 * hardDelete / describe / shutdown) for owners using file-backed
 * memory. The per-call handle is {@link MemoryFileHandle}.
 *
 * Persistence layout: see paths.ts.
 *
 * Trash model (RFC §5): softDelete moves the entire owner directory
 * into `<rootDir>/.trash/<refId>/payload/`, writes a `meta.json`
 * holding the TrashRef. The id is a hash deterministic on
 * `(type, impl, owner, dayBucket)` — re-deleting on the same day is
 * idempotent: meta.json already exists, no payload to move (the
 * owner dir is gone), return the same ref.
 *
 * Concurrent-attach guarantee: the Hub ensures one open handle per
 * `(plugin, owner)` at a time. This plugin keeps no in-memory state
 * besides the handle map below — restart-safe.
 */

import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Logger } from '@aipehub/core'
import type {
  Owner,
  ServiceInitCtx,
  ServicePlugin,
  ServiceSnapshot,
  TrashRef,
} from '@aipehub/services-sdk'
import {
  makeTrashRef,
  ownerKey,
  PREVIEW_MAX_BYTES,
  TrashRestoreConflictError,
} from '@aipehub/services-sdk'

import { type MemoryFileConfig, validateMemoryFileConfig } from './config.js'
import { MemoryFileHandle } from './handle.js'
import {
  kindFile,
  ownerDir,
  trashEntryDir,
  trashMetaFile,
  trashPayloadDir,
  trashRoot,
} from './paths.js'

const PLUGIN_VERSION = '0.1.0'

export class MemoryFilePlugin
  implements ServicePlugin<MemoryFileConfig, MemoryFileHandle>
{
  readonly type = 'memory'
  readonly impl = 'file'
  readonly version = PLUGIN_VERSION
  readonly description = 'File-backed memory (jsonl) — first-party'

  private rootDir = ''
  private logger!: Logger
  private now: () => number = Date.now
  /** Currently-attached handles, keyed by ownerKey. */
  private readonly handles = new Map<string, MemoryFileHandle>()

  async validateConfig(raw: unknown): Promise<MemoryFileConfig> {
    return validateMemoryFileConfig(raw)
  }

  async init(ctx: ServiceInitCtx): Promise<void> {
    this.rootDir = ctx.rootDir
    this.logger = ctx.logger
    this.now = () => ctx.hub.now()
    await mkdir(this.rootDir, { recursive: true })
    await mkdir(trashRoot(this.rootDir), { recursive: true })
    this.logger.debug('memory:file initialised', { rootDir: this.rootDir })
  }

  async attach(owner: Owner, config: MemoryFileConfig): Promise<MemoryFileHandle> {
    const key = ownerKey(owner)
    const existing = this.handles.get(key)
    if (existing) return existing
    const handle = new MemoryFileHandle({
      rootDir: this.rootDir,
      owner,
      config,
      logger: this.logger,
      now: this.now,
    })
    this.handles.set(key, handle)
    return handle
  }

  async detach(owner: Owner): Promise<void> {
    this.handles.delete(ownerKey(owner))
  }

  async softDelete(owner: Owner): Promise<TrashRef> {
    const deletedAt = this.now()
    const ref = await makeTrashRef({
      type: this.type, impl: this.impl, owner, deletedAt,
    })
    const trashDir = trashEntryDir(this.rootDir, ref.id)
    const metaPath = trashMetaFile(this.rootDir, ref.id)
    const payloadPath = trashPayloadDir(this.rootDir, ref.id)
    const srcDir = ownerDir(this.rootDir, owner)

    // Drop the in-memory handle so a subsequent attach gets a fresh start.
    this.handles.delete(ownerKey(owner))

    await mkdir(trashDir, { recursive: true })
    if (!await exists(metaPath)) {
      await writeFile(metaPath, JSON.stringify(ref, null, 2), 'utf8')
    }

    if (await exists(srcDir)) {
      if (await exists(payloadPath)) {
        // Second softDelete same day, but owner accumulated new data
        // since the first one. Stash it as a sibling so we don't lose
        // anything.
        const siblingPath = join(trashDir, `payload-${deletedAt}`)
        await rename(srcDir, siblingPath)
        this.logger.warn('soft-delete merged into existing trash entry', {
          owner: ownerKey(owner), trashId: ref.id, sibling: siblingPath,
        })
      } else {
        await rename(srcDir, payloadPath)
      }
    }

    return ref
  }

  async restore(ref: TrashRef): Promise<void> {
    const owner: Owner = { kind: ref.ownerKind, id: ref.ownerId }
    const dstDir = ownerDir(this.rootDir, owner)
    const trashDir = trashEntryDir(this.rootDir, ref.id)
    const payloadPath = trashPayloadDir(this.rootDir, ref.id)

    if (await exists(dstDir)) {
      throw new TrashRestoreConflictError(ref.id)
    }

    if (await exists(payloadPath)) {
      await mkdir(dirname(dstDir), { recursive: true })
      await rename(payloadPath, dstDir)
    }
    await rm(trashDir, { recursive: true, force: true })
  }

  async hardDelete(ref: TrashRef): Promise<void> {
    const trashDir = trashEntryDir(this.rootDir, ref.id)
    await rm(trashDir, { recursive: true, force: true })
  }

  async describe(owner: Owner): Promise<ServiceSnapshot> {
    const dir = ownerDir(this.rootDir, owner)
    if (!await exists(dir)) {
      return { sizeBytes: 0, itemCount: 0 }
    }
    let sizeBytes = 0
    let itemCount = 0
    let lastAccess: number | undefined
    for (const kind of ['episodic', 'semantic', 'working'] as const) {
      const path = kindFile(this.rootDir, owner, kind)
      if (!await exists(path)) continue
      const st = await stat(path)
      sizeBytes += st.size
      if (!lastAccess || st.mtimeMs > lastAccess) lastAccess = st.mtimeMs
      // Approximate line count without re-reading: count by reading.
      // For a memory file this is cheap; if it grows past tens of MB
      // we'd cache. Not optimising for MVP.
      const raw = await readFile(path, 'utf8')
      for (const line of raw.split('\n')) if (line) itemCount += 1
    }
    const preview = await this.buildPreview(owner)
    const snap: ServiceSnapshot = { sizeBytes, itemCount }
    if (lastAccess !== undefined) snap.lastAccess = lastAccess
    if (preview) snap.preview = preview
    return snap
  }

  async shutdown(): Promise<void> {
    this.handles.clear()
  }

  // --- internals ----------------------------------------------------

  /** Build a preview blob — tail of the most-recent kind file. */
  private async buildPreview(owner: Owner): Promise<ServiceSnapshot['preview']> {
    for (const kind of ['episodic', 'semantic', 'working'] as const) {
      const path = kindFile(this.rootDir, owner, kind)
      if (!await exists(path)) continue
      const raw = await readFile(path, 'utf8')
      const cap = PREVIEW_MAX_BYTES
      let truncated = false
      let text = raw
      if (Buffer.byteLength(text, 'utf8') > cap) {
        // Tail bytes (newest content is at the end).
        text = text.slice(-cap)
        truncated = true
      }
      return {
        mime: 'application/x-ndjson',
        text,
        ...(truncated ? { truncated: true } : {}),
      }
    }
    return undefined
  }

  /** Walk the local .trash/ and report every well-formed entry. */
  async listTrash(): Promise<TrashRef[]> {
    const root = trashRoot(this.rootDir)
    if (!await exists(root)) return []
    const out: TrashRef[] = []
    for (const id of await readdir(root)) {
      const metaPath = trashMetaFile(this.rootDir, id)
      if (!await exists(metaPath)) continue
      try {
        const ref = JSON.parse(await readFile(metaPath, 'utf8')) as TrashRef
        out.push(ref)
      } catch (err) {
        this.logger.warn('skipping corrupt trash meta', { id, err: String(err) })
      }
    }
    return out
  }
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}
