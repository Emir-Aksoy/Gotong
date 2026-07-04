/**
 * ArtifactFilePlugin — first-party artifact:file ServicePlugin.
 *
 * Same lifecycle pattern as memory-file: per-owner dir, in-rootDir
 * .trash with deterministic refIds, idempotent same-day softDelete,
 * sibling-merge on data-after-trash.
 *
 * Two extension points beyond memory-file:
 *   - `describe` previews the first matching artifact's content
 *     (cap 32 KB) rather than tailing a jsonl.
 *   - `read`/`remove`/`exists` accept a ref OR a user path — same
 *     thing for this backend.
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
import { dirname, join, relative } from 'node:path'
import type { Logger } from '@gotong/core'
import type {
  Owner,
  ServiceInitCtx,
  ServicePlugin,
  ServiceSnapshot,
  TrashRef,
} from '@gotong/services-sdk'
import {
  assertSafeOwnerId,
  makeTrashRef,
  ownerKey,
  PREVIEW_MAX_BYTES,
  TrashRestoreConflictError,
} from '@gotong/services-sdk'

import { type ArtifactFileConfig, validateArtifactFileConfig } from './config.js'
import { ArtifactFileHandle } from './handle.js'
import { guessMime } from './mime.js'
import {
  ownerDir,
  trashEntryDir,
  trashMetaFile,
  trashPayloadDir,
  trashRoot,
} from './paths.js'

const PLUGIN_VERSION = '0.1.0'

export class ArtifactFilePlugin
  implements ServicePlugin<ArtifactFileConfig, ArtifactFileHandle>
{
  readonly type = 'artifact'
  readonly impl = 'file'
  readonly version = PLUGIN_VERSION
  readonly description = 'File-backed artifact storage — first-party'

  private rootDir = ''
  private logger!: Logger
  private now: () => number = Date.now
  private readonly handles = new Map<string, ArtifactFileHandle>()

  async validateConfig(raw: unknown): Promise<ArtifactFileConfig> {
    return validateArtifactFileConfig(raw)
  }

  async init(ctx: ServiceInitCtx): Promise<void> {
    this.rootDir = ctx.rootDir
    this.logger = ctx.logger
    this.now = () => ctx.hub.now()
    await mkdir(this.rootDir, { recursive: true })
    await mkdir(trashRoot(this.rootDir), { recursive: true })
    this.logger.debug('artifact:file initialised', { rootDir: this.rootDir })
  }

  async attach(owner: Owner, config: ArtifactFileConfig): Promise<ArtifactFileHandle> {
    // Fail fast on a malicious / buggy Owner.id (`../foo`, `\0`, etc.)
    // — defense-in-depth alongside the same check inside `ownerDir`.
    assertSafeOwnerId(owner.id)
    const key = ownerKey(owner)
    const existing = this.handles.get(key)
    if (existing) return existing
    const handle = new ArtifactFileHandle({
      rootDir: this.rootDir,
      owner,
      config,
      logger: this.logger.child({ owner: key }),
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

    this.handles.delete(ownerKey(owner))

    await mkdir(trashDir, { recursive: true })
    if (!await pathExists(metaPath)) {
      await writeFile(metaPath, JSON.stringify(ref, null, 2), 'utf8')
    }

    if (await pathExists(srcDir)) {
      if (await pathExists(payloadPath)) {
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

    if (await pathExists(dstDir)) {
      throw new TrashRestoreConflictError(ref.id)
    }
    if (await pathExists(payloadPath)) {
      await mkdir(dirname(dstDir), { recursive: true })
      await rename(payloadPath, dstDir)
    }
    // Same-day re-deletes stash extra user data in `payload-<ts>/`
    // siblings. Pre-3.1 the unconditional `rm -rf trashDir` wiped
    // them out on the first restore — irrecoverable data loss.
    // Now we keep the trash entry alive so the siblings remain
    // visible to listTrash + retrievable by an operator.
    const siblings = (await readdir(trashDir).catch(() => []))
      .filter((e) => e.startsWith('payload-'))
    if (siblings.length > 0) {
      this.logger.warn('restore left sibling payloads in trash', {
        trashId: ref.id, siblings,
      })
      return
    }
    await rm(trashDir, { recursive: true, force: true })
  }

  async hardDelete(ref: TrashRef): Promise<void> {
    await rm(trashEntryDir(this.rootDir, ref.id), { recursive: true, force: true })
  }

  async describe(owner: Owner): Promise<ServiceSnapshot> {
    const oDir = ownerDir(this.rootDir, owner)
    if (!await pathExists(oDir)) {
      return { sizeBytes: 0, itemCount: 0 }
    }
    let sizeBytes = 0
    let itemCount = 0
    let lastAccess: number | undefined
    let previewSource: { path: string; mime: string } | undefined
    for await (const full of walk(oDir)) {
      try {
        const st = await stat(full)
        sizeBytes += st.size
        itemCount += 1
        if (!lastAccess || st.mtimeMs > lastAccess) {
          lastAccess = st.mtimeMs
          previewSource = { path: full, mime: guessMime(relative(oDir, full)) }
        }
      } catch { /* race with concurrent delete — skip */ }
    }
    const snap: ServiceSnapshot = { sizeBytes, itemCount }
    if (lastAccess !== undefined) snap.lastAccess = lastAccess
    if (previewSource) {
      const preview = await this.buildPreview(previewSource.path, previewSource.mime)
      if (preview) snap.preview = preview
    }
    return snap
  }

  async shutdown(): Promise<void> {
    this.handles.clear()
  }

  async listTrash(): Promise<TrashRef[]> {
    const root = trashRoot(this.rootDir)
    if (!await pathExists(root)) return []
    const out: TrashRef[] = []
    for (const id of await readdir(root)) {
      const metaPath = trashMetaFile(this.rootDir, id)
      if (!await pathExists(metaPath)) continue
      try {
        const r = JSON.parse(await readFile(metaPath, 'utf8')) as TrashRef
        out.push(r)
      } catch (err) {
        this.logger.warn('skipping corrupt trash meta', { id, err: String(err) })
      }
    }
    return out
  }

  // --- internals ----------------------------------------------------

  private async buildPreview(
    fullPath: string,
    mime: string,
  ): Promise<ServiceSnapshot['preview']> {
    if (mime.startsWith('image/') || mime === 'application/pdf') {
      // Binary preview as base64. Cap at 32 KB of raw bytes.
      const buf = await readFile(fullPath)
      const cap = PREVIEW_MAX_BYTES
      const sliced = buf.byteLength > cap ? buf.subarray(0, cap) : buf
      return {
        mime,
        base64: sliced.toString('base64'),
        ...(buf.byteLength > cap ? { truncated: true } : {}),
      }
    }
    // Text preview.
    let text = await readFile(fullPath, 'utf8')
    let truncated = false
    if (Buffer.byteLength(text, 'utf8') > PREVIEW_MAX_BYTES) {
      text = text.slice(0, PREVIEW_MAX_BYTES)
      truncated = true
    }
    return { mime, text, ...(truncated ? { truncated: true } : {}) }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

async function* walk(dir: string): AsyncIterable<string> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) }
  catch { return }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}
